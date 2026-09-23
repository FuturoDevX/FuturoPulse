#!/usr/bin/env node
/*
 * OWNA ↔ Employment Hero staff-code RECONCILIATION worklist — READ-ONLY.
 *
 * Purpose: close the #1 sync blocker. To post a worked shift into EH we map
 *   OWNA staff.employeeCode  →  EH employee.externalId   (both are ftXXXXXX).
 * Where OWNA's employeeCode is blank the shift can't be mapped. This script
 * lists every active OWNA staff member missing a code and NAME-MATCHES them to
 * their EH employee so an admin can paste the ft-code into the OWNA staff record.
 *
 * It WRITES NOTHING to either system. OWNA has no staff write API, and we never
 * touch EH here. Output is a console table + a CSV worklist.
 *
 * IMPORTANT — pagination: OWNA list endpoints return { data, totalCount } and
 * page via take/skip, defaulting to ~10 rows. Fetching a single page (as the
 * first POC did) silently drops most staff and makes almost everyone look
 * "unmapped". Always walk every page — staffAll() below does this.
 *
 * Usage:
 *   node scripts/eh-timesheet-reconcile.js [centreOwnaId|all] [YYYY-MM-DD]
 *     centre : restrict to one centre by OWNA id (default: all active centres)
 *     date   : mark staff who worked a shift that day as PRIORITY (default: none)
 *
 * Name-match confidence (highest first):
 *   exact   — normalised "first surname" matches exactly one ACTIVE EH employee
 *   pref    — matches an EH employee's preferredName + surname
 *   middle  — matches ignoring a middle name on either side
 *   surname — unique ACTIVE EH employee with the same surname (first name differs)
 *   review  — 0 or >1 plausible matches; a human must decide (never auto-fill)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const m = require(path.join(__dirname, "..", "services", "metrics"));
const { eh } = require(path.join(__dirname, "..", "services", "eh"));

const OBASE = (process.env.OWNA_BASE_URL || "https://api.owna.com.au").replace(/\/$/, "");
const OKEY = process.env.OWNA_API_KEY || "";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
const dropMiddle = (n) => { const p = norm(n).split(" "); return p.length >= 3 ? p[0] + " " + p[p.length - 1] : norm(n); };
const shortName = (n) => (n || "").replace(/Futuro Childcare (and|&) Education\s*-?\s*/i, "").replace(/^Futuro\s+/, "").trim();

// Human-confirmed name aliases where OWNA and EH legitimately differ (e.g. name change).
// Keyed by normalised OWNA "first surname" → EH externalId. Confirmed with the user.
const CONFIRMED_ALIAS = {
  "rachel brazel": "ft000088", // → Rachel Sertlioglu (name change), confirmed 2026-09-04
};

// Non-payroll OWNA logins (kiosk/admin/recruitment/support) — never get a timesheet, so exclude from the fill list.
const SYSTEM_ACCOUNT = /\b(app support|accounts admin|recruitment|support|kiosk|test|demo|reception|admin\d*)\b/i;
const isSystemAccount = (name) => SYSTEM_ACCOUNT.test(name) || norm(name).split(" ").length < 2;

