// Tools the "Ask your data" assistant may call. Claude chooses the tool and the arguments;
// THIS file validates those arguments and runs parameterised SQL. The model never writes SQL,
// so there is no injection surface, and every tool honours centre scoping.
//
// Privacy: waitlist/pipeline tools return COUNTS AND BREAKDOWNS ONLY — no child or family names
// ever leave the database.
const db = require("../db/db");
const m = require("./metrics");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 400;
const DOW = ["su", "mo", "tu", "we", "th", "fr", "sa"];

const short = (n) => (n || "").replace(/Futuro Childcare (and|&) Education\s*-?\s*/i, "").replace(/^Futuro\s+/, "").trim();
const utc = (d) => new Date(d + "T00:00:00Z");
const ymd = (dt) => dt.toISOString().slice(0, 10);
const addDays = (d, n) => { const t = utc(d); t.setUTCDate(t.getUTCDate() + n); return ymd(t); };
// Monday of the week containing d (UTC-safe).
const mondayOf = (d) => { const t = utc(d); const dow = t.getUTCDay(); t.setUTCDate(t.getUTCDate() - ((dow + 6) % 7)); return ymd(t); };

function bad(msg) { return { error: msg }; }

// Resolve a centre name the model supplied to a real centre, enforcing scope.
function resolveCentre(name, scopedOwnaId) {
  const centres = db.prepare("SELECT owna_id, name, capacity, opening FROM centres WHERE capacity > 0 OR opening = 1").all();
  if (scopedOwnaId) {
    const mine = centres.find((c) => c.owna_id === scopedOwnaId);
    if (!mine) return { error: "Your account has no valid centre scope." };
    if (name) {
      const asked = centres.find((c) => short(c.name).toLowerCase().includes(String(name).toLowerCase().trim()));
      if (asked && asked.owna_id !== scopedOwnaId) return { error: "You can only see data for your own centre." };
    }
    return { one: mine };
  }
  if (!name) return { one: null }; // all centres
  const q = String(name).toLowerCase().trim();
  const hit = centres.find((c) => short(c.name).toLowerCase() === q)
    || centres.find((c) => short(c.name).toLowerCase().includes(q))
    || centres.find((c) => q.includes(short(c.name).toLowerCase()));
  if (!hit) return { error: `No centre matches "${name}". Known centres: ${centres.map((c) => short(c.name)).join(", ")}.` };
  return { one: hit };
}

function validRange(from, to) {
  if (!DATE_RE.test(from || "") || !DATE_RE.test(to || "")) return "Dates must be YYYY-MM-DD.";
  if (from > to) return "`from` must be on or before `to`.";
  if ((utc(to) - utc(from)) / 86400000 > MAX_SPAN_DAYS) return `Range too wide (max ${MAX_SPAN_DAYS} days).`;
  return null;
}

// ---------------------------------------------------------------- tools

