// Turnover as the OWNER enters it — his decision of 16 September 2026, which reverses the
// payroll-derived turnover built the week before. Payroll records that someone left; it cannot know
// whether the business counts the departure as turnover, so three numbers per centre per month —
// resignations, terminations, headcount — are typed in on /admin/pc and everything here is arithmetic.
//
// Harness mirrors tests/talent.test.js: temp DB via DB_PATH, fixture users, app.listen(0), and freeze()
// moves the APP's clock through services/calendar.js only (never the global Date, which deadlocks the
// runner by stopping the timers Node's fetch ages its sockets on).
//
// Subtests run in order, and the last two deliberately WRITE fixtures of their own. Every assertion
// about the group total is made before that happens.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-turnover-'));
process.env.DB_PATH = path.join(dir, 'test.db'); process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'test-admin@example.test'; process.env.ADMIN_DEFAULT_PASSWORD = 'FixturePasswordOnly!';
process.env.SESSION_SECRET = 'fixture-session-only';
const db = require('../db/db'), bcrypt = require('bcryptjs');
const pass = 'FixturePasswordOnly!';
for (const [id, name] of [['a', 'Centre Alpha'], ['b', 'Centre Beta'], ['c', 'Centre Gamma'], ['d', 'Centre Delta'], ['e', 'Centre Echo']]) {
  db.prepare('INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,100,0)').run(id, name);
}
for (const role of ['viewer', 'centre', 'exec', 'ops_manager', 'admin']) {
  db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)').run(role + '@example.test', role, bcrypt.hashSync(pass, 4), role, role === 'centre' ? 'a' : null);
}

const cal = require('../services/calendar');
const m = require('../services/metrics');

const FROZEN = '2026-09-16T02:00:00Z'; // midday, Wednesday 16 September 2026 in Sydney
function freeze(iso, fn) {
  cal.setNow(iso);
  const restore = () => { cal.setNow(null); };
  let out; try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
  restore(); return out;
}

// The entered fixture. A `null` is a field the owner has NOT entered, which is not a zero:
//   Alpha  five entered months of the twelve to Sep 26, one of them a real 0, one missing terminations
//   Beta   two months
//   Gamma  leavers against a headcount of ZERO — must never divide
//   Delta  leavers with NO headcount entered at all — must never divide
//   Echo   nothing entered: it appears on the form blank, and in no figure
const ENTRIES = [
  ['a', '2026-04', 1, 0, 20],
  ['a', '2026-05', 2, 1, 20],
  // 2026-06 deliberately absent for Alpha: a month nobody entered
  ['a', '2026-07', 0, 1, 24],
  ['a', '2026-08', 1, null, 24],
  ['a', '2026-09', 0, 0, 32],
  ['b', '2026-08', 0, 0, 20],
  ['b', '2026-09', 2, 2, 20],
  ['c', '2026-09', 1, 1, 0],
  ['d', '2026-09', 3, null, null],
];
for (const [id, mth, res, term, head] of ENTRIES) {
  db.prepare("INSERT INTO pc_turnover_entry (owna_id, month, resignations, terminations, headcount, updated_at) VALUES (?,?,?,?,?,datetime('now'))").run(id, mth, res, term, head);
}

const app = require('../server');
let server, base;
async function login(role) {
  const r = await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ email: role + '@example.test', password: pass }), redirect: 'manual' });
  assert.equal(r.status, 302); return r.headers.get('set-cookie').split(';')[0];
}
async function request(url, cookie) { return fetch(base + url, { headers: { cookie }, redirect: 'manual' }); }
async function page(url, cookie) { const r = await request(url, cookie); assert.equal(r.status, 200, url + ' ' + r.status); return r.text(); }
async function post(url, cookie, body) {
  return fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
}

