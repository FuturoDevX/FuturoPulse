// The forward attendance pull.
//
// A single request for a long range does not come back whole. Walked over a seven- and a twelve-month
// window, the four operating centres' booked child-days came back missing whole Monday-to-Friday blocks
// from the MIDDLE of the range — 17 gaps, every one starting on a Monday and ending on a Friday, several
// with complete weeks either side. No pattern of family bookings produces that.
//
// What it cost was not the missing days but the inference drawn from them: the last date a pull happened
// to return became "the centre's booking horizon", and two centres' continuation was blanked on a board
// report under a footnote saying families had not booked that far ahead. They had.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-pull-')), 'test.db');
process.env.NODE_ENV = 'test';
process.env.OWNA_API_KEY = process.env.OWNA_API_KEY || 'fixture-key';
process.env.OWNA_RETRIES = '0';                 // no test may sit in a backoff loop
const { owna, getAllWithMeta, monthChunks } = require('../services/owna');

const realFetch = global.fetch;
const json = (body) => ({ ok: true, status: 200, headers: new Map([['content-type', 'application/json']]),
  text: async () => JSON.stringify(body) });
// The header lookup in services/owna.js uses res.headers.get(), which a Map provides.

test('monthChunks splits a range on calendar months and clips both ends', () => {
  const c = monthChunks('2026-09-18', '2027-04-30');
  assert.equal(c.length, 8);
  assert.deepEqual(c[0], { from: '2026-09-18', to: '2026-09-30' }, 'the first chunk starts where asked');
  assert.deepEqual(c[7], { from: '2027-04-01', to: '2027-04-30' }, 'the last chunk ends where asked');
  for (let i = 1; i < c.length; i++) assert.equal(c[i].from > c[i - 1].to, true, 'chunks do not overlap');
  // A range inside one month is one chunk, not a month-wide one.
  assert.deepEqual(monthChunks('2027-03-05', '2027-03-20'), [{ from: '2027-03-05', to: '2027-03-20' }]);
  // A leap February is 29 days.
  assert.equal(monthChunks('2028-02-01', '2028-02-29')[0].to, '2028-02-29');
});

test('a walk that ends holding fewer rows than OWNA declared is reported short', async () => {
  // OWNA says 1200 rows exist; the walk is handed a repeat of page one and its skip counter runs ahead
  // of the unique rows it holds, so it exits believing it is done. That is the shape that truncates a
  // long range: rows RECEIVED, not rows HELD, drive the exit condition.
  let call = 0;
  global.fetch = async () => {
    call += 1;
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: (call === 2 ? 0 : (call - 1) * 500) + i }));
    return json({ data: rows, totalCount: 1200 });
  };
  try {
    const { rows, meta } = await getAllWithMeta('/api/attendance/x/2026-09-01/2027-04-30', { key: (r) => r.id });
    assert.equal(meta.total_count, 1200);
    assert.equal(meta.received, 1500, 'OWNA handed over 1500 rows…');
    assert.equal(meta.duplicates, 500, '…500 of which it had already sent');
    assert.equal(meta.held, 1000, 'so only 1000 of the declared 1200 are actually held');
    assert.equal(meta.short, true, 'and the walk must say so rather than look complete');
    assert.equal(rows.length, meta.held, 'with no shared set, what is held is what is returned');
  } finally { global.fetch = realFetch; }
});

test('a walk with no totalCount that fills its first page is treated as suspect, not complete', async () => {
  global.fetch = async () => json({ data: Array.from({ length: 500 }, (_, i) => ({ id: i })) });
  try {
    const { meta } = await getAllWithMeta('/api/attendance/x/2026-09-01/2026-09-30');
    assert.equal(meta.total_count, null);
    assert.equal(meta.stop, 'no-total-count');
    assert.equal(meta.short, true, 'a full page and no count is exactly how a silent truncation looks');
  } finally { global.fetch = realFetch; }
});

test('a short first page with no totalCount is a complete answer, not a suspect one', async () => {
  global.fetch = async () => json({ data: [{ id: 1 }, { id: 2 }] });
  try {
    const { meta } = await getAllWithMeta('/api/attendance/x/2026-09-01/2026-09-30');
    assert.equal(meta.short, false, 'two rows in a 500-row page is OWNA saying "that is all there is"');
  } finally { global.fetch = realFetch; }
});

