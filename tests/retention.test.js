// Retention purge tests — services/retention.js, the periods the owner approved on 14 September 2026.
//
// Harness mirrors tests/week2.test.js: a temp DB via DB_PATH set before db/db.js is required, and the
// APP's clock moved with cal.setNow() rather than the global Date (a global Date swap stops Node's
// fetch keep-alive timers and hangs the runner — see the note in week2.test.js).
//
// What these tests are actually defending: a purge that deletes too much is unrecoverable. So every
// boundary is pinned to a literal date, and the "keep it if you cannot prove it is past its period"
// rule is tested from both sides — an unparseable date, and a shaped-but-impossible one.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-retention-'));
const FIXTURE_ENV = {
  NODE_ENV: 'test',
  ADMIN_EMAIL: 'test-admin@example.test',
  ADMIN_DEFAULT_PASSWORD: 'FixturePasswordOnly!',
  SESSION_SECRET: 'fixture-session-only',
};
Object.assign(process.env, FIXTURE_ENV);
process.env.DB_PATH = path.join(dir, 'test.db');

const db = require('../db/db');           // runs dotenv.config() and builds the schema
const ret = require('../services/retention');
const cal = require('../services/calendar');

// Clear any RETAIN_* inherited from the developer's own .env — AFTER db/db.js has run dotenv, so a
// local experiment cannot put a different period under these assertions. Each test that wants an
// override sets it explicitly and deletes it again.
const clearOverrides = () => { for (const v of Object.values(ret.ENV)) delete process.env[v]; };
clearOverrides();

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Move the APP's clock for the duration of fn. Restores even if fn throws. Same contract as
// week2.test.js's freeze(), deliberately: one way to do this in the suite.
function freeze(iso, fn) {
  cal.setNow(iso);
  try { return fn(); } finally { cal.setNow(null); }
}

// The instant every boundary below is measured from: 09:00 on 14 September 2026 in Sydney, which is
// still 13 September in UTC. Stated as UTC so the test does not depend on the host's zone, and chosen
// inside that ten-hour window on purpose — a purge that measured its cutoffs from a UTC "today" would
// keep a day too much here, and every boundary below would be off by one.
const AT = '2026-09-13T23:00:00Z', TODAY = '2026-09-14';

const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
const keys = (t, col) => db.prepare(`SELECT ${col} k FROM ${t} ORDER BY ${col}`).all().map((r) => r.k);
const wipe = () => { for (const t of ret.TABLES) db.exec(`DELETE FROM ${t}`); };

// Fixture writers. Every one takes the date that decides its fate, so a test reads as a list of dates.
const addBriefing = (key, created_at) =>
  db.prepare(`INSERT INTO ai_briefings(period_key,period_from,period_to,content,model,created_at)
              VALUES(?,?,?,?,?,?)`).run(key, '2026-01-01', '2026-01-07', `BRIEFING-BODY-${key}`, 'test-model', created_at);
