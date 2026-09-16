// How a survey invitation actually leaves the building. Two implementations behind one small interface,
// because the owner asked for email and this must not sit blocked on someone else's IT:
//
//   1. MAIL MERGE EXPORT — works today, needs nobody's permission. An admin downloads a CSV of address +
//      magic link + centre and mail-merges it from Outlook. The addresses are read from payroll to write
//      the file and are never stored.
//   2. MICROSOFT GRAPH — Futuro is a Microsoft tenant, so Graph sends from a real Futuro mailbox with no
//      new vendor and no new address for staff to distrust. It needs an app registration with the
//      Mail.Send APPLICATION permission, a tenant admin's consent, and an Exchange RBAC scope limiting
//      the app to that one mailbox. All of which is why it is behind environment variables and why its
//      absence is not an error: with any of them unset the admin page offers the export and says, in one
//      line, which variable is missing.
//
// A sender is only ever handed one address at a time, and only from the export rows, which are built
// inside a run and discarded with it. Nothing here writes an address anywhere — see survey_deliveries in
// db/schema.sql for how a retry knows who already has their link without one.
const db = require("../db/db");
const cal = require("./calendar");
const survey = require("./survey");

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const GRAPH_BASE = (process.env.GRAPH_BASE_URL || "https://graph.microsoft.com").replace(/\/+$/, "");
const LOGIN_BASE = (process.env.GRAPH_LOGIN_URL || "https://login.microsoftonline.com").replace(/\/+$/, "");

// ---- Pacing ---------------------------------------------------------------------------------------
// Exchange Online throttles a single mailbox at roughly 30 messages a minute. Going faster does not get
// there sooner — it gets the mailbox throttled, and a burst from a mailbox that has never sent one is
// also the shape of a compromised account. 221 recipients at this rate is about eight minutes, which is
// why the send runs in the background and the page shows progress instead of hanging.
const MESSAGES_PER_MINUTE = 30;
const SEND_INTERVAL_MS = Math.round(60000 / MESSAGES_PER_MINUTE);
// An app-only token lasts about an hour. Refresh against ITS clock with room to spare rather than
// waiting for a 401 to discover the expiry mid-round: a 401 costs a message and a round trip, this costs
// nothing.
const TOKEN_SAFETY_MS = 2 * 60 * 1000;
// Used ONLY when a throttling response carries no Retry-After. When the header is there it is
// authoritative — Exchange knows when it will let us back in and a guess does not.
const FALLBACK_RETRY_MS = 5000;
// A Retry-After of an hour is a stopped run, not a wait. Cap it, fail that recipient, and let the retry
// button pick them up later.
const MAX_RETRY_WAIT_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 4;
// The link in a test message. A test send must not spend a real staff member's invitation, so it carries
// the same sample link the draft on the admin page shows.
const TEST_LINK_TOKEN = "EXAMPLE-LINK-NOT-A-REAL-TOKEN";

// ---- Configuration --------------------------------------------------------------------------------
// GRAPH_SENDER is the mailbox invitations are sent FROM. It was called SURVEY_FROM_MAILBOX before this
// release; that name is still read, so a deployment already carrying it keeps sending, and GRAPH_SENDER
// wins if both are set.
function graphConfig(env = process.env) {
  const pick = (...keys) => { for (const k of keys) { const v = String(env[k] || "").trim(); if (v) return v; } return ""; };
  return {
    tenantId: pick("GRAPH_TENANT_ID"),
    clientId: pick("GRAPH_CLIENT_ID"),
    clientSecret: pick("GRAPH_CLIENT_SECRET"),
    sender: pick("GRAPH_SENDER", "SURVEY_FROM_MAILBOX"),
  };
}

// Is Graph usable, and if not, exactly which variable is missing. The page prints the reason rather than
// a bare "unavailable", so whoever has to raise it with IT knows what to ask for — and the export is
// offered meanwhile, so nobody is blocked on configuration.
function graphAvailability(env = process.env) {
  const c = graphConfig(env);
  const missing = Object.entries({
    GRAPH_TENANT_ID: c.tenantId, GRAPH_CLIENT_ID: c.clientId,
    GRAPH_CLIENT_SECRET: c.clientSecret, GRAPH_SENDER: c.sender,
  }).filter(([, v]) => !v).map(([k]) => k);
  if (!missing.length) return { available: true, missing: [], sender: c.sender, reason: `Sends from ${c.sender} via Microsoft Graph.` };
  return {
    available: false, missing, sender: c.sender,
    reason: `Microsoft Graph is not configured (${missing.join(", ")} not set). `
      + "It needs an app registration with the Mail.Send application permission, a tenant admin's consent, "
      + "and an Exchange RBAC scope limiting the app to the one mailbox it sends from. "
      + (missing.includes("GRAPH_SENDER") ? "GRAPH_SENDER was called SURVEY_FROM_MAILBOX before this release; either name is read. " : "")
      + "Until then, use the mail-merge export below — it sends exactly the same links.",
  };
}

