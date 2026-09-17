// Read-model queries over the snapshotted tables. All figures come from SQLite,
// so pages are fast and work even if OWNA is briefly unreachable.
const db = require("../db/db");
const cal = require("./calendar");
const { ownaIdFor } = require("./eh-labour"); // payroll's own EH-name → owna_id mapping; see the target section below

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

// ===== Licensed places =====
// "Licensed places" means the APPROVED PLACES on the service approval — the count on the ACECQA National
// Register — which is held in centres.approved_places and maintained at /admin/places. centres.capacity is
// the SUM OF OWNA ROOM CAPACITIES that the nightly snapshot writes; it is a different number (Austral is
// licensed for 124 and its rooms add to 122), so it is only ever the fallback for a service whose approval
// has not been recorded yet. EVERY licensed-places denominator on this dashboard — utilisation, unused
// places, seats, COE available child-days, the booking mix — goes through placesFor()/placesOf()/PLACES_SQL.
// They answer null, never 0, when neither figure is known, because a centre that is not licensed yet has no
// denominator at all: the pages must print "—" rather than a percentage of nothing.
// daily_metrics.capacity stays exactly as the snapshot wrote it — it is a per-day record of the room sum on
// that day, and history is not rewritten; it is simply no longer what the percentages divide by.
const PLACES_SQL = "COALESCE(NULLIF(approved_places,0), NULLIF(capacity,0))";
const PLACES_SQL_C = "COALESCE(NULLIF(c.approved_places,0), NULLIF(c.capacity,0))"; // for queries that alias centres as c
function placesFor(centre) {
  if (!centre) return null;
  const approved = Number(centre.approved_places);
  if (Number.isFinite(approved) && approved > 0) return approved;
  const rooms = Number(centre.capacity);
  return Number.isFinite(rooms) && rooms > 0 ? rooms : null;
}
// Licensed places for one centre id — for the aggregates over daily_metrics, whose own capacity column is
// the historical room sum and must not be used as a denominator.
function placesOf(ownaId) {
  return placesFor(db.prepare(`SELECT approved_places, capacity FROM centres WHERE owna_id = ?`).get(ownaId));
}
// pct() answers 0 for an unusable denominator, which would print "0%" for a centre that has no licence.
const pctOrNull = (num, den) => (den > 0 ? pct(num, den) : null);

// "Today" is always the Sydney date (services/calendar.js owns the zone), never the UTC one:
// toISOString is UTC regardless of TZ, so before 10am Sydney it reads a day behind.
const todayStr = () => cal.today();

