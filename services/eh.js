// Employment Hero Payroll (KeyPay) API client.
// Auth: HTTP Basic — API key as username, blank password. Base: https://api.yourpayroll.com.au
require("dotenv").config();

// Read at CALL time, not at module load.
//
// These four were consts evaluated once when the module was first required, which meant the credentials
// were frozen at boot. Rotating EH_PAYROLL_API_KEY in the Render dashboard then had no effect until the
// service happened to restart: the process carried on presenting the old key, and the only symptom was
// an EH 401 on the nightly run. Reading process.env per call costs a base64 of a short string and makes
// a rotated key take effect on the next request.
const base = () => (process.env.EH_PAYROLL_BASE_URL || "https://api.yourpayroll.com.au").replace(/\/$/, "");
const key = () => process.env.EH_PAYROLL_API_KEY || "";
const businessId = () => process.env.EH_PAYROLL_BUSINESS_ID || "";
const authHeader = () => "Basic " + Buffer.from(key() + ":").toString("base64");

function hasCreds() { return Boolean(key() && businessId()); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Locations, pay runs and the employee list barely change, but the timesheet screen needs all three
// on every preview. Cached briefly so opening the page twice does not rate-limit the whole app.
const CACHE_MS = 5 * 60 * 1000;
const _cache = new Map();
async function cached(cacheKey, fn) {
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fn();
  _cache.set(cacheKey, { at: Date.now(), value });
  return value;
}
function clearCache() { _cache.clear(); }

async function apiGet(path, query) {
  const url = new URL(base() + `/api/v2/business/${businessId()}` + path);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(45000), headers: { Authorization: authHeader(), Accept: "application/json" } });
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (res.ok) return body;
    // EH rate-limits (429) and throws transient 5xx. The timesheet screen needs several calls per
    // preview, so a couple of refreshes in a row used to 429 the whole app. Backing off costs a
    // second; failing costs the page.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(800 * 2 ** attempt); continue; }
    throw new Error(`EH ${res.status} ${path}`); // no response body: it may contain employee records
  }
}

// Fetch every page; fail rather than silently accepting a truncated/repeated response.
async function allPages(path) {
  const out = [], seen = new Set();
  for (let skip = 0; skip < 100000; ) {
    const page = await apiGet(path, { "$orderby": "id asc", "$top": 100, "$skip": skip });
    if (!Array.isArray(page)) throw new Error("EH returned an invalid list.");
    if (!page.length) return out;
    for (const row of page) {
      if (row.id == null || seen.has(String(row.id))) throw new Error("EH pagination was incomplete or repeated.");
      seen.add(String(row.id)); out.push(row);
    }
    skip += page.length;
  }
  throw new Error("EH pagination safety limit reached; no data saved.");
}

// Write/side-effecting calls. Kept separate from apiGet so every mutation is easy to audit.
// Unlike apiGet this DOES surface the response body on error — timesheet errors are field
// validation messages (no personal data), and we need them to debug a failed post.
async function apiSend(method, path, body) {
  const url = base() + `/api/v2/business/${businessId()}` + path;
  const opt = { method, signal: AbortSignal.timeout(45000), headers: { Authorization: authHeader(), Accept: "application/json" } };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, opt);
    const text = await res.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (res.ok) return parsed;
    // A 429 means EH rejected the call outright, so resending is safe. A 5xx may have half-applied,
    // so only DELETE — which is idempotent — is retried on one. A POST that might already have
    // created a timesheet is never resent: a duplicate in payroll is worse than an error on screen.
    const retryable = res.status === 429 || (res.status >= 500 && method === "DELETE");
    if (retryable && attempt < 3) { await sleep(800 * 2 ** attempt); continue; }
    throw new Error(`EH ${res.status} ${method} ${path}: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
}

const eh = {
  hasCreds,
  locations: () => apiGet("/location"),
  employees: (skip = 0) => apiGet("/employee", { "$top": 100, "$skip": skip }),
  allEmployees: () => allPages("/employee"),
  payRuns: () => allPages("/payrun"),
  // Cached variants, used by the timesheet screen which needs all three on every preview.
  locationsCached: () => cached("locations", () => apiGet("/location")),
  employeesCached: () => cached("employees", () => allPages("/employee")),
  payRunsCached: () => cached("payruns", () => allPages("/payrun")),
  clearCache,
  earnings: (runId) => apiGet(`/payrun/${encodeURIComponent(runId)}/earningslines`),
  runTotals: (runId) => apiGet(`/payrun/${encodeURIComponent(runId)}/totals`),
  // Pay-category detail per employee x location for a pay-date range.
  payCategoriesReport: (fromDate, toDate) => apiGet("/report/paycategories", { fromDate, toDate }),
  payRunActivity: (fromDate, toDate) => apiGet("/report/payrunactivity", { fromDate, toDate }),

  // --- Timesheets -------------------------------------------------------
  // The timesheet endpoint IGNORES fromDate/toDate params (they 500). It is OData-only.
  timesheetsBetween: (fromDate, toDate) => apiGet("/timesheet", {
    "$filter": `startTime ge datetime'${fromDate}T00:00:00' and startTime lt datetime'${toDate}T23:59:59'`,
    "$top": 2000,
  }),
  // Creates one timesheet line. Post status "Submitted" (draft, awaiting a director's approval).
  // NEVER post "Approved" — that puts hours straight into a pay run with no human check.
  createTimesheet: (line) => apiSend("POST", "/timesheet", line),
  deleteTimesheet: (id) => apiSend("DELETE", `/timesheet/${encodeURIComponent(id)}`),
};

module.exports = { eh, apiGet, apiSend, allPages };
