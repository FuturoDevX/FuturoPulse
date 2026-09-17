// The centre-manager screen (/manager).
//
// Each of these pins a defect an adversarial review found in the first cut, all of which produced a
// confident wrong number on a page a director uses to decide whether to sell a place:
//   - a week that had already happened reported "~0 seats likely to sit empty" while 45 place-days
//     had genuinely sat empty, because the forecast field is null once a day is observed;
//   - a gazetted public holiday drew a full seat grid with 67 green "free" tiles and an expected head
//     count, because OWNA keeps booking rows through a closure and nothing checked the operating day;
//   - the same holidays dragged the weekday show-rate down, inflating the empty-seat forecast;
//   - a week with no data at all reported 0 free places rather than "not known";
//   - a regex-valid but impossible ?week= reached toISOString() and returned a 500.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-manager-'));
process.env.DB_PATH = path.join(dir, 'test.db'); process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'test-admin@example.test'; process.env.ADMIN_DEFAULT_PASSWORD = 'FixturePasswordOnly!';
process.env.SESSION_SECRET = 'fixture-session-only';
const db = require('../db/db'), bcrypt = require('bcryptjs');
const m = require('../services/metrics'), cal = require('../services/calendar');
const pass = 'FixturePasswordOnly!';

function freeze(iso, fn) {
  cal.setNow(iso);
  const restore = () => { cal.setNow(null); };
  let out; try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
  restore(); return out;
}

// Two centres, 100 approved places each; one pre-opening. A 'centre' login is scoped to A.
db.prepare("INSERT INTO centres(owna_id,name,capacity,approved_places,opening) VALUES('a','Centre Alpha',100,100,0)").run();
db.prepare("INSERT INTO centres(owna_id,name,capacity,approved_places,opening) VALUES('b','Centre Beta',100,100,0)").run();
db.prepare("INSERT INTO centres(owna_id,name,capacity,approved_places,opening) VALUES('soon','Centre Soon',0,NULL,1)").run();
for (const [role, loc] of [['centre', 'a'], ['exec', null], ['admin', null], ['centre_soon', 'soon']])
  db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)')
    .run(role + '@example.test', role, bcrypt.hashSync(pass, 4), role === 'centre_soon' ? 'centre' : role, loc);

const dm = db.prepare('INSERT INTO daily_metrics(owna_id,metric_date,capacity,booked,attended,absent,casual,fee_total) VALUES(?,?,100,?,?,?,0,0)');

// The feed's boundary: one good run finishing 2026-09-10.
db.prepare("INSERT INTO snapshot_runs(started_at,finished_at,status,rows_written) VALUES('2026-09-10 09:00:00','2026-09-10 09:50:30','ok',772)").run();
const NOW = '2026-09-17T02:00:00Z', SNAP = '2026-09-10';