// ===== Actual vs forecast: where the observed data really stops =====
// daily_metrics holds forward bookings as well as history — OWNA's attendance endpoint returns booked days
// out to the end of the campaign window. On those forward rows `booked` is real (a booking is a fact the
// moment it is made) but `attended` is NOT a measurement: it is OWNA's default attending flag on a day that
// has not happened. Anything derived from attended/absent is only true up to the last successful pull.
//
// So the boundary is the last SNAPSHOT date, not today. Writing `metric_date <= today` reads as correct and
// is wrong the moment the feed misses a night — and it had. On 2026-09-17 the last good run was 2026-09-10,
// so six days of forward bookings were being counted as observed attendance: the group read 98.7% and Heath
// Rd read a flat 100%, against real figures of 89.7% and 81.1%. Every attendance guard goes through here.
function lastActualDate() {
  const today = todayStr();
  // Ask about the OWNA FEED specifically, not about the nightly job as a whole.
  //
  // runSnapshot marks a run "partial" when ANY of its steps failed (services/snapshot.js: status =
  // problems.length ? "partial" : "ok"), and those steps include LineLeader, the exits pull and the
  // retention purge. So one flaky secondary source would have frozen this boundary — and therefore
  // every attendance figure on the dashboard — even though OWNA's day-rows landed perfectly. The
  // source_sync row for "owna" is written by the OWNA pull itself and answers the narrower question.
  const sync = db.prepare(
    `SELECT last_success, rows FROM source_sync WHERE source = 'owna' AND status = 'ok'`
  ).get();
  let ts = sync && sync.last_success && (sync.rows == null || sync.rows > 0) ? sync.last_success : null;
  if (!ts) {
    // Older databases predate per-source tracking. Fall back to the run row, accepting "partial":
    // the attendance write happens before the steps that can turn a run partial, so its day-rows are
    // there. A run that wrote nothing is not evidence of anything and is excluded.
    const row = db.prepare(
      `SELECT MAX(finished_at) AS ts FROM snapshot_runs WHERE status IN ('ok','partial') AND rows_written > 0`
    ).get();
    ts = row && row.ts ? row.ts : null;
  }
  if (!ts) return today;                                   // nothing has ever run: fall back to today
  // Stored timestamps are UTC (SQLite datetime('now')); the day one landed on is the Sydney date.
  const day = cal.sydneyDate(new Date(String(ts).replace(" ", "T") + "Z"));
  return day < today ? day : today;                        // never claim actuals past today
}
// How stale the observed data is, in whole days — 0 when the feed ran today. Pages show this so a figure
// is never read as "now" when it is a week old.
function actualsLagDays() {
  const a = lastActualDate(), t = todayStr();
  return Math.round((Date.parse(t + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

// Default range = the last 7 days up to today (history). Future data exists in the table
// but the default view is "to date"; forward presets expose the forecast.
function defaultRange() {
  const row = db.prepare(`SELECT MAX(metric_date) AS maxd FROM daily_metrics`).get();
  // End at the last day we actually observed, not at today. daily_metrics runs well into the future, so
  // MAX(metric_date) is a booking horizon, and today is only meaningful if the feed is current.
  const bound = lastActualDate();
  const maxd = (row && row.maxd) || bound;
  const to = maxd < bound ? maxd : bound;
  return { from: cal.addDays(to, -6), to };
}

// A forward-looking range: today → today + n days (the booked/scheduled horizon).
function forwardRange(days = 30) {
  const today = todayStr();
  return { from: today, to: cal.addDays(today, days) };
}

function centres() {
  return db.prepare(`SELECT * FROM centres ORDER BY name`).all();
}

// One aggregated summary row per centre for a date range.
// Ranges may run past today (booked-ahead days). Attendance is only known for past days — future rows
// carry OWNA's default "attending" flag — so attended/absent/attendance_rate are past days only, and
// fees are split into fee_past (billed to date) and fee_future (booked ahead).
// Occupancy counts operating days only (op_days/op_booked): OWNA keeps booking rows on public holidays
// when the centre is closed and nobody attends, so counting them would understate occupancy and
// contradict the seats and utilisation tiles beside it. booked/days stay raw for the child-day totals.
function overview(from, to) {
  const today = lastActualDate(); // the day observation stops, which is only "today" when the feed is current
  const opDays = JSON.stringify(cal.operatingDayList(from, to));
  const rows = db.prepare(`
    SELECT c.owna_id, c.name, c.alias, c.suburb, c.capacity, c.approved_places,
           ${PLACES_SQL_C}                    AS places,
           c.enrolled,
           COUNT(DISTINCT d.metric_date)      AS days,
           COALESCE(SUM(d.booked),0)          AS booked,
           COALESCE(SUM(d.casual),0)          AS casual,
           COALESCE(SUM(d.fee_total),0)       AS fee_total,
           COUNT(DISTINCT CASE WHEN d.metric_date IN (SELECT value FROM json_each(@opDays)) THEN d.metric_date END) AS op_days,
           COALESCE(SUM(CASE WHEN d.metric_date IN (SELECT value FROM json_each(@opDays)) THEN d.booked END),0) AS op_booked,
           COUNT(DISTINCT CASE WHEN d.metric_date <= @today THEN d.metric_date END) AS past_days,
           COALESCE(SUM(CASE WHEN d.metric_date <= @today THEN d.booked    END),0) AS past_booked,
           COALESCE(SUM(CASE WHEN d.metric_date <= @today THEN d.attended  END),0) AS attended,
           COALESCE(SUM(CASE WHEN d.metric_date <= @today THEN d.absent    END),0) AS absent,
           COALESCE(SUM(CASE WHEN d.metric_date <= @today THEN d.fee_total END),0) AS fee_past,
           COALESCE(SUM(CASE WHEN d.metric_date >  @today THEN d.booked    END),0) AS future_booked,
           COALESCE(SUM(CASE WHEN d.metric_date >  @today THEN d.fee_total END),0) AS fee_future
    FROM centres c
    LEFT JOIN daily_metrics d
      ON d.owna_id = c.owna_id AND d.metric_date BETWEEN @from AND @to
    WHERE c.opening IS NULL OR c.opening = 0
    GROUP BY c.owna_id
    ORDER BY c.name
  `).all({ from, to, today, opDays });

  return rows.map((r) => {
    // Licensed places × operating days in the range. A centre with no approved places and no room sum has
    // no denominator, so its occupancy is null (rendered "—"), never a percentage of zero.
    const denom = r.places == null ? null : r.places * r.op_days;
    return {
      ...r,
      fee_total: round(r.fee_total),
      fee_past: round(r.fee_past),
      fee_future: round(r.fee_future),
      future_days: r.days - r.past_days,
      occupancy: denom == null ? null : pct(r.op_booked, denom), // booked child-days / place-days, operating days only (incl. booked ahead)
      attendance_rate: pct(r.attended, r.past_booked), // past days only
      avg_daily_booked: r.days ? Math.round(r.booked / r.days) : 0,
    };
  });
}

function totals(rows) {
  const t = rows.reduce((a, r) => {
    // `capacity`/`capacity_days` stay the raw OWNA room sum (what the snapshot measured); `places` and the
    // *_places_days denominators are the licensed count the percentages are judged against. A centre with
    // no licensed places contributes nothing to the denominator rather than a zero that flatters it.
    a.capacity += r.capacity; a.places += r.places || 0; a.enrolled += r.enrolled;
    a.booked += r.booked; a.attended += r.attended; a.absent += r.absent;
    a.casual += r.casual; a.fee_total += r.fee_total;
    a.capacity_days += r.capacity * r.days;
    a.places_days += (r.places || 0) * r.days;
    a.days = Math.max(a.days, r.days);
    // Occupancy ratio: operating days only (see overview) — booked/days/capacity_days stay raw for the child-day tiles.
    a.op_booked += r.op_booked || 0;
    a.op_capacity_days += r.capacity * (r.op_days || 0);
    a.op_places_days += (r.places || 0) * (r.op_days || 0);
    a.op_days = Math.max(a.op_days, r.op_days || 0);
    // Past/future split (see overview): attendance is judged on past days only.
    a.past_booked += r.past_booked || 0; a.future_booked += r.future_booked || 0;
    a.fee_past += r.fee_past || 0; a.fee_future += r.fee_future || 0;
    a.past_days = Math.max(a.past_days, r.past_days || 0);
    a.future_days = Math.max(a.future_days, r.future_days || 0);
    return a;
  }, { capacity: 0, places: 0, enrolled: 0, booked: 0, attended: 0, absent: 0, casual: 0, fee_total: 0,
       capacity_days: 0, places_days: 0, days: 0,
       op_booked: 0, op_capacity_days: 0, op_places_days: 0, op_days: 0,
       past_booked: 0, future_booked: 0, fee_past: 0, fee_future: 0, past_days: 0, future_days: 0 });
  return {
    ...t,
    fee_total: round(t.fee_total),
    fee_past: round(t.fee_past),
    fee_future: round(t.fee_future),
    occupancy: pct(t.op_booked, t.op_places_days),
    attendance_rate: pct(t.attended, t.past_booked),
  };
}

function centre(ownaId) {
  return db.prepare(`SELECT * FROM centres WHERE owna_id = ?`).get(ownaId);
}

// Per-day series for one centre.
function centreDaily(ownaId, from, to) {
  // The row's own `capacity` is the room sum recorded on that day and is left alone; the day's occupancy is
  // judged against the centre's licensed places, like every other percentage on the dashboard.
  const places = placesOf(ownaId);
  const rows = db.prepare(`
    SELECT metric_date, capacity, booked, attended, absent, casual, fee_total
    FROM daily_metrics
    WHERE owna_id = ? AND metric_date BETWEEN ? AND ?
    ORDER BY metric_date
  `).all(ownaId, from, to);
  // views/centre.ejs already refuses to print a rate for a future day, but the model must not hand one out
  // at all: the next caller (an export, an AI tool, a new page) will not know to repeat that check.
  const observedTo = lastActualDate();
  return rows.map((r) => ({
    ...r,
    places,
    observed: r.metric_date <= observedTo,
    fee_total: round(r.fee_total),
    occupancy: pctOrNull(r.booked, places),
    attendance_rate: r.metric_date <= observedTo ? pct(r.attended, r.booked) : null,
  }));
}

// Monthly occupancy trend for one centre (past months only), most recent `months` back.
function occupancyTrend(ownaId, months = 18) {
  const today = lastActualDate();
  const places = placesOf(ownaId); // licensed places, not the month's room sum
  const rows = db.prepare(`
    SELECT substr(metric_date,1,7) AS month,
           COALESCE(SUM(booked),0) AS booked,
           COALESCE(SUM(attended),0) AS attended,
           COALESCE(SUM(fee_total),0) AS fee_total,
           COUNT(DISTINCT metric_date) AS days
    FROM daily_metrics
    WHERE owna_id = ? AND metric_date <= ?
    GROUP BY month ORDER BY month
  `).all(ownaId, today);
  return rows.map((r) => ({
    month: r.month,
    occupancy: places == null ? null : pct(r.booked, places * r.days),
    attendance_rate: pct(r.attended, r.booked),
    fee_total: round(r.fee_total),
    days: r.days,
  })).slice(-months);
}

// Group monthly occupancy trend (all centres combined).
function occupancyTrendGroup(months = 18) {
  const today = lastActualDate();
  const rows = db.prepare(`
    SELECT substr(d.metric_date,1,7) AS month,
           COALESCE(SUM(d.booked),0) AS booked,
           COALESCE(SUM(d.attended),0) AS attended,
           COALESCE(SUM(d.fee_total),0) AS fee_total,
           SUM(${PLACES_SQL_C}) AS cap_days
    FROM daily_metrics d JOIN centres c ON c.owna_id = d.owna_id
    WHERE d.metric_date <= ?
    GROUP BY month ORDER BY month
  `).all(today);
  return rows.map((r) => ({
    month: r.month,
    occupancy: pct(r.booked, r.cap_days),
    attendance_rate: pct(r.attended, r.booked),
    fee_total: round(r.fee_total),
  })).slice(-months);
}

// Group monthly occupancy including FUTURE months projected from scheduled bookings (dashed on charts).
// projected=true for the current (partial) month and any future month.
function occupancyTrendGroupFwd(pastMonths = 12, fwdMonths = 2) {
  const now = todayStr().slice(0, 7);
  // A month is only fully observed if the actuals boundary has passed its end; otherwise its attendance
  // rate would average real days against forward bookings that all claim a perfect attendance.
  const observedThrough = lastActualDate().slice(0, 7);
  const rows = db.prepare(`
    SELECT substr(d.metric_date,1,7) AS month,
           COALESCE(SUM(d.booked),0) AS booked, COALESCE(SUM(d.attended),0) AS attended,
           COALESCE(SUM(d.fee_total),0) AS fee, SUM(${PLACES_SQL_C}) AS cap_days
    FROM daily_metrics d JOIN centres c ON c.owna_id = d.owna_id
    GROUP BY month ORDER BY month`).all();
  const [y, mo] = now.split("-").map(Number);
  const lo = new Date(Date.UTC(y, mo - 1 - pastMonths, 1)).toISOString().slice(0, 7);
  const hi = new Date(Date.UTC(y, mo - 1 + fwdMonths, 1)).toISOString().slice(0, 7);
  return rows.filter((r) => r.month >= lo && r.month <= hi).map((r) => ({
    month: r.month,
    occupancy: pct(r.booked, r.cap_days),
    attendance_rate: r.month < observedThrough ? pct(r.attended, r.booked) : null, // observed months only
    fee_total: round(r.fee),
    projected: r.month >= now,
  }));
}

function centreCcs(ownaId, from, to) {
  return db.prepare(`
    SELECT week_starting, amount FROM ccs_payments
    WHERE owna_id = ? AND week_starting BETWEEN ? AND ?
    ORDER BY week_starting
  `).all(ownaId, from, to);
}

function ccsTotal(ownaId, from, to) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS amt FROM ccs_payments
    WHERE owna_id = ? AND week_starting BETWEEN ? AND ?
  `).get(ownaId, from, to);
  return round(r.amt);
}

// ===== LineLeader pipeline read-model =====

// Stages we surface, in funnel order (id → label). Others still stored, just not columned.
const LL_FUNNEL = [
  [1, "New Family"], [2, "Engaged"], [11, "Tour Scheduled"], [3, "Tour Completed"],
  [4, "Waitlist"], [12, "Pre-Offered"], [5, "Offer Accepted"], [6, "Enrolled (Started)"],
];

function llLatestDate() {
  const r = db.prepare(`SELECT MAX(snapshot_date) AS d FROM ll_pipeline`).get();
  return r && r.d;
}

// One row per centre with a {statusId: count} map, for the latest snapshot.
function llPipeline() {
  const date = llLatestDate();
  if (!date) return { date: null, funnel: LL_FUNNEL, rows: [], totals: {} };
  const raw = db.prepare(`
    SELECT ll_id, centre_name, status_id, count FROM ll_pipeline WHERE snapshot_date = ?
  `).all(date);
  const byCentre = new Map();
  for (const r of raw) {
    if (!byCentre.has(r.ll_id)) byCentre.set(r.ll_id, { ll_id: r.ll_id, name: r.centre_name, counts: {} });
    byCentre.get(r.ll_id).counts[r.status_id] = r.count;
  }
  // The "started / withdrawn / net" figures that used to be built here were removed on 15 Sept 2026.
  // The query had no date filter, so it counted every enrolment record ever written while the page
  // labelled the result "120d": the group read 1,554 expected starts and +1,520 net against 501
  // licensed places. Expected starts with a real window live on the Continuation of Enrolment page,
  // which counts them per month against the places available.
  const rows = [...byCentre.values()]
    .sort((a, b) => (b.counts[4] || 0) - (a.counts[4] || 0)); // busiest waitlist first

  const totals = {};
  for (const [sid] of LL_FUNNEL) totals[sid] = rows.reduce((s, r) => s + (r.counts[sid] || 0), 0);
  totals.started = rows.reduce((s, r) => s + r.started, 0);
  totals.withdrawn = rows.reduce((s, r) => s + r.withdrawn, 0);
  totals.net = totals.started - totals.withdrawn;

  return { date, funnel: LL_FUNNEL, rows, totals };
}

// Pipeline stage counts over time (one point per snapshot date) — for a centre (owna_id) or all centres.
// Returns per-stage series aligned to the same date axis, for small-multiple trend charts.
function pipelineTrend(ownaId, limit = 120) {
  const dates = db.prepare("SELECT DISTINCT snapshot_date FROM ll_pipeline ORDER BY snapshot_date DESC LIMIT ?")
    .all(limit).map((r) => r.snapshot_date).reverse();
  if (!dates.length) return { dates: [], series: [] };
  let llId = null;
  if (ownaId) { const c = db.prepare("SELECT ll_id FROM centres WHERE owna_id=?").get(ownaId); llId = c && c.ll_id; }
  const rows = ownaId
    ? db.prepare("SELECT snapshot_date, status_id, SUM(count) c FROM ll_pipeline WHERE ll_id=? GROUP BY snapshot_date, status_id").all(llId)
    : db.prepare("SELECT snapshot_date, status_id, SUM(count) c FROM ll_pipeline GROUP BY snapshot_date, status_id").all();
  const map = {}; rows.forEach((r) => { (map[r.status_id] = map[r.status_id] || {})[r.snapshot_date] = r.c; });
  const series = LL_FUNNEL.map(([sid, name]) => {
    const points = dates.map((d) => (map[sid] && map[sid][d]) || 0);
    const first = points[0], last = points[points.length - 1];
    return { id: sid, name: name.replace(" (Started)", ""), points, current: last, change: last - first };
  });
  return { dates, series };
}
// New families joining the waitlist over time (by their wait-list date) — for a centre or all.
// A continuous monthly axis (last `months`, up to the current month), zero-filled, so marketing
// spikes are easy to read. Reveals when families joined regardless of daily snapshots.
function waitlistJoins(ownaId, months = 18) {
  const now = todayStr().slice(0, 7);
  let llId = null;
  if (ownaId) { const c = db.prepare("SELECT ll_id FROM centres WHERE owna_id=?").get(ownaId); llId = c && c.ll_id; }
  const where = ownaId ? "AND ll_id=?" : "";
  const args = ownaId ? [llId] : [];
  const rows = db.prepare(`SELECT substr(wait_list_date,1,7) m, COUNT(*) n FROM ll_pipeline_members
    WHERE wait_list_date IS NOT NULL AND length(wait_list_date) >= 7 AND substr(wait_list_date,1,7) <= ? ${where}
    GROUP BY m`).all(now, ...args);
  const map = {}; rows.forEach((r) => { map[r.m] = r.n; });
  const [y, mo] = now.split("-").map(Number);
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, mo - 1 - i, 1));
    const k = d.toISOString().slice(0, 7);
    out.push({ month: k, count: map[k] || 0 });
  }
  return out;
}
// Centres that appear in the LineLeader pipeline (for the trend centre selector).
function pipelineCentres() {
  return db.prepare(`SELECT DISTINCT c.owna_id, c.name FROM ll_pipeline p JOIN centres c ON c.ll_id = p.ll_id WHERE c.owna_id IS NOT NULL ORDER BY c.name`).all();
}

// LineLeader pipeline for ONE OWNA centre (via centres.ll_id). Returns null if unlinked.
function llForCentre(ownaId) {
  const c = db.prepare(`SELECT ll_id FROM centres WHERE owna_id = ?`).get(ownaId);
  if (!c || !c.ll_id) return null;
  const date = llLatestDate();
  const rows = date ? db.prepare(
    `SELECT status_id, status_name, count FROM ll_pipeline WHERE snapshot_date = ? AND ll_id = ?`
  ).all(date, c.ll_id) : [];
  const counts = {};
  rows.forEach((r) => { counts[r.status_id] = r.count; });
  const today = todayStr();
  // Expected starts split past/future, and withdrawals — from ll_enrolments for this centre.
  const g = db.prepare(`
    SELECT
      SUM(start_date IS NOT NULL AND start_date >= ?) AS starts_future,
      SUM(start_date IS NOT NULL AND start_date <  ?) AS starts_past,
      SUM(withdrawn_date IS NOT NULL) AS withdrawn
    FROM ll_enrolments WHERE ll_id = ?
  `).get(today, today, c.ll_id) || {};
  return {
    ll_id: c.ll_id,
    date,
    waitlist: counts[4] || 0,
    tour_scheduled: counts[11] || 0,
    tour_completed: counts[3] || 0,
    offers_accepted: counts[5] || 0,
    new_family: counts[1] || 0,
    engaged: counts[2] || 0,
    enrolled: counts[6] || 0,
    starts_future: g.starts_future || 0,
    starts_past: g.starts_past || 0,
    withdrawn: g.withdrawn || 0,
  };
}

// Forecast occupancy per centre over the next `days` (from tomorrow), keyed by owna_id.
// Uses scheduled future bookings already in daily_metrics.
function forwardOccupancyByCentre(days = 30) {
  const today = todayStr();
  const to = cal.addDays(today, days);
  const rows = db.prepare(`
    SELECT d.owna_id, ${PLACES_SQL_C} AS places,
           COALESCE(SUM(d.booked),0) AS booked,
           COUNT(DISTINCT d.metric_date) AS days
    FROM daily_metrics d JOIN centres c ON c.owna_id = d.owna_id
    WHERE d.metric_date > ? AND d.metric_date <= ?
    GROUP BY d.owna_id
  `).all(today, to);
  const map = {};
  rows.forEach((r) => {
    map[r.owna_id] = { occupancy: r.places == null ? null : pct(r.booked, r.places * r.days), days: r.days, booked: r.booked };
  });
  return map;
}

// Waitlist + upcoming starts per OWNA centre, keyed by owna_id (for the Overview).
function llByOwnaCentre() {
  const date = llLatestDate();
  const today = todayStr();
  const rows = db.prepare(`
    SELECT c.owna_id, c.ll_id,
      (SELECT count FROM ll_pipeline p WHERE p.snapshot_date = ? AND p.ll_id = c.ll_id AND p.status_id = 4) AS waitlist,
      (SELECT SUM(start_date >= ?) FROM ll_enrolments e WHERE e.ll_id = c.ll_id) AS starts_future
    FROM centres c WHERE c.ll_id IS NOT NULL
  `).all(date, today);
  const map = {};
  rows.forEach((r) => { map[r.owna_id] = { waitlist: r.waitlist || 0, starts_future: r.starts_future || 0 }; });
  return map;
}

// ===== Centre pipeline drill-down =====

const FUNNEL_STAGES = [
  [1, "New Family"], [2, "Engaged"], [11, "Tour Scheduled"], [3, "Tour Completed"],
  [4, "Waitlist"], [12, "Pre-Offered"], [5, "Offer Accepted"],
];

function centrePipelineDetail(ownaId) {
  const c = db.prepare(`SELECT owna_id, name, ll_id FROM centres WHERE owna_id = ?`).get(ownaId);
  if (!c || !c.ll_id) return null;
  const today = todayStr();

  // Funnel counts (family-level, matches the rest of the dashboard).
  const date = llLatestDate();
  const pc = {};
  if (date) db.prepare(`SELECT status_id, count FROM ll_pipeline WHERE snapshot_date = ? AND ll_id = ?`)
    .all(date, c.ll_id).forEach((r) => { pc[r.status_id] = r.count; });
  const funnel = FUNNEL_STAGES.map(([id, name]) => ({ id, name, count: pc[id] || 0 }));

  // Members (child-level) summarised per stage. This used to be a list of children and families by name;
  // it is now COUNTS — how many are at each stage, and when they want to start — because no child or family
  // name is held any more (db/schema.sql). LineLeader is where a name is looked up.
  const memberRows = db.prepare(`
    SELECT child_id, status_id, status_name, wait_list_date, expected_start
    FROM ll_pipeline_members WHERE owna_id = ?
    ORDER BY COALESCE(wait_list_date, expected_start) DESC
  `).all(ownaId);
  const membersByStage = {};
  FUNNEL_STAGES.forEach(([id]) => { membersByStage[id] = { count: 0, starts: [], no_start: 0, joined_from: null, joined_to: null }; });
  memberRows.forEach((r) => {
    const s = membersByStage[r.status_id] || (membersByStage[r.status_id] = { count: 0, starts: [], no_start: 0, joined_from: null, joined_to: null });
    s.count += 1;
    const mth = r.expected_start ? String(r.expected_start).slice(0, 7) : null;
    if (mth) { const hit = s.starts.find((x) => x.month === mth); if (hit) hit.n += 1; else s.starts.push({ month: mth, n: 1 }); }
    else s.no_start += 1;
    const wl = r.wait_list_date ? String(r.wait_list_date).slice(0, 10) : null;
    if (wl) { if (!s.joined_from || wl < s.joined_from) s.joined_from = wl; if (!s.joined_to || wl > s.joined_to) s.joined_to = wl; }
  });
  Object.values(membersByStage).forEach((s) => s.starts.sort((a, b) => a.month.localeCompare(b.month)));

  // Upcoming tours (scheduled, not done/cancelled) + recent completed. When and what type — the family the
  // booking belongs to is in LineLeader, not here, so there is no name and no per-family current stage.
  const upcomingTours = db.prepare(`
    SELECT task_id, type_name, tour_date, result FROM ll_tours
    WHERE owna_id = ? AND is_completed = 0 AND is_cancelled = 0 AND substr(tour_date,1,10) >= ?
    ORDER BY tour_date ASC
  `).all(ownaId, today);
  const recentTours = db.prepare(`
    SELECT task_id, type_name, tour_date, result FROM ll_tours
    WHERE owna_id = ? AND is_completed = 1 AND substr(tour_date,1,10) < ?
    ORDER BY tour_date DESC LIMIT 10
  `).all(ownaId, today);

  // Waitlist joins over time (from wait_list_date of current waitlist members).
  const trendRows = db.prepare(`
    SELECT substr(wait_list_date,1,7) AS month, COUNT(*) n
    FROM ll_pipeline_members WHERE owna_id = ? AND status_id = 4 AND wait_list_date IS NOT NULL
    GROUP BY month ORDER BY month
  `).all(ownaId);

  return {
    centre: c, funnel, membersByStage, memberCount: memberRows.length,
    upcomingTours, recentTours, waitlistTrend: trendRows.slice(-18),
    stages: FUNNEL_STAGES,
  };
}


// ===== Funnel conversions by centre (LineLeader) =====
// Stage order for the conversion funnel; Waitlist (4) sits alongside rather than being a step.
const CONVERSION_STAGES = [[1, "New Family"], [2, "Engaged"], [11, "Tour Scheduled"], [3, "Tour Completed"], [12, "Pre-Offered"], [5, "Offer Accepted"]];
const WAITLIST_STATUS = 4;
const ENROLLED_STATUS = 6; // LineLeader "Enrolled (Started)" — the only status that is a genuine start

// YYYY-MM-DD `months` calendar months before `today` (JS Date month arithmetic, same convention as churnByRoom).
function monthsBefore(today, months) {
  const d = new Date(today + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10);
}
// Centres linked to LineLeader (operating first, then pre-opening) — the rows of every pipeline table.
function llLinkedCentres() {
  return db.prepare(`SELECT owna_id, name, ll_id, capacity, opening, opening_year, opening_month FROM centres
    WHERE ll_id IS NOT NULL ORDER BY COALESCE(opening, 0), name`).all();
}
// A tour counts as HELD when LineLeader marks it complete, or its scheduled date has passed and it was not cancelled.
// (Staff rarely tick "complete" in LineLeader, so the completed flag alone reads 0; both figures are returned.)
const TOUR_HELD_SQL = `is_cancelled = 0 AND (is_completed = 1 OR substr(tour_date,1,10) < @today)`;
const TOUR_COUNT_SQL = `COUNT(*) AS held, SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END) AS completed`;

// Funnel per centre. Stage counts are a SNAPSHOT of who is in the pipeline now; the conversion strip is ACTIVITY over
// the 12 months to `today` (leads joined → tours held → offers accepted → started). With `month` (YYYY-MM) both parts
// are restricted to the cohort of families whose wait-list date falls in that month, i.e. where that month's leads are now.
//   leads   = members who joined in the window + families who started in it (they have left the pipeline, so a floor)
//   tours   = tours held in the window (see TOUR_HELD_SQL); cohort mode: tours the cohort's families held on or after
//             they joined the wait list — an earlier tour belongs to an earlier enquiry, not to this cohort's journey
//   offers  = members currently at Offer Accepted (LineLeader does not date the acceptance) + started in the window
//   started = ll_enrolments at Enrolled (Started) with a start date in the window; LineLeader hands families to OWNA at
//             enrolment so this is a floor. Not knowable for a cohort (started families keep no wait-list date) → null.
function funnelByCentre(month = null, today = todayStr()) {
  const cohort = /^\d{4}-\d{2}$/.test(month || "") ? month : null;
  const from = monthsBefore(today, 12);
  const stageRows = cohort
    ? db.prepare(`SELECT owna_id, status_id, COUNT(*) n FROM ll_pipeline_members WHERE owna_id IS NOT NULL AND substr(wait_list_date,1,7) = ? GROUP BY owna_id, status_id`).all(cohort)
    : db.prepare(`SELECT owna_id, status_id, COUNT(*) n FROM ll_pipeline_members WHERE owna_id IS NOT NULL GROUP BY owna_id, status_id`).all();
  const stageMap = {}; stageRows.forEach((r) => { (stageMap[r.owna_id] = stageMap[r.owna_id] || {})[r.status_id] = r.n; });

  const leadsMap = {}, toursMap = {}, startedMap = {};
  if (cohort) {
    db.prepare(`SELECT owna_id, COUNT(*) n FROM ll_pipeline_members WHERE owna_id IS NOT NULL AND substr(wait_list_date,1,7) = ? GROUP BY owna_id`)
      .all(cohort).forEach((r) => { leadsMap[r.owna_id] = r.n; });
    // Tours held by the cohort's families — matched on the family KEY within the centre (a salted hash of the
    // family name; neither table holds the name itself), counted only (never listed), and only from the day the
    // family joined: a tour before that wait-list date came from an earlier enquiry, not this cohort.
    db.prepare(`SELECT owna_id, ${TOUR_COUNT_SQL} FROM ll_tours t WHERE owna_id IS NOT NULL AND ${TOUR_HELD_SQL}
      AND t.family_key IS NOT NULL
      AND EXISTS (SELECT 1 FROM ll_pipeline_members m WHERE m.owna_id = t.owna_id AND m.family_key = t.family_key
        AND substr(m.wait_list_date,1,7) = @cohort AND substr(t.tour_date,1,10) >= substr(m.wait_list_date,1,10))
      GROUP BY owna_id`).all({ today, cohort }).forEach((r) => { toursMap[r.owna_id] = r; });
  } else {
    db.prepare(`SELECT owna_id, COUNT(*) n FROM ll_pipeline_members WHERE owna_id IS NOT NULL AND wait_list_date > ? AND wait_list_date <= ? GROUP BY owna_id`)
      .all(from, today).forEach((r) => { leadsMap[r.owna_id] = r.n; });
    db.prepare(`SELECT owna_id, ${TOUR_COUNT_SQL} FROM ll_tours WHERE owna_id IS NOT NULL AND ${TOUR_HELD_SQL}
      AND substr(tour_date,1,10) > @from AND substr(tour_date,1,10) <= @today GROUP BY owna_id`).all({ today, from }).forEach((r) => { toursMap[r.owna_id] = r; });
    db.prepare(`SELECT c.owna_id, COUNT(*) n FROM ll_enrolments e JOIN centres c ON c.ll_id = e.ll_id
      WHERE e.status_id = ? AND e.start_date > ? AND e.start_date <= ? GROUP BY c.owna_id`).all(ENROLLED_STATUS, from, today).forEach((r) => { startedMap[r.owna_id] = r.n; });
  }

  const rows = llLinkedCentres().map((c) => {
    const sm = stageMap[c.owna_id] || {};
    const total = Object.values(sm).reduce((s, n) => s + n, 0);
    const stages = CONVERSION_STAGES.map(([id, name]) => ({ id, name, count: sm[id] || 0, share: pct(sm[id] || 0, total) }));
    const waitlist = { id: WAITLIST_STATUS, name: "Waitlist", count: sm[WAITLIST_STATUS] || 0, share: pct(sm[WAITLIST_STATUS] || 0, total) };
    const started = cohort ? null : (startedMap[c.owna_id] || 0);
    const leadsJoined = leadsMap[c.owna_id] || 0;
    const leads = leadsJoined + (started || 0);
    const t = toursMap[c.owna_id] || { held: 0, completed: 0 };
    const offersCurrent = sm[5] || 0;
    const offers = offersCurrent + (started || 0);
    const strip = {
      leads, leads_joined: leadsJoined, tours_held: t.held || 0, tours_completed: t.completed || 0,
      offers, offers_current: offersCurrent, started,
      tour_pct: pct(t.held || 0, leads), offer_pct: pct(offers, leads), start_pct: started == null ? null : pct(started, leads),
    };
    return { owna_id: c.owna_id, name: c.name, opening: !!c.opening, total, stages, waitlist, strip };
  });

  const sum = (f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
  const gTotal = sum((r) => r.total);
  const gLeads = sum((r) => r.strip.leads), gTours = sum((r) => r.strip.tours_held), gOffers = sum((r) => r.strip.offers);
  const gStarted = cohort ? null : sum((r) => r.strip.started);
  const group = {
    total: gTotal,
    stages: CONVERSION_STAGES.map(([id, name]) => { const n = sum((r) => (r.stages.find((s) => s.id === id) || {}).count); return { id, name, count: n, share: pct(n, gTotal) }; }),
    waitlist: { id: WAITLIST_STATUS, name: "Waitlist", count: sum((r) => r.waitlist.count), share: pct(sum((r) => r.waitlist.count), gTotal) },
    strip: {
      leads: gLeads, leads_joined: sum((r) => r.strip.leads_joined), tours_held: gTours, tours_completed: sum((r) => r.strip.tours_completed),
      offers: gOffers, offers_current: sum((r) => r.strip.offers_current), started: gStarted,
      tour_pct: pct(gTours, gLeads), offer_pct: pct(gOffers, gLeads), start_pct: gStarted == null ? null : pct(gStarted, gLeads),
    },
  };
  return { mode: cohort ? "cohort" : "window", month: cohort, from, to: today, stages: CONVERSION_STAGES, rows, group };
}
// Months (YYYY-MM, latest first) in which any current pipeline family joined the wait list — the cohort selector.
// Read straight off the members table so no cohort ages out of the list; future wait-list dates are not offered.
function funnelMonths(today = todayStr()) {
  return db.prepare(`SELECT DISTINCT substr(wait_list_date,1,7) m FROM ll_pipeline_members
    WHERE wait_list_date IS NOT NULL AND length(wait_list_date) >= 7 AND substr(wait_list_date,1,7) <= ?
    ORDER BY m DESC`).all(today.slice(0, 7)).map((r) => r.m);
}

// ===== Lead & tour targets per centre (pipeline_targets; month-specific rows override the standing 'default') =====
function pipelineTargets(month) {
  const map = {};
  db.prepare(`SELECT * FROM pipeline_targets WHERE month = 'default'`).all().forEach((t) => { map[t.owna_id] = t; });
  if (month) db.prepare(`SELECT * FROM pipeline_targets WHERE month = ?`).all(month).forEach((t) => { map[t.owna_id] = t; });
  return map;
}
function savePipelineTarget(ownaId, month, target) {
  db.prepare(`
    INSERT INTO pipeline_targets (owna_id, month, leads, tours) VALUES (?,?,?,?)
    ON CONFLICT(owna_id, month) DO UPDATE SET leads=excluded.leads, tours=excluded.tours
  `).run(ownaId, month || "default", target.leads == null ? null : target.leads, target.tours == null ? null : target.tours);
}
function deletePipelineTarget(ownaId, month) {
  db.prepare(`DELETE FROM pipeline_targets WHERE owna_id = ? AND month = ?`).run(ownaId, month || "default");
}
// Green = monthly target already met, amber = on pace for the share of the month elapsed, red = behind pace.
function targetRag(actual, target, elapsed) {
  if (target == null || !(target > 0)) return null;
  if (actual >= target) return "good";
  return actual >= target * elapsed ? "warn" : "bad";
}
// This month so far, per LineLeader-linked centre: new leads (wait-list date this month) and tours held vs the targets.
function pipelineTargetProgress(today = todayStr()) {
  const month = today.slice(0, 7);
  const [y, mo] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const day = Number(today.slice(8, 10));
  const elapsed = day / daysInMonth;
  const targets = pipelineTargets(month);
  const leads = {}; db.prepare(`SELECT owna_id, COUNT(*) n FROM ll_pipeline_members WHERE owna_id IS NOT NULL AND substr(wait_list_date,1,7) = ? GROUP BY owna_id`).all(month).forEach((r) => { leads[r.owna_id] = r.n; });
  const tours = {}; db.prepare(`SELECT owna_id, ${TOUR_COUNT_SQL} FROM ll_tours WHERE owna_id IS NOT NULL AND ${TOUR_HELD_SQL} AND substr(tour_date,1,7) = @month GROUP BY owna_id`).all({ today, month }).forEach((r) => { tours[r.owna_id] = r; });
  const rows = llLinkedCentres().map((c) => {
    const t = targets[c.owna_id] || {};
    const l = leads[c.owna_id] || 0, th = (tours[c.owna_id] || {}).held || 0, tc = (tours[c.owna_id] || {}).completed || 0;
    const lt = t.leads == null ? null : t.leads, tt = t.tours == null ? null : t.tours;
    return {
      owna_id: c.owna_id, name: c.name, opening: !!c.opening,
      leads: l, leads_target: lt, leads_delta: lt == null ? null : l - lt, leads_rag: targetRag(l, lt, elapsed),
      tours_held: th, tours_completed: tc, tours_target: tt, tours_delta: tt == null ? null : th - tt, tours_rag: targetRag(th, tt, elapsed),
    };
  });
  return { month, today, day, days_in_month: daysInMonth, elapsed: Math.round(elapsed * 100) / 100, rows, has_targets: rows.some((r) => r.leads_target != null || r.tours_target != null) };
}

// ===== Unused places / utilisation by month =====
// Booked child-days on NSW operating days per calendar month for one centre → unused places (licensed places − average
// booked per operating day with data) and utilisation (booked child-days ÷ places × those days). Months with no booking
// rows are omitted, so callers see gaps rather than zeros. The average is taken over the operating days that actually
// carry a daily_metrics row (`days_with_rows`), not over every operating day in the month: the nightly pull writes only
// the days OWNA returned attendance records for, so a missing day is missing snapshot coverage, never a zero-booked day.
// Dividing by the whole month would count a pull gap as fully empty places. `days_with_rows` < `operating_days` marks a
// month whose coverage is incomplete, so callers can flag or drop it.
// `places` is the licensed count (services/metrics.js placesFor) — callers must pass approved places, not
// the OWNA room sum. A centre with none (null) gets nulls for unused places and utilisation, never zeros.
function placesByMonth(ownaId, places, fromMonth, toMonth) {
  const rows = db.prepare(`SELECT metric_date, booked FROM daily_metrics WHERE owna_id = ? AND substr(metric_date,1,7) BETWEEN ? AND ?`).all(ownaId, fromMonth, toMonth);
  const sums = new Map();
  for (const r of rows) {
    if (!cal.isOperatingDay(r.metric_date)) continue;
    const mo = r.metric_date.slice(0, 7);
    const s = sums.get(mo) || { booked: 0, days: 0 };
    s.booked += r.booked || 0; s.days += 1; // one row per centre-day (daily_metrics PK)
    sums.set(mo, s);
  }
  return [...sums.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, s]) => {
    const [y, mo] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const opDays = cal.operatingDays(`${month}-01`, `${month}-${String(last).padStart(2, "0")}`);
    const avg = s.days ? s.booked / s.days : null;
    return {
      month, booked: s.booked, operating_days: opDays, days_with_rows: s.days, places,
      avg_booked: avg == null ? null : Math.round(avg * 10) / 10,
      unused_places: (avg == null || places == null) ? null : Math.round((places - avg) * 10) / 10,
      utilisation: places == null ? null : pct(s.booked, places * s.days),
    };
  });
}

// Weekly labour budget targets per centre (week-specific overrides, else 'default').
function labourBudgets(weekEnding) {
  const map = {};
  db.prepare(`SELECT * FROM labour_budget WHERE week_ending = 'default'`).all().forEach((b) => { map[b.eh_centre] = b; });
  if (weekEnding) db.prepare(`SELECT * FROM labour_budget WHERE week_ending = ?`).all(weekEnding).forEach((b) => { map[b.eh_centre] = b; });
  return map;
}
function saveLabourBudget(ehCentre, weekEnding, budget) {
  db.prepare(`
    INSERT INTO labour_budget (eh_centre, week_ending, budget_wages, budget_hours, budget_occ, budget_support)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(eh_centre, week_ending) DO UPDATE SET budget_wages=excluded.budget_wages, budget_hours=excluded.budget_hours, budget_occ=excluded.budget_occ, budget_support=excluded.budget_support
  `).run(ehCentre, weekEnding, budget.wages, budget.hours, budget.occ, budget.support);
}

// ===== Per-centre occupancy target =====
// ONE stored value, in labour_budget.budget_occ at week_ending='default'. The wage page and the COE page
// read the same row, so a target changed in either place moves both; nothing here keeps a second copy.
// labour_budget is keyed by the EMPLOYMENT HERO centre name ("Futuro GWH"), not owna_id, so every lookup
// goes through services/eh-labour.js ownaIdFor() — the payroll import's own mapping, reused rather than
// re-implemented. A centre with no stored target falls back to GROUP_TARGET_PCT and says so: the pages must
// be able to print which target each centre was judged against, because they are not all the same number
// (Heath Rd is on 85 while the other three are on 102).
const GROUP_TARGET_PCT = 95;        // the fallback, used ONLY where a centre has no stored target
const MAX_TARGET_PCT = 200;         // a guard against a typo like 1020 — a target above 100 is legitimate here

// Every Employment Hero centre name we know of: the ones payroll has imported, plus any a budget was
// typed against before payroll reached them.
function ehCentreNames() {
  return db.prepare(`SELECT eh_centre FROM labour_weekly WHERE eh_centre IS NOT NULL
                     UNION SELECT eh_centre FROM labour_budget WHERE eh_centre IS NOT NULL
                     ORDER BY eh_centre`).all().map((r) => r.eh_centre);
}
// owna_id -> [eh_centre, …] and eh_centre -> owna_id. Head office and the food project map to no centre
// (ownaIdFor answers null) and are simply absent, which is what makes them invisible to the COE page.
function ehCentreMap() {
  const centres = db.prepare(`SELECT owna_id, name FROM centres`).all();
  const byOwna = {}, byEh = {};
  for (const eh of ehCentreNames()) {
    const id = ownaIdFor(eh, centres);
    byEh[eh] = id;
    if (id) (byOwna[id] = byOwna[id] || []).push(eh);
  }
  return { byOwna, byEh };
}
// The Employment Hero name a centre's target is stored under — the one that already carries a target if
// more than one payroll location maps to the centre, so an edit lands on the row the pages read.
function ehCentreFor(ownaId, budgets = labourBudgets(), map = ehCentreMap()) {
  const names = map.byOwna[ownaId] || [];
  return names.find((n) => budgets[n] && budgets[n].budget_occ != null) || names[0] || null;
}
// Occupancy target per centre, keyed by owna_id: { pct, source: 'centre'|'default', eh_centre }.
// `source` is not decoration — the page has to say "judged against its own 102%" or "against the 95% group
// default" beside the figure, or a reader cannot tell why two centres in the same column are coloured
// differently. A stored 0 or a negative is treated as not set: it is not a target anyone means.
function occupancyTargets() {
  const budgets = labourBudgets(), map = ehCentreMap();
  const out = {};
  for (const c of db.prepare(`SELECT owna_id FROM centres`).all()) {
    const eh = ehCentreFor(c.owna_id, budgets, map);
    const stored = eh && budgets[eh] ? Number(budgets[eh].budget_occ) : NaN;
    out[c.owna_id] = Number.isFinite(stored) && stored > 0
      ? { pct: Math.round(stored * 10) / 10, source: "centre", eh_centre: eh }
      : { pct: GROUP_TARGET_PCT, source: "default", eh_centre: eh };
  }
  return out;
}
function targetFor(ownaId, targets) {
  return (targets || occupancyTargets())[ownaId] || { pct: GROUP_TARGET_PCT, source: "default", eh_centre: null };
}
// The group's target is the places-weighted blend of the centre targets, not their mean and not the
// fallback: 501 places split 365 at 102% and 136 at 85% is a group target of 97.4%, and averaging the four
// numbers instead (97.75%) would quietly weight Heath Rd's 136 places the same as GWH's 119.
function blendedTarget(rows, targets) {
  const places = rows.reduce((a, c) => a + (c.places || 0), 0);
  if (!places) return GROUP_TARGET_PCT;
  const weighted = rows.reduce((a, c) => a + (c.places || 0) * targetFor(c.owna_id, targets).pct, 0);
  return Math.round(weighted / places * 10) / 10;
}
// Parse one submitted target: "" clears it (the centre falls back to the group default), otherwise a
// number from 1 to MAX_TARGET_PCT with at most one decimal. Over 100 is accepted on purpose.
function parseOccupancyTarget(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(/%$/, "").trim();
  if (s === "") return { value: null };
  if (!/^\d{1,3}(\.\d)?$/.test(s)) return { error: "must be a percentage like 102 or 97.5" };
  const n = Number(s);
  if (n < 1 || n > MAX_TARGET_PCT) return { error: `must be between 1 and ${MAX_TARGET_PCT}` };
  return { value: n };
}
// Write a target back to the ONE row it lives in, leaving the wage and hours budgets on that row alone —
// saveLabourBudget replaces every column, so the untouched ones have to be read and written back.
// Answers false when the centre has no Employment Hero name yet: there is nothing to key the row on, and
// inventing one would create the second copy this whole section exists to avoid.
function saveOccupancyTarget(ownaId, pctValue) {
  const eh = ehCentreFor(ownaId);
  if (!eh) return false;
  const b = labourBudgets()[eh] || {};
  saveLabourBudget(eh, "default", {
    wages: b.budget_wages != null ? b.budget_wages : null,
    hours: b.budget_hours != null ? b.budget_hours : null,
    occ: pctValue,
    support: b.budget_support != null ? b.budget_support : null,
  });
  return true;
}

// ===== Approved places (admin maintenance) =====
// Nothing automated can fill this in: OWNA does not hold the licensed count, so it comes off the service
// approval on the ACECQA National Register and is typed in at /admin/places. Every centre is listed,
// pre-opening ones included, with the OWNA room sum beside the licensed count so that a discrepancy
// (Austral: 124 approved places, 122 room capacity) is visible instead of silently wrong.
const MAX_APPROVED_PLACES = 500; // a guard against a typo like 1240, not a regulatory limit
const ACECQA_SERVICE_URL = "https://www.acecqa.gov.au/resources/national-registers/services/";
// The occupancy target rides along on these rows: it is a percentage OF the approved places on the same
// line, so this is where a reader looks for it. `target_stored` is the value actually in labour_budget
// (null = nothing stored, and the centre falls back to the group default), kept separate from `target_pct`
// so the form's input can be blank rather than pre-filled with a default nobody typed. `target_eh_centre`
// is null for a centre payroll has never seen, and the form has to say the target cannot be stored yet.
function placesAdminRows() {
  const budgets = labourBudgets(), map = ehCentreMap(), targets = occupancyTargets();
  return db.prepare(`SELECT owna_id, name, capacity, approved_places, approval_no, opening, opening_year, opening_month
    FROM centres ORDER BY COALESCE(opening, 0), name`).all().map((c) => {
    const eh = ehCentreFor(c.owna_id, budgets, map);
    const stored = eh && budgets[eh] && Number(budgets[eh].budget_occ) > 0 ? Math.round(Number(budgets[eh].budget_occ) * 10) / 10 : null;
    const t = targetFor(c.owna_id, targets);
    return {
      ...c,
      places: placesFor(c),
      // Only meaningful once both numbers exist: null means "nothing to compare", not "they agree".
      discrepancy: (c.approved_places != null && c.capacity) ? c.approved_places - c.capacity : null,
      register_url: c.approval_no ? ACECQA_SERVICE_URL + encodeURIComponent(c.approval_no) : null,
      target_eh_centre: eh, target_stored: stored, target_pct: t.pct, target_source: t.source,
    };
  });
}
// Parse one submitted value: "" (blank) clears it, otherwise a positive integer up to MAX_APPROVED_PLACES.
// Returns { value } or { error } — rubbish is rejected outright rather than silently coerced to 0, which is
// the whole failure this field exists to stop.
function parseApprovedPlaces(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (s === "") return { value: null };
  if (!/^\d+$/.test(s)) return { error: "must be a whole number of places" };
  const n = Number(s);
  if (n < 1 || n > MAX_APPROVED_PLACES) return { error: `must be between 1 and ${MAX_APPROVED_PLACES}` };
  return { value: n };
}
function saveApprovedPlaces(ownaId, places) {
  db.prepare("UPDATE centres SET approved_places = ? WHERE owna_id = ?").run(places, ownaId);
}

// ===== Enrolment projection (scenario) =====

// Confidence scopes → LineLeader status ids to include.
const PROJECTION_SCOPES = {
  committed: { label: "Committed (offers accepted)", statuses: [5, 12] },
  likely: { label: "Likely (+ waitlist & toured)", statuses: [5, 12, 4, 3] },
  all: { label: "All active pipeline", statuses: [5, 12, 4, 3, 1, 2, 11] },
};
const DOW_ABBR = ["su", "mo", "tu", "we", "th", "fr", "sa"];

// Project occupancy per centre over the next `days`, adding CRM pipeline children on their
// expected start date + weekly schedule on top of OWNA's already-booked future.
function projection(scope = "likely", days = 90) {
  const scopeDef = PROJECTION_SCOPES[scope] || PROJECTION_SCOPES.likely;
  const statusSet = new Set(scopeDef.statuses);
  const today = todayStr();
  const to = cal.addDays(today, days);

  const centres = db.prepare(`SELECT owna_id, name, capacity, ${PLACES_SQL} AS places FROM centres WHERE ll_id IS NOT NULL AND ${PLACES_SQL} > 0`).all();

  // Base future bookings per centre per date.
  const baseRows = db.prepare(`
    SELECT owna_id, metric_date, booked FROM daily_metrics
    WHERE metric_date > ? AND metric_date <= ?
  `).all(today, to);
  const baseByCentre = new Map();
  for (const r of baseRows) {
    if (!baseByCentre.has(r.owna_id)) baseByCentre.set(r.owna_id, []);
    baseByCentre.get(r.owna_id).push(r);
  }

  // Pipeline starts in scope, grouped by centre.
  const psByCentre = new Map();
  const psFull = db.prepare(`
    SELECT owna_id, status_id, expected_start, days_csv FROM ll_pipeline_starts
    WHERE owna_id IS NOT NULL AND expected_start <= ?
  `).all(to);
  for (const r of psFull) {
    if (!statusSet.has(r.status_id)) continue;
    if (!psByCentre.has(r.owna_id)) psByCentre.set(r.owna_id, []);
    psByCentre.get(r.owna_id).push({ start: r.expected_start, days: (r.days_csv || "").split(",").filter(Boolean) });
  }

  const rows = centres.map((c) => {
    const base = baseByCentre.get(c.owna_id) || [];
    const starts = psByCentre.get(c.owna_id) || [];
    base.sort((a, b) => (a.metric_date < b.metric_date ? -1 : 1));
    let baseBooked = 0, projBooked = 0, addedChildDays = 0;
    const weeks = new Map(); // weekStart -> {baseBooked, projBooked, days}
    for (const d of base) {
      const dow = DOW_ABBR[new Date(d.metric_date + "T00:00:00").getDay()];
      let adds = 0;
      for (const s of starts) {
        if (s.start <= d.metric_date && s.days.includes(dow)) adds += 1;
      }
      baseBooked += d.booked;
      projBooked += d.booked + adds;
      addedChildDays += adds;
      const wk = weekStart(d.metric_date);
      let w = weeks.get(wk);
      if (!w) { w = { week: wk, baseBooked: 0, projBooked: 0, days: 0 }; weeks.set(wk, w); }
      w.baseBooked += d.booked; w.projBooked += d.booked + adds; w.days += 1;
    }
    const capDays = c.places * base.length; // licensed places × days in the horizon
    const weekly = [...weeks.values()].map((w) => ({
      week: w.week,
      base_occ: pct(w.baseBooked, c.places * w.days),
      proj_occ: pct(w.projBooked, c.places * w.days),
    }));
    return {
      owna_id: c.owna_id, name: c.name, capacity: c.capacity, places: c.places, days: base.length,
      pipeline_children: starts.length,
      base_occ: pct(baseBooked, capDays),
      proj_occ: pct(projBooked, capDays),
      added_child_days: addedChildDays,
      weekly,
    };
  });
  return { scope, scopeLabel: scopeDef.label, days, to, rows, scopes: PROJECTION_SCOPES };
}

// Monday (ISO week start) for a YYYY-MM-DD date, as YYYY-MM-DD. Parsed and stepped in UTC: parsing
// as local time and then slicing an ISO string lands a day early on any host east of Greenwich.
function weekStart(dateStr) {
  const dow = (new Date(dateStr + "T00:00:00Z").getUTCDay() + 6) % 7; // 0 = Monday
  return cal.addDays(dateStr, -dow);
}

// ===== Operating days, seats & utilisation =====
// Operating day = weekday that is not a NSW public holiday (services/calendar.js). OWNA keeps booking
// rows on public holidays (the centre is closed, nobody attends), so seats and utilisation only count
// bookings that fall on operating days.

// Start of the reporting year containing `today`: 'fy' = 1 July (Australian financial year), 'cy' = 1 January.
function yearStart(kind, today = todayStr()) {
  const y = Number(today.slice(0, 4)), mo = Number(today.slice(5, 7));
  if (kind === "cy") return `${y}-01-01`;
  return mo >= 7 ? `${y}-07-01` : `${y - 1}-07-01`;
}

// The full reporting year around `today`: { kind, start, end, label ("FY2026-27" / "CY2026"), ytdLabel }.
function yearRange(kind, today = todayStr()) {
  const k = kind === "cy" ? "cy" : "fy";
  const start = yearStart(k, today);
  const y = Number(start.slice(0, 4));
  return {
    kind: k, start,
    end: k === "cy" ? `${y}-12-31` : `${y + 1}-06-30`,
    label: k === "cy" ? `CY${y}` : `FY${y}-${String(y + 1).slice(2)}`,
    ytdLabel: k === "cy" ? "CYTD" : "FYTD",
  };
}

// Seats filled = average booked children per operating day, per operating centre and for the group:
// sum of booked on operating days ÷ operating days in the range that have any bookings.
function seatsFilled(from, to) {
  const rows = db.prepare(`
    SELECT d.owna_id, c.name, c.capacity, ${PLACES_SQL_C} AS places, d.metric_date, d.booked
    FROM daily_metrics d JOIN centres c ON c.owna_id = d.owna_id
    WHERE d.metric_date BETWEEN ? AND ? AND (c.opening IS NULL OR c.opening = 0) AND ${PLACES_SQL_C} > 0
  `).all(from, to);
  const byCentre = new Map(); const groupDays = new Set(); let groupBooked = 0;
  for (const r of rows) {
    if (!(r.booked > 0) || !cal.isOperatingDay(r.metric_date)) continue;
    let c = byCentre.get(r.owna_id);
    if (!c) { c = { owna_id: r.owna_id, name: r.name, capacity: r.capacity, places: r.places, booked: 0, days: 0 }; byCentre.set(r.owna_id, c); }
    c.booked += r.booked; c.days += 1;
    groupBooked += r.booked; groupDays.add(r.metric_date);
  }
  const finish = (c) => ({ ...c, seats: c.days ? Math.round(c.booked / c.days) : 0 });
  const list = [...byCentre.values()].sort((a, b) => a.name.localeCompare(b.name)).map(finish);
  const byOwna = {}; list.forEach((r) => { byOwna[r.owna_id] = r; });
  // The group row is the SUM OF THE CENTRE AVERAGES, not groupBooked ÷ distinct dates.
  //
  // Those agree only while every centre has a row on every date. Forward coverage is ragged — the
  // centres' bookings run out on different dates (Bardia stops 2027-03-19, Austral goes to 2027-04-30),
  // and some dates in between carry one centre and no others. Dividing the whole group's bookings by
  // the union of dates then averages a one-centre day against a four-centre day: over 2026-09-17 to
  // 2026-12-16 it returned 326 while the four centre rows above it read 121, 120, 118 and 93 — a group
  // total smaller than three of its parts, under a heading that says "seats filled".
  //
  // The days field stays the union, because the coverage note is drawn from it; raggedCoverage says
  // whether the centres disagree about it, so a view can qualify the figure instead of implying that
  // every centre was measured over the same span.
  const dayCounts = list.map((c) => c.days);
  return {
    from, to,
    operating_days: cal.operatingDays(from, to),
    rows: list, byOwna,
    group: {
      booked: groupBooked,
      days: groupDays.size,
      seats: list.reduce((sum, c) => sum + c.seats, 0),
    },
    raggedCoverage: dayCounts.length > 1 && Math.min(...dayCounts) !== Math.max(...dayCounts),
    coverageRange: dayCounts.length ? { min: Math.min(...dayCounts), max: Math.max(...dayCounts) } : null,
    unknownYears: cal.unknownHolidayYears(from, to),
  };
}

// Utilisation year-to-date = booked child-days on operating days from the year start to today
// ÷ (licensed places × operating days from the year start to today), per operating centre and group.
// Also returns the annual denominator: operating days in the full year × places (e.g. "253 × 499").
function utilisationYtd(kind = "fy", today = todayStr()) {
  const yr = yearRange(kind, today);
  const to = today > yr.end ? yr.end : today;
  const centreRows = db.prepare(`
    SELECT owna_id, name, capacity, ${PLACES_SQL} AS places FROM centres
    WHERE (opening IS NULL OR opening = 0) AND ${PLACES_SQL} > 0 ORDER BY name
  `).all();
  const bookedRows = db.prepare(`SELECT owna_id, metric_date, booked FROM daily_metrics WHERE metric_date BETWEEN ? AND ?`).all(yr.start, to);
  const sum = new Map();
  for (const r of bookedRows) {
    if (!cal.isOperatingDay(r.metric_date)) continue;
    sum.set(r.owna_id, (sum.get(r.owna_id) || 0) + (r.booked || 0));
  }
  const opDaysYtd = cal.operatingDays(yr.start, to);
  const opDaysYear = cal.operatingDays(yr.start, yr.end);
  const rows = centreRows.map((c) => {
    const booked = sum.get(c.owna_id) || 0;
    const capDays = c.places * opDaysYtd; // licensed places × operating days to date
    return { ...c, booked, cap_days: capDays, utilisation: pct(booked, capDays), annual_child_days: c.places * opDaysYear };
  });
  const byOwna = {}; rows.forEach((r) => { byOwna[r.owna_id] = r; });
  const places = rows.reduce((s, r) => s + r.places, 0);
  const gBooked = rows.reduce((s, r) => s + r.booked, 0);
  const gCap = places * opDaysYtd;
  return {
    ...yr, today: to,
    operating_days_ytd: opDaysYtd, operating_days_year: opDaysYear,
    places, rows, byOwna,
    // group.capacity keeps its name for callers, but it is now the sum of APPROVED PLACES — the group's
    // licensed total (501 across the four operating services), not the sum of OWNA room capacities (499).
    group: { booked: gBooked, cap_days: gCap, utilisation: pct(gBooked, gCap), capacity: places, annual_child_days: places * opDaysYear },
    annual_child_days: places * opDaysYear,
    unknownYears: cal.unknownHolidayYears(yr.start, yr.end),
  };
}

// Serious incidents (Reg 12) for one centre over the 12 calendar months ending with the current month,
// with how many of those months actually have data. `reportable` = emergency services attended or
// medical attention sought, recorded from OWNA incident reports.
function reg12Last12Months(ownaId, today = todayStr()) {
  const [y, mo] = today.slice(0, 7).split("-").map(Number);
  const fromMonth = new Date(Date.UTC(y, mo - 12, 1)).toISOString().slice(0, 7); // 11 months back
  const toMonth = today.slice(0, 7);
  const r = db.prepare(`
    SELECT COALESCE(SUM(reportable),0) AS reportable, COALESCE(SUM(serious),0) AS serious, COALESCE(SUM(total),0) AS total,
           COUNT(*) AS months, MIN(month) AS first_month, MAX(month) AS last_month
    FROM incidents_monthly WHERE owna_id = ? AND month BETWEEN ? AND ?
  `).get(ownaId, fromMonth, toMonth);
  return { from_month: fromMonth, to_month: toMonth, reportable: r.reportable, serious: r.serious, total: r.total,
    months: r.months, first_month: r.first_month, last_month: r.last_month };
}

// ===== Exit report read-model =====

const REASON_LABEL_NONE = "Not recorded";

// Per-centre exit summary (past vs scheduled + top recorded reason).
// The one window every exit figure on the page uses, so the summary and the churn table cannot
// disagree again.
const EXIT_WINDOW_MONTHS = 12;

// Departures over the same rolling window the churn table uses (12 months by default). It used to
// count every row in child_exits with no window at all, which read 313 while churn on the same page
// read 310 — the three departures that had aged past twelve months. The detail table only ever holds
// about a year anyway (the nightly pull's look-back), so "all of it" was a window pretending not to be.
function exitsSummary(months = EXIT_WINDOW_MONTHS, today = todayStr()) {
  const d = new Date(today + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() - months);
  const from = d.toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT c.owna_id, c.name,
      SUM(e.upcoming = 0 AND e.finish_date > @from AND e.finish_date <= @today) AS past,
      SUM(e.upcoming = 1) AS upcoming,
      SUM(e.upcoming = 0 AND e.finish_date > @from AND e.finish_date <= @today AND e.reason IS NOT NULL AND e.reason <> 'Unknown') AS reason_known,
      AVG(CASE WHEN e.upcoming = 0 AND e.finish_date > @from AND e.finish_date <= @today AND e.tenure_days > 0 THEN e.tenure_days END) AS avg_tenure
    FROM centres c LEFT JOIN child_exits e ON e.owna_id = c.owna_id
    GROUP BY c.owna_id ORDER BY past DESC
  `).all({ from, today });
  return rows.map((r) => {
    const top = db.prepare(`
      SELECT reason, COUNT(*) n FROM child_exits
      WHERE owna_id = ? AND upcoming = 0 AND reason IS NOT NULL AND reason <> 'Unknown'
      GROUP BY reason ORDER BY n DESC LIMIT 1
    `).get(r.owna_id);
    return {
      ...r,
      past: r.past || 0, upcoming: r.upcoming || 0, reason_known: r.reason_known || 0,
      avg_tenure_months: r.avg_tenure ? Math.round(r.avg_tenure / 30.4) : null,
      top_reason: top ? `${top.reason} (${top.n})` : "—",
    };
  });
}

// Reason distribution for the whole group or one centre (past exits).
function exitReasons(ownaId) {
  const where = ownaId ? "AND owna_id = ?" : "";
  const args = ownaId ? [ownaId] : [];
  const rows = db.prepare(`
    SELECT COALESCE(reason, '${REASON_LABEL_NONE}') AS reason, COUNT(*) n
    FROM child_exits WHERE upcoming = 0 ${where}
    GROUP BY COALESCE(reason, '${REASON_LABEL_NONE}') ORDER BY n DESC
  `).all(...args);
  const total = rows.reduce((s, r) => s + r.n, 0);
  return { rows, total };
}

// Individual exits for one centre (most recent first). scope: 'past' | 'upcoming' | 'all'.
// De-identified: child_exits holds no name or date of birth, so there is none to select.
function centreExits(ownaId, scope = "past", limit = 200) {
  const cond = scope === "past" ? "AND upcoming = 0" : scope === "upcoming" ? "AND upcoming = 1" : "";
  return db.prepare(`
    SELECT room, start_date, finish_date, tenure_days, upcoming, reason, reason_source
    FROM child_exits WHERE owna_id = ? ${cond}
    ORDER BY finish_date DESC LIMIT ?
  `).all(ownaId, limit);
}

function exitsLatestDate() {
  const r = db.prepare(`SELECT MAX(updated_at) d FROM child_exits`).get();
  return r && r.d;
}

// ---- Exit report: by month / by year, finish dates set, tenure, churn ----

// YYYY-MM for the calendar month `offset` months from the month containing `today` (0 = current month).
function monthKey(today, offset) {
  const [y, mo] = today.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1 + offset, 1)).toISOString().slice(0, 7);
}

