// Employment Hero Payroll (KeyPay) API client.
// Auth: HTTP Basic — API key as username, blank password. Base: https://api.yourpayroll.com.au
require("dotenv").config();

const BASE = (process.env.EH_PAYROLL_BASE_URL || "https://api.yourpayroll.com.au").replace(/\/$/, "");
const KEY = process.env.EH_PAYROLL_API_KEY || "";
const BID = process.env.EH_PAYROLL_BUSINESS_ID || "";
const AUTH = "Basic " + Buffer.from(KEY + ":").toString("base64");

function hasCreds() { return Boolean(KEY && BID); }

async function apiGet(path, query) {
  const url = new URL(BASE + `/api/v2/business/${BID}` + path);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(45000), headers: { Authorization: AUTH, Accept: "application/json" } });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`EH ${res.status} ${path}`); // no response body: it may contain employee records
  return body;
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

const eh = {
  hasCreds,
  locations: () => apiGet("/location"),
  employees: (skip = 0) => apiGet("/employee", { "$top": 100, "$skip": skip }),
  allEmployees: () => allPages("/employee"),
  payRuns: () => allPages("/payrun"),
  earnings: (runId) => apiGet(`/payrun/${encodeURIComponent(runId)}/earningslines`),
  runTotals: (runId) => apiGet(`/payrun/${encodeURIComponent(runId)}/totals`),
  // Pay-category detail per employee x location for a pay-date range.
  payCategoriesReport: (fromDate, toDate) => apiGet("/report/paycategories", { fromDate, toDate }),
  payRunActivity: (fromDate, toDate) => apiGet("/report/payrunactivity", { fromDate, toDate }),
};

module.exports = { eh, apiGet, allPages };
