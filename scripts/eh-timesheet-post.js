#!/usr/bin/env node
/*
 * OWNA → Employment Hero timesheet sync — POSTER.
 *
 * Reads OWNA clock-in/out via services/eh-timesheet.js (the same buildTimesheets() the dry run
 * uses, so the two can never drift) and creates the matching timesheet lines in EH.
 *
 * SAFETY — this touches real payroll. In order:
 *   1. DRY RUN BY DEFAULT. Nothing is written unless you pass --live.
 *   2. Lines post as status "Submitted" — a draft for a centre director to approve.
 *      Never "Approved", so hours cannot reach a pay run without a human.
 *   3. Refuses any date already covered by a FINALISED pay run.
 *   4. Idempotent: each line carries externalId `owna:{staffId}:{startEpoch}`. A re-run skips
 *      anything already in EH with that externalId.
 *   5. Conflict guard: if the employee already has ANY timesheet overlapping that day from
 *      another source (a manual FileImport, the EH WorkZone clock), the line is SKIPPED and
 *      reported — we never create a second, double-paying record.
 *   6. --undo deletes only lines this tool created (externalId prefix `owna:`) in the range.
 *
 * Usage:
 *   node scripts/eh-timesheet-post.js <centre|all> <from> [to] [options]
 *
 *   --live                 actually write to EH (otherwise dry run)
 *   --employee <ftCode>    restrict to one person by OWNA employeeCode / EH externalId
 *   --limit <n>            post at most n lines
 *   --undo                 delete this tool's previously posted lines in the range
 *   --allow-conflict       post even if another timesheet overlaps (use with care)
 *
 * Examples:
 *   node scripts/eh-timesheet-post.js gwh 2026-09-08                       # dry run, whole centre
 *   node scripts/eh-timesheet-post.js gwh 2026-09-08 --employee ft000140 --limit 1 --live
 *   node scripts/eh-timesheet-post.js gwh 2026-09-08 --undo --live
 */
require("dotenv").config();
const path = require("path");
const m = require(path.join(__dirname, "..", "services", "metrics"));
const { eh } = require(path.join(__dirname, "..", "services", "eh"));
const ts = require(path.join(__dirname, "..", "services", "eh-timesheet"));

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const shortName = (n) => (n || "").replace(/Futuro Childcare (and|&) Education\s*-?\s*/i, "").replace(/^Futuro\s+/, "").trim();

// OWNA centre name → the EH location it maps to. EH calls Gledswood Hills "GWH", so name
// matching alone is not enough; this table is the contract.
const EH_LOCATION_BY_CENTRE = [
  { match: /austral/i,   ehName: "Futuro Austral" },
  { match: /bardia/i,    ehName: "Futuro Bardia" },
  { match: /gledswood/i, ehName: "Futuro GWH" },
  { match: /heath/i,     ehName: "Futuro Heath Rd" },
  { match: /oran/i,      ehName: "Futuro Oran Park" },
  { match: /cobbitty/i,  ehName: "Futuro Cobbitty" },
];

// CLI aliases so you can type "gwh" instead of a 24-char OWNA id.
const CENTRE_ALIAS = { gwh: /gledswood/i, gledswood: /gledswood/i, austral: /austral/i, bardia: /bardia/i, heath: /heath/i, heathrd: /heath/i, "heath-rd": /heath/i };

function parseArgs(argv) {
  const o = { live: false, undo: false, allowConflict: false, employee: null, limit: Infinity, centre: null, dates: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") o.live = true;
    else if (a === "--undo") o.undo = true;
    else if (a === "--allow-conflict") o.allowConflict = true;
    else if (a === "--employee") o.employee = String(argv[++i] || "").trim().toLowerCase();
    else if (a === "--limit") o.limit = Number(argv[++i]);
    else if (isDate(a)) o.dates.push(a);
    else if (!a.startsWith("--")) o.centre = a;
  }
  return o;
}

// A pay run whose period covers `date` and is finalised means those hours are already paid.
// Imported, not re-declared: this was a second copy of the rule, and a second copy is a rule that will
// eventually disagree with itself. See services/timesheet-push.js for why it fails closed.
const { finalisedRunCovering } = require(path.join(__dirname, "..", "services", "timesheet-push"));

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

