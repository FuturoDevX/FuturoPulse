// Idempotent DB initialization: schema + column migrations + default admin seed.
// Called from db/db.js when the connection opens, so it targets whatever database
// the app actually uses at RUNTIME. This matters on hosts (e.g. Render) where the
// persistent disk is NOT mounted during pre-deploy — initializing only in pre-deploy
// would create the schema on an ephemeral filesystem that the running app never sees.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

// Roster leave, de-identified: OWNA hands back one entry per staff member per day, carrying that person's
// name and their leave type. Only the HOURS are ever used (services/metrics.js rosterCentre, views/centre.ejs),
// so this folds the entries into one row per day — how many people were on leave and for how many hours —
// and the name and leave type never reach the database. Accepts either OWNA's array or a stored JSON string,
// so the nightly write (services/snapshot.js) and the one-off migration below share one implementation.
// Days are normalised to the weekday names days_json already uses; OWNA numbers them 1 = Monday.
const LEAVE_DOW = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
function leaveTotals(input) {
  let list = input;
  if (typeof list === "string") { try { list = JSON.parse(list || "[]"); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  const byDay = new Map();
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const raw = e.day == null ? "" : String(e.day).trim().toLowerCase();
    const day = /^[1-7]$/.test(raw) ? LEAVE_DOW[Number(raw) - 1] : (raw || "unknown");
    const d = byDay.get(day) || { day, staff: 0, hours: 0, who: new Set() };
    // A person can hold two leave entries on one day (e.g. part personal, part unpaid): one person, both lots
    // of hours. Count distinct people while the names are still in hand; an already-aggregated row counts as
    // whatever it says. After this, nothing downstream can tell two entries from two people.
    if (typeof e.staff === "number") d.staff += e.staff;
    else if (e.staff != null && String(e.staff).trim()) d.who.add(String(e.staff).trim().toLowerCase());
    else d.staff += 1;
    d.hours += Number(e.hours) || 0;
    byDay.set(day, d);
  }
  return LEAVE_DOW.filter((d) => byDay.has(d)).concat([...byDay.keys()].filter((d) => !LEAVE_DOW.includes(d)))
    .map((k) => { const d = byDay.get(k); return { day: d.day, staff: d.staff + d.who.size, hours: Math.round(d.hours * 100) / 100 }; });
}

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
  addColumnIfMissing("centres", "approved_places", "INTEGER");
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
  // The feedback retention period runs from the review, so the review needs a date. Rows triaged
  // before this column existed keep a NULL here and are therefore never purged — services/retention.js
  // deletes only what it can prove is past its period, and NULL proves nothing (see rule 2 there).
  addColumnIfMissing("feedback", "reviewed_at", "TEXT");

  // ---- Approved places: the licensed count on each service approval (ACECQA National Register) ----
  // centres.capacity is the SUM OF OWNA ROOM CAPACITIES and the nightly snapshot rewrites it every night,
  // so it can never hold the licensed figure — Austral runs 124 approved places against a 122 room sum.
  // Seed the four operating services with the register's "Approved Places", plus the service approval
  // number OWNA does not return for Heath Rd (SE-00018172, "Futuro Childcare & Education - Leppington
  // Heath Road", 201 Heath Rd, Leppington NSW 2179). ONLY where the value is still NULL: /admin/places is
  // the maintained source from here on, so an admin's later correction must survive every reboot.
  // Cobbitty, Oran Park and Park Rd have no service approval yet and stay NULL — unknown, never 0.
  const APPROVED_PLACES = [
    { name: "Austral", approval_no: "SE-00017004", places: 124 },
    { name: "Bardia", approval_no: "SE-00016692", places: 122 },
    { name: "Gledswood", approval_no: "SE-40025191", places: 119 },
    { name: "Heath", approval_no: "SE-00018172", places: 136 },
  ];
  const seedApprovalNo = db.prepare(`UPDATE centres SET approval_no = @approval_no
    WHERE approval_no IS NULL AND (opening IS NULL OR opening = 0) AND name LIKE @like`);
  const seedApprovedPlaces = db.prepare(`UPDATE centres SET approved_places = @places
    WHERE approved_places IS NULL AND (opening IS NULL OR opening = 0)
      AND (approval_no = @approval_no OR name LIKE @like)`);
  let placesSeeded = 0, approvalsSeeded = 0;
  for (const c of APPROVED_PLACES) {
    const args = { approval_no: c.approval_no, places: c.places, like: `%${c.name}%` };
    approvalsSeeded += seedApprovalNo.run(args).changes; // first, so the places update can match on it
    placesSeeded += seedApprovedPlaces.run(args).changes;
  }
  if (placesSeeded || approvalsSeeded) {
    console.log(`[init] seeded approved places for ${placesSeeded} centre(s)`
      + (approvalsSeeded ? ` and a service approval number for ${approvalsSeeded}` : "")
      + " — maintain them at /admin/places");
  }

  addColumnIfMissing("action_plan_items", "start_date", "TEXT");
  addColumnIfMissing("action_plan_items", "due_date", "TEXT");
  addColumnIfMissing("action_plan_items", "progress", "TEXT");
  addColumnIfMissing("action_plan_items", "outcome", "TEXT");
  addColumnIfMissing("action_plan_items", "priority", "TEXT");
  addColumnIfMissing("action_plan_items", "job_reference", "TEXT");

  // The tours/members family match used to be on the family NAME. It is now a salted hash of it, written
  // by the nightly LineLeader rebuild, so an existing database needs the column before the drops below.
  addColumnIfMissing("ll_pipeline_members", "family_key", "TEXT");
  addColumnIfMissing("ll_tours", "family_key", "TEXT");

  // De-identification (APP 11.2). This dashboard is a DERIVED system: OWNA, Employment Hero and LineLeader
  // remain the records of who each child, family and staff member is, and nobody used the named lists here.
  // So no child name, family name, date of birth or staff name is collected any more — clean them out of any
  // database that already has them. Every one of these tables is REBUILT from its source (child_exits and the
  // three ll_* tables nightly), so deleting the ROWS would only have the names written back the next morning:
  // the COLUMNS go, and the snapshot stops collecting them. SQLite 3.35+ can drop a column that is in no key
  // or index — none of these are — otherwise fall back to clearing the values.
  const NAME_COLUMNS = [
    ["child_exits", ["child_name", "dob"], "the exit report"],
    ["ll_pipeline_members", ["child_name", "family_name"], "the centre pipeline"],
    ["ll_pipeline_starts", ["child_name"], "the enrolment projection"],
    ["ll_tours", ["family_name"], "the tour list"],
  ];
  const exitCols = db.prepare("PRAGMA table_info(child_exits)").all().map((c) => c.name);
  let deidentified = false; // set when this boot actually removed or rewrote name-bearing data

  // Carry the family match across the drop. The cohort tour figures on /pipeline match a tour to its family,
  // and LineLeader gives no family id on a tour row — only the name. Waiting for the nightly rebuild to fill
  // family_key would leave those counts reading zero until the next morning, so derive the key HERE, from the
  // name that is about to go, with a salt that exists only for this boot and is never written down. Both
  // tables are keyed in the same pass, so they agree; the nightly rebuild then re-keys both with its own salt.
  const bootSalt = crypto.randomBytes(32).toString("hex");
  const familyKey = (name) => {
    const n = (name || "").toLowerCase().replace(/[^a-z]/g, "");
    return n ? crypto.createHmac("sha256", bootSalt).update(n).digest("hex").slice(0, 32) : null;
  };
  for (const [table, idCol] of [["ll_pipeline_members", "child_id"], ["ll_tours", "task_id"]]) {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!have.includes("family_name") || !have.includes("family_key")) continue;
    const rows = db.prepare(`SELECT ${idCol} AS id, family_name FROM ${table} WHERE family_name IS NOT NULL AND family_key IS NULL`).all();
    if (!rows.length) continue;
    const set = db.prepare(`UPDATE ${table} SET family_key = ? WHERE ${idCol} = ?`);
    db.transaction(() => { for (const r of rows) set.run(familyKey(r.family_name), r.id); })();
    console.log(`[init] keyed ${rows.length} ${table} row(s) by an opaque family key, so the tour match survives the name going`);
  }

  for (const [table, cols, what] of NAME_COLUMNS) {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const col of cols) {
      if (!have.includes(col)) continue;
      try {
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
        console.log(`[init] dropped ${table}.${col} — ${what} no longer stores it`);
      } catch (e) {
        db.exec(`UPDATE ${table} SET ${col} = NULL`);
        console.log(`[init] could not drop ${table}.${col} (${e.message}) — cleared every value instead`);
      }
      deidentified = true;
    }
  }
  // Legacy child_key values were the raw "name|dob" string, i.e. a recoverable name. Replace them with
  // opaque ids; the next exit rebuild re-keys every row with a salted hash anyway.
  if (exitCols.includes("child_key") && db.prepare("SELECT COUNT(*) n FROM child_exits WHERE child_key LIKE '%|%'").get().n) {
    const n = db.prepare("UPDATE child_exits SET child_key = lower(hex(randomblob(16))) WHERE child_key LIKE '%|%'").run().changes;
    console.log(`[init] replaced ${n} name-bearing child_exits keys with opaque ids`);
    deidentified = true;
  }
  // roster_weekly.leave_json used to be one entry per staff member per day — {staff, leavetype, day, hours} —
  // where `staff` is a person's name and `leavetype` (personal, parental) implies health, which is sensitive
  // information. Only the hours were ever used. Rewrite each stored week IN PLACE to per-day totals,
  // {day, staff: <count of people on leave>, hours}, so the figures survive and neither survives with them.
  // Distinct names are counted here while they are still readable; after this boot nothing can recover them.
  const rosterCols = db.prepare("PRAGMA table_info(roster_weekly)").all().map((c) => c.name);
  if (rosterCols.includes("leave_json")) {
    const legacy = db.prepare("SELECT owna_id, week_starting, leave_json FROM roster_weekly WHERE leave_json LIKE '%\"staff\":\"%' OR leave_json LIKE '%leavetype%'").all();
    if (legacy.length) {
      const write = db.prepare("UPDATE roster_weekly SET leave_json = ? WHERE owna_id = ? AND week_starting = ?");
      db.transaction(() => { for (const r of legacy) write.run(JSON.stringify(leaveTotals(r.leave_json)), r.owna_id, r.week_starting); })();
      console.log(`[init] rewrote ${legacy.length} roster week(s) of leave detail as per-day hours — no staff name, no leave type`);
      deidentified = true;
    }
  }
  // Dropping a column, clearing it or rewriting a key only changes the rows SQL can see: SQLite leaves the
  // old bytes on the freed pages of the database file and in the WAL, where `strings` still reads them, and
  // secure_delete is off by default. So the de-identification is not finished until the space is reclaimed
  // — fold the WAL back and truncate it, then rewrite the file — otherwise the names stay recoverable from
  // the file and from every backup taken after the migration. This has to cover the databases that were
  // already migrated by the earlier release as well as the ones still carrying the columns, so it runs once
  // per database, recorded in user_version (this dashboard uses that pragma for nothing else), and never on
  // a boot that has nothing to reclaim — a normal boot must not rewrite the database every time.
  const RECLAIM_STAMP = 2; // bump if a later migration frees name-bearing pages again (2: the LineLeader
                           // pipeline tables and the roster's leave detail joined child_exits)
  const stamped = db.pragma("user_version", { simple: true }) >= RECLAIM_STAMP;
  // A database stamped by the EARLIER release has already had child_exits reclaimed, but its pipeline and
  // roster pages are still in the file — so "has this stamp" is the only thing that clears a database, and
  // any of the name-bearing tables holding rows is enough to have to reclaim again.
  const hadRows = () => NAME_COLUMNS.concat([["roster_weekly"]]).some(([t]) => {
    try { return !!db.prepare(`SELECT 1 FROM ${t}`).get(); } catch { return false; }
  });
  const mayHoldResidue = deidentified || (!stamped && hadRows());
  if (mayHoldResidue) {
    try {
      db.pragma("secure_delete = ON"); // later deletions zero their pages instead of leaving them readable
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      db.pragma("wal_checkpoint(TRUNCATE)"); // apply the rewrite to the file itself, not just to a new WAL
      db.pragma(`user_version = ${RECLAIM_STAMP}`);
      console.log("[init] reclaimed the freed pages (WAL checkpoint + VACUUM) so removed names are not recoverable from the database file");
    } catch (e) {
      // Leave the stamp unset so the next boot retries, but do not take the dashboard down over housekeeping.
      console.error(`[init] COULD NOT reclaim the freed pages (${e.message}) — removed names may still be readable in the database file; retrying next boot`);
    }
  } else if (!stamped) {
    db.pragma(`user_version = ${RECLAIM_STAMP}`); // nothing was ever stored here to leave behind
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

module.exports = { initSchema, leaveTotals };
