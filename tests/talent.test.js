// Talent pipeline tests — Employment Hero people counted per centre per month.
// Harness mirrors tests/week2.test.js: temp DB via DB_PATH, fixture users, app.listen(0), and freeze()
// moves the APP's clock through services/calendar.js only (never the global Date, which deadlocks the
// runner by stopping the timers Node's fetch ages its sockets on).
//
// The Employment Hero client is stubbed in full — no network, no credentials, no live tenant.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-talent-'));
process.env.DB_PATH = path.join(dir, 'test.db'); process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'test-admin@example.test'; process.env.ADMIN_DEFAULT_PASSWORD = 'FixturePasswordOnly!';
process.env.SESSION_SECRET = 'fixture-session-only';
const db = require('../db/db'), bcrypt = require('bcryptjs');
const pass = 'FixturePasswordOnly!';
for (const [id, name] of [['a', 'Centre Alpha'], ['b', 'Centre Beta']]) db.prepare('INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,100,0)').run(id, name);
for (const role of ['viewer', 'centre', 'exec', 'admin']) db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)').run(role + '@example.test', role, bcrypt.hashSync(pass, 4), role, role === 'centre' ? 'a' : null);

const cal = require('../services/calendar');
const m = require('../services/metrics');
const talent = require('../services/eh-talent');
const { eh } = require('../services/eh');

const FROZEN = '2026-06-15T02:00:00Z'; // midday on Monday 15 June 2026 in Sydney
function freeze(iso, fn) {
  cal.setNow(iso);
  const restore = () => { cal.setNow(null); };
  let out; try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
  restore(); return out;
}

// ===== The stubbed payroll tenant =====
// Names, ids and dates of birth are deliberately distinctive strings so a test can prove none of them
// reaches the database. Nothing here is a real person.
const NAME_MARKERS = ['Qwertius', 'Zzyzxson', 'Vrelkonia', '1987-07-07'];
const ID_MARKER = 987654321; // a payroll id no count could coincidentally equal
const LOCATIONS = [
  { id: 1, name: 'Org', parentId: null },
  { id: 2, name: 'Centre Alpha', parentId: 1 },
  { id: 3, name: 'Centre Beta', parentId: 1 },
  { id: 4, name: 'Alpha Kitchen', parentId: 2 },
  { id: 5, name: 'HQ', parentId: 1 },
];
const ALPHA = 'Org / Centre Alpha', BETA = 'Org / Centre Beta', KITCHEN = 'Org / Centre Alpha / Alpha Kitchen', HQ = 'Org / HQ';
let nextId = 100;
function emp(o) {
  return Object.assign({
    id: o.id != null ? o.id : ++nextId,
    firstName: 'Qwertius', surname: 'Zzyzxson', preferredName: 'Vrelkonia', dateOfBirth: '1987-07-07',
    emailAddress: 'qwertius.zzyzxson@example.invalid', taxFileNumber: '123456789',
    status: 'Active', employmentType: 'Full Time', endDate: null, terminationReason: null,
    jobTitle: 'Early Childhood Educator', primaryLocation: ALPHA,
  }, o);
}
// The five reasons this tenant uses, plus a sixth code the dashboard has never seen.
const LEAVER_REASONS = ['Voluntary cessation', 'Contract cessation', 'Dismissal', 'Redundancy', 'Ill health', 'Gardening leave'];
const EMPLOYEES = [
  // --- Centre Alpha, still here ---
  emp({ id: ID_MARKER, startDate: '2024-01-15', jobTitle: 'Early Childhood Teacher' }),
  emp({ startDate: '2024-02-15', jobTitle: 'Educational Leader' }),
  emp({ startDate: '2024-03-15', jobTitle: 'Early Childhood Educator' }),
  // --- Centre Alpha, left in May 2026, one per cessation code ---
  ...LEAVER_REASONS.map((reason, i) => emp({
    status: 'Terminated', startDate: '2025-01-06', endDate: `2026-05-${String(20 + i).padStart(2, '0')}`,
    terminationReason: reason,
  })),
  // --- A CASUAL who left in May: in the raw termination count, never in turnover ---
  emp({ employmentType: 'Casual', status: 'Terminated', startDate: '2025-03-01', endDate: '2026-05-28', terminationReason: 'Voluntary cessation' }),
  // --- A casual still working, filed against Centre Beta in payroll: group headcount only ---
  emp({ employmentType: 'Casual', startDate: '2025-02-01', primaryLocation: BETA }),
  // --- Never started: end date IS the start date. Not a leaver, not in headcount ---
  emp({ status: 'Terminated', startDate: '2026-05-04', endDate: '2026-05-04', terminationReason: 'Voluntary cessation' }),
  // --- Fourteen days of tenure, then left. This IS turnover ---
  emp({ employmentType: 'Part Time', status: 'Terminated', startDate: '2026-05-01', endDate: '2026-05-15', terminationReason: 'Voluntary cessation' }),
  // --- Centre Beta: three permanent staff and not one termination, ever ---
  emp({ startDate: '2024-04-01', primaryLocation: BETA, jobTitle: 'Early Childhood Teacher' }),
  emp({ startDate: '2024-05-01', primaryLocation: BETA, jobTitle: 'Room Leader' }),
  // A chef filed against Alpha's kitchen: payroll's own hierarchy rolls that up to Centre Alpha,
  // exactly as it does for wages, so this person must land at Alpha and not in a fourth bucket.
  emp({ startDate: '2024-06-01', primaryLocation: KITCHEN, jobTitle: 'Chef' }),
  // --- Support office: a real person at a payroll location that is not a centre ---
  emp({ startDate: '2024-02-01', primaryLocation: HQ, jobTitle: 'CFO' }),
];