// Levenshtein distance (small strings) for near-miss name spellings, e.g. "Siddiq" vs "Sidiq".
function lev(a, b) {
  a = norm(a); b = norm(b);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

async function oget(p) {
  const r = await fetch(OBASE + p, { headers: { "x-api-key": OKEY, Accept: "application/json" } });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
  if (!r.ok) throw new Error(`OWNA ${r.status} ${p}: ${String(JSON.stringify(b)).slice(0, 160)}`);
  return Array.isArray(b) ? { rows: b, total: b.length } : { rows: (b && b.data) || [], total: (b && b.totalCount) ?? ((b && b.data) || []).length };
}

// Walk EVERY page of a paginated OWNA list endpoint (the fix for the page-1 truncation bug).
async function staffAll(centreId) {
  const out = []; let skip = 0;
  for (;;) {
    const { rows, total } = await oget(`/api/staff/${centreId}/list?take=500&skip=${skip}`);
    out.push(...rows); skip += rows.length;
    if (!rows.length || skip >= total) break;
    if (skip > 50000) break; // safety
  }
  return out;
}

// Build EH lookup indexes once.
function ehIndexes(emps) {
  const active = emps.filter((e) => e.status === "Active");
  const byFull = new Map();     // "first surname" -> [emp]
  const byPref = new Map();     // "preferred surname" -> [emp]
  const byMiddle = new Map();   // first+surname ignoring middle -> [emp]
  const bySurname = new Map();  // surname -> [active emp]
  const push = (map, key, e) => { if (!key) return; (map.get(key) || map.set(key, []).get(key)).push(e); };
  for (const e of emps) {
    push(byFull, norm(`${e.firstName} ${e.surname}`), e);
    push(byMiddle, dropMiddle(`${e.firstName} ${e.middleName || ""} ${e.surname}`), e);
    if (e.preferredName) push(byPref, norm(`${e.preferredName} ${e.surname}`), e);
  }
  for (const e of active) push(bySurname, norm(e.surname), e);
  return { byFull, byPref, byMiddle, bySurname, active };
}

// Resolve one OWNA name to an EH ft-code with a confidence label.
function matchEmp(name, ix) {
  const key = norm(name);
  const aliasCode = CONFIRMED_ALIAS[key];
  if (aliasCode) { const e = ix.active.find((x) => String(x.externalId).toLowerCase() === aliasCode.toLowerCase()); if (e) return { emp: e, conf: "alias" }; }
  const activeOnly = (arr) => (arr || []).filter((e) => e.status === "Active");
  const one = (arr, conf) => { const a = activeOnly(arr); if (a.length === 1) return { emp: a[0], conf }; return null; };

  const strong = one(ix.byFull.get(key), "exact")
    || one(ix.byPref.get(key), "pref")
    || one(ix.byMiddle.get(dropMiddle(name)), "middle")
    || one(ix.bySurname.get(norm(name.split(" ").slice(1).join(" "))), "surname");
  if (strong) return strong;

  // Fuzzy: closest ACTIVE full name within edit-distance 2, and clearly nearest (beats runner-up by ≥2).
  const scored = ix.active.map((e) => ({ e, d: lev(name, `${e.firstName} ${e.surname}`) })).sort((a, b) => a.d - b.d);
  if (scored.length && scored[0].d <= 2 && (scored.length < 2 || scored[1].d - scored[0].d >= 2)) {
    return { emp: scored[0].e, conf: "fuzzy" };
  }
  return { emp: null, conf: "review", candidates: dedupeCandidates(name, ix) };
}

// For review rows, surface the plausible EH people so a human can choose fast.
function dedupeCandidates(name, ix) {
  const key = norm(name), sn = norm(name.split(" ").slice(1).join(" "));
  const set = new Map();
  [...(ix.byFull.get(key) || []), ...(ix.byPref.get(key) || []), ...(ix.byMiddle.get(dropMiddle(name)) || []), ...(ix.bySurname.get(sn) || [])]
    .forEach((e) => set.set(e.id, e));
  return [...set.values()];
}

(async () => {
  const arg1 = process.argv[2], arg2 = process.argv[3];
  const DATE = /^\d{4}-\d{2}-\d{2}$/.test(arg2 || arg1) ? (arg2 || arg1) : null;
  const centreArg = (arg1 && arg1 !== "all" && !/^\d{4}-/.test(arg1)) ? arg1 : null;

  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  OWNA ↔ Employment Hero code reconciliation — READ-ONLY worklist        ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  if (!eh.hasCreds()) { console.log("EH credentials not set — cannot resolve EH employees."); return; }

  const emps = await eh.allEmployees();
  const ix = ehIndexes(emps);
  console.log(`EH employees: ${emps.length} (${emps.filter((e) => e.status === "Active").length} active).`);

  let centres = m.centres().filter((c) => !c.opening && c.capacity > 0);
  if (centreArg) centres = centres.filter((c) => c.owna_id === centreArg);
  console.log(`Centres: ${centres.map((c) => shortName(c.name)).join(", ")}` + (DATE ? `  ·  priority date: ${DATE}` : "") + "\n");

  const rows = [];
  for (const c of centres) {
    const cn = shortName(c.name);
    const staff = await staffAll(c.owna_id);
    const active = staff.filter((s) => !s.inactive);
    const missing = active.filter((s) => !(s.employeeCode || "").trim());

    // Optionally flag who actually worked a shift on DATE (operational priority).
    let workedIds = new Set();
    if (DATE) {
      const { rows: log } = await oget(`/api/staff/log/${c.owna_id}/${DATE}`);
      log.filter((r) => /centre\s*check/i.test(r.status)).forEach((r) => workedIds.add(String(r.staffId)));
    }

    console.log(`▶ ${cn}: ${staff.length} staff · ${active.length} active · ${missing.length} missing employeeCode`);
    for (const s of missing) {
      const name = [s.firstname, s.surname].filter(Boolean).join(" ").trim();
      const worked = DATE && workedIds.has(String(s.id));
      if (isSystemAccount(name) && !worked) continue; // skip kiosk/admin/support logins that never work a shift
      const { emp, conf, candidates } = matchEmp(name, ix);
      rows.push({
        centre: cn,
        ownaName: name,
        ownaStaffId: s.id,
        worked: worked ? "yes" : "",
        ftCode: emp ? emp.externalId : "",
        confidence: isSystemAccount(name) ? "system" : conf,
        ehName: emp ? [emp.firstName, emp.surname].filter(Boolean).join(" ") : "",
        note: isSystemAccount(name) ? "likely non-payroll login — confirm" : (emp ? "" : (candidates && candidates.length ? "candidates: " + candidates.map((e) => `${e.firstName} ${e.surname} [${e.externalId}/${e.status}]`).join("; ") : "NO EH name match")),
      });
    }
  }

  // Sort: priority (worked) first, then needs-review, then centre/name.
  const confRank = { exact: 0, pref: 1, middle: 2, surname: 3, review: 9 };
  rows.sort((a, b) => (b.worked ? 1 : 0) - (a.worked ? 1 : 0) || (a.confidence === "review" ? -1 : 0) - (b.confidence === "review" ? -1 : 0) || a.centre.localeCompare(b.centre) || a.ownaName.localeCompare(b.ownaName));

  console.log("\n──────────────────────────────────────────────────────────────────────");
  console.log("WORKLIST (fill the ft-code into the OWNA staff record — Employee Code field):\n");
  console.log(["worked", "centre", "OWNA name", "→ ft-code", "conf", "note"].map((h, i) => h.padEnd([7, 16, 24, 12, 8, 0][i])).join(""));
  for (const r of rows) {
    console.log([
      (r.worked ? "★" : "").padEnd(7),
      r.centre.padEnd(16),
      r.ownaName.padEnd(24),
      (r.ftCode ? "→ " + r.ftCode : "→ ?").padEnd(12),
      r.confidence.padEnd(8),
      r.note,
    ].join(""));
  }

  const strong = rows.filter((r) => r.ftCode && ["exact", "pref", "middle", "surname", "alias"].includes(r.confidence)).length;
  const fuzzy = rows.filter((r) => r.confidence === "fuzzy").length;
  const review = rows.filter((r) => r.confidence === "review").length;
  const system = rows.filter((r) => r.confidence === "system").length;
  const workedRows = rows.filter((r) => r.worked);
  console.log(`\nSUMMARY: ${rows.length} rows · ${strong} strong match · ${fuzzy} fuzzy (verify) · ${review} need human review · ${system} likely non-payroll`);
  if (DATE) {
    const wStrong = workedRows.filter((r) => r.ftCode).length;
    console.log(`PRIORITY (worked ${DATE}): ${workedRows.length} staff blocked from posting · ${wStrong} have a suggested ft-code · ${workedRows.length - wStrong} need a decision`);
  }

  // Write CSV worklist.
  const outDir = process.env.RECON_OUT_DIR || path.join(__dirname, "..", "data");
  const stamp = new Date().toISOString().slice(0, 10);
  const csvPath = path.join(outDir, `owna-eh-reconcile-${stamp}.csv`);
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const header = ["centre", "owna_name", "owna_staff_id", "worked_on_date", "suggested_ft_code", "confidence", "eh_name", "note"];
  const csv = [header.join(",")].concat(rows.map((r) => [r.centre, r.ownaName, r.ownaStaffId, r.worked, r.ftCode, r.confidence, r.ehName, r.note].map(esc).join(","))).join("\n");
  try { fs.writeFileSync(csvPath, csv); console.log(`\nCSV worklist written: ${csvPath}`); } catch (e) { console.log(`\n(could not write CSV: ${e.message})`); }

  console.log("\n*** READ-ONLY — nothing was written to OWNA or Employment Hero. ***");
  console.log("Review 'review'-confidence rows by hand before filling. High-confidence rows still merit a spot-check.");
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
