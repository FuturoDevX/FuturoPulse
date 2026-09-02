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
  const res = await fetch(url, { headers: { Authorization: AUTH, Accept: "application/json" } });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`EH ${res.status} ${path}: ${JSON.stringify(body).slice(0, 160)}`);
  return body;
}

const eh = {
  hasCreds,
  locations: () => apiGet("/location"),
  employees: (skip = 0) => apiGet("/employee", { "$top": 100, "$skip": skip }),
  async allEmployees() {
    const out = []; let skip = 0;
    for (;;) { const page = await this.employees(skip); if (!Array.isArray(page) || !page.length) break; out.push(...page); skip += page.length; if (page.length < 100 || skip > 5000) break; }
    return out;
  },
  payRuns: () => apiGet("/payrun", { "$orderby": "datePaid desc", "$top": 30 }),
  // Pay-category detail per employee x location for a pay-date range.
  payCategoriesReport: (fromDate, toDate) => apiGet("/report/paycategories", { fromDate, toDate }),
  payRunActivity: (fromDate, toDate) => apiGet("/report/payrunactivity", { fromDate, toDate }),
};

module.exports = { eh, apiGet };