// Booked occupancy for a period. Past = actual. Future = current recurring enrolments rolled
// forward, which OVER-states because departures (school transition, withdrawals) are not deducted.
function occupancyForPeriod({ centre, from, to, group_by }, scoped) {
  const err = validRange(from, to); if (err) return bad(err);
  const c = resolveCentre(centre, scoped); if (c.error) return bad(c.error);
  const today = m.todayStr();
  const params = [from, to];
  let where = "metric_date BETWEEN ? AND ?";
  if (c.one) { where += " AND owna_id = ?"; params.push(c.one.owna_id); }
  const rows = db.prepare(`SELECT owna_id, metric_date, capacity, booked, attended, casual, fee_total
    FROM daily_metrics WHERE ${where} ORDER BY metric_date`).all(...params);
  if (!rows.length) return { note: "No booking rows exist for that period — it is outside the data window.", from, to };

  const names = {}; db.prepare("SELECT owna_id, name FROM centres").all().forEach((r) => { names[r.owna_id] = short(r.name); });
  const grain = group_by === "day" ? "day" : group_by === "centre" ? "centre" : "week";
  const buckets = new Map();
  for (const r of rows) {
    const key = grain === "day" ? r.metric_date : grain === "week" ? mondayOf(r.metric_date) : "all";
    const k = (c.one ? "" : names[r.owna_id] + "|") + key;
    let b = buckets.get(k);
    if (!b) { b = { centre: names[r.owna_id] || r.owna_id, period: key, capacity_days: 0, booked: 0, attended: 0, casual: 0, revenue: 0, days: 0, future_days: 0 }; buckets.set(k, b); }
    b.capacity_days += r.capacity; b.booked += r.booked; b.attended += r.attended; b.casual += r.casual;
    b.revenue += r.fee_total || 0; b.days++; if (r.metric_date > today) b.future_days++;
  }
  const out = [...buckets.values()].map((b) => ({
    centre: c.one ? short(c.one.name) : b.centre,
    period: grain === "day" ? b.period : grain === "week" ? `week of ${b.period}` : `${from}..${to}`,
    occupancy_pct: b.capacity_days ? Math.round(b.booked / b.capacity_days * 1000) / 10 : null,
    booked_child_days: b.booked, capacity_child_days: b.capacity_days,
    casual_days: b.casual, revenue_aud: Math.round(b.revenue),
    basis: b.future_days === b.days ? "future — recurring enrolments rolled forward (OVER-states: departures not deducted)"
      : b.future_days ? "mixed actual + future" : "actual",
  }));
  return { from, to, grouped_by: grain, rows: out.slice(0, 120),
    caveat: "Future occupancy is current enrolments projected forward. It does NOT deduct children leaving (notably the Jan/Feb school-year transition), so treat it as a ceiling. Use projected_occupancy for pipeline-adjusted numbers, and waitlist/expected_starts for incoming demand." };
}

// Waitlist / pipeline demand — COUNTS ONLY, no names.
function waitlist({ centre, wanting_care_from, wanting_care_to, status }, scoped) {
  const c = resolveCentre(centre, scoped); if (c.error) return bad(c.error);
  const where = []; const params = [];
  if (c.one) { where.push("owna_id = ?"); params.push(c.one.owna_id); }
  if (wanting_care_from) { if (!DATE_RE.test(wanting_care_from)) return bad("wanting_care_from must be YYYY-MM-DD."); where.push("expected_start >= ?"); params.push(wanting_care_from); }
  if (wanting_care_to) { if (!DATE_RE.test(wanting_care_to)) return bad("wanting_care_to must be YYYY-MM-DD."); where.push("expected_start <= ?"); params.push(wanting_care_to); }
  if (status) { where.push("status_name = ?"); params.push(String(status)); }
  const sql = `SELECT owna_id, status_name, substr(expected_start,1,7) AS month, COUNT(*) n
    FROM ll_pipeline_members ${where.length ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY owna_id, status_name, month ORDER BY month, n DESC`;
  const rows = db.prepare(sql).all(...params);
  const names = {}; db.prepare("SELECT owna_id, name FROM centres").all().forEach((r) => { names[r.owna_id] = short(r.name); });
  let total = 0; const byStatus = {}; const byMonth = {}; const byCentre = {};
  rows.forEach((r) => {
    total += r.n;
    byStatus[r.status_name || "(none)"] = (byStatus[r.status_name || "(none)"] || 0) + r.n;
    if (r.month) byMonth[r.month] = (byMonth[r.month] || 0) + r.n;
    const cn = names[r.owna_id] || r.owna_id || "(unlinked)";
    byCentre[cn] = (byCentre[cn] || 0) + r.n;
  });
  return { filters: { centre: c.one ? short(c.one.name) : "all centres", wanting_care_from: wanting_care_from || null, wanting_care_to: wanting_care_to || null, status: status || "any" },
    total_families: total, by_status: byStatus, by_centre: byCentre, by_month_care_wanted: byMonth,
    status_meaning: "‘Waitlist’ = registered interest. ‘Pre-Offered’/‘Offer Accepted’ are much closer to converting. Counts are families/children, names withheld by policy." };
}

