// OWNA Childcare Portal API client.
// Docs: https://api.owna.com.au/swagger/index.html
// Auth: single API key sent as the "x-api-key" header.
//
// List endpoints return { data: [...], totalCount, errors } and page via take/skip.
// Attendance additionally REQUIRES a `sort` query param (bare field name, e.g. "attendanceDate").
require("dotenv").config();

const BASE = (process.env.OWNA_BASE_URL || "https://api.owna.com.au").replace(/\/$/, "");
const KEY = (process.env.OWNA_API_KEY || "").trim();
const PAGE = 500; // rows per page when walking a list endpoint

if (!KEY) {
  console.warn("[owna] OWNA_API_KEY is not set — API calls will fail. Fill it into .env.");
}

// Futuro runs a DNS-filtering agent on the machine itself (the resolver is 127.0.0.1), and it decides
// per lookup. Even with api.owna.com.au allow-listed the verdict flaps: a single probe succeeds five
// times out of five, then the next minute the same call is intercepted. A nightly snapshot makes several
// hundred calls, so it will meet a blocked moment almost every run — and one was enough to kill it.
//
// Two shapes to survive, both transient and both worth retrying:
//   · the interception itself, which fails the TLS handshake (UNABLE_TO_VERIFY_LEAF_SIGNATURE) because
//     the agent presents its own certificate and Node ships its own CA list
//   · the block page, HTTP 200 with a "Website Filtered" body
// A 4xx from OWNA is NOT retried — that is OWNA answering, and asking again will not change its mind.
const RETRIES = Number(process.env.OWNA_RETRIES || 4);
const RETRY_BASE_MS = Number(process.env.OWNA_RETRY_MS || 1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function transient(e) {
  if (e && e.notJson && e.filtered) return true;
  const code = (e && e.cause && e.cause.code) || (e && e.code) || "";
  return /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED|CERT_|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(String(code))
    || /fetch failed/i.test(String(e && e.message));
}

async function apiGet(path, opts = {}) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try { return await apiGetOnce(path, opts); }
    catch (e) {
      last = e;
      if (!transient(e) || attempt === RETRIES) throw e;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt));   // 1.5s, 3s, 6s, 12s
    }
  }
  throw last;
}

async function apiGetOnce(path, { query } = {}) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { "x-api-key": KEY, Accept: "application/json" } });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = undefined; }
  if (!res.ok) {
    // Status + path only. Never include the response body — it may contain children's or staff records.
    const err = new Error(`OWNA ${res.status} ${path}`);
    err.status = res.status;
    throw err;
  }
  // A 200 is not the same as an answer. Futuro's network runs a DNS filter that intercepts this host and
  // serves its own block page — HTTP 200, content-type text/html, a 515-byte "Website Filtered" document.
  // This used to be caught by JSON.parse and then handed back as a STRING, which getAll() read as "no
  // rows": every pull returned zero, the nightly run recorded itself as ok, and the feed was dead for
  // eight days before anyone noticed. A response that is not JSON is a failure, and says which host did it.
  if (body === undefined) {
    const ct = res.headers.get("content-type") || "no content-type";
    const filtered = /dnsfilter|website filtered|blocked/i.test(text);
    const err = new Error(
      `OWNA ${path}: expected JSON, got ${ct}` +
      (filtered ? " — this looks like a network filter's block page, not OWNA. The host is being intercepted." : "")
    );
    err.status = res.status;
    err.notJson = true;
    err.filtered = filtered;
    throw err;
  }
  return body;
}

// Walk a paginated list endpoint until every row is collected.
async function getAll(path, { query } = {}) {
  const out = [];
  let skip = 0;
  for (;;) {
    const q = { take: PAGE, skip, ...query };
    const body = await apiGet(path, { query: q });
    const rows = Array.isArray(body) ? body : (body && body.data) || [];
    out.push(...rows);
    const total = body && typeof body.totalCount === "number" ? body.totalCount : rows.length;
    skip += rows.length;
    if (rows.length === 0 || skip >= total) break;
    if (skip > 200000) break; // hard safety stop
  }
  return out;
}

// Dates: OWNA path params are date-times; a plain YYYY-MM-DD works.
const fmtDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

const owna = {
  hasKey: () => Boolean(KEY),

  async listCentres() {
    return getAll("/api/centre/list");
  },

  async listRooms(centreId) {
    return getAll(`/api/room/${centreId}/list`);
  },

  // All children for a centre (active, finished, upcoming) — carries finishDate/activeFrom.
  async listChildren(centreId) {
    return getAll(`/api/children/${centreId}/list`);
  },

  // Child incident reports for a centre + date range.
  async childIncidents(centreId, from, to) {
    return getAll(`/api/children/incident/${centreId}/${fmtDate(from)}/${fmtDate(to)}`);
  },

  // Booked child-days with fee + attendance + casual flags.
  async attendance(centreId, from, to) {
    return getAll(`/api/attendance/${centreId}/${fmtDate(from)}/${fmtDate(to)}`, {
      query: { sort: "attendanceDate" },
    });
  },

  // CCS subsidy payments clearing in the window.
  async ccsPayments(centreId, from, to) {
    return getAll(`/api/ccs/payments/${centreId}/${fmtDate(from)}/${fmtDate(to)}/list`);
  },

  // Weekly staff roster (weekStarting = Monday, YYYY-MM-DD). Returns the week's roster doc, or null.
  // Shape: { weekstarting, monday..sunday: [shift...], rosteredhours: [{<day>: hours, hoursperbooking}], leave, comments }
  async weeklyRoster(centreId, weekStarting) {
    const body = await apiGet(`/api/roster/${centreId}/${fmtDate(weekStarting)}`);
    const rows = Array.isArray(body) ? body : (body && body.data) || [];
    return rows[0] || null;
  },
};

module.exports = { owna, apiGet, getAll, fmtDate };
