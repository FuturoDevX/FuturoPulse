// The Microsoft Graph sender for the eNPS invitations. NO NETWORK: global fetch is replaced, and every
// call to login.microsoftonline.com or graph.microsoft.com is answered from this file. Anything else —
// the test's own HTTP requests to the app it starts — is handed to the real fetch, so a stub can never
// quietly become a live call and a live call can never quietly become a stub.
//
// Harness mirrors tests/enps.test.js: temp DB via DB_PATH, payroll stubbed on the shared `eh` object,
// app.listen(0). The APP clock is frozen through cal.setNow, never the global Date (that deadlocks the
// runner — see the note in tests/week2.test.js).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-graph-'));
process.env.DB_PATH = path.join(dir, 'test.db'); process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'test-admin@example.test'; process.env.ADMIN_DEFAULT_PASSWORD = 'FixturePasswordOnly!';
process.env.SESSION_SECRET = 'fixture-session-only'; process.env.ANTHROPIC_API_KEY = 'fixture';

// The four variables, on this process only. SECRET is a fixture string and is the exact value the
// "never written down" test scans the logs, the errors and the database file for.
const SECRET = 'fixture-graph-secret-4f2a9c1e-never-print-this';
const SENDER = 'people@futuro.test';
process.env.GRAPH_TENANT_ID = '611ee5ea-0000-4000-b000-000000000001';
process.env.GRAPH_CLIENT_ID = 'ba4e5fac-0000-4000-b000-000000000002';
process.env.GRAPH_CLIENT_SECRET = SECRET;
process.env.GRAPH_SENDER = SENDER;
delete process.env.SURVEY_FROM_MAILBOX;
const FULL_ENV = { GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', GRAPH_SENDER: SENDER };

// ---- The fetch stub -------------------------------------------------------------------------------
const realFetch = global.fetch;
const MICROSOFT = /^https?:\/\/(login\.microsoftonline\.com|graph\.microsoft\.com)\//;
let calls = [];                 // every Microsoft request this file would have made
let tokenSerial = 0;
const tokenResponse = () => new Response(JSON.stringify({ access_token: 'access-' + (++tokenSerial), expires_in: 3600, token_type: 'Bearer' }),
  { status: 200, headers: { 'content-type': 'application/json' } });
const accepted = () => new Response(null, { status: 202 });          // what a real sendMail returns
let handler = async (u) => (u.includes('/oauth2/v2.0/token') ? tokenResponse() : accepted());
global.fetch = async (url, init) => {
  const u = String(url && url.url ? url.url : url);
  if (!MICROSOFT.test(u)) return realFetch(url, init);
  calls.push({ url: u, init });
  return handler(u, init);
};
const reset = (h) => { calls = []; handler = h || (async (u) => (u.includes('/oauth2/v2.0/token') ? tokenResponse() : accepted())); surveyMail.resetGraphToken(); };
const sends = () => calls.filter((c) => c.url.includes('/sendMail'));
const signins = () => calls.filter((c) => c.url.includes('/oauth2/v2.0/token'));
const payload = (c) => JSON.parse(c.init.body);
const recipient = (c) => payload(c).message.toRecipients[0].emailAddress.address;

const db = require('../db/db'), bcrypt = require('bcryptjs');
const pass = 'FixturePasswordOnly!';
for (const [id, name] of [['a', 'Futuro Childcare & Education - Alpha'], ['b', 'Futuro Childcare & Education - Beta']])
  db.prepare('INSERT INTO centres(owna_id,name,capacity,opening,ll_id) VALUES(?,?,100,0,NULL)').run(id, name);
for (const role of ['viewer', 'admin'])
  db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)').run(role + '@example.test', role, bcrypt.hashSync(pass, 4), role, null);

const cal = require('../services/calendar');
const survey = require('../services/survey');
const surveyMail = require('../services/survey-mail');
const { eh } = require('../services/eh');

function freeze(iso, fn) {
  cal.setNow(iso);
  const restore = () => { cal.setNow(null); };
  let out; try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
  restore(); return out;
}
const FROZEN = '2026-09-16T03:00:00Z', TODAY = '2026-09-16', CLOSES = '2026-09-30';

// ---- Payroll stub ---------------------------------------------------------------------------------
const LOCATIONS = [{ id: 1, name: 'Futuro Early Learning', parentId: null },
  { id: 2, name: 'Futuro Alpha', parentId: 1 }, { id: 3, name: 'Futuro Beta', parentId: 1 }, { id: 4, name: 'Futuro HQ', parentId: 1 }];
const emp = (id, centre) => ({ id, emailAddress: 'staff' + id + '@personal.example', primaryLocation: 'Futuro Early Learning / ' + centre,
  status: 'Active', startDate: '2025-01-06', endDate: null, employmentType: 'Full Time' });
