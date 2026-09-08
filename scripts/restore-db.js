#!/usr/bin/env node
require("dotenv").config();
try {
  const [source,target] = process.argv.slice(2);
  if (!source || !target) throw new Error("Arguments required");
  require("../services/backup").restore(source,target,process.env.BACKUP_PASSPHRASE);
  console.log("Restored to a new file; SQLite integrity check passed.");
} catch { console.error("Restore failed; use a new destination and the correct passphrase. Existing database not overwritten."); process.exitCode=1; }