// Operating centres — the only ones with OWNA children, so the only ones that can have exits — alphabetical.
function exitCentres() {
  return db.prepare(`SELECT owna_id, name, capacity, enrolled FROM centres WHERE (opening IS NULL OR opening = 0) AND capacity > 0 ORDER BY name`).all();
}

// Earliest departure the per-child detail holds. child_exits is rebuilt every sync with a fixed look-back
// (EXIT_LOOKBACK_DAYS, default 365), so it only ever covers the last 12 months.
function exitsCapturedFrom() {
  const r = db.prepare(`SELECT MIN(finish_date) d FROM child_exits WHERE upcoming = 0`).get();
  return (r && r.d) || null;
}

// Earliest month the monthly aggregate holds. exits_monthly is written by each exit rebuild before the
// detail rows age out, so it keeps counting departures the look-back let go of long ago.
function exitsAggregateFromMonth() {
  const r = db.prepare(`SELECT MIN(month) m FROM exits_monthly WHERE upcoming = 0`).get();
  return (r && r.m) || null;
}

// Where the departure history starts, at the best precision available: the exact date while the detail is
// the only source, the first of the aggregate's earliest month once the aggregate reaches further back.
// Months before this are "not captured", not zero.
function exitsHistoryFrom() {
  const detail = exitsCapturedFrom(), agg = exitsAggregateFromMonth();
  if (!agg) return detail;
  if (!detail || agg < detail.slice(0, 7)) return `${agg}-01`;
  return detail;
}

// Past departures per centre and month, keyed "owna_id|YYYY-MM": the detail window where it covers the
// month, the monthly aggregate before that. The month the look-back starts in is partial in the detail and
// complete in the aggregate (written before those rows aged out), so it takes the greater of the two.
function pastDeparturesByMonth() {
  const detail = new Map();
  db.prepare(`SELECT owna_id, substr(finish_date, 1, 7) AS month, COUNT(*) n FROM child_exits WHERE upcoming = 0 GROUP BY owna_id, month`).all()
    .forEach((r) => detail.set(`${r.owna_id}|${r.month}`, r.n));
  const agg = new Map();
  db.prepare(`SELECT owna_id, month, SUM(departures) n FROM exits_monthly WHERE upcoming = 0 GROUP BY owna_id, month`).all()
    .forEach((r) => agg.set(`${r.owna_id}|${r.month}`, r.n));
  const detailFrom = exitsCapturedFrom();
  const boundary = detailFrom ? detailFrom.slice(0, 7) : null;
  const out = new Map();
  new Set([...detail.keys(), ...agg.keys()]).forEach((k) => {
    const month = k.slice(-7), d = detail.get(k) || 0, a = agg.get(k) || 0;
    out.set(k, boundary == null || month < boundary ? a : (month === boundary ? Math.max(d, a) : d));
  });
  return out;
}

// Departures (upcoming = 0) per calendar month for the `months` months ending with the current month, per
// operating centre and for the group, from the detail window and the monthly aggregate before it. Months
// before the history starts are null (not captured). `captured_from` is where the per-child detail starts,
// `history_from` where the counts start — they differ once the aggregate outlives the look-back.
function exitsByMonth(months = 24, today = todayStr()) {
  const axis = []; for (let i = months - 1; i >= 0; i--) axis.push(monthKey(today, -i));
  const capturedFrom = exitsCapturedFrom();
  const historyFrom = exitsHistoryFrom();
  const capMonth = historyFrom ? historyFrom.slice(0, 7) : null;
  const captured = (mo) => capMonth != null && mo >= capMonth;
  const map = pastDeparturesByMonth();
  const rows = exitCentres().map((c) => {
    const points = axis.map((mo) => (captured(mo) ? (map.get(`${c.owna_id}|${mo}`) || 0) : null));
    return { owna_id: c.owna_id, name: c.name, points, total: points.reduce((s, v) => s + (v || 0), 0) };
  });
  const group = { points: axis.map((mo, i) => (captured(mo) ? rows.reduce((s, r) => s + (r.points[i] || 0), 0) : null)) };
  group.total = group.points.reduce((s, v) => s + (v || 0), 0);
  return { months: axis, current: axis[axis.length - 1], captured_from: capturedFrom, history_from: historyFrom, rows, group };
}

// Departures (upcoming = 0) per reporting year — 'fy' = financial years from 1 July (label "FY 2025-26"),
// 'cy' = calendar years — per operating centre and for the group, from the earliest captured year to the current one.
// A year is `to_date` when it has not finished, and carries `captured_from` when the history only covers part of it.
// Counts come from the monthly aggregate outside the detail look-back, so years keep building as history accumulates.
function exitsByYear(kind = "fy", today = todayStr()) {
  const k = kind === "cy" ? "cy" : "fy";
  const startYear = (d) => { const y = Number(d.slice(0, 4)); return k === "cy" ? y : (Number(d.slice(5, 7)) >= 7 ? y : y - 1); };
  const capturedFrom = exitsHistoryFrom();
  const years = [];
  for (let y = startYear(capturedFrom || today); y <= startYear(today); y++) {
    const start = k === "cy" ? `${y}-01-01` : `${y}-07-01`, end = k === "cy" ? `${y}-12-31` : `${y + 1}-06-30`;
    years.push({
      key: String(y), label: k === "cy" ? String(y) : `FY ${y}-${String(y + 1).slice(2)}`, start, end,
      to_date: end > today, captured_from: capturedFrom && capturedFrom > start ? capturedFrom : null,
    });
  }
  const tally = new Map();
  pastDeparturesByMonth().forEach((n, key) => {
    const ownaId = key.slice(0, -8), yearKey = `${ownaId}|${startYear(key.slice(-7))}`;
    tally.set(yearKey, (tally.get(yearKey) || 0) + n);
  });
  const rows = exitCentres().map((c) => {
    const counts = {}; years.forEach((y) => { counts[y.key] = tally.get(`${c.owna_id}|${y.key}`) || 0; });
    return { owna_id: c.owna_id, name: c.name, counts, total: Object.values(counts).reduce((s, v) => s + v, 0) };
  });
  const group = { counts: {} }; years.forEach((y) => { group.counts[y.key] = rows.reduce((s, r) => s + r.counts[y.key], 0); });
  group.total = Object.values(group.counts).reduce((s, v) => s + v, 0);
  return { kind: k, years, rows, group, captured_from: capturedFrom };
}