function stubPayroll(employees = EMPLOYEES) {
  const saved = { hasCreds: eh.hasCreds, allEmployees: eh.allEmployees, locations: eh.locations };
  eh.hasCreds = () => true;
  eh.allEmployees = async () => employees.map((e) => ({ ...e }));
  eh.locations = async () => LOCATIONS.map((l) => ({ ...l }));
  return () => Object.assign(eh, saved);
}

const app = require('../server');
let server, base;
async function login(role) { const r = await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ email: role + '@example.test', password: pass }), redirect: 'manual' }); assert.equal(r.status, 302); return r.headers.get('set-cookie').split(';')[0]; }
async function page(url, cookie) { const r = await fetch(base + url, { headers: { cookie }, redirect: 'manual' }); assert.equal(r.status, 200, url + ' ' + r.status); return r.text(); }

const groupRow = (month) => db.prepare('SELECT * FROM talent_group_monthly WHERE month=?').get(month);
const centreRow = (owna, month) => db.prepare('SELECT * FROM talent_monthly WHERE owna_id=? AND month=?').get(owna, month);
const reasonsFor = (owna, month) => db.prepare('SELECT reason_key, reason_label, leavers FROM talent_reasons_monthly WHERE owna_id=? AND month=? ORDER BY reason_key').all(owna, month);

