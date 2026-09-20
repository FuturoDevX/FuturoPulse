// Employment Hero Payroll (KeyPay) credentials are read at CALL time.
//
// They used to be consts evaluated when the module was first required, so the credentials were frozen at
// boot. Rotating EH_PAYROLL_API_KEY in the Render dashboard had no effect until the service happened to
// restart — the process kept presenting the old key, and the only symptom was an EH 401 on the nightly
// run, recorded in source_sync and visible to nobody who did not go looking.
//
// NOTE ON SCOPE: Pulse is on the Payroll API (api.yourpayroll.com.au), which authenticates with HTTP
// Basic — API key as username, blank password. It is NOT on the HR API (oauth.employmenthero.com) and
// is unaffected by that product's PKCE cutover. There is deliberately no OAuth, token or refresh code
// in this path.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ehauth-')), 'test.db');
process.env.NODE_ENV = 'test';

const { eh } = require('../services/eh');

const realFetch = global.fetch;
const saved = {
  key: process.env.EH_PAYROLL_API_KEY,
  bid: process.env.EH_PAYROLL_BUSINESS_ID,
  base: process.env.EH_PAYROLL_BASE_URL,
};
const restore = () => {
  global.fetch = realFetch;
  for (const [k, v] of [['EH_PAYROLL_API_KEY', saved.key], ['EH_PAYROLL_BUSINESS_ID', saved.bid], ['EH_PAYROLL_BASE_URL', saved.base]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};
const decode = (header) => Buffer.from(String(header).replace(/^Basic /, ''), 'base64').toString();

test('a rotated API key takes effect on the next call, with no restart', async () => {
  const sent = [];
  global.fetch = async (url, init) => {
    sent.push({ url: String(url), auth: init.headers.Authorization });
    return { ok: true, status: 200, text: async () => '[]' };
  };
  try {
    process.env.EH_PAYROLL_BASE_URL = 'https://api.yourpayroll.com.au';
    process.env.EH_PAYROLL_BUSINESS_ID = 'biz-1';
    process.env.EH_PAYROLL_API_KEY = 'key-before-rotation';
    await eh.locations();

    // The rotation. The module is NOT re-required — this is the whole point.
    process.env.EH_PAYROLL_API_KEY = 'key-after-rotation';
    await eh.locations();

    assert.equal(sent.length, 2);
    assert.equal(decode(sent[0].auth), 'key-before-rotation:', 'API key is the username, password blank');
    assert.equal(decode(sent[1].auth), 'key-after-rotation:', 'the new key is used without a restart');
    assert.notEqual(sent[0].auth, sent[1].auth);
  } finally { restore(); }
});

test('the business id and base URL are read at call time too', async () => {
  const sent = [];
  global.fetch = async (url) => { sent.push(String(url)); return { ok: true, status: 200, text: async () => '[]' }; };
  try {
    process.env.EH_PAYROLL_API_KEY = 'k';
    process.env.EH_PAYROLL_BASE_URL = 'https://api.yourpayroll.com.au';
    process.env.EH_PAYROLL_BUSINESS_ID = 'biz-1';
    await eh.locations();
    process.env.EH_PAYROLL_BUSINESS_ID = 'biz-2';
    await eh.locations();
    assert.match(sent[0], /\/business\/biz-1\/location$/);
    assert.match(sent[1], /\/business\/biz-2\/location$/, 'a changed business id is picked up without a restart');
    // A trailing slash on the base must not produce a double slash in the path.
    process.env.EH_PAYROLL_BASE_URL = 'https://api.yourpayroll.com.au/';
    await eh.locations();
    assert.match(sent[2], /^https:\/\/api\.yourpayroll\.com\.au\/api\/v2\//);
  } finally { restore(); }
});

test('hasCreds reflects the environment as it stands, not as it was at boot', () => {
  try {
    process.env.EH_PAYROLL_API_KEY = 'k';
    process.env.EH_PAYROLL_BUSINESS_ID = 'b';
    assert.equal(eh.hasCreds(), true);

    delete process.env.EH_PAYROLL_API_KEY;
    assert.equal(eh.hasCreds(), false, 'a cleared key is seen immediately');

    process.env.EH_PAYROLL_API_KEY = 'k';
    delete process.env.EH_PAYROLL_BUSINESS_ID;
    assert.equal(eh.hasCreds(), false, 'a key without a business id is not credentials');
  } finally { restore(); }
});

test('an EH error never carries the response body', async () => {
  // Unchanged behaviour, asserted here because this is the auth file's test: a 401 body from EH could
  // contain employee records, and the thrown message is what lands in source_sync.detail and the logs.
  global.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ employees: ['Jane Citizen'] }) });
  try {
    process.env.EH_PAYROLL_API_KEY = 'k';
    process.env.EH_PAYROLL_BUSINESS_ID = 'b';
    await assert.rejects(eh.locations(), (e) => {
      assert.match(e.message, /EH 401 \/location/);
      assert.doesNotMatch(e.message, /Jane Citizen|employees/);
      return true;
    });
  } finally { restore(); }
});