// Finish dates already set in OWNA (upcoming = 1) per month for the current month and the following
// `months` - 1, per operating centre and for the group; anything beyond the window is counted in `later`.
// A row still flagged upcoming with a finish month before the current one lands in `overdue` — the flag is
// stamped at snapshot time, so a missed or partly failed snapshot across a month end leaves rows dated in the
// past. They are counted, not dropped, so the total always reconciles with the scheduled-to-leave headcount.
// This is the COE leaver signal: confirmed departures whose places will need refilling.
function upcomingExitsByMonth(months = 8, today = todayStr()) {
  const axis = []; for (let i = 0; i < months; i++) axis.push(monthKey(today, i));
  const last = axis[axis.length - 1];
  const map = new Map(), laterMap = new Map(), overdueMap = new Map();
  db.prepare(`SELECT owna_id, substr(finish_date, 1, 7) AS month, COUNT(*) AS n FROM child_exits WHERE upcoming = 1 GROUP BY owna_id, month`).all()
    .forEach((r) => {
      if (r.month > last) laterMap.set(r.owna_id, (laterMap.get(r.owna_id) || 0) + r.n);
      else if (r.month < axis[0]) overdueMap.set(r.owna_id, (overdueMap.get(r.owna_id) || 0) + r.n);
      else map.set(`${r.owna_id}|${r.month}`, r.n);
    });
  const rows = exitCentres().map((c) => {
    const points = axis.map((mo) => map.get(`${c.owna_id}|${mo}`) || 0);
    const later = laterMap.get(c.owna_id) || 0, overdue = overdueMap.get(c.owna_id) || 0;
    return { owna_id: c.owna_id, name: c.name, points, later, overdue, total: points.reduce((s, v) => s + v, 0) + overdue + later };
  });
  const group = {
    points: axis.map((_, i) => rows.reduce((s, r) => s + r.points[i], 0)),
    later: rows.reduce((s, r) => s + r.later, 0), overdue: rows.reduce((s, r) => s + r.overdue, 0),
  };
  group.total = group.points.reduce((s, v) => s + v, 0) + group.overdue + group.later;
  return { months: axis, rows, group };
}

// Average and median tenure of departed children (upcoming = 0, tenure_days > 0) in years (÷ 365.25), per
// operating centre and overall, with the count each figure rests on. Departed children without a usable
// start date (tenure null or zero) are excluded from the averages and reported in `excluded`.
function tenureByCentre() {
  const years = (days) => Math.round((days / 365.25) * 100) / 100;
  const stats = (vals) => {
    if (!vals.length) return { n: 0, avg_days: null, median_days: null, avg_years: null, median_years: null };
    const s = vals.slice().sort((a, b) => a - b), mid = Math.floor(s.length / 2);
    const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    const avg = s.reduce((a, b) => a + b, 0) / s.length;
    return { n: s.length, avg_days: Math.round(avg), median_days: Math.round(median), avg_years: years(avg), median_years: years(median) };
  };
  const byCentre = new Map();
  db.prepare(`SELECT owna_id, tenure_days FROM child_exits WHERE upcoming = 0`).all().forEach((e) => {
    const c = byCentre.get(e.owna_id) || { departed: 0, vals: [] };
    c.departed += 1; if (e.tenure_days > 0) c.vals.push(e.tenure_days); byCentre.set(e.owna_id, c);
  });
  const all = { departed: 0, vals: [] };
  const rows = exitCentres().map((c) => {
    const t = byCentre.get(c.owna_id) || { departed: 0, vals: [] };
    all.departed += t.departed; all.vals.push(...t.vals);
    return { owna_id: c.owna_id, name: c.name, departed: t.departed, excluded: t.departed - t.vals.length, ...stats(t.vals) };
  });
  return { rows, group: { departed: all.departed, excluded: all.departed - all.vals.length, ...stats(all.vals) } };
}

// Departures over the last `months` months (window (from, today]) per operating centre and per room — the room
// at exit as recorded in OWNA, rooms in descending order of departures — with an annualised churn rate:
// departures × (12 ÷ months) ÷ average booked children per operating day over the same window (daily_metrics,
// NSW operating days with bookings). A centre with no booking data in the window falls back to centres.enrolled.
function churnByRoom(months = EXIT_WINDOW_MONTHS, today = todayStr()) {
  const d = new Date(today + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() - months);
  const from = d.toISOString().slice(0, 10);
  const roomRows = db.prepare(`
    SELECT owna_id, room, COUNT(*) AS n FROM child_exits
    WHERE upcoming = 0 AND finish_date > ? AND finish_date <= ?
    GROUP BY owna_id, room ORDER BY n DESC, room IS NULL, room
  `).all(from, today);
  const seat = new Map();
  db.prepare(`SELECT owna_id, metric_date, booked FROM daily_metrics WHERE metric_date > ? AND metric_date <= ? AND booked > 0`).all(from, today)
    .forEach((r) => { if (!cal.isOperatingDay(r.metric_date)) return; const s = seat.get(r.owna_id) || { sum: 0, days: 0 }; s.sum += r.booked; s.days += 1; seat.set(r.owna_id, s); });
  const annualise = (n) => (n * 12) / months;
  const rate = (n, den) => (den > 0 ? Math.round((annualise(n) / den) * 1000) / 10 : null);
  let gDep = 0, gDen = 0;
  const rows = exitCentres().map((c) => {
    const rooms = roomRows.filter((r) => r.owna_id === c.owna_id);
    const departures = rooms.reduce((s, r) => s + r.n, 0);
    const s = seat.get(c.owna_id);
    const denominator = s ? s.sum / s.days : (c.enrolled > 0 ? c.enrolled : 0);
    gDep += departures; gDen += denominator;
    return {
      owna_id: c.owna_id, name: c.name, departures, annualised: Math.round(annualise(departures) * 10) / 10,
      avg_booked: s ? Math.round((s.sum / s.days) * 10) / 10 : null, booked_days: s ? s.days : 0,
      enrolled: c.enrolled || 0, denominator_source: s ? "booked" : (c.enrolled > 0 ? "enrolled" : null),
      churn_pct: rate(departures, denominator),
      rooms: rooms.map((r) => ({ room: r.room || "Not recorded", n: r.n, share: pct(r.n, departures) })),
    };
  });
  return {
    from, to: today, months, rows,
    group: { departures: gDep, annualised: Math.round(annualise(gDep) * 10) / 10, avg_booked: Math.round(gDen * 10) / 10, churn_pct: rate(gDep, gDen) },
  };
}





// ===== Monthly action plan (RAG auto-suggest + manual) =====
const AP_AREAS = [
  { key: "occupancy", group: "Business Performance", label: "Occupancy — actual vs target" },
  { key: "labour", group: "Business Performance", label: "Wages — actual vs budget" },
  { key: "costs", group: "Business Performance", label: "Other costs vs budget" },
  { key: "quality", group: "High Quality Practice", label: "Compliance snapshot" },
  { key: "family", group: "Family Experience", label: "Family NPS / feedback" },
  { key: "enps", group: "Team Experience", label: "Team engagement (eNPS)" },
  { key: "team", group: "Team Experience", label: "Turnover & absence" },
  { key: "safety", group: "Safety Culture", label: "Child / adult injury rate" },
  { key: "leadership", group: "Centre Leadership", label: "Roles in place / CM feedback" },
];
const rag = (v, greenAtLeast, amberAtLeast, lowerBetter) => {
  if (v == null) return null;
  if (lowerBetter) return v <= greenAtLeast ? "green" : v <= amberAtLeast ? "amber" : "red";
  return v >= greenAtLeast ? "green" : v >= amberAtLeast ? "amber" : "red";
};
// Suggested RAG per area from live module data, for one centre.
function actionPlanAuto(ownaId) {
  const out = {};
  // Occupancy: latest month
  const occT = occupancyTrend(ownaId, 1); const occ = occT.length ? occT[occT.length - 1].occupancy : null;
  if (occ != null) out.occupancy = { rating: rag(occ, 95, 85, false), reason: `Occupancy ${occ}% (target ~100%)` };
  // Labour: latest complete week wage % of revenue
  const lw = labourWeeks(1)[0];
  if (lw) { const row = labourForWeek(lw).find((r) => r.owna_id === ownaId); if (row && row.wage_pct != null) out.labour = { rating: rag(row.wage_pct, 55, 65, true), reason: `Educator wages ${row.wage_pct}% of revenue (week ${lw})` }; }
  // Quality: compliance overall
  const qc = qcCentre(ownaId);
  if (qc && qc.overall_pct != null) out.quality = { rating: rag(qc.overall_pct, 90, 75, false), reason: `Compliance ${qc.overall_pct}% (${qc.actions.filter((a)=>!/^y/i.test((a.completed||"").trim())).length} open actions)` };
  // Family (eNPS) + Team (turnover): latest P&C month
  const pm = pcMonths(1)[0];
  if (pm) { const pr = pcForMonth(pm, ownaId)[0]; const t = pcTargets();
    if (pr && pr.family_nps != null) out.family = { rating: rag(pr.family_nps, t.family_nps || 30, (t.family_nps || 30) - 15, false), reason: `Family NPS ${pr.family_nps}` };
    if (pr && pr.enps != null) out.enps = { rating: rag(pr.enps, t.enps || 30, (t.enps || 30) - 15, false), reason: `eNPS ${pr.enps}` };
  }
  // Turnover is the figure the OWNER enters (rolling 12 months, resignations + terminations). The
  // spreadsheet column in pc_metrics is the fallback for a centre he has not entered yet.
  { const t = pcTargets();
    const tr = pcTurnoverReport(ownaId);
    let v = tr ? tr.rates.combined : null, why = tr && tr.window ? `rolling ${tr.window.entered} month${tr.window.entered === 1 ? "" : "s"}` : "";
    if (v == null) { const pm = pcMonths(1)[0]; const pr = pm ? pcForMonth(pm, ownaId)[0] : null; if (pr && pr.turnover != null) { v = pr.turnover; why = "HR spreadsheet"; } }
    if (v != null) out.team = { rating: rag(v, t.turnover || 15, (t.turnover || 15) + 5, true), reason: `Turnover ${v}%${why ? ` (${why})` : ""}` };
  }
  // Safety: serious child incidents (reg 12: emergency services or medical attention) in the latest complete month.
  const inc = incidentsMonth(ownaId, null, true);
  if (inc) out.safety = { rating: rag(inc.reportable, 0, 1, true),
    reason: `${inc.reportable} serious incident${inc.reportable === 1 ? "" : "s"} (Reg 12) · ${inc.total} incidents, ${inc.injuries} injuries · ${inc.month}` };
  return out;
}
function incidentsMonth(ownaId, month, preferComplete) {
  // Exact month if given/available; else the latest available. preferComplete skips
  // the partial current calendar month so ratings aren't understated mid-month.
  if (month) {
    const r = db.prepare("SELECT * FROM incidents_monthly WHERE owna_id=? AND month=?").get(ownaId, month);
    if (r) return r;
  }
  const nowMonth = cal.currentMonth();
  if (preferComplete) {
    const r = db.prepare("SELECT * FROM incidents_monthly WHERE owna_id=? AND month<? ORDER BY month DESC LIMIT 1").get(ownaId, nowMonth);
    if (r) return r;
  }
  return db.prepare("SELECT * FROM incidents_monthly WHERE owna_id=? ORDER BY month DESC LIMIT 1").get(ownaId) || null;
}

const INCIDENT_KEYS = ["total", "injuries", "illness", "serious", "reportable"];

// Sum incident counts per centre and for the group over an inclusive YYYY-MM range, with how many
// months of data each centre has in that range. Rows follow the order of `centreRows`.
function incidentTotalsBetween(centreRows, fromMonth, toMonth) {
  const q = db.prepare(`
    SELECT COALESCE(SUM(total),0) total, COALESCE(SUM(injuries),0) injuries, COALESCE(SUM(illness),0) illness,
           COALESCE(SUM(serious),0) serious, COALESCE(SUM(reportable),0) reportable, COUNT(*) months
    FROM incidents_monthly WHERE owna_id = ? AND month BETWEEN ? AND ?
  `);
  const rows = centreRows.map((c) => ({ owna_id: c.owna_id, name: c.name, ...q.get(c.owna_id, fromMonth, toMonth) }));
  const group = { total: 0, injuries: 0, illness: 0, serious: 0, reportable: 0, months: 0 };
  rows.forEach((r) => { INCIDENT_KEYS.forEach((k) => { group[k] += r[k]; }); group.months = Math.max(group.months, r.months); });
  return { from_month: fromMonth, to_month: toMonth, rows, group };
}

// Rolling incident report: per-centre month-by-month grid + last-complete-month headline, plus
// year-to-date totals for the chosen reporting year (yearKind 'fy' = from 1 July, 'cy' = from 1 January)
// and the 12 calendar months ending with the current month. "Notified to the Department" on the Safety
// page is the `reportable` (Reg 12) count: OWNA exposes no separate notification flag.
function incidentsReport(scopedOwnaId, monthsBack = 12, headlineMonth = null, yearKind = "fy", today = todayStr()) {
  let months = db.prepare("SELECT DISTINCT month FROM incidents_monthly ORDER BY month DESC LIMIT ?").all(monthsBack).map((r) => r.month);
  months.reverse(); // chronological (oldest → newest)
  const nowMonth = today.slice(0, 7); // the (partial) current month in Sydney
  const yr = yearRange(yearKind, today);
  const yStart = Number(yr.start.slice(0, 4));
  const year = { kind: yr.kind, start: yr.start, label: yr.label,
    ytdLabel: yr.kind === "cy" ? `${yStart} to date` : `FY ${yStart}-${String(yStart + 1).slice(2)} to date` };
  if (!months.length) return { months: [], rows: [], totals: [], lastComplete: null, selectedMonth: null, currentMonth: nowMonth, headline: null, year, ytd: null, last12: null, windowTotals: null };
  const lastComplete = months.filter((mo) => mo < nowMonth).slice(-1)[0] || months[months.length - 1];
  // Headline reflects the chosen month (default: last complete month; the current month is partial).
  const selectedMonth = (headlineMonth && months.includes(headlineMonth)) ? headlineMonth : lastComplete;

  let centreRows = db.prepare(`SELECT DISTINCT c.owna_id, c.name FROM incidents_monthly i JOIN centres c ON c.owna_id = i.owna_id ORDER BY c.name`).all()
    .map((c) => ({ owna_id: c.owna_id, name: c.name.replace("Futuro Childcare & Education - ", "") }));
  if (scopedOwnaId) centreRows = centreRows.filter((c) => c.owna_id === scopedOwnaId);
  const get = db.prepare("SELECT total, injuries, illness, serious, reportable FROM incidents_monthly WHERE owna_id=? AND month=?");
  const rateOf = (rep) => rag(rep, 0, 1, true); // serious incidents (reg 12): 0 green, 1 amber, 2+ red

  const rows = centreRows.map((c) => {
    const cells = months.map((mo) => {
      const row = get.get(c.owna_id, mo);
      const r = row || { total: 0, injuries: 0, illness: 0, serious: 0, reportable: 0 };
      return { month: mo, ...r, hasData: !!row, rating: rateOf(r.reportable) };
    });
    const hc = cells.find((x) => x.month === selectedMonth) || { total: 0, injuries: 0, illness: 0, serious: 0, reportable: 0, rating: rateOf(0) };
    return { owna_id: c.owna_id, name: c.name, cells, headline: hc };
  });
  const totals = months.map((mo) => {
    const t = { month: mo, total: 0, injuries: 0, illness: 0, serious: 0, reportable: 0 };
    rows.forEach((r) => { const cell = r.cells.find((x) => x.month === mo); ["total","injuries","illness","serious","reportable"].forEach((k) => t[k] += cell[k]); });
    return t;
  });
  const headline = { ...(totals.find((t) => t.month === selectedMonth) || { total: 0, injuries: 0, illness: 0, serious: 0, reportable: 0 }), rating: rateOf((totals.find((t) => t.month === selectedMonth) || {}).reportable || 0) };
  // Totals across the displayed months (the trend grid's trailing column).
  const windowTotals = { months: months.length, total: 0, injuries: 0, illness: 0, serious: 0, reportable: 0 };
  rows.forEach((r) => {
    r.window = { months: months.length, total: 0, injuries: 0, illness: 0, serious: 0, reportable: 0 };
    r.cells.forEach((cell) => { INCIDENT_KEYS.forEach((k) => { r.window[k] += cell[k]; windowTotals[k] += cell[k]; }); });
  });
  // Year to date (start of the reporting year → current, partial month) and the last 12 calendar months.
  const toMonth = today.slice(0, 7);
  const [ty, tm] = toMonth.split("-").map(Number);
  const from12 = new Date(Date.UTC(ty, tm - 12, 1)).toISOString().slice(0, 7); // 11 months back
  const ytd = { ...year, ...incidentTotalsBetween(centreRows, yr.start.slice(0, 7), toMonth) };
  const last12 = incidentTotalsBetween(centreRows, from12, toMonth);
  rows.forEach((r, i) => { r.ytd = ytd.rows[i]; r.last12 = last12.rows[i]; });
  return { months, rows, totals, lastComplete, selectedMonth, currentMonth: nowMonth, headline, year, ytd, last12, windowTotals };
}
function actionPlanMonths(limit = 24) {
  return db.prepare("SELECT DISTINCT month FROM action_plans ORDER BY month DESC LIMIT ?").all(limit).map((r) => r.month);
}
function actionPlanGet(ownaId, month) {
  const p = db.prepare("SELECT * FROM action_plans WHERE owna_id=? AND month=?").get(ownaId, month);
  const items = db.prepare("SELECT * FROM action_plan_items WHERE owna_id=? AND month=? ORDER BY category, sort, id").all(ownaId, month);
  return { plan: p ? { ...p, areas: JSON.parse(p.areas_json || "{}") } : null, items, auto: actionPlanAuto(ownaId), areasDef: AP_AREAS };
}
function saveActionPlan(ownaId, month, overall, context, areas) {
  db.prepare(`INSERT INTO action_plans (owna_id, month, overall, context, areas_json, updated_at) VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(owna_id, month) DO UPDATE SET overall=excluded.overall, context=excluded.context, areas_json=excluded.areas_json, updated_at=datetime('now')`)
    .run(ownaId, month, overall, context, JSON.stringify(areas || {}));
}
function replaceActionItems(ownaId, month, items) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM action_plan_items WHERE owna_id=? AND month=?").run(ownaId, month);
    const ins = db.prepare("INSERT INTO action_plan_items (owna_id, month, category, focus_area, actions, owner, status, sort, start_date, due_date, progress, outcome, priority, job_reference) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    items.forEach((it, i) => { if ((it.focus_area || it.actions || "").trim()) ins.run(ownaId, month, it.category, it.focus_area, it.actions, it.owner, it.status, i, it.start_date || "", it.due_date || "", it.progress || "", it.outcome || "", it.priority || "", it.job_reference || ""); });
  });
  tx();
}

// ===== Quality & Compliance (uploaded audit) =====
// The most recent audit per centre (by audit date, falling back to upload time).
function qcSummary(ownaId) {
  const where = ownaId ? "AND a.owna_id = ?" : "";
  const args = ownaId ? [ownaId] : [];
  const audits = db.prepare(`
    SELECT a.* FROM qc_audits a
    JOIN (SELECT owna_id, MAX(COALESCE(audit_date, uploaded_at)) md FROM qc_audits GROUP BY owna_id) x
      ON a.owna_id = x.owna_id AND COALESCE(a.audit_date, a.uploaded_at) = x.md
    WHERE 1=1 ${where} ORDER BY a.centre_name`).all(...args);
  return audits.map((a) => {
    const open = db.prepare("SELECT COUNT(*) n FROM qc_actions WHERE owna_id=? AND term=? AND (completed IS NULL OR completed='' OR completed NOT LIKE 'Y%')").get(a.owna_id, a.term).n;
    const high = db.prepare("SELECT COUNT(*) n FROM qc_actions WHERE owna_id=? AND term=? AND priority LIKE 'High%' AND (completed IS NULL OR completed='' OR completed NOT LIKE 'Y%')").get(a.owna_id, a.term).n;
    return { ...a, qa: JSON.parse(a.qa_json || "[]"), open_actions: open, open_high: high };
  });
}
// Audits available for a centre, most recent first.
function qcTerms(ownaId) {
  return db.prepare(`SELECT term, audit_date, overall_pct FROM qc_audits WHERE owna_id=? ORDER BY COALESCE(audit_date, uploaded_at) DESC`).all(ownaId);
}
// One centre's audit for a term (latest term if not given), plus actions.
function qcCentre(ownaId, term) {
  const a = term
    ? db.prepare("SELECT * FROM qc_audits WHERE owna_id=? AND term=?").get(ownaId, term)
    : db.prepare("SELECT * FROM qc_audits WHERE owna_id=? ORDER BY COALESCE(audit_date, uploaded_at) DESC LIMIT 1").get(ownaId);
  if (!a) return null;
  const actions = db.prepare("SELECT * FROM qc_actions WHERE owna_id=? AND term=? ORDER BY (completed LIKE 'Y%'), CASE priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, quality_area").all(ownaId, a.term);
  return { ...a, qa: JSON.parse(a.qa_json || "[]"), actions };
}
// Overall + per-QA % across a centre's audits, chronological (oldest → newest), for trend charts.
function qcTrend(ownaId) {
  const rows = db.prepare(`SELECT term, audit_date, overall_pct, qa_json FROM qc_audits WHERE owna_id=? ORDER BY COALESCE(audit_date, uploaded_at)`).all(ownaId);
  return rows.map((r) => {
    const qa = {}; JSON.parse(r.qa_json || "[]").forEach((q) => { qa[q.code] = q.pct; });
    return { term: r.term, audit_date: r.audit_date, overall_pct: r.overall_pct, qa };
  });
}

// ===== People & Culture (manual entry) =====
const PC_TARGET_KEYS = ["enps", "family_nps", "turnover", "checkin_pct", "psych_safety"];
function pcTargets() {
  const m = {};
  db.prepare("SELECT metric, target FROM pc_targets").all().forEach((r) => { m[r.metric] = r.target; });
  return m;
}
function savePcTarget(metric, target) {
  db.prepare("INSERT INTO pc_targets (metric, target) VALUES (?,?) ON CONFLICT(metric) DO UPDATE SET target=excluded.target").run(metric, target);
}
function savePcMetric(ownaId, month, v) {
  // Merge: a blank (null) field keeps the existing value, so the manual form and the
  // SharePoint upload can each fill their own metrics without wiping the other's.
  db.prepare(`INSERT INTO pc_metrics (owna_id, month, enps, family_nps, turnover, checkin_due, checkin_completed, psych_safety, updated_at)
    VALUES (@owna_id,@month,@enps,@family_nps,@turnover,@checkin_due,@checkin_completed,@psych_safety,datetime('now'))
    ON CONFLICT(owna_id, month) DO UPDATE SET
      enps=COALESCE(@enps, enps), family_nps=COALESCE(@family_nps, family_nps), turnover=COALESCE(@turnover, turnover),
      checkin_due=COALESCE(@checkin_due, checkin_due), checkin_completed=COALESCE(@checkin_completed, checkin_completed),
      psych_safety=COALESCE(@psych_safety, psych_safety), updated_at=datetime('now')`)
    .run({ owna_id: ownaId, month, family_nps: null, ...v });
}
function pcMonths(limit = 24) {
  return db.prepare("SELECT DISTINCT month FROM pc_metrics ORDER BY month DESC LIMIT ?").all(limit).map((r) => r.month);
}
// Per-centre P&C for a month, with derived check-in % and target flags.
function pcForMonth(month, ownaId) {
  const centres = db.prepare("SELECT owna_id, name FROM centres WHERE (owna_id IN (SELECT owna_id FROM daily_metrics) OR ll_id IS NOT NULL) AND (opening IS NULL OR opening = 0) ORDER BY name").all()
    .filter((c) => !ownaId || c.owna_id === ownaId);
  const t = pcTargets();
  return centres.map((c) => {
    const r = db.prepare("SELECT * FROM pc_metrics WHERE owna_id=? AND month=?").get(c.owna_id, month) || {};
    const checkin_pct = (r.checkin_due) ? Math.round((r.checkin_completed || 0) / r.checkin_due * 1000) / 10 : null;
    return { owna_id: c.owna_id, name: c.name, enps: r.enps, family_nps: r.family_nps, turnover: r.turnover,
      checkin_due: r.checkin_due, checkin_completed: r.checkin_completed, checkin_pct, psych_safety: r.psych_safety };
  });
}
// P&C metrics over time (monthly axis, last `months`) for one centre or the group average.
// Only real entries count (nulls skipped), so the different cadences (NPS ~6-monthly, eNPS/psych
// ~quarterly, check-ins monthly) each render as their own sparse-but-honest series.
const PC_METRIC_KEYS = ["enps", "family_nps", "turnover", "checkin_pct", "psych_safety"];
function pcTrend(ownaId, months = 18) {
  const now = todayStr().slice(0, 7);
  const [y, mo] = now.split("-").map(Number);
  const axis = [];
  for (let i = months - 1; i >= 0; i--) axis.push(new Date(Date.UTC(y, mo - 1 - i, 1)).toISOString().slice(0, 7));
  const rows = ownaId
    ? db.prepare("SELECT * FROM pc_metrics WHERE owna_id=? AND month>=?").all(ownaId, axis[0])
    : db.prepare("SELECT * FROM pc_metrics WHERE month>=?").all(axis[0]);
  const byMonth = {};
  rows.forEach((r) => {
    const cp = r.checkin_due ? Math.round((r.checkin_completed || 0) / r.checkin_due * 1000) / 10 : null;
    (byMonth[r.month] = byMonth[r.month] || []).push({ ...r, checkin_pct: cp });
  });
  const series = {};
  PC_METRIC_KEYS.forEach((k) => {
    series[k] = axis.map((m) => {
      const vals = (byMonth[m] || []).map((r) => r[k]).filter((v) => v != null && v !== "");
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
    });
  });
  return { axis, series };
}

