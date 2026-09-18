// The board report: who may read it, what the CSV promises, and the two marks that stop a figure being
// quoted as something it is not.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-report-'));
process.env.DB_PATH = path.join(dir, 'test.db'); process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'test-admin@example.test'; process.env.ADMIN_DEFAULT_PASSWORD = 'FixturePasswordOnly!';
process.env.SESSION_SECRET = 'fixture-session-only'; process.env.ANTHROPIC_API_KEY = 'fixture';
const db = require('../db/db'), bcrypt = require('bcryptjs');
const pass = 'FixturePasswordOnly!';

for (const [id, name, opening] of [['a', 'Centre Alpha', 0], ['b', 'Centre Beta', 0], ['ll-1', 'Centre Opening', 1]])
  db.prepare('INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,100,?)').run(id, name, opening);
for (const role of ['viewer', 'centre', 'exec', 'ops_manager', 'admin'])
  db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)')
    .run(role + '@example.test', role, bcrypt.hashSync(pass, 4), role, role === 'centre' ? 'a' : null);

// Twelve operating days booked in November, then nothing: whatever the horizon is, this centre's
// December is a month nobody has booked into yet.
const ins = db.prepare('INSERT INTO daily_metrics(owna_id,metric_date,capacity,booked) VALUES(?,?,100,80)');
for (let d = 2; d <= 30; d++) {
  const day = new Date(Date.UTC(2026, 10, d));
  if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
  ins.run('a', '2026-11-' + String(d).padStart(2, '0'));
}
for (let d = 1; d <= 10; d++) ins.run('a', '2026-12-' + String(d).padStart(2, '0'));

const app = require('../server');
const report = require('../services/report-enrolment');
const originalFetch = global.fetch;
let server, base;
const login = async (role) => {
  const r = await originalFetch(base + '/login', { method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ email: role + '@example.test', password: pass }) });
  assert.equal(r.status, 302);
  return r.headers.get('set-cookie').split(';')[0];
};
const request = (url, cookie, body) => originalFetch(base + url, {
  headers: { cookie, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
  method: body ? 'POST' : 'GET', body: body ? new URLSearchParams(body) : undefined, redirect: 'manual' });

test('board report', async (t) => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  try {
    await t.test('only an admin can reach it', async () => {
      for (const role of ['viewer', 'centre', 'exec', 'ops_manager']) {
        for (const p of ['/reports/enrolment', '/reports/enrolment.csv']) {
          const r = await request(p, await login(role));
          assert.ok([302, 403].includes(r.status), role + ' ' + p + ' got ' + r.status);
        }
      }
      assert.equal((await request('/reports/enrolment', await login('admin'))).status, 200);
    });

    await t.test('renders before any OWNA snapshot has run', async () => {
      // The whole COE half is null until a snapshot completes. The page must still be readable rather
      // than 500 — this is the state a new environment is in.
      const html = await (await request('/reports/enrolment', await login('admin'))).text();
      assert.match(html, /No OWNA snapshot has completed/);
      assert.match(html, /Enrolment — board report/);
    });

    await t.test('the CSV downloads as a file and names its columns', async () => {
      const r = await request('/reports/enrolment.csv', await login('admin'));
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/csv/);
      assert.match(r.headers.get('content-disposition'), /attachment; filename="futuro-enrolment-\d{4}-\d{2}-\d{2}\.csv"/);
      const body = await r.text();
      assert.match(body, /^centre,month,enrolled,continuing,.*coverage_note$/m);
    });

    await t.test('an initiative round-trips, and markup in it is escaped', async () => {
      const c = await login('admin'), evil = '<img src=x onerror=alert(1)>';
      assert.equal((await request('/reports/enrolment/initiative', c,
        { starts_on: '2026-09-14', owna_id: 'a', title: evil, channel: 'signage' })).status, 302);
      const row = db.prepare('SELECT * FROM marketing_initiatives').get();
      assert.equal(row.title, evil);                       // stored verbatim
      const html = await (await request('/reports/enrolment', c)).text();
      assert.ok(!html.includes(evil));                     // never rendered as markup
      assert.match(html, /&lt;img/);
      assert.equal((await request('/reports/enrolment/initiative/' + row.id + '/delete', c, {})).status, 302);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM marketing_initiatives').get().n, 0);
    });

    await t.test('a bad initiative is refused rather than half-saved', async () => {
      const c = await login('admin');
      const r = await request('/reports/enrolment/initiative', c, { starts_on: 'not-a-date', title: '' });
      assert.equal(r.status, 302);
      assert.match(r.headers.get('location'), /err=/);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM marketing_initiatives').get().n, 0);
    });
  } finally { server.close(); }
});

test('occupancy is marked where the booking data stops', () => {
  // Without this, December reads as a centre with nobody in it. It is a month nobody has booked yet.
  const months = ['2026-11', '2026-12'];
  const rows = report.occupancyByMonth(months, new Map([['a', '2026-11-20']]));
  const a = rows.find((r) => r.owna_id === 'a');

  const nov = a.months['2026-11'];
  assert.equal(nov.partial_horizon, true, 'November straddles the 20th');
  assert.equal(nov.beyond_horizon, false);
  assert.equal(nov.horizon, '2026-11-20');

  const dec = a.months['2026-12'];
  assert.equal(dec.beyond_horizon, true, 'December starts after the last booked day');

  // And with no horizon known, nothing is marked — the flags must not invent a limit.
  const bare = report.occupancyByMonth(months).find((r) => r.owna_id === 'a');
  assert.equal(bare.months['2026-11'].beyond_horizon, false);
  assert.equal(bare.months['2026-11'].partial_horizon, false);
  // December holds 8 operating days of a 23-day month, so it is flagged thin whichever way it is read.
  assert.equal(bare.months['2026-12'].thin, true);
});
