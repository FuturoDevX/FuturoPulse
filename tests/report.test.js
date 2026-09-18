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
      assert.doesNotMatch(html, /<h2>Continuation of enrolment<\/h2>/);
      assert.match(html, /Booked occupancy by month/);
      assert.match(html, /Partial month/);
      assert.doesNotMatch(html, /nobody has booked|occupancy understated|average is dragged down/);
      assert.match(html, /Enrolment — board report/);
    });

    await t.test('the OWNA refresh is admin-only and refuses to start without a key', async () => {
      const snap = require('../services/snapshot');
      for (const role of ['viewer', 'centre', 'exec', 'ops_manager']) {
        const r = await request('/reports/enrolment/refresh-owna', await login(role), {});
        assert.ok([302, 403].includes(r.status), role + ' got ' + r.status);
        if (r.status === 302) assert.doesNotMatch(r.headers.get('location') || '', /^\/reports\/enrolment\?msg=/);
      }
      // The fixture environment inherits a real OWNA_API_KEY from .env, so the key guard does NOT stop
      // this — and without the NODE_ENV refusal in runSnapshotOnce, pressing it here starts a full
      // production pull from `npm test`. That is what this asserts: an admin gets a refusal, and no run
      // is left in flight.
      const c = await login('admin');
      const r = await request('/reports/enrolment/refresh-owna', c, {});
      assert.equal(r.status, 302);
      assert.match(r.headers.get('location'), /err=.*disabled/);
      assert.equal(snap.snapshotRunning(), false, 'no run may be left in flight from a test');
    });

    await t.test('the status endpoint reports counts and statuses only', async () => {
      const r = await request('/reports/enrolment/status', await login('admin'));
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      const body = await r.json();
      assert.deepEqual(Object.keys(body).sort(), ['error', 'last_run', 'refreshing', 'started_at']);
      assert.equal(body.refreshing, false);
      // Nothing about children, families or figures may travel down a polled endpoint.
      const text = JSON.stringify(body);
      assert.doesNotMatch(text, /continuing|enrolled|waitlist|child/i);
      assert.equal((await request('/reports/enrolment/status', await login('viewer'))).status === 200, false);
    });

    await t.test('a failed feed is disclosed on the page, not hidden behind a fresh date', async () => {
      // owna (day-rows) succeeding while coe fails is the real shape of the bug this card exists for:
      // the header would read "OWNA actuals to <today>" over continuation figures from an older night.
      const snap = require('../services/snapshot');
      snap.recordSync('owna', 'ok', '4 centres, 800 day-rows', { rows: 800 });
      snap.recordSync('coe', 'error', 'every OWNA children/attendance call failed');
      const html = await (await request('/reports/enrolment', await login('admin'))).text();
      assert.match(html, /The last pull did not complete/);
      assert.match(html, /Continuation of enrolment<\/strong> — error/);
      assert.match(html, /every OWNA children\/attendance call failed/);
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

test('the CSV never carries a figure the page refuses to show', () => {
  // A spreadsheet is where a caveat gets lost: a beyond-horizon occupancy computed off a handful of held
  // days looks like a real percentage to anyone sorting the column. It must be blank, with the reason in
  // the note — not printed with a footnote beside it.
  const model = {
    coe: { centres: [{ owna_id: 'a', name: 'Centre Alpha', months: [
      { month: '2026-11', enrolled: 100, continuing: 90, not_confirmed: 2, leaving: 8, continuing_pct: 90, beyond_horizon: false },
      { month: '2026-12', beyond_horizon: true },
    ] }] },
    occupancy: [{ owna_id: 'a', places: 100, months: {
      '2026-11': { avg_booked: 80, utilisation: 80, days_with_rows: 20, operating_days: 21, thin: false, beyond_horizon: false, partial_horizon: false, horizon: '2026-11-20' },
      // No occupancy rows at all — the only thing that now empties an occupancy cell. A COE horizon
      // must not do it: a month with real booked days keeps its figure and is marked instead.
      '2026-12': { avg_booked: 0, utilisation: null, days_with_rows: 0, operating_days: 22, thin: true, beyond_horizon: true, partial_horizon: false, horizon: '2026-11-20' },
    } }],
  };
  const head = report.csv(model).trim().split('\n')[0].split(',');
  const col = (row, name) => row[head.indexOf(name)];
  const rows = report.csv(model).trim().split('\n');
  const nov = rows[1].split(','), dec = rows[2].split(',');
  assert.equal(col(nov, 'occupancy_pct'), '80', 'a real month keeps its occupancy');
  assert.equal(col(dec, 'occupancy_pct'), '', 'a month with no occupancy rows carries no percentage');
  assert.equal(col(dec, 'booked_avg_per_day'), '', 'nor an average');
  assert.equal(col(dec, 'continuing'), '', 'nor a continuation count');
  assert.match(rows[2], /the forward booking pull behind continuation reached none of this month/);
  // The held-days columns stay, because they are what proves the blank is a blank and not a zero.
  assert.equal(col(dec, 'operating_days_held'), '0');
  assert.equal(col(dec, 'operating_days_in_month'), '22');
});

// The regression this exists for. Before 18 September 2026 a month was hidden when the roll ended inside
// it and left "more than a week" uncounted — and on live data that hid Bardia's March 2027, which had 150
// of 195 children continuing and ONE child unresolved, behind a dot saying nobody had booked that far
// ahead. A fully-measured month must never be blanked on the strength of where the roll happens to end.
test('a month the pull only partly covers is measured, not blanked', () => {
  const m = require('../services/metrics');
  const SNAP = '2026-09-18';
  db.prepare('DELETE FROM coe_continuing').run();
  db.prepare('DELETE FROM coe_forward_horizon').run();
  // Centre 'a' is booked to 19 March 2027 — inside March, nowhere near April.
  db.prepare(`INSERT INTO coe_forward_horizon (snapshot_date, owna_id, enrolled, last_booking_date, horizon_children, week_from, week_to)
              VALUES (?,?,?,?,?,?,?)`).run(SNAP, 'a', 195, '2027-03-19', 111, '2026-10-12', '2026-10-16');
  const cal = require('../services/calendar');
  const monthEnd = (ym) => { const [y, mo] = ym.split('-').map(Number); return ym + '-' + String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0'); };
  const ins = db.prepare(`INSERT INTO coe_continuing (snapshot_date, owna_id, month, enrolled, continuing, not_confirmed, leaving,
                            continuing_days, not_confirmed_days, leaving_days, operating_days, covered_days, beyond_horizon)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [month, continuing, notConfirmed] of [
    ['2026-11', 192, 2], ['2026-12', 180, 14], ['2027-01', 178, 16],
    ['2027-02', 150, 1], ['2027-03', 150, 1], ['2027-04', 0, 151],
  ]) {
    const opDays = cal.operatingDays(month + '-01', monthEnd(month));
    const covered = '2027-03-19' >= monthEnd(month) ? opDays
      : '2027-03-19' < month + '-01' ? 0
      : cal.operatingDays(month + '-01', '2027-03-19');
    ins.run(SNAP, 'a', month, 195, continuing, notConfirmed, 44, continuing * 3, notConfirmed * 3, 132, opDays, covered, covered === 0 ? 1 : 0);
  }

  const byMonth = new Map(m.coeMeasured().centres.find((c) => c.owna_id === 'a').months.map((x) => [x.month, x]));

  const feb = byMonth.get('2027-02');
  assert.equal(feb.beyond_horizon, false);
  assert.equal(feb.partial_horizon, false, 'February is covered end to end');
  assert.equal(feb.in_group, true);

  // THE FIX. March is covered to the 19th — 15 of its 21 operating days — and 150 of 195 children are
  // accounted for with one unresolved. It is a measurement and it must be published, marked.
  const mar = byMonth.get('2027-03');
  assert.equal(mar.beyond_horizon, false, 'March must not be blanked: the pull reaches most of it');
  assert.equal(mar.partial_horizon, true, 'but it is only part of the month, and says so');
  assert.equal(mar.covered_days, 15);
  assert.equal(mar.operating_days, 21);
  assert.equal(mar.thin, false, '15 days is well over a full operating week');
  assert.equal(mar.in_group, true, 'so it counts toward the group figure');
  assert.equal(mar.continuing_pct, 76.9);

  // April is genuinely unreachable — the roll ends eleven days before it starts. This one IS a dot.
  const apr = byMonth.get('2027-04');
  assert.equal(apr.covered_days, 0);
  assert.equal(apr.beyond_horizon, true);
  assert.equal(apr.in_group, false);

  // And the group figure says how many centres it covers, per month, so April's is not read as the whole.
  const g = new Map(m.coeMeasured().group.months.map((x) => [x.month, x]));
  assert.equal(g.get('2027-03').centres_measured, 1);
  assert.equal(g.get('2027-03').centres_beyond, 0);
  assert.equal(g.get('2027-04').centres_measured, 0);
  assert.equal(g.get('2027-04').centres_beyond, 1);
});

test('a month covered by less than one operating week is reported but kept out of the group', () => {
  const m = require('../services/metrics');
  const SNAP = '2026-09-18';
  const cal = require('../services/calendar');
  // Two operating days of April: a child booked one day a week need not appear at all in that, so their
  // absence measures the calendar, not a decision. Reported, marked, and not averaged into the group.
  db.prepare('UPDATE coe_forward_horizon SET last_booking_date = ? WHERE snapshot_date = ? AND owna_id = ?').run('2027-04-02', SNAP, 'a');
  const covered = cal.operatingDays('2027-04-01', '2027-04-02');
  db.prepare('UPDATE coe_continuing SET covered_days = ?, beyond_horizon = 0, continuing = 109, not_confirmed = 37 WHERE snapshot_date = ? AND owna_id = ? AND month = ?')
    .run(covered, SNAP, 'a', '2027-04');
  const apr = m.coeMeasured().centres.find((c) => c.owna_id === 'a').months.find((x) => x.month === '2027-04');
  assert.equal(apr.covered_days, 2);
  assert.equal(apr.beyond_horizon, false, 'two days is not "reached none of"');
  assert.equal(apr.thin, true);
  assert.equal(apr.in_group, false, 'and a two-day average is not a month');
  assert.ok(apr.continuing_pct > 0, 'the figure is still reported, so the reader can see what it is');
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

  // December starts after the last COE booking, but it HOLDS eight days of its own booking rows. A
  // horizon derived from a different OWNA pull must not blank a month that has its own evidence — that
  // was throwing away real occupancy. It is marked understated, not emptied.
  const dec = a.months['2026-12'];
  assert.equal(dec.beyond_horizon, false, 'a month with booked days of its own is not empty');
  assert.equal(dec.partial_horizon, true, 'it is past the last booked day, so the average is understated');
  assert.ok(dec.utilisation > 0, 'and it keeps the figure those days produce');

  // And with no horizon known, nothing is marked — the flags must not invent a limit.
  const bare = report.occupancyByMonth(months).find((r) => r.owna_id === 'a');
  assert.equal(bare.months['2026-11'].beyond_horizon, false);
  assert.equal(bare.months['2026-11'].partial_horizon, false);
  // December holds 8 operating days of a 23-day month, so it is flagged thin whichever way it is read.
  assert.equal(bare.months['2026-12'].thin, true);
});
