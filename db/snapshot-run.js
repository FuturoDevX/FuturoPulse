// CLI entry: `npm run snapshot` — pulls the rolling window from OWNA into SQLite.
require("dotenv").config();
const { runSnapshot } = require("../services/snapshot");

runSnapshot()
  .then((r) => { console.log("Snapshot complete:", r); process.exit(0); })
  .catch((e) => { console.error("Snapshot failed:", e.message); process.exit(1); });
