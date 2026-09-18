// Marketing initiatives — the hand-entered markers that go on the weekly enquiry line.
//
// They are entered by hand because LineLeader's own campaign field is attached to 13 of the 1,039
// families created in 2026, carries no UTM data at all, and 872 of those enquiries arrived as inquiry
// type "Import". Campaign effect is not recoverable from the CRM, so the marketing team records what
// they did and the chart is read against it.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-mktg-'));
process.env.DB_PATH = path.join(dir, 'test.db'); process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'test-admin@example.test'; process.env.ADMIN_DEFAULT_PASSWORD = 'FixturePasswordOnly!';
process.env.SESSION_SECRET = 'fixture-session-only';
const db = require('../db/db');
const mk = require('../services/marketing');

db.prepare("INSERT INTO centres(owna_id,name,capacity,approved_places,opening) VALUES('a','Centre Alpha',100,100,0)").run();

test('a dated initiative is stored and comes back on its week', () => {
  const r = mk.save({ starts_on: '2026-09-14', owna_id: 'a', title: 'Banner at the sales office',
    channel: 'signage', detail: '100 flyers too', source: 'marketing email' });
  assert.equal(r.ok, true);
  const byWeek = mk.byWeek();
  assert.ok(byWeek.has('2026-09-14'), 'a Monday initiative sits on its own week');
  assert.equal(byWeek.get('2026-09-14')[0].title, 'Banner at the sales office');
});

test('an initiative is marked on the week it STARTED, not every week it ran', () => {
  mk.save({ starts_on: '2026-09-16', ends_on: '2026-10-02', title: 'Three-week radio run', channel: 'digital' });
  const w = mk.byWeek();
  assert.ok(w.get('2026-09-14').some((m) => m.title === 'Three-week radio run'),
    'Wednesday the 16th belongs to the week beginning Monday the 14th');
  assert.ok(!(w.get('2026-09-28') || []).some((m) => m.title === 'Three-week radio run'),
    'and it is not repeated across the weeks it ran — that is the week its effect could first show');
});

test('a group-wide initiative shows against every centre', () => {
  mk.save({ starts_on: '2026-09-18', title: 'Partner posted about us', channel: 'partner' });  // no owna_id
  assert.ok(mk.list({ ownaId: 'a' }).some((m) => m.title === 'Partner posted about us'),
    'an initiative with no centre affected all of them, so it must appear on each');
});

test('it refuses what it cannot place on a chart', () => {
  assert.deepEqual(mk.save({ starts_on: '2026-13-45', title: 'x' }).errs, ['That start date is not a real day.']);
  assert.match(mk.save({ starts_on: '2026-09-14', title: '  ' }).errs[0], /Give it a title/);
  assert.match(mk.save({ starts_on: '2026-09-14', ends_on: '2026-09-01', title: 'x' }).errs[0], /end date is before/);
  assert.match(mk.save({ starts_on: '2026-09-14', title: 'x', channel: 'telepathy' }).errs[0], /Unknown channel/);
  assert.ok(mk.save({ starts_on: '', title: 'x' }).errs.length, 'a missing date is refused');
});

test('an initiative can be corrected and removed', () => {
  const { id } = mk.save({ starts_on: '2026-08-03', title: 'Typo', channel: 'event' });
  mk.save({ id, starts_on: '2026-08-03', title: 'Open day', channel: 'event' });
  assert.equal(mk.list().find((m) => m.id === id).title, 'Open day');
  assert.equal(mk.remove(id), 1);
  assert.equal(mk.list().find((m) => m.id === id), undefined);
});

test('the window filters by start date', () => {
  const inSep = mk.list({ from: '2026-09-01', to: '2026-09-30' });
  assert.ok(inSep.length >= 3);
  assert.ok(inSep.every((m) => m.starts_on >= '2026-09-01' && m.starts_on <= '2026-09-30'));
});