// ---- Cadence-aware P&C trend: bucket by each metric's natural period, newest-window with exploration ----
// Each P&C metric is collected on its own rhythm, so plotting them all on a dense monthly axis
// leaves sparse metrics (quarterly eNPS, 6-monthly Family NPS) looking broken. Bucket instead.
const PC_CADENCE = { enps: "quarter", family_nps: "half", turnover: "month", checkin_pct: "month", psych_safety: "quarter" };
const PC_DEFAULT_WIN = { quarter: 4, half: 4, month: 12 }; // periods shown by default (rest via "explore")

function _pcPeriodKey(month, cadence) {
  const [y, mo] = month.split("-").map(Number);
  if (cadence === "quarter") return `${y}-Q${Math.ceil(mo / 3)}`;
  if (cadence === "half") return `${y}-H${mo <= 6 ? 1 : 2}`;
  return month; // monthly: YYYY-MM
}
function _pcPeriodSort(key) { // chronological ordering key
  const [y, p] = key.split("-");
  if (p[0] === "Q") return (+y) * 12 + (+p[1]) * 3;
  if (p[0] === "H") return (+y) * 12 + (+p[1]) * 6;
  return (+y) * 12 + (+p); // month
}
function _pcPeriodLabel(key, cadence) {
  const [y, p] = key.split("-");
  if (cadence === "month") return new Date(Date.UTC(+y, (+p) - 1, 1)).toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" }) + " " + y.slice(2);
  return p + " " + y.slice(2); // "Q3 25" / "H1 25"
}
// One metric's series bucketed by its cadence. Only periods that actually have data appear.
function pcSeriesGrouped(ownaId, metric, cadence, limit) {
  const rows = ownaId
    ? db.prepare("SELECT * FROM pc_metrics WHERE owna_id=?").all(ownaId)
    : db.prepare("SELECT * FROM pc_metrics").all();
  const buckets = {};
  rows.forEach((r) => { if (r.month) (buckets[_pcPeriodKey(r.month, cadence)] ||= []).push(r); });
  const keys = Object.keys(buckets).sort((a, b) => _pcPeriodSort(a) - _pcPeriodSort(b));
  const pts = keys.map((k) => {
    const rs = buckets[k];
    let value;
    if (metric === "checkin_pct") { // sum due/done across the period, then a single rate
      let due = 0, done = 0, any = false;
      rs.forEach((r) => { if (r.checkin_due != null) { due += r.checkin_due; done += (r.checkin_completed || 0); any = true; } });
      value = any && due > 0 ? Math.round(done / due * 1000) / 10 : null;
    } else {
      const vals = rs.map((r) => r[metric]).filter((v) => v != null && v !== "");
      value = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
    }
    return { key: k, label: _pcPeriodLabel(k, cadence), value };
  }).filter((p) => p.value != null);
  const full = pts.length;
  const shown = (limit && limit < full) ? pts.slice(-limit) : pts;
  return { labels: shown.map((p) => p.label), points: shown.map((p) => p.value), cadence, full, shown: shown.length };
}
// All P&C metrics at once; `full` shows the whole history instead of the default recent window.
function pcAllSeries(ownaId, full) {
  const out = {};
  PC_METRIC_KEYS.forEach((k) => {
    const cad = PC_CADENCE[k] || "month";
    out[k] = pcSeriesGrouped(ownaId, k, cad, full ? null : PC_DEFAULT_WIN[cad]);
  });
  return out;
}

// Group-level P&C for the latest month with data: simple average across centres that have a value.
function pcGroupLatest() {
  const month = pcMonths(1)[0];
  if (!month) return null;
  const rows = pcForMonth(month, null);
  const avg = (key) => {
    const vals = rows.map((r) => r[key]).filter((v) => v != null && v !== "");
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
  };
  return { month, enps: avg("enps"), family_nps: avg("family_nps"), turnover: avg("turnover"),
    checkin_pct: avg("checkin_pct"), psych_safety: avg("psych_safety"), targets: pcTargets() };
}

// ===== Turnover as the owner enters it (his decision of 16 September 2026) =====
// THE turnover figure. Payroll records that someone left; it cannot know whether the business counts the
// departure as turnover, so the owner types three numbers per centre per month — resignations,
// terminations, headcount — on /admin/pc, and everything below is arithmetic on them.
//
// THE BASIS, once, so every caller reports the same thing:
//   * Blank is NOT ZERO. A month nobody entered is left out of the average headcount and adds no
//     leavers; a month entered as 0 is a measurement and counts. Blank must round-trip as blank.
//   * The rate is ROLLING TWELVE MONTHS, the same basis the HR spreadsheet used: the twelve months
//     ending in the selected month, leavers summed and headcount averaged over the months that have an
//     entry. Where fewer than twelve are entered the caller is told how many it actually covers, so a
//     five-month figure is never read as a year.
//   * Three rates, all of them: combined (resignations + terminations), resignations only, and
//     terminations only. The difference between them is the point of the exercise.
//   * An average headcount of 0 — or no entered headcount at all — yields null, never a division.
const PC_TURNOVER_WINDOW = 12;
const pcTurnoverInt = (v) => {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;                                     // blank = not entered
  const n = Math.round(parseFloat(s.replace(/[^0-9.-]/g, "")));  // keep the '.', round — "30.0" is 30, not 300
  return isNaN(n) || n < 0 ? null : n;
};
// n months ending at `last` (YYYY-MM), oldest first.
function monthsEndingAt(last, n) {
  const [y, mo] = last.split("-").map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = y * 12 + (mo - 1) - i;
    out.push(`${String(Math.floor(t / 12)).padStart(4, "0")}-${String(((t % 12) + 12) % 12 + 1).padStart(2, "0")}`);
  }
  return out;
}
// Centres the owner enters figures for: the ones actually operating.
function pcTurnoverCentres() {
  return db.prepare("SELECT owna_id, name FROM centres WHERE (opening IS NULL OR opening = 0) AND capacity > 0 ORDER BY name").all();
}
function pcTurnoverMonths(limit = 36) {
  return db.prepare("SELECT DISTINCT month FROM pc_turnover_entry ORDER BY month DESC LIMIT ?").all(limit).map((r) => r.month);
}
function pcTurnoverLatestMonth(ownaId = null) {
  const r = db.prepare(`SELECT MAX(month) m FROM pc_turnover_entry WHERE (resignations IS NOT NULL OR terminations IS NOT NULL OR headcount IS NOT NULL)${ownaId ? " AND owna_id = ?" : ""}`)
    .get(...(ownaId ? [ownaId] : [])) || {};
  return r.m || null;
}
// One row per operating centre for the entry form. A field never entered comes back null, not 0.
function pcTurnoverEntries(month, ownaId = null) {
  const saved = {};
  db.prepare("SELECT * FROM pc_turnover_entry WHERE month = ?").all(month).forEach((r) => { saved[r.owna_id] = r; });
  return pcTurnoverCentres().filter((c) => !ownaId || c.owna_id === ownaId).map((c) => {
    const r = saved[c.owna_id] || {};
    return { owna_id: c.owna_id, name: c.name, resignations: r.resignations ?? null, terminations: r.terminations ?? null, headcount: r.headcount ?? null };
  });
}
// Write one centre-month. All three blank deletes the row, so "not entered" stays distinguishable from
// zero on re-read rather than being stored as a row of nulls that later reads as an entered month.
function savePcTurnoverEntry(ownaId, month, v) {
  const res = pcTurnoverInt(v.resignations), term = pcTurnoverInt(v.terminations), head = pcTurnoverInt(v.headcount);
  if (res == null && term == null && head == null) {
    db.prepare("DELETE FROM pc_turnover_entry WHERE owna_id=? AND month=?").run(ownaId, month);
    return { deleted: true };
  }
  db.prepare(`INSERT INTO pc_turnover_entry (owna_id, month, resignations, terminations, headcount, updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(owna_id, month) DO UPDATE SET
      resignations=excluded.resignations, terminations=excluded.terminations,
      headcount=excluded.headcount, updated_at=datetime('now')`).run(ownaId, month, res, term, head);
  return { resignations: res, terminations: term, headcount: head };
}
// The arithmetic, once, for the group and for a single centre alike. `byMonth` maps YYYY-MM to
// { res, term, head } with nulls preserved.
function _pcTurnoverRoll(win, byMonth) {
  const months = win.map((mth) => {
    const r = byMonth[mth] || {};
    return { month: mth, resignations: r.res ?? null, terminations: r.term ?? null, headcount: r.head ?? null };
  });
  const entered = months.filter((x) => x.resignations != null || x.terminations != null || x.headcount != null);
  const heads = months.map((x) => x.headcount).filter((v) => v != null);
  const avgHead = heads.length ? heads.reduce((a, b) => a + b, 0) / heads.length : null;
  const sum = (k) => { const vs = months.map((x) => x[k]).filter((v) => v != null); return vs.length ? vs.reduce((a, b) => a + b, 0) : null; };
  const res = sum("resignations"), term = sum("terminations");
  const leavers = (res == null && term == null) ? null : (res || 0) + (term || 0);
  // No entered headcount, or an entered headcount of zero, gives no rate — never a division.
  const rate = (n) => (n == null || avgHead == null || avgHead <= 0) ? null : Math.round((n / avgHead) * 1000) / 10;
  const last = months[months.length - 1];
  const mLeavers = (last.resignations == null && last.terminations == null) ? null : (last.resignations || 0) + (last.terminations || 0);
  const mRate = (n) => (n == null || !last.headcount || last.headcount <= 0) ? null : Math.round((n / last.headcount) * 1000) / 10;
  return {
    months,
    window: { from: win[0], to: win[win.length - 1], months: win.length, entered: entered.length, complete: entered.length >= win.length },
    headcount_months: heads.length,
    avg_headcount: avgHead == null ? null : Math.round(avgHead * 10) / 10,
    resignations: res, terminations: term, leavers,
    rates: { combined: rate(leavers), resignations: rate(res), terminations: rate(term) },
    month: { month: last.month, headcount: last.headcount, resignations: last.resignations, terminations: last.terminations, leavers: mLeavers,
      rates: { combined: mRate(mLeavers), resignations: mRate(last.resignations), terminations: mRate(last.terminations) } },
  };
}
// Scope-level roll (one centre, or the group when ownaId is null). SUM over an all-null column is NULL
// and COUNT(col) ignores nulls, so a month nobody entered stays null instead of collapsing to 0.
function _pcTurnoverScope(ownaId, win) {
  const rows = db.prepare(`SELECT month, SUM(resignations) res, SUM(terminations) term, SUM(headcount) head,
      COUNT(resignations) nres, COUNT(terminations) nterm, COUNT(headcount) nhead
      FROM pc_turnover_entry WHERE month BETWEEN ? AND ?${ownaId ? " AND owna_id = ?" : ""} GROUP BY month`)
    .all(...(ownaId ? [win[0], win[win.length - 1], ownaId] : [win[0], win[win.length - 1]]));
  const byMonth = {};
  rows.forEach((r) => { byMonth[r.month] = { res: r.nres ? r.res : null, term: r.nterm ? r.term : null, head: r.nhead ? r.head : null }; });
  return _pcTurnoverRoll(win, byMonth);
}
// The whole entered-turnover picture for one centre (`ownaId`) or the group (null), as at `month`
// (default: the latest month anything was entered for). Null when nothing has been entered at all.
function pcTurnoverReport(ownaId = null, month = null) {
  const to = month || pcTurnoverLatestMonth(ownaId) || pcTurnoverLatestMonth(null);
  if (!to) return null;
  const win = monthsEndingAt(to, PC_TURNOVER_WINDOW);
  const out = _pcTurnoverScope(ownaId, win);
  const perCentre = {};
  db.prepare("SELECT * FROM pc_turnover_entry WHERE month BETWEEN ? AND ?").all(win[0], to).forEach((r) => {
    (perCentre[r.owna_id] ||= {})[r.month] = { res: r.resignations, term: r.terminations, head: r.headcount };
  });
  const centreRows = pcTurnoverCentres().filter((c) => !ownaId || c.owna_id === ownaId).map((c) => {
    const roll = _pcTurnoverRoll(win, perCentre[c.owna_id] || {});
    return { owna_id: c.owna_id, name: c.name, ...roll };
  });
  return { ...out, scoped: ownaId || null, centres: centreRows };
}
// The combined rolling rate month by month, in the shape the P&C chart tabs already consume. Only
// months with an entry become points, so the line is sparse-but-honest like every other P&C series.
//
// Every point is put on the SAME twelve-month basis. The rolling rate is leavers summed over the
// entered months ÷ headcount averaged over them, so while the window is still filling the numerator
// grows month after month against a denominator that does not: a centre with identical figures every
// month would climb 5, 10, 15, 20… purely because more months are entered, on an axis shared with
// full-year points and with the target line. Scaling a window of `entered` months to twelve makes the
// points comparable — flat business, flat line — and `partial` lets the view say so.
function pcTurnoverSeries(ownaId = null, full = false, limit = 12) {
  const months = db.prepare(`SELECT DISTINCT month FROM pc_turnover_entry WHERE (resignations IS NOT NULL OR terminations IS NOT NULL OR headcount IS NOT NULL)${ownaId ? " AND owna_id = ?" : ""} ORDER BY month`)
    .all(...(ownaId ? [ownaId] : [])).map((r) => r.month);
  const pts = months.map((mth) => {
    const r = _pcTurnoverScope(ownaId, monthsEndingAt(mth, PC_TURNOVER_WINDOW));
    const v = r.rates.combined; // null unless at least one month carries a headcount, so entered >= 1
    return { month: mth, value: v == null ? null : Math.round((v * PC_TURNOVER_WINDOW / r.window.entered) * 10) / 10, complete: r.window.complete };
  }).filter((p) => p.value != null);
  const shown = (!full && limit && limit < pts.length) ? pts.slice(-limit) : pts;
  return {
    labels: shown.map((p) => _pcPeriodLabel(p.month, "month")),
    points: shown.map((p) => p.value),
    cadence: "month", full: pts.length, shown: shown.length,
    partial: shown.filter((p) => !p.complete).length, // points annualised from a part-filled window
  };
}

// ===== Employment Hero labour + margin =====

// Weeks available (most recent first).
function labourWeeks(limit = 16) {
  return db.prepare(`SELECT week_ending FROM labour_weekly GROUP BY week_ending HAVING COUNT(*) >= 4 ORDER BY week_ending DESC LIMIT ?`).all(limit).map((r) => r.week_ending);
}

// OWNA revenue + occupancy for the Mon..weekEnding week of a centre, plus booked child-days.
// child_days = booked children summed over the week's operating days (weekdays that are not NSW public
// holidays — OWNA keeps booking rows on holidays although the centre is closed); op_days = those days.
function ownaWeek(ownaId, weekEnding) {
  if (!ownaId) return { revenue: 0, occupancy: null, child_days: 0, op_days: 0 };
  const from = cal.addDays(weekEnding, -6); // Monday of the Mon..weekEnding week
  const places = placesOf(ownaId); // licensed places, not the week's room sum
  const r = db.prepare(`
    SELECT COALESCE(SUM(fee_total),0) rev, COALESCE(SUM(booked),0) booked, COUNT(DISTINCT metric_date) days
    FROM daily_metrics WHERE owna_id = ? AND metric_date BETWEEN ? AND ?
  `).get(ownaId, from, weekEnding);
  let child_days = 0; const opDates = new Set();
  db.prepare(`SELECT metric_date, booked FROM daily_metrics WHERE owna_id = ? AND metric_date BETWEEN ? AND ?`).all(ownaId, from, weekEnding)
    .forEach((d) => { if (cal.isOperatingDay(d.metric_date)) { child_days += d.booked || 0; opDates.add(d.metric_date); } });
  return { revenue: round(r.rev), occupancy: (r.days && places) ? pct(r.booked, places * r.days) : null, child_days, op_days: opDates.size };
}

// Full labour table for one week (per centre) with revenue, occupancy and margin.
function labourForWeek(weekEnding) {
  const rows = db.prepare(`SELECT * FROM labour_weekly WHERE week_ending = ?`).all(weekEnding);
  const mapped = rows.map((r0) => {
    const r = { ...r0 };
    if (!r.owna_id) { // head office / pre-open: not split into support, shown as one line
      r.worked_h += (r.kitchen_h || 0) + (r.cleaning_h || 0);
      r.worked_amt += (r.kitchen_amt || 0) + (r.cleaning_amt || 0);
      r.kitchen_h = 0; r.kitchen_amt = 0; r.cleaning_h = 0; r.cleaning_amt = 0;
    }
    const ow = ownaWeek(r.owna_id, weekEnding);
    // Care labour only — kitchen is its own cost centre, excluded from centre totals & margin.
    const care_hours = r.worked_h + r.leave_h;
    const care_wages = r.worked_amt + r.leave_amt + r.matwc_amt;
    return {
      ...r,
      revenue: ow.revenue,
      occupancy: ow.occupancy,
      child_days: ow.child_days,
      care_hours: Math.round(care_hours * 10) / 10,
      care_wages: Math.round(care_wages),
      wage_pct: ow.revenue > 0 ? Math.round(care_wages / ow.revenue * 1000) / 10 : null,
    };
  });
  const bud = labourBudgets(weekEnding);
  mapped.forEach((r) => {
    const b = bud[r.eh_centre];
    r.budget = b || null;
    // Compare all-in (care + kitchen) wages/hours to the centre's total budget.
    const support_amt = (r.kitchen_amt || 0) + (r.cleaning_amt || 0);
    const support_h = (r.kitchen_h || 0) + (r.cleaning_h || 0);
    r.support_amt = Math.round(support_amt);
    r.support_h = Math.round(support_h * 10) / 10;
    const allWages = r.care_wages + support_amt;
    const allHours = r.care_hours + support_h;
    r.all_wages = Math.round(allWages);
    r.all_hours = Math.round(allHours * 10) / 10;
    r.vs_wages = b && b.budget_wages != null ? Math.round(allWages - b.budget_wages) : null;
    r.vs_hours = b && b.budget_hours != null ? Math.round((allHours - b.budget_hours) * 10) / 10 : null;
    r.vs_occ = (b && b.budget_occ != null && r.occupancy != null) ? Math.round((r.occupancy - b.budget_occ) * 10) / 10 : null;
    r.vs_support = (b && b.budget_support != null) ? Math.round((r.support_amt || 0) - b.budget_support) : null;
    // Wages per booked child-day (whole dollars): educator (care) wages, and all-in incl. kitchen + cleaning.
    // Head office / pre-opening rows have no bookings → null (shown as "—").
    r.wages_per_child_day = r.child_days > 0 ? Math.round(r.care_wages / r.child_days) : null;
    r.all_in_per_child_day = r.child_days > 0 ? Math.round(allWages / r.child_days) : null;
  });
  mapped.sort((a, b) => b.care_wages - a.care_wages);
  return mapped;
}

// Group wages per child-day for one week from labourForWeek rows: centres with bookings only
// (head office and pre-opening rows carry wages but no children, so they are left out of both sides).
function wagesPerChildDay(rows) {
  const withKids = (rows || []).filter((r) => r.child_days > 0);
  const child_days = withKids.reduce((s, r) => s + r.child_days, 0);
  const care_wages = Math.round(withKids.reduce((s, r) => s + r.care_wages, 0));
  const all_wages = Math.round(withKids.reduce((s, r) => s + (r.all_wages != null ? r.all_wages : r.care_wages + (r.kitchen_amt || 0) + (r.cleaning_amt || 0)), 0));
  return {
    centres: withKids.length, child_days, care_wages, all_wages,
    per_child_day: child_days > 0 ? Math.round(care_wages / child_days) : null,
    all_in_per_child_day: child_days > 0 ? Math.round(all_wages / child_days) : null,
  };
}

// Weekly trend: total wages, revenue and wage% over time (group, or one centre by owna_id).
function labourTrend(ownaId = null, weeks = 16) {
  const weeksList = labourWeeks(weeks).slice().reverse();
  return weeksList.map((wk) => {
    const rows = ownaId
      ? db.prepare(`SELECT * FROM labour_weekly WHERE week_ending = ? AND owna_id = ?`).all(wk, ownaId)
      : db.prepare(`SELECT * FROM labour_weekly WHERE week_ending = ?`).all(wk);
    let wages = 0, hours = 0, rev = 0;
    const seenCentre = new Set();
    rows.forEach((r) => {
      wages += (r.worked_amt + r.leave_amt + r.matwc_amt); hours += (r.worked_h + r.leave_h);
      if (r.owna_id && !seenCentre.has(r.owna_id)) { rev += ownaWeek(r.owna_id, wk).revenue; seenCentre.add(r.owna_id); }
    });
    return { week: wk, wages: round(wages), hours: round(hours), revenue: round(rev), wage_pct: rev > 0 ? Math.round(wages / rev * 1000) / 10 : null };
  });
}

// Richer weekly financial trend: revenue, worked/leave/support wages, total wages, margin ($ & %).
// Group (ownaId null) or one centre. The money view over time.
function wagesTrend(ownaId = null, weeks = 16) {
  const weeksList = labourWeeks(weeks).slice().reverse();
  return weeksList.map((wk) => {
    const rows = ownaId
      ? db.prepare(`SELECT * FROM labour_weekly WHERE week_ending = ? AND owna_id = ?`).all(wk, ownaId)
      : db.prepare(`SELECT * FROM labour_weekly WHERE week_ending = ?`).all(wk);
    let worked = 0, leave = 0, matwc = 0, kitchen = 0, cleaning = 0, rev = 0;
    const seen = new Set();
    rows.forEach((r) => {
      worked += r.worked_amt || 0; leave += r.leave_amt || 0; matwc += r.matwc_amt || 0;
      kitchen += r.kitchen_amt || 0; cleaning += r.cleaning_amt || 0;
      if (r.owna_id && !seen.has(r.owna_id)) { rev += ownaWeek(r.owna_id, wk).revenue; seen.add(r.owna_id); }
    });
    const care = worked + leave + matwc, support = kitchen + cleaning, allw = care + support;
    return { week: wk, revenue: round(rev), worked: round(worked), leave: round(leave), support: round(support),
      care_wages: round(care), all_wages: round(allw), margin: round(rev - allw),
      wage_pct: rev > 0 ? Math.round(care / rev * 1000) / 10 : null,
      margin_pct: rev > 0 ? Math.round((rev - allw) / rev * 1000) / 10 : null };
  });
}

// ===== Centre insights: day-of-week occupancy, tips, occupancy calculator, wages/margin =====
const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Average occupancy per weekday (Mon–Fri) over a recent window (past days only).
function centreDowOccupancy(ownaId, days = 56) {
  const today = todayStr();
  const from = cal.addDays(today, -days);
  const places = placesOf(ownaId); // licensed places, not the room sum the days were snapshotted with
  const rows = db.prepare(`
    SELECT CAST(strftime('%w', metric_date) AS INTEGER) AS dow,
           COALESCE(SUM(booked),0) AS booked, COALESCE(SUM(casual),0) AS casual,
           COUNT(DISTINCT metric_date) AS d
    FROM daily_metrics
    WHERE owna_id = ? AND metric_date BETWEEN ? AND ?
    GROUP BY dow`).all(ownaId, from, today);
  const byDow = {}; rows.forEach((r) => { byDow[r.dow] = r; });
  const out = [];
  for (let wd = 1; wd <= 5; wd++) {
    const r = byDow[wd];
    if (!r || !r.d) { out.push({ dow: DOW_NAMES[wd], occupancy: null, avg_booked: null, avg_casual: null, days: 0 }); continue; }
    out.push({ dow: DOW_NAMES[wd], occupancy: places == null ? null : pct(r.booked, places * r.d), avg_booked: Math.round(r.booked / r.d), avg_casual: Math.round(r.casual / r.d), days: r.d, places });
  }
  return out;
}

// Latest full pay-week wages, revenue and margin for one centre.
function centreLabourLatest(ownaId) {
  const wk = labourWeeks(1)[0]; if (!wk) return null;
  const row = labourForWeek(wk).find((r) => r.owna_id === ownaId); if (!row) return null;
  const marginAfterWages = row.revenue != null ? Math.round(row.revenue - row.all_wages) : null;
  const margin_pct = row.revenue > 0 ? Math.round((row.revenue - row.all_wages) / row.revenue * 1000) / 10 : null;
  return { week: wk, revenue: row.revenue, care_wages: row.care_wages, all_wages: row.all_wages,
    worked_amt: Math.round(row.worked_amt || 0), leave_amt: Math.round(row.leave_amt || 0), matwc_amt: Math.round(row.matwc_amt || 0),
    worked_h: Math.round((row.worked_h || 0) * 10) / 10, leave_h: Math.round((row.leave_h || 0) * 10) / 10,
    support_amt: row.support_amt, wage_pct: row.wage_pct, occupancy: row.occupancy, marginAfterWages, margin_pct };
}

