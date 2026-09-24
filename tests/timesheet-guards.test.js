// The guards between an OWNA clock-in and somebody's pay.
//
// This code CREATES TIMESHEETS IN EMPLOYMENT HERO PAYROLL. Every test here is a thing that, if it
// stopped holding, would pay a real educator twice, pay them for a shift they did not work, or put
// hours into a period that is already paid. The feature shipped with no tests at all; these are the
// claims its own commit message makes, pinned down.
//
// Nothing here touches a live API. eh.* and buildTimesheets are replaced with fixtures, so a test run
// can never reach OWNA or Employment Hero.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ts-')), 'test.db');
process.env.NODE_ENV = 'test';
process.env.EH_PAYROLL_API_KEY = 'fixture-key';
process.env.EH_PAYROLL_BUSINESS_ID = 'fixture-biz';

const db = require('../db/db');
const { eh } = require('../services/eh');
const ts = require('../services/eh-timesheet');
const push = require('../services/timesheet-push');

db.prepare("INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,100,0)").run('c-austral', 'Futuro Childcare & Education - Austral');
db.prepare("INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,100,0)").run('c-gwh', 'Futuro Childcare & Education - Gledswood Hills');

// ---------------------------------------------------------------- fixture harness -------------
const LOCATIONS = [{ id: 11, name: 'Futuro Austral' }, { id: 12, name: 'Futuro GWH' }];
const realPayRunsCached = eh.payRunsCached;   // kept before any stub replaces it
const real = {};
function stub({ payRuns = [], timesheets = [], lines = [], unmapped = [], locations = LOCATIONS, onCreate, onDelete } = {}) {
  for (const k of ['payRunsCached', 'locationsCached', 'timesheetsBetween', 'createTimesheet', 'deleteTimesheet', 'hasCreds'])
    if (!(k in real)) real[k] = eh[k];
  if (!('buildTimesheets' in real)) real.buildTimesheets = ts.buildTimesheets;

  const created = [], deleted = [];
  eh.hasCreds = () => true;
  eh.payRunsCached = async () => payRuns;
  eh.locationsCached = async () => locations;
  eh.timesheetsBetween = async () => timesheets;
  eh.createTimesheet = async (body) => {
    created.push(body);
    if (onCreate) return onCreate(body);
    return { id: 9000 + created.length, status: body.status };
  };
  eh.deleteTimesheet = async (id) => { deleted.push(id); if (onDelete) return onDelete(id); return {}; };
  ts.buildTimesheets = async () => ({ lines, unmapped, quarantined: [], skipped: [], issues: [], stats: {} });
  return { created, deleted };
}
const restore = () => { for (const [k, v] of Object.entries(real)) (k === 'buildTimesheets' ? ts : eh)[k] = v; };

// A candidate line as buildTimesheets emits one.
const line = (o = {}) => ({
  centre: 'Futuro Childcare & Education - Austral', name: 'A Educator', staffId: o.staffId || '1',
  employeeId: o.employeeId || 501, employeeCode: 'ft000001',
  payDate: o.payDate || '2026-09-23',
  startLocal: o.startLocal || '07:00', endLocal: o.endLocal || '15:00',
  startLocalISO: `${o.payDate || '2026-09-23'}T${o.startLocal || '07:00'}:00`,
  endLocalISO: `${o.payDate || '2026-09-23'}T${o.endLocal || '15:00'}:00`,
  grossHours: o.grossHours || 8,
  dedupeKey: o.dedupeKey || `owna:${o.staffId || '1'}:1758610800`,
});
// An existing EH timesheet, in the shape eh.timesheetsBetween returns.
const sheet = (o = {}) => ({
  id: o.id || 1, employeeId: o.employeeId || 501,
  startTime: o.startTime || '2026-09-23T07:00:00', endTime: o.endTime || '2026-09-23T15:00:00',
  status: o.status || 'Approved', source: o.source || 'FileImport', externalId: o.externalId,
});