test('attendance is pulled per month, deduplicated across chunk boundaries, and reports short months', async () => {
  const asked = [];
  global.fetch = async (url) => {
    const u = new URL(url);
    const [, , , centre, from, to] = u.pathname.split('/');   // '', api, attendance, <id>, <from>, <to>
    asked.push(`${from}..${to}`);
    if (Number(u.searchParams.get('skip')) > 0) return json({ data: [], totalCount: 2 });
    // Every month returns the same two rows for the same child on 2026-10-01 — a duplicate across
    // chunks, which is what the COE path has always had to defend against by hand.
    const rows = [
      { attendanceDate: '2026-10-01T00:00:00', childId: 'c1', attending: true },
      { attendanceDate: `${from}T00:00:00`, childId: 'c2', attending: true },
    ];
    // One month comes back declaring more rows than it hands over: the short chunk.
    return json({ data: rows, totalCount: from.startsWith('2026-12') ? 99 : rows.length });
  };
  try {
    const r = await owna.attendanceDetailed('centre-1', '2026-10-01', '2027-01-31');
    assert.deepEqual(asked.filter((a, i, s) => s.indexOf(a) === i),
      ['2026-10-01..2026-10-31', '2026-11-01..2026-11-30', '2026-12-01..2026-12-31', '2027-01-01..2027-01-31'],
      'one request per calendar month');
    assert.equal(r.chunks.length, 4);

    // c1 on 2026-10-01 appears in all four chunks and is held once.
    const c1 = r.rows.filter((x) => x.childId === 'c1');
    assert.equal(c1.length, 1, 'a booking repeated across chunks is one booked child-day, not four');
    assert.equal(r.rows.length, 5, '1 shared booking + one per month');
    // `duplicates` counts repeats WITHIN a request — the symptom of a truncating walk. A row held back
    // because an earlier month already delivered it is a seam, not a symptom, and is not counted here.
    assert.equal(r.chunks.reduce((a, c) => a + c.duplicates, 0), 0);

    // A booking that repeats at a month boundary is held once but is NOT evidence of a short month:
    // OWNA delivered both rows it declared. Only December, which declared 99 and delivered 2, is short.
    assert.equal(r.short.length, 1, 'a boundary duplicate must not make every later month look short');
    assert.equal(r.short[0].from, '2026-12-01');
    assert.deepEqual(r.chunks.map((c) => c.held), [2, 2, 2, 2], 'each month delivered both its rows');
    assert.deepEqual(r.chunks.map((c) => c.duplicates), [0, 0, 0, 0], 'none repeated a row within itself');
  } finally { global.fetch = realFetch; }
});

test('a booking horizon is never inferred from a pull that came back short', async () => {
  // The whole point. runCoeSnapshot reads owna.attendanceDetailed; when any month is short it must
  // record no horizon at all rather than publish the maximum of an incomplete set as a fact.
  const snap = require('../services/snapshot');
  const db = require('../db/db');
  const { owna: client } = require('../services/owna');
  db.prepare('INSERT OR IGNORE INTO centres(owna_id,name,capacity,opening) VALUES(?,?,?,0)').run('h', 'Centre Horizon', 100);
  const kids = [{ id: 'k1', firstname: 'F', surname: 'L', finishDate: null }];
  const att = [{ attendanceDate: '2026-11-02T00:00:00', childId: 'k1', attending: true }];

  const realChildren = client.listChildren, realDetailed = client.attendanceDetailed, realAtt = client.attendance;
  client.listChildren = async () => kids;
  client.attendance = async () => att;
  try {
    // Complete pull: a horizon IS recorded.
    client.attendanceDetailed = async () => ({ rows: att, chunks: [{ short: false }], short: [] });
    await snap.runCoeSnapshot({ log: () => {} });
    const good = db.prepare('SELECT last_booking_date FROM coe_forward_horizon WHERE owna_id = ?').get('h');
    assert.equal(good.last_booking_date, '2026-11-02');

    // Short pull, identical rows: no horizon, and nothing blanked on the strength of one.
    client.attendanceDetailed = async () => ({ rows: att, chunks: [{ short: true }], short: [{ from: '2026-12-01' }] });
    const r = await snap.runCoeSnapshot({ log: () => {} });
    assert.ok(r.short_pulls >= 1, 'the run reports how many centres came back short');
    const h = db.prepare('SELECT last_booking_date FROM coe_forward_horizon WHERE owna_id = ?').get('h');
    assert.equal(h.last_booking_date, null, 'the maximum of an incomplete set is not a horizon');
    const blanked = db.prepare('SELECT COUNT(*) AS n FROM coe_continuing WHERE owna_id = ? AND beyond_horizon = 1').get('h');
    assert.equal(blanked.n, 0, 'and no month may be blanked from a pull we know was incomplete');
    const unknown = db.prepare('SELECT COUNT(*) AS n FROM coe_continuing WHERE owna_id = ? AND covered_days IS NULL').get('h');
    assert.ok(unknown.n > 0, 'coverage is recorded as unknown, which is not the same as zero');
  } finally {
    client.listChildren = realChildren; client.attendanceDetailed = realDetailed; client.attendance = realAtt;
  }
});