// Compare every operating centre on one metric over time (each centre = one line).
// `source: "bookings"` metrics come from OWNA daily bookings and extend two months ahead (booked-ahead days, drawn dashed).
const COMPARE_METRICS = {
  occupancy:  { cadence: "month", label: "Occupancy", suf: "%", better: "high", source: "bookings" },
  unused_places: { cadence: "month", label: "Unused places, avg per day", unit: "places", better: "low", source: "bookings" },
  utilisation: { cadence: "month", label: "Utilisation", suf: "%", better: "high", source: "bookings" },
  wage_pct:   { cadence: "week",  label: "Educator wages % of revenue", suf: "%", better: "low" },
  margin_pct: { cadence: "week",  label: "Margin after wages", suf: "%", better: "high" },
  revenue:    { cadence: "week",  label: "Revenue", money: true, better: "high" },
  turnover:   { cadence: "month", label: "Turnover", suf: "%", better: "low" },
  enps:       { cadence: "month", label: "eNPS", better: "high" },
};
function lastMonths(n) {
  const now = todayStr().slice(0, 7); const [y, mo] = now.split("-").map(Number);
  const out = []; for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, mo - 1 - i, 1)).toISOString().slice(0, 7));
  return out;
}
// Latest ACTUAL value per series (ignoring projected points past `dashFrom`; the most recent month that has data), then
// a ranking that honours cfg.better so "lower is better" metrics colour correctly: best → tone "good", worst → "bad".
function rankCompareSeries(series, cfg, dashFrom) {
  series.forEach((s) => {
    const upto = dashFrom == null ? s.points : s.points.slice(0, dashFrom + 1);
    const nn = upto.filter((v) => v != null);
    s.latest = nn.length ? nn[nn.length - 1] : null; s.tone = null;
  });
  const ranked = series.filter((s) => s.latest != null).sort((a, b) => (cfg.better === "low" ? a.latest - b.latest : b.latest - a.latest));
  if (ranked.length > 1) { ranked[0].tone = "good"; ranked[ranked.length - 1].tone = "bad"; }
  return ranked.map((s) => ({ owna_id: s.owna_id, name: s.name, latest: s.latest, tone: s.tone }));
}
function compareTrend(metric = "occupancy", n) {
  const cfg = COMPARE_METRICS[metric] || COMPARE_METRICS.occupancy;
  const centres = db.prepare(`SELECT owna_id, name, capacity, ${PLACES_SQL} AS places FROM centres WHERE (opening IS NULL OR opening = 0) AND ${PLACES_SQL} > 0 ORDER BY name`).all();
  if (cfg.cadence === "week") {
    const weeks = labourWeeks(n || 16).slice().reverse();
    const series = centres.map((ct) => {
      const map = {}; wagesTrend(ct.owna_id, n || 16).forEach((r) => { map[r.week] = r[metric]; });
      return { owna_id: ct.owna_id, name: ct.name.replace("Futuro Childcare & Education - ", ""), points: weeks.map((w) => (map[w] == null ? null : map[w])) };
    });
    const ranking = rankCompareSeries(series, cfg, null);
    return { axis: weeks, cadence: "week", series, cfg, metric, ranking };
  }
  // Booking-based metrics extend forward (projected from scheduled bookings, drawn dashed); manual P&C metrics are past-only.
  const fromBookings = cfg.source === "bookings";
  const now = todayStr().slice(0, 7); const [yy, mm] = now.split("-").map(Number);
  const pastN = n || 12, fwdN = fromBookings ? 2 : 0;
  const axis = [];
  for (let i = pastN; i >= -fwdN; i--) axis.push(new Date(Date.UTC(yy, mm - 1 - i, 1)).toISOString().slice(0, 7));
  let dashFrom = null;
  if (fromBookings) { const fi = axis.findIndex((mo2) => mo2 >= now); dashFrom = fi > 0 ? fi - 1 : (fi === 0 ? 0 : null); }
  const series = centres.map((ct) => {
    const map = {}; // months absent from the map render as null (a gap), never zero
    if (metric === "occupancy") {
      db.prepare("SELECT substr(metric_date,1,7) month, COALESCE(SUM(booked),0) booked, COUNT(DISTINCT metric_date) days FROM daily_metrics WHERE owna_id=? GROUP BY month")
        .all(ct.owna_id).forEach((r) => { map[r.month] = pct(r.booked, ct.places * r.days); });
    } else if (fromBookings) {
      placesByMonth(ct.owna_id, ct.places, axis[0], axis[axis.length - 1]).forEach((r) => { map[r.month] = r[metric]; });
    } else { const pt = pcTrend(ct.owna_id, 24); pt.axis.forEach((mo2, i) => { map[mo2] = pt.series[metric] ? pt.series[metric][i] : null; }); }
    return { owna_id: ct.owna_id, name: ct.name.replace("Futuro Childcare & Education - ", ""), points: axis.map((mo2) => (map[mo2] == null ? null : map[mo2])) };
  });
  const ranking = rankCompareSeries(series, cfg, dashFrom);
  return { axis, cadence: "month", series, cfg, metric, dashFrom, ranking };
}

// How many new bookings of each day-pattern lift weekly occupancy by each target (pp).
// `places` is the licensed count (approved places), the same denominator the occupancy figure came from.
function occupancyCalculator(places, occupancyNow, targets = [5, 10]) {
  const patterns = [2, 3, 4, 5];
  const free = occupancyNow != null ? Math.max(0, Math.round(places * (1 - occupancyNow / 100))) : null;
  return targets.map((delta) => ({
    delta,
    target_occ: occupancyNow != null ? Math.round((occupancyNow + delta) * 10) / 10 : null,
    reachable: occupancyNow == null || occupancyNow + delta <= 100,
    perPattern: patterns.map((d) => {
      const extraChildDays = delta / 100 * places * 5; // extra booked child-days/week for +delta pp
      return { days: d, count: Math.ceil(extraChildDays / d) };
    }),
    free,
  }));
}

// Rule-based, data-driven improvement tips for a centre. Each rule only fires when the data warrants it.
// `places` is the licensed count (approved places); with none recorded there is no growth calculator to show.
function centreInsights(ownaId, places, occupancyNow, pipeline, labour) {
  const dow = centreDowOccupancy(ownaId);
  const valid = dow.filter((d) => d.occupancy != null);
  const tips = [];
  const today = todayStr();
  const money = (n) => "$" + Math.round(n).toLocaleString("en-AU");
  const ago = (days) => cal.addDays(today, -days);
  const ahead = (days) => cal.addDays(today, days);

  // Recent 28-day actuals (past only): occupancy, attendance, avg daily fee, absences.
  const recent = db.prepare(`
    SELECT COALESCE(SUM(booked),0) booked, COALESCE(SUM(attended),0) attended, COALESCE(SUM(absent),0) absent,
           COALESCE(SUM(fee_total),0) fee, COUNT(DISTINCT metric_date) d
    FROM daily_metrics WHERE owna_id=? AND metric_date BETWEEN ? AND ?`).get(ownaId, ago(28), today);
  const avgDailyFee = recent.booked ? recent.fee / recent.booked : null; // $ per child-day
  const recentOcc = (places && recent.d) ? pct(recent.booked, places * recent.d) : occupancyNow;

  // 1) Day-of-week balance, with the $ opportunity of closing the gap folded in.
  if (valid.length >= 2) {
    const peak = valid.reduce((a, b) => (b.occupancy > a.occupancy ? b : a));
    const low = valid.reduce((a, b) => (b.occupancy < a.occupancy ? b : a));
    const spread = Math.round((peak.occupancy - low.occupancy) * 10) / 10;
    if (spread >= 8) {
      let t = `${peak.dow} runs fullest at ${peak.occupancy}%, while ${low.dow} sits at ${low.occupancy}% — a ${spread}pp gap. Encouraging some ${peak.dow} families to add a ${low.dow} day (or steering casual demand there) would lift your quietest day and overall occupancy.`;
      const extra = Math.max(0, Math.round((peak.avg_booked || 0) - (low.avg_booked || 0)));
      if (extra > 0 && avgDailyFee) t += ` That's about ${extra} more ${low.dow} place${extra === 1 ? "" : "s"} ≈ ${money(extra * avgDailyFee)}/week in fees.`;
      tips.push(t);
    }
  }

  // Waitlist vs free places.
  if (pipeline && pipeline.waitlist > 0) {
    const free = places && recentOcc != null ? Math.round(places * (1 - recentOcc / 100)) : null;
    if (free && free > 0) tips.push(`You have ${pipeline.waitlist} on the waitlist and roughly ${free} place${free === 1 ? "" : "s"} free on an average day — converting waitlist families into permanent bookings is the fastest occupancy win.`);
  }

  // Casual conversion.
  const avgCasual = valid.length ? Math.round(valid.reduce((s, d) => s + (d.avg_casual || 0), 0) / valid.length) : 0;
  if (avgCasual >= 3) tips.push(`Around ${avgCasual} casual bookings a day — casuals are good revenue but volatile. Offering these families a permanent day locks in the place and steadies your roster.`);

  // 2) Occupancy trend over the last 3 complete months.
  const tr = occupancyTrend(ownaId, 6).filter((t) => t.month < today.slice(0, 7));
  if (tr.length >= 4) {
    const cur = tr[tr.length - 1], prev = tr[tr.length - 4];
    const delta = Math.round((cur.occupancy - prev.occupancy) * 10) / 10;
    if (delta <= -4) tips.push(`Occupancy has slipped ${Math.abs(delta)}pp over the last 3 months (${prev.occupancy}% → ${cur.occupancy}%) — worth acting before it compounds.`);
    else if (delta >= 5) tips.push(`Occupancy is up ${delta}pp over the last 3 months (${prev.occupancy}% → ${cur.occupancy}%) — good momentum; keep the pipeline warm to hold it.`);
  }

  // 3) Forward-booking dip: next 4 weeks scheduled vs recent actual.
  const fwd = db.prepare(`
    SELECT COALESCE(SUM(booked),0) booked, COUNT(DISTINCT metric_date) d
    FROM daily_metrics WHERE owna_id=? AND metric_date > ? AND metric_date <= ?`).get(ownaId, today, ahead(28));
  if (fwd.d >= 5 && places && recentOcc != null) {
    const fwdOcc = pct(fwd.booked, places * fwd.d);
    const dip = Math.round((recentOcc - fwdOcc) * 10) / 10;
    if (dip >= 4) tips.push(`Bookings for the next 4 weeks average ${fwdOcc}%, ${dip}pp below your recent ${recentOcc}% — a casual drive or re-enrolment push would close the gap.`);
  }

  // 4) Exits vs pipeline gap over the next 90 days.
  const leaving90 = db.prepare(`SELECT COUNT(*) n FROM child_exits WHERE owna_id=? AND upcoming=1 AND finish_date <= ?`).get(ownaId, ahead(90)).n;
  const starts = pipeline ? (pipeline.starts_future || 0) : 0;
  if (leaving90 > 0 && leaving90 > starts) {
    const gap = leaving90 - starts;
    tips.push(`${leaving90} ${leaving90 === 1 ? "child is" : "children are"} scheduled to leave in the next 90 days and you have ${starts} expected start${starts === 1 ? "" : "s"} — you'll need about ${gap} more enrolment${gap === 1 ? "" : "s"} just to hold occupancy.`);
  }

  // 5) Tour-to-enrolment follow-up: tours booked outnumbering locked-in future starts.
  if (pipeline && (pipeline.tour_scheduled || 0) >= 5 && (pipeline.tour_scheduled || 0) > starts) {
    tips.push(`${pipeline.tour_scheduled} tours are booked but only ${starts} expected start${starts === 1 ? "" : "s"} ${starts === 1 ? "is" : "are"} locked in — make sure every tour has a clear follow-up so more of them convert.`);
  }

  // 6) Absence = sellable capacity (only where a waitlist means real demand to backfill).
  if (recent.booked && recent.d && pipeline && pipeline.waitlist > 0) {
    const attRate = pct(recent.attended, recent.booked);
    const emptyPerWeek = Math.round(recent.absent / recent.d * 5);
    if (emptyPerWeek >= 8) tips.push(`About ${emptyPerWeek} booked places go unattended each week (attendance ${attRate}%) — with ${pipeline.waitlist} on the waitlist, those booked-but-absent days can be on-sold as casual: extra revenue on a place you've already staffed.`);
  }

  // 7) Wage % / margin pressure.
  if (labour && labour.wage_pct != null && labour.wage_pct > 65) {
    tips.push(`Educator wages are ${labour.wage_pct}% of revenue (target ≤65%). Lifting occupancy on quiet days, or trimming roster hours there, would restore margin.`);
  }

  const calc = places ? occupancyCalculator(places, occupancyNow) : [];
  return { dow, tips, calc, occupancyNow, places };
}

// ===== Rostering (OWNA weekly roster) + rostered-vs-paid reconciliation =====
const ROSTER_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];
function rosterWeeks(limit = 16) {
  return db.prepare("SELECT DISTINCT week_starting FROM roster_weekly ORDER BY week_starting DESC LIMIT ?").all(limit).map((r) => r.week_starting);
}
// Best default week for the group view: latest roster week that also has EH paid data (pay lags the roster).
function latestReconciledRosterWeek() {
  const weeks = rosterWeeks(16);
  for (const w of weeks) {
    if (db.prepare("SELECT 1 FROM labour_weekly WHERE week_ending=? LIMIT 1").get(ehWeekEndingFor(w))) return w;
  }
  return weeks[0] || null;
}
// EH pay weeks end on the Sunday of the roster's Mon-start week. Compute in UTC to avoid tz drift.
function ehWeekEndingFor(weekStarting) {
  const d = new Date(weekStarting + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}
// Actual WORKED hours matching OWNA's roster scope: educators (worked_h) + cooks (kitchen_h),
// EXCLUDING paid leave and cleaning (cleaners are not on the OWNA roster). Like-for-like vs rostered hours.
function ehPaidHours(ownaId, weekEnding) {
  const r = db.prepare("SELECT * FROM labour_weekly WHERE owna_id=? AND week_ending=?").get(ownaId, weekEnding);
  if (!r) return null;
  return Math.round(((r.worked_h || 0) + (r.kitchen_h || 0)) * 10) / 10;
}
function rosterParse(r) {
  const days = JSON.parse(r.days_json || "[]");
  const wd = days.filter((d) => ROSTER_WEEKDAYS.includes(d.day) && d.hours > 0);
  const hpb = wd.map((d) => d.hpb).filter((v) => v != null);
  const avgHpb = hpb.length ? Math.round(hpb.reduce((a, b) => a + b, 0) / hpb.length * 100) / 100 : null;
  return { week_starting: r.week_starting, total_hours: r.total_hours, avg_hpb: avgHpb, days };
}
// One row per centre for a given roster week, with EH paid-hours reconciliation.
function rosterForWeek(weekStarting) {
  const rows = db.prepare("SELECT r.*, c.name FROM roster_weekly r JOIN centres c ON c.owna_id=r.owna_id WHERE r.week_starting=? ORDER BY c.name").all(weekStarting);
  const wkEnd = ehWeekEndingFor(weekStarting);
  return rows.map((r) => {
    const base = rosterParse(r);
    const paid = ehPaidHours(r.owna_id, wkEnd);
    const variance = paid != null ? Math.round((paid - r.total_hours) * 10) / 10 : null;
    return { owna_id: r.owna_id, name: r.name.replace("Futuro Childcare & Education - ", ""), ...base,
      paid_hours: paid, ehWeek: wkEnd, variance, variance_pct: (paid && r.total_hours) ? Math.round((paid - r.total_hours) / r.total_hours * 1000) / 10 : null };
  });
}
// One centre: latest week day-breakdown + weekly trend (rostered hrs, hrs/booking, paid hrs) + leave.
function rosterCentre(ownaId, weeksBack = 12) {
  const rows = db.prepare("SELECT * FROM roster_weekly WHERE owna_id=? ORDER BY week_starting DESC LIMIT ?").all(ownaId, weeksBack);
  if (!rows.length) return null;
  const trend = rows.slice().reverse().map((r) => {
    const b = rosterParse(r);
    return { week_starting: r.week_starting, total_hours: r.total_hours, avg_hpb: b.avg_hpb, paid_hours: ehPaidHours(ownaId, ehWeekEndingFor(r.week_starting)) };
  });
  // Headline on the latest week that has EH worked data for this centre (pay lags the roster), else the latest roster.
  const headRow = rows.find((r) => ehPaidHours(ownaId, ehWeekEndingFor(r.week_starting)) != null) || rows[0];
  const latest = rosterParse(headRow);
  const ehWeek = ehWeekEndingFor(headRow.week_starting);
  const paid = ehPaidHours(ownaId, ehWeek);
  return { latest, paid_hours: paid, ehWeek, variance: paid != null ? Math.round((paid - latest.total_hours) * 10) / 10 : null,
    leave: JSON.parse(headRow.leave_json || "[]"), trend };
}

// ===== Continuation of Enrolment (COE): the 2027 campaign outlook, Nov 2026 – Apr 2027 =====
// Counts only, one method per number, so the page can state beside every figure how it was derived:
//   available child-days = licensed places × operating days in the month (NSW calendar)
//   run rate             = child-days booked in the last complete Mon–Fri week, scaled to the month
//   leaver days          = OWNA finish dates already set, valued at the centre's average booked days per child
//   backfill days        = LineLeader expected starts, valued at the weekdays the family asked for
//   projected filled     = run rate − leaver days + firm backfill
// Three limits are deliberate and are printed in the page lede: the run rate assumes every family without a
// finish date continues (so it is a ceiling), January overlaps leavers still present with starters already added,
// and leaver days use the centre's average booking pattern rather than each leaver's own days.
const COE_FIRST_MONTH = "2026-11";
const COE_MONTH_COUNT = 6;                       // Nov 2026 → Apr 2027
const COE_FIRM_STATUSES = [5, 12];               // LineLeader: Offer Accepted, Pre-Offered
// The COE target is now the PER-CENTRE occupancy target stored in labour_budget.budget_occ (see
// occupancyTargets() above): Austral, Bardia and GWH are on 102% and Heath Rd on 85%. COE_TARGET_PCT is
// kept as the single group fallback for a centre with nothing stored, and every figure derived from a
// target carries target_pct and target_source so the page can print which one it used.
//
// WHY A TARGET ABOVE 100% IS NOT A BUG, and which measure it applies to. The measure is BOOKED child-days
// ÷ (approved places × operating days) — the same construction as the occupancy figure budget_occ has
// always been compared against on the wage page, so the stored number keeps its meaning here. A booking
// counts whether or not the child turns up: an absent child still holds the place. So booked child-days run
// above the children actually present, and the ratio can pass 100% while the number of children in the
// building does not — the licence limits who ATTENDS on a day. In the run-rate week of 7–11 Sep 2026
// Austral booked 625 child-days against 620 place-days (100.8%) and 572 of them were attended (92.3%).
// It is NOT reached by part-time families sharing a place across the week: that is what makes CHILDREN
// PER PLACE 1.52, and it cannot lift days-filled, because a part-time child contributes fewer child-days,
// not more. coeOutlook therefore reports run_week_attended beside run_week_days so the page can show both.
const COE_TARGET_PCT = GROUP_TARGET_PCT;         // group fallback only — per-centre targets come from labour_budget
const COE_WEEKDAYS = ["mo", "tu", "we", "th", "fr"];

const coeDaysInMonth = (ym) => { const [y, mo] = ym.split("-").map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
const coeMonthEnd = (ym) => `${ym}-${String(coeDaysInMonth(ym)).padStart(2, "0")}`;
const d1 = (n) => Math.round(n * 10) / 10;
function coeMonthKeys(first = COE_FIRST_MONTH, count = COE_MONTH_COUNT) {
  const [y, mo] = first.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(y, mo - 1 + i, 1)).toISOString().slice(0, 7));
}
// Days per week a family has asked for, from LineLeader's days_csv ("mo,tu,we"). Unknown tokens are ignored.
function coeDaysPerWeek(csv) {
  return String(csv || "").split(",").map((s) => s.trim().slice(0, 2).toLowerCase()).filter((s) => COE_WEEKDAYS.includes(s)).length;
}
// The last Mon–Fri week that had fully ended before today. Steps back over weeks with no booking rows at
// all (a stale snapshot) so the run rate is never silently zero. The same week is used for every centre.
function coeRunWeek(today = todayStr()) {
  const d = new Date(today + "T00:00:00Z");
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() !== 5);
  const any = db.prepare("SELECT 1 FROM daily_metrics WHERE metric_date BETWEEN ? AND ? LIMIT 1");
  let firstTry = null;
  for (let i = 0; i < 8; i++) {
    const to = d.toISOString().slice(0, 10);
    const mon = new Date(d); mon.setUTCDate(mon.getUTCDate() - 4);
    const week = { from: mon.toISOString().slice(0, 10), to };
    if (!firstTry) firstTry = week;
    if (any.get(week.from, week.to)) return week;
    d.setUTCDate(d.getUTCDate() - 7);
  }
  return firstTry;
}