test('Turnover the owner enters — by centre, by month', async (t) => {
  server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  try {

    await t.test('the three rates compute from the entered months, and they add up', () => {
      // Alpha, rolling to Sep 26. Entered: Apr, May, Jul, Aug, Sep (Jun is blank and is left out).
      //   resignations 1+2+0+1+0 = 4 · terminations 0+1+1+0 = 2 (August's is blank, not zero)
      //   headcounts 20,20,24,24,32 → average 24
      const a = freeze(FROZEN, () => m.pcTurnoverReport('a'));
      assert.equal(a.resignations, 4);
      assert.equal(a.terminations, 2);
      assert.equal(a.leavers, 6);
      assert.equal(a.avg_headcount, 24);
      assert.equal(a.rates.combined, 25);       // 6 / 24
      assert.equal(a.rates.resignations, 16.7); // 4 / 24
      assert.equal(a.rates.terminations, 8.3);  // 2 / 24
      // The point of showing all three: the two parts make the whole.
      assert.equal(Math.round((a.rates.resignations + a.rates.terminations) * 10) / 10, a.rates.combined);

      // The group is every centre's numbers summed per month, then the same arithmetic.
      //   Apr 1/0/20 · May 2/1/20 · Jul 0/1/24 · Aug 1/0/44 · Sep 6/3/52
      //   resignations 10 · terminations 5 · headcounts avg 160/5 = 32
      const g = freeze(FROZEN, () => m.pcTurnoverReport(null));
      assert.equal(g.resignations, 10);
      assert.equal(g.terminations, 5);
      assert.equal(g.avg_headcount, 32);
      assert.equal(g.rates.combined, 46.9);
      assert.equal(g.rates.resignations, 31.3);
      assert.equal(g.rates.terminations, 15.6);

      // And the MONTHLY rate, clearly its own figure: September alone for Beta, 4 leavers over 20.
      const b = freeze(FROZEN, () => m.pcTurnoverReport('b'));
      assert.equal(b.month.month, '2026-09');
      assert.equal(b.month.rates.combined, 20);
      assert.equal(b.month.rates.resignations, 10);
      assert.equal(b.month.rates.terminations, 10);
      // Rolling is a different number from monthly, and Beta is where that shows: 4 leavers over an
      // average of 20 across its two entered months.
      assert.equal(b.rates.combined, 20);
      assert.equal(b.window.entered, 2);
    });

    await t.test('the rolling window says how many months it is actually based on', async () => {
      const a = freeze(FROZEN, () => m.pcTurnoverReport('a'));
      assert.equal(a.window.months, 12);
      assert.equal(a.window.entered, 5, 'five of the twelve are entered');
      assert.equal(a.window.complete, false);
      assert.equal(a.window.to, '2026-09');
      assert.equal(a.window.from, '2025-10');
      // ...and the page says so rather than implying a year.
      const execCookie = await login('exec');
      const html = await freeze(FROZEN, () => page('/pc?metric=turnover', execCookie));
      assert.match(html, /Rolling 5 months/, 'the reader is told it is five months, not twelve');
      assert.match(html, /not a full year/i);
      assert.match(html, /5 of 12/, 'and the per-centre table says it too');
      // The monthly rate is on the page and is labelled as monthly, never mixed in with the rolling one.
      assert.match(html, /<strong>monthly<\/strong> rather than rolling/i);
      // A full twelve months reads as a year instead.
      for (const mth of ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-06']) {
        db.prepare("INSERT INTO pc_turnover_entry (owna_id, month, resignations, terminations, headcount, updated_at) VALUES ('b',?,0,0,20,datetime('now'))").run(mth);
      }
      const full = freeze(FROZEN, () => m.pcTurnoverReport('b'));
      assert.equal(full.window.entered, 9);
      db.prepare("INSERT INTO pc_turnover_entry (owna_id, month, resignations, terminations, headcount, updated_at) VALUES ('b',?,0,0,20,datetime('now'))").run('2026-04');
      db.prepare("INSERT INTO pc_turnover_entry (owna_id, month, resignations, terminations, headcount, updated_at) VALUES ('b',?,0,0,20,datetime('now'))").run('2026-05');
      db.prepare("INSERT INTO pc_turnover_entry (owna_id, month, resignations, terminations, headcount, updated_at) VALUES ('b',?,0,0,20,datetime('now'))").run('2026-07');
      const year = freeze(FROZEN, () => m.pcTurnoverReport('b'));
      assert.equal(year.window.entered, 12);
      assert.equal(year.window.complete, true);
      // 4 leavers over an average headcount of 20 across a full year.
      assert.equal(year.rates.combined, 20);
      // Clean up so the later subtests see the fixture they were written against.
      db.prepare("DELETE FROM pc_turnover_entry WHERE owna_id='b' AND month NOT IN ('2026-08','2026-09')").run();
      assert.equal(freeze(FROZEN, () => m.pcTurnoverReport('b')).window.entered, 2);
    });

    await t.test('a headcount of zero — or none entered — produces no rate, never a division', () => {
      // Gamma entered a headcount of 0 with two leavers against it.
      const c = freeze(FROZEN, () => m.pcTurnoverReport('c'));
      assert.equal(c.avg_headcount, 0);
      assert.equal(c.leavers, 2);
      assert.equal(c.rates.combined, null);
      assert.equal(c.rates.resignations, null);
      assert.equal(c.rates.terminations, null);
      assert.equal(c.month.rates.combined, null);
      // Delta entered leavers and no headcount at all.
      const d = freeze(FROZEN, () => m.pcTurnoverReport('d'));
      assert.equal(d.avg_headcount, null);
      assert.equal(d.resignations, 3);
      assert.equal(d.rates.combined, null);
      // Echo has nothing at all: no window, no rates, and nothing pretending to be zero.
      const e = freeze(FROZEN, () => m.pcTurnoverReport('e'));
      assert.equal(e.window.entered, 0);
      assert.equal(e.leavers, null);
      assert.equal(e.rates.combined, null);
      // None of the four is Infinity or NaN, which is what a naive divide would have produced.
      for (const r of [c, d, e]) for (const v of Object.values(r.rates)) assert.ok(v === null, `${v} is not a rate`);
    });

    await t.test('blank is not zero: it round-trips as blank and changes the arithmetic', async () => {
      const cookie = await login('admin');
      // August for Alpha was entered with terminations left blank. It must come back blank.
      const aug = freeze(FROZEN, () => m.pcTurnoverEntries('2026-08'));
      const alphaAug = aug.find((r) => r.owna_id === 'a');
      assert.equal(alphaAug.resignations, 1);
      assert.equal(alphaAug.terminations, null, 'a field never entered is null, not 0');
      assert.equal(alphaAug.headcount, 24);
      // A centre nobody has entered comes back blank too, not as a row of zeros.
      const echo = aug.find((r) => r.owna_id === 'e');
      assert.deepEqual([echo.resignations, echo.terminations, echo.headcount], [null, null, null]);
      // And the form renders both as empty inputs rather than "0".
      const html = await freeze(FROZEN, () => page('/admin/pc?month=2026-08', cookie));
      assert.match(html, /name="term_a" value=""/, 'blank round-trips to the form as blank');
      assert.match(html, /name="res_a" value="1"/);
      assert.match(html, /name="head_e" value=""/);

      // Save through the form: a zero typed in is kept as a zero, a field cleared goes back to blank.
      let r = await freeze(FROZEN, () => post('/admin/pc/turnover', cookie, { month: '2026-08', res_a: '1', term_a: '0', head_a: '24' }));
      assert.equal(r.status, 302);
      assert.equal(freeze(FROZEN, () => m.pcTurnoverEntries('2026-08')).find((x) => x.owna_id === 'a').terminations, 0);
      r = await freeze(FROZEN, () => post('/admin/pc/turnover', cookie, { month: '2026-08', res_a: '1', term_a: '', head_a: '24' }));
      assert.equal(r.status, 302);
      assert.equal(freeze(FROZEN, () => m.pcTurnoverEntries('2026-08')).find((x) => x.owna_id === 'a').terminations, null);

      // The difference is not cosmetic. Echo: a blank headcount month is left OUT of the average; the
      // same month entered as 0 is a measurement and drags it down, halving the denominator.
      freeze(FROZEN, () => m.savePcTurnoverEntry('e', '2026-08', { resignations: 3, terminations: 0, headcount: 10 }));
      freeze(FROZEN, () => m.savePcTurnoverEntry('e', '2026-09', { resignations: 0, terminations: 0, headcount: '' }));
      const blank = freeze(FROZEN, () => m.pcTurnoverReport('e'));
      assert.equal(blank.avg_headcount, 10, 'the blank month is not in the average');
      assert.equal(blank.rates.combined, 30);
      freeze(FROZEN, () => m.savePcTurnoverEntry('e', '2026-09', { resignations: 0, terminations: 0, headcount: 0 }));
      const zero = freeze(FROZEN, () => m.pcTurnoverReport('e'));
      assert.equal(zero.avg_headcount, 5, 'a zero IS in the average');
      assert.equal(zero.rates.combined, 60);

      // Excel renders a number-formatted count as "30.0", so that is what gets pasted in. Keeping the
      // digits but dropping the point would store 300 and make every rate on the page a tenth of the truth.
      const dec = freeze(FROZEN, () => m.savePcTurnoverEntry('e', '2026-07', { resignations: '1.0', terminations: '0', headcount: '30.0' }));
      assert.equal(dec.headcount, 30, '"30.0" is thirty, not three hundred');
      assert.equal(dec.resignations, 1, '"1.0" is one, not ten');
      assert.equal(freeze(FROZEN, () => m.pcTurnoverEntries('2026-07')).find((x) => x.owna_id === 'e').headcount, 30);
      assert.equal(freeze(FROZEN, () => m.savePcTurnoverEntry('e', '2026-07', { headcount: '28.5' })).headcount, 29, 'a fraction rounds, it does not become 285');
      assert.equal(freeze(FROZEN, () => m.savePcTurnoverEntry('e', '2026-07', { headcount: 'abc' })).deleted, true, 'garbage is still nothing entered');

      // All three cleared removes the row entirely, so "not entered" cannot be mistaken for a month of zeros.
      freeze(FROZEN, () => m.savePcTurnoverEntry('e', '2026-09', { resignations: '', terminations: '', headcount: '' }));
      assert.equal(db.prepare("SELECT COUNT(*) n FROM pc_turnover_entry WHERE owna_id='e' AND month='2026-09'").get().n, 0);
      assert.equal(freeze(FROZEN, () => m.pcTurnoverReport('e')).avg_headcount, 10);
      db.prepare("DELETE FROM pc_turnover_entry WHERE owna_id='e'").run();
    });

    await t.test('only an admin or an ops manager can reach the form, or save through it', async () => {
      for (const role of ['admin', 'ops_manager']) {
        const cookie = await login(role);
        const html = await freeze(FROZEN, () => page('/admin/pc', cookie));
        assert.match(html, /Turnover — enter the numbers/, role + ' must see the form');
        const r = await freeze(FROZEN, () => post('/admin/pc/turnover', cookie, { month: '2026-03', res_a: '1', term_a: '1', head_a: '20' }));
        assert.equal(r.status, 302, role + ' must be able to save');
      }
      for (const role of ['viewer', 'exec', 'centre']) {
        const cookie = await login(role);
        assert.equal((await request('/admin/pc', cookie)).status, 403, role + ' must not reach the form');
        assert.equal((await freeze(FROZEN, () => post('/admin/pc/turnover', cookie, { month: '2026-03', res_a: '99', term_a: '99', head_a: '1' }))).status, 403, role + ' must not save');
      }
      // Signed out is refused as well — a redirect to the login page, never the form.
      const out = await fetch(base + '/admin/pc', { redirect: 'manual' });
      assert.equal(out.status, 302);
      assert.match(out.headers.get('location') || '', /login/);
      // Nothing the refused roles sent was written.
      assert.equal(db.prepare("SELECT resignations FROM pc_turnover_entry WHERE owna_id='a' AND month='2026-03'").get().resignations, 1);
      db.prepare("DELETE FROM pc_turnover_entry WHERE month='2026-03'").run();
      // Those saves named one centre only. A submission must not erase the centres it said nothing
      // about — clearing a centre is done by blanking its fields, not by omitting them.
      assert.equal(db.prepare("SELECT headcount FROM pc_turnover_entry WHERE owna_id='b' AND month='2026-08'").get().headcount, 20);
    });

    await t.test('a centre-scoped user sees their own centre and no other, and no group figure', async () => {
      const cookie = await login('centre'); // scoped to Centre Alpha
      const html = await freeze(FROZEN, () => page('/pc?metric=turnover', cookie));
      assert.match(html, /Centre Alpha/);
      assert.ok(!html.includes('Centre Beta'), 'another centre must not appear');
      assert.ok(!html.includes('Centre Gamma'), 'another centre must not appear');
      assert.ok(!/>Group</.test(html), 'no group total row for a scoped user');
      // Their own rate, not the group's: 25% for Alpha, where the group is 46.9%.
      assert.ok(html.includes('25%'), "the scoped user's own combined rate is shown");
      assert.ok(!html.includes('46.9%'), 'the group rate must not leak to a scoped user');
      // The read model is scoped too, not just the rendering.
      const rep = freeze(FROZEN, () => m.pcTurnoverReport('a'));
      assert.equal(rep.centres.length, 1);
      assert.equal(rep.centres[0].owna_id, 'a');
      // A scoped user cannot query another centre's figures through the page's own selector.
      const other = await freeze(FROZEN, () => page('/pc?metric=turnover&owna=b', cookie));
      assert.ok(!other.includes('Centre Beta'));
      assert.ok(other.includes('25%'));

      // An UNSCOPED reader who picks one centre gets that centre's figures and no "Group" row either:
      // the report covers one centre, so a group line would just relabel the same numbers.
      const execCookie = await login('exec');
      const one = await freeze(FROZEN, () => page('/pc?metric=turnover&owna=a', execCookie));
      assert.ok(one.includes('25%'), "the selected centre's rate");
      assert.ok(!one.includes('46.9%'), 'and not the group rate');
      assert.ok(!/>Group</.test(one));
      // With no centre selected they get the group, and the per-centre table with every centre in it.
      const all = await freeze(FROZEN, () => page('/pc?metric=turnover', execCookie));
      assert.ok(all.includes('46.9%'));
      assert.match(all, />Group</);
      assert.match(all, /Centre Beta/);
    });

    await t.test('this is now THE turnover figure: payroll reports none, and the chart plots the entered one', async () => {
      const cookie = await login('exec');
      const html = await freeze(FROZEN, () => page('/pc?metric=turnover', cookie));
      // The owner's three figures, headlined.
      assert.match(html, /Combined/);
      assert.match(html, /Resignations only/);
      assert.match(html, /Terminations only/);
      assert.ok(html.includes('46.9%') && html.includes('31.3%') && html.includes('15.6%'));
      // The spreadsheet-versus-payroll comparison is gone from the admin page: nothing left to compare.
      const adminCookie = await login('admin');
      const adminHtml = await freeze(FROZEN, () => page('/admin/pc', adminCookie));
      assert.doesNotMatch(adminHtml, /spreadsheet vs payroll/i);
      // The turnover chart is fed by the entered numbers, not by the uploaded pc_metrics column.
      db.prepare("INSERT INTO pc_metrics (owna_id, month, turnover, updated_at) VALUES ('a','2026-09',77.7,datetime('now'))").run();
      const s = freeze(FROZEN, () => m.pcTurnoverSeries(null, true));
      assert.ok(s.points.length >= 2);
      // The plotted figure is the rolling rate put on a twelve-month basis, so it can share an axis
      // with the full-year points: 46.9% over the five entered months is 46.9 × 12/5 a year.
      assert.equal(s.points[s.points.length - 1], 112.6);
      assert.ok(!s.points.includes(77.7), 'the uploaded spreadsheet figure is not plotted');
      const again = await freeze(FROZEN, () => page('/pc?metric=turnover', cookie));
      assert.ok(!again.includes('77.7'), 'and it is nowhere on the page');
      db.prepare("DELETE FROM pc_metrics WHERE owna_id='a' AND month='2026-09'").run();
    });

    await t.test('a filling window does not read as a rising trend: partial points are annualised', async () => {
      // Echo, entered from scratch and perfectly flat — 1 resignation, 1 termination, headcount 40 in
      // every month from April to September. Nothing about the business changes across the six months.
      const flat = (mth) => db.prepare("INSERT OR IGNORE INTO pc_turnover_entry (owna_id, month, resignations, terminations, headcount, updated_at) VALUES ('e',?,1,1,40,datetime('now'))").run(mth);
      ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].forEach(flat);

      const s = freeze(FROZEN, () => m.pcTurnoverSeries('e', true));
      assert.equal(s.points.length, 6);
      // Two leavers a month against 40 is 60% a year, and every point says 60. Plotting the raw rolling
      // figure gave 5, 10, 15, 20, 25, 30 — a sixfold "rise" that was only the window filling up.
      assert.deepEqual(s.points, [60, 60, 60, 60, 60, 60]);
      assert.equal(s.partial, 6, 'and all six are scaled from a part-filled window');
      // The group line had the same shape, so it gets the same treatment.
      assert.equal(new Set(freeze(FROZEN, () => m.pcTurnoverSeries('e', true)).points).size, 1);

      // On the page: a flat line, a headline that is not six times the first month, and a label that
      // says what has been done rather than the bare "rolling 12 months" the points were not.
      const cookie = await login('exec');
      const html = await freeze(FROZEN, () => page('/pc?metric=turnover&owna=e', cookie));
      assert.match(html, /annualised while fewer are entered/, 'the chart says what it has done');
      assert.ok(!html.includes('rolling 12 months · entered'), 'and does not claim a year it does not have');
      s.labels.forEach((l) => assert.ok(html.includes('Turnover · ' + l + ': 60%'), l + ' must read 60%'));
      assert.ok(!html.includes('Turnover · ' + s.labels[0] + ': 5%'), 'the first month is no longer 5%');

      // Fill the whole window and the scaling is a no-op (12/12): the same 60%, the flag clears, and
      // the chart goes back to calling itself a rolling twelve months.
      for (let i = 2024 * 12 + 9; i <= 2026 * 12 + 2; i++) flat(`${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
      const year = freeze(FROZEN, () => m.pcTurnoverSeries('e'));
      assert.equal(year.shown, 12);
      assert.equal(year.partial, 0, 'every plotted point now covers a full twelve months');
      assert.deepEqual(new Set(year.points), new Set([60]));
      const yearHtml = await freeze(FROZEN, () => page('/pc?metric=turnover&owna=e', cookie));
      assert.match(yearHtml, /rolling 12 months · entered/);
      assert.ok(!yearHtml.includes('annualised while fewer are entered'));

      db.prepare("DELETE FROM pc_turnover_entry WHERE owna_id='e'").run();
    });

    await t.test('the entry stores counts only — no name, no employee id, no date of birth', () => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('pc_turnover_entry')").all().map((r) => r.name);
      assert.deepEqual(cols, ['owna_id', 'month', 'resignations', 'terminations', 'headcount', 'updated_at']);
    });

  } finally {
    // server.close() only stops the listener and then waits for every open connection; Node's fetch
    // keeps sockets alive, so they are closed explicitly first or this file hangs after passing.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
    require('../middleware/session').store.stopPruning();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
