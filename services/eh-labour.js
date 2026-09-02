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

function classify(payCategory) {
  const n = (payCategory || "").toLowerCase();
  if (n.includes("leave taken") || n.includes("leave loading")) return "leave";
  if (n.includes("workers comp") || n.includes("maternity") || n.includes("parental leave")) return "matwc";
  return "worked";
}

async function runLabourSnapshot({ weeks = WEEKS, log = console.log } = {}) {
  if (!eh.hasCreds()) { log("[EH] no payroll credentials — skipping"); return { skipped: true }; }

  // 1) Employee map: id -> { isKitchen, isCasual }.
  const emps = await eh.allEmployees();
  const empMap = new Map();
  for (const e of emps) {
    empMap.set(e.id, {
      isKitchen: /kitchen/i.test(e.primaryLocation || ""),
      isCleaning: /clean/i.test(e.primaryLocation || ""),
      isCasual: (e.employmentType || "") === "Casual",
    });
  }

  // 2) Pay runs -> datePaid => periodEnding, limited to recent `weeks` distinct periods.
  const runs = await eh.payRuns();
  const paidToPeriod = new Map();
  const periods = [];
  for (const r of runs) {
    const paid = d10(r.datePaid), end = d10(r.payPeriodEnding);
    if (!paid || !end) continue;
    paidToPeriod.set(paid, end);
    if (!periods.includes(end)) periods.push(end);
  }
  const keepPeriods = new Set(periods.slice(0, weeks));
  const paidDates = [...paidToPeriod.entries()].filter(([, e]) => keepPeriods.has(e)).map(([p]) => p).sort();
  if (!paidDates.length) { log("[EH] no pay runs"); return { ok: true, weeks: 0 }; }
  const fromDate = paidDates[0], toDate = paidDates[paidDates.length - 1];

  // 3) Pay-category detail for the window.
  const rows = await eh.payCategoriesReport(fromDate, toDate);
  log(`[EH] ${emps.length} employees, ${keepPeriods.size} weeks, ${rows.length} pay lines (${fromDate}..${toDate})`);

  // 4) Aggregate per (centre, week).
  const centres = db.prepare(`SELECT owna_id, name FROM centres`).all();
  const agg = new Map(); // key eh_centre|week
  const empSeen = new Map(); // key -> Set of employeeIds
  for (const r of rows) {
    const week = paidToPeriod.get(d10(r.datePaid));
    if (!week || !keepPeriods.has(week)) continue;
    const centre = r.location || "(none)";
    const key = centre + "|" + week;
    let a = agg.get(key);
    if (!a) { a = { eh_centre: centre, week_ending: week, worked_h: 0, worked_amt: 0, kitchen_h: 0, kitchen_amt: 0, cleaning_h: 0, cleaning_amt: 0, leave_h: 0, leave_amt: 0, matwc_amt: 0, casual_h: 0, super_amt: 0 }; agg.set(key, a); empSeen.set(key, new Set()); }
    const em = empMap.get(r.employeeId) || {};
    const hrs = Number(r.units) || 0, amt = Number(r.amount) || 0, sup = Number(r.superAmount) || 0;
    let bucket = classify(r.payCategory);
    if (bucket === "worked" && em.isKitchen) bucket = "kitchen";
    else if (bucket === "worked" && em.isCleaning) bucket = "cleaning";
    if (bucket === "worked") { a.worked_h += hrs; a.worked_amt += amt; if (em.isCasual) a.casual_h += hrs; }
    else if (bucket === "kitchen") { a.kitchen_h += hrs; a.kitchen_amt += amt; }
    else if (bucket === "cleaning") { a.cleaning_h += hrs; a.cleaning_amt += amt; }
    else if (bucket === "leave") { a.leave_h += hrs; a.leave_amt += amt; }
    else if (bucket === "matwc") { a.matwc_amt += amt; }
    a.super_amt += sup;
    if (r.employeeId) empSeen.get(key).add(r.employeeId);
  }

  // 5) Upsert (rebuild the weeks in window).
  const del = db.prepare(`DELETE FROM labour_weekly WHERE week_ending BETWEEN ? AND ?`);
  const ins = db.prepare(`
    INSERT INTO labour_weekly (eh_centre, week_ending, owna_id, employees, worked_h, worked_amt, kitchen_h, kitchen_amt, cleaning_h, cleaning_amt, leave_h, leave_amt, matwc_amt, casual_h, total_hours, total_wages, super_amt, updated_at)
    VALUES (@eh_centre,@week_ending,@owna_id,@employees,@worked_h,@worked_amt,@kitchen_h,@kitchen_amt,@cleaning_h,@cleaning_amt,@leave_h,@leave_amt,@matwc_amt,@casual_h,@total_hours,@total_wages,@super_amt,datetime('now'))
    ON CONFLICT(eh_centre,week_ending) DO UPDATE SET owna_id=excluded.owna_id, employees=excluded.employees,
      worked_h=excluded.worked_h, worked_amt=excluded.worked_amt, kitchen_h=excluded.kitchen_h, kitchen_amt=excluded.kitchen_amt, cleaning_h=excluded.cleaning_h, cleaning_amt=excluded.cleaning_amt,
      leave_h=excluded.leave_h, leave_amt=excluded.leave_amt, matwc_amt=excluded.matwc_amt, casual_h=excluded.casual_h,
      total_hours=excluded.total_hours, total_wages=excluded.total_wages, super_amt=excluded.super_amt, updated_at=datetime('now')
  `);
  const minW = [...keepPeriods].sort()[0], maxW = [...keepPeriods].sort().slice(-1)[0];
  const tx = db.transaction(() => {
    del.run(minW, maxW);
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
  return { ok: true, weeks: keepPeriods.size, rows: agg.size };
}

module.exports = { runLabourSnapshot };