// The one value that must never be written down. Nothing here deliberately prints the secret; this is
// what stops a future edit, or an error object that quotes the request it failed on, from doing it by
// accident. Every message that could have come from outside this file goes through it.
function redact(text, env = process.env) {
  const s = String(text == null ? "" : text);
  const secret = String(env.GRAPH_CLIENT_SECRET || "").trim();
  return secret ? s.split(secret).join("[redacted]") : s;
}

// The sendMail body Graph expects. Split out from the request so its shape can be tested without a
// network call. saveToSentItems is false: 221 copies of the same message in a shared mailbox's Sent
// Items is noise, and the copy would carry the recipient list, which is the one thing not to keep.
function sendMailBody({ to, subject, body }) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to || ""))) throw new Error("A recipient address is required.");
  if (!String(subject || "").trim()) throw new Error("A subject is required.");
  return {
    message: {
      subject: String(subject),
      body: { contentType: "Text", content: String(body || "") },
      toRecipients: [{ emailAddress: { address: String(to) } }],
    },
    saveToSentItems: false,
  };
}

// ---- Failures -------------------------------------------------------------------------------------
// A send fails in three materially different ways and the run has to tell them apart:
//   retryable  — 429/503/504 and the odd 5xx: wait as long as the response says, then try again.
//   fatal      — 403 and a 401 on a fresh token: configuration, not luck. Every remaining message would
//                fail identically, so the run stops and says which mailbox it was refused for.
//   rejected   — a 4xx about this one message: skip the recipient, keep the round going.
// `klass` is the single word written to survey_deliveries.last_error. Never a body, never an address.
class SendFailure extends Error {
  constructor(klass, message, { status = 0, retryAfterMs = null, fatal = false } = {}) {
    super(message);
    this.name = "SendFailure";
    this.klass = klass; this.status = status; this.retryAfterMs = retryAfterMs; this.fatal = fatal;
  }
}

