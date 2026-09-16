// Role mix from PAY CLASSIFICATION — the owner's rule of 16 September 2026: a person's role is their
// payRateTemplate, not their job title.
//
// Harness mirrors tests/talent.test.js: temp DB via DB_PATH, fixture users, app.listen(0), and freeze()
// moves the APP's clock through services/calendar.js only (never the global Date, which deadlocks the
// runner by stopping the timers Node's fetch ages its sockets on).
//
// The Employment Hero client is stubbed in full — no network, no credentials, no live tenant.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-payclass-'));
process.env.DB_PATH = path.join(dir, 'test.db'); process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'test-admin@example.test'; process.env.ADMIN_DEFAULT_PASSWORD = 'FixturePasswordOnly!';
process.env.SESSION_SECRET = 'fixture-session-only';
const db = require('../db/db'), bcrypt = require('bcryptjs');
const pass = 'FixturePasswordOnly!';
for (const [id, name] of [['a', 'Centre Alpha'], ['b', 'Centre Beta']]) db.prepare('INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,100,0)').run(id, name);
for (const role of ['viewer', 'centre', 'exec', 'ops_manager', 'admin']) db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)').run(role + '@example.test', role, bcrypt.hashSync(pass, 4), role, role === 'centre' ? 'a' : null);

const cal = require('../services/calendar');
const m = require('../services/metrics');
const talent = require('../services/eh-talent');
const cls = require('../services/classification');
const { eh } = require('../services/eh');

const FROZEN = '2026-06-15T02:00:00Z'; // midday on Monday 15 June 2026 in Sydney
function freeze(iso, fn) {
  cal.setNow(iso);
  const restore = () => { cal.setNow(null); };
  let out; try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
  restore(); return out;
}

// ===== The owner's scales, verbatim =====
const TEACHER = (n) => `Permanent - Teachers - Long Day Care Centres - Level ${n}`;
const CSE1 = 'Permanent CSE Level 1 - Introductory Educator';
const CSE1_17 = 'Permanent CSE Level 1 - Introductory Educator 17 yrs';
const CSE2 = 'Permanent CSE Level 2 - Educator';
const CSE3 = 'Permanent CSE Level 3 - Qualified Educator';
const CSE4 = 'Permanent CSE Level 4 - Experienced Educator';
const CSE5 = 'Permanent CSE Level 5 - Advanced Educator';
const CSE6 = 'Permanent CSE Level 6 - Room Leader';
const CSE7 = 'Permanent CSE Level 7 - Assistant Director';
const CSE8 = 'Permanent CSE Level 8 - Director';
const CAS3 = 'Casual CSE Level 3 - Qualified Educator';
const CAS4 = 'Casual CSE Level 4 - Experienced Educator';
const CAS5 = 'Casual CSE Level 5 - Advanced Educator';
const SW1 = 'Permanent Support Worker L1.1 (On Commencement)';
const SW3 = 'Permanent Support Worker L3.1 (On Commencement)';
const UNSEEN = 'Permanent Interpretive Dance Scale - Level 4'; // a scale no rule maps — must still be counted