const addFeedback = (msg, status, reviewed_at, created_at = '2020-01-01 00:00:00') =>
  db.prepare(`INSERT INTO feedback(created_at,user_email,user_name,user_role,area,category,rating,message,page,status,reviewed_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(created_at, 'someone@example.test', 'Someone', 'centre', 'Overview', 'idea', 4, msg, '/', status, reviewed_at);
const addRun = (started_at, note) =>
  db.prepare(`INSERT INTO snapshot_runs(started_at,finished_at,status,rows_written,note)
              VALUES(?,?,?,?,?)`).run(started_at, started_at, 'ok', 1, note);
const addExit = (child_key, finish_date) =>
  db.prepare(`INSERT INTO child_exits(owna_id,child_key,room,start_date,finish_date,tenure_days,upcoming,updated_at)
              VALUES(?,?,?,?,?,?,0,datetime('now'))`).run('a', child_key, 'Toddlers', '2019-01-01', finish_date, 400);
const addExitMonth = (month, departures = 3) =>
  db.prepare(`INSERT INTO exits_monthly(owna_id,month,room,upcoming,departures,tenure_days_sum,tenure_n,updated_at)
              VALUES(?,?,'',0,?,0,0,datetime('now'))`).run('a', month, departures);

test('Retention purge — the owner\'s periods of 14 September 2026', async (t) => {
 try {

  // ---------------------------------------------------------------------------------------------
  await t.test('the frozen instant is the Sydney date these boundaries are measured from', () => {
    // If this stops holding, every literal date below is proving nothing.
    freeze(AT, () => assert.equal(cal.today(), TODAY));
    assert.equal(new Date(AT).toISOString().slice(0, 10), '2026-09-13', 'the same instant is still yesterday in UTC');
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('the whole job runs clean against an empty database', () => {
    for (const tbl of ret.TABLES) assert.equal(count(tbl), 0, `${tbl} should start empty`);
    const lines = [];
    const r = freeze(AT, () => ret.runPurge({ log: (s) => lines.push(s) }));
    assert.equal(r.total, 0);
    for (const tbl of ret.TABLES) assert.equal(r.removed[tbl], 0, tbl);
    assert.match(r.detail, /nothing past its period/);
    // It still says what it looked at, so an empty run is distinguishable from a run that did not happen.
    for (const tbl of ret.TABLES) assert.ok(lines.join('\n').includes(tbl), `${tbl} missing from the log`);
    // Nothing to delete means nothing to reclaim: no VACUUM on an empty run.
    assert.equal(r.reclaimedBytes, null);
    assert.equal(r.reclaimError, null);
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('the periods live in one place, as the owner\'s numbers', () => {
    assert.deepEqual({ ...ret.DEFAULTS }, {
      aiBriefingMonths: 12,   // AI briefings 12 months
      feedbackMonths: 12,     // staff feedback 12 months after review
      runLogDays: 90,         // nightly run logs 90 days
      exitDetailMonths: 24,   // exit detail 2 years
      exitAggregateMonths: 84, // exit aggregate 7 years
    });
    // "ONE place" is only true if nothing else reads a RETAIN_* variable or hard-codes a period.
    const owners = fs.readdirSync(path.join(ROOT, 'services')).filter((f) => f.endsWith('.js'))
      .filter((f) => /RETAIN_[A-Z_]+/.test(read(`services/${f}`)));
    assert.deepEqual(owners, ['retention.js'], 'a retention period escaped services/retention.js');

    // (b) documented where a deployment can change them.
    const yaml = read('render.yaml');
    for (const [key, fallback] of Object.entries(ret.DEFAULTS)) {
      const name = ret.ENV[key];
      assert.ok(name, `${key} has no environment variable`);
      assert.match(yaml, new RegExp(`key:\\s*${name}\\s*\\n\\s*value:\\s*${fallback}\\b`),
        `render.yaml must document ${name} at the approved ${fallback}`);
    }
    assert.match(yaml, /14 September 2026/, 'render.yaml must say whose decision these are and when');
    const outstanding = read('docs/outstanding.md');
    for (const name of Object.values(ret.ENV)) assert.ok(outstanding.includes(name), `docs/outstanding.md must list ${name}`);
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('every period boundary: one day older goes, the period itself and one day newer stay', () => {
    wipe();
    // The cutoffs, as literals. A row dated EXACTLY the cutoff is exactly its period old and is KEPT.
    const cut = freeze(AT, () => ret.cutoffs(ret.periods(), cal.today()));
    assert.deepEqual(cut, {
      ai_briefings: '2025-09-14',   // 12 months
      feedback: '2025-09-14',       // 12 months
      snapshot_runs: '2026-06-16',  // 90 days
      child_exits: '2024-09-14',    // 2 years
      exits_monthly: '2019-09',     // 7 years
    });

    addBriefing('out', '2025-09-13 23:59:59'); addBriefing('edge', '2025-09-14 00:00:01'); addBriefing('in', '2025-09-15 10:00:00');
    addFeedback('out', 'reviewed', '2025-09-13 23:59:59'); addFeedback('edge', 'reviewed', '2025-09-14 00:00:01'); addFeedback('in', 'dismissed', '2025-09-15 10:00:00');
    // snapshot_runs: insert oldest first so the newest id really is the newest run, then the "always
    // keep the most recent run" rule cannot accidentally rescue a row this test expects to go.
    addRun('2026-06-15 02:15:00', 'out'); addRun('2026-06-16 02:15:00', 'edge'); addRun('2026-06-17 02:15:00', 'in');
    addExit('out', '2024-09-13'); addExit('edge', '2024-09-14'); addExit('in', '2024-09-15');
    addExitMonth('2019-08'); addExitMonth('2019-09'); addExitMonth('2019-10');

    const r = freeze(AT, () => ret.runPurge({ log: () => {} }));
    assert.equal(r.total, 5, 'exactly one row per table is past its period');
    for (const tbl of ret.TABLES) assert.equal(r.removed[tbl], 1, tbl);
    assert.deepEqual(keys('ai_briefings', 'period_key'), ['edge', 'in']);
    assert.deepEqual(keys('feedback', 'message'), ['edge', 'in']);
    assert.deepEqual(keys('snapshot_runs', 'note'), ['edge', 'in']);
    assert.deepEqual(keys('child_exits', 'child_key'), ['edge', 'in']);
    assert.deepEqual(keys('exits_monthly', 'month'), ['2019-09', '2019-10']);
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('it is safe to run twice', () => {
    // Straight after the boundary test above: the survivors must not move.
    const before = ret.TABLES.map((tbl) => count(tbl));
    const r = freeze(AT, () => ret.runPurge({ log: () => {} }));
    assert.equal(r.total, 0, 'a second run finds nothing left to match');
    assert.deepEqual(ret.TABLES.map((tbl) => count(tbl)), before);
    // And a third, in case anything about the first deletion was one-shot.
    assert.equal(freeze(AT, () => ret.runPurge({ log: () => {} })).total, 0);
    assert.deepEqual(keys('ai_briefings', 'period_key'), ['edge', 'in']);
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('feedback still marked new survives indefinitely, and the clock runs from the review', () => {
    wipe();
    addFeedback('new-and-ancient', 'new', null, '2015-01-01 00:00:00');
    // Triaged before reviewed_at existed: reviewed, but with no review date. Not provably past its
    // period, so it is KEPT rather than guessed at.
    addFeedback('reviewed-but-undated', 'reviewed', null, '2015-01-01 00:00:00');
    // Submitted years ago, read last week. Measured from created_at this would go tonight; measured
    // from the review — which is the period the owner set — it has eleven and a half months to run.
    addFeedback('old-but-just-read', 'reviewed', '2026-09-07 09:00:00', '2015-01-01 00:00:00');
    addFeedback('reviewed-long-ago', 'dismissed', '2025-01-01 09:00:00', '2024-12-01 00:00:00');
    // A status nobody recognises is not "reviewed or dismissed" either.
    addFeedback('odd-status', 'triaged?', '2015-01-01 09:00:00', '2015-01-01 00:00:00');

    const r = freeze(AT, () => ret.runPurge({ log: () => {} }));
    assert.equal(r.removed.feedback, 1);
    assert.deepEqual(keys('feedback', 'message'), ['new-and-ancient', 'odd-status', 'old-but-just-read', 'reviewed-but-undated']);

    // Still there a decade later, because nobody has dealt with it.
    freeze('2036-09-14T02:00:00Z', () => ret.runPurge({ log: () => {} }));
    assert.ok(keys('feedback', 'message').includes('new-and-ancient'), 'a new row must never be deleted');
    assert.ok(keys('feedback', 'message').includes('reviewed-but-undated'), 'an undated review is not provably old');

    // Reviewing it starts the clock; sending it back to new stops it again.
    const id = db.prepare("SELECT id FROM feedback WHERE message='new-and-ancient'").get().id;
    const fb = require('../services/feedback');
    fb.setStatus(id, 'reviewed');
    assert.ok(db.prepare('SELECT reviewed_at FROM feedback WHERE id=?').get(id).reviewed_at, 'review must be dated');
    fb.setStatus(id, 'new');
    assert.equal(db.prepare('SELECT reviewed_at FROM feedback WHERE id=?').get(id).reviewed_at, null, 'back to new clears the clock');
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('the monthly exits aggregate outlives the row-level detail', () => {
    wipe();
    // One departure, three years ago: past the 2-year detail period, well inside the 7-year aggregate.
    addExit('three-years-ago', '2023-05-10');
    addExitMonth('2023-05', 7);
    // And the aggregate's own edge, five years further back.
    addExitMonth('2019-08', 4);

    const r = freeze(AT, () => ret.runPurge({ log: () => {} }));
    assert.equal(r.removed.child_exits, 1, 'the per-child row is past two years');
    assert.equal(r.removed.exits_monthly, 1, 'only the row past seven years');
    assert.equal(count('child_exits'), 0, 'no per-child detail survives its two years');
    assert.deepEqual(keys('exits_monthly', 'month'), ['2023-05'], 'the count survives the detail it came from');
    assert.equal(db.prepare("SELECT departures d FROM exits_monthly WHERE month='2023-05'").get().d, 7,
      'and it still carries the number, so exits-by-year keeps its history');
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('a date it cannot prove is past its period is KEPT, not deleted', () => {
    wipe();
    // Null, empty, prose, and a half-padded date SQLite will not parse. Every one of them is nominally
    // ancient; every one of them must survive, because none of them is provably anything.
    addBriefing('null-date', null);
    addBriefing('empty-date', '');
    addBriefing('prose', 'unknown');
    addBriefing('half-padded', '2015-9-4');
    addFeedback('unparseable-review', 'reviewed', 'sometime last year');
    addRun('not-a-date', 'unparseable');
    addRun('2026-09-13 02:15:00', 'recent');   // so the most-recent-run rule is not what saves the row above
    addExit('no-finish-date', 'unknown');
    addExitMonth('bogus');

    const r = freeze(AT, () => ret.runPurge({ log: () => {} }));
    assert.equal(r.total, 0, 'not one unparseable row may be deleted');
    assert.deepEqual(keys('ai_briefings', 'period_key'), ['empty-date', 'half-padded', 'null-date', 'prose']);
    assert.deepEqual(keys('feedback', 'message'), ['unparseable-review']);
    assert.deepEqual(keys('child_exits', 'child_key'), ['no-finish-date']);
    assert.deepEqual(keys('exits_monthly', 'month'), ['bogus']);
    assert.equal(count('snapshot_runs'), 2);
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('a shaped-but-impossible date normalises FORWARD, so it errs towards keeping', () => {
    wipe();
    // 2025-02-30 does not exist. SQLite's date() rolls it forward to 2025-03-02. Frozen at 30 May
    // 2025 the 90-day run-log cutoff is exactly 2025-03-01, so a naive string comparison
    // ('2025-02-30' < '2025-03-01') would DELETE this row while the normalised comparison
    // ('2025-03-02' < '2025-03-01' is false) KEEPS it. That direction is the whole point.
    const impossible = '2025-02-30 02:15:00';
    freeze('2025-05-30T02:00:00Z', () => {
      assert.equal(cal.today(), '2025-05-30');
      assert.equal(ret.cutoffs(ret.periods(), cal.today()).snapshot_runs, '2025-03-01');
      assert.ok(impossible.slice(0, 10) < '2025-03-01', 'a naive comparison would delete this row');
      addRun(impossible, 'impossible');
      addRun('2025-05-29 02:15:00', 'recent');  // the most recent run, so id is not what saves it
      const r = ret.runPurge({ log: () => {} });
      assert.equal(r.removed.snapshot_runs, 0, 'a date that rolls forward past the cutoff is kept');
    });
    assert.deepEqual(keys('snapshot_runs', 'note'), ['impossible', 'recent']);
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('the most recent run is kept whatever its age, so the status page can still speak', () => {
    wipe();
    addRun('2019-01-01 02:15:00', 'ancient-first');
    addRun('2019-01-02 02:15:00', 'ancient-last');
    const r = freeze(AT, () => ret.runPurge({ log: () => {} }));
    assert.equal(r.removed.snapshot_runs, 1);
    assert.deepEqual(keys('snapshot_runs', 'note'), ['ancient-last'], 'the last run always survives');
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('occupancy, wages and incident numbers are never touched', () => {
    wipe();
    db.prepare("INSERT OR IGNORE INTO centres(owna_id,name,capacity) VALUES('a','Centre Alpha',100)").run();
    db.prepare(`INSERT INTO daily_metrics(owna_id,metric_date,capacity,booked,attended,absent,casual,fee_total)
                VALUES('a','2012-03-04',100,50,48,2,1,900)`).run();
    db.prepare(`INSERT INTO labour_weekly(eh_centre,week_ending,owna_id,total_hours,total_wages)
                VALUES('Futuro Alpha','2012-03-04','a',400,20000)`).run();
    db.prepare(`INSERT INTO incidents_monthly(owna_id,month,total,injuries,reportable,updated_at)
                VALUES('a','2012-03',5,3,0,datetime('now'))`).run();
    // Something old enough to delete, so the purge really does run rather than short-circuit.
    addBriefing('old', '2015-01-01 00:00:00');

    const r = freeze(AT, () => ret.runPurge({ log: () => {} }));
    assert.equal(r.total, 1);
    assert.equal(count('daily_metrics'), 1, 'occupancy is kept indefinitely');
    assert.equal(count('labour_weekly'), 1, 'wages are kept indefinitely');
    assert.equal(count('incidents_monthly'), 1, 'incident numbers are kept indefinitely');
    // The job must not even name them.
    for (const tbl of ['daily_metrics', 'labour_weekly', 'incidents_monthly', 'ccs_payments', 'labour_budget']) {
      assert.ok(!ret.TABLES.includes(tbl), `${tbl} must not be in the purge`);
    }
    db.exec("DELETE FROM daily_metrics; DELETE FROM labour_weekly; DELETE FROM incidents_monthly");
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('it reports counts per table, and never what a deleted row said', () => {
    wipe();
    const SECRET = 'the-air-conditioning-in-room-3-is-broken';
    addFeedback(SECRET, 'reviewed', '2015-01-01 09:00:00');
    addBriefing('leaky', '2015-01-01 00:00:00');   // content is BRIEFING-BODY-leaky
    addExit('a-child', '2015-01-01');
    const lines = [];
    const r = freeze(AT, () => ret.runPurge({ log: (s) => lines.push(s) }));
    const said = lines.join('\n') + '\n' + r.detail;

    assert.equal(r.total, 3);
    assert.deepEqual(r.removed, { ai_briefings: 1, feedback: 1, snapshot_runs: 0, child_exits: 1, exits_monthly: 0 });
    for (const tbl of ret.TABLES) assert.match(r.detail, new RegExp(`${tbl} ${r.removed[tbl]}\\b`), `${tbl} count missing from the detail`);
    assert.match(r.detail, /removed 3 rows/);
    // (d) counts, never content.
    assert.ok(!said.includes(SECRET), 'the feedback message must never reach the log');
    assert.ok(!said.includes('BRIEFING-BODY'), 'the briefing body must never reach the log');
    assert.ok(!said.includes('a-child'), 'a child key must never reach the log');
    assert.ok(!said.includes('someone@example.test'), 'the submitter must never reach the log');
    // source_sync.detail is stored truncated to 240 characters — the counts must fit inside that or
    // the report the status page reads is the half that got cut off.
    assert.ok(r.detail.length <= 240, `detail is ${r.detail.length} chars and would be truncated`);
    assert.match(r.detail, /sessions expire 8h/, 'the run must say sessions are covered elsewhere');
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('a period can be changed by environment variable; a nonsense one is ignored', () => {
    wipe();
    try {
      process.env.RETAIN_RUN_LOG_DAYS = '7';
      addRun('2026-09-06 02:15:00', 'eight-days-old');
      addRun('2026-09-07 02:15:00', 'exactly-seven');
      addRun('2026-09-13 02:15:00', 'yesterday');
      const r = freeze(AT, () => ret.runPurge({ log: () => {} }));
      assert.equal(r.periods.runLogDays, 7, 'the override must be honoured');
      assert.equal(r.removed.snapshot_runs, 1);
      assert.deepEqual(keys('snapshot_runs', 'note'), ['exactly-seven', 'yesterday']);

      // A malformed, zero or negative override must NOT be read as "keep nothing".
      for (const bad of ['ninety', '0', '-5', '12.5', ' ']) {
        process.env.RETAIN_RUN_LOG_DAYS = bad;
        const warned = [];
        const p = ret.periods((s) => warned.push(s));
        assert.equal(p.runLogDays, ret.DEFAULTS.runLogDays, `"${bad}" must fall back to the approved period`);
        if (bad.trim() !== '') assert.equal(warned.length, 1, `"${bad}" must be reported as ignored`);
      }
      process.env.RETAIN_RUN_LOG_DAYS = 'ninety';
      const before = count('snapshot_runs');
      assert.equal(freeze(AT, () => ret.runPurge({ log: () => {} })).removed.snapshot_runs, 0);
      assert.equal(count('snapshot_runs'), before, 'a nonsense period must never empty the table');
    } finally { clearOverrides(); }
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('sessions are confirmed, not swept a second time', () => {
    const { store, MAX_AGE_MS } = require('../middleware/session');
    try {
      // The documented period and the enforced one cannot drift apart silently.
      assert.equal(ret.SESSION_HOURS * 60 * 60 * 1000, MAX_AGE_MS, 'the 8 hours must be the store\'s own');
      // No statement in this job goes anywhere near the table the store owns.
      assert.ok(Object.keys(ret.STATEMENTS).length, 'the statements must be inspectable');
      for (const [tbl, sql] of Object.entries(ret.STATEMENTS)) {
        assert.ok(!/\bsessions\b/i.test(sql), `${tbl} must not touch sessions`);
      }
      assert.ok(!ret.TABLES.includes('sessions'));
      // An expired row is the store's to remove, and the purge leaves it exactly where it found it.
      db.prepare("INSERT INTO sessions(sid,expire,sess) VALUES('purge-test-sid',?,'{}')")
        .run(new Date(Date.now() - 60_000).toISOString());
      const r = freeze(AT, () => ret.runPurge({ log: () => {} }));
      assert.match(r.sessions, /session store/);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE sid='purge-test-sid'").get().n, 1,
        'the purge must not duplicate the store\'s sweep');
      db.prepare("DELETE FROM sessions WHERE sid='purge-test-sid'").run();
    } finally { store.stopPruning(); }
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('the nightly snapshot runs the purge as a best-effort step, last', () => {
    const src = read('services/snapshot.js');
    const purge = src.indexOf('step("retention"');
    const exits = src.indexOf('step("exits"');
    assert.ok(purge > 0, 'the snapshot must run the purge');
    assert.ok(exits > 0 && purge > exits,
      'the purge must come AFTER the exit fold, or a night\'s departures are trimmed before they are counted');
    // It is the last step, so a slow reclaim cannot delay any other source.
    assert.equal(src.slice(purge + 6).indexOf('step("'), -1, 'nothing may be stepped after the purge');
    // It goes through the same best-effort wrapper as every other source, so a failure records an
    // error against "retention" and marks the run partial instead of sinking the whole snapshot.
    assert.match(src, /await step\("retention"/);
    assert.match(src, /const status = problems\.length \? "partial" : "ok";/);
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('scripts/purge-run.js runs on demand and records the run in source_sync', () => {
    // Its own database, so the CLI cannot disturb the fixtures above, and a brand-new file also
    // proves the on-demand job is clean against an empty database.
    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-purge-cli-'));
    const cliDb = path.join(cliDir, 'cli.db');
    try {
      const Database = require('better-sqlite3');
      {
        const d = new Database(cliDb);
        require('../db/init-schema').initSchema(d);
        d.prepare(`INSERT INTO ai_briefings(period_key,period_from,period_to,content,model,created_at)
                   VALUES('ancient','2015-01-01','2015-01-07','BODY','m','2015-01-01 00:00:00')`).run();
        d.prepare(`INSERT INTO ai_briefings(period_key,period_from,period_to,content,model,created_at)
                   VALUES('fresh','2026-09-01','2026-09-07','BODY','m','2026-09-01 00:00:00')`).run();
        d.close();
      }
      const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'purge-run.js')],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...FIXTURE_ENV, DB_PATH: cliDb } });
      assert.match(out, /Retention purge/);
      assert.match(out, /ai_briefings 1/);
      assert.ok(!out.includes('BODY'), 'the CLI must not print what it deleted');

      const d = new Database(cliDb, { readonly: true });
      assert.deepEqual(d.prepare('SELECT period_key k FROM ai_briefings').all().map((r) => r.k), ['fresh']);
      const row = d.prepare("SELECT * FROM source_sync WHERE source='retention'").get();
      assert.ok(row, 'the run must show on the per-source health row');
      assert.equal(row.status, 'ok');
      assert.equal(row.rows, 1);
      assert.match(row.detail, /ai_briefings 1/);
      assert.ok(!row.detail.includes('BODY'), 'source_sync must carry counts, not content');
      assert.deepEqual(JSON.parse(row.meta_json).removed,
        { ai_briefings: 1, feedback: 0, snapshot_runs: 0, child_exits: 0, exits_monthly: 0 });
      d.close();

      // Safe to run twice, from the CLI as well.
      const again = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'purge-run.js')],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...FIXTURE_ENV, DB_PATH: cliDb } });
      assert.match(again, /nothing past its period/);
    } finally { fs.rmSync(cliDir, { recursive: true, force: true }); }
  });

  // ---------------------------------------------------------------------------------------------
  await t.test('npm run purge is wired to the script', () => {
    assert.equal(JSON.parse(read('package.json')).scripts.purge, 'node scripts/purge-run.js');
  });

 } finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
 }
});
