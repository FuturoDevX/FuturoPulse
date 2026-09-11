// Pulls Employment Hero payroll into weekly per-centre labour rows (labour_weekly).
const db = require("../db/db");
const { eh } = require("./eh");

const WEEKS = parseInt(process.env.EH_LABOUR_WEEKS || "16", 10);
const d10 = (s) => (s ? String(s).slice(0, 10) : null);

// Map an EH centre name ("Futuro GWH") to an OWNA centre owna_id.
function ownaIdFor(ehCentre, centres) {
  const norm = (s) => (s || "").toLowerCase().replace(/futuro( early learning)?/g, "").replace(/[^a-z]/g, "");
  const alias = { gwh: "gledswoodhills", heathrd: "heathrd" };
  let key = norm(ehCentre); key = alias[key] || key;
  const c = centres.find((c) => { const n = norm(c.name); return n && key && (n.includes(key) || key.includes(n)); });
  return c ? c.owna_id : null;
}

// Bucket a KeyPay pay category. "matwc" = the "Other (Mat leave / WC)" column: pay that's
// neither hours worked nor ordinary paid leave taken (mat/parental, workers comp, and
// termination / unused-leave payouts). Time-in-lieu taken is treated as leave (time off).
function classify(payCategory) {
  const n = (payCategory || "").toLowerCase();
  if (n.includes("workers comp") || n.includes("maternity") || n.includes("parental")
      || n.includes("unused leave") || n.includes("termination")) return "matwc";
  if (n.includes("leave taken") || n.includes("leave loading") || n.includes("time in lieu")) return "leave";
  return "worked";
}