function coeOutlook() {
  const today = todayStr();
  const keys = coeMonthKeys();
  const lastEnd = coeMonthEnd(keys[keys.length - 1]);
  const runWeek = coeRunWeek(today);
  const pipelineFrom = today.slice(0, 7) + "-01";   // starts are counted from the first of the current month
  const months = keys.map((k) => ({ month: k, operating_days: cal.operatingDays(k + "-01", coeMonthEnd(k)), days_in_month: coeDaysInMonth(k) }));

  const targets = occupancyTargets();
  // Attendance beside the bookings in the same week, so the page can show why a target over 100% of
  // approved places is reachable on a BOOKED measure without any child being in the building over licence.
  const runRow = db.prepare("SELECT COALESCE(SUM(booked),0) AS booked, COALESCE(SUM(attended),0) AS attended FROM daily_metrics WHERE owna_id=? AND metric_date BETWEEN ? AND ?");
  const exitRows = db.prepare("SELECT owna_id, finish_date FROM child_exits WHERE upcoming=1 AND finish_date>=? AND finish_date<=? ORDER BY finish_date").all(today, lastEnd);
  const startRows = db.prepare("SELECT owna_id, status_id, expected_start, days_csv FROM ll_pipeline_starts WHERE expected_start>=? AND expected_start<=? ORDER BY expected_start").all(pipelineFrom, lastEnd);
  const byOwna = (rows) => rows.reduce((a, r) => { (a[r.owna_id] = a[r.owna_id] || []).push(r); return a; }, {});
  const exitsBy = byOwna(exitRows), startsBy = byOwna(startRows);

  // Backfill child-days for one centre in one month: a start counts from its expected start date, prorated
  // across the month's calendar days, valued at the weekdays asked for scaled to the month's operating days.
  // A start with no requested days recorded in LineLeader is still a committed child: it is counted in the
  // headcount and valued at that centre's mean requested days per week, and days_unknown / all_days_unknown
  // say how many of the children counted carry that estimate, so the page can state it beside the number.
  const backfill = (rows, mo) => {
    const start = mo.month + "-01", end = coeMonthEnd(mo.month);
    const known = rows.map((s) => coeDaysPerWeek(s.days_csv)).filter((n) => n > 0);
    const fallbackDpw = known.length ? known.reduce((a, n) => a + n, 0) / known.length : 0;
    const out = { firm_children: 0, firm_days: 0, all_children: 0, all_days: 0, days_unknown: 0, all_days_unknown: 0 };
    for (const s of rows) {
      if (!s.expected_start || s.expected_start > end) continue;
      const asked = coeDaysPerWeek(s.days_csv);
      const dpw = asked || fallbackDpw;                // no requested days recorded → the centre's mean, flagged below
      const unknown = asked ? 0 : 1;
      const frac = s.expected_start <= start ? 1 : (mo.days_in_month - Number(s.expected_start.slice(8, 10)) + 1) / mo.days_in_month;
      const days = dpw * (mo.operating_days / 5) * frac;
      out.all_children += 1; out.all_days += days; out.all_days_unknown += unknown;
      if (COE_FIRM_STATUSES.includes(s.status_id)) { out.firm_children += 1; out.firm_days += days; out.days_unknown += unknown; }
    }
    return out;
  };

  const operating = db.prepare(`SELECT owna_id, name, capacity, ${PLACES_SQL} AS places, enrolled FROM centres WHERE (opening IS NULL OR opening=0) AND ${PLACES_SQL}>0 ORDER BY name`).all();
  const centres = operating.map((c) => {
    const runWk = runRow.get(c.owna_id, runWeek.from, runWeek.to);
    const runDays = runWk.booked;
    const tgt = targetFor(c.owna_id, targets);               // this centre's own target, or the group fallback
    const avgDays = c.enrolled ? runDays / c.enrolled : 0;   // average booked days per child per week
    const exits = exitsBy[c.owna_id] || [], starts = startsBy[c.owna_id] || [];
    const rows = months.map((mo) => {
      const start = mo.month + "-01", end = coeMonthEnd(mo.month);
      const available = c.places * mo.operating_days; // licensed places × operating days
      const runRate = runDays * (mo.operating_days / 5);
      // Leavers are cumulative: a child who finished in an earlier month is gone for the whole of this one.
      let leaverDays = 0, toDate = 0, inMonth = 0;
      for (const e of exits) {
        if (e.finish_date > end) continue;
        toDate += 1;
        if (e.finish_date >= start) inMonth += 1;
        const frac = e.finish_date < start ? 1 : (mo.days_in_month - Number(e.finish_date.slice(8, 10))) / mo.days_in_month;
        leaverDays += avgDays * (mo.operating_days / 5) * frac;
      }
      const bf = backfill(starts, mo);
      const projected = runRate - leaverDays + bf.firm_days;
      return {
        month: mo.month, operating_days: mo.operating_days,
        available_days: available, run_rate_days: d1(runRate),
        leavers_in_month: inMonth, leavers_to_date: toDate, leaver_days: d1(leaverDays),
        firm_children: bf.firm_children, firm_days: d1(bf.firm_days), days_unknown: bf.days_unknown,
        all_children: bf.all_children, all_days: d1(bf.all_days), all_days_unknown: bf.all_days_unknown,
        projected_days: d1(projected), pct: pct(projected, available),
        // Target and gap are this centre's own, never the group's: Heath Rd is measured against 85% in the
        // same column where Austral is measured against 102%, so both travel with the row.
        target_pct: tgt.pct, target_days: d1(available * tgt.pct / 100),
        gap_days: d1(Math.max(0, available * tgt.pct / 100 - projected)),
        _raw: { available, runRate, leaverDays, firm: bf.firm_days, all: bf.all_days, projected, leavers: toDate, inMonth,
          firmKids: bf.firm_children, unknown: bf.days_unknown, allUnknown: bf.all_days_unknown,
          targetDays: available * tgt.pct / 100 },
      };
    });
    return { owna_id: c.owna_id, name: c.name, places: c.places, enrolled: c.enrolled,
      run_week_days: runDays, run_week_attended: runWk.attended,
      run_week_pct: pctOrNull(runDays, c.places * 5), run_week_attended_pct: pctOrNull(runWk.attended, c.places * 5),
      target_pct: tgt.pct, target_source: tgt.source, target_eh_centre: tgt.eh_centre,
      avg_days_per_child: Math.round(avgDays * 100) / 100, months: rows };
  });

  const groupPlaces = centres.reduce((a, c) => a + c.places, 0);
  const groupTarget = blendedTarget(centres, targets);
  const group = {
    places: groupPlaces,
    enrolled: centres.reduce((a, c) => a + c.enrolled, 0),
    run_week_days: centres.reduce((a, c) => a + c.run_week_days, 0),
    run_week_attended: centres.reduce((a, c) => a + c.run_week_attended, 0),
    run_week_pct: pctOrNull(centres.reduce((a, c) => a + c.run_week_days, 0), groupPlaces * 5),
    run_week_attended_pct: pctOrNull(centres.reduce((a, c) => a + c.run_week_attended, 0), groupPlaces * 5),
    // The group target is the places-weighted blend of the centre targets, not the 95% fallback and not
    // their mean — see blendedTarget(). A group row coloured against a flat number would say Heath Rd's
    // 85% and Austral's 102% average out to something neither centre is actually judged against.
    target_pct: groupTarget,
    months: months.map((mo, i) => {
      const t = centres.reduce((a, c) => {
        const r = c.months[i]._raw;
        a.available += r.available; a.runRate += r.runRate; a.leaverDays += r.leaverDays; a.firm += r.firm; a.all += r.all;
        a.projected += r.projected; a.leavers += r.leavers; a.inMonth += r.inMonth; a.firmKids += r.firmKids;
        a.unknown += r.unknown; a.allUnknown += r.allUnknown;
        a.targetDays += r.targetDays; a.shortfall += Math.max(0, r.targetDays - r.projected);
        return a;
      }, { available: 0, runRate: 0, leaverDays: 0, firm: 0, all: 0, projected: 0, leavers: 0, inMonth: 0, firmKids: 0, unknown: 0, allUnknown: 0, targetDays: 0, shortfall: 0 });
      return { month: mo.month, operating_days: mo.operating_days, available_days: t.available,
        run_rate_days: d1(t.runRate), leavers_in_month: t.inMonth, leavers_to_date: t.leavers, leaver_days: d1(t.leaverDays),
        firm_children: t.firmKids, firm_days: d1(t.firm), all_days: d1(t.all),
        days_unknown: t.unknown, all_days_unknown: t.allUnknown,
        projected_days: d1(t.projected), pct: pct(t.projected, t.available),
        target_pct: pct(t.targetDays, t.available), target_days: d1(t.targetDays),
        gap_days: d1(Math.max(0, t.targetDays - t.projected)),
        // …and the same shortfall counted centre by centre, which is the number the campaign has to fill:
        // a centre over its target cannot fill a seat at a centre under it, so the two differ on purpose.
        shortfall_days: d1(t.shortfall) };
    }),
  };
  centres.forEach((c) => c.months.forEach((r) => { delete r._raw; }));

  // Pre-opening centres that open inside the window: no run rate and no licensed places, so no percentage.
  const lastIdx = Number(keys[keys.length - 1].slice(0, 4)) * 12 + Number(keys[keys.length - 1].slice(5, 7));
  const opening = db.prepare("SELECT owna_id, name, capacity, approved_places, opening_year, opening_month FROM centres WHERE opening=1 AND opening_year IS NOT NULL AND opening_month IS NOT NULL ORDER BY opening_year, opening_month, name")
    .all().filter((c) => c.opening_year * 12 + c.opening_month <= lastIdx).map((c) => {
      const starts = startsBy[c.owna_id] || [];
      const mix = {}; COE_WEEKDAYS.forEach((w) => { mix[w] = 0; });
      let mixFamilies = 0;
      for (const s of starts) {
        const days = String(s.days_csv || "").split(",").map((x) => x.trim().slice(0, 2).toLowerCase()).filter((x) => COE_WEEKDAYS.includes(x));
        if (days.length) mixFamilies += 1;
        days.forEach((x) => { mix[x] += 1; });
      }
      // No service approval on the register yet, so places is null (unknown) — never 0, and never a percentage of 0.
      return { owna_id: c.owna_id, name: c.name, places: placesFor(c), opening_year: c.opening_year, opening_month: c.opening_month,
        months: months.map((mo) => { const bf = backfill(starts, mo);
          return { month: mo.month, operating_days: mo.operating_days, firm_children: bf.firm_children, firm_days: d1(bf.firm_days),
            all_children: bf.all_children, all_days: d1(bf.all_days), days_unknown: bf.days_unknown, all_days_unknown: bf.all_days_unknown }; }),
        mix, mix_families: mixFamilies };
    });

  return { months, window: { first: keys[0], last: keys[keys.length - 1] }, as_at: today,
    run_week: runWeek, pipeline_from: pipelineFrom,
    // target_pct is the GROUP FALLBACK, kept under its old name so nothing that reads it silently changes
    // meaning. The number a centre is actually judged against is centre.target_pct, and the group's is
    // group.target_pct. targets_* count how many centres are on a stored target and how many fell back.
    target_pct: COE_TARGET_PCT, target_default_pct: COE_TARGET_PCT,
    targets_stored: centres.filter((c) => c.target_source === "centre").length,
    targets_default: centres.filter((c) => c.target_source !== "centre").length,
    targets_editable_at: "/admin/places",
    centres, group, opening, measured: coeMeasured(keys, targets),
    unknown_holiday_years: cal.unknownHolidayYears(keys[0] + "-01", lastEnd) };
}

// ===== The MEASURED half of COE: what the nightly snapshot counted (services/snapshot.js runCoeSnapshot)
// Returns null until the first snapshot has run, so the page keeps working exactly as it did and says the
// measured count starts accumulating from the first nightly run. Counts only — nothing here is per-child.
//
// A centre whose recurring bookings stop dead before the window ends (Heath Rd appears to end them on
// 31 December rather than rolling them — outstanding.md item 7) reads as a total collapse if you take it
// at face value, so months its roll does not reach are marked beyond_horizon and reported as "not measurable",
// never as leavers. Those centre-months are also kept out of the group totals, which say how many centres
// they cover.

// A snapshot night that fails for some centres — or that OWNA reports no children for — still writes rows
// for the ones it reached (services/snapshot.js runCoeSnapshot counts them and carries on), so the newest
// snapshot_date can cover a fraction of the group. Taking MAX(snapshot_date) blindly let a 1-of-4 night
// replace a complete one and shrink every measured figure on the page with no caveat at all. Prefer the
// most recent night that covered every operating centre; fall back to the newest partial night, which the
// page must then label "n of m centres measured" rather than report as the whole group.
function coeSnapshotDate(meta) {
  if (meta.length) {
    const marks = meta.map(() => "?").join(",");
    const full = db.prepare(
      `SELECT snapshot_date AS d FROM coe_continuing WHERE owna_id IN (${marks})
        GROUP BY snapshot_date HAVING COUNT(DISTINCT owna_id) = ? ORDER BY snapshot_date DESC LIMIT 1`
    ).get(...meta.map((c) => c.owna_id), meta.length);
    if (full && full.d) return full.d;
  }
  return (db.prepare("SELECT MAX(snapshot_date) AS d FROM coe_continuing").get() || {}).d || null;
}

function coeMeasured(keys = coeMonthKeys(), targets = occupancyTargets()) {
  // Read the operating centres first: they decide WHICH night to read, not just which rows to keep.
  const meta = db.prepare(`SELECT owna_id, name, capacity, ${PLACES_SQL} AS places FROM centres WHERE (opening IS NULL OR opening = 0) AND ${PLACES_SQL} > 0 ORDER BY name`).all();
  const date = coeSnapshotDate(meta);
  if (!date) return null;
  const cont = db.prepare("SELECT * FROM coe_continuing WHERE snapshot_date = ? ORDER BY owna_id, month").all(date);
  if (!cont.length) return null;
  const horizons = db.prepare("SELECT * FROM coe_forward_horizon WHERE snapshot_date = ?").all(date);
  const mixRows = db.prepare("SELECT * FROM coe_booking_mix WHERE snapshot_date = ? ORDER BY owna_id, days_per_week").all(date);
  const byId = (rows) => rows.reduce((a, r) => { (a[r.owna_id] = a[r.owna_id] || []).push(r); return a; }, {});
  const contBy = byId(cont), mixBy = byId(mixRows);
  const horizonBy = horizons.reduce((a, r) => { a[r.owna_id] = r; return a; }, {});

  const centres = meta.filter((c) => contBy[c.owna_id]).map((c) => {
    const h = horizonBy[c.owna_id] || {};
    const rows = keys.map((k) => contBy[c.owna_id].find((r) => r.month === k) || null).filter(Boolean)
      .map((r) => ({ month: r.month, operating_days: r.operating_days, enrolled: r.enrolled,
        continuing: r.continuing, not_confirmed: r.not_confirmed, leaving: r.leaving,
        continuing_days: r.continuing_days, not_confirmed_days: r.not_confirmed_days, leaving_days: r.leaving_days,
        beyond_horizon: !!r.beyond_horizon,
        continuing_pct: pct(r.continuing, r.enrolled),
        available_days: c.places * r.operating_days })); // licensed places × operating days
    const mix = (mixBy[c.owna_id] || []).map((r) => ({ days_per_week: r.days_per_week, children: r.children, child_days: r.child_days }));
    const children = mix.reduce((a, b) => a + b.children, 0);
    const childDays = mix.reduce((a, b) => a + b.child_days, 0);
    const tgt = targetFor(c.owna_id, targets);
    return { owna_id: c.owna_id, name: c.name, places: c.places,
      enrolled: h.enrolled != null ? h.enrolled : (rows[0] ? rows[0].enrolled : 0),
      months: rows, mix, mix_children: children, mix_child_days: childDays,
      avg_days_per_child: children ? Math.round(childDays / children * 100) / 100 : 0,
      places_filled_pct: pctOrNull(children, c.places),       // one child holds one licensed place
      days_filled_pct: pctOrNull(childDays, c.places * 5),    // …but only for the days they book
      // Days filled is the measure the stored target is set against, so it travels with its own target.
      target_pct: tgt.pct, target_source: tgt.source, target_eh_centre: tgt.eh_centre,
      week: { from: h.week_from || null, to: h.week_to || null },
      last_booking_date: h.last_booking_date || null,
      horizon_children: h.horizon_children || 0,
      // "Stops dead": the roll ends early enough to leave a campaign month it does not cover — empty, or
      // stopped inside it with more than a week of it uncounted (services/snapshot.js sets the flag) —
      // and it ends for most of the centre in the same week. A data problem at source, not families leaving.
      stops_early: rows.some((r) => r.beyond_horizon),
      stops_together: !!(h.last_booking_date && h.enrolled && h.horizon_children / h.enrolled >= 0.5),
    };
  });
  if (!centres.length) return null;

  const months = keys.map((k, i) => {
    const rows = centres.map((c) => c.months[i]).filter((r) => r && r.month === k);
    const live = rows.filter((r) => !r.beyond_horizon);
    const sum = (f) => live.reduce((a, r) => a + (r[f] || 0), 0);
    return { month: k, operating_days: rows.length ? rows[0].operating_days : 0,
      enrolled: sum("enrolled"), continuing: sum("continuing"), not_confirmed: sum("not_confirmed"), leaving: sum("leaving"),
      continuing_days: Math.round(sum("continuing_days") * 10) / 10,
      not_confirmed_days: Math.round(sum("not_confirmed_days") * 10) / 10,
      leaving_days: Math.round(sum("leaving_days") * 10) / 10,
      continuing_pct: pct(sum("continuing"), sum("enrolled")),
      available_days: live.reduce((a, r) => a + (r.available_days || 0), 0),
      centres_measured: live.length, centres_beyond: rows.length - live.length };
  });
  const mix = [1, 2, 3, 4, 5].map((d) => ({ days_per_week: d,
    children: centres.reduce((a, c) => a + ((c.mix.find((x) => x.days_per_week === d) || {}).children || 0), 0),
    child_days: centres.reduce((a, c) => a + ((c.mix.find((x) => x.days_per_week === d) || {}).child_days || 0), 0) }));
  const mixChildren = mix.reduce((a, b) => a + b.children, 0);
  const mixChildDays = mix.reduce((a, b) => a + b.child_days, 0);
  const places = centres.reduce((a, c) => a + c.places, 0);

  // The centres this night did NOT reach, with the night each was last measured on, so the page can say
  // "3 of 4 centres measured, Alpha last measured 12 Sep" instead of reporting a fraction as the whole.
  const missing = meta.filter((c) => !contBy[c.owna_id]).map((c) => ({ owna_id: c.owna_id, name: c.name,
    last_measured: (db.prepare("SELECT MAX(snapshot_date) AS d FROM coe_continuing WHERE owna_id = ?").get(c.owna_id) || {}).d || null }));

  return { snapshot_date: date, months,
    centres_expected: meta.length, centres_missing: missing, partial: missing.length > 0,
    group: { places, months, mix, mix_children: mixChildren, mix_child_days: mixChildDays,
      avg_days_per_child: mixChildren ? Math.round(mixChildDays / mixChildren * 100) / 100 : 0,
      places_filled_pct: pctOrNull(mixChildren, places), days_filled_pct: pctOrNull(mixChildDays, places * 5),
      // Blended over the centres this night actually reached, so a partial night is not judged against a
      // target that includes a centre whose numbers are not in the total.
      target_pct: blendedTarget(centres, targets) },
    targets_stored: centres.filter((c) => c.target_source === "centre").length,
    targets_default: centres.filter((c) => c.target_source !== "centre").length,
    centres, stops: centres.filter((c) => c.stops_early) };
}


// ===== Talent pipeline: Employment Hero people, counted (services/eh-talent.js writes the tables) =====
// Read-model only. Every figure below is a count of people, never a person: the snapshot stores no
// name, no employee id and no date of birth, so there is none here to leak.
//
// THE BASIS, once, so every caller reports the same thing (the owner's rules of 14 September 2026):
//   * Casuals are excluded from turnover on BOTH sides — not in the headcount denominator, and a casual
//     who leaves is not a leaver. They are counted once, group-wide, because the centre recorded
//     against a casual in payroll is an administrative home, not where the hours were worked. There is
//     therefore no per-centre casual figure anywhere in this file. (Casual HOURS per centre on the
//     Wages page come from payroll earnings lines and are a different measurement; they stand.)
//   * Someone whose end date is on or before their start date never worked a day and is not a leaver.
//   * Turnover % is rolling twelve months: leavers over that window ÷ the average month-end permanent
//     headcount across it. The same formula per centre and for the group, so they can be read together.
//   * A person's ROLE is their PAY CLASSIFICATION, not their job title (the owner's rule of 16
//     September 2026). services/classification.js holds the mapping; the categories below — ECT, Dip,
//     Cert 3, Trainee, Management, Support, Unclassified — are what every page shows, they sum to the
//     headcount, and a scale no rule matches is counted as Unclassified and listed on /admin/pay-scales
//     rather than hidden. Casuals are NOT in the per-centre mix, for the reason above; their mix is one
//     group figure.
const { ROLES: TALENT_ROLES, CESSATION_REASONS, NO_CENTRE } = require("./eh-talent");
const { CATEGORIES: PAY_CATEGORIES, classify: classifyScale, NO_SCALE_LABEL } = require("./classification");
const TALENT_WINDOW = 12; // months in the rolling turnover window
const VOLUNTARY_KEYS = new Set(CESSATION_REASONS.filter((r) => r.voluntary).map((r) => r.key));

const talentMonthsBack = monthsEndingAt; // n months ending at `last`, oldest first (P&C section)
function talentLatestMonth() {
  const r = db.prepare("SELECT MAX(month) m FROM talent_group_monthly").get();
  return (r && r.m) || null;
}
// Rolling turnover: leavers over the window as a percentage of the AVERAGE month-end headcount across
// it. Averaging matters in a group that grew from 138 to 175 in a year — dividing by today's headcount
// alone would quietly flatter every month the business was smaller.
function talentTurnoverPct(leavers, headcounts) {
  const hs = (headcounts || []).filter((h) => h != null);
  if (!hs.length) return null;
  const avg = hs.reduce((a, b) => a + b, 0) / hs.length;
  return avg > 0 ? Math.round((leavers / avg) * 1000) / 10 : null;
}
function talentCentreName(ownaId) {
  if (ownaId === NO_CENTRE) return "Support office (no centre)";
  const c = db.prepare("SELECT name FROM centres WHERE owna_id = ?").get(ownaId);
  return (c && c.name) || ownaId;
}

// The whole People & Culture talent picture for one centre (`ownaId`) or the group (null).
// `months` is how much of the trend to return; the reconciliation is always the full history, because
// a basis you can only see part of is a basis nobody can check.
function talentReport(ownaId = null, months = 24) {
  const latest = talentLatestMonth();
  if (!latest) return null;
  const axis = talentMonthsBack(latest, Math.max(1, months));
  const win = talentMonthsBack(latest, TALENT_WINDOW);            // the rolling year
  const winFrom = win[0], prevTo = talentMonthsBack(winFrom, 2)[0];
  const prevFrom = talentMonthsBack(winFrom, TALENT_WINDOW + 1)[0];
  const scoped = !!ownaId;

  const centreIds = db.prepare("SELECT DISTINCT owna_id FROM talent_monthly").all().map((r) => r.owna_id)
    .filter((id) => !scoped || id === ownaId);
  const monthRow = db.prepare("SELECT * FROM talent_monthly WHERE owna_id=? AND month=?");
  const windowRow = db.prepare(`SELECT COALESCE(SUM(starters),0) starters, COALESCE(SUM(leavers),0) leavers,
      COALESCE(SUM(never_started),0) never_started FROM talent_monthly WHERE owna_id=? AND month BETWEEN ? AND ?`);
  const heads = db.prepare("SELECT month, headcount FROM talent_monthly WHERE owna_id=? AND month BETWEEN ? AND ?");

  // A talent row's owna_id is a centre id for every real centre and '(support office)' for the payroll
  // locations that are not one. Only the former has a centre page to link the row to.
  const centrePages = new Set(db.prepare("SELECT owna_id FROM centres").all().map((r) => r.owna_id));

  const centres = centreIds.map((id) => {
    const now = monthRow.get(id, latest) || {};
    const w = windowRow.get(id, winFrom, latest) || {};
    const hs = heads.all(id, winFrom, latest).map((r) => r.headcount);
    return {
      owna_id: id, name: talentCentreName(id), is_group_bucket: id === NO_CENTRE,
      linkable: centrePages.has(id),
      headcount: now.headcount || 0,
      // The reported role mix: pay classification, permanent staff only. Sums to headcount.
      classes: PAY_CATEGORIES.map((c) => ({ key: c.key, label: c.label, n: now["cls_" + c.key] || 0 })),
      // A row written before the pay classification existed has a headcount and an empty mix. Say so;
      // seven zeros that do not add up to the headcount beside them would read as a finding.
      mix_pending: (now.headcount || 0) > 0 && !PAY_CATEGORIES.some((c) => now["cls_" + c.key]),
      roles: TALENT_ROLES.map((r) => ({ key: r.key, label: r.label, n: now[r.key] || 0 }))
        .concat([{ key: "other", label: "Other / unclassified", n: now.other || 0 }]),
      ect: now.ect || 0, edu_leader: now.edu_leader || 0, room_leader: now.room_leader || 0,
      educator: now.educator || 0, management: now.management || 0, support: now.support || 0, other: now.other || 0,
      starters12: w.starters || 0, leavers12: w.leavers || 0, never_started12: w.never_started || 0,
      turnover12: talentTurnoverPct(w.leavers || 0, hs),
      // A centre that opened inside the window divides by a much smaller average headcount than it
      // carries today, so its rate is real but volatile. Flagged rather than footnoted away.
      partial_window: hs.length > 0 && hs[0] === 0,
    };
  }).sort((a, b) => (a.is_group_bucket - b.is_group_bucket) || (b.headcount - a.headcount));

  // Group figures. Casuals live here and only here.
  const g = db.prepare("SELECT * FROM talent_group_monthly WHERE month=?").get(latest) || {};
  const sumGroup = (from, to) => db.prepare(`SELECT COALESCE(SUM(starters),0) starters, COALESCE(SUM(leavers),0) leavers,
      COALESCE(SUM(raw_terminations),0) raw, COALESCE(SUM(casual_leavers),0) casual, COALESCE(SUM(never_started),0) never
      FROM talent_group_monthly WHERE month BETWEEN ? AND ?`).get(from, to);
  const g12 = sumGroup(winFrom, latest);
  const gHeads = db.prepare("SELECT month, headcount FROM talent_group_monthly WHERE month BETWEEN ? AND ?").all(winFrom, latest).map((r) => r.headcount);
  const allTime = db.prepare(`SELECT MIN(month) first, COALESCE(SUM(raw_terminations),0) raw, COALESCE(SUM(casual_leavers),0) casual,
      COALESCE(SUM(never_started),0) never, COALESCE(SUM(leavers),0) leavers FROM talent_group_monthly`).get();

  // The group role mix is the sum of every centre's, taken from the table rather than from the `centres`
  // array above, which a scoped report has already narrowed to one centre.
  const gcSql = PAY_CATEGORIES.map((c) => `COALESCE(SUM(cls_${c.key}),0) ${c.key}`).join(",");
  const gc = db.prepare(`SELECT ${gcSql} FROM talent_monthly WHERE month = ?`).get(latest) || {};
  const group = {
    month: latest,
    headcount: g.headcount || 0,
    casual_headcount: g.casual_headcount || 0,   // group only — rule 3
    starters12: g12.starters, leavers12: g12.leavers,
    turnover12: talentTurnoverPct(g12.leavers, gHeads),
    classes: PAY_CATEGORIES.map((c) => ({ key: c.key, label: c.label, n: gc[c.key] || 0 })),
    // The one casual figure there is, broken down by the same categories. Never per centre.
    casual_classes: PAY_CATEGORIES.map((c) => ({ key: c.key, label: c.label, n: g["cas_" + c.key] || 0 })),
  };
  // The reconciliation the owner asked to be printed, so the 115 can be traced rather than doubted.
  const recon = {
    window: { from: winFrom, to: latest, label: "last 12 months", raw: g12.raw, casual: g12.casual, never_started: g12.never, leavers: g12.leavers },
    all: { from: allTime.first, to: latest, label: "all payroll history", raw: allTime.raw, casual: allTime.casual, never_started: allTime.never, leavers: allTime.leavers },
  };

  // Termination reasons, on the turnover basis, for the window / the previous window / all time.
  const reasonSum = (from, to) => {
    const sql = `SELECT reason_key, reason_label, COALESCE(SUM(leavers),0) n FROM talent_reasons_monthly
                 WHERE month BETWEEN ? AND ?${scoped ? " AND owna_id = ?" : ""} GROUP BY reason_key, reason_label`;
    const args = scoped ? [from, to, ownaId] : [from, to];
    const out = new Map();
    for (const r of db.prepare(sql).all(...args)) out.set(r.reason_key, r);
    return out;
  };
  const cur = reasonSum(winFrom, latest), before = reasonSum(prevFrom, prevTo), ever = reasonSum("0000-00", "9999-99");
  const keys = [...new Set([...CESSATION_REASONS.map((r) => r.key), ...ever.keys()])];
  const reasons = keys.map((key) => {
    const known = CESSATION_REASONS.find((r) => r.key === key);
    const seen = ever.get(key) || cur.get(key) || before.get(key);
    return {
      key,
      label: known ? known.label : (seen ? seen.reason_label : key),
      voluntary: VOLUNTARY_KEYS.has(key),
      known: !!known,
      last12: (cur.get(key) || {}).n || 0,
      prior12: (before.get(key) || {}).n || 0,
      all: (ever.get(key) || {}).n || 0,
    };
  }).filter((r) => r.all > 0 || r.known)           // an unseen STP code still shows as 0, never as blank
    .sort((a, b) => b.last12 - a.last12 || b.all - a.all || a.label.localeCompare(b.label));
  const totalLast12 = reasons.reduce((a, r) => a + r.last12, 0);
  const voluntaryLast12 = reasons.filter((r) => r.voluntary).reduce((a, r) => a + r.last12, 0);
  const totalAll = reasons.reduce((a, r) => a + r.all, 0);
  const voluntaryAll = reasons.filter((r) => r.voluntary).reduce((a, r) => a + r.all, 0);

  // Trend over the axis. For a centre, its own rows; for the group, the group table.
  const monthly = axis.map((mth) => {
    if (scoped) {
      const r = monthRow.get(ownaId, mth) || {};
      const v = db.prepare(`SELECT COALESCE(SUM(leavers),0) n FROM talent_reasons_monthly WHERE owna_id=? AND month=? AND reason_key IN (${[...VOLUNTARY_KEYS].map(() => "?").join(",")})`).get(ownaId, mth, ...VOLUNTARY_KEYS);
      return { month: mth, headcount: r.headcount ?? null, starters: r.starters || 0, leavers: r.leavers || 0, voluntary: v.n };
    }
    const r = db.prepare("SELECT * FROM talent_group_monthly WHERE month=?").get(mth) || {};
    const v = db.prepare(`SELECT COALESCE(SUM(leavers),0) n FROM talent_reasons_monthly WHERE month=? AND reason_key IN (${[...VOLUNTARY_KEYS].map(() => "?").join(",")})`).get(mth, ...VOLUNTARY_KEYS);
    return { month: mth, headcount: r.headcount ?? null, starters: r.starters || 0, leavers: r.leavers || 0, voluntary: v.n };
  });

  return {
    month: latest, scoped: scoped ? ownaId : null, window: { from: winFrom, to: latest, months: TALENT_WINDOW },
    centres, group, recon, reasons, monthly,
    totals: { last12: totalLast12, voluntary_last12: voluntaryLast12, all: totalAll, voluntary_all: voluntaryAll },
    // classLabels is the reported mix (pay classification). roleLabels is the superseded job-title one,
    // still returned for anything that asks but shown on no page.
    classLabels: PAY_CATEGORIES.map((c) => ({ key: c.key, label: c.label })),
    // True only while every counted month predates the pay classification — i.e. between deploying it
    // and the first talent snapshot that fills it in.
    mix_pending: (group.headcount > 0 && !group.classes.some((c) => c.n)) || centres.some((c) => c.mix_pending),
    roleLabels: TALENT_ROLES.map((r) => ({ key: r.key, label: r.label })).concat([{ key: "other", label: "Other / unclassified" }]),
    noCentreKey: NO_CENTRE,
  };
}

