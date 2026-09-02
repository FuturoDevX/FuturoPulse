// LineLeader (ChildcareCRM) Enroll API client.
// Docs: https://apidocs.childcarecrm.com/ · API under /api/v3
// Auth: JWT. POST /login (service-account username/password) -> token (1h) + refresh_token (72h).
// Paging: max 100/page via limit + offset; total row count is in the X-Total-Count response header.
require("dotenv").config();

const BASE = (process.env.LINELEADER_BASE_URL || "https://live.childcarecrm.com.au").replace(/\/$/, "");
const USER = process.env.LINELEADER_USERNAME || "";
const PASS = process.env.LINELEADER_PASSWORD || "";
const PAGE = 100; // API hard cap

let _token = null;
let _tokenAt = 0; // epoch ms
const TOKEN_TTL = 55 * 60 * 1000; // refresh a little before the 1h expiry

function hasCreds() { return Boolean(USER && PASS); }

async function login() {
  const res = await fetch(BASE + "/api/v3/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // disable_business_rules keeps a read-only warehouse pull from triggering
    // automated tasks/emails on LineLeader's side.
    body: JSON.stringify({ username: USER, password: PASS, disable_business_rules: true }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LineLeader login ${res.status}: ${t.slice(0, 200)}`);
  }
  const body = await res.json();
  _token = body.token;
  _tokenAt = Date.now();
  return _token;
}

async function token() {
  if (_token && Date.now() - _tokenAt < TOKEN_TTL) return _token;
  return login();
}

async function apiGet(path, { query } = {}) {
  const url = new URL(BASE + (path.startsWith("/api/") ? path : "/api/v3" + path));
  if (query) for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k + "[]", x));
    else if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  let tok = await token();
  let res = await fetch(url, { headers: { Authorization: "Bearer " + tok, Accept: "application/json" } });
  if (res.status === 401) { // token expired/rotated — re-login once
    tok = await login();
    res = await fetch(url, { headers: { Authorization: "Bearer " + tok, Accept: "application/json" } });
  }
  const total = parseInt(res.headers.get("x-total-count") || "0", 10);
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`LineLeader ${res.status} ${url.pathname}: ${JSON.stringify(body).slice(0, 200)}`);
  return { body, total };
}

// Return just the X-Total-Count for a query (cheap: limit=1, no need to read rows).
async function count(path, query = {}) {
  const { total } = await apiGet(path, { query: { ...query, limit: 1, offset: 0 } });
  return total;
}

// Walk a list endpoint fully.
async function getAll(path, query = {}) {
  const out = [];
  let offset = 0;
  for (;;) {
    const { body, total } = await apiGet(path, { query: { ...query, limit: PAGE, offset } });
    const rows = Array.isArray(body) ? body : (body && (body.data || body.items)) || [];
    out.push(...rows);
    offset += rows.length;
    if (rows.length === 0 || offset >= total) break;
    if (offset > 100000) break;
  }
  return out;
}

const lineleader = {
  hasCreds,
  centres: () => getAll("/centers", { include_inactive: true }),
  statuses: () => getAll("/statuses"),
  // Count of families in a given status (optionally scoped to a centre).
  familyCount: (statusId, centerId) =>
    count("/families", centerId ? { "status_ids": [statusId], center_id: centerId } : { "status_ids": [statusId] }),
  // Enrolments started / withdrawn within a window (ISO datetimes).
  enrolmentsStarted: (fromISO, toISO, centerIds) =>
    getAll("/enrollments", { start_after_date: fromISO, start_before_date: toISO, ...(centerIds ? { center_ids: centerIds } : {}) }),
  enrolmentsWithdrawn: (fromISO, toISO, centerIds) =>
    getAll("/enrollments", { withdrawn_after_date: fromISO, withdrawn_before_date: toISO, ...(centerIds ? { center_ids: centerIds } : {}) }),
  withdrawnReasonTypes: () => getAll("/types/reasons/withdrawn"),
  // Child-level enrolment records currently in given pipeline statuses.
  enrolmentsByStatus: (statusIds) => getAll("/enrollments", { "status_ids": statusIds }),
  // Tasks of a given type (e.g. 89 = Tour, 758 = Orientation Day).
  tasksOfType: (typeId) => getAll("/tasks", { type: typeId }),
};

module.exports = { lineleader, apiGet, getAll, count };
