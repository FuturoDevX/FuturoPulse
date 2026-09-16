// The state between deploying the pay classification and the first payroll sync that fills it in:
// every talent row carries a real headcount and an empty mix, because cls_*/cas_* are NOT NULL
// DEFAULT 0 and the rows predate the columns. The permanent table has always said so in a line
// instead of printing seven zeros; the group casual card did not, and printed a breakdown of 37
// people that added to 0. Both are asserted here, and so is the opposite direction: once the mix
// arrives, the table comes back.
//
// Harness mirrors tests/talent.test.js: temp DB via DB_PATH, fixture users, app.listen(0), and
// freeze() moves the APP's clock through services/calendar.js only (never the global Date, which
// deadlocks the runner by stopping the timers Node's fetch ages its sockets on).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-mixpending-'));
process.env.DB_PATH = path.join(dir, 'test.db'); process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'test-admin@example.test'; process.env.ADMIN_DEFAULT_PASSWORD = 'FixturePasswordOnly!';
process.env.SESSION_SECRET = 'fixture-session-only';
const db = require('../db/db'), bcrypt = require('bcryptjs');
const pass = 'FixturePasswordOnly!';
for (const [id, name] of [['a', 'Centre Alpha'], ['b', 'Centre Beta']]) db.prepare('INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,100,0)').run(id, name);
for (const role of ['viewer', 'centre', 'exec', 'ops_manager', 'admin']) db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)').run(role + '@example.test', role, bcrypt.hashSync(pass, 4), role, role === 'centre' ? 'a' : null);

const cal = require('../services/calendar');
const m = require('../services/metrics');

const FROZEN = '2026-09-16T02:00:00Z'; // midday on Wednesday 16 September 2026 in Sydney
const MONTH = '2026-09';
function freeze(iso, fn) {
  cal.setNow(iso);
  const restore = () => { cal.setNow(null); };
  let out; try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
  restore(); return out;
}

// Rows exactly as the live database carries them: a headcount, and every cls_/cas_ column left at its
// schema default. Nothing is set to 0 by hand — the point is that the defaults read as 0, not NULL.
db.prepare('INSERT INTO talent_monthly(owna_id,month,headcount,starters,leavers) VALUES(?,?,?,?,?)').run('a', MONTH, 42, 3, 2);
db.prepare('INSERT INTO talent_monthly(owna_id,month,headcount,starters,leavers) VALUES(?,?,?,?,?)').run('b', MONTH, 132, 9, 7);
db.prepare('INSERT INTO talent_group_monthly(month,headcount,casual_headcount,starters,raw_terminations,casual_leavers,never_started,leavers) VALUES(?,?,?,?,?,?,?,?)')
  .run(MONTH, 174, 37, 12, 11, 1, 1, 9);

const CATS = ['ect', 'dip', 'cert3', 'trainee', 'management', 'support', 'unclassified'];
const LABELS = ['ECT', 'Dip', 'Cert 3', 'Trainee', 'Management', 'Support'];

const app = require('../server');
let server, base;
async function login(role) {
  const r = await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ email: role + '@example.test', password: pass }), redirect: 'manual' });
  assert.equal(r.status, 302);
  return r.headers.get('set-cookie').split(';')[0];
}
async function page(url, cookie) {
  const r = await fetch(base + url, { headers: { cookie }, redirect: 'manual' });
  assert.equal(r.status, 200, url + ' ' + r.status);
  return r.text();
}
// The group casual card only — from its heading to the card that follows it — so an assertion about
// what the card does NOT contain cannot be satisfied or broken by the rest of the page.
function casualCard(html) {
  const from = html.indexOf('Casuals — group-wide');
  if (from < 0) return null;
  const to = html.indexOf('Why people left', from);
  return html.slice(from, to > 0 ? to : html.length);
}

test('Role mix pending — a headcount with no classification yet', async (t) => {
  server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  try {

    await t.test('the report itself reports a pending mix beside a real casual headcount', () => {
      const rep = freeze(FROZEN, () => m.talentReport(null, 24));
      assert.equal(rep.month, MONTH);
      assert.equal(rep.mix_pending, true);
      assert.equal(rep.group.casual_headcount, 37);
      assert.deepEqual(rep.group.casual_classes.map((c) => c.n), [0, 0, 0, 0, 0, 0, 0], 'the defect depends on these being zero, not absent');
    });

    await t.test('the casual card prints the headcount, not seven zeros under seven headers', async () => {
      for (const role of ['viewer', 'exec', 'ops_manager', 'admin']) {
        const cookie = await login(role);
        const html = await freeze(FROZEN, () => page('/pc', cookie));
        const card = casualCard(html);
        assert.ok(card, `${role} should still see the group casual card`);
        // No table at all in the card: no category headers, and so no row of zeros beneath them.
        assert.ok(!/<table/.test(card), `${role}: the casual card must not render a table while the mix is pending`);
        assert.ok(!/<t[hd][\s>]/.test(card), `${role}: no cells either`);
        for (const label of LABELS) assert.ok(!card.includes('>' + label + '<'), `${role}: "${label}" is a category header of a mix that does not exist yet`);
        assert.ok(!html.includes('37 in total'), `${role}: "37 in total" is the label of the zero-filled row`);
        // The headcount is real data and stays, with a line saying what is missing.
        assert.ok(card.includes('37'), `${role}: the casual headcount is real and stays on the page`);
        assert.match(card, /next payroll sync/i, `${role}: and says why the mix is missing`);
        // The guard the permanent table has always had is still doing its job directly above.
        assert.match(html, /Role mix arrives with the next payroll sync/);
      }
    });

    await t.test('and when the sync fills the mix in, the breakdown comes back', async () => {
      const setCls = (id, vals) => db.prepare(`UPDATE talent_monthly SET ${CATS.map((c) => 'cls_' + c + '=?').join(',')} WHERE owna_id=? AND month=?`).run(...vals, id, MONTH);
      setCls('a', [10, 12, 14, 3, 2, 1, 0]);
      setCls('b', [30, 40, 44, 9, 6, 3, 0]);
      db.prepare(`UPDATE talent_group_monthly SET ${CATS.map((c) => 'cas_' + c + '=?').join(',')} WHERE month=?`).run(4, 9, 18, 3, 0, 2, 1, MONTH);
      try {
        const rep = freeze(FROZEN, () => m.talentReport(null, 24));
        assert.equal(rep.mix_pending, false);
        const cookie = await login('exec');
        const html = await freeze(FROZEN, () => page('/pc', cookie));
        const card = casualCard(html);
        assert.match(card, /<table/, 'the mix exists now, so the table is the right way to show it');
        assert.ok(card.includes('37 in total'));
        for (const label of LABELS) assert.ok(card.includes('>' + label + '<'), `"${label}" is a column of the mix now that there is one`);
        assert.doesNotMatch(html, /Role mix arrives with the next payroll sync/);
      } finally {
        for (const id of ['a', 'b']) setCls(id, CATS.map(() => 0));
        db.prepare(`UPDATE talent_group_monthly SET ${CATS.map((c) => 'cas_' + c + '=0').join(',')} WHERE month=?`).run(MONTH);
      }
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
