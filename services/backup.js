const crypto = require("crypto"), fs = require("fs"), path = require("path"), os = require("os");
const Database = require("better-sqlite3");
const MAGIC = Buffer.from("FUTURO01");
function key(pass, salt) { if (!pass || pass.length < 20) throw new Error("A backup passphrase of at least 20 characters is required."); return crypto.scryptSync(pass, salt, 32); }
async function backup(db, target, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), k = key(pass, salt);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "futuro-backup-"));
  try {
    const raw = path.join(dir, "snapshot.db"); await db.backup(raw);
    const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
    const encrypted = Buffer.concat([cipher.update(fs.readFileSync(raw)), cipher.final()]);
    fs.writeFileSync(target, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted]), { flag: "wx", mode: 0o600 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function restore(source, target, pass) {
  if (fs.existsSync(target)) throw new Error("Restore destination already exists.");
  const data = fs.readFileSync(source);
  if (!data.subarray(0,8).equals(MAGIC)) throw new Error("Unsupported backup format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(pass, data.subarray(8,24)), data.subarray(24,36));
  decipher.setAuthTag(data.subarray(36,52));
  const raw = Buffer.concat([decipher.update(data.subarray(52)), decipher.final()]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "futuro-restore-"));
  try {
    const check = path.join(dir,"check.db"); fs.writeFileSync(check,raw,{mode:0o600});
    const db = new Database(check,{readonly:true});
    try { if (db.pragma("integrity_check",{simple:true}) !== "ok") throw new Error("Backup failed integrity check."); } finally { db.close(); }
    fs.writeFileSync(target,raw,{flag:"wx",mode:0o600});
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
module.exports = { backup, restore };
