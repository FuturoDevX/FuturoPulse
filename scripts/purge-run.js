// CLI entry: `npm run purge` — enforces the owner's retention periods on demand, so a period change
// or a first run does not have to wait for 2:15am. Exactly the same step the nightly snapshot runs
// last (services/retention.js), against the same tables, reporting to the same per-source health row.
// Safe to run twice and safe to run on an empty database; it reports how many rows it removed per
// table and never what any of them contained.
require("dotenv").config();
const { runPurge } = require("../services/retention");
const { recordSync, errSummary } = require("../services/snapshot"); // one implementation of the health row

try {
  const r = runPurge({ log: console.log });
  recordSync("retention", "ok", r.detail, { rows: r.total, meta: { at: r.at, removed: r.removed, cutoffs: r.cutoffs } });
  console.log(`Retention purge ${r.at}: ${r.detail}`);
  process.exit(0);
} catch (e) {
  const why = errSummary(e);
  recordSync("retention", "error", why);
  console.error("Retention purge failed:", why);
  process.exit(1);
}