async function runLabourSnapshot({ weeks = WEEKS, log = console.log, dryRun = false } = {}) {
  if (!eh.hasCreds()) { log("[EH] no payroll credentials — skipping"); return { skipped: true, reason: "no Employment Hero credentials configured" }; }

  // 1) Employee map: id -> { isKitchen, isCasual }.
  const emps = await eh.allEmployees();
  const empMap = new Map();
  for (const e of emps) {
    // Detect support roles by JOB TITLE (reliable) — many kitchen/cleaning staff are
    // assigned to the centre, not a "… / Kitchen" sub-location, so location misses them.
    const jt = (e.jobTitle || ""); const loc = (e.primaryLocation || "");
    empMap.set(e.id, {
      isKitchen: /chef|kitchen|cook/i.test(jt) || /kitchen/i.test(loc),
      isCleaning: /clean/i.test(jt) || /clean/i.test(loc),
      isCasual: (e.employmentType || "") === "Casual",
    });
  }

  // Use each finalised run's own pay period, never its payment date.
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 260) throw new Error("Invalid wage history window.");
  const allRuns = await eh.payRuns();
  const runs = allRuns.filter(r => r.isFinalised === true);
  if (runs.some(r => !/^\d{4}-\d{2}-\d{2}$/.test(d10(r.payPeriodEnding) || ""))) throw new Error("Pay period missing; no wages saved.");
  const periods = [...new Set(runs.map(r => d10(r.payPeriodEnding)))].sort().reverse();
  const keepPeriods = new Set(periods.slice(0, weeks));
  const selected = runs.filter(r => keepPeriods.has(d10(r.payPeriodEnding)));
  if (!selected.length) return { ok: true, weeks: 0, rows: 0 };
  const rows = [], reconciliation = [];
  const locations = await eh.locations();
  for (const run of selected) {
    const [detail, totals] = await Promise.all([eh.earnings(run.id), eh.runTotals(run.id)]);
    const normalised = normaliseRun(run, detail, totals);
    rows.push(...normalised.rows.map(row => ({ ...row, sourceLocation: row.location, location: centreLocation(row.location_id, locations) })));
    reconciliation.push(normalised.reconciliation);
  }
  log(`[EH] ${selected.length} finalised runs reconciled across ${keepPeriods.size} periods`);

  // 4) Aggregate per (centre, week).
  const centres = db.prepare(`SELECT owna_id, name FROM centres`).all();
  const agg = new Map(); // key eh_centre|week
  const empSeen = new Map(); // key -> Set of employeeIds
  for (const r of rows) {
    const week = r.week_ending;
    if (!week || !keepPeriods.has(week)) continue;
    const centre = r.location || "(none)";
    const key = centre + "|" + week;
    let a = agg.get(key);
    if (!a) { a = { eh_centre: centre, week_ending: week, worked_h: 0, worked_amt: 0, kitchen_h: 0, kitchen_amt: 0, cleaning_h: 0, cleaning_amt: 0, leave_h: 0, leave_amt: 0, matwc_amt: 0, casual_h: 0, super_amt: 0 }; agg.set(key, a); empSeen.set(key, new Set()); }
    const em = empMap.get(r.employeeId) || {};
    const hrs = Number(r.units) || 0, amt = Number(r.amount) || 0, sup = Number(r.superAmount) || 0;
    let bucket = classify(r.payCategory);
    if (bucket === "worked" && (em.isKitchen || /kitchen|chef/i.test(r.sourceLocation || ""))) bucket = "kitchen";
    else if (bucket === "worked" && (em.isCleaning || /clean/i.test(r.sourceLocation || ""))) bucket = "cleaning";
    if (bucket === "worked") { a.worked_h += hrs; a.worked_amt += amt; if (em.isCasual) a.casual_h += hrs; }
    else if (bucket === "kitchen") { a.kitchen_h += hrs; a.kitchen_amt += amt; }
    else if (bucket === "cleaning") { a.cleaning_h += hrs; a.cleaning_amt += amt; }
    else if (bucket === "leave") { a.leave_h += hrs; a.leave_amt += amt; }
    else if (bucket === "matwc") { a.matwc_amt += amt; }
    a.super_amt += sup;
    if (r.employeeId) empSeen.get(key).add(r.employeeId);
  }

  const summary = { ok: true, weeks: keepPeriods.size, rows: agg.size, runs: reconciliation.length,
    total_wages: Math.round(rows.reduce((a,r) => a + r.amount, 0) * 100) / 100, reconciliation };
  if (dryRun) return summary;

  // 5) Upsert (rebuild the weeks in window).
  const del = db.prepare(`DELETE FROM labour_weekly WHERE week_ending = ?`);
  const ins = db.prepare(`
    INSERT INTO labour_weekly (eh_centre, week_ending, owna_id, employees, worked_h, worked_amt, kitchen_h, kitchen_amt, cleaning_h, cleaning_amt, leave_h, leave_amt, matwc_amt, casual_h, total_hours, total_wages, super_amt, updated_at)
    VALUES (@eh_centre,@week_ending,@owna_id,@employees,@worked_h,@worked_amt,@kitchen_h,@kitchen_amt,@cleaning_h,@cleaning_amt,@leave_h,@leave_amt,@matwc_amt,@casual_h,@total_hours,@total_wages,@super_amt,datetime('now'))
    ON CONFLICT(eh_centre,week_ending) DO UPDATE SET owna_id=excluded.owna_id, employees=excluded.employees,
      worked_h=excluded.worked_h, worked_amt=excluded.worked_amt, kitchen_h=excluded.kitchen_h, kitchen_amt=excluded.kitchen_amt, cleaning_h=excluded.cleaning_h, cleaning_amt=excluded.cleaning_amt,
      leave_h=excluded.leave_h, leave_amt=excluded.leave_amt, matwc_amt=excluded.matwc_amt, casual_h=excluded.casual_h,
      total_hours=excluded.total_hours, total_wages=excluded.total_wages, super_amt=excluded.super_amt, updated_at=datetime('now')
  `);
  const tx = db.transaction(() => {
    for (const period of keepPeriods) del.run(period);
    for (const [key, a] of agg) {
      const rnd = (x) => Math.round(x * 100) / 100;
      ins.run({
        ...a, owna_id: ownaIdFor(a.eh_centre, centres), employees: empSeen.get(key).size,
        worked_h: rnd(a.worked_h), worked_amt: rnd(a.worked_amt), kitchen_h: rnd(a.kitchen_h), kitchen_amt: rnd(a.kitchen_amt), cleaning_h: rnd(a.cleaning_h), cleaning_amt: rnd(a.cleaning_amt),
        leave_h: rnd(a.leave_h), leave_amt: rnd(a.leave_amt), matwc_amt: rnd(a.matwc_amt), casual_h: rnd(a.casual_h),
        total_hours: rnd(a.worked_h + a.kitchen_h + a.cleaning_h + a.leave_h), total_wages: rnd(a.worked_amt + a.kitchen_amt + a.cleaning_amt + a.leave_amt + a.matwc_amt), super_amt: rnd(a.super_amt),
      });
    }
  });
  tx();
  log(`[EH] labour_weekly rows written: ${agg.size}`);
  return summary;
}