// Honour what the response actually says. Graph sends Retry-After as seconds, but the HTTP-date form is
// legal and Microsoft does use it, so both are read rather than assumed.
function retryAfterMs(res, now = Date.now()) {
  const raw = String((res && res.headers && res.headers.get && res.headers.get("retry-after")) || "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Math.min(Number(raw) * 1000, MAX_RETRY_WAIT_MS);
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.min(Math.max(at - now, 0), MAX_RETRY_WAIT_MS);
  return null;
}

// The single most likely misconfiguration, so it gets the plainest sentence and names the address.
function forbiddenMessage(c) {
  return `Microsoft Graph refused to send as ${c.sender} (403). This is the RBAC scope, not a bad message: `
    + `the app may only send as the mailboxes its Exchange "RBAC for Applications" role assignment covers, and `
    + `${c.sender} is not one of them. Every remaining message would be refused the same way, so the run has `
    + `stopped. Check that the role assignment's scope includes ${c.sender}, or set GRAPH_SENDER to a mailbox `
    + `it does cover. Nothing was sent to anyone this attempt would have reached.`;
}
function unauthorizedMessage(c) {
  return `Microsoft Graph rejected a token it had just issued, sending as ${c.sender} (401). That is the app `
    + `registration, not the run: the Mail.Send application permission or its admin consent is missing, or `
    + `GRAPH_CLIENT_ID does not belong to GRAPH_TENANT_ID. Retrying will not fix it, so the run has stopped.`;
}

function failureFor(res, c, now) {
  const s = res.status;
  if (s === 429) return new SendFailure("throttled", `Microsoft Graph is throttling ${c.sender} (429).`,
    { status: s, retryAfterMs: retryAfterMs(res, now) != null ? retryAfterMs(res, now) : FALLBACK_RETRY_MS });
  if (s === 503 || s === 504) return new SendFailure("unavailable", `Microsoft Graph is temporarily unavailable (${s}).`,
    { status: s, retryAfterMs: retryAfterMs(res, now) != null ? retryAfterMs(res, now) : FALLBACK_RETRY_MS });
  if (s === 403) return new SendFailure("forbidden", forbiddenMessage(c), { status: s, fatal: true });
  if (s >= 500) return new SendFailure("server", `Microsoft Graph failed on its own side (${s}).`, { status: s, retryAfterMs: FALLBACK_RETRY_MS });
  return new SendFailure("rejected", `Microsoft Graph refused the message (${s}).`, { status: s });
}

// ---- The access token -----------------------------------------------------------------------------
// Client credentials, in memory, for the life of the process. Two callers arriving on an expired token
// must not start two sign-ins: the second waits on the first's promise.
let tokenCache = null;   // { token, expiresAt }
let refreshing = null;   // the ONE in-flight refresh

async function requestToken(env, now) {
  const c = graphConfig(env);
  if (!c.tenantId || !c.clientId || !c.clientSecret) throw new SendFailure("unconfigured", graphAvailability(env).reason, { fatal: true });
  let res;
  try {
    res = await fetch(`${LOGIN_BASE}/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, scope: GRAPH_SCOPE, grant_type: "client_credentials" }),
    });
  } catch (e) {
    throw new SendFailure("network", `Could not reach Microsoft to sign in (${redact(e && e.message, env)}).`, { retryAfterMs: FALLBACK_RETRY_MS });
  }
  // The failure body is never read and never logged. A client-credentials error quotes the request back
  // at you, and the request carries the secret.
  if (!res.ok) {
    throw new SendFailure("credentials",
      `Microsoft refused the sign-in for this app registration (${res.status}). Check GRAPH_TENANT_ID and `
      + "GRAPH_CLIENT_ID, and whether the client secret has expired — Entra secrets expire on a date and "
      + "this is what that looks like.",
      { status: res.status, fatal: res.status === 400 || res.status === 401 });
  }
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!json || !json.access_token) throw new SendFailure("credentials", "Microsoft returned no access token.", { fatal: true });
  tokenCache = { token: String(json.access_token), expiresAt: now + (Number(json.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}

async function graphToken(env = process.env, now = Date.now()) {
  if (tokenCache && tokenCache.expiresAt > now + TOKEN_SAFETY_MS) return tokenCache.token;
  if (refreshing) return refreshing;                       // one sign-in, however many callers are waiting
  refreshing = requestToken(env, now);
  try { return await refreshing; } finally { refreshing = null; }
}
function resetGraphToken() { tokenCache = null; refreshing = null; }

// ---- One message ----------------------------------------------------------------------------------
async function graphSend({ to, subject, body }, env = process.env, { now = Date.now } = {}) {
  const c = graphConfig(env);
  const payload = JSON.stringify(sendMailBody({ to, subject, body })); // built first: a bad row is not a network failure
  const held = tokenCache;
  const token = await graphToken(env, now());
  const fresh = !held || tokenCache !== held;
  let res;
  try {
    res = await fetch(`${GRAPH_BASE}/v1.0/users/${encodeURIComponent(c.sender)}/sendMail`, {
      method: "POST",
      signal: AbortSignal.timeout(45000),
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: payload,
    });
  } catch (e) {
    throw new SendFailure("network", `Could not reach Microsoft Graph (${redact(e && e.message, env)}).`, { retryAfterMs: FALLBACK_RETRY_MS });
  }
  if (res.status === 202 || res.ok) return { ok: true, status: res.status };   // 202, no body
  if (res.status === 401) {
    // A token we had been holding can be revoked or cut short. One retry with a new one; a 401 on a
    // token issued seconds ago is the permission, not the clock, and stops the run.
    if (fresh) throw new SendFailure("unauthorized", unauthorizedMessage(c), { status: 401, fatal: true });
    resetGraphToken();
    return graphSend({ to, subject, body }, env, { now });
  }
  throw failureFor(res, c, now());
}

// ---- The delivery log -----------------------------------------------------------------------------
// Keyed on the TOKEN. exportRows() is deterministic — same key, same staff list, same person, same token
// — so a retry can ask "did this one go?" without the address ever being stored. See db/schema.sql.
function deliveredTokens(roundId) {
  if (roundId == null) return new Set();
  return new Set(db.prepare("SELECT token FROM survey_deliveries WHERE round_id = ? AND status = 'sent'").all(roundId).map((r) => r.token));
}
function recordDelivery({ token, roundId, status, attempts = 1, errorClass = null, today = cal.today() }) {
  if (roundId == null || !token) return; // a send outside a round (the test message) logs nothing
  db.prepare(`INSERT INTO survey_deliveries (token, round_id, status, attempts, last_error, updated_on)
              VALUES (@token, @round_id, @status, @attempts, @last_error, @updated_on)
              ON CONFLICT(token) DO UPDATE SET
                status     = excluded.status,
                attempts   = survey_deliveries.attempts + excluded.attempts,
                last_error = excluded.last_error,
                updated_on = excluded.updated_on`)
    .run({ token, round_id: roundId, status, attempts, last_error: errorClass, updated_on: today });
}
function deliveryCounts(roundId) {
  const rows = db.prepare("SELECT status, COUNT(*) n FROM survey_deliveries WHERE round_id = ? GROUP BY status").all(roundId);
  const get = (s) => (rows.find((r) => r.status === s) || { n: 0 }).n;
  const last = db.prepare(`SELECT last_error, updated_on FROM survey_deliveries
                           WHERE round_id = ? AND status <> 'sent' AND last_error IS NOT NULL
                           ORDER BY updated_on DESC LIMIT 1`).get(roundId) || null;
  return { sent: get("sent"), failed: get("failed"), last_error: last && last.last_error, last_on: last && last.updated_on };
}

const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms || 0)));

// ---- A whole round --------------------------------------------------------------------------------
// Serial and paced. A delivery is written the moment its 202 comes back, so an interrupted run — a
// throttle that outlasts the retries, a crash, a 403 half way — leaves an exact record of who already
// has their link. Running this again is therefore the retry: anyone already delivered is skipped, which
// is what makes "send two links to the same person" impossible rather than unlikely.
//
// `sleep` and `now` are injectable so the pacing and the Retry-After behaviour can be tested without
// spending eight minutes of wall clock in the test runner.
//
// THE QUEUE IS SORTED BY TOKEN, and that is a privacy control rather than a tidiness one. `rows` arrives
// in PAYROLL-ID ORDER (exportRows -> activeStaff sorts by employee id), a delivery is written per row as
// it is sent, and insertion order is an order this table cannot help recording. Send in payroll order and
// the log's row order IS the payroll list: pair the two off and every token has a name on it, recovered
// from a copy of the database plus the same eh.allEmployees() call the export makes — WITHOUT the assign
// key, which is the one thing the schema says must not be kept with the backups. That is precisely the
// identifier the keyed shuffle in exportRows was built to destroy, put back by the back door. A token is
// 32 random bytes, so sorting on it is an order that says nothing about who, and nothing in this run
// depends on the order anyway: the pacing, the retries and the progress counts are all per row.
async function graphSendRound(rows, {
  roundId = null, closesOn = "", contact = "",
  intervalMs = SEND_INTERVAL_MS, onProgress = null, sleep = wait, log = console.log,
  today = cal.today(), now = Date.now,
} = {}, env = process.env) {
  const avail = graphAvailability(env);
  if (!avail.available) throw new Error(avail.reason);
  const already = deliveredTokens(roundId);
  const queue = (rows || []).filter((r) => r && !already.has(r.token))
    .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0)); // see above: never the order they arrived in
  const state = {
    total: (rows || []).length, queued: queue.length, skipped: (rows || []).length - queue.length,
    done: 0, sent: 0, failed: 0, stopped: null,
  };
  const report = () => { if (onProgress) { try { onProgress({ ...state }); } catch { /* progress must never break a send */ } } };
  report();

  for (let i = 0; i < queue.length; i++) {
    const row = queue[i];
    const mail = survey.invitationEmail({ centre: row.centre, link: row.link, closesOn, contact });
    let attempts = 0, delivered = false, klass = "error";
    while (attempts < MAX_ATTEMPTS && !delivered) {
      attempts += 1;
      try {
        await graphSend({ to: row.email, subject: mail.subject, body: mail.body }, env, { now });
        delivered = true;
      } catch (e) {
        klass = (e && e.klass) || "error";
        if (e && e.fatal) {
          recordDelivery({ token: row.token, roundId, status: "failed", attempts, errorClass: klass, today });
          state.failed += 1; state.done += 1; state.stopped = klass; report();
          log(`[survey] send stopped after ${state.sent} delivered: ${redact(e.message, env)}`);
          const stop = new Error(redact(e.message, env));
          Object.assign(stop, { klass, stopped: true, sent: state.sent, failed: state.failed, skipped: state.skipped, done: state.done, total: state.total });
          throw stop;
        }
        if (attempts < MAX_ATTEMPTS && e && e.retryAfterMs != null) { await sleep(e.retryAfterMs); continue; }
        break;
      }
    }
    // Written as the 202 arrives — before the pacing pause, so an interruption cannot lose it.
    recordDelivery({ token: row.token, roundId, status: delivered ? "sent" : "failed", attempts, errorClass: delivered ? null : klass, today });
    if (delivered) state.sent += 1;
    else { state.failed += 1; log(`[survey] one invitation was not delivered (${klass}) after ${attempts} attempt(s)`); } // the class, never the recipient
    state.done += 1;
    report();
    if (i < queue.length - 1 && intervalMs > 0) await sleep(intervalMs);
  }
  return { total: state.total, queued: state.queued, skipped: state.skipped, sent: state.sent, failed: state.failed, done: state.done };
}

// ---- Dry run --------------------------------------------------------------------------------------
// Everything except the send: resolve the recipients, build every message, say what would go where and
// how many. It makes NO network call at all — not even a sign-in — so it is safe to run on a whim, and
// it works before the tenant work is done, which is when you most want to look at it.
async function graphDryRun(rows, { roundId = null, closesOn = "", contact = "" } = {}, env = process.env) {
  const c = graphConfig(env);
  const already = deliveredTokens(roundId);
  const byCentre = new Map();
  let queued = 0, alreadyDelivered = 0, unsendable = 0;
  for (const row of (rows || [])) {
    const mail = survey.invitationEmail({ centre: row.centre, link: row.link, closesOn, contact });
    let ok = true;
    try { sendMailBody({ to: row.email, subject: mail.subject, body: mail.body }); } catch { ok = false; }
    const centre = row.centre || survey.NO_CENTRE_LABEL;
    const e = byCentre.get(centre) || { centre, total: 0, queued: 0, delivered: 0, unsendable: 0 };
    e.total += 1;
    if (!ok) { e.unsendable += 1; unsendable += 1; }
    else if (already.has(row.token)) { e.delivered += 1; alreadyDelivered += 1; }
    else { e.queued += 1; queued += 1; }
    byCentre.set(centre, e);
  }
  const avail = graphAvailability(env);
  return {
    sender: c.sender, available: avail.available, reason: avail.reason,
    total: (rows || []).length, queued, alreadyDelivered, unsendable,
    centres: [...byCentre.values()].sort((a, b) => a.centre.localeCompare(b.centre)),
    ratePerMinute: MESSAGES_PER_MINUTE,
    minutes: Math.ceil((queued * SEND_INTERVAL_MS) / 60000),
  };
}

// ---- Test send ------------------------------------------------------------------------------------
// One real message to a nominated address, so the owner can watch it land in a real inbox — SPF, DKIM,
// the from address, how it reads on a phone — before 221 go out. It carries the SAMPLE link, not a real
// invitation: a test must not spend a staff member's token. Nothing is recorded; it is not part of the
// round, and the address goes to Graph and nowhere else.
async function graphSendTest(to, { baseUrl = "", centre = "Early Learning", closesOn = "", contact = "" } = {}, env = process.env) {
  const avail = graphAvailability(env);
  if (!avail.available) throw new Error(avail.reason);
  const address = String(to || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error("Enter the address to send the test to.");
  const mail = survey.invitationEmail({ centre, link: survey.linkFor(baseUrl, TEST_LINK_TOKEN), closesOn, contact });
  await graphSend({ to: address, subject: mail.subject, body: mail.body }, env);
  return { ok: true, centre, sender: graphConfig(env).sender };
}

// The senders an admin page should offer, in the order it should offer them.
function senders(env = process.env) {
  const graph = graphAvailability(env);
  return [
    { key: "export", label: "Mail-merge export (CSV for Outlook)", available: true,
      reason: "Downloads one row per active staff member: address, centre and magic link. Nothing is stored." },
    { key: "graph", label: "Send from a Futuro mailbox (Microsoft Graph)", available: graph.available, reason: graph.reason },
  ];
}

module.exports = {
  MESSAGES_PER_MINUTE, SEND_INTERVAL_MS, TOKEN_SAFETY_MS, MAX_ATTEMPTS, FALLBACK_RETRY_MS, TEST_LINK_TOKEN,
  senders, graphAvailability, graphConfig, sendMailBody, redact,
  graphToken, resetGraphToken, graphSend, graphSendRound, graphDryRun, graphSendTest,
  deliveredTokens, recordDelivery, deliveryCounts, SendFailure,
};
