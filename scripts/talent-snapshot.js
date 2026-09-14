// CLI entry: `npm run talent-snapshot` — rebuilds the talent counts on demand, so the first one does
// not have to wait for the 2:15am run and a payroll correction can be picked up the moment it is made.
// Same step the nightly snapshot runs, same tables, same per-source health row. Safe to re-run: the
// three talent tables are wholly derived from payroll and are rebuilt inside one transaction.
//
// Prints counts only. Nothing that identifies a person reaches this output, the tables or the log.
require("dotenv").config();
const { runTalentSnapshot } = require("../services/eh-talent");
const { recordSync, errSummary } = require("../services/snapshot"); // one implementation of the health row

runTalentSnapshot()
  .then((r) => {
    if (r.skipped) { recordSync("talent", "skipped", r.reason); console.log(`Talent snapshot skipped: ${r.reason}`); process.exit(0); }
    const detail = `${r.employees} employees over ${r.months} months to ${r.to}: ${r.headcount} permanent, ${r.casual_headcount} casual (group), `
      + `${r.terminations} terminations less ${r.casual_leavers} casual less ${r.never_started} never started = ${r.turnover_leavers} turnover events`
      + (r.undated_terminations ? `; ${r.undated_terminations} termination(s) carry no end date` : "");
    // No employees is not a result — keep the last good counts and flag it, as the nightly step does.
    const dead = !r.employees;
    recordSync("talent", dead ? "error" : "ok", dead ? "Employment Hero returned no employees; talent counts left as previously imported" : detail,
      { rows: r.rows, meta: { months: r.months, from: r.from, to: r.to, headcount: r.headcount, casual_headcount: r.casual_headcount,
        terminations: r.terminations, casual_leavers: r.casual_leavers, never_started: r.never_started,
        turnover_leavers: r.turnover_leavers, undated_terminations: r.undated_terminations, centres: r.centres } });
    console.log(`Talent snapshot ${r.from} → ${r.to}: ${detail}`);
    console.log(`  turnover basis: ${r.terminations} raw − ${r.casual_leavers} casual − ${r.never_started} never started = ${r.turnover_leavers}`);
    process.exit(dead ? 1 : 0);
  })
  .catch((e) => {
    const why = errSummary(e);
    recordSync("talent", "error", why);
    console.error("Talent snapshot failed:", why);
    process.exit(1);
  });