const EMPLOYEES = [emp(11, 'Futuro Alpha'), emp(12, 'Futuro Alpha'), emp(13, 'Futuro Alpha'),
  emp(21, 'Futuro Beta'), emp(22, 'Futuro Beta'), emp(41, 'Futuro HQ')];
const STAFF = EMPLOYEES.length;
eh.allEmployees = async () => EMPLOYEES.map((e) => ({ ...e }));
eh.locations = async () => LOCATIONS.map((l) => ({ ...l }));
eh.hasCreds = () => true;

const app = require('../server');
let server, base;
const login = async (role) => {
  const r = await realFetch(base + '/login', { method: 'POST', body: new URLSearchParams({ email: role + '@example.test', password: pass }), redirect: 'manual' });
  assert.equal(r.status, 302); return r.headers.get('set-cookie').split(';')[0];
};

// A round of its own per test, so one test's delivery log cannot decide another's outcome.
const newRound = (name) => freeze(FROZEN, () => survey.createRound({ name, opens_on: TODAY, closes_on: CLOSES }));
const rowsFor = (round) => freeze(FROZEN, () => survey.exportRows(round.id, { baseUrl: 'https://pulse.example' })).then((o) => o.rows);
const noWait = () => { const waits = []; return { waits, sleep: async (ms) => { waits.push(ms); } }; };
const quiet = () => {};

