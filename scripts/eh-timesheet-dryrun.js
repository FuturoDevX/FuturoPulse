#!/usr/bin/env node
/*
 * OWNA → Employment Hero timesheet sync — DRY RUN (read-only, sends NOTHING to payroll).
 *
 * What it does:
 *   1. Reads OWNA staff clock events  GET /api/staff/log/{centreId}/{date}
 *   2. Keeps only "centre checkin"/"centre checkout" (ignores "signin" kiosk noise),
 *      pairs them per staff → worked spans (handles split shifts).
 *   3. Converts UTC → Australia/Sydney, applies an unpaid-break rule.
 *   4. Maps OWNA employeeCode  →  EH externalId (ftXXXXXX), resolves the EH employee.
 *   5. Prints the timesheet lines it WOULD create in EH, and flags anything unmapped.
 *
 * Usage:
 *   node scripts/eh-timesheet-dryrun.js [centreOwnaId|all] [YYYY-MM-DD]
 *   (defaults: first active centre, 2026-09-03)
 *
 * Break rule (edit BREAK_RULE below to match your award/policy):
 *   >= 8h  → 45 min unpaid, >= 5h → 30 min unpaid, else 0.
 */
require("dotenv").config();
const path = require("path");
const m = require(path.join(__dirname, "..", "services", "metrics"));
const { eh } = require(path.join(__dirname, "..", "services", "eh"));

const OBASE = (process.env.OWNA_BASE_URL || "https://api.owna.com.au").replace(/\/$/, "");
const OKEY = process.env.OWNA_API_KEY || "";
const TZ = "Australia/Sydney";

const BREAK_RULE = (grossMins) => (grossMins >= 8 * 60 ? 45 : grossMins >= 5 * 60 ? 30 : 0);

async function oget(p) {
  const r = await fetch(OBASE + p, { headers: { "x-api-key": OKEY, Accept: "application/json" } });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
  if (!r.ok) throw new Error(`OWNA ${r.status} ${p}: ${String(JSON.stringify(b)).slice(0, 160)}`);
  return Array.isArray(b) ? b : (b && b.data) || [];
}

const fmtTime = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const fmtDate = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const localTime = (iso) => fmtTime.format(new Date(iso));
const localDate = (iso) => fmtDate.format(new Date(iso));
const isIn = (s) => /checkin/i.test(s);
const isOut = (s) => /checkout/i.test(s);

// Pair a staff member's sorted checkin/checkout events into worked spans.
function pairSpans(events) {
  const evs = events.filter((e) => /centre\s*check/i.test(e.status))
    .sort((a, b) => new Date(a.statusDate) - new Date(b.statusDate));
  const spans = []; const issues = [];
  let open = null;
  for (const e of evs) {
    if (isIn(e.status)) { if (open) issues.push(`double check-in at ${localTime(open.statusDate)} then ${localTime(e.statusDate)}`); open = e; }
    else if (isOut(e.status)) {
      if (!open) { issues.push(`check-out at ${localTime(e.statusDate)} with no matching check-in`); continue; }
      spans.push({ in: open.statusDate, out: e.statusDate }); open = null;
    }
  }
  if (open) issues.push(`check-in at ${localTime(open.statusDate)} never checked out (still on shift or missed tap)`);
  return { spans, issues };
}

