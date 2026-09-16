// How a survey invitation actually leaves the building. Two implementations behind one small interface,
// because the owner asked for email and this must not sit blocked on someone else's IT:
//
//   1. MAIL MERGE EXPORT — works today, needs nobody's permission. An admin downloads a CSV of address +
//      magic link + centre and mail-merges it from Outlook. The addresses are read from payroll to write
//      the file and are never stored.
//   2. MICROSOFT GRAPH — Futuro is a Microsoft tenant, so Graph sends from a real Futuro mailbox with no
//      new vendor and no new address for staff to distrust. It needs an app registration with the
//      Mail.Send application permission and a tenant admin's consent, which is why it is behind
//      environment variables and why its absence is not an error: with the variables unset the admin page
//      offers the export and says, in one line, what is missing.
//
// A sender is only ever handed one address at a time, and only from the export rows, which are built and
// discarded inside a single request. Nothing here writes an address anywhere.
const survey = require("./survey");

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const GRAPH_BASE = (process.env.GRAPH_BASE_URL || "https://graph.microsoft.com").replace(/\/+$/, "");
const LOGIN_BASE = (process.env.GRAPH_LOGIN_URL || "https://login.microsoftonline.com").replace(/\/+$/, "");

function graphConfig(env = process.env) {
  return {
    tenantId: (env.GRAPH_TENANT_ID || "").trim(),
    clientId: (env.GRAPH_CLIENT_ID || "").trim(),
    clientSecret: (env.GRAPH_CLIENT_SECRET || "").trim(),
    mailbox: (env.SURVEY_FROM_MAILBOX || "").trim(),
  };
}

// Is Graph usable, and if not, exactly what is missing. The page prints the reason rather than a bare
// "unavailable", so whoever has to raise it with IT knows what to ask for.
function graphAvailability(env = process.env) {
  const c = graphConfig(env);
  const missing = Object.entries({
    GRAPH_TENANT_ID: c.tenantId, GRAPH_CLIENT_ID: c.clientId,
    GRAPH_CLIENT_SECRET: c.clientSecret, SURVEY_FROM_MAILBOX: c.mailbox,
  }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    return { available: false, reason: `Microsoft Graph is not configured (${missing.join(", ")} not set). ` +
      "It needs an app registration with the Mail.Send application permission and a tenant admin's consent. " +
      "Until then, use the mail-merge export below — it sends exactly the same links." };
  }
  return { available: true, reason: `Sends from ${c.mailbox} via Microsoft Graph.` };
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

let tokenCache = null; // { token, expiresAt } — an app-only token lasts about an hour
async function graphToken(env = process.env, now = Date.now()) {
  if (tokenCache && tokenCache.expiresAt > now + 60000) return tokenCache.token;
  const c = graphConfig(env);
  const res = await fetch(`${LOGIN_BASE}/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, scope: GRAPH_SCOPE, grant_type: "client_credentials" }),
  });
  // Never log or surface the response body: it can echo the client secret back in an error.
  if (!res.ok) throw new Error(`Microsoft Graph refused the sign-in (${res.status}).`);
  const json = await res.json();
  if (!json || !json.access_token) throw new Error("Microsoft Graph returned no access token.");
  tokenCache = { token: json.access_token, expiresAt: now + (Number(json.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}
function resetGraphToken() { tokenCache = null; }

async function graphSend({ to, subject, body }, env = process.env) {
  const c = graphConfig(env);
  const token = await graphToken(env);
  const res = await fetch(`${GRAPH_BASE}/v1.0/users/${encodeURIComponent(c.mailbox)}/sendMail`, {
    method: "POST",
    signal: AbortSignal.timeout(45000),
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(sendMailBody({ to, subject, body })),
  });
  if (!res.ok) throw new Error(`Microsoft Graph refused the message (${res.status}).`); // no body: it quotes the recipient
  return { ok: true };
}

// Send a whole round. Serial and gently paced — a burst of 221 messages from a mailbox that has never
// sent one is the shape of a compromised account, and the tenant will throttle or quarantine it.
// A failure is counted, never retried blindly, and the address is never put in the log line.
async function graphSendRound(rows, { closesOn, contact, delayMs = 250, log = console.log } = {}, env = process.env) {
  const avail = graphAvailability(env);
  if (!avail.available) throw new Error(avail.reason);
  let sent = 0, failed = 0;
  for (const row of rows) {
    const mail = survey.invitationEmail({ centre: row.centre, link: row.link, closesOn, contact });
    try {
      await graphSend({ to: row.email, subject: mail.subject, body: mail.body }, env);
      sent += 1;
    } catch (e) {
      failed += 1;
      log(`[survey] one invitation could not be sent: ${e.message}`); // the message, never the recipient
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { sent, failed };
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

module.exports = { senders, graphAvailability, graphConfig, sendMailBody, graphSend, graphSendRound, graphToken, resetGraphToken };
