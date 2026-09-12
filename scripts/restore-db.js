#!/usr/bin/env node
require("dotenv").config();
const fs = require("fs"), Database = require("better-sqlite3");
try {
  const [source,target] = process.argv.slice(2);
  if (!source || !target) throw new Error("Arguments required");
  require("../services/backup").restore(source,target,process.env.BACKUP_PASSPHRASE);
  // Clear the logins the backup was carrying. A row in `sessions` expires eight hours after that user's
  // LAST REQUEST, and the boot sweep in middleware/session.js deletes only rows already past their
  // `expire` — so in any backup younger than eight hours (which is what "back up, break something,
  // restore two hours later" produces) every row survives the restore and signs those people straight
  // back in. That includes anyone who logged out in between: express-session's destroy deletes the row
  // but never clears the browser cookie, so the signed sid is still held and the resurrected row matches
  // it. Clearing here, on the restored file before it is put into service, is the only thing that makes
  // a restore sign everyone out rather than reinstate whoever was signed in at backup time.
  try {
    const d = new Database(target);
    try { if (d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get()) d.exec("DELETE FROM sessions"); }
    finally { d.close(); }
  } catch (e) { for (const s of ["","-wal","-shm"]) fs.rmSync(target+s,{force:true}); throw e; }
  console.log("Restored to a new file; SQLite integrity check passed. Signed-in sessions cleared, so everyone signs in again.");
} catch { console.error("Restore failed; use a new destination and the correct passphrase. Existing database not overwritten."); process.exitCode=1; }