// ================================================================ GUARD 1: finalised pay runs ====
test('guard 1: a date inside a finalised pay run is refused', async () => {
  // Those hours are already paid. Posting into them pays them again.
  stub({ payRuns: [{ id: 1, isFinalised: true, payPeriodStarting: '2026-09-21', payPeriodEnding: '2026-09-27', datePaid: '2026-09-29' }] });
  try {
    const pv = await push.preview({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(pv.blocked, true);
    assert.match(pv.blockedReason, /finalised pay run/);
    assert.deepEqual(pv.lines, [], 'a blocked preview offers nothing to post');
  } finally { restore(); }
});

test('guard 1: push() refuses to post when the range is blocked', async () => {
  const { created } = stub({
    payRuns: [{ id: 1, isFinalised: true, payPeriodStarting: '2026-09-21', payPeriodEnding: '2026-09-27', datePaid: '2026-09-29' }],
    lines: [line()],
  });
  try {
    await assert.rejects(push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' }), /finalised pay run/);
    assert.equal(created.length, 0, 'nothing may reach payroll');
  } finally { restore(); }
});

test('guard 1: an OPEN pay run does not block — those hours are not paid yet', async () => {
  stub({ payRuns: [{ id: 1, isFinalised: false, payPeriodStarting: '2026-09-21', payPeriodEnding: '2026-09-27', datePaid: null }], lines: [line()] });
  try {
    const pv = await push.preview({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(pv.blocked, false);
    assert.equal(pv.lines.length, 1);
  } finally { restore(); }
});

test('guard 1: ONE blocked day inside the range blocks the whole range', async () => {
  stub({ payRuns: [{ id: 1, isFinalised: true, payPeriodStarting: '2026-09-21', payPeriodEnding: '2026-09-22', datePaid: '2026-09-24' }], lines: [line()] });
  try {
    const pv = await push.preview({ ownaId: 'c-austral', from: '2026-09-21', to: '2026-09-25' });
    assert.equal(pv.blocked, true, 'a range that straddles a paid period must not post its open days either');
  } finally { restore(); }
});

test('guard 1: the period is inclusive at both ends', async () => {
  const runs = [{ id: 1, isFinalised: true, payPeriodStarting: '2026-09-21', payPeriodEnding: '2026-09-27', datePaid: '2026-09-29' }];
  for (const d of ['2026-09-21', '2026-09-27']) {
    stub({ payRuns: runs });
    try {
      const pv = await push.preview({ ownaId: 'c-austral', from: d, to: d });
      assert.equal(pv.blocked, true, d + ' is inside the period');
    } finally { restore(); }
  }
  stub({ payRuns: runs, lines: [line({ payDate: '2026-09-28' })] });
  try {
    const pv = await push.preview({ ownaId: 'c-austral', from: '2026-09-28', to: '2026-09-28' });
    assert.equal(pv.blocked, false, 'the day after the period is open');
  } finally { restore(); }
});

test('guard 1: a finalised run with no payPeriodStarting still blocks', async () => {
  // THE IMPORTANT ONE. Every other Employment Hero path in this repo — services/eh-labour.js, proven
  // against live data, and every payrun fixture in tests/ — carries only payPeriodEnding and datePaid.
  // payPeriodStarting appears nowhere but these two new files. If it is absent on a real KeyPay payrun,
  // String(undefined).slice(0,10) is "undefined", and "undefined" <= "2026-09-23" is FALSE, so the
  // find() never matches and this guard does nothing at all — silently, on the one thing it exists for.
  // A missing field must fail CLOSED: refuse, and let a human say otherwise.
  stub({
    payRuns: [{ id: 1, isFinalised: true, payPeriodEnding: '2026-09-27', datePaid: '2026-09-29' }],
    lines: [line()],
  });
  try {
    const pv = await push.preview({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(pv.blocked, true, 'a finalised period we cannot fully read must refuse, not wave it through');
    assert.deepEqual(pv.lines, []);
  } finally { restore(); }
});

// ================================================================ GUARD 2: overlap conflicts =====
test('guard 2: a shift overlapping an existing timesheet is skipped, not posted', async () => {
  // Most days most educators already have a timesheet from the manual spreadsheet import. Without this
  // guard every push would give them a second one.
  const { created } = stub({
    lines: [line()],
    timesheets: [sheet({ id: 77, source: 'FileImport' })],
  });
  try {
    const r = await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(r.lines.length, 0);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].clash.id, 77);
    assert.equal(created.length, 0, 'nothing posted');
  } finally { restore(); }
});

test('guard 2: a PARTIAL overlap counts as a clash', async () => {
  // 07:00-15:00 against an existing 14:00-18:00 is four hours of double pay.
  const { created } = stub({
    lines: [line()],
    timesheets: [sheet({ id: 78, startTime: '2026-09-23T14:00:00', endTime: '2026-09-23T18:00:00' })],
  });
  try {
    const r = await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(r.conflicts.length, 1);
    assert.equal(created.length, 0);
  } finally { restore(); }
});

test('guard 2: shifts that merely touch end-to-end are NOT a clash', async () => {
  // A split shift 07:00-11:00 then 11:00-15:00 is two real shifts, not a double-up.
  const { created } = stub({
    lines: [line({ startLocal: '11:00', endLocal: '15:00' })],
    timesheets: [sheet({ id: 79, startTime: '2026-09-23T07:00:00', endTime: '2026-09-23T11:00:00' })],
  });
  try {
    const r = await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(r.conflicts.length, 0);
    assert.equal(created.length, 1);
  } finally { restore(); }
});

test('guard 2: another employee\'s timesheet at the same time is not a clash', async () => {
  const { created } = stub({
    lines: [line({ employeeId: 501 })],
    timesheets: [sheet({ id: 80, employeeId: 999 })],
  });
  try {
    const r = await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(r.conflicts.length, 0);
    assert.equal(created.length, 1);
  } finally { restore(); }
});

test('guard 2: the clash is caught whatever the existing line\'s source or status', async () => {
  for (const src of [{ source: 'FileImport', status: 'Approved' }, { source: 'WorkZone', status: 'Submitted' }, { source: null, status: 'Rejected' }]) {
    const { created } = stub({ lines: [line()], timesheets: [sheet({ id: 81, ...src })] });
    try {
      const r = await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
      assert.equal(created.length, 0, `source ${src.source} / status ${src.status} must still block`);
    } finally { restore(); }
  }
});

test('guard 2: the clash is caught whatever time format EH returns', async () => {
  // The comparison used to be raw text between our naive Sydney-local string and whatever EH sends.
  // That is right for one wire format and silently wrong for others: the SAME 07:00-15:00 shift
  // expressed in UTC, or with a space instead of the T, sorted differently as text, so no overlap was
  // seen and the line was posted on top of the existing one. No warning — the screen showed no conflict.
  const formats = {
    'naive local':   ['2026-09-23T07:00:00', '2026-09-23T15:00:00'],
    'offset +10:00': ['2026-09-23T07:00:00+10:00', '2026-09-23T15:00:00+10:00'],
    'milliseconds':  ['2026-09-23T07:00:00.000', '2026-09-23T15:00:00.000'],
    'UTC Z':         ['2026-09-22T21:00:00Z', '2026-09-23T05:00:00Z'],   // the same instants
    'space instead of T': ['2026-09-23 07:00:00', '2026-09-23 15:00:00'],
  };
  for (const [name, [startTime, endTime]] of Object.entries(formats)) {
    const { created } = stub({ lines: [line()], timesheets: [sheet({ id: 84, startTime, endTime })] });
    try {
      const r = await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
      assert.equal(r.conflicts.length, 1, `${name}: the same shift must be seen as a clash`);
      assert.equal(created.length, 0, `${name}: nothing may be posted over it`);
    } finally { restore(); }
  }
});

test('guard 2: a time this code cannot read counts as a clash, not as clear', async () => {
  // If we cannot understand an existing timesheet's hours, the one thing we must not do is post more
  // hours over them. Unreadable fails CLOSED.
  for (const bad of [{ startTime: 'not-a-date', endTime: 'also-not' }, { startTime: null, endTime: null }, { startTime: '/Date(1758610800000)/', endTime: '/Date(1758639600000)/' }]) {
    const { created } = stub({ lines: [line()], timesheets: [sheet({ id: 85, ...bad })] });
    try {
      const r = await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
      assert.equal(created.length, 0, `unreadable ${bad.startTime} must block, not wave through`);
      assert.equal(r.conflicts.length, 1);
    } finally { restore(); }
  }
});

test('guard 2: normalising does not invent clashes between genuinely separate shifts', async () => {
  // The fix must not over-fire: a real split shift, and a different day, must still post.
  const { created } = stub({
    lines: [line({ startLocal: '13:00', endLocal: '17:00' })],
    timesheets: [
      sheet({ id: 86, startTime: '2026-09-23T07:00:00+10:00', endTime: '2026-09-23T11:00:00+10:00' }),
      sheet({ id: 87, startTime: '2026-09-22 13:00:00', endTime: '2026-09-22 17:00:00' }),
    ],
  });
  try {
    const r = await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(r.conflicts.length, 0);
    assert.equal(created.length, 1);
  } finally { restore(); }
});

// ================================================================ GUARD 3: idempotency ===========
test('guard 3: a shift already posted by this tool is not posted again', async () => {
  const key = 'owna:1:1758610800';
  const { created } = stub({
    lines: [line({ dedupeKey: key })],
    timesheets: [sheet({ id: 82, externalId: key })],
  });
  try {
    const r = await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(r.alreadyPosted.length, 1);
    assert.equal(r.alreadyPosted[0].ehId, 82);
    assert.equal(r.lines.length, 0);
    assert.equal(created.length, 0, 'a second press of the button must be a no-op');
  } finally { restore(); }
});

test('guard 3: the idempotency key is checked before the overlap guard, and either way nothing posts', async () => {
  const key = 'owna:1:1758610800';
  const { created } = stub({ lines: [line({ dedupeKey: key })], timesheets: [sheet({ id: 83, externalId: key })] });
  try {
    const r = await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(r.alreadyPosted.length, 1);
    assert.equal(r.conflicts.length, 0, 'it is our own line — reporting it as a conflict would be misleading');
    assert.equal(created.length, 0);
  } finally { restore(); }
});

test('guard 3: every posted line carries its externalId', async () => {
  const { created } = stub({ lines: [line({ dedupeKey: 'owna:1:1758610800' })] });
  try {
    await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(created.length, 1);
    assert.equal(created[0].externalId, 'owna:1:1758610800', 'without this the next run posts it again');
  } finally { restore(); }
});

// ================================================================ GUARD 5: draft status ==========
test('guard 5: lines post as Submitted, never Approved', async () => {
  // "Approved" puts hours straight into a pay run with no human check.
  const { created } = stub({ lines: [line(), line({ staffId: '2', employeeId: 502, dedupeKey: 'owna:2:1758610800' })] });
  try {
    await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(created.length, 2);
    for (const body of created) {
      assert.equal(body.status, 'Submitted');
      assert.notEqual(body.status, 'Approved');
    }
  } finally { restore(); }
});

test('guard 5: no source file anywhere posts an Approved status', () => {
  for (const f of ['services/timesheet-push.js', 'services/eh.js', 'scripts/eh-timesheet-post.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const bad = src.split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /status\s*[:=]\s*["'`]Approved/i.test(l));
    assert.deepEqual(bad, [], `${f} must never set status "Approved": ${bad.map((b) => b.n).join(', ')}`);
  }
});

test('guard 5: the dry run prints exactly what gets posted', async () => {
  // The dry-run payload is the artefact a human signs off before this runs against real payroll. It used
  // to be a separate object from the one actually sent, and the two had already drifted on both fields
  // that matter: the idempotency key's name, and the status. Reviewing one and shipping the other is how
  // an unnoticed field name becomes a duplicate in somebody's pay.
  const l = { ...line(), locationId: 11, locationName: 'Austral' };
  const { created } = stub({ lines: [l] });
  try {
    await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    const posted = created[0];
    const shown = ts.toPayload(l);
    for (const k of ['employeeId', 'startTime', 'endTime', 'locationId', 'externalId', 'comments', 'status']) {
      assert.deepEqual(shown[k], posted[k], `the dry run and the post disagree about "${k}"`);
    }
    assert.equal(posted.status, 'Submitted');
    assert.ok('externalId' in posted, 'the idempotency key must be on the posted body');
    assert.ok(!('externalReference' in posted), 'and under one name only');
  } finally { restore(); }
});

// ================================================================ location mapping ===============
test('a centre with no mapped EH location posts nothing', async () => {
  // Gledswood Hills is "Futuro GWH" in EH. If the location cannot be resolved, a line with no
  // locationId would land against the wrong award rules — so it is held back instead.
  const { created } = stub({ lines: [line()], locations: [{ id: 99, name: 'Some Other Business' }] });
  try {
    const r = await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(r.noLocation.length, 1);
    assert.equal(r.lines.length, 0);
    assert.equal(created.length, 0);
  } finally { restore(); }
});

test('the EH location name table is used, not the centre name', async () => {
  const { created } = stub({ lines: [line({ employeeId: 601 })] });
  try {
    await push.push({ ownaId: 'c-gwh', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(created[0].locationId, 12, 'Gledswood Hills maps to "Futuro GWH" (id 12), not by name');
  } finally { restore(); }
});

// ================================================================ GUARD 6: undo ==================
test('guard 6: undo deletes only lines this tool created', async () => {
  const { deleted } = stub({
    lines: [line({ employeeId: 501 })],
    timesheets: [
      sheet({ id: 90, employeeId: 501, externalId: 'owna:1:1758610800' }),  // ours
      sheet({ id: 91, employeeId: 501, externalId: null }),                 // the manual import
      sheet({ id: 92, employeeId: 501, externalId: 'workzone:abc' }),       // EH's own clock
    ],
  });
  try {
    const r = await push.undo({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.deepEqual(deleted, [90]);
    assert.equal(r.found, 1);
  } finally { restore(); }
});

test('guard 6: undo does not touch another centre\'s people', async () => {
  const { deleted } = stub({
    lines: [line({ employeeId: 501 })],                                      // this centre has employee 501
    timesheets: [
      sheet({ id: 93, employeeId: 501, externalId: 'owna:1:1758610800' }),   // ours, this centre
      sheet({ id: 94, employeeId: 777, externalId: 'owna:9:1758610800' }),   // ours, a different centre
    ],
  });
  try {
    await push.undo({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.deepEqual(deleted, [93], 'undo on one centre must not reverse another centre\'s push');
  } finally { restore(); }
});

// ================================================================ audit trail ====================
test('every payroll write leaves an audit row naming who pressed the button', async () => {
  db.prepare('DELETE FROM timesheet_push_log').run();
  stub({ lines: [line()] });
  try {
    await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23', byUser: { id: 4, email: 'christo@futuro.test' } });
    const row = db.prepare('SELECT * FROM timesheet_push_log ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.action, 'push');
    assert.equal(row.user_email, 'christo@futuro.test');
    assert.equal(row.user_id, 4);
    assert.equal(row.owna_id, 'c-austral');
    assert.equal(row.created_count, 1);
    // No staff names: the EH timesheet is the record of who worked; this answers who pressed the button.
    assert.doesNotMatch(JSON.stringify(row), /A Educator/);
  } finally { restore(); }
});

test('a post that fails is counted as failed and never counted as created', async () => {
  const { created } = stub({
    lines: [line(), line({ staffId: '2', employeeId: 502, dedupeKey: 'owna:2:1758610800' })],
    onCreate: (body) => { if (body.employeeId === 502) throw new Error('EH 400 POST /timesheet: invalid'); return { id: 95, status: body.status }; },
  });
  try {
    const r = await push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(r.created.length, 1);
    assert.equal(r.failed.length, 1);
    assert.equal(created.length, 2, 'both were attempted');
    const row = db.prepare('SELECT * FROM timesheet_push_log ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.created_count, 1);
    assert.equal(row.failed_count, 1);
  } finally { restore(); }
});

test('preview writes nothing at all', async () => {
  db.prepare('DELETE FROM timesheet_push_log').run();
  const { created, deleted } = stub({ lines: [line()] });
  try {
    await push.preview({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(created.length, 0);
    assert.equal(deleted.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM timesheet_push_log').get().n, 0);
  } finally { restore(); }
});

test('an unknown centre and missing credentials both refuse before any EH call', async () => {
  stub({ lines: [line()] });
  try {
    await assert.rejects(push.preview({ ownaId: 'nope', from: '2026-09-23' }), /Unknown centre/);
    eh.hasCreds = () => false;
    await assert.rejects(push.preview({ ownaId: 'c-austral', from: '2026-09-23' }), /credentials are not configured/);
  } finally { restore(); }
});

// ============================================ the list BOTH guards read ==========================
// Guards 2 and 3 are only as good as eh.timesheetsBetween. If it returns fewer existing timesheets than
// exist, both of them under-detect, and both fail in the direction that posts a duplicate into payroll.
// It was the only EH list fetched in a single unchecked call ($top 2000, no pagination, no truncation
// check) while every other list in the file walked its pages and threw on a short read.
const realFetch = global.fetch;

test('the existing-timesheet list is paginated, not one hopeful call', async () => {
  const asked = [];
  const all = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, employeeId: 501 }));
  global.fetch = async (url) => {
    const u = new URL(url);
    const skip = Number(u.searchParams.get('$skip') || 0);
    const top = Number(u.searchParams.get('$top') || 0);
    asked.push({ skip, top, filter: u.searchParams.get('$filter') });
    return { ok: true, status: 200, text: async () => JSON.stringify(all.slice(skip, skip + top)) };
  };
  try {
    const got = await eh.timesheetsBetween('2026-09-21', '2026-09-27');
    assert.equal(got.length, 250, 'every page, not just the first');
    assert.ok(asked.length >= 3, 'it walked the pages: ' + asked.length + ' calls');
    assert.ok(asked.every((a) => a.filter && a.filter.includes('2026-09-21')), 'the date filter travels with every page');
  } finally { global.fetch = realFetch; }
});

test('a caller cannot widen $top and quietly turn pagination back off', async () => {
  const seen = [];
  global.fetch = async (url) => {
    const u = new URL(url);
    seen.push(Number(u.searchParams.get('$top')));
    return { ok: true, status: 200, text: async () => JSON.stringify([]) };
  };
  try {
    await eh.timesheetsBetween('2026-09-21', '2026-09-27');
    assert.deepEqual([...new Set(seen)], [100], 'the page size is the module\'s, not the caller\'s');
  } finally { global.fetch = realFetch; }
});

test('a truncated or repeated page is an error, never a short list', async () => {
  // The whole point. A server that repeats a page would otherwise hand the guards a list that looks
  // complete, and the duplicate it causes lands in somebody's pay.
  const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, employeeId: 501 }));
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(page) });
  try {
    await assert.rejects(eh.timesheetsBetween('2026-09-21', '2026-09-27'), /pagination was incomplete or repeated/);
  } finally { global.fetch = realFetch; }

  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{ employeeId: 501 }]) });
  try {
    await assert.rejects(eh.timesheetsBetween('2026-09-21', '2026-09-27'), /pagination was incomplete or repeated/,
      'a row with no id cannot be deduplicated, so it cannot be trusted');
  } finally { global.fetch = realFetch; }
});

test('a failed read of that list stops the push rather than posting into the dark', async () => {
  // If we cannot see what already exists, we cannot know whether we are about to duplicate it.
  const { created } = stub({ lines: [line()] });
  eh.timesheetsBetween = async () => { throw new Error('EH 500 /timesheet'); };
  try {
    await assert.rejects(push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' }), /EH 500/);
    assert.equal(created.length, 0, 'no line may be posted when the conflict check could not run');
  } finally { restore(); }
});

// ================================================================ GUARD 4: shift-length gates ====
// These are pure functions in services/eh-timesheet.js — no API, no stubbing.
test('guard 4: pairSpans turns clock events into worked spans', () => {
  const ev = (t, s) => ({ statusDate: t, status: s });
  const { spans, issues } = ts.pairSpans([
    ev('2026-09-23T07:00:00+10:00', 'centre checkin'),
    ev('2026-09-23T15:00:00+10:00', 'centre checkout'),
  ]);
  assert.equal(spans.length, 1);
  assert.deepEqual(issues, []);
});

test('guard 4: a split shift is two spans, not one long one', () => {
  const ev = (t, s) => ({ statusDate: t, status: s });
  const { spans } = ts.pairSpans([
    ev('2026-09-23T07:00:00+10:00', 'centre checkin'),
    ev('2026-09-23T11:00:00+10:00', 'centre checkout'),
    ev('2026-09-23T13:00:00+10:00', 'centre checkin'),
    ev('2026-09-23T17:00:00+10:00', 'centre checkout'),
  ]);
  assert.equal(spans.length, 2, 'paying the gap between them would be wrong');
});

test('guard 4: a check-in never checked out produces no span, and is reported', () => {
  const ev = (t, s) => ({ statusDate: t, status: s });
  const { spans, issues } = ts.pairSpans([ev('2026-09-23T07:00:00+10:00', 'centre checkin')]);
  assert.deepEqual(spans, [], 'an open shift has no end, so there are no hours to pay');
  assert.equal(issues.length, 1);
  assert.match(issues[0], /never checked out/);
});

test('guard 4: a check-out with no check-in produces no span, and is reported', () => {
  const ev = (t, s) => ({ statusDate: t, status: s });
  const { spans, issues } = ts.pairSpans([ev('2026-09-23T15:00:00+10:00', 'centre checkout')]);
  assert.deepEqual(spans, []);
  assert.match(issues[0], /no matching check-in/);
});

test('guard 4: a double check-in keeps the LATER one and says so', () => {
  const ev = (t, s) => ({ statusDate: t, status: s });
  const { spans, issues } = ts.pairSpans([
    ev('2026-09-23T07:00:00+10:00', 'centre checkin'),
    ev('2026-09-23T07:02:00+10:00', 'centre checkin'),
    ev('2026-09-23T15:00:00+10:00', 'centre checkout'),
  ]);
  assert.equal(spans.length, 1);
  assert.match(issues[0], /double check-in/);
  assert.equal(spans[0].in, '2026-09-23T07:02:00+10:00', 'the shorter, later span is the safer one to pay');
});

test('guard 4: the dedupe key is stable for the same shift and different for another', () => {
  const span = { in: '2026-09-23T07:00:00+10:00', out: '2026-09-23T15:00:00+10:00' };
  assert.equal(ts.dedupeKey('1', span), ts.dedupeKey('1', span), 're-running must produce the same key');
  assert.notEqual(ts.dedupeKey('1', span), ts.dedupeKey('2', span), 'two people, two keys');
  assert.notEqual(ts.dedupeKey('1', span), ts.dedupeKey('1', { ...span, in: '2026-09-23T07:01:00+10:00' }));
  assert.match(ts.dedupeKey('1', span), /^owna:1:\d+$/);
});

test('guard 4: the thresholds are 3 minutes and 12 hours', () => {
  assert.equal(ts.MIN_SHIFT_MINUTES, 3);
  assert.equal(ts.MAX_SHIFT_HOURS, 12);
});

test('guard 4: an event this code cannot classify is not silently dropped', () => {
  // pairSpans filters on /centre\s*check/i but then classifies with /checkin/i and /checkout/i, which do
  // NOT allow a space inside "check in". So a status spelled "centre check in" passes the filter and
  // matches neither branch: the event is discarded, the shift never appears, and no issue is recorded —
  // the educator simply is not paid for that day, silently.
  //
  // OWNA sends "centre checkin" today (scripts/owna-room-report.js:6), so this is latent, not live. It
  // is pinned because the failure is invisible: there is no error, no count, nothing on a screen.
  const ev = (t, s) => ({ statusDate: t, status: s });
  const { spans, issues } = ts.pairSpans([
    ev('2026-09-23T07:00:00+10:00', 'centre check in'),
    ev('2026-09-23T15:00:00+10:00', 'centre check out'),
  ]);
  const lost = spans.length === 0 && issues.length === 0;
  assert.equal(lost, false,
    'a clock event that matched the filter but no branch was dropped without a trace — pairSpans must ' +
    'either classify it or record an issue. Widen isIn/isOut to /check\\s*in/i and /check\\s*out/i, or ' +
    'record an issue for an unclassifiable event.');
});

test('dateRange covers both ends and survives a single day', () => {
  assert.deepEqual(ts.dateRange('2026-09-23', '2026-09-25'), ['2026-09-23', '2026-09-24', '2026-09-25']);
  assert.deepEqual(ts.dateRange('2026-09-23', '2026-09-23'), ['2026-09-23']);
  assert.deepEqual(ts.dateRange('2026-09-23'), ['2026-09-23']);
  assert.deepEqual(ts.dateRange('2026-09-25', '2026-09-23'), ['2026-09-25'], 'a reversed range must not silently pull a month');
});

// ============================================ the pay-run list is re-read before writing ========
test('guard 1: push() re-reads the pay runs instead of trusting the preview\'s cached copy', async () => {
  // preview() reads pay runs through a five-minute cache with no invalidation anywhere in the repo, and
  // the Post button sits on the preview page — so the ordinary two-click flow decided against the
  // snapshot taken when the screen rendered. A payroll officer finalising the run in that window was
  // invisible to the guard. The CLI never had this; it uses the uncached call.
  //
  // The cache closes over a module-local allPages, so only global.fetch reaches it — the real cache is
  // under test here, not a stub of it.
  const realFetch = global.fetch;
  let runs = [{ id: 1, isFinalised: false, payPeriodStarting: '2026-09-21', payPeriodEnding: '2026-09-27', datePaid: null }];
  const { created } = stub({ lines: [line()] });
  eh.payRunsCached = realPayRunsCached;          // the genuine cached reader
  eh.clearCache();
  global.fetch = async (url) => {
    const skip = Number(new URL(url).searchParams.get('$skip') || 0);
    return { ok: true, status: 200, text: async () => JSON.stringify(skip === 0 ? runs : []) };
  };
  try {
    const pv = await push.preview({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' });
    assert.equal(pv.blocked, false, 'the run is still open when the screen renders');

    // The payroll officer finalises it. No clock is advanced: this is inside the cache window.
    runs = [{ id: 1, isFinalised: true, payPeriodStarting: '2026-09-21', payPeriodEnding: '2026-09-27', datePaid: '2026-09-29' }];

    await assert.rejects(push.push({ ownaId: 'c-austral', from: '2026-09-23', to: '2026-09-23' }), /finalised pay run/,
      'the write path must see the finalisation, not the snapshot from when the page loaded');
    assert.equal(created.length, 0, 'nothing may reach payroll');
  } finally { global.fetch = realFetch; eh.clearCache(); restore(); }
});