// ===== The stubbed payroll tenant =====
// Names, ids and dates of birth are deliberately distinctive strings so a test can prove none of them
// reaches the database. Nothing here is a real person.
const NAME_MARKERS = ['Qwertius', 'Zzyzxson', 'Vrelkonia', '1987-07-07'];
const ID_MARKER = 987654321;
const LOCATIONS = [
  { id: 1, name: 'Org', parentId: null },
  { id: 2, name: 'Centre Alpha', parentId: 1 },
  { id: 3, name: 'Centre Beta', parentId: 1 },
  { id: 5, name: 'HQ', parentId: 1 },
];
const ALPHA = 'Org / Centre Alpha', BETA = 'Org / Centre Beta', HQ = 'Org / HQ';
let nextId = 100;
function emp(o) {
  return Object.assign({
    id: o.id != null ? o.id : ++nextId,
    firstName: 'Qwertius', surname: 'Zzyzxson', preferredName: 'Vrelkonia', dateOfBirth: '1987-07-07',
    emailAddress: 'qwertius.zzyzxson@example.invalid', taxFileNumber: '123456789',
    status: 'Active', employmentType: 'Full Time', startDate: '2024-01-15', endDate: null, terminationReason: null,
    // The job title is deliberately WRONG for everybody: nothing below may fall back to it. If the role
    // mix ever reads the title again, every person lands in "educator" and these tests fail.
    jobTitle: 'Early Childhood Educator', primaryLocation: ALPHA,
  }, o);
}
const EMPLOYEES = [
  // --- Centre Alpha: one person on each of the owner's scales, plus the two that map to nothing ---
  emp({ id: ID_MARKER, payRateTemplate: TEACHER(1) }),   // ECT
  emp({ payRateTemplate: TEACHER(5) }),                  // ECT
  emp({ payRateTemplate: CSE1 }),                        // Trainee
  emp({ payRateTemplate: CSE1_17 }),                     // Trainee — the junior-rate suffix
  emp({ payRateTemplate: CSE2 }),                        // Trainee
  emp({ payRateTemplate: CSE3 }),                        // Cert 3
  emp({ payRateTemplate: CSE4 }),                        // Cert 3
  emp({ payRateTemplate: CSE5 }),                        // Dip
  emp({ payRateTemplate: CSE6 }),                        // Dip
  emp({ payRateTemplate: CSE7 }),                        // Management
  emp({ payRateTemplate: CSE8 }),                        // Management
  emp({ payRateTemplate: SW1 }),                         // Support
  emp({ payRateTemplate: SW3 }),                         // Support
  emp({ payRateTemplate: UNSEEN }),                      // Unclassified — counted, never dropped
  emp({ payRateTemplate: null }),                        // Unclassified — no scale recorded at all
  // --- Centre Beta: a TEACHERS Level 3, which is not a CSE Level 3 ---
  emp({ primaryLocation: BETA, payRateTemplate: TEACHER(3) }),  // ECT, not Cert 3
  emp({ primaryLocation: BETA, payRateTemplate: CSE3 }),        // Cert 3
  // --- A payroll location that is not a centre ---
  emp({ primaryLocation: HQ, payRateTemplate: CSE8 }),          // Management
  // --- Casuals. Payroll files them against a centre; that centre is an administrative home, so they
  //     must appear in NO per-centre figure — only in the one group figure, by category.
  emp({ employmentType: 'Casual', primaryLocation: BETA, payRateTemplate: CAS3 }),   // Cert 3
  emp({ employmentType: 'Casual', primaryLocation: BETA, payRateTemplate: CAS4 }),   // Cert 3
  emp({ employmentType: 'Casual', primaryLocation: BETA, payRateTemplate: CAS5 }),   // Dip
  emp({ employmentType: 'Casual', primaryLocation: ALPHA, payRateTemplate: CAS5 }),  // Dip
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
const MONTH = '2026-06';
const CATS = ['ect', 'dip', 'cert3', 'trainee', 'management', 'support', 'unclassified'];

test('Role mix from pay classification', async (t) => {
  server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r)); base = 'http://127.0.0.1:' + server.address().port;
  const restore = stubPayroll();
  try {

    await t.test("every scale in the owner's list maps as the owner specified", () => {
      for (const n of [1, 2, 3, 4, 5]) assert.equal(cls.categoryOf(TEACHER(n)), 'ect', `Teachers Level ${n} is an ECT`);
      assert.equal(cls.categoryOf(CSE1), 'trainee');
      assert.equal(cls.categoryOf(CSE2), 'trainee');
      assert.equal(cls.categoryOf(CSE3), 'cert3');
      assert.equal(cls.categoryOf(CSE4), 'cert3');
      assert.equal(cls.categoryOf(CSE5), 'dip');
      assert.equal(cls.categoryOf(CSE6), 'dip');
      // The level is matched, not the job words in the scale: CSE Level 6 is called "Room Leader" and
      // is still a Dip, and a Teachers Level 3 is NOT a Cert 3.
      assert.equal(cls.categoryOf(TEACHER(3)), 'ect', 'a teacher scale and a CSE scale share level numbers and nothing else');
      assert.notEqual(cls.categoryOf(TEACHER(3)), cls.categoryOf(CSE3));
      // Every one of them was matched by a rule rather than falling through.
      for (const s of [TEACHER(1), CSE1, CSE2, CSE3, CSE4, CSE5, CSE6]) assert.equal(cls.classify(s).matched, true, s);
    });

    await t.test('a Casual Level N lands in the same category as a Permanent Level N', () => {
      assert.equal(cls.categoryOf(CAS3), cls.categoryOf(CSE3));
      assert.equal(cls.categoryOf(CAS4), cls.categoryOf(CSE4));
      assert.equal(cls.categoryOf(CAS5), cls.categoryOf(CSE5));
      assert.equal(cls.categoryOf(CAS5), 'dip');
      // And the match is on the LEVEL, not on the word "Casual" being stripped: strip it from a teachers
      // scale and it is still a teachers scale, which a CSE rule must never claim.
      assert.equal(cls.categoryOf('Casual - Teachers - Long Day Care Centres - Level 3'), 'ect');
    });

    await t.test('the "17 yrs" junior-rate suffix still matches Level 1', () => {
      assert.equal(cls.categoryOf(CSE1_17), 'trainee');
      assert.equal(cls.categoryOf(CSE1_17), cls.categoryOf(CSE1));
      assert.equal(cls.classify(CSE1_17).level, 1, 'the 17 is a rate suffix, not a level');
      assert.equal(cls.classify(CSE1_17).matched, true);
    });

    await t.test('CSE Level 7 and 8 are Management, not educators', () => {
      assert.equal(cls.categoryOf(CSE7), 'management');
      assert.equal(cls.categoryOf(CSE8), 'management');
    });

    await t.test('Support Worker is Support, and its L-number is never read as a CSE level', () => {
      assert.equal(cls.categoryOf(SW1), 'support');
      assert.equal(cls.categoryOf(SW3), 'support');
      assert.equal(cls.classify(SW1).family, 'support_worker');
      assert.notEqual(cls.categoryOf(SW1), cls.categoryOf(CSE1), 'L1.1 is a support-worker step, not CSE Level 1');
      assert.notEqual(cls.categoryOf(SW3), cls.categoryOf(CSE3));
    });

    await t.test('an unseen scale becomes Unclassified, and says so rather than being guessed at', () => {
      assert.equal(cls.categoryOf(UNSEEN), 'unclassified');
      assert.equal(cls.classify(UNSEEN).matched, false, 'an unmatched scale must be flagged, not silently categorised');
      assert.equal(cls.categoryOf(null), 'unclassified');
      assert.equal(cls.categoryOf(''), 'unclassified');
      assert.equal(cls.classify(null).why, 'no pay classification recorded in payroll');
      // A CSE level outside the owner's mapping is not extrapolated either.
      assert.equal(cls.categoryOf('Permanent CSE Level 9 - Something New'), 'unclassified');
      assert.equal(cls.classify('Permanent CSE Level 9 - Something New').matched, false);
      // Payroll spacing and case are noise, not a new scale.
      assert.equal(cls.categoryOf('  permanent   cse   level 5 - advanced educator '), 'dip');
    });

    await t.test('the snapshot classifies from the pay scale and never from the job title', async () => {
      const summary = await freeze(FROZEN, () => talent.runTalentSnapshot({ log: () => {} }));
      assert.equal(summary.ok, true);
      assert.equal(summary.employees, EMPLOYEES.length);
      // Every job title in the fixture says "Early Childhood Educator". If the mix came from the title,
      // Alpha would be fifteen educators; it comes from the pay scale, so it is this:
      const a = centreRow('a', MONTH);
      assert.equal(a.headcount, 15);
      assert.deepEqual(
        Object.fromEntries(CATS.map((k) => [k, a['cls_' + k]])),
        { ect: 2, dip: 2, cert3: 2, trainee: 3, management: 2, support: 2, unclassified: 2 });
      assert.equal(CATS.reduce((s, k) => s + a['cls_' + k], 0), a.headcount, 'the mix must add up to the headcount');
      const b = centreRow('b', MONTH);
      assert.equal(b.headcount, 2);
      assert.equal(b.cls_ect, 1, 'a Teachers Level 3 is an ECT');
      assert.equal(b.cls_cert3, 1, 'a CSE Level 3 is a Cert 3');
      // The scales that map to nothing are counted and visible, not dropped.
      assert.equal(a.cls_unclassified, 2, 'the unseen scale and the person with no scale at all');
      assert.equal(summary.unclassified_people, 2);
      assert.equal(summary.unmapped_scales, 1, 'the unseen scale only — no scale recorded is not a scale awaiting a rule');
      assert.equal(summary.unmapped_people, 1);
      assert.equal(summary.no_scale_people, 1);
    });

    await t.test('casuals appear in no per-centre figure, and are one group figure by category', () => {
      const g = groupRow(MONTH);
      assert.equal(g.headcount, 18, 'permanent, group-wide: 15 + 2 + 1');
      assert.equal(g.casual_headcount, 4);
      assert.deepEqual(
        Object.fromEntries(CATS.map((k) => [k, g['cas_' + k]])),
        { ect: 0, dip: 2, cert3: 2, trainee: 0, management: 0, support: 0, unclassified: 0 });
      assert.equal(CATS.reduce((s, k) => s + g['cas_' + k], 0), g.casual_headcount);
      // Three of the four casuals are filed against Centre Beta in payroll. Beta's mix holds its two
      // permanent staff and nothing else — no casual is anywhere in it.
      assert.equal(centreRow('b', MONTH).cls_cert3, 1, 'the two casual Cert 3s filed at Beta are NOT in Beta');
      assert.equal(centreRow('b', MONTH).cls_dip, 0, 'nor is the casual Dip');
      assert.equal(centreRow('a', MONTH).cls_dip, 2, "Alpha's two are its own permanent Level 5 and 6");
      // Per-centre totals sum to the PERMANENT group headcount, with no casual anywhere in them.
      for (const k of CATS) {
        const perCentre = db.prepare(`SELECT COALESCE(SUM(cls_${k}),0) n FROM talent_monthly WHERE month=?`).get(MONTH).n;
        const group = db.prepare(`SELECT COALESCE(cas_${k},0) n FROM talent_group_monthly WHERE month=?`).get(MONTH).n;
        assert.equal(perCentre + group, (k === 'cert3' ? 5 : k === 'dip' ? 4 : k === 'ect' ? 3 : k === 'management' ? 3 : k === 'trainee' ? 3 : 2),
          `${k}: permanent per centre plus the group casual figure is everyone on that category`);
      }
      const totalPerCentre = CATS.reduce((s, k) => s + db.prepare(`SELECT COALESCE(SUM(cls_${k}),0) n FROM talent_monthly WHERE month=?`).get(MONTH).n, 0);
      assert.equal(totalPerCentre, g.headcount);
      // And the per-centre table has no casual column at all to put one in.
      const cols = db.prepare('PRAGMA table_info(talent_monthly)').all().map((c) => c.name);
      assert.equal(cols.filter((c) => /casual|^cas_/i.test(c)).length, 0);
    });

    await t.test('the mapping itself is stored so it can be reviewed, with counts and no person', () => {
      const rows = db.prepare('SELECT * FROM talent_pay_scales ORDER BY scale').all();
      assert.equal(rows.length, 19, 'one row per distinct scale, including the empty one');
      assert.equal(rows.reduce((a, r) => a + r.people, 0), EMPLOYEES.length);
      const by = Object.fromEntries(rows.map((r) => [r.scale, r]));
      assert.equal(by[CSE3].people, 2, 'Alpha and Beta both have someone on CSE Level 3');
      assert.equal(by[CSE3].permanent, 2);
      assert.equal(by[CSE3].casual, 0);
      assert.equal(by[CAS5].people, 2);
      assert.equal(by[CAS5].casual, 2, 'permanent/casual comes from the employment type, not the scale name');
      assert.equal(by[CAS5].permanent, 0);
      assert.equal(by[CAS5].category, 'dip');
      assert.equal(by[UNSEEN].matched, 0, 'the unmapped scale is flagged in the row itself');
      assert.equal(by[UNSEEN].category, 'unclassified');
      assert.equal(by[''].people, 1, 'a person with no pay classification is still counted, under an empty scale');
      // Every column is a scale, a category or a count — nothing that identifies anyone.
      const cols = db.prepare('PRAGMA table_info(talent_pay_scales)').all().map((c) => c.name);
      assert.deepEqual(cols.filter((c) => /name|email|dob|birth|employee|staff/i.test(c)), []);
    });

    await t.test('no name, employee id or date of birth reaches the database', () => {
      const rows = [
        ...db.prepare('SELECT * FROM talent_monthly').all(),
        ...db.prepare('SELECT * FROM talent_group_monthly').all(),
        ...db.prepare('SELECT * FROM talent_pay_scales').all(),
      ];
      assert.ok(rows.length > 0, 'there must be rows for this to prove anything');
      const dump = JSON.stringify(rows);
      for (const marker of NAME_MARKERS) assert.ok(!dump.includes(marker), `"${marker}" reached the talent tables`);
      assert.ok(!dump.includes(String(ID_MARKER)), 'an Employment Hero employee id reached the talent tables');
      assert.ok(!dump.includes('example.invalid'), 'a staff email address reached the talent tables');
      assert.ok(!dump.includes('123456789'), 'a tax file number reached the talent tables');
      // Not just these tables — nowhere in the file, so the new pay-scale register cannot smuggle one in.
      const bytes = fs.readFileSync(process.env.DB_PATH);
      for (const marker of NAME_MARKERS.concat([String(ID_MARKER), 'example.invalid'])) {
        assert.ok(!bytes.includes(Buffer.from(marker)), `"${marker}" is present somewhere in the database file`);
      }
    });

    await t.test('People & Culture shows the mix per centre, and each centre links to its own page', async () => {
      const cookie = await login('admin');
      const html = await freeze(FROZEN, () => page('/pc', cookie));
      for (const label of ['ECT', 'Dip', 'Cert 3', 'Trainee', 'Management', 'Support', 'Unclassified']) {
        assert.ok(html.includes('>' + label + '</th>'), `the mix must have a ${label} column`);
      }
      assert.match(html, /pay classification/i, 'the page says what the role is derived from');
      assert.match(html, /href="\/centre\/a"/, 'the owner asked to drill down to a centre from here');
      assert.match(html, /href="\/centre\/b"/);
      // The casual figure is separate from the per-centre table, broken down, with its one-line note.
      assert.match(html, /Casuals — group-wide/);
      assert.match(html, /no casual appears in this table/i);
      assert.match(html, /administrative home/i);
      for (const marker of NAME_MARKERS) assert.ok(!html.includes(marker), `"${marker}" was rendered`);
      assert.ok(!html.includes(String(ID_MARKER)));
    });

    await t.test('the centre page shows the same mix for that centre', async () => {
      const cookie = await login('admin');
      const html = await freeze(FROZEN, () => page('/centre/a', cookie));
      assert.match(html, /Role mix/);
      assert.match(html, /pay classification, not the job title/i);
      for (const label of ['ECT', 'Dip', 'Cert 3', 'Trainee', 'Unclassified']) {
        assert.ok(html.includes('>' + label + '</th>'), `the centre mix must have a ${label} column`);
      }
      const rep = freeze(FROZEN, () => m.talentReport('a', 1));
      const mix = rep.centres.find((c) => c.owna_id === 'a');
      assert.equal(mix.headcount, 15);
      assert.deepEqual(mix.classes.map((c) => c.n), [2, 2, 2, 3, 2, 2, 2], 'ECT, Dip, Cert 3, Trainee, Management, Support, Unclassified');
      assert.equal(mix.classes.reduce((a, c) => a + c.n, 0), mix.headcount);
      for (const marker of NAME_MARKERS) assert.ok(!html.includes(marker));
    });

    await t.test('a centre-scoped user gets their own mix and no group casual figure', async () => {
      const cookie = await login('centre'); // scoped to Centre Alpha
      const html = await freeze(FROZEN, () => page('/pc', cookie));
      assert.ok(!/Casuals — group-wide/.test(html), 'the casual figure is a group figure, not theirs');
      assert.ok(!html.includes('Centre Beta'));
      assert.match(html, /counted once group-wide/i, 'but the rule is still explained where their numbers are');
      assert.match(html, /Unclassified/);
    });

    await t.test('the admin mapping page lists every scale, its headcount and its category', async () => {
      const cookie = await login('admin');
      const html = await freeze(FROZEN, () => page('/admin/pay-scales', cookie));
      for (const scale of [TEACHER(1), CSE1_17, CSE7, CSE8, SW1, SW3, CAS5, UNSEEN]) {
        assert.ok(html.includes(scale), `the mapping page must list "${scale}"`);
      }
      assert.match(html, /no pay classification recorded/i, 'the people carrying no scale are a visible row, not a gap');
      assert.match(html, /unmapped/i, 'a scale no rule maps is flagged rather than folded into Unclassified');
      // The model behind the page, asserted rather than inferred from the HTML.
      const scales = freeze(FROZEN, () => m.talentPayScales());
      assert.equal(scales.totals.scales, 18, 'the scales payroll carries; the "none recorded" row is not one of them');
      assert.equal(scales.totals.people, EMPLOYEES.length);
      assert.equal(scales.totals.permanent, 18);
      assert.equal(scales.totals.casual, 4);
      assert.equal(scales.totals.unmapped_scales, 1, 'the unseen scale only');
      assert.equal(scales.totals.unmapped_people, 1);
      assert.equal(scales.totals.no_scale_people, 1);
      assert.match(html, /No classification recorded/, 'the people with no scale are their own figure, not an unmapped scale');
      assert.equal(scales.rows[0].matched, false, 'unmapped scales sort to the top, where they get looked at');
      const cert3 = scales.byCategory.find((c) => c.key === 'cert3');
      assert.equal(cert3.people, 5, 'two permanent CSE 3, one permanent at Beta... and the two casuals');
      for (const marker of NAME_MARKERS) assert.ok(!html.includes(marker));
    });

    await t.test('a tenant where every scale maps flags nothing, however many carry no scale at all', async () => {
      // The owner's own shape: every scale payroll carries maps, and a number of people carry none. If
      // those people count as an unmapped scale the page shows a red 1 for ever — and the 20th scale
      // that really is unmapped only moves it to 2, which is the one thing the flag exists to show.
      const mapped = EMPLOYEES.filter((e) => e.payRateTemplate && e.payRateTemplate !== UNSEEN);
      const none = [emp({ payRateTemplate: null }), emp({ payRateTemplate: null }), emp({ payRateTemplate: '   ' })];
      const undo = stubPayroll(mapped.concat(none));
      try {
        const summary = await freeze(FROZEN, () => talent.runTalentSnapshot({ log: () => {} }));
        const scales = freeze(FROZEN, () => m.talentPayScales());
        assert.equal(scales.totals.unmapped_scales, 0, 'nothing on this tenant is unmapped');
        assert.equal(scales.totals.unmapped_people, 0);
        assert.equal(scales.totals.scales, 17, 'the 17 scales payroll carries, not 18 with an empty one');
        assert.equal(scales.totals.no_scale_people, 3, 'the people with no classification are counted here, and only here');
        assert.equal(scales.totals.people, mapped.length + none.length, 'and nobody is lost by being counted there');
        assert.ok(scales.rows.some((r) => !r.recorded && r.people === 3), 'their row is still listed, under its own name');
        assert.equal(summary.unmapped_scales, 0, 'so the nightly run raises no false alarm either');
        assert.equal(summary.no_scale_people, 3);
        const cookie = await login('admin');
        const html = await freeze(FROZEN, () => page('/admin/pay-scales', cookie));
        assert.ok(!html.includes('bad-text'), 'and the page shows nothing in red');
        assert.match(html, /No classification recorded/);
      } finally {
        undo();
        await freeze(FROZEN, () => talent.runTalentSnapshot({ log: () => {} })); // put the fixture tenant back
      }
    });

    await t.test('an ops manager can open it; a viewer and a centre user cannot', async () => {
      const ops = await login('ops_manager');
      await freeze(FROZEN, () => page('/admin/pay-scales', ops));
      for (const role of ['viewer', 'centre', 'exec']) {
        const cookie = await login(role);
        const r = await fetch(base + '/admin/pay-scales', { headers: { cookie }, redirect: 'manual' });
        assert.ok(r.status === 403 || r.status === 302, `${role} must not reach the mapping page (got ${r.status})`);
      }
    });

    await t.test('re-running rebuilds the scale register rather than doubling it', async () => {
      const before = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(people),0) p FROM talent_pay_scales').get();
      await freeze(FROZEN, () => talent.runTalentSnapshot({ log: () => {} }));
      assert.deepEqual(db.prepare('SELECT COUNT(*) n, COALESCE(SUM(people),0) p FROM talent_pay_scales').get(), before);
      // A scale that leaves payroll leaves the register too, rather than lingering as a phantom.
      const undo = stubPayroll(EMPLOYEES.filter((e) => e.payRateTemplate !== UNSEEN));
      try {
        await freeze(FROZEN, () => talent.runTalentSnapshot({ log: () => {} }));
        assert.equal(db.prepare('SELECT COUNT(*) n FROM talent_pay_scales WHERE scale=?').get(UNSEEN).n, 0);
        assert.equal(centreRow('a', MONTH).cls_unclassified, 1, 'and the count it fed comes back down');
      } finally { undo(); }
      await freeze(FROZEN, () => talent.runTalentSnapshot({ log: () => {} }));
      assert.equal(centreRow('a', MONTH).cls_unclassified, 2, 'and back again when payroll is restored');
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