// Confirmed/expected starts, including which weekdays are wanted.
function expectedStarts({ centre, from, to }, scoped) {
  const err = validRange(from, to); if (err) return bad(err);
  const c = resolveCentre(centre, scoped); if (c.error) return bad(c.error);
  const where = ["expected_start BETWEEN ? AND ?"]; const params = [from, to];
  if (c.one) { where.push("owna_id = ?"); params.push(c.one.owna_id); }
  const rows = db.prepare(`SELECT owna_id, expected_start, days_csv FROM ll_pipeline_starts WHERE ${where.join(" AND ")}`).all(...params);
  const names = {}; db.prepare("SELECT owna_id, name FROM centres").all().forEach((r) => { names[r.owna_id] = short(r.name); });
  const byCentre = {}, byMonth = {}, dayDemand = { mo: 0, tu: 0, we: 0, th: 0, fr: 0 };
  let noDays = 0;
  rows.forEach((r) => {
    const cn = names[r.owna_id] || r.owna_id || "(unlinked)";
    byCentre[cn] = (byCentre[cn] || 0) + 1;
    const mo = (r.expected_start || "").slice(0, 7); if (mo) byMonth[mo] = (byMonth[mo] || 0) + 1;
    const ds = (r.days_csv || "").split(",").filter(Boolean);
    if (!ds.length) noDays++;
    ds.forEach((d) => { if (dayDemand[d] != null) dayDemand[d]++; });
  });
  return { filters: { centre: c.one ? short(c.one.name) : "all centres", from, to },
    total_expected_starts: rows.length, by_centre: byCentre, by_month: byMonth,
    weekday_demand: dayDemand, starts_with_no_days_recorded: noDays,
    note: "weekday_demand counts how many of these children want each weekday — use it to spot which days will fill first." };
}

// Pipeline-adjusted projection (reuses the existing /projection engine: future bookings + in-scope starts).
function projectedOccupancy({ scope, days }, scoped) {
  const d = Math.min(Math.max(parseInt(days, 10) || 90, 7), 365);
  let res;
  try { res = m.projection(scope || "likely", d); } catch (e) { return bad("Projection failed: " + e.message); }
  let rows = (res && res.rows) || res || [];
  if (scoped && Array.isArray(rows)) rows = rows.filter((r) => r.owna_id === scoped);
  const trimmed = (Array.isArray(rows) ? rows : []).map((r) => ({
    centre: short(r.name || ""), capacity: r.capacity,
    base_occupancy_pct: r.baseOcc != null ? r.baseOcc : r.base_occ, projected_occupancy_pct: r.projOcc != null ? r.projOcc : r.proj_occ,
    added_child_days: r.addedChildDays != null ? r.addedChildDays : r.added_child_days,
  }));
  return { horizon_days: d, scope: scope || "likely", rows: trimmed,
    note: "Projection = future bookings PLUS pipeline starts in scope (weighted by the weekdays each child wants). Departures are still not deducted." };
}

function tours({ centre, from, to }, scoped) {
  const err = validRange(from, to); if (err) return bad(err);
  const c = resolveCentre(centre, scoped); if (c.error) return bad(c.error);
  const where = ["tour_date BETWEEN ? AND ?"]; const params = [from, to];
  if (c.one) { where.push("owna_id = ?"); params.push(c.one.owna_id); }
  const rows = db.prepare(`SELECT owna_id, type_name, is_completed, is_cancelled FROM ll_tours WHERE ${where.join(" AND ")}`).all(...params);
  const names = {}; db.prepare("SELECT owna_id, name FROM centres").all().forEach((r) => { names[r.owna_id] = short(r.name); });
  const byCentre = {}; let completed = 0, cancelled = 0;
  rows.forEach((r) => { const cn = names[r.owna_id] || "(unlinked)"; byCentre[cn] = (byCentre[cn] || 0) + 1; if (r.is_completed) completed++; if (r.is_cancelled) cancelled++; });
  return { filters: { centre: c.one ? short(c.one.name) : "all centres", from, to }, total_tours: rows.length, completed, cancelled, by_centre: byCentre };
}

function currentState(_input, scoped) {
  return require("./ai-ask").gatherContext(scoped);
}

