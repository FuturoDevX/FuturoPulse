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

async function apiGet(path, { query } = {}) {
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