function normaliseRun(run, detail, totals) {
  if (String(detail?.payRunId) !== String(run.id) || String(totals?.payRunId) !== String(run.id) ||
      !detail.earningsLines || !totals.payRunTotals) throw new Error("Run identity missing or mismatched; no wages saved.");
  const rows = [], seen = new Set();
  for (const [employeeId, lines] of Object.entries(detail.earningsLines)) {
    if (!Array.isArray(lines)) throw new Error("Invalid earnings response.");
    for (const line of lines) {
      if (line.id == null || seen.has(String(line.id))) throw new Error("Duplicate or missing earnings line identity.");
      seen.add(String(line.id));
      if (!line.locationName || !line.payCategoryName || !Number.isFinite(Number(line.earnings))) throw new Error("Incomplete earnings line; no wages saved.");
      rows.push({ week_ending: d10(run.payPeriodEnding), employeeId: Number(employeeId), location: line.locationName, location_id: line.locationId,
        payCategory: line.payCategoryName, units: Number(line.units) || 0, amount: Number(line.earnings), superAmount: Number(line.super) || 0 });
    }
  }
  // EH rounds each employee's gross, while earnings lines retain up to five decimals.
  // Reconcile individually; apply only the <= half-cent rounding residual to that
  // employee's largest line. Missing earnings cannot pass a whole-run tolerance.
  let roundingAdjustment = 0;
  const employeeIds = new Set([...Object.keys(totals.payRunTotals), ...rows.map(r => String(r.employeeId))]);
  for (const id of employeeIds) {
    const total = totals.payRunTotals[id];
    if (!total || !Number.isFinite(Number(total.grossEarnings))) throw new Error("Missing employee payroll total.");
    const employeeRows = rows.filter(r => String(r.employeeId) === id);
    const delta = Number(total.grossEarnings) - employeeRows.reduce((a,r) => a + r.amount, 0);
    if (Math.abs(delta) > 0.005001) throw new Error("Employee earnings do not reconcile to payroll totals; no wages saved.");
    if (employeeRows.length) { employeeRows.reduce((a,b) => Math.abs(a.amount) >= Math.abs(b.amount) ? a : b).amount += delta; roundingAdjustment += delta; }
  }
  const expected = Object.values(totals.payRunTotals);
  if (expected.some(t => !Number.isFinite(Number(t.grossEarnings)))) throw new Error("Invalid payroll totals.");
  const gross = expected.reduce((a,t) => a + Number(t.grossEarnings), 0);
  const actual = rows.reduce((a,r) => a + r.amount, 0);
  if (Math.abs(Math.round(gross * 100) - Math.round(actual * 100)) > 1) throw new Error("Earnings do not reconcile to payroll totals; no wages saved.");
  return { rows, reconciliation: { run_id: run.id, period_ending: d10(run.payPeriodEnding), lines: rows.length, rounding_adjustment: roundingAdjustment,
    source_gross: Math.round(gross * 100) / 100, imported_gross: Math.round(actual * 100) / 100 } };
}
function centreLocation(id, locations) {
  const byId = new Map(locations.map(l => [String(l.id),l]));
  let loc = byId.get(String(id)); const seen = new Set();
  if (!loc) throw new Error("Unknown payroll location; no wages saved.");
  while (loc.parentId != null) {
    if (seen.has(String(loc.id))) throw new Error("Payroll location hierarchy is cyclic.");
    seen.add(String(loc.id));
    const parent = byId.get(String(loc.parentId));
    if (!parent) throw new Error("Payroll parent location missing.");
    if (parent.parentId == null) break; // direct child of the organisation is a centre/cost centre
    loc = parent;
  }
  return loc.name;
}
module.exports = { runLabourSnapshot, normaliseRun, classify, centreLocation };
