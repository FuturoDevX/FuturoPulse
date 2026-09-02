// One-time deep history backfill: pulls ~2 years of OWNA occupancy into daily_metrics.
// Usage: node db/backfill.js [backDays]   (default 730)
require("dotenv").config();
const { runOwnaBackfill } = require("../services/snapshot");

const backDays = parseInt(process.argv[2], 10) || 730;
runOwnaBackfill({ backDays })
  .then((r) => { console.log("Backfill complete:", r); process.exit(0); })
  .catch((e) => { console.error("Backfill failed:", e.message); process.exit(1); });