// The mapping itself, for /admin/pay-scales: every distinct pay scale payroll carries, how many people
// are on it, and the category it maps to. The category is re-derived from services/classification.js on
// every read rather than trusted from the stored column, so a correction to the rule shows immediately
// instead of waiting for the next nightly run — and a stored row that disagrees is flagged, not hidden.
function talentPayScales() {
  let stored = [];
  try { stored = db.prepare("SELECT * FROM talent_pay_scales").all(); } catch { stored = []; }
  const rows = stored.map((r) => {
    const c = classifyScale(r.scale);
    return {
      scale: r.scale || "",
      label: r.scale || NO_SCALE_LABEL,
      recorded: !!r.scale,
      category: c.key, category_label: c.label, matched: c.matched, why: c.why,
      people: r.people || 0, permanent: r.permanent || 0, casual: r.casual || 0,
      stale: r.category !== c.key,   // the rule has changed since the last snapshot wrote this row
    };
  }).sort((a, b) => (a.matched - b.matched) || (b.people - a.people) || a.label.localeCompare(b.label));
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  return {
    rows,
    byCategory: PAY_CATEGORIES.map((c) => ({
      key: c.key, label: c.label,
      people: rows.filter((r) => r.category === c.key).reduce((a, r) => a + r.people, 0),
      scales: rows.filter((r) => r.category === c.key).length,
    })),
    totals: {
      // The "no scale recorded" row is people payroll holds no classification for, not a scale awaiting
      // a rule: counting it as one would leave an unmapped scale permanently flagged on a tenant where
      // every scale maps, and hide the arrival of a real one. It is no_scale_people, and only that.
      scales: rows.filter((r) => r.recorded).length,
      people: sum((r) => r.people), permanent: sum((r) => r.permanent), casual: sum((r) => r.casual),
      unmapped_scales: rows.filter((r) => r.recorded && !r.matched).length,
      unmapped_people: rows.filter((r) => r.recorded && !r.matched).reduce((a, r) => a + r.people, 0),
      no_scale_people: rows.filter((r) => !r.recorded).reduce((a, r) => a + r.people, 0),
      stale: rows.filter((r) => r.stale).length,
    },
  };
}

// Removed 16 September 2026: talentTurnoverSources(), which reported the HR spreadsheet figure and the
// payroll figure side by side so neither silently stood in for the other. The owner now ENTERS turnover
// (pcTurnoverReport above), so there is one figure and nothing left to compare. Payroll's leaver COUNTS
// and its breakdown by ATO cessation code stay — they answer why people left, which no entered number does.


// ===== Centre manager screen =====
// An operational aid, not a report: what the week looks like, where the room is, and what is worth doing
// about it. Everything here is drawn from observed data or from bookings, and anything that would need a
// figure OWNA does not hold (a room's real capacity, its ratio, its age band) reports itself as not
// configured instead of guessing. See db/schema.sql on the rooms table for why that matters.
//
// Two rules this file exists to keep:
//   1. NON-OPERATING DAYS ARE NOT DAYS. OWNA keeps full booking rows on gazetted public holidays — 57
//      children "booked" at Austral on Labour Day — with attended = 0 and absent = booked, because the
//      centre is shut. Counting them anywhere produces nonsense in both directions: a show-rate that
//      says nobody turns up on Mondays, and a seat grid offering 67 free places at a closed centre.
//   2. OBSERVED AND FORECAST ARE NEVER MIXED IN ONE NUMBER. A day that has happened reports what was
//      measured; a day that has not reports an estimate, labelled as one.

// Monday of the week a date falls in. Weeks run Mon–Fri because no centre has a weekend booking row.
// Returns null for anything that is not a real calendar date — "2026-13-45" matches the route's shape
// check but is not a day, and letting it through reaches toISOString() and throws a 500.
function mondayOf(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ""))) return null;
  const t = new Date(d + "T00:00:00Z");
  if (Number.isNaN(t.getTime())) return null;
  // Date rolls 2026-02-30 forward to 2 March rather than rejecting it. Round-tripping catches that, so
  // an impossible date is refused instead of quietly showing a different week than the URL asked for.
  if (t.toISOString().slice(0, 10) !== d) return null;
  const back = (t.getUTCDay() + 6) % 7;           // Sun=0 -> 6, Mon=1 -> 0
  return cal.addDays(d, -back);
}

// The rooms OWNA has configured for a centre. `configured` is the honest test for whether anything may be
// drawn per room: a row with no capacity tells you the room exists and nothing more.
function roomsFor(ownaId) {
  const rows = db.prepare(`
    SELECT room_id, name, capacity, ratio, age_min, age_max, seen_at
    FROM rooms WHERE owna_id = ? ORDER BY name
  `).all(ownaId);
  return rows.map((r) => ({
    ...r,
    configured: Number.isFinite(Number(r.capacity)) && Number(r.capacity) > 0,
    hasRatio: r.ratio != null,
    hasAgeBand: r.age_min != null && r.age_max != null,
  }));
}

// Observed show-rate by weekday, over the last `weeks` observed weeks. This is what turns a booking into
// an expected head count — and it is a FORECAST, which is why it is returned separately from anything
// measured rather than blended into one number the page could mistake for an actual.
//
// Operating days ONLY. A single public holiday in the window is enough to wreck the weekday it lands on:
// measured at 15 May 2026, with Good Friday and Easter Monday inside the trailing eight weeks, Austral's
// Monday rate reads 76.5% including them against 82.3% on operating days. That understates the expected
// head count, which overstates the empty seats, which is precisely the number a director acts on.
function showRateByDow(ownaId, weeks = 8) {
  const to = lastActualDate();
  // BETWEEN is inclusive at both ends, so -(weeks * 7) spans weeks*7 + 1 days and gives one weekday a
  // ninth occurrence — a lopsided sample that quietly weights whichever weekday the window opens on.
  const from = cal.addDays(to, -(weeks * 7) + 1);
  const opDays = JSON.stringify(cal.operatingDayList(from, to));
  const rows = db.prepare(`
    SELECT CAST(strftime('%w', metric_date) AS INTEGER) AS dow,
           COALESCE(SUM(booked),0) AS booked, COALESCE(SUM(attended),0) AS attended,
           COUNT(*) AS days
    FROM daily_metrics
    WHERE owna_id = ? AND metric_date BETWEEN ? AND ?
      AND metric_date IN (SELECT value FROM json_each(?))
    GROUP BY dow
  `).all(ownaId, from, to, opDays);
  const out = {};
  for (const r of rows) out[r.dow] = { rate: r.booked > 0 ? r.attended / r.booked : null, days: r.days, booked: r.booked };
  return { from, to, byDow: out };
}

// One week of a centre, day by day: what is booked against the licensed places, what was actually observed
// where the day has happened, and what is merely expected where it has not.
//
// `available` is places − booked and is routinely NEGATIVE here: three of four centres are oversubscribed
// on bookings, which is normal (a booking holds a place whether the child turns up or not). The page must
// say "oversubscribed", never print "−13 available".
function managerWeek(ownaId, weekStart) {
  const places = placesOf(ownaId);
  const monday = mondayOf(weekStart) || mondayOf(todayStr());
  const friday = cal.addDays(monday, 4);
  const observedTo = lastActualDate();
  const { byDow } = showRateByDow(ownaId);
  const rows = db.prepare(`
    SELECT metric_date, booked, attended, absent, casual
    FROM daily_metrics WHERE owna_id = ? AND metric_date BETWEEN ? AND ? ORDER BY metric_date
  `).all(ownaId, monday, friday);
  const byDate = new Map(rows.map((r) => [r.metric_date, r]));

  const days = [];
  for (let i = 0; i < 5; i++) {
    const date = cal.addDays(monday, i);
    const r = byDate.get(date) || null;
    const operating = cal.isOperatingDay(date);
    const observed = date <= observedTo;
    const booked = r ? r.booked : null;
    const dow = (new Date(date + "T00:00:00Z")).getUTCDay();
    const sr = byDow[dow] ? byDow[dow].rate : null;
    // Forecast head count, for an operating day that has not happened. Not computed for a closed day:
    // OWNA's booking rows survive the closure and multiplying them by a show-rate invents a head count
    // for a centre nobody attended.
    const expected = (!observed && operating && r && sr != null) ? Math.round(r.booked * sr) : null;
    // The head count the day will run at: measured where it can be, estimated where it cannot, null when
    // neither is knowable. Everything the seat grid draws derives from this one number.
    const head = !operating ? null : (observed ? (r ? r.attended : null) : expected);
    days.push({
      date, dow,
      label: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow],
      operating,                              // a gazetted public holiday still carries booking rows in OWNA
      holiday: !operating,
      observed,
      isToday: date === todayStr(),
      places,
      booked,
      attended: observed && r ? r.attended : null,
      absent: observed && r ? r.absent : null,
      casual: r ? r.casual : null,
      expected,
      head,
      headBasis: head == null ? null : (observed ? "measured" : "estimated"),
      showRate: sr == null ? null : Math.round(sr * 1000) / 10,
      // Seats that did, or will, sit empty — the free ones INCLUDED. places − head, so it is one quantity
      // rather than two that overlap. Null when the head count is unknown.
      emptySeats: (places != null && head != null) ? Math.max(0, places - head) : null,
      available: (places != null && r && operating) ? places - r.booked : null,
      // null, not 0% — a day the sync holds no row for is unknown, and 0% reads as an empty centre.
      occupancy: (operating && r) ? pctOrNull(r.booked, places) : null,
    });
  }
  const open = days.filter((d) => d.operating && d.booked != null);
  const opDays = days.filter((d) => d.operating);
  return {
    monday, friday, places,
    observedTo,                                  // the feed's boundary, group-wide
    // The last day OF THIS WEEK that was observed — what the attendance tile should name. Naming the
    // group-wide boundary instead told a director reading August that the figure ran "to 10 Sep".
    weekObservedTo: open.filter((d) => d.observed).map((d) => d.date).pop() || null,
    isPast: friday < todayStr(),
    isFuture: monday > todayStr(),
    days,
    hasData: open.length > 0,
    bookedTotal: open.reduce((s, d) => s + d.booked, 0),
    placeDays: places != null ? places * opDays.length : null,
    availableTotal: places != null && open.length ? open.reduce((s, d) => s + (places - d.booked), 0) : null,
    missingDays: opDays.filter((d) => d.booked == null).map((d) => d.date),
    closedDays: days.filter((d) => !d.operating).map((d) => d.date),
  };
}

// The prioritised list a centre manager opens the screen for. Every item is derived from something the
// database actually observed; there is no placeholder and nothing is invented to fill the panel. When
// there is genuinely nothing to act on the list is empty, and the page says so rather than padding it.
function managerActions(ownaId, week) {
  const w = week || managerWeek(ownaId);
  const out = [];
  const lag = actualsLagDays();
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
  const open = w.days.filter((d) => d.operating && d.booked != null);
  // A week that has already ended gets described, not prescribed: telling a director to fill Tuesday is
  // nonsense when Tuesday was three weeks ago.
  const past = w.isPast;
  const was = (present, pastTense) => (past ? pastTense : present);

  // 1. The feed itself. A manager acting on week-old numbers is the worst failure mode here, so it leads.
  if (lag >= 2) {
    out.push({
      kind: "feed", tone: "warn", title: `Every figure here is ${lag} days old`,
      detail: `The last successful OWNA sync was ${w.observedTo}. Bookings AND attendance are as at that ` +
        "date — a booking taken since then does not appear on this page.",
      impact: null,
    });
  }

  // 2. Nothing to say at all. Better stated than left to be inferred from an empty panel.
  if (!open.length) {
    // Three different reasons the week is empty, and they are not interchangeable.
    const anyOperating = w.days.some((d) => d.operating);
    out.push({
      kind: "nodata", tone: "info",
      title: anyOperating ? "No booking data for this week" : "The centre is closed all week",
      detail: !anyOperating
        ? "Every weekday is a gazetted public holiday, so there are no places to fill."
        : w.isFuture
        ? "This week is past the end of the booking data OWNA has returned, so nothing is known about it — not that it is empty."
        : "The sync holds no rows for the operating days of this week. This is not the same as a week with no children booked.",
      impact: null,
    });
    return out;
  }
  if (w.places == null) {
    out.push({
      kind: "places", tone: "warn", title: "No approved places recorded for this centre",
      detail: "Without the licensed count there is no denominator, so occupancy, free places and empty " +
        "seats cannot be worked out at all. Record it at /admin/places.",
      impact: null,
    });
  }

  // 3. Places genuinely free on the licence — the only ones that can be sold without a judgement call.
  const free = open.filter((d) => d.available != null && d.available > 0);
  if (free.length) {
    const total = free.reduce((s, d) => s + d.available, 0);
    const best = free.reduce((a, b) => (b.available > a.available ? b : a));
    out.push({
      kind: "fill", tone: past ? "info" : "good",
      title: `${plural(total, "place-day")} ${was("free this week", "went unbooked")}`,
      detail: `Across ${plural(free.length, "day")}. ${best.label} ${was("has", "had")} the most room, with ` +
        `${plural(best.available, "place")} against ${best.places} approved.`,
      impact: `${total} place-days`,
    });
  }

  // 4. Days booked past the licence. Legitimate — a booking holds a place whether the child attends or not
  //    — but it is the cue to check the roster covers the BOOKED number rather than the expected one.
  const over = open.filter((d) => d.available != null && d.available < 0);
  if (over.length) {
    const worst = over.reduce((a, b) => (b.available < a.available ? b : a));
    out.push({
      kind: "over", tone: past ? "info" : "warn",
      title: `${plural(over.length, "day")} booked above approved places`,
      detail: `${over.map((d) => d.label).join(", ")}. ${worst.label} ${was("is", "was")} the tightest at ` +
        `${worst.booked} booked against ${worst.places}.` + (past ? "" : " Check the roster covers the booked number."),
      impact: `${Math.abs(worst.available)} over on ${worst.label}`,
    });
  }

  // 5. Seats that sat, or will sit, empty — the reason this screen exists. A day can be oversubscribed on
  //    BOOKINGS and still run well under its licence, because roughly one child in ten does not attend.
  //    For a week that has happened this is a MEASUREMENT; for one that has not it is an estimate, and the
  //    two are never added together.
  const withHead = open.filter((d) => d.emptySeats != null);
  if (withHead.length) {
    const total = withHead.reduce((s, d) => s + d.emptySeats, 0);
    const best = withHead.reduce((a, b) => (b.emptySeats > a.emptySeats ? b : a));
    const estimated = withHead.some((d) => d.headBasis === "estimated");
    const measured = withHead.some((d) => d.headBasis === "measured");
    // ANY estimated day makes the total an estimate. A week half observed and half forecast used to be
    // announced as "45 seats sat empty" with no tilde, because one measured day was enough to clear the
    // forecast flag — stating a part-modelled number as a measurement.
    const approx = estimated;
    const mixed = estimated && measured;
    if (total >= 3) {
      out.push({
        kind: "opportunity", tone: "good", forecast: approx,
        title: approx
          ? `About ${plural(total, "seat")} ${mixed ? "empty this week" : "likely to sit empty this week"}`
          : `${plural(total, "seat")} ${was("are sitting empty", "sat empty")}`,
        detail: (mixed
          ? `Part measured, part forecast: ${withHead.filter((d) => d.headBasis === "measured").length} of ` +
            `${withHead.length} days have been observed, the rest are estimated from the last 8 observed weeks. `
          : approx
          ? `Estimated from the last 8 observed weeks, operating days only. ${best.label} is the largest gap: ` +
            `${best.booked} booked, but this weekday runs at ${best.showRate}% attendance so around ${best.head} are expected. `
          : `${best.label} was the widest: ${best.booked} booked and ${best.head} attended. `) +
          `This is the total gap between the licence and the head count, so it includes any place with no ` +
          `booking at all. ` + (past ? "" : "Confirm room, ratio and roster before offering any of it as a casual place."),
        impact: `${approx ? "~" : ""}${total} seats`,
      });
    }
  }

  // 6. Absence already observed: places that were paid for and sat empty. The evidence behind (5).
  const gap = open.filter((d) => d.observed && d.absent > 0).sort((a, b) => b.absent - a.absent);
  if (gap.length) {
    const d = gap[0];
    out.push({
      kind: "absence", tone: "info",
      title: `${plural(gap.reduce((s, x) => s + x.absent, 0), "booked child", "booked children")} did not attend`,
      detail: `${d.label} was the highest, with ${d.attended} of ${d.booked} attending.` +
        (past ? "" : " A confirmed absence can be offered as a casual place."),
      impact: null,
    });
  }

  // 7. The roll ahead. Always measured from today, never from the displayed week — a director looking back
  //    at August still needs to know who is leaving now, and the label says "from today" so it cannot be
  //    read as belonging to the week on screen.
  const today = todayStr();
  const leaving = db.prepare(`
    SELECT COUNT(*) AS n FROM child_exits
    WHERE owna_id = ? AND upcoming = 1 AND finish_date > ? AND finish_date <= ?
  `).get(ownaId, today, cal.addDays(today, 90));
  if (leaving && leaving.n > 0) {
    out.push({
      kind: "leaving", tone: "info", title: `${plural(leaving.n, "child", "children")} finish within 90 days of today`,
      detail: "Each is a place to re-book. Check the waitlist for a match on their days.",
      impact: `${leaving.n} places`,
    });
  }

  // 8. What cannot be shown per room, stated plainly rather than drawn wrong.
  const rooms = roomsFor(ownaId);
  if (!rooms.length) {
    out.push({
      kind: "rooms", tone: "info", title: "Room-level detail is not available yet",
      detail: "OWNA's room list has not been captured. It arrives with the next successful overnight sync.",
      impact: null,
    });
  } else {
    const unconfigured = rooms.filter((r) => !r.configured);
    if (unconfigured.length) {
      out.push({
        kind: "rooms", tone: "warn",
        title: `${unconfigured.length} of ${rooms.length} rooms have no capacity recorded`,
        detail: `${unconfigured.map((r) => r.name || r.room_id).join(", ")}. Per-room places cannot be shown ` +
          "for these until the capacity is set in OWNA.",
        impact: null,
      });
    }
  }

  const order = { warn: 0, good: 1, info: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

module.exports = {
  defaultRange, forwardRange, centres, overview, totals,
  lastActualDate, actualsLagDays,
  roomsFor, showRateByDow, managerWeek, managerActions, mondayOf,
  centreDowOccupancy, centreLabourLatest, occupancyCalculator, centreInsights,
  rosterWeeks, rosterForWeek, rosterCentre, latestReconciledRosterWeek,
  centre, centreDaily, centreCcs, ccsTotal, round, pct,
  placesFor, placesOf, placesAdminRows, parseApprovedPlaces, saveApprovedPlaces, MAX_APPROVED_PLACES, ACECQA_SERVICE_URL,
  occupancyTargets, targetFor, blendedTarget, ehCentreMap, ehCentreFor, parseOccupancyTarget, saveOccupancyTarget,
  GROUP_TARGET_PCT, MAX_TARGET_PCT,
  llPipeline, llLatestDate, llForCentre, llByOwnaCentre, todayStr, pipelineTrend, pipelineCentres, waitlistJoins,
  exitsSummary, exitReasons, centreExits, exitsLatestDate, exitsByMonth, exitsByYear, upcomingExitsByMonth, tenureByCentre, churnByRoom,
  forwardOccupancyByCentre, projection, centrePipelineDetail,
  occupancyTrend, occupancyTrendGroup, occupancyTrendGroupFwd,
  labourWeeks, labourForWeek, labourTrend, wagesTrend, compareTrend, COMPARE_METRICS, labourBudgets, saveLabourBudget,
  pcTargets, savePcTarget, savePcMetric, pcMonths, pcForMonth, pcGroupLatest, pcTrend, pcAllSeries, PC_TARGET_KEYS,
  pcTurnoverCentres, pcTurnoverMonths, pcTurnoverLatestMonth, pcTurnoverEntries, savePcTurnoverEntry,
  pcTurnoverReport, pcTurnoverSeries, PC_TURNOVER_WINDOW,
  qcSummary, qcCentre, qcTerms, qcTrend,
  AP_AREAS, actionPlanAuto, actionPlanMonths, actionPlanGet, saveActionPlan, replaceActionItems, incidentsMonth, incidentsReport,
  yearStart, yearRange, seatsFilled, utilisationYtd, reg12Last12Months, wagesPerChildDay, ownaWeek,
  funnelByCentre, funnelMonths, CONVERSION_STAGES, pipelineTargets, savePipelineTarget, deletePipelineTarget, pipelineTargetProgress, targetRag, placesByMonth,
  coeOutlook, coeMeasured, coeRunWeek, coeMonthKeys, COE_TARGET_PCT, COE_FIRM_STATUSES,
  talentReport, talentLatestMonth, talentTurnoverPct, talentPayScales,
  TALENT_WINDOW, PAY_CATEGORIES,
};