function centresList(_input, scoped) {
  const rows = db.prepare("SELECT owna_id, name, capacity, enrolled, opening FROM centres WHERE capacity > 0 OR opening = 1 ORDER BY name").all()
    .filter((r) => !scoped || r.owna_id === scoped)
    .map((r) => ({ centre: short(r.name), licensed_places: r.capacity, enrolled: r.enrolled, status: r.opening ? "pre-opening" : "operating" }));
  const dm = db.prepare("SELECT MIN(metric_date) mn, MAX(metric_date) mx FROM daily_metrics").get();
  return { today: m.todayStr(), centres: rows, booking_data_available: { earliest: dm.mn, latest: dm.mx } };
}

const TOOLS = {
  centres_list: { fn: centresList, spec: { name: "centres_list", description: "List the centres, their licensed places, and the date window for which booking data exists. Call this first if you need to know which centres exist or how far forward the data goes.", input_schema: { type: "object", properties: {}, additionalProperties: false } } },
  occupancy_for_period: { fn: occupancyForPeriod, spec: { name: "occupancy_for_period", description: "Booked occupancy for a date range. Past dates are actual; future dates are current recurring enrolments rolled forward (an over-estimate — departures are not deducted). Use for questions like 'what will occupancy be the week of 11 Jan'.", input_schema: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { centre: { type: "string", description: "Centre name e.g. 'Austral'. Omit for all centres." }, from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" }, group_by: { type: "string", enum: ["day", "week", "centre"], description: "day for a single week, week for longer ranges, centre for a single total per centre." } } } } },
  waitlist: { fn: waitlist, spec: { name: "waitlist", description: "Waitlist / enrolment-pipeline demand as COUNTS ONLY (no names). Filter by centre and by the period families want care to START. Use for 'how many are waiting for care in January at Austral'.", input_schema: { type: "object", additionalProperties: false, properties: { centre: { type: "string" }, wanting_care_from: { type: "string", description: "YYYY-MM-DD — earliest desired start" }, wanting_care_to: { type: "string", description: "YYYY-MM-DD — latest desired start" }, status: { type: "string", description: "Optional exact status: Waitlist, Pre-Offered, Offer Accepted, Tour Scheduled, Tour Completed, New Family, Engaged" } } } } },
  expected_starts: { fn: expectedStarts, spec: { name: "expected_starts", description: "Children with an expected START date in a range, including which weekdays each wants (weekday_demand). Use to say how much of a future week is already committed to arrive.", input_schema: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { centre: { type: "string" }, from: { type: "string" }, to: { type: "string" } } } } },
  projected_occupancy: { fn: projectedOccupancy, spec: { name: "projected_occupancy", description: "Pipeline-adjusted occupancy projection: future bookings plus expected starts weighted by the days each child wants.", input_schema: { type: "object", additionalProperties: false, properties: { scope: { type: "string", description: "'likely' (default) or a wider scope" }, days: { type: "integer", description: "Horizon in days, 7-365" } } } } },
  tours: { fn: tours, spec: { name: "tours", description: "Scheduled tours and orientation days in a date range, with completed/cancelled counts.", input_schema: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { centre: { type: "string" }, from: { type: "string" }, to: { type: "string" } } } } },
  current_state: { fn: currentState, spec: { name: "current_state", description: "Snapshot of how the group is performing right now: latest-week occupancy, attendance, revenue, wages %, margin, staff turnover and eNPS per centre. Use for 'how are we doing' questions.", input_schema: { type: "object", properties: {}, additionalProperties: false } } },
};

const TOOL_SPECS = Object.values(TOOLS).map((t) => t.spec);

function runTool(name, input, scopedOwnaId) {
  const t = TOOLS[name];
  if (!t) return { error: `Unknown tool "${name}".` };
  try { return t.fn(input || {}, scopedOwnaId || null); }
  catch (e) { return { error: "The requested data could not be retrieved." }; }
}

module.exports = { TOOL_SPECS, runTool, resolveCentre, addDays, mondayOf };
