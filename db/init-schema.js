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
  addColumnIfMissing("centres", "opening_year", "INTEGER");
  addColumnIfMissing("centres", "opening_month", "INTEGER");
  addColumnIfMissing("users", "location_id", "TEXT");
  addColumnIfMissing("labour_weekly", "cleaning_h", "REAL DEFAULT 0");
  addColumnIfMissing("labour_weekly", "cleaning_amt", "REAL DEFAULT 0");
  addColumnIfMissing("labour_budget", "budget_support", "REAL");
  addColumnIfMissing("pc_metrics", "family_nps", "REAL");
  addColumnIfMissing("pc_metrics", "turnover_mom", "REAL");
  addColumnIfMissing("pc_metrics", "headcount", "INTEGER");
  addColumnIfMissing("pc_metrics", "leavers", "INTEGER");
  addColumnIfMissing("qc_actions", "term", "TEXT");
  addColumnIfMissing("incidents_monthly", "illness", "INTEGER DEFAULT 0");
  addColumnIfMissing("incidents_monthly", "serious", "INTEGER DEFAULT 0");

  addColumnIfMissing("action_plan_items", "start_date", "TEXT");
  addColumnIfMissing("action_plan_items", "due_date", "TEXT");
  addColumnIfMissing("action_plan_items", "progress", "TEXT");
  addColumnIfMissing("action_plan_items", "outcome", "TEXT");
  addColumnIfMissing("action_plan_items", "priority", "TEXT");
  addColumnIfMissing("action_plan_items", "job_reference", "TEXT");

  // Exit report de-identification (APP 11.2): departed children's names and dates of birth are no longer
  // collected, so clean them out of any database that already has them. The nightly rebuild would only
  // put them back, which is why the columns go rather than the rows. SQLite 3.35+ can drop a column that
  // is in no key or index (child_name/dob are in neither); otherwise fall back to clearing the values.
  const exitCols = db.prepare("PRAGMA table_info(child_exits)").all().map((c) => c.name);
  for (const col of ["child_name", "dob"]) {
    if (!exitCols.includes(col)) continue;
    try {
      db.exec(`ALTER TABLE child_exits DROP COLUMN ${col}`);
      console.log(`[init] dropped child_exits.${col} — the exit report no longer stores it`);
    } catch (e) {
      db.exec(`UPDATE child_exits SET ${col} = NULL`);
      console.log(`[init] could not drop child_exits.${col} (${e.message}) — cleared every value instead`);
    }
  }
  // Legacy child_key values were the raw "name|dob" string, i.e. a recoverable name. Replace them with
  // opaque ids; the next exit rebuild re-keys every row with a salted hash anyway.
  if (exitCols.includes("child_key") && db.prepare("SELECT COUNT(*) n FROM child_exits WHERE child_key LIKE '%|%'").get().n) {
    const n = db.prepare("UPDATE child_exits SET child_key = lower(hex(randomblob(16))) WHERE child_key LIKE '%|%'").run().changes;
    console.log(`[init] replaced ${n} name-bearing child_exits keys with opaque ids`);
  }
  // Seed exits_monthly from whatever detail the database already holds, so the aggregate starts with the
  // history that is in the current look-back window instead of waiting a year to fill up. One-off: after
  // this, runExitReport maintains it.
  if (exitCols.length && !db.prepare("SELECT 1 FROM exits_monthly").get() && db.prepare("SELECT 1 FROM child_exits").get()) {
    const n = db.prepare(`
      INSERT INTO exits_monthly (owna_id, month, room, upcoming, departures, tenure_days_sum, tenure_n, updated_at)
      SELECT owna_id, substr(finish_date, 1, 7), COALESCE(room, ''), COALESCE(upcoming, 0), COUNT(*),
             COALESCE(SUM(CASE WHEN tenure_days > 0 THEN tenure_days END), 0),
             SUM(CASE WHEN tenure_days > 0 THEN 1 ELSE 0 END), datetime('now')
      FROM child_exits WHERE finish_date IS NOT NULL
      GROUP BY owna_id, substr(finish_date, 1, 7), COALESCE(room, ''), COALESCE(upcoming, 0)
    `).run().changes;
    console.log(`[init] seeded exits_monthly with ${n} month rows from the current exit window`);
  }

  // ai_briefings moved from one-row-per-week (PK period_to) to one-per-date-range (PK period_key).
  // It is a regenerable cache, so recreate it rather than migrate rows.
  const abCols = db.prepare("PRAGMA table_info(ai_briefings)").all().map((c) => c.name);
  if (abCols.length && !abCols.includes("period_key")) {
    db.exec("DROP TABLE ai_briefings");
    db.exec(schema); // all CREATE ... IF NOT EXISTS — recreates it with the new shape
    console.log("[init] rebuilt ai_briefings for per-range caching");
  }

  // source_sync arrived after payroll had already been imported: seed its eh_labour row from the
  // existing labour_weekly data so the Wages page does not claim payroll was never imported.
  if (!db.prepare("SELECT 1 FROM source_sync WHERE source = 'eh_labour'").get()) {
    const lw = db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT week_ending) weeks, MAX(week_ending) latest, MAX(updated_at) at FROM labour_weekly").get();
    if (lw && lw.n) db.prepare("INSERT INTO source_sync (source, last_attempt, last_success, status, detail, rows, meta_json) VALUES ('eh_labour', ?, ?, 'ok', 'imported before per-source tracking was added', ?, ?)")
      .run(lw.at, lw.at, lw.n, JSON.stringify({ weeks: lw.weeks, runs: null, latest_period: lw.latest, total_wages: null }));
  }

  // Seed the default admin if it doesn't exist yet.
  const isProd = process.env.NODE_ENV === "production";
  const email = process.env.ADMIN_EMAIL || "admin@example.com";
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!existing) {
    const pw = process.env.ADMIN_DEFAULT_PASSWORD || "ChangeMe123!";
    // Never seed a production admin with the published default or a weak/missing password.
    if (isProd && (!process.env.ADMIN_EMAIL || /example\.com$/i.test(email) || !process.env.ADMIN_DEFAULT_PASSWORD || pw === "ChangeMe123!" || pw.length < 12)) {
      console.error("Refusing to create the default admin in production: set ADMIN_EMAIL and a strong (12+ char) ADMIN_DEFAULT_PASSWORD.");
      process.exit(1);
    }
    const hash = bcrypt.hashSync(pw, 10);
    db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)").run(email, "Admin", hash, "admin");
    console.log(`[init] created admin user ${email} (change the password after first login)`);
  }
}

module.exports = { initSchema };
