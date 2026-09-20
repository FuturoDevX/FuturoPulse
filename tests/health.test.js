// Feed health: /healthz for an external monitor, and the topbar chip for the people who can act on it.
//
// Both read services/health.js, so they cannot tell different stories. The case that matters most is the
// one an alert-on-failure scheme cannot see: a nightly job that never ran throws nothing, so nothing
// fails, and silence looks exactly like success.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-health-'));
process.env.DB_PATH = path.join(dir, 'test.db'); process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'test-admin@example.test'; process.env.ADMIN_DEFAULT_PASSWORD = 'FixturePasswordOnly!';
process.env.SESSION_SECRET = 'fixture-session-only'; process.env.ANTHROPIC_API_KEY = 'fixture';
const db = require('../db/db'), bcrypt = require('bcryptjs');
const pass = 'FixturePasswordOnly!';
for (const [id, name] of [['a', 'Centre Alpha'], ['b', 'Centre Beta']])
  db.prepare('INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,100,0)').run(id, name);
for (const role of ['viewer', 'centre', 'exec', 'ops_manager', 'admin'])
  db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)')
    .run(role + '@example.test', role, bcrypt.hashSync(pass, 4), role, role === 'centre' ? 'a' : null);

const { feedHealth } = require('../services/health');
const app = require('../server');
const originalFetch = global.fetch;
let server, base;
const login = async (role) => {
  const r = await originalFetch(base + '/login', { method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ email: role + '@example.test', password: pass }) });
  assert.equal(r.status, 302);
  return r.headers.get('set-cookie').split(';')[0];
};
const page = (url, cookie) => originalFetch(base + url, { headers: { cookie }, redirect: 'manual' });

const ALL = ['owna', 'coe', 'lineleader', 'eh_labour', 'talent', 'exits', 'incidents', 'roster', 'retention'];
const setSources = (fn) => {
  db.prepare('DELETE FROM source_sync').run();
  const ins = db.prepare(`INSERT INTO source_sync (source,last_attempt,last_success,status,detail)
                          VALUES (?, datetime('now'), datetime('now', ?), ?, ?)`);
  for (const s of ALL) { const o = fn(s) || {}; ins.run(s, o.ago || '-1 hours', o.status || 'ok', o.detail || null); }
};
const setRun = (offset, status) => {
  db.prepare('DELETE FROM snapshot_runs').run();
  if (offset === null) return;
  db.prepare(`INSERT INTO snapshot_runs (started_at, finished_at, status, rows_written)
              VALUES (datetime('now', ?), datetime('now', ?), ?, 800)`).run(offset, offset, status);
};

