#!/usr/bin/env node
// Run in the deployed service shell; read-only and no record content or secrets emitted.
require("dotenv").config();
const fs=require("fs"), path=require("path"), Database=require("better-sqlite3");
try {
  const file=path.resolve(process.env.DB_PATH || "./data/owna.db");
  const db=new Database(file,{readonly:true,fileMustExist:true});
  let mount="not found";
  if (fs.existsSync("/proc/mounts")) { const mounts=fs.readFileSync("/proc/mounts","utf8").split("\n").map(l=>l.split(" ")[1]).filter(Boolean); mount=mounts.filter(m=>m!=="/" && (file===m || file.startsWith(m+"/"))).sort((a,b)=>b.length-a.length)[0] || "not found"; }
  console.log(JSON.stringify({commit:process.env.RENDER_GIT_COMMIT || "not found",database:file,mount,
    integrity:db.pragma("quick_check",{simple:true}),journal:db.pragma("journal_mode",{simple:true}),
    centreCount:db.prepare("SELECT COUNT(*) n FROM centres").get().n,
    lastWageUpdate:db.prepare("SELECT MAX(updated_at) d FROM labour_weekly").get().d,
    encryptionAtRest:"not found in application configuration; verify with hosting provider"},null,2));
  db.close();
} catch { console.error("Deployment verification failed; check the configured database path and schema."); process.exitCode=1; }
