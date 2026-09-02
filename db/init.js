// Creates the schema and seeds the default admin account. Idempotent.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
require("dotenv").config();
const db = require("./db");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

// Lightweight migrations for columns added after first release.
function addColumnIfMissing(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    console.log(`[init] added ${table}.${col}`);
  }
}
addColumnIfMissing("centres", "ll_id", "INTEGER"); // link OWNA centre -> LineLeader centre
addColumnIfMissing("users", "location_id", "TEXT"); // owna_id for centre-scoped users (NULL = all centres)
addColumnIfMissing("labour_weekly", "cleaning_h", "REAL DEFAULT 0");
addColumnIfMissing("labour_weekly", "cleaning_amt", "REAL DEFAULT 0");
addColumnIfMissing("labour_budget", "budget_support", "REAL");

const email = process.env.ADMIN_EMAIL || "admin@example.com";
const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
if (!existing) {
  const pw = process.env.ADMIN_DEFAULT_PASSWORD || "ChangeMe123!";
  const hash = bcrypt.hashSync(pw, 10);
  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)")
    .run(email, "Admin", hash, "admin");
  console.log(`[init] created admin user ${email} (change the password after first login)`);
} else {
  console.log(`[init] admin user ${email} already exists`);
}

console.log("[init] schema ready");