// --- An OBSERVED week, 31 Aug – 4 Sep: 100 booked, 90 attended each day. 10 seats empty per day. ---
for (const d of ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) dm.run('a', d, 100, 90, 10);
// --- A FUTURE week, 14–18 Sep: forward bookings, attended == booked as OWNA returns them. ---
for (const d of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']) dm.run('a', d, 100, 100, 0);
// --- A week containing NSW Labour Day, Monday 5 October 2026. OWNA keeps the bookings; nobody attends. ---
dm.run('a', '2026-10-05', 60, 0, 60);                       // the closed Monday
for (const d of ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']) dm.run('a', d, 100, 100, 0);
// --- A window around King's Birthday (Monday 8 June 2026) to prove a closure is kept out of the
//     show-rate. Two ordinary Mondays at 90%, and the holiday Monday at 0% as OWNA actually records it.
//     Including it would give (90+90+0)/(100+100+60) = 69.2% instead of the true 90%. ---
dm.run('a', '2026-06-08', 60, 0, 60);                       // King's Birthday — closed, nobody attends
dm.run('a', '2026-06-01', 100, 90, 10);
dm.run('a', '2026-05-25', 100, 90, 10);

test('a public holiday is a closed day, not a day with 60 free places', () => {
  freeze(NOW, () => {
    assert.equal(cal.isOperatingDay('2026-10-05'), false, 'fixture assumption: 5 Oct 2026 is NSW Labour Day');
    const w = m.managerWeek('a', '2026-10-05');
    const mon = w.days[0];
    assert.equal(mon.operating, false);
    assert.equal(mon.head, null, 'no head count may be forecast for a day the centre is shut');
    assert.equal(mon.emptySeats, null, 'and therefore no empty seats');
    assert.equal(mon.available, null, 'nor any free places to sell');
    assert.equal(mon.booked, 60, 'the booking rows are still reported, so the page can explain them');
  });
});

test('the show-rate is measured on operating days only', () => {
  // Stand the clock at 15 June 2026 so the trailing 8 weeks span King's Birthday.
  freeze('2026-06-15T02:00:00Z', () => {
    assert.equal(cal.isOperatingDay('2026-06-08'), false, "fixture assumption: 8 June 2026 is King's Birthday");
    const sr = m.showRateByDow('a');
    assert.ok(sr.from <= '2026-06-08' && '2026-06-08' <= sr.to, 'the holiday must fall inside the window: ' + sr.from + '..' + sr.to);
    const mon = sr.byDow[1];
    assert.ok(mon, 'there are Monday rows in the window');
    assert.equal(mon.days, 2, 'only the two OPERATING Mondays count; the closure is excluded');
    assert.ok(Math.abs(mon.rate - 0.9) < 1e-9,
      'Monday should read 90%, not the 69.2% that including the closure gives; got ' + mon.rate);
  });
});

test('an observed week reports the seats that actually sat empty, not ~0', () => {
  freeze(NOW, () => {
    const w = m.managerWeek('a', '2026-08-31');
    assert.equal(w.isPast, true);
    for (const d of w.days) {
      assert.equal(d.headBasis, 'measured');
      assert.equal(d.head, 90, 'the head count of an observed day is what was measured');
      assert.equal(d.emptySeats, 10, '100 approved places less 90 who attended');
    }
    const total = w.days.reduce((s, d) => s + d.emptySeats, 0);
    assert.equal(total, 50, 'the week sat 50 place-days empty; the first cut reported ~0');
    const act = m.managerActions('a', w).find((a) => a.kind === 'opportunity');
    assert.ok(act, 'the empty seats must be surfaced as an action');
    assert.equal(act.forecast, false, 'a measured figure is not a forecast');
    assert.match(act.title, /sat empty/, 'and a past week is described, not prescribed: ' + act.title);
  });
});

test('a future week reports an estimate, labelled as one', () => {
  freeze(NOW, () => {
    const w = m.managerWeek('a', '2026-09-14');
    assert.equal(w.isFuture, false, '14 Sep is the current week, not a future one');
    for (const d of w.days) assert.equal(d.headBasis, 'estimated');
    const act = m.managerActions('a', w).find((a) => a.kind === 'opportunity');
    assert.equal(act.forecast, true);
    assert.match(act.title, /likely to sit empty/);
    assert.match(act.detail, /Estimated from the last 8 observed weeks/);
  });
});

test('a week with no data says so, rather than reporting zero free places', () => {
  freeze(NOW, () => {
    const w = m.managerWeek('a', '2027-06-07');
    assert.equal(w.hasData, false);
    for (const d of w.days) {
      assert.equal(d.booked, null);
      assert.equal(d.available, null, 'unknown, not zero');
      assert.equal(d.emptySeats, null);
    }
    const acts = m.managerActions('a', w);
    assert.ok(acts.some((a) => a.kind === 'nodata'), 'the page must say nothing is known about this week');
    assert.ok(!acts.some((a) => a.kind === 'fill'), 'and must not claim free places it cannot see');
  });
});

test('the attendance figure names the last observed day OF THE WEEK on screen', () => {
  freeze(NOW, () => {
    const past = m.managerWeek('a', '2026-08-31');
    assert.equal(past.weekObservedTo, '2026-09-04', 'not the feed boundary of ' + past.observedTo);
    assert.equal(past.observedTo, SNAP);
    const future = m.managerWeek('a', '2026-09-14');
    assert.equal(future.weekObservedTo, null, 'no day of the current week has been observed');
  });
});

test('mondayOf refuses a date that is not a real day', () => {
  for (const bad of ['2026-13-45', '2026-00-10', '2026-02-30', 'not-a-date', '', null, undefined])
    assert.equal(m.mondayOf(bad), null, 'should refuse ' + bad);
  assert.equal(m.mondayOf('2026-09-16'), '2026-09-14', 'a Wednesday maps back to its Monday');
  assert.equal(m.mondayOf('2026-09-14'), '2026-09-14');
  assert.equal(m.mondayOf('2026-09-20'), '2026-09-14', 'a Sunday belongs to the week that began the 14th');
  assert.equal(m.mondayOf('2027-01-01'), '2026-12-28', 'across a year boundary');
});


// ===== The route =====
// Harness as in tests/week2.test.js: the app on an ephemeral port, form login, manual redirects.
const app = require('../server');

test('the /manager route: bad dates, scoping and pre-opening centres', async (t) => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = async (email) => {
    const r = await fetch(base + '/login', {
      method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ email, password: pass }),
    });
    assert.equal(r.status, 302, 'login as ' + email);
    return r.headers.get('set-cookie').split(';')[0];
  };
  const get = (url, cookie) => fetch(base + url, { headers: { cookie }, redirect: 'manual' });

  try {
    const exec = await login('exec@example.test');
    const centre = await login('centre@example.test');
    const soon = await login('centre_soon@example.test');

    await t.test('a well-formed but impossible week is refused, not a 500', async () => {
      for (const bad of ['2026-13-45', '2026-00-10', '2026-02-30']) {
        const r = await get('/manager?owna=a&week=' + bad, exec);
        assert.equal(r.status, 400, bad + ' should be a 400, not a 500 error page');
      }
      assert.equal((await get('/manager?owna=a&week=2026-09-16', exec)).status, 200, 'a real date still works');
      assert.equal((await get('/manager?owna=a', exec)).status, 200, 'and so does no week at all');
    });

    await t.test('a scoped centre login is refused another centre, not silently given its own', async () => {
      assert.equal((await get('/manager?owna=a', centre)).status, 200, 'its own centre is fine');
      const r = await get('/manager?owna=b', centre);
      assert.equal(r.status, 403, 'asking for centre b must be refused outright');
      const body = await r.text();
      assert.ok(!/Centre Beta/.test(body), 'and must not name the other centre back');
    });

    await t.test('a login scoped to a pre-opening centre is sent to the pipeline, not an empty week', async () => {
      const r = await get('/manager', soon);
      assert.equal(r.status, 302);
      assert.match(r.headers.get('location'), /^\/centre\/soon$/);
    });

    await t.test('the page never states a figure it does not have', async () => {
      const body = await (await get('/manager?owna=a&week=2027-06-07', exec)).text();
      assert.match(body, /No booking data for this week/, 'a week past the horizon must say nothing is known');
      assert.ok(!/place-days with no booking at all against them[\s\S]{0,80}>0</.test(body),
        'and must not print a confident zero for free places');
    });
  } finally {
    server.close();
    await new Promise((r) => server.once('close', r));
  }
});

