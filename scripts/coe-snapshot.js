// CLI entry: `npm run coe-snapshot` — takes the Continuation of Enrolment measurement on demand, so the
// first one does not have to wait for the 2:15am run. Same step the nightly snapshot runs, same tables,
// same per-source health row: re-running it on the same day overwrites that day's rows rather than
// duplicating them (the primary keys carry snapshot_date).
require("dotenv").config();
const { runCoeSnapshot, recordSync, errSummary } = require("../services/snapshot");

runCoeSnapshot()
  .then((r) => {
    const detail = `${r.rows} centre-months and ${r.mix_rows} mix bands over ${r.attempts - r.failed - r.empty} centres`
      + (r.failed ? ` (${r.failed} of ${r.attempts} centres failed: ${r.firstError})` : "")
      + (r.empty ? `, ${r.empty} with no children` : "")
      + (r.stops.length ? `; forward bookings stop before the window ends at ${r.stops.map((s) => `${s.name} ${s.last_booking_date}`).join(", ")}` : "");
    // Every centre failing is not a result — keep the last good rows and flag it, as the nightly step does.
    const dead = r.attempts && r.failed === r.attempts;
    recordSync("coe", dead ? "error" : "ok", dead ? `every OWNA children/attendance call failed: ${r.firstError}` : detail,
      { rows: r.rows, meta: { snapshot_date: r.snapshot_date, centres: r.attempts - r.failed, stops: r.stops.length } });
    console.log(`COE snapshot ${r.snapshot_date}: ${detail}`);
    for (const s of r.stops) console.log(`  NOTE: ${s.name} has no bookings after ${s.last_booking_date} (${s.horizon_children} of ${s.enrolled} children stop on that day) — months after it are reported as not measurable, not as leavers.`);
    process.exit(dead ? 1 : 0);
  })
  .catch((e) => {
    const why = errSummary(e);
    recordSync("coe", "error", why);
    console.error("COE snapshot failed:", why);
    process.exit(1);
  });
