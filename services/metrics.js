// Read-model queries over the snapshotted tables. All figures come from SQLite,
// so pages are fast and work even if OWNA is briefly unreachable.
const db = require("../db/db");

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

const todayStr = () => new Date().toISOString().slice(0, 10);

// Default range = the last 7 days up to today (history). Future data exists in the table
// but the default view is "to date"; forward presets expose the forecast.
function defaultRange() {
  const row = db.prepare(`SELECT MAX(metric_date) AS maxd FROM daily_metrics`).get();
  const today = todayStr();
  const maxd = (row && row.maxd) || today;
  const to = maxd < today ? maxd : today; // never default into the future
  const d = new Date(to);
  d.setDate(d.getDate() - 6);
  return { from: d.toISOString().slice(0, 10), to };
}

// A forward-looking range: today → today + n days (the booked/scheduled horizon).
function forwardRange(days = 30) {
  const today = todayStr();
  const d = new Date(today);
  d.setDate(d.getDate() + days);
  return { from: today, to: d.toISOString().slice(0, 10) };
}

function centres() {
  return db.prepare(`SELECT * FROM centres ORDER BY name`).all();
}

// One aggregated summary row per centre for a date range.
function overview(from, to) {
  const rows = db.prepare(`
    SELECT c.owna_id, c.name, c.alias, c.suburb, c.capacity, c.enrolled,
           COUNT(DISTINCT d.metric_date)      AS days,
           COALESCE(SUM(d.booked),0)          AS booked,
           COALESCE(SUM(d.attended),0)        AS attended,
           COALESCE(SUM(d.absent),0)          AS absent,
           COALESCE(SUM(d.casual),0)          AS casual,
           COALESCE(SUM(d.fee_total),0)       AS fee_total
    FROM centres c
    LEFT JOIN daily_metrics d
      ON d.owna_id = c.owna_id AND d.metric_date BETWEEN ? AND ?
    WHERE c.opening IS NULL OR c.opening = 0
    GROUP BY c.owna_id
    ORDER BY c.name
  `).all(from, to);

  return rows.map((r) => {
    const denom = r.capacity * r.days; // capacity-days available in the range
    return {
      ...r,
      fee_total: round(r.fee_total),
      occupancy: pct(r.booked, denom),          // booked child-days / capacity-days
      attendance_rate: pct(r.attended, r.booked),
      avg_daily_booked: r.days ? Math.round(r.booked / r.days) : 0,
    };
  });
}

function totals(rows) {
  const t = rows.reduce((a, r) => {
    a.capacity += r.capacity; a.enrolled += r.enrolled;
    a.booked += r.booked; a.attended += r.attended; a.absent += r.absent;
    a.casual += r.casual; a.fee_total += r.fee_total;
    a.capacity_days += r.capacity * r.days;
    a.days = Math.max(a.days, r.days);
    return a;
  }, { capacity: 0, enrolled: 0, booked: 0, attended: 0, absent: 0, casual: 0, fee_total: 0, capacity_days: 0, days: 0 });
  return {
    ...t,
    fee_total: round(t.fee_total),
    occupancy: pct(t.booked, t.capacity_days),
    attendance_rate: pct(t.attended, t.booked),
  };
}

function centre(ownaId) {
  return db.prepare(`SELECT * FROM centres WHERE owna_id = ?`).get(ownaId);
}

// Per-day series for one centre.
function centreDaily(ownaId, from, to) {
  const rows = db.prepare(`
    SELECT metric_date, capacity, booked, attended, absent, casual, fee_total
    FROM daily_metrics
    WHERE owna_id = ? AND metric_date BETWEEN ? AND ?
    ORDER BY metric_date
  `).all(ownaId, from, to);
  return rows.map((r) => ({
    ...r,
    fee_total: round(r.fee_total),
    occupancy: pct(r.booked, r.capacity),
    attendance_rate: pct(r.attended, r.booked),
  }));
}

