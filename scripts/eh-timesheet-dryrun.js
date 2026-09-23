#!/usr/bin/env node
/*
 * OWNA → Employment Hero timesheet sync — DRY RUN (read-only, sends NOTHING to payroll).
 *
 * Thin CLI over services/eh-timesheet.js (buildTimesheets). It:
 *   1. Reads OWNA clock events, pairs checkin→checkout into worked spans (split-shift aware),
 *      converting UTC → Australia/Sydney.
 *   2. Applies data-quality gates: drops <3min double-taps, QUARANTINES >12h missed-checkouts.
 *   3. Maps OWNA employeeCode → EH externalId (ftXXXXXX) and resolves the EH employee.
 *   4. Prints the timesheet lines it WOULD create — with NO break deducted (EH applies breaks
 *      automatically via its award rules), plus an idempotency key per line.
 *
 * Usage:
 *   node scripts/eh-timesheet-dryrun.js [centreOwnaId|all] [fromDate] [toDate]
 *   e.g. node scripts/eh-timesheet-dryrun.js all 2026-09-01 2026-09-05
 *        node scripts/eh-timesheet-dryrun.js all 2026-09-03           (single day)
 */
require("dotenv").config();
const path = require("path");
const m = require(path.join(__dirname, "..", "services", "metrics"));
const { eh } = require(path.join(__dirname, "..", "services", "eh"));
const ts = require(path.join(__dirname, "..", "services", "eh-timesheet"));

const shortName = (n) => (n || "").replace(/Futuro Childcare (and|&) Education\s*-?\s*/i, "").replace(/^Futuro\s+/, "").trim();
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

(async () => {
  const args = process.argv.slice(2);
  const centreArg = args.find((a) => a && a !== "all" && !isDate(a)) || null;
  const dateArgs = args.filter(isDate);
  const from = dateArgs[0] || "2026-09-03";
  const to = dateArgs[1] || from;

  const allCentres = m.centres().filter((c) => !c.opening && c.capacity > 0);
  const centres = centreArg ? allCentres.filter((c) => c.owna_id === centreArg) : allCentres;

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  OWNA → Employment Hero timesheets — DRY RUN (no data is written)  ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log(`Range: ${from}${to !== from ? " → " + to : ""}  ·  TZ: ${ts.TZ}  ·  Centres: ${centres.map((c) => shortName(c.name)).join(", ")}`);
  console.log(`Breaks: EH applies unpaid breaks automatically — this posts ACTUAL clock times, no deduction.\n`);

  if (!eh.hasCreds()) { console.log("EH credentials not set — cannot resolve EH employees."); return; }

  const { lines, quarantined, skipped, unmapped, issues, stats } = await ts.buildTimesheets({ centres, from, to });

  // Postable lines, grouped by centre.
  const byCentre = {};
  lines.forEach((l) => (byCentre[l.centre] ||= []).push(l));
  for (const c of centres) {
    const rows = byCentre[c.name] || [];
    console.log("──────────────────────────────────────────────────────────────────");
    console.log(`▶ ${shortName(c.name)}  (${rows.length} postable line${rows.length === 1 ? "" : "s"})`);
    rows.sort((a, b) => (a.payDate + a.startLocal).localeCompare(b.payDate + b.startLocal));
    for (const l of rows) {
      console.log(`  ${l.name.padEnd(22)} ${l.payDate}  ${l.startLocal}–${l.endLocal}  ${String(l.grossHours.toFixed(2)).padStart(5)}h  → EH ${l.externalId} (${l.ehName})`);
    }
  }

  const bang = (title, arr, fmt) => {
    if (!arr.length) return;
    console.log("\n──────────────────────────────────────────────────────────────────");
    console.log(title);
    arr.forEach((x) => console.log("  " + fmt(x)));
  };
  bang(`⚠ QUARANTINED — NOT posted, need human review (${quarantined.length}):`, quarantined,
    (x) => `${shortName(x.centre).padEnd(10)} ${x.name.padEnd(22)} ${x.payDate} ${x.startLocal}–${x.endLocal} ${x.grossHours}h — ${x.reason}`);
  bang(`✖ UNMAPPED — fill employeeCode in OWNA (${unmapped.length}):`, unmapped,
    (x) => `${shortName(x.centre).padEnd(10)} ${x.name.padEnd(22)} ${x.payDate} — ${x.reason}`);
  bang(`· Dropped as noise (${skipped.length}):`, skipped,
    (x) => `${shortName(x.centre).padEnd(10)} ${x.name.padEnd(22)} ${x.payDate} ${x.startLocal}–${x.endLocal} — ${x.reason}`);
  bang(`ℹ Pairing anomalies (${issues.length}):`, issues,
    (x) => `${shortName(x.centre).padEnd(10)} ${x.name.padEnd(22)} ${x.msg}`);

  console.log("\n──────────────────────────────────────────────────────────────────");
  console.log(`SUMMARY over ${stats.dates} day(s): ${stats.postable} postable · ${stats.quarantined} quarantined · ${stats.unmapped} unmapped · ${stats.skipped} dropped · ${stats.grossHours}h total (actual clocked).`);
  console.log("\nExact payload that WOULD be POSTed to EH (first postable line):");
  console.log(JSON.stringify(lines[0] ? ts.toPayload(lines[0]) : { note: "nothing postable for this range/centre" }, null, 2));
  console.log("\n*** DRY RUN — no request was sent to Employment Hero. ***");
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
