#!/usr/bin/env node
/*
 * What is actually in Employment Hero right now — READ-ONLY.
 *
 * Written after the timesheet push was first run against live centres. It answers the questions a
 * successful POST does not: EH accepting a payload does not prove it STORED the idempotency key, and a
 * push that reported "created" does not prove the hours are not doubled up.
 *
 * It WRITES NOTHING, to either system. Every call is a GET. Run it before a push to see the ground
 * truth, and after a push to prove what landed.
 *
 * It reports:
 *   1. which field EH returns the idempotency key in — externalId or externalReference. If neither
 *      carries an `owna:` value on a line this tool created, the key was not stored and the next push
 *      of the same range will DUPLICATE it.
 *   2. the wire format of startTime, which is what the overlap guard has to compare against.
 *   3. the status of every line we created — they are posted as "Submitted" drafts, and anything else
 *      means something approved them.
 *   4. ACTUAL DOUBLE-UPS: any employee with two overlapping timesheets in the range, whoever made them.
 *
 * No names are printed. EH employee ids and the opaque OWNA staff id inside the key are enough to find
 * a line in EH, and this output may be pasted into a chat or an email.
 *
 * Usage:
 *   node scripts/eh-timesheet-audit.js [from YYYY-MM-DD] [to YYYY-MM-DD]
 *   (default: the last 14 days)
 */
require("dotenv").config();
const path = require("path");
const { eh } = require(path.join(__dirname, "..", "services", "eh"));
const { sydneyLocal } = require(path.join(__dirname, "..", "services", "timesheet-push"));

const d10 = (d) => d.toISOString().slice(0, 10);
const argFrom = process.argv[2], argTo = process.argv[3];
const today = new Date();
const from = argFrom || d10(new Date(today.getTime() - 14 * 86400000));
const to = argTo || d10(today);

(async () => {
  if (!eh.hasCreds()) { console.error("EH_PAYROLL_API_KEY / EH_PAYROLL_BUSINESS_ID are not set."); process.exit(1); }
  console.log(`Employment Hero timesheets, ${from} → ${to}  (read-only)\n`);

  let rows;
  try { rows = await eh.timesheetsBetween(from, to); }
  catch (e) { console.error("Could not read timesheets:", e.message); process.exit(1); }

  console.log(`Timesheets in range: ${rows.length}`);
  if (!rows.length) { console.log("Nothing to audit."); return; }

  // ---- 1. where does the idempotency key live, and did it survive? ----
  const keyField = (r) => (String(r.externalId || "").startsWith("owna:") ? "externalId"
    : String(r.externalReference || "").startsWith("owna:") ? "externalReference" : null);
  const ours = rows.filter((r) => keyField(r));
  const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();
  console.log(`\n1. THE IDEMPOTENCY KEY`);
  console.log(`   fields EH returns on a timesheet: ${fields.join(", ")}`);
  console.log(`   lines carrying an "owna:" key:    ${ours.length} of ${rows.length}`);
  if (ours.length) {
    const where = [...new Set(ours.map(keyField))];
    console.log(`   it comes back in:                 ${where.join(" and ")}`);
    console.log(`   => idempotency WORKS. A re-push of this range will skip these lines.`);
  } else {
    const anyExt = rows.filter((r) => r.externalId != null || r.externalReference != null).length;
    console.log(`   => NO line carries an "owna:" key.`);
    console.log(`      ${anyExt} line(s) have any external id at all.`);
    console.log(`      If this tool created lines in this range, the key was NOT stored, and pushing`);
    console.log(`      the same range again WILL create duplicates. Do not re-push until this is fixed.`);
  }

  // ---- 2. the wire format the overlap guard must cope with ----
  console.log(`\n2. TIME FORMAT`);
  const shapes = new Map();
  for (const r of rows) {
    const s = String(r.startTime);
    const shape = s.replace(/\d/g, "9");
    if (!shapes.has(shape)) shapes.set(shape, { shape, example: s, n: 0 });
    shapes.get(shape).n += 1;
  }
  for (const s of shapes.values()) {
    const readable = sydneyLocal(s.example);
    console.log(`   ${s.n.toString().padStart(4)} × ${s.shape}   e.g. ${s.example}`);
    console.log(`        → this code reads that as ${readable || "UNREADABLE — the overlap guard will treat it as a clash"}`);
  }

  // ---- 3. status of the lines we created ----
  console.log(`\n3. STATUS OF OUR LINES`);
  if (!ours.length) console.log("   (none found)");
  else {
    const byStatus = {};
    ours.forEach((r) => { byStatus[r.status || "(none)"] = (byStatus[r.status || "(none)"] || 0) + 1; });
    for (const [st, n] of Object.entries(byStatus)) {
      const ok = /^submitted$/i.test(st);
      console.log(`   ${String(n).padStart(4)} × ${st}${ok ? "   (draft — not paid until a director approves)" : "   <-- NOT a draft: check this"}`);
    }
  }

  // ---- 4. actual double-ups, whoever made them ----
  console.log(`\n4. OVERLAPPING TIMESHEETS (the thing that doubles someone's pay)`);
  const byEmp = {};
  rows.forEach((r) => { (byEmp[r.employeeId] ||= []).push(r); });
  let clashes = 0;
  for (const [empId, list] of Object.entries(byEmp)) {
    const sorted = list.slice().sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i], b = sorted[j];
        const a1 = sydneyLocal(a.startTime), a2 = sydneyLocal(a.endTime);
        const b1 = sydneyLocal(b.startTime), b2 = sydneyLocal(b.endTime);
        if (!a1 || !a2 || !b1 || !b2) continue;          // reported in section 2, not guessed at here
        if (a1 < b2 && b1 < a2) {
          clashes += 1;
          console.log(`   employee ${empId}: #${a.id} ${a1}–${a2} [${a.status || "?"}${keyField(a) ? ", ours" : ""}]`);
          console.log(`                  overlaps #${b.id} ${b1}–${b2} [${b.status || "?"}${keyField(b) ? ", ours" : ""}]`);
        }
      }
    }
  }
  if (!clashes) console.log(`   none — no employee has two overlapping timesheets in this range.`);
  else console.log(`\n   ${clashes} overlapping pair(s). Each is hours counted twice if both are approved.`);

  console.log(`\nNothing was written. To reverse lines this tool created, use Undo on the centre's`);
  console.log(`Rostering tab — it deletes only lines carrying an "owna:" key.`);
})();