(async () => {
  const arg1 = process.argv[2], arg2 = process.argv[3];
  const DATE = /^\d{4}-\d{2}-\d{2}$/.test(arg2 || arg1) ? (arg2 || arg1) : "2026-09-03";
  const allCentres = m.centres().filter((c) => !c.opening && c.capacity > 0);
  const centres = (arg1 && arg1 !== "all" && !/^\d{4}-/.test(arg1)) ? allCentres.filter((c) => c.owna_id === arg1) : allCentres;
  const shortName = (n) => (n || "").replace(/Futuro Childcare (and|&) Education\s*-?\s*/i, "").replace(/^Futuro\s+/, "").trim();

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  OWNA → Employment Hero timesheets — DRY RUN (no data is written)  ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log(`Date: ${DATE}  ·  Timezone: ${TZ}  ·  Centres: ${centres.map((c) => shortName(c.name)).join(", ")}\n`);

  if (!eh.hasCreds()) { console.log("EH credentials not set — cannot resolve EH employees."); return; }
  // EH index by externalId (lowercased).
  const emps = await eh.allEmployees();
  const ehByExt = new Map();
  emps.forEach((e) => { if (e.externalId) ehByExt.set(String(e.externalId).trim().toLowerCase(), e); });

  let created = 0, unmapped = 0, totalNet = 0;
  const wouldPost = [];

  for (const c of centres) {
    console.log("──────────────────────────────────────────────────────────────────");
    console.log(`▶ ${shortName(c.name)}`);
    const staff = await oget(`/api/staff/${c.owna_id}/list`);
    const staffById = new Map(staff.map((s) => [s.id, s]));
    const log = await oget(`/api/staff/log/${c.owna_id}/${DATE}`);
    const byStaff = {}; log.forEach((r) => { (byStaff[r.staffId] ||= []).push(r); });

    const ids = Object.keys(byStaff);
    if (!ids.length) { console.log("  (no clock events)\n"); continue; }

    for (const sid of ids) {
      const s = staffById.get(sid) || {};
      const name = [s.firstname, s.surname].filter(Boolean).join(" ") || byStaff[sid][0].staffName || "(unknown)";
      const { spans, issues } = pairSpans(byStaff[sid]);
      if (!spans.length && !issues.length) continue; // only "signin" noise, no shift

      const code = (s.employeeCode || "").trim();
      const ehEmp = code ? ehByExt.get(code.toLowerCase()) : null;
      const mapLabel = !code ? "⚠ no employeeCode in OWNA"
        : !ehEmp ? `⚠ code ${code} not found in EH`
        : `→ EH ${ehEmp.externalId} (${[ehEmp.firstName, ehEmp.surname].filter(Boolean).join(" ")})`;

      for (const sp of spans) {
        const grossMins = Math.round((new Date(sp.out) - new Date(sp.in)) / 60000);
        const brk = BREAK_RULE(grossMins);
        const netMins = Math.max(0, grossMins - brk);
        totalNet += netMins;
        const payDate = localDate(sp.in);
        const startL = localTime(sp.in), endL = localTime(sp.out);
        const row = `  ${name.padEnd(22)} ${payDate}  ${startL}–${endL}  gross ${(grossMins / 60).toFixed(2)}h  −${brk}m brk  = ${(netMins / 60).toFixed(2)}h  ${mapLabel}`;
        console.log(row);
        if (ehEmp) {
          created++;
          wouldPost.push({
            endpoint: `POST /api/v2/business/${process.env.EH_PAYROLL_BUSINESS_ID}/timesheet`,
            employeeId: ehEmp.id, externalId: ehEmp.externalId, employee: [ehEmp.firstName, ehEmp.surname].filter(Boolean).join(" "),
            date: payDate, startTime: `${payDate}T${startL}:00`, endTime: `${payDate}T${endL}:00`,
            breaks: brk ? [{ minutes: brk, paid: false }] : [],
            netHours: +(netMins / 60).toFixed(2),
            locationName: shortName(c.name), status: "Submitted (draft — for approval)",
          });
        } else unmapped++;
      }
      issues.forEach((i) => console.log(`     ⚠ ${name}: ${i}`));
    }
    console.log("");
  }

  console.log("──────────────────────────────────────────────────────────────────");
  console.log(`SUMMARY: ${created} timesheet line(s) ready to create · ${unmapped} unmapped (need employeeCode) · ${(totalNet / 60).toFixed(1)}h total net`);
  console.log("\nExample of the EXACT payload that WOULD be POSTed to EH (first mapped line):");
  console.log(JSON.stringify(wouldPost[0] || { note: "nothing mapped for this date/centre" }, null, 2));
  console.log("\n*** DRY RUN — no request was sent to Employment Hero. ***");
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