test('Microsoft Graph sender for the eNPS invitations', async (t) => {
  server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r)); base = 'http://127.0.0.1:' + server.address().port;
  try {

  // ===== Configuration =====
  await t.test('a missing variable falls back to the export and names the one that is missing', async () => {
    reset();
    for (const key of ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_SENDER']) {
      const env = { ...FULL_ENV }; delete env[key];
      const a = surveyMail.graphAvailability(env);
      assert.equal(a.available, false, key + ' missing must not read as available');
      assert.deepEqual(a.missing, [key], 'it must name the one that is actually missing');
      assert.match(a.reason, new RegExp(key));
      assert.match(a.reason, /export/, 'and say the export is there meanwhile');
      // The export is offered whatever is missing — the owner is never blocked on configuration.
      const s = surveyMail.senders(env);
      assert.equal(s.find((x) => x.key === 'export').available, true);
      assert.equal(s.find((x) => x.key === 'graph').available, false);
    }
    assert.equal(surveyMail.graphAvailability(FULL_ENV).available, true);
    assert.match(surveyMail.graphAvailability(FULL_ENV).reason, new RegExp(SENDER));
    // The previous name for GRAPH_SENDER is still read, so a deployment already carrying it keeps sending.
    const legacy = { GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', SURVEY_FROM_MAILBOX: 'old@futuro.test' };
    assert.equal(surveyMail.graphAvailability(legacy).available, true);
    assert.equal(surveyMail.graphConfig(legacy).sender, 'old@futuro.test');
    assert.equal(surveyMail.graphConfig({ ...legacy, GRAPH_SENDER: SENDER }).sender, SENDER, 'GRAPH_SENDER wins over the old name');

    // And an unconfigured send refuses outright rather than half-sending: nothing leaves, nothing is logged.
    const round = newRound('unconfigured'); const rows = await rowsFor(round);
    await assert.rejects(() => surveyMail.graphSendRound(rows, { roundId: round.id, sleep: quiet, log: quiet }, {}), /not configured/);
    assert.equal(calls.length, 0, 'an unconfigured sender must not reach Microsoft at all');
    assert.equal(surveyMail.deliveryCounts(round.id).sent, 0);
  });

  // ===== The access token =====
  await t.test('the token is fetched once, reused until it expires, then refreshed once however many callers wait', async () => {
    reset();
    const first = await surveyMail.graphToken(process.env, 0);
    assert.equal(first, 'access-' + tokenSerial);
    assert.equal(signins().length, 1);
    // A live token is not fetched again.
    assert.equal(await surveyMail.graphToken(process.env, 60_000), first);
    assert.equal(await surveyMail.graphToken(process.env, 3_600_000 - surveyMail.TOKEN_SAFETY_MS - 1000), first);
    assert.equal(signins().length, 1, 'a token still inside its hour must be reused');
    // Inside the safety margin it is refreshed on the clock — not after a 401 has cost a message.
    const late = 3_600_000 - surveyMail.TOKEN_SAFETY_MS + 1000;
    const together = await Promise.all([surveyMail.graphToken(process.env, late), surveyMail.graphToken(process.env, late), surveyMail.graphToken(process.env, late)]);
    assert.equal(signins().length, 2, 'three callers waiting must share ONE refresh, not start three');
    assert.equal(new Set(together).size, 1, 'and all get the same new token');
    assert.notEqual(together[0], first);
    // The secret is posted to the token endpoint and nowhere else.
    assert.ok(String(signins()[0].init.body).includes('grant_type=client_credentials'));
    assert.equal(sends().length, 0);
  });

  // ===== What actually goes in the message =====
  await t.test('each message is the approved invitation wording, with that person\'s own centre and link', async () => {
    reset();
    const round = newRound('wording'); const rows = await rowsFor(round);
    const { sleep } = noWait();
    const out = await surveyMail.graphSendRound(rows, { roundId: round.id, closesOn: CLOSES, contact: 'the Privacy Officer', sleep, log: quiet });
    assert.equal(out.sent, STAFF);
    assert.equal(sends().length, STAFF);
    for (const c of sends()) {
      const body = payload(c), to = recipient(c);
      const row = rows.find((r) => r.email === to);
      assert.ok(row, 'a message went to an address that is not in the export: ' + to);
      const approved = survey.invitationEmail({ centre: row.centre, link: row.link, closesOn: CLOSES, contact: 'the Privacy Officer' });
      assert.equal(body.message.subject, approved.subject, 'the subject must be the approved wording, not a new one');
      assert.equal(body.message.body.content, approved.body);
      assert.equal(body.message.body.contentType, 'Text');
      assert.equal(body.saveToSentItems, false, '221 copies carrying the recipient list is the one thing not to keep');
      // Their own centre, their own link — not the first row's.
      assert.match(body.message.body.content, new RegExp('Futuro ' + row.centre));
      assert.ok(body.message.body.content.includes(row.link));
      assert.match(body.message.body.content, /30 September 2026/);
      assert.equal(c.url, 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(SENDER) + '/sendMail');
    }
    // Two centres and head office, each asked about the thing they work for.
    const centres = new Set(sends().map((c) => payload(c).message.subject));
    assert.equal(centres.size, 3, 'Alpha, Beta and Early Learning each get their own subject line');
  });

  // ===== Pacing and throttling =====
  await t.test('the round is paced at the mailbox ceiling, and a 429 waits as long as Retry-After says', async () => {
    assert.equal(surveyMail.MESSAGES_PER_MINUTE, 30, 'Exchange caps a mailbox at about 30 a minute');
    assert.equal(surveyMail.SEND_INTERVAL_MS, 2000);
    // 221 recipients at this rate is the eight minutes the owner was told to expect.
    assert.ok(Math.round((221 * surveyMail.SEND_INTERVAL_MS) / 60000) >= 7);

    reset();
    const round = newRound('pacing'); const rows = (await rowsFor(round)).slice(0, 3);
    let { waits, sleep } = noWait();
    await surveyMail.graphSendRound(rows, { roundId: round.id, closesOn: CLOSES, sleep, log: quiet });
    assert.deepEqual(waits, [2000, 2000], 'a pause between messages, and none after the last one');

    // Now a 429 carrying Retry-After: 2. The wait must come from the header, not from a fixed backoff.
    reset();
    const round2 = newRound('throttled'); const rows2 = (await rowsFor(round2)).slice(0, 1);
    let n = 0;
    handler = async (u) => {
      if (u.includes('/oauth2/v2.0/token')) return tokenResponse();
      n += 1;
      return n === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '2' } }) : accepted();
    };
    ({ waits, sleep } = noWait());
    const out = await surveyMail.graphSendRound(rows2, { roundId: round2.id, closesOn: CLOSES, sleep, log: quiet });
    assert.equal(out.sent, 1, 'a throttle is a wait, not a lost invitation');
    assert.deepEqual(waits, [2000], 'exactly what the header asked for');
    assert.notEqual(waits[0], surveyMail.FALLBACK_RETRY_MS, 'and not the fallback, which is what a fixed backoff would give');
    assert.equal(sends().length, 2);

    // 503 is treated the same way, and a header saying "come back in a day" is capped rather than obeyed.
    reset();
    const round3 = newRound('unavailable'); const rows3 = (await rowsFor(round3)).slice(0, 1);
    let m = 0;
    handler = async (u) => {
      if (u.includes('/oauth2/v2.0/token')) return tokenResponse();
      m += 1;
      return m === 1 ? new Response(null, { status: 503, headers: { 'retry-after': '86400' } }) : accepted();
    };
    ({ waits, sleep } = noWait());
    assert.equal((await surveyMail.graphSendRound(rows3, { roundId: round3.id, sleep, log: quiet })).sent, 1);
    assert.equal(waits[0], 10 * 60 * 1000, 'a wait longer than the cap is the cap');
  });

  // ===== The failure that will actually happen =====
  await t.test('a 403 stops the run and the message names the address it was refused for', async () => {
    reset();
    const round = newRound('forbidden'); const rows = await rowsFor(round);
    handler = async (u) => (u.includes('/oauth2/v2.0/token') ? tokenResponse()
      : new Response(JSON.stringify({ error: { code: 'ErrorAccessDenied' } }), { status: 403 }));
    const { waits, sleep } = noWait();
    await assert.rejects(
      () => surveyMail.graphSendRound(rows, { roundId: round.id, closesOn: CLOSES, sleep, log: quiet }),
      (e) => {
        assert.ok(e.message.includes(SENDER), 'the single likeliest misconfiguration must name the sender address');
        assert.match(e.message, /403/);
        assert.match(e.message, /RBAC|scope/i, 'and say what is actually wrong, not "refused"');
        assert.equal(e.stopped, true);
        assert.equal(e.sent, 0);
        return true;
      });
    assert.equal(sends().length, 1, 'a 403 is configuration: it must not be retried and must not walk the list');
    assert.deepEqual(waits, [], 'nor waited on');
    // A 401 on a token issued seconds ago is the same kind of fact, and stops the same way.
    reset();
    const round2 = newRound('unauthorized'); const rows2 = await rowsFor(round2);
    handler = async (u) => (u.includes('/oauth2/v2.0/token') ? tokenResponse() : new Response(null, { status: 401 }));
    await assert.rejects(
      () => surveyMail.graphSendRound(rows2, { roundId: round2.id, sleep: quiet, log: quiet }),
      (e) => { assert.ok(e.message.includes(SENDER)); assert.match(e.message, /401/); return true; });
    assert.equal(sends().length, 1, 'a freshly issued token that is refused will be refused again');
  });

  // ===== The delivery log, which is the whole point of (d) =====
  await t.test('a delivery is recorded per token as its 202 arrives, and a retry covers only the undelivered', async () => {
    reset();
    const round = newRound('delivery'); const rows = await rowsFor(round);
    assert.equal(rows.length, STAFF);
    // Two land, then the RBAC scope turns out to be wrong and the run stops.
    let n = 0;
    handler = async (u) => {
      if (u.includes('/oauth2/v2.0/token')) return tokenResponse();
      n += 1;
      return n <= 2 ? accepted() : new Response(null, { status: 403 });
    };
    const firstAddresses = [];
    await assert.rejects(() => surveyMail.graphSendRound(rows, { roundId: round.id, closesOn: CLOSES, sleep: quiet, log: quiet }), /403/);
    for (const c of sends()) firstAddresses.push(recipient(c));
    assert.equal(firstAddresses.length, 3, 'two delivered and one refused');
    let counts = surveyMail.deliveryCounts(round.id);
    assert.equal(counts.sent, 2, 'each 202 is written as it arrives, not at the end of a run that never finished');
    assert.equal(counts.failed, 1);
    assert.equal(counts.last_error, 'forbidden', 'the error CLASS, not a message and not an address');
    const deliveredAfterFirst = surveyMail.deliveredTokens(round.id);
    assert.equal(deliveredAfterFirst.size, 2);

    // The scope is fixed and the admin presses Retry. exportRows is deterministic, so the same people
    // get the same tokens — which is what lets the log know who already has a link.
    reset();
    const again = await rowsFor(round);
    assert.deepEqual(again.map((r) => r.token), rows.map((r) => r.token), 'the same person must get the same token on a re-export');
    const out = await surveyMail.graphSendRound(again, { roundId: round.id, closesOn: CLOSES, sleep: quiet, log: quiet });
    const secondAddresses = sends().map(recipient);
    assert.equal(out.skipped, 2, 'the two already delivered are skipped');
    assert.equal(out.sent, STAFF - 2);
    assert.equal(secondAddresses.length, STAFF - 2);

    // THE ASSERTION THAT MATTERS: nobody was sent two links, and everybody was sent one.
    const all = [...firstAddresses.slice(0, 2), ...secondAddresses];
    assert.equal(new Set(all).size, all.length, 'an address was sent a link twice');
    assert.deepEqual([...new Set(all)].sort(), rows.map((r) => r.email).sort(), 'everyone got exactly one');
    counts = surveyMail.deliveryCounts(round.id);
    assert.equal(counts.sent, STAFF);
    assert.equal(counts.failed, 0, 'the recipient that failed is now delivered, not both');
    // A third run has nothing to do — pressing Send again cannot re-send to anybody.
    reset();
    const third = await surveyMail.graphSendRound(await rowsFor(round), { roundId: round.id, sleep: quiet, log: quiet });
    assert.equal(third.sent, 0);
    assert.equal(third.skipped, STAFF);
    assert.equal(sends().length, 0, 'nothing at all leaves when everyone already has their link');
  });

  // ===== The order the log is written in, which is a column nobody declared =====
  await t.test('the delivery log records nothing about the order the round was sent in', async () => {
    reset();
    // The export hands the sender its rows in PAYROLL-ID order — that is the premise the attack needs,
    // and it is what makes the send order worth hiding.
    const payrollOrder = EMPLOYEES.map((e) => e.emailAddress);
    // Tokens are random, so pick a round where token order and payroll order genuinely differ; otherwise
    // "not payroll order" would be asserting nothing. In practice this is the first round every time.
    let round = null, rows = null;
    for (let i = 0; i < 8 && !round; i++) {
      const r = newRound('order-' + i), got = await rowsFor(r);
      const sent = got.map((x) => x.token);
      if (JSON.stringify(sent) !== JSON.stringify([...sent].sort())) { round = r; rows = got; }
    }
    assert.ok(round, 'could not build a fixture whose token order differs from its payroll order');
    assert.deepEqual(rows.map((r) => r.email), payrollOrder, 'the export is in payroll order');

    await surveyMail.graphSendRound(rows, { roundId: round.id, closesOn: CLOSES, sleep: quiet, log: quiet });

    // What a copy of the database gives up. No ORDER BY: rows come back in the order the FILE holds them,
    // which is the order anyone reading a backup, a disk snapshot or scripts/restore-db.js gets.
    const payrollTokens = rows.map((r) => r.token);
    const stored = db.prepare('SELECT token FROM survey_deliveries WHERE round_id = ?').all(round.id).map((r) => r.token);
    assert.equal(stored.length, STAFF);
    assert.notDeepEqual(stored, payrollTokens,
      'the delivery log is stored in payroll order: pair it against eh.allEmployees() and every token has a name on it, with no key and nothing kept');
    assert.deepEqual(stored, [...payrollTokens].sort(), 'it is in token order, which is 32 random bytes and says nothing about who');

    // The attack in full, exactly as someone holding the file and the payroll list would run it, without
    // SURVEY_ASSIGN_KEY: pair position for position. It must not hand back the map the keyed shuffle in
    // exportRows exists to destroy.
    const recovered = stored.filter((token, i) => token === payrollTokens[i]).length;
    assert.ok(recovered < STAFF, `row order re-identified ${recovered} of ${STAFF} tokens`);

    // The send itself is in that same order — this is where the ordering is actually decided.
    const tokenOf = new Map(rows.map((r) => [r.email, r.token]));
    assert.deepEqual(sends().map((c) => tokenOf.get(recipient(c))), [...payrollTokens].sort(), 'the round goes out in token order');

    // And the same tokens handed over in a DIFFERENT order leave the same file behind: the order a caller
    // supplies leaves no trace at all. This is the assertion that fails the moment the sort goes missing.
    const round2 = newRound('order-reversed');
    const rows2 = [...(await rowsFor(round2))].reverse();
    reset();
    await surveyMail.graphSendRound(rows2, { roundId: round2.id, closesOn: CLOSES, sleep: quiet, log: quiet });
    const stored2 = db.prepare('SELECT token FROM survey_deliveries WHERE round_id = ?').all(round2.id).map((r) => r.token);
    assert.deepEqual(stored2, [...rows2.map((r) => r.token)].sort(), 'the order the rows arrived in must leave no trace');

    // Belt and braces, in the schema: there is no rowid here to order by in the first place.
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'survey_deliveries'").get().sql,
      /WITHOUT\s+ROWID/i, 'the delivery log must not keep an insertion counter');
    assert.throws(() => db.prepare('SELECT rowid FROM survey_deliveries').all(), /no such column/i);
  });

  // ===== Dry run =====
  await t.test('the dry run reports what would go where and sends nothing at all', async () => {
    reset();
    const round = newRound('dry'); const rows = await rowsFor(round);
    const report = await surveyMail.graphDryRun(rows, { roundId: round.id, closesOn: CLOSES, contact: 'the Privacy Officer' });
    assert.equal(calls.length, 0, 'a dry run must not call Microsoft — not even to sign in');
    assert.equal(sends().length, 0);
    assert.equal(report.total, STAFF);
    assert.equal(report.queued, STAFF);
    assert.equal(report.alreadyDelivered, 0);
    assert.equal(report.sender, SENDER);
    assert.equal(report.ratePerMinute, surveyMail.MESSAGES_PER_MINUTE);
    assert.deepEqual(report.centres.map((c) => c.centre).sort(), ['Alpha', 'Beta', 'Early Learning']);
    assert.equal(report.centres.reduce((a, c) => a + c.queued, 0), STAFF, 'the per-centre counts must add up to the round');
    assert.equal(report.centres.find((c) => c.centre === 'Alpha').queued, 3);
    // Deliver one, and the dry run says so rather than counting it again.
    await surveyMail.graphSendRound(rows.slice(0, 1), { roundId: round.id, sleep: quiet, log: quiet });
    const after = await surveyMail.graphDryRun(rows, { roundId: round.id, closesOn: CLOSES });
    assert.equal(after.queued, STAFF - 1);
    assert.equal(after.alreadyDelivered, 1);
    // And it works before the tenant work is done, which is when you most want to look at it.
    const unconfigured = await surveyMail.graphDryRun(rows, { roundId: round.id }, {});
    assert.equal(unconfigured.available, false);
    assert.match(unconfigured.reason, /GRAPH_TENANT_ID/);
    assert.equal(unconfigured.total, STAFF);
  });

  // The owner's pre-flight is: dry run, dry run again, then send. So a dry run must leave the round
  // exactly as it found it. It used to mint the round's tokens and stamp them sent, and since the
  // re-shuffle guard in exportRows arms on those rows EXISTING, one resignation between the pre-flight
  // and the send left the round impossible to export or send — with nothing sent, and no saved file to
  // merge the reminder from.
  await t.test('a dry run writes nothing, so a resignation before the send cannot brick the round', async () => {
    reset();
    const round = newRound('pre-flight');
    const cookie = await login('admin');
    const invs = () => db.prepare('SELECT COUNT(*) n, COUNT(sent_on) stamped FROM survey_invitations WHERE round_id = ?').get(round.id);
    assert.deepEqual(invs(), { n: 0, stamped: 0 });

    const dry = async () => {
      const r = await freeze(FROZEN, () => realFetch(base + '/admin/survey/' + round.id + '/dry-run',
        { method: 'POST', headers: { cookie }, redirect: 'manual' }));
      await r.text(); return decodeURIComponent(r.headers.get('location') || '');
    };
    const said = await dry();
    assert.match(said, new RegExp('Dry run: ' + STAFF + ' message\\(s\\) would be sent'), 'it still reports the whole round');
    await dry();                                   // and again, as the owner does
    assert.deepEqual(invs(), { n: 0, stamped: 0 }, 'a dry run must mint no token and stamp none sent');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM survey_deliveries WHERE round_id = ?').get(round.id).n, 0);
    assert.equal(calls.length, 0, 'and must not reach Microsoft');

    // Someone leaves payroll between the pre-flight and the send. The send must still be possible.
    const full = eh.allEmployees;
    eh.allEmployees = async () => EMPLOYEES.slice(1).map((e) => ({ ...e }));
    let out;
    try {
      out = await freeze(FROZEN, () => survey.exportRows(round.id, { baseUrl: 'https://pulse.example' }));
      assert.equal(out.rows.length, STAFF - 1);
      assert.equal(out.preview, false);
      assert.deepEqual(invs(), { n: STAFF - 1, stamped: STAFF - 1 }, 'the real export is what issues and stamps');
      for (const r of out.rows) assert.notEqual(r.token, survey.PREVIEW_TOKEN, 'a real export hands out real tokens');

      // A dry run AFTER the tokens are out reports on those tokens, and still changes nothing.
      const after = await freeze('2026-09-17T03:00:00Z', () => survey.exportRows(round.id, { baseUrl: 'https://pulse.example', preview: true }));
      assert.deepEqual(after.rows.map((r) => r.token), out.rows.map((r) => r.token), 'the same people, the same links');
      assert.deepEqual(invs(), { n: STAFF - 1, stamped: STAFF - 1 });
      assert.equal(db.prepare('SELECT DISTINCT sent_on FROM survey_invitations WHERE round_id = ?').get(round.id).sent_on, TODAY,
        'a later dry run must not re-date the send');
    } finally { eh.allEmployees = full; }

    // Preview rows carry real addresses and a link that is nobody's, so the sender refuses them outright.
    const fresh = newRound('preview-never-sends');
    const preview = await freeze(FROZEN, () => survey.exportRows(fresh.id, { baseUrl: 'https://pulse.example', preview: true }));
    assert.equal(preview.rows.length, STAFF);
    assert.ok(preview.rows.every((r) => r.token === survey.PREVIEW_TOKEN));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM survey_invitations WHERE round_id = ?').get(fresh.id).n, 0);
    await assert.rejects(() => surveyMail.graphSendRound(preview.rows, { roundId: fresh.id, sleep: quiet, log: quiet }), /preview/);
    assert.equal(sends().length, 0, 'not one message, and no delivery recorded');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM survey_deliveries WHERE round_id = ?').get(fresh.id).n, 0);
  });

  // ===== A single real message =====
  await t.test('the test send is one real message, carrying the sample link and recorded nowhere', async () => {
    reset();
    const before = db.prepare('SELECT COUNT(*) n FROM survey_deliveries').get().n;
    const out = await surveyMail.graphSendTest('owner@futuro.test', { baseUrl: 'https://pulse.example', centre: 'Austral', closesOn: CLOSES });
    assert.equal(out.sent, undefined); assert.equal(out.ok, true); assert.equal(out.sender, SENDER);
    assert.equal(sends().length, 1);
    assert.equal(recipient(sends()[0]), 'owner@futuro.test');
    const body = payload(sends()[0]).message.body.content;
    assert.ok(body.includes('https://pulse.example/s/' + surveyMail.TEST_LINK_TOKEN), 'a test must not spend a real invitation');
    assert.match(body, /Futuro Austral/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM survey_deliveries').get().n, before, 'a test message is not part of a round');
    await assert.rejects(() => surveyMail.graphSendTest('not-an-address', {}), /address/);
    await assert.rejects(() => surveyMail.graphSendTest('owner@futuro.test', {}, {}), /not configured/);
  });

  // ===== The secret =====
  await t.test('the client secret never reaches a log line, an error or a thrown message', async () => {
    reset();
    const logs = [];
    const real = { log: console.log, error: console.error, warn: console.warn };
    const capture = (...a) => logs.push(a.map((x) => (x && x.stack) || String(x)).join(' '));
    console.log = capture; console.error = capture; console.warn = capture;
    let thrown = [];
    try {
      const round = newRound('secrets'); const rows = await rowsFor(round);
      // The worst realistic case: the sign-in fails and Microsoft quotes the request — which carries the
      // secret — back in the body. Nothing may read that body.
      handler = async (u) => (u.includes('/oauth2/v2.0/token')
        ? new Response(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided: client_secret=' + SECRET }), { status: 401 })
        : accepted());
      await surveyMail.graphSendRound(rows, { roundId: round.id, closesOn: CLOSES, sleep: quiet }).catch((e) => thrown.push(e));
      // And a transport error whose own message carries it.
      reset();
      await surveyMail.graphToken(process.env, Date.now());               // a good token in hand
      handler = async () => { throw new Error('socket hang up while posting client_secret=' + SECRET); };
      await surveyMail.graphSend({ to: 'x@y.test', subject: 'S', body: 'B' }).catch((e) => thrown.push(e));
      // A send that fails per-recipient, logged by the round runner's own default logger.
      reset();
      const round2 = newRound('secrets-2'); const rows2 = (await rowsFor(round2)).slice(0, 1);
      handler = async (u) => (u.includes('/oauth2/v2.0/token') ? tokenResponse()
        : new Response('the body may say client_secret=' + SECRET + ' and must never be read', { status: 400 }));
      await surveyMail.graphSendRound(rows2, { roundId: round2.id, sleep: quiet }).catch((e) => thrown.push(e));
    } finally {
      console.log = real.log; console.error = real.error; console.warn = real.warn;
    }
    assert.ok(logs.length > 0, 'the capture caught nothing, so it proved nothing');
    assert.ok(thrown.length >= 2, 'the failures under test did not fail');
    for (const line of logs) assert.ok(!line.includes(SECRET), 'a log line carries the client secret: ' + line);
    for (const e of thrown) {
      assert.ok(!String(e && e.message).includes(SECRET), 'a thrown message carries the client secret');
      assert.ok(!String(e && e.stack).includes(SECRET), 'a stack carries the client secret');
    }
    assert.ok(thrown.some((e) => /\[redacted\]/.test(String(e.message))), 'a message that did carry it must show it was taken out');
    assert.equal(surveyMail.redact('a ' + SECRET + ' b', process.env), 'a [redacted] b');
    // Nor may it reach the page: the availability line is rendered, so it says names, never values.
    for (const env of [process.env, {}]) assert.ok(!surveyMail.graphAvailability(env).reason.includes(SECRET));
  });

  // ===== The guarantee the whole survey rests on =====
  await t.test('no email address — and no secret — is written to the database by any of it', () => {
    // Every table, every column, off sqlite_master rather than a list, so a table added later is covered.
    const addresses = [...EMPLOYEES.map((e) => e.emailAddress), 'owner@futuro.test'];
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    let scanned = 0;
    for (const tb of tables) {
      const cols = db.prepare(`PRAGMA table_info(${tb})`).all().map((c) => c.name);
      for (const row of db.prepare(`SELECT * FROM ${tb}`).all()) {
        for (const c of cols) {
          const v = row[c]; if (v == null) continue;
          const s = String(v); scanned += 1;
          for (const a of addresses) assert.ok(!s.includes(a), `${tb}.${c} contains the address ${a}`);
          assert.ok(!s.includes(SECRET), `${tb}.${c} contains the client secret`);
          if (tb.startsWith('survey_')) assert.ok(!/@/.test(s), `${tb}.${c} holds something address-shaped: ${s}`);
        }
      }
    }
    assert.ok(scanned > 0, 'the scan found no rows at all, so it proved nothing');
    assert.ok(db.prepare('SELECT COUNT(*) n FROM survey_deliveries').get().n > 0, 'and it scanned a delivery log that actually has rows in it');

    // The file itself, not just the rows a query returns — a dropped column or a freed page still holds
    // its bytes. WAL first, or the recent writes are in a file this would not look at.
    db.pragma('wal_checkpoint(TRUNCATE)');
    for (const f of [process.env.DB_PATH, process.env.DB_PATH + '-wal', process.env.DB_PATH + '-shm']) {
      if (!fs.existsSync(f)) continue;
      const bytes = fs.readFileSync(f).toString('latin1');
      for (const a of addresses) assert.ok(!bytes.includes(a), `${path.basename(f)} contains the address ${a}`);
      assert.ok(!bytes.includes(SECRET), `${path.basename(f)} contains the client secret`);
    }
    // The delivery log holds a token, a round, a status, a count, an error class and a DAY. Nothing else:
    // a per-token timestamp would order the round, and an address would undo the survey.
    assert.deepEqual(db.prepare('PRAGMA table_info(survey_deliveries)').all().map((c) => c.name),
      ['token', 'round_id', 'status', 'attempts', 'last_error', 'updated_on']);
    for (const r of db.prepare('SELECT updated_on FROM survey_deliveries').all())
      assert.match(r.updated_on, /^\d{4}-\d{2}-\d{2}$/, 'a day, never an instant');
  });

  // ===== The admin page =====
  await t.test('the page offers the dry run, the test send and a retry, to admin and ops only', async () => {
    reset();
    const round = newRound('page'); const rows = await rowsFor(round);
    const cookie = await login('admin');
    const get = async (url, c) => { const r = await realFetch(base + url, { headers: c ? { cookie: c } : {}, redirect: 'manual' }); return { status: r.status, text: await r.text() }; };

    let page = await freeze(FROZEN, () => get('/admin/survey?round=' + round.id, cookie));
    assert.equal(page.status, 200);
    assert.match(page.text, /Dry run/);
    assert.match(page.text, /Send now/);
    assert.match(page.text, /Test send/);
    assert.match(page.text, new RegExp(SENDER), 'it says which mailbox it will send from');
    assert.match(page.text, /30 a minute/, 'and why it takes eight minutes');
    assert.ok(!page.text.includes(SECRET));

    // A dry run from the page: a report, and still no call to Microsoft.
    const dry = await freeze(FROZEN, () => realFetch(base + '/admin/survey/' + round.id + '/dry-run', { method: 'POST', headers: { cookie }, redirect: 'manual' }));
    await dry.text();
    assert.equal(dry.status, 302);
    assert.equal(calls.length, 0, 'the dry run button must not reach Microsoft');
    page = await freeze(FROZEN, () => get('/admin/survey?round=' + round.id, cookie));
    assert.match(page.text, /Dry run — 2026-09-16\. Nothing was sent\./);
    assert.match(page.text, /would go out from people@futuro\.test/);

    // Deliver two, and the button becomes a retry that counts only the undelivered.
    await surveyMail.graphSendRound(rows.slice(0, 2), { roundId: round.id, sleep: quiet, log: quiet });
    page = await freeze(FROZEN, () => get('/admin/survey?round=' + round.id, cookie));
    assert.match(page.text, /Retry the undelivered/);
    assert.match(page.text, /Delivered <strong>2<\/strong> of 6/);

    // Progress is counts and nothing else — no address, no token.
    const status = await freeze(FROZEN, () => realFetch(base + '/admin/survey/' + round.id + '/send-status', { headers: { cookie } }));
    const json = await status.json();
    assert.equal(status.status, 200);
    assert.equal(json.running, false);
    assert.equal(json.deliveries.sent, 2);
    const asText = JSON.stringify(json);
    for (const e of EMPLOYEES) assert.ok(!asText.includes(e.emailAddress));
    for (const r of rows) assert.ok(!asText.includes(r.token), 'progress must not carry tokens either');

    // Ops and admin only, on every one of them.
    reset();
    const viewer = await login('viewer');
    for (const [method, url] of [['GET', '/admin/survey/' + round.id + '/send-status'], ['POST', '/admin/survey/' + round.id + '/send'],
      ['POST', '/admin/survey/' + round.id + '/dry-run'], ['POST', '/admin/survey/' + round.id + '/test']]) {
      const r = await freeze(FROZEN, () => realFetch(base + url, { method, headers: { cookie: viewer }, redirect: 'manual' }));
      await r.text();
      assert.equal(r.status, 403, method + ' ' + url + ' must be closed to a viewer');
    }
    assert.equal(sends().length, 0, 'and none of that sent anything');
  });

  } finally {
    const { store } = require('../middleware/session');
    if (store && store.stopPruning) store.stopPruning();
    await new Promise((r) => server.close(r));
    db.close();
    global.fetch = realFetch;
  }
});