// ===== A week that mixes observed and forecast days =====
// Found by the second review round: keying the tilde and the tense off "estimated && !measured" meant
// one observed day was enough to announce a part-modelled total as a flat past-tense measurement.
test('a week that is part observed and part forecast is never stated as a measurement', () => {
  // Boundary is 2026-09-10 (Thursday). The week of 7 Sep therefore has Mon-Thu observed and Fri forecast.
  for (const [d, booked, attended] of [['2026-09-07', 100, 90], ['2026-09-08', 100, 90],
                                       ['2026-09-09', 100, 90], ['2026-09-10', 100, 90]])
    dm.run('a', d, booked, attended, booked - attended);
  dm.run('a', '2026-09-11', 100, 100, 0);   // forward booking: OWNA's default attending flag

  freeze(NOW, () => {
    const w = m.managerWeek('a', '2026-09-07');
    const basis = w.days.map((d) => d.headBasis);
    assert.deepEqual(basis, ['measured', 'measured', 'measured', 'measured', 'estimated'],
      'the boundary falls inside this week');
    const act = m.managerActions('a', w).find((x) => x.kind === 'opportunity');
    assert.ok(act, 'the empty seats are surfaced');
    assert.equal(act.forecast, true, 'one estimated day makes the whole total an estimate');
    assert.match(act.impact, /^~/, 'and the impact carries a tilde');
    assert.match(act.detail, /Part measured, part forecast: 4 of 5 days have been observed/);
    assert.doesNotMatch(act.title, /sat empty/, 'it must not be phrased as a completed measurement');
  });
});

test('a figure is not reported for a licence that was never recorded', () => {
  db.prepare("INSERT INTO centres(owna_id,name,capacity,approved_places,opening) VALUES('nolic','No Licence',0,NULL,0)").run();
  for (const d of ['2026-09-14', '2026-09-15', '2026-09-16']) dm.run('nolic', d, 40, 40, 0);
  freeze(NOW, () => {
    const w = m.managerWeek('nolic', '2026-09-14');
    assert.equal(w.places, null);
    for (const d of w.days.filter((x) => x.booked != null)) {
      assert.equal(d.available, null, 'no licence means no free places, not zero free places');
      assert.equal(d.emptySeats, null);
      assert.equal(d.occupancy, null);
    }
    const acts = m.managerActions('nolic', w);
    assert.ok(acts.some((a) => a.kind === 'places'), 'the missing licence is called out');
    assert.ok(!acts.some((a) => a.kind === 'fill'), 'and no free-places claim is made');
  });
});

test('an operating day with no row reports unknown occupancy, not 0%', () => {
  freeze(NOW, () => {
    const w = m.managerWeek('a', '2027-06-07');
    for (const d of w.days) assert.equal(d.occupancy, null, d.date + ' has no row, so occupancy is unknown');
  });
});

test('the show-rate window is exactly the number of weeks asked for', () => {
  freeze(NOW, () => {
    const sr = m.showRateByDow('a', 8);
    const days = Math.round((Date.parse(sr.to + 'T00:00:00Z') - Date.parse(sr.from + 'T00:00:00Z')) / 86400000) + 1;
    assert.equal(days, 56, 'BETWEEN is inclusive at both ends, so 8 weeks must span 56 days, not 57');
  });
});