(async () => {
  const o = parseArgs(process.argv.slice(2));
  const from = o.dates[0];
  const to = o.dates[1] || from;
  if (!from) { console.error("Need a date: node scripts/eh-timesheet-post.js <centre|all> <YYYY-MM-DD> [to] [--live]"); process.exit(1); }
  if (!eh.hasCreds()) { console.error("EH credentials not set (EH_PAYROLL_API_KEY / EH_PAYROLL_BUSINESS_ID)."); process.exit(1); }

  const allCentres = m.centres().filter((c) => !c.opening && c.capacity > 0);
  let centres = allCentres;
  if (o.centre && o.centre !== "all") {
    const alias = CENTRE_ALIAS[o.centre.toLowerCase()];
    centres = allCentres.filter((c) => (alias ? alias.test(c.name) : c.owna_id === o.centre));
  }
  if (!centres.length) { console.error(`No centre matched "${o.centre}". Try: all, gwh, austral, bardia, heath.`); process.exit(1); }

  const mode = o.undo ? "UNDO" : (o.live ? "LIVE — WRITING TO PAYROLL" : "DRY RUN — nothing will be written");
  console.log("══════════════════════════════════════════════════════════════════");
  console.log(`  OWNA → Employment Hero timesheets  ·  ${mode}`);
  console.log("══════════════════════════════════════════════════════════════════");
  console.log(`Range: ${from}${to !== from ? " → " + to : ""}  ·  Centres: ${centres.map((c) => shortName(c.name)).join(", ")}`);
  if (o.employee) console.log(`Employee filter: ${o.employee}`);
  if (Number.isFinite(o.limit)) console.log(`Limit: ${o.limit} line(s)`);
  console.log("");

  // --- Guard: no finalised pay run may cover any date in range -----------------
  const runs = await eh.payRuns();
  for (const d of ts.dateRange(from, to)) {
    const r = finalisedRunCovering(runs, d);
    if (r) {
      console.error(`REFUSING: ${d} falls inside FINALISED pay run ${r.id} ` +
        `(${String(r.payPeriodStarting).slice(0, 10)} → ${String(r.payPeriodEnding).slice(0, 10)}, paid ${String(r.datePaid).slice(0, 10)}).`);
      console.error("Those hours are already paid. Posting here would not reach that run and risks a duplicate next run.");
      process.exit(2);
    }
  }
  console.log("✓ No finalised pay run covers this range.\n");

  // --- What EH already holds for the range ------------------------------------
  const existing = await eh.timesheetsBetween(from, to);
  const byExternalId = new Map();
  const byEmployee = {};
  existing.forEach((t) => {
    if (t.externalId) byExternalId.set(String(t.externalId), t);
    (byEmployee[t.employeeId] ||= []).push(t);
  });
  console.log(`EH already holds ${existing.length} timesheet line(s) in this range.\n`);

  // --- UNDO --------------------------------------------------------------------
  if (o.undo) {
    const ours = existing.filter((t) => String(t.externalId || "").startsWith("owna:"));
    if (!ours.length) { console.log("Nothing to undo — no lines with an `owna:` externalId in this range."); return; }
    console.log(`Found ${ours.length} line(s) created by this tool:`);
    ours.forEach((t) => console.log(`  id=${t.id} emp=${t.employeeId} ${t.startTime} → ${t.endTime} [${t.status}] ${t.externalId}`));
    if (!o.live) { console.log("\nDRY RUN — pass --live to actually delete these."); return; }
    let gone = 0;
    for (const t of ours) {
      try { await eh.deleteTimesheet(t.id); gone++; console.log(`  deleted ${t.id}`); }
      catch (e) { console.error(`  FAILED to delete ${t.id}: ${e.message}`); }
    }
    console.log(`\nDeleted ${gone}/${ours.length}.`);
    return;
  }

  // --- Build the lines from OWNA ------------------------------------------------
  const { lines, quarantined, unmapped, skipped, stats } = await ts.buildTimesheets({ centres, from, to });
  console.log(`OWNA → ${stats.postable} postable · ${stats.quarantined} quarantined · ${stats.unmapped} unmapped · ${stats.skipped} dropped\n`);

  // Resolve EH locations once.
  const locs = await eh.locations();
  const locIdFor = (centreName) => {
    const rule = EH_LOCATION_BY_CENTRE.find((r) => r.match.test(centreName));
    const loc = rule && locs.find((l) => l.name === rule.ehName);
    return loc ? loc.id : null;
  };

  let candidates = lines;
  if (o.employee) candidates = candidates.filter((l) => String(l.externalId || "").toLowerCase() === o.employee);
  candidates.sort((a, b) => (a.payDate + a.startLocal).localeCompare(b.payDate + b.startLocal));

  const toPost = [], conflicts = [], alreadyDone = [], noLocation = [];
  for (const l of candidates) {
    if (byExternalId.has(l.dedupeKey)) { alreadyDone.push(l); continue; }
    const locationId = locIdFor(l.centre);
    if (!locationId) { noLocation.push(l); continue; }
    const clash = (byEmployee[l.employeeId] || []).find((t) =>
      overlaps(l.startLocalISO, l.endLocalISO, String(t.startTime), String(t.endTime)));
    if (clash && !o.allowConflict) { conflicts.push({ l, clash }); continue; }
    toPost.push({ ...l, locationId });
    if (toPost.length >= o.limit) break;
  }

  const report = (title, arr, fmt) => { if (!arr.length) return; console.log(title); arr.forEach((x) => console.log("  " + fmt(x))); console.log(""); };
  report(`⏭  Already posted by this tool (${alreadyDone.length}) — skipped:`, alreadyDone,
    (l) => `${l.name.padEnd(22)} ${l.payDate} ${l.startLocal}-${l.endLocal}`);
  report(`⚠  Overlapping timesheet already in EH (${conflicts.length}) — SKIPPED to avoid double pay:`, conflicts,
    ({ l, clash }) => `${l.name.padEnd(22)} OWNA ${l.startLocal}-${l.endLocal}  vs  EH id=${clash.id} ${String(clash.startTime).slice(11, 16)}-${String(clash.endTime).slice(11, 16)} [${clash.status}/${clash.source}]`);
  report(`✖  No EH location mapped (${noLocation.length}):`, noLocation, (l) => `${l.name.padEnd(22)} ${l.centre}`);

  if (!toPost.length) { console.log("Nothing to post."); return; }

  console.log(`▶ ${toPost.length} line(s) to create:`);
  toPost.forEach((l) => console.log(`  ${l.name.padEnd(22)} ${l.payDate} ${l.startLocal}-${l.endLocal}  ${String(l.grossHours).padStart(5)}h  → EH emp ${l.employeeId} (${l.externalId})  loc ${l.locationId}`));

  const body = (l) => ({
    employeeId: l.employeeId,
    startTime: l.startLocalISO,
    endTime: l.endLocalISO,
    locationId: l.locationId,
    externalId: l.dedupeKey,
    comments: "Imported from OWNA clock-in/out",
    status: "Submitted", // draft — a director approves it in EH
  });

  console.log("\nExact payload for the first line:");
  console.log(JSON.stringify(body(toPost[0]), null, 2));

  if (!o.live) { console.log("\n*** DRY RUN — nothing was sent. Add --live to post. ***"); return; }

  console.log("\nPosting…");
  const created = [], failed = [];
  for (const l of toPost) {
    try {
      const res = await eh.createTimesheet(body(l));
      created.push({ l, res });
      console.log(`  ✓ ${l.name} ${l.payDate} ${l.startLocal}-${l.endLocal} → EH timesheet id ${res.id} [${res.status}]`);
    } catch (e) {
      failed.push({ l, e });
      console.error(`  ✗ ${l.name} ${l.payDate}: ${e.message}`);
    }
  }

  // Read back so success is proven, not assumed.
  const after = await eh.timesheetsBetween(from, to);
  const seen = new Set(after.map((t) => String(t.id)));
  const verified = created.filter((c) => seen.has(String(c.res.id))).length;

  console.log("\n──────────────────────────────────────────────────────────────────");
  console.log(`Created ${created.length}, failed ${failed.length}, verified present in EH: ${verified}/${created.length}.`);
  console.log(`All lines are status "Submitted" — they need a director's approval in EH before they can be paid.`);
  if (created.length) console.log(`To reverse: node scripts/eh-timesheet-post.js ${o.centre || "all"} ${from}${to !== from ? " " + to : ""} --undo --live`);
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