// Monthly occupancy trend for one centre (past months only), most recent `months` back.
function occupancyTrend(ownaId, months = 18) {
  const today = todayStr();
  const rows = db.prepare(`
    SELECT substr(metric_date,1,7) AS month,
           COALESCE(SUM(booked),0) AS booked,
           COALESCE(SUM(attended),0) AS attended,
           COALESCE(SUM(fee_total),0) AS fee_total,
           MAX(capacity) AS capacity,
           COUNT(DISTINCT metric_date) AS days
    FROM daily_metrics
    WHERE owna_id = ? AND metric_date <= ?
    GROUP BY month ORDER BY month
  `).all(ownaId, today);
  return rows.map((r) => ({
    month: r.month,
    occupancy: pct(r.booked, r.capacity * r.days),
    attendance_rate: pct(r.attended, r.booked),
    fee_total: round(r.fee_total),
    days: r.days,
  })).slice(-months);
}

// Group monthly occupancy trend (all centres combined).
function occupancyTrendGroup(months = 18) {
  const today = todayStr();
  const rows = db.prepare(`
    SELECT substr(d.metric_date,1,7) AS month,
           COALESCE(SUM(d.booked),0) AS booked,
           COALESCE(SUM(d.attended),0) AS attended,
           COALESCE(SUM(d.fee_total),0) AS fee_total,
           SUM(d.capacity) AS cap_days
    FROM daily_metrics d
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
  const rows = db.prepare(`
    SELECT substr(metric_date,1,7) AS month,
           COALESCE(SUM(booked),0) AS booked, COALESCE(SUM(attended),0) AS attended,
           COALESCE(SUM(fee_total),0) AS fee, SUM(capacity) AS cap_days
    FROM daily_metrics GROUP BY month ORDER BY month`).all();
  const [y, mo] = now.split("-").map(Number);
  const lo = new Date(Date.UTC(y, mo - 1 - pastMonths, 1)).toISOString().slice(0, 7);
  const hi = new Date(Date.UTC(y, mo - 1 + fwdMonths, 1)).toISOString().slice(0, 7);
  return rows.filter((r) => r.month >= lo && r.month <= hi).map((r) => ({
    month: r.month,
    occupancy: pct(r.booked, r.cap_days),
    attendance_rate: r.month < now ? pct(r.attended, r.booked) : null, // attendance only known for past
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
  // Net growth (window) from ll_enrolments.
  const growth = db.prepare(`
    SELECT ll_id, SUM(start_date IS NOT NULL) AS started, SUM(withdrawn_date IS NOT NULL) AS withdrawn
    FROM ll_enrolments GROUP BY ll_id
  `).all();
  const gMap = new Map(growth.map((g) => [g.ll_id, g]));

  const rows = [...byCentre.values()].map((c) => {
    const g = gMap.get(c.ll_id) || { started: 0, withdrawn: 0 };
    return { ...c, started: g.started || 0, withdrawn: g.withdrawn || 0, net: (g.started || 0) - (g.withdrawn || 0) };
  }).sort((a, b) => (b.counts[4] || 0) - (a.counts[4] || 0)); // busiest waitlist first

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
  const end = new Date(today); end.setDate(end.getDate() + days);
  const to = end.toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT owna_id, capacity,
           COALESCE(SUM(booked),0) AS booked,
           COUNT(DISTINCT metric_date) AS days
    FROM daily_metrics
    WHERE metric_date > ? AND metric_date <= ?
    GROUP BY owna_id
  `).all(today, to);
  const map = {};
  rows.forEach((r) => {
    map[r.owna_id] = { occupancy: pct(r.booked, r.capacity * r.days), days: r.days, booked: r.booked };
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

  // Members (child-level) grouped by stage, most recent activity first.
  const memberRows = db.prepare(`
    SELECT child_id, child_name, family_name, status_id, status_name, wait_list_date, expected_start
    FROM ll_pipeline_members WHERE owna_id = ?
    ORDER BY COALESCE(wait_list_date, expected_start) DESC
  `).all(ownaId);
  const membersByStage = {};
  FUNNEL_STAGES.forEach(([id]) => { membersByStage[id] = []; });
  memberRows.forEach((m) => { (membersByStage[m.status_id] = membersByStage[m.status_id] || []).push(m); });

  // Upcoming tours (scheduled, not done/cancelled) + recent completed.
  const upcomingTours = db.prepare(`
    SELECT t.family_name, t.type_name, t.tour_date, t.result,
      (SELECT m.status_name FROM ll_pipeline_members m
        WHERE m.owna_id = t.owna_id AND m.family_name = t.family_name LIMIT 1) AS current_stage
    FROM ll_tours t
    WHERE t.owna_id = ? AND t.is_completed = 0 AND t.is_cancelled = 0 AND substr(t.tour_date,1,10) >= ?
    ORDER BY t.tour_date ASC
  `).all(ownaId, today);
  const recentTours = db.prepare(`
    SELECT family_name, type_name, tour_date, result FROM ll_tours
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
  const end = new Date(today); end.setDate(end.getDate() + days);
  const to = end.toISOString().slice(0, 10);

  const centres = db.prepare(`SELECT owna_id, name, capacity FROM centres WHERE ll_id IS NOT NULL AND capacity > 0`).all();

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
    const capDays = c.capacity * base.length;
    const weekly = [...weeks.values()].map((w) => ({
      week: w.week,
      base_occ: pct(w.baseBooked, c.capacity * w.days),
      proj_occ: pct(w.projBooked, c.capacity * w.days),
    }));
    return {
      owna_id: c.owna_id, name: c.name, capacity: c.capacity, days: base.length,
      pipeline_children: starts.length,
      base_occ: pct(baseBooked, capDays),
      proj_occ: pct(projBooked, capDays),
      added_child_days: addedChildDays,
      weekly,
    };
  });
  return { scope, scopeLabel: scopeDef.label, days, to, rows, scopes: PROJECTION_SCOPES };
}

// Monday (ISO week start) for a YYYY-MM-DD date, as YYYY-MM-DD.
function weekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}

// ===== Exit report read-model =====

const REASON_LABEL_NONE = "Not recorded";

// Per-centre exit summary (past vs scheduled + top recorded reason).
function exitsSummary() {
  const rows = db.prepare(`
    SELECT c.owna_id, c.name,
      SUM(e.upcoming = 0) AS past,
      SUM(e.upcoming = 1) AS upcoming,
      SUM(e.upcoming = 0 AND e.reason IS NOT NULL AND e.reason <> 'Unknown') AS reason_known,
      AVG(CASE WHEN e.upcoming = 0 AND e.tenure_days > 0 THEN e.tenure_days END) AS avg_tenure
    FROM centres c LEFT JOIN child_exits e ON e.owna_id = c.owna_id
    GROUP BY c.owna_id ORDER BY past DESC
  `).all();
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
function centreExits(ownaId, scope = "past", limit = 200) {
  const cond = scope === "past" ? "AND upcoming = 0" : scope === "upcoming" ? "AND upcoming = 1" : "";
  return db.prepare(`
    SELECT child_name, room, start_date, finish_date, tenure_days, upcoming, reason, reason_source
    FROM child_exits WHERE owna_id = ? ${cond}
    ORDER BY finish_date DESC LIMIT ?
  `).all(ownaId, limit);
}

function exitsLatestDate() {
  const r = db.prepare(`SELECT MAX(updated_at) d FROM child_exits`).get();
  return r && r.d;
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
    if (pr && pr.turnover != null) out.team = { rating: rag(pr.turnover, t.turnover || 15, (t.turnover || 15) + 5, true), reason: `Turnover ${pr.turnover}%` };
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
  const nowMonth = new Date().toISOString().slice(0, 7);
  if (preferComplete) {
    const r = db.prepare("SELECT * FROM incidents_monthly WHERE owna_id=? AND month<? ORDER BY month DESC LIMIT 1").get(ownaId, nowMonth);
    if (r) return r;
  }
  return db.prepare("SELECT * FROM incidents_monthly WHERE owna_id=? ORDER BY month DESC LIMIT 1").get(ownaId) || null;
}

// Rolling incident report: per-centre month-by-month grid + last-complete-month headline.
function incidentsReport(scopedOwnaId, monthsBack = 12, headlineMonth = null) {
  let months = db.prepare("SELECT DISTINCT month FROM incidents_monthly ORDER BY month DESC LIMIT ?").all(monthsBack).map((r) => r.month);
  months.reverse(); // chronological (oldest → newest)
  const nowMonth = new Date().toISOString().slice(0, 7);
  if (!months.length) return { months: [], rows: [], totals: [], lastComplete: null, selectedMonth: null, currentMonth: nowMonth, headline: null };
  const lastComplete = months.filter((mo) => mo < nowMonth).slice(-1)[0] || months[months.length - 1];
  // Headline reflects the chosen month (default: last complete month; the current month is partial).
  const selectedMonth = (headlineMonth && months.includes(headlineMonth)) ? headlineMonth : lastComplete;

  let centreRows = db.prepare(`SELECT DISTINCT c.owna_id, c.name FROM incidents_monthly i JOIN centres c ON c.owna_id = i.owna_id ORDER BY c.name`).all();
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
    return { owna_id: c.owna_id, name: c.name.replace("Futuro Childcare & Education - ", ""), cells, headline: hc };
  });
  const totals = months.map((mo) => {
    const t = { month: mo, total: 0, injuries: 0, illness: 0, serious: 0, reportable: 0 };
    rows.forEach((r) => { const cell = r.cells.find((x) => x.month === mo); ["total","injuries","illness","serious","reportable"].forEach((k) => t[k] += cell[k]); });
    return t;
  });
  const headline = { ...(totals.find((t) => t.month === selectedMonth) || { total: 0, injuries: 0, illness: 0, serious: 0, reportable: 0 }), rating: rateOf((totals.find((t) => t.month === selectedMonth) || {}).reportable || 0) };
  return { months, rows, totals, lastComplete, selectedMonth, currentMonth: nowMonth, headline };
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
    const ins = db.prepare("INSERT INTO action_plan_items (owna_id, month, category, focus_area, actions, owner, status, sort) VALUES (?,?,?,?,?,?,?,?)");
    items.forEach((it, i) => { if ((it.focus_area || it.actions || "").trim()) ins.run(ownaId, month, it.category, it.focus_area, it.actions, it.owner, it.status, i); });
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

// ===== Employment Hero labour + margin =====

// Weeks available (most recent first).
function labourWeeks(limit = 16) {
  return db.prepare(`SELECT week_ending FROM labour_weekly GROUP BY week_ending HAVING COUNT(*) >= 4 ORDER BY week_ending DESC LIMIT ?`).all(limit).map((r) => r.week_ending);
}

// OWNA revenue + occupancy for the Mon..weekEnding week of a centre.
function ownaWeek(ownaId, weekEnding) {
  if (!ownaId) return { revenue: 0, occupancy: null };
  const start = new Date(weekEnding + "T00:00:00"); start.setDate(start.getDate() - 6);
  const from = start.toISOString().slice(0, 10);
  const r = db.prepare(`
    SELECT COALESCE(SUM(fee_total),0) rev, COALESCE(SUM(booked),0) booked, MAX(capacity) cap, COUNT(DISTINCT metric_date) days
    FROM daily_metrics WHERE owna_id = ? AND metric_date BETWEEN ? AND ?
  `).get(ownaId, from, weekEnding);
  return { revenue: round(r.rev), occupancy: r.days ? pct(r.booked, r.cap * r.days) : null };
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
  });
  mapped.sort((a, b) => b.care_wages - a.care_wages);
  return mapped;
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
  const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT CAST(strftime('%w', metric_date) AS INTEGER) AS dow,
           COALESCE(SUM(booked),0) AS booked, COALESCE(SUM(casual),0) AS casual,
           MAX(capacity) AS cap, COUNT(DISTINCT metric_date) AS d
    FROM daily_metrics
    WHERE owna_id = ? AND metric_date BETWEEN ? AND ?
    GROUP BY dow`).all(ownaId, from, today);
  const byDow = {}; rows.forEach((r) => { byDow[r.dow] = r; });
  const out = [];
  for (let wd = 1; wd <= 5; wd++) {
    const r = byDow[wd];
    if (!r || !r.d) { out.push({ dow: DOW_NAMES[wd], occupancy: null, avg_booked: null, avg_casual: null, days: 0 }); continue; }
    out.push({ dow: DOW_NAMES[wd], occupancy: pct(r.booked, r.cap * r.d), avg_booked: Math.round(r.booked / r.d), avg_casual: Math.round(r.casual / r.d), days: r.d, capacity: r.cap });
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
const COMPARE_METRICS = {
  occupancy:  { cadence: "month", label: "Occupancy", suf: "%", better: "high" },
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
function compareTrend(metric = "occupancy", n) {
  const cfg = COMPARE_METRICS[metric] || COMPARE_METRICS.occupancy;
  const centres = db.prepare("SELECT owna_id, name FROM centres WHERE (opening IS NULL OR opening = 0) AND capacity > 0 ORDER BY name").all();
  if (cfg.cadence === "week") {
    const weeks = labourWeeks(n || 16).slice().reverse();
    const series = centres.map((ct) => {
      const map = {}; wagesTrend(ct.owna_id, n || 16).forEach((r) => { map[r.week] = r[metric]; });
      return { owna_id: ct.owna_id, name: ct.name.replace("Futuro Childcare & Education - ", ""), points: weeks.map((w) => (map[w] == null ? null : map[w])) };
    });
    return { axis: weeks, cadence: "week", series, cfg, metric };
  }
  // Occupancy extends forward (projected from scheduled bookings, drawn dashed); manual P&C metrics are past-only.
  const isOcc = metric === "occupancy";
  const now = todayStr().slice(0, 7); const [yy, mm] = now.split("-").map(Number);
  const pastN = n || 12, fwdN = isOcc ? 2 : 0;
  const axis = [];
  for (let i = pastN; i >= -fwdN; i--) axis.push(new Date(Date.UTC(yy, mm - 1 - i, 1)).toISOString().slice(0, 7));
  let dashFrom = null;
  if (isOcc) { const fi = axis.findIndex((mo2) => mo2 >= now); dashFrom = fi > 0 ? fi - 1 : (fi === 0 ? 0 : null); }
  const series = centres.map((ct) => {
    const map = {};
    if (isOcc) {
      db.prepare("SELECT substr(metric_date,1,7) month, COALESCE(SUM(booked),0) booked, MAX(capacity) cap, COUNT(DISTINCT metric_date) days FROM daily_metrics WHERE owna_id=? GROUP BY month")
        .all(ct.owna_id).forEach((r) => { map[r.month] = pct(r.booked, r.cap * r.days); });
    } else { const pt = pcTrend(ct.owna_id, 24); pt.axis.forEach((mo2, i) => { map[mo2] = pt.series[metric] ? pt.series[metric][i] : null; }); }
    return { owna_id: ct.owna_id, name: ct.name.replace("Futuro Childcare & Education - ", ""), points: axis.map((mo2) => (map[mo2] == null ? null : map[mo2])) };
  });
  return { axis, cadence: "month", series, cfg, metric, dashFrom };
}

// How many new bookings of each day-pattern lift weekly occupancy by each target (pp).
function occupancyCalculator(capacity, occupancyNow, targets = [5, 10]) {
  const patterns = [2, 3, 4, 5];
  const free = occupancyNow != null ? Math.max(0, Math.round(capacity * (1 - occupancyNow / 100))) : null;
  return targets.map((delta) => ({
    delta,
    target_occ: occupancyNow != null ? Math.round((occupancyNow + delta) * 10) / 10 : null,
    reachable: occupancyNow == null || occupancyNow + delta <= 100,
    perPattern: patterns.map((d) => {
      const extraChildDays = delta / 100 * capacity * 5; // extra booked child-days/week for +delta pp
      return { days: d, count: Math.ceil(extraChildDays / d) };
    }),
    free,
  }));
}

// Rule-based, data-driven improvement tips for a centre. Each rule only fires when the data warrants it.
function centreInsights(ownaId, capacity, occupancyNow, pipeline, labour) {
  const dow = centreDowOccupancy(ownaId);
  const valid = dow.filter((d) => d.occupancy != null);
  const tips = [];
  const today = todayStr();
  const money = (n) => "$" + Math.round(n).toLocaleString("en-AU");
  const ago = (days) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const ahead = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

  // Recent 28-day actuals (past only): occupancy, attendance, avg daily fee, absences.
  const recent = db.prepare(`
    SELECT COALESCE(SUM(booked),0) booked, COALESCE(SUM(attended),0) attended, COALESCE(SUM(absent),0) absent,
           COALESCE(SUM(fee_total),0) fee, MAX(capacity) cap, COUNT(DISTINCT metric_date) d
    FROM daily_metrics WHERE owna_id=? AND metric_date BETWEEN ? AND ?`).get(ownaId, ago(28), today);
  const avgDailyFee = recent.booked ? recent.fee / recent.booked : null; // $ per child-day
  const recentOcc = (recent.cap && recent.d) ? pct(recent.booked, recent.cap * recent.d) : occupancyNow;

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
    const free = capacity && recentOcc != null ? Math.round(capacity * (1 - recentOcc / 100)) : null;
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
    SELECT COALESCE(SUM(booked),0) booked, MAX(capacity) cap, COUNT(DISTINCT metric_date) d
    FROM daily_metrics WHERE owna_id=? AND metric_date > ? AND metric_date <= ?`).get(ownaId, today, ahead(28));
  if (fwd.d >= 5 && fwd.cap && recentOcc != null) {
    const fwdOcc = pct(fwd.booked, fwd.cap * fwd.d);
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

  const calc = capacity ? occupancyCalculator(capacity, occupancyNow) : [];
  return { dow, tips, calc, occupancyNow, capacity };
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

module.exports = {
  defaultRange, forwardRange, centres, overview, totals,
  centreDowOccupancy, centreLabourLatest, occupancyCalculator, centreInsights,
  rosterWeeks, rosterForWeek, rosterCentre, latestReconciledRosterWeek,
  centre, centreDaily, centreCcs, ccsTotal, round, pct,
  llPipeline, llLatestDate, llForCentre, llByOwnaCentre, todayStr, pipelineTrend, pipelineCentres, waitlistJoins,
  exitsSummary, exitReasons, centreExits, exitsLatestDate,
  forwardOccupancyByCentre, projection, centrePipelineDetail,
  occupancyTrend, occupancyTrendGroup, occupancyTrendGroupFwd,
  labourWeeks, labourForWeek, labourTrend, wagesTrend, compareTrend, COMPARE_METRICS, labourBudgets, saveLabourBudget,
  pcTargets, savePcTarget, savePcMetric, pcMonths, pcForMonth, pcGroupLatest, pcTrend, pcAllSeries, PC_TARGET_KEYS,
  qcSummary, qcCentre, qcTerms, qcTrend,
  AP_AREAS, actionPlanAuto, actionPlanMonths, actionPlanGet, saveActionPlan, replaceActionItems, incidentsMonth, incidentsReport,
};