test('feed health', async (t) => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  try {
    await t.test('everything fresh is 200 and ok', async () => {
      setSources(() => ({})); setRun('-2 hours', 'ok');
      const r = await originalFetch(base + '/healthz');
      assert.equal(r.status, 200);
      const b = await r.json();
      assert.equal(b.status, 'ok');
      assert.deepEqual(b.problems, []);
    });

    await t.test('the monitor never picks up a session cookie', async () => {
      // /healthz is mounted before the session middleware: 288 polls a day would otherwise mint 288
      // session rows nothing will ever read again.
      const r = await originalFetch(base + '/healthz');
      assert.equal(r.headers.get('set-cookie'), null);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    });

    await t.test('a failing critical feed is 503; a failing secondary one is not', async () => {
      setSources((s) => (s === 'roster' ? { status: 'error' } : {}));
      setRun('-2 hours', 'partial');
      let b = await (await originalFetch(base + '/healthz')).json();
      assert.equal(b.status, 'degraded', 'roster is not what the board figures rest on');
      assert.equal((await originalFetch(base + '/healthz')).status, 200);

      setSources((s) => (s === 'eh_labour' ? { status: 'error' } : {}));
      const r = await originalFetch(base + '/healthz');
      assert.equal(r.status, 503);
      b = await r.json();
      assert.equal(b.status, 'down');
      assert.ok(b.problems.some((p) => p.startsWith('eh_labour:')));
    });

    await t.test('a feed that simply stopped is caught without anything having thrown', async () => {
      // status is still "ok" — the last attempt succeeded. It was just three days ago. This is the OWNA
      // failure of September 2026: recorded as a success, silent, for eight days.
      setSources((s) => (s === 'owna' ? { ago: '-72 hours' } : {}));
      setRun('-2 hours', 'ok');
      const r = await originalFetch(base + '/healthz');
      assert.equal(r.status, 503);
      const b = await r.json();
      assert.ok(b.problems.some((p) => /^owna: no successful pull for/.test(p)));
      assert.equal(b.sources.find((x) => x.source === 'owna').status, 'ok', 'still "ok", and still wrong');
    });

    await t.test('a nightly run that never happened is caught — the blind spot', async () => {
      setSources(() => ({}));
      setRun(null, null);
      let b = await (await originalFetch(base + '/healthz')).json();
      assert.equal(b.status, 'down');
      assert.ok(b.problems.includes('no snapshot has ever completed'));

      setRun('-40 hours', 'ok');   // it ran, it succeeded, and then it never ran again
      const r = await originalFetch(base + '/healthz');
      assert.equal(r.status, 503);
      b = await r.json();
      assert.ok(b.problems.some((p) => /nightly snapshot has not completed/.test(p)));
    });

    await t.test('a feed that is switched off is not a failure', async () => {
      // No Employment Hero credentials configured is a decision, not a fault. A monitor that pages
      // someone over an optional feed being off gets muted, and then it is worth nothing.
      setSources((s) => (s === 'eh_labour' ? { status: 'skipped', ago: '-500 hours' } : {}));
      setRun('-2 hours', 'ok');
      const r = await originalFetch(base + '/healthz');
      assert.equal(r.status, 200);
      const b = await r.json();
      assert.equal(b.sources.find((x) => x.source === 'eh_labour').configured, false);
      assert.ok(!b.problems.some((p) => p.startsWith('eh_labour')));
    });

    await t.test('upstream error text never reaches the endpoint', async () => {
      const secret = 'employee Jane Citizen was rejected by the payroll host';
      setSources((s) => (s === 'owna' ? { status: 'error', detail: secret } : {}));
      setRun('-2 hours', 'partial');
      const body = await (await originalFetch(base + '/healthz')).text();
      assert.doesNotMatch(body, /Jane Citizen/);
      assert.doesNotMatch(body, /payroll host/);
      assert.doesNotMatch(body, /"detail"/);
    });

    await t.test('HEALTHZ_TOKEN closes the endpoint, and says nothing when it is wrong', async () => {
      process.env.HEALTHZ_TOKEN = 'a-long-unguessable-value';
      try {
        assert.equal((await originalFetch(base + '/healthz')).status, 404, 'no hint that it exists');
        assert.equal((await originalFetch(base + '/healthz?token=wrong')).status, 404);
        const ok = await originalFetch(base + '/healthz?token=a-long-unguessable-value');
        assert.ok([200, 503].includes(ok.status));
      } finally { delete process.env.HEALTHZ_TOKEN; }
    });

    await t.test('the topbar chip shows for admin and ops, and for nobody else', async () => {
      setSources((s) => (s === 'owna' ? { status: 'error' } : {}));
      setRun('-2 hours', 'partial');
      for (const role of ['admin', 'ops_manager']) {
        const html = await (await page('/', await login(role))).text();
        assert.match(html, /feed-chip down/, role + ' must see it');
        assert.match(html, /Data feeds down/);
      }
      for (const role of ['viewer', 'centre', 'exec']) {
        const r = await page('/', await login(role));
        if (r.status !== 200) continue;                    // some roles are scoped away from /
        const html = await r.text();
        assert.doesNotMatch(html, /feed-chip/, role + ' cannot act on this and must not be shown it');
      }
    });

    await t.test('the chip is absent when everything is healthy', async () => {
      setSources(() => ({})); setRun('-2 hours', 'ok');
      const html = await (await page('/', await login('admin'))).text();
      assert.doesNotMatch(html, /feed-chip/, 'a permanent green badge is furniture people stop reading');
    });

    await t.test('the chip and the endpoint always agree', async () => {
      setSources((s) => (s === 'talent' ? { status: 'error' } : {}));
      setRun('-2 hours', 'partial');
      const endpoint = await (await originalFetch(base + '/healthz')).json();
      const html = await (await page('/', await login('admin'))).text();
      assert.equal(endpoint.status, 'down');
      assert.match(html, /feed-chip down/);
      assert.equal(feedHealth().status, endpoint.status);
    });
  } finally { server.close(); }
});

test('the assessment survives a database it cannot read', () => {
  // The health check must never be the thing that breaks. It reports down, and says nothing more.
  const real = db.prepare;
  db.prepare = () => { throw new Error('database is locked'); };
  try {
    const h = feedHealth();
    assert.equal(h.status, 'down');
    assert.equal(h.healthy, false);
    assert.deepEqual(h.problems, ['the dashboard could not read its own status']);
  } finally { db.prepare = real; }
});
