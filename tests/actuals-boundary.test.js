// The actual/forecast boundary.
//
// daily_metrics carries forward bookings as well as history. On a forward row `booked` is a fact but
// `attended` is not a measurement — it is OWNA's default attending flag on a day that has not happened.
// The code used to treat `metric_date <= today` as the past, which is correct only while the nightly feed
// is current. It was not: on 2026-09-17 the last good pull was 2026-09-10, so six days of forward bookings
// were counted as observed attendance and the dashboard reported Heath Rd at a flat 100% against a real
// 81.1%. These tests pin the boundary to the last successful snapshot so that cannot come back.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-actuals-'));
process.env.DB_PATH = path.join(dir, 'test.db'); process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'fixture-session-only';
process.env.ADMIN_EMAIL = 'test-admin@example.test'; process.env.ADMIN_DEFAULT_PASSWORD = 'FixturePasswordOnly!';
const db = require('../db/db');
const m = require('../services/metrics'), cal = require('../services/calendar');

// Same freeze helper as tests/week2.test.js: move the APP's clock via services/calendar, never global Date.
function freeze(iso, fn) {
  cal.setNow(iso);
  const restore = () => { cal.setNow(null); };
  let out; try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
  restore(); return out;
}

// "Today" for these tests is Thursday 17 September 2026 in Sydney; the last good pull was the 10th.
const NOW = '2026-09-17T02:00:00Z';      // 12:00 on the 17th in Sydney
const SNAP_DAY = '2026-09-10', TODAY = '2026-09-17';

db.prepare('INSERT INTO centres(owna_id,name,capacity,approved_places,opening) VALUES(?,?,?,?,0)').run('a', 'Centre Alpha', 100, 100);
const dm = db.prepare('INSERT INTO daily_metrics(owna_id,metric_date,capacity,booked,attended,absent,casual,fee_total) VALUES(?,?,100,?,?,?,0,0)');
// Observed days, 8–10 Sep: a real 80% attendance (80 of 100 booked).
for (const d of ['2026-09-08', '2026-09-09', '2026-09-10']) dm.run('a', d, 100, 80, 20);
// Forward bookings, 11–18 Sep: OWNA says everyone is attending, because nothing has happened yet.
for (const d of ['2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']) dm.run('a', d, 100, 100, 0);
// The feed's own record: one good run that finished on the 10th, and a later failure that wrote nothing.
db.prepare("INSERT INTO snapshot_runs(started_at,finished_at,status,window_from,window_to,rows_written) VALUES(?,?,'ok',?,?,772)")
  .run('2026-09-10 09:47:14', '2026-09-10 09:50:30', '2026-05-13', '2027-05-08');
db.prepare("INSERT INTO snapshot_runs(started_at,finished_at,status,rows_written) VALUES(?,?,'error',0)")
  .run('2026-09-16 08:00:46', '2026-09-16 08:18:27');

test('the actuals boundary is the last successful snapshot, not today', () => {
  freeze(NOW, () => {
    assert.equal(m.todayStr(), TODAY);
    assert.equal(m.lastActualDate(), SNAP_DAY, 'a failed run must not move the boundary forward');
    assert.equal(m.actualsLagDays(), 7, 'the page needs to be able to say how stale the figure is');
  });
});

test('the default range ends where observation ends, so the landing page is not all forecast', () => {
  freeze(NOW, () => {
    const r = m.defaultRange();
    assert.equal(r.to, SNAP_DAY, 'defaulting to today would have made the whole window forward bookings');
    assert.equal(r.from, '2026-09-04');
  });
});

test('overview reports the observed attendance rate, not the forward bookings\' perfect one', () => {
  freeze(NOW, () => {
    // Deliberately ask for a window that spans the boundary — this is what the old default did.
    const [row] = m.overview('2026-09-08', '2026-09-18');
    assert.equal(row.attended, 240, 'only the three observed days contribute attendance');
    assert.equal(row.past_booked, 300, 'and only their bookings are the denominator: 3 days x 100 booked');
    assert.equal(row.attendance_rate, 80, 'the honest figure; counting forward rows gave 93.9%');
    assert.equal(row.future_booked, 600, 'the six forward days are booked, and are reported as forecast');
  });
});

test('centreDaily hands out no attendance rate for a day nobody observed', () => {
  freeze(NOW, () => {
    const rows = m.centreDaily('a', '2026-09-08', '2026-09-18');
    const observed = rows.filter((r) => r.observed), forecast = rows.filter((r) => !r.observed);
    assert.equal(observed.length, 3);
    assert.equal(forecast.length, 6);
    assert.ok(observed.every((r) => r.attendance_rate === 80), 'observed days keep their real rate');
    assert.ok(forecast.every((r) => r.attendance_rate === null),
      'a forward row must return null, not 100 — the next caller will not know to re-check the date');
    assert.ok(forecast.every((r) => r.booked === 100), 'bookings stay: they are real on both sides');
  });
});

test('with no successful run on record the boundary falls back to today rather than hiding everything', () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-actuals-empty-'));
  const prev = process.env.DB_PATH;
  process.env.DB_PATH = path.join(dir2, 'test.db');
  delete require.cache[require.resolve('../db/db')];
  delete require.cache[require.resolve('../services/metrics')];
  const m2 = require('../services/metrics');
  try {
    freeze(NOW, () => assert.equal(m2.lastActualDate(), TODAY));
  } finally {
    process.env.DB_PATH = prev;
    delete require.cache[require.resolve('../db/db')];
    delete require.cache[require.resolve('../services/metrics')];
  }
});

// ===== The boundary tracks the OWNA feed, not the nightly job as a whole =====
// runSnapshot marks a run "partial" if ANY step failed, and those steps include LineLeader, the exits
// pull and the retention purge. Keying the boundary to status='ok' meant one flaky secondary source
// froze every attendance figure on the dashboard even though OWNA's day-rows had landed.
test('a run that OWNA succeeded in is honoured even when another source failed', () => {
  db.prepare("INSERT INTO snapshot_runs(started_at,finished_at,status,rows_written) VALUES(?,?,'partial',?)")
    .run('2026-09-16 09:00:00', '2026-09-16 09:40:00', 900);
  freeze(NOW, () => {
    assert.equal(m.lastActualDate(), '2026-09-16',
      'a partial run that wrote day-rows still moved the OWNA feed forward');
    assert.equal(m.actualsLagDays(), 1);
  });
});

test('the per-source record wins over the run row, and a run that wrote nothing is ignored', () => {
  // A later run that wrote no rows must not move the boundary: it is not evidence of anything.
  db.prepare("INSERT INTO snapshot_runs(started_at,finished_at,status,rows_written) VALUES(?,?,'ok',0)")
    .run('2026-09-17 02:15:00', '2026-09-17 02:16:00');
  freeze(NOW, () => assert.equal(m.lastActualDate(), '2026-09-16', 'a zero-row run proves nothing'));

  // Once the OWNA pull records itself, that is the authority.
  db.prepare("INSERT INTO source_sync(source,last_attempt,last_success,status,rows) VALUES('owna',?,?,'ok',1200)")
    .run('2026-09-15 09:50:00', '2026-09-15 09:50:00');
  freeze(NOW, () => assert.equal(m.lastActualDate(), '2026-09-15',
    'the feed’s own record is the narrower, truer answer'));
});