test('Talent pipeline — payroll people, counted', async (t) => {
  server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r)); base = 'http://127.0.0.1:' + server.address().port;
  const restore = stubPayroll();
  let summary;
  try {

    await t.test('classification: one primary role each, and an educator is never read as a teacher', () => {
      assert.equal(talent.roleOf('Early Childhood Educator'), 'educator');
      assert.equal(talent.roleOf('Early Childhood Educator Trainee'), 'educator');
      assert.equal(talent.roleOf('Early Childhood Teacher'), 'ect');
      assert.equal(talent.roleOf('Early Childhood Teachers'), 'ect');
      assert.equal(talent.roleOf('ECT Room Leader'), 'ect', 'a teacher who leads a room is counted once, as a teacher');
      assert.equal(talent.roleOf('Educational Leader'), 'edu_leader');
      assert.equal(talent.roleOf('Room Leader'), 'room_leader');
      assert.equal(talent.roleOf('Centre Manager'), 'management');
      assert.equal(talent.roleOf('Assistant to Executive Chef'), 'support', 'kitchen first: this is not an assistant educator');
      assert.equal(talent.roleOf('Cleaner'), 'support');
      assert.equal(talent.roleOf('Maintenance Officer'), 'support');
      assert.equal(talent.roleOf(''), 'other');
      assert.equal(talent.roleOf('Interpretive Dance Consultant'), 'other', 'an unrecognised title is carried as "other", never dropped');
    });

    await t.test('the exclusions are tests of the dates and the type, never of tenure', () => {
      assert.equal(talent.isCasual({ employmentType: 'Casual' }), true);
      assert.equal(talent.isCasual({ employmentType: 'Part Time' }), false);
      assert.equal(talent.neverStarted({ startDate: '2026-05-04', endDate: '2026-05-04' }), true, 'same day = never worked a day');
      assert.equal(talent.neverStarted({ startDate: '2026-05-04', endDate: '2026-05-01' }), true, 'ended before it began');
      assert.equal(talent.neverStarted({ startDate: '2026-05-01', endDate: '2026-05-15' }), false, 'a fortnight IS tenure');
      assert.equal(talent.neverStarted({ startDate: '2026-05-01', endDate: '2026-05-02' }), false, 'one day worked is still a day worked');
      assert.equal(talent.neverStarted({ startDate: '2026-05-01', endDate: null }), false);
    });

    await t.test('cessation codes: the known set groups, an unknown one keeps its own name', () => {
      assert.deepEqual(talent.reasonOf('Voluntary cessation'), { key: 'voluntary', label: 'Voluntary cessation', voluntary: true });
      assert.equal(talent.reasonOf('  voluntary   CESSATION ').key, 'voluntary', 'spacing and case are payroll noise, not a new code');
      assert.equal(talent.reasonOf('Contract cessation').key, 'contract');
      assert.equal(talent.reasonOf('Dismissal').key, 'dismissal');
      assert.equal(talent.reasonOf('Redundancy').key, 'redundancy');
      assert.equal(talent.reasonOf('Ill health').key, 'ill_health');
      // In the ATO set but unused by this tenant: they must not break anything the day they appear.
      assert.equal(talent.reasonOf('Transfer').key, 'transfer');
      assert.equal(talent.reasonOf('Deceased').key, 'deceased');
      // And a code nobody has seen is carried, not dropped into someone else's total.
      const unknown = talent.reasonOf('Gardening leave');
      assert.equal(unknown.key, 'other:gardening_leave');
      assert.equal(unknown.label, 'Gardening leave');
      assert.equal(unknown.voluntary, false, 'an unknown code is never counted as a resignation');
      assert.equal(talent.reasonOf(null).key, 'not_recorded');
      assert.equal(talent.reasonOf('').key, 'not_recorded');
    });

    await t.test('the snapshot runs from the stub and writes counts', async () => {
      summary = await freeze(FROZEN, () => talent.runTalentSnapshot({ log: () => {} }));
      assert.equal(summary.ok, true);
      assert.equal(summary.employees, EMPLOYEES.length);
      assert.equal(summary.to, '2026-06');
      assert.ok(summary.rows > 0);
    });

    await t.test('a casual leaver is in the raw termination count and in no turnover figure', () => {
      const may = groupRow('2026-05');
      // Nine terminations dated in May: six coded leavers, one casual, one never-started, one fortnight.
      assert.equal(may.raw_terminations, 9);
      assert.equal(may.casual_leavers, 1);
      assert.equal(may.never_started, 1);
      assert.equal(may.leavers, 7, 'turnover = raw less the casual less the never-started');
      // The reconciliation the page prints, asserted as arithmetic rather than as prose.
      assert.equal(may.leavers, may.raw_terminations - may.casual_leavers - may.never_started);
      // And the casual is not hiding inside the centre's leavers either.
      assert.equal(centreRow('a', '2026-05').leavers, 7);
    });

    await t.test('someone who never started is excluded; a fortnight of tenure is included', () => {
      const may = groupRow('2026-05');
      assert.equal(may.never_started, 1);
      assert.equal(centreRow('a', '2026-05').never_started, 1, 'the exclusion is shown per centre, not swallowed');
      // The never-started person is in no reason row; the 14-day one is, as a voluntary cessation.
      const rs = reasonsFor('a', '2026-05');
      const voluntary = rs.find((r) => r.reason_key === 'voluntary');
      assert.equal(voluntary.leavers, 2, 'one coded voluntary leaver plus the fortnight, and NOT the never-started');
      assert.equal(rs.reduce((a, r) => a + r.leavers, 0), 7, 'every turnover event has a reason row');
      // Never-started is excluded from the denominator too: they are in no month's headcount.
      const heads = db.prepare('SELECT COALESCE(SUM(headcount),0) n FROM talent_monthly WHERE month=?').get('2026-05').n;
      assert.equal(heads, groupRow('2026-05').headcount);
    });

    await t.test('the five reasons group correctly and the unknown sixth is carried', () => {
      const rs = reasonsFor('a', '2026-05');
      const byKey = Object.fromEntries(rs.map((r) => [r.reason_key, r.leavers]));
      assert.equal(byKey.voluntary, 2);       // the coded one + the fortnight
      assert.equal(byKey.contract, 1);
      assert.equal(byKey.dismissal, 1);
      assert.equal(byKey.redundancy, 1);
      assert.equal(byKey.ill_health, 1);
      assert.equal(byKey['other:gardening_leave'], 1, 'a code the dashboard has never seen is still counted');
      assert.equal(rs.find((r) => r.reason_key === 'other:gardening_leave').reason_label, 'Gardening leave');
      assert.equal(rs.length, 6);
    });

    await t.test('casuals appear in no per-centre figure at all', () => {
      const cols = db.prepare('PRAGMA table_info(talent_monthly)').all().map((c) => c.name);
      assert.equal(cols.filter((c) => /casual/i.test(c)).length, 0, 'the per-centre table must not even have a casual column');
      const reasonCols = db.prepare('PRAGMA table_info(talent_reasons_monthly)').all().map((c) => c.name);
      assert.equal(reasonCols.filter((c) => /casual/i.test(c)).length, 0);
      // The working casual is filed against Centre Beta in payroll. Beta's headcount is its three
      // permanent staff and nothing else, and the casual is counted once, group-wide.
      assert.equal(centreRow('b', '2026-06').headcount, 2, 'Beta holds only its own permanent staff');
      assert.equal(groupRow('2026-06').casual_headcount, 1);
      const perCentre = db.prepare('SELECT COALESCE(SUM(headcount),0) n FROM talent_monthly WHERE month=?').get('2026-06').n;
      assert.equal(perCentre, groupRow('2026-06').headcount, 'the centres sum to the permanent group headcount, with no casual anywhere in it');
      // Nothing in any per-centre row can be traced to a casual: the casual leaver of May is absent.
      const alphaMayReasons = reasonsFor('a', '2026-05').reduce((a, r) => a + r.leavers, 0);
      assert.equal(alphaMayReasons, groupRow('2026-05').leavers);
    });

    await t.test('a centre with no terminations reads 0, not blank', () => {
      const rep = freeze(FROZEN, () => m.talentReport(null, 24));
      const beta = rep.centres.find((c) => c.owna_id === 'b');
      assert.equal(beta.leavers12, 0);
      assert.equal(beta.never_started12, 0);
      assert.equal(typeof beta.leavers12, 'number', '0 is a measurement; null or "" is not');
      assert.equal(beta.turnover12, 0, 'no leavers against a real headcount is 0%, not unknown');
      // And every listed cessation code reads 0 rather than vanishing when nobody used it.
      const transfer = rep.reasons.find((r) => r.key === 'transfer');
      assert.ok(transfer, 'an ATO code this tenant has never used is still listed');
      assert.equal(transfer.all, 0);
      assert.equal(transfer.last12, 0);
    });

    await t.test('the role mix adds up to the headcount, per centre and for the group', () => {
      const rep = freeze(FROZEN, () => m.talentReport(null, 24));
      for (const c of rep.centres) {
        const sum = c.roles.reduce((a, r) => a + r.n, 0);
        assert.equal(sum, c.headcount, `${c.name}: the role columns must add to the headcount`);
      }
      const alpha = rep.centres.find((c) => c.owna_id === 'a');
      assert.equal(alpha.ect, 1); assert.equal(alpha.edu_leader, 1); assert.equal(alpha.educator, 1);
      assert.equal(alpha.headcount, 4); // three educators/teachers plus the kitchen chef
      const beta = rep.centres.find((c) => c.owna_id === 'b');
      assert.equal(beta.ect, 1); assert.equal(beta.room_leader, 1);
      // The chef sits at "Alpha Kitchen", which rolls up to its centre exactly as payroll's own
      // hierarchy does for wages — no second, disagreeing mapping.
      assert.equal(alpha.support, 1);
      // A payroll location that is not a centre still holds its people, so the group is the sum of
      // its parts rather than quietly short.
      const hq = rep.centres.find((c) => c.owna_id === talent.NO_CENTRE);
      assert.ok(hq && hq.headcount === 1 && hq.is_group_bucket);
      assert.equal(rep.centres.reduce((a, c) => a + c.headcount, 0), rep.group.headcount);
    });

    await t.test('no name, employee id or date of birth reaches the database', () => {
      const rows = [
        ...db.prepare('SELECT * FROM talent_monthly').all(),
        ...db.prepare('SELECT * FROM talent_group_monthly').all(),
        ...db.prepare('SELECT * FROM talent_reasons_monthly').all(),
      ];
      assert.ok(rows.length > 0, 'there must be rows for this to prove anything');
      const dump = JSON.stringify(rows);
      for (const marker of NAME_MARKERS) assert.ok(!dump.includes(marker), `"${marker}" reached the talent tables`);
      assert.ok(!dump.includes(String(ID_MARKER)), 'an Employment Hero employee id reached the talent tables');
      assert.ok(!dump.includes('example.invalid'), 'a staff email address reached the talent tables');
      assert.ok(!dump.includes('123456789'), 'a tax file number reached the talent tables');
      // Not just these tables — nowhere in the file. The whole database is searched, so a future
      // column, index or health row cannot smuggle a name in behind this test's back.
      const bytes = fs.readFileSync(process.env.DB_PATH);
      for (const marker of NAME_MARKERS.concat([String(ID_MARKER), 'example.invalid'])) {
        assert.ok(!bytes.includes(Buffer.from(marker)), `"${marker}" is present somewhere in the database file`);
      }
      // Every column of the per-centre table is a count, a centre or a month — nothing else.
      const cols = db.prepare('PRAGMA table_info(talent_monthly)').all().map((c) => c.name);
      assert.deepEqual(cols.filter((c) => /name|email|dob|birth|employee|staff_id/i.test(c)), []);
    });

    await t.test('re-running rebuilds rather than doubles, and a correction can take a count down', async () => {
      const before = groupRow('2026-05');
      const again = await freeze(FROZEN, () => talent.runTalentSnapshot({ log: () => {} }));
      assert.deepEqual(groupRow('2026-05'), { ...before, updated_at: groupRow('2026-05').updated_at });
      assert.equal(again.turnover_leavers, summary.turnover_leavers);
      // Payroll reverses one termination: the count must fall, which an upsert alone could not do.
      const corrected = EMPLOYEES.filter((e) => e.terminationReason !== 'Dismissal');
      const undo = stubPayroll(corrected);
      try {
        await freeze(FROZEN, () => talent.runTalentSnapshot({ log: () => {} }));
        assert.equal(groupRow('2026-05').leavers, 6, 'a reversed termination must take the count back down');
        assert.equal(reasonsFor('a', '2026-05').find((r) => r.reason_key === 'dismissal'), undefined);
      } finally { undo(); }
      await freeze(FROZEN, () => talent.runTalentSnapshot({ log: () => {} }));
      assert.equal(groupRow('2026-05').leavers, 7, 'and back again when payroll is restored');
    });

    await t.test('no payroll credentials is a skip, not a failure', async () => {
      const saved = eh.hasCreds; eh.hasCreds = () => false;
      try {
        const r = await talent.runTalentSnapshot({ log: () => {} });
        assert.equal(r.skipped, true);
        assert.match(r.reason, /credentials/);
        assert.equal(groupRow('2026-05').leavers, 7, 'and it leaves the last good counts alone');
      } finally { eh.hasCreds = saved; }
    });

    await t.test('the People & Culture page states the basis and prints the reconciliation', async () => {
      const cookie = await login('admin');
      const html = await freeze(FROZEN, () => page('/pc', cookie));
      // The sentence the owner asked for, so nobody reads the absent "Resignation" row as missing data.
      assert.match(html, /no separate .resignation. code in payroll/i);
      assert.match(html, /Voluntary cessation/);
      // The reconciliation, traceable rather than asserted: raw, less casuals, less never-started.
      assert.match(html, /less casual employees/i);
      assert.match(html, /on or before their start date/i);
      assert.match(html, /Turnover events/);
      // The casual rule, stated where the per-centre table is.
      assert.match(html, /no casual appears in this table/i);
      assert.match(html, /administrative home/i);
      // Group casual headcount appears exactly once as a figure, at group level.
      assert.match(html, /Casuals/);
      assert.match(html, /group-wide only/i);
      // Codes never used still read 0.
      assert.match(html, /Transfer/); assert.match(html, /Deceased/);
      // And the unknown code is on the page under its own name.
      assert.match(html, /Gardening leave/);
      // No name from payroll is anywhere on the page.
      for (const marker of NAME_MARKERS) assert.ok(!html.includes(marker), `"${marker}" was rendered`);
      assert.ok(!html.includes(String(ID_MARKER)));
    });

    await t.test('payroll no longer reports a turnover PERCENTAGE anywhere, and nothing compares two', async () => {
      // Changed 16 September 2026. Turnover used to be reported from two sources — the HR spreadsheet
      // and payroll — labelled by basis so neither silently stood in for the other, with the comparison
      // on the P&C admin page. The owner now ENTERS turnover himself (tests/turnover-entry.test.js),
      // because payroll records that someone left but cannot know whether the business counts it. So
      // there is one figure, it is his, and there is nothing left to compare: the payroll percentage is
      // off /pc and the comparison card is off /admin/pc. Payroll's leaver COUNTS and the breakdown by
      // cessation code stay — they answer why people left, which no entered number does.
      db.prepare("INSERT INTO pc_metrics (owna_id, month, turnover, headcount, updated_at) VALUES ('a','2026-05',12.5,40,datetime('now'))").run();
      db.prepare("INSERT INTO pc_metrics (owna_id, month, turnover, headcount, updated_at) VALUES ('b','2026-05',8.5,30,datetime('now'))").run();
      assert.equal(typeof m.talentTurnoverSources, 'undefined', 'the two-source reporter is gone');

      const rep = freeze(FROZEN, () => m.talentReport(null, 1));
      const cookie = await login('exec');
      const html = await freeze(FROZEN, () => page('/pc', cookie));
      assert.doesNotMatch(html, /Turnover has two sources/);
      assert.ok(!html.includes(rep.group.turnover12 + '%'), "payroll's rate is not printed on the page");
      // What payroll still answers is on the page, unchanged.
      assert.match(html, /Leavers 12m/);
      assert.match(html, /Why people left/i);
      assert.match(html, /Voluntary cessation/);

      const adminCookie = await login('admin');
      const adminHtml = await freeze(FROZEN, () => page('/admin/pc', adminCookie));
      assert.doesNotMatch(adminHtml, /this spreadsheet vs payroll/i, 'nothing left to compare');
      assert.ok(!adminHtml.includes('10.5%'), 'the spreadsheet average is not reported either');
      assert.match(adminHtml, /Turnover — enter the numbers/, 'the owner enters it here instead');
    });

    await t.test('a centre-scoped user sees their centre and no group or casual figure', async () => {
      const cookie = await login('centre'); // scoped to Centre Alpha
      const html = await freeze(FROZEN, () => page('/pc', cookie));
      assert.match(html, /Talent — counted from payroll/);
      assert.match(html, /Centre Alpha/);
      assert.ok(!html.includes('Centre Beta'), 'a scoped user must not see another centre');
      assert.ok(!/group-wide only/i.test(html), 'the group casual headcount is a group figure, not theirs');
      assert.ok(!/>Group</.test(html), 'no group total row');
      // But the rule is still explained where their numbers are, so the missing casuals are not a mystery.
      assert.match(html, /Casual/);
      assert.match(html, /counted once group-wide/i);
      assert.match(html, /on or before their start date/i);
      const rep = freeze(FROZEN, () => m.talentReport('a', 24));
      assert.equal(rep.centres.length, 1);
      assert.equal(rep.centres[0].owna_id, 'a');
    });

    await t.test('a viewer sees the aggregates and no name', async () => {
      const cookie = await login('viewer');
      const html = await freeze(FROZEN, () => page('/pc', cookie));
      assert.match(html, /Talent — counted from payroll/);
      assert.match(html, /Permanent headcount/);
      for (const marker of NAME_MARKERS) assert.ok(!html.includes(marker));
    });

    await t.test('the nightly snapshot records the talent step in source_sync', async () => {
      const snap = require('../services/snapshot');
      const r = await freeze(FROZEN, () => talent.runTalentSnapshot({ log: () => {} }));
      snap.recordSync('talent', 'ok', `${r.terminations} terminations less ${r.casual_leavers} casual less ${r.never_started} never started = ${r.turnover_leavers} turnover events`, { rows: r.rows, meta: { turnover_leavers: r.turnover_leavers } });
      const row = snap.sourceSyncFor('talent');
      assert.equal(row.status, 'ok');
      assert.match(row.detail, /terminations less 1 casual less 1 never started = 7 turnover events/);
      for (const marker of NAME_MARKERS) assert.ok(!row.detail.includes(marker), 'the health row must carry counts, never a person');
    });

  } finally {
    restore();
    // server.close() only stops the listener and then waits for every open connection; Node's fetch
    // keeps sockets alive, so they are closed explicitly first or this file hangs after passing.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
    require('../middleware/session').store.stopPruning();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
