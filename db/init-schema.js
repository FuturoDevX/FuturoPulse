// Idempotent DB initialization: schema + column migrations + default admin seed.
// Called from db/db.js when the connection opens, so it targets whatever database
// the app actually uses at RUNTIME. This matters on hosts (e.g. Render) where the
// persistent disk is NOT mounted during pre-deploy — initializing only in pre-deploy
// would create the schema on an ephemeral filesystem that the running app never sees.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

function initSchema(db) {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema); // all CREATE ... IF NOT EXISTS — safe to run every boot

  // Lightweight migrations for columns added after a table's first release.
  const addColumnIfMissing = (table, col, decl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  };
  addColumnIfMissing("centres", "ll_id", "INTEGER");
  addColumnIfMissing("centres", "opening", "INTEGER DEFAULT 0");
  addColumnIfMissing("users", "location_id", "TEXT");
  addColumnIfMissing("labour_weekly", "cleaning_h", "REAL DEFAULT 0");
  addColumnIfMissing("labour_weekly", "cleaning_amt", "REAL DEFAULT 0");
  addColumnIfMissing("labour_budget", "budget_support", "REAL");
  addColumnIfMissing("pc_metrics", "family_nps", "REAL");
  addColumnIfMissing("qc_actions", "term", "TEXT");
  addColumnIfMissing("incidents_monthly", "illness", "INTEGER DEFAULT 0");
  addColumnIfMissing("incidents_monthly", "serious", "INTEGER DEFAULT 0");

  // Seed the default admin if it doesn't exist yet.
  const email = process.env.ADMIN_EMAIL || "admin@example.com";
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!existing) {
    const pw = process.env.ADMIN_DEFAULT_PASSWORD || "ChangeMe123!";
    const hash = bcrypt.hashSync(pw, 10);
    db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)").run(email, "Admin", hash, "admin");
    console.log(`[init] created admin user ${email} (change the password after first login)`);
  }
}

module.exports = { initSchema };
