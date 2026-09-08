#!/usr/bin/env node
require("dotenv").config();
const fs = require("fs"), path = require("path"), Database = require("better-sqlite3");
const { backup } = require("../services/backup");
(async () => {
  if (!process.env.BACKUP_PASSPHRASE || process.env.BACKUP_PASSPHRASE.length < 20) throw new Error("Backup passphrase required.");
  const dir = path.resolve(process.env.BACKUP_DIR || "./backups"); fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const db = new Database(process.env.DB_PATH || "./data/owna.db",{readonly:true,fileMustExist:true});
  const target = path.join(dir,"owna-"+new Date().toISOString().replace(/[:.]/g,"-")+".db.enc");
  try { await backup(db,target,process.env.BACKUP_PASSPHRASE); } finally { db.close(); }
  console.log("Encrypted backup created: " + target);
})().catch(() => { console.error("Backup failed. Check source, destination and passphrase configuration."); process.exitCode=1; });
