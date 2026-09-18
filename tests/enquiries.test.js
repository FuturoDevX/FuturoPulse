// Weekly enquiry counts from LineLeader.
//
// The alias table is the part most likely to go wrong quietly: an unmapped centre looks exactly like a
// centre with no enquiries, and "Leppington Heath" is Heath Rd with nothing in the strings to say so.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-enq-'));
process.env.DB_PATH = path.join(dir, 'test.db'); process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'test-admin@example.test'; process.env.ADMIN_DEFAULT_PASSWORD = 'FixturePasswordOnly!';
process.env.SESSION_SECRET = 'fixture-session-only';
const db = require('../db/db');

for (const [id, name] of [
  ['a', 'Futuro Childcare & Education - Austral'],
  ['b', 'Futuro Childcare & Education - Bardia'],
  ['g', 'Futuro Childcare & Education - Gledswood Hills'],
  ['h', 'Futuro Childcare & Education - Heath Rd'],
  ['c', 'Futuro Childcare & Education Cobbitty'],
  ['o', 'Futuro Childcare & Education - Oran Park'],
  ['p', 'Futuro Childcare & Education - Park Rd'],
]) db.prepare('INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,100,0)').run(id, name);

const enq = require('../services/enquiries');

test('every LineLeader spelling maps to the right centre', () => {
  const map = enq.centreMap();
  const cases = [
    ['Futuro Childcare and Education Leppington Heath', 'h'],   // the one nothing in the string says
    ['Futuro Childcare and Education Gledswood Hills', 'g'],
    ['Futuro Childcare & Education - Oran Park', 'o'],
    ['Futuro Childcare & Education - Park Rd', 'p'],
    ['Futuro Childcare & Education Cobbitty', 'c'],
    ['Futuro Childcare and Education Austral', 'a'],
    ['Futuro Childcare and Education Bardia', 'b'],
  ];
  for (const [name, expect] of cases)
    assert.equal(enq.matchCentre(name, map), expect, name);
});

test('Oran Park is not mistaken for Park Rd', () => {
  const map = enq.centreMap();
  assert.equal(enq.matchCentre('Oran Park', map), 'o', 'order matters: Oran Park contains "Park"');
  assert.equal(enq.matchCentre('Park Rd', map), 'p');
});

test('an unknown centre is left unmapped rather than guessed at', () => {
  const map = enq.centreMap();
  assert.equal(enq.matchCentre('Futuro Childcare & Education - Somewhere New', map), null,
    'a near-miss that silently mapped this onto a real centre would be worse than no mapping');
  assert.equal(enq.matchCentre('', map), null);
  assert.equal(enq.matchCentre(null, map), null);
});

test('mondayOf puts every day on its own week, and refuses a non-date', () => {
  assert.equal(enq.mondayOf('2026-09-14'), '2026-09-14');   // Monday
  assert.equal(enq.mondayOf('2026-09-18'), '2026-09-14');   // Friday
  assert.equal(enq.mondayOf('2026-09-20'), '2026-09-14');   // Sunday belongs to the week that began
  assert.equal(enq.mondayOf('2026-09-21'), '2026-09-21');
  assert.equal(enq.mondayOf('2026-13-45'), null);
  assert.equal(enq.mondayOf('not a date'), null);
});

test('the rollup counts a lead once and follows it to its furthest stage', async () => {
  const ll = require('../services/lineleader');
  const realGetAll = ll.getAll, realHas = ll.lineleader.hasCreds;
  ll.lineleader.hasCreds = () => true;

  // Two leads in the same week at Heath Rd, one in the week before at Oran Park.
  const FAMS = [
    { id: 1, created_date: '2026-09-15T00:00:00Z', center: { values: { name: 'Futuro Childcare and Education Leppington Heath' } } },
    { id: 2, created_date: '2026-09-17T00:00:00Z', center: { values: { name: 'Futuro Childcare and Education Leppington Heath' } } },
    { id: 3, created_date: '2026-09-09T00:00:00Z', center: { values: { name: 'Futuro Childcare & Education - Oran Park' } } },
    { id: 9, created_date: '2026-09-15T00:00:00Z', center: { values: { name: 'Z-Test Location' } } },  // must be dropped
  ];
  // Family 1 has two children: one lapsed, one enrolled. The better outcome must win.
  const ENROL = { 4: [{ family: { id: 2 } }], 6: [{ family: { id: 1 } }], 9: [{ family: { id: 1 } }, { family: { id: 3 } }] };

  ll.getAll = async (path, q) => {
    if (path === '/families') return FAMS;
    if (path === '/enrollments') return ENROL[(q.status_ids || [])[0]] || [];
    return [];
  };
  try {
    const r = await enq.refresh({ since: '2026-09-01', log: () => {} });
    assert.equal(r.families, 3, 'the Z-Test row is filtered out');

    const wk = enq.weeks({});
    const w14 = wk.find((w) => w.week_start === '2026-09-14');
    assert.equal(w14.leads, 2, 'both Heath Rd leads land on the Monday of their week');
    assert.equal(w14.enrolled, 1, 'family 1 counts as enrolled despite its other child lapsing');
    assert.equal(w14.reached_waitlist, 2, 'family 2 reached waitlist, family 1 went further');

    const w07 = wk.find((w) => w.week_start === '2026-09-07');
    assert.equal(w07.leads, 1);
    assert.equal(w07.enrolled, 0, 'family 3 is a lost opportunity, not an enrolment');

    const centres = enq.byCentre({});
    const heath = centres.find((c) => c.owna_id === 'h');
    assert.equal(heath.leads, 2, 'and the LineLeader spelling resolved to Heath Rd');
    assert.ok(enq.lastRefreshed().cells >= 2);
  } finally { ll.getAll = realGetAll; ll.lineleader.hasCreds = realHas; }
});

test('no credentials is reported, not treated as zero enquiries', async () => {
  const ll = require('../services/lineleader');
  const real = ll.lineleader.hasCreds;
  ll.lineleader.hasCreds = () => false;
  try {
    const r = await enq.refresh({});
    assert.equal(r.skipped, true);
    assert.match(r.reason, /credentials/);
  } finally { ll.lineleader.hasCreds = real; }
});
