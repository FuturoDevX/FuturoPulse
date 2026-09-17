#!/usr/bin/env node
// Print what this dashboard holds for each centre in EXACTLY the shape of LineLeader's own
// "Child Counts" bar, so anyone can put the two side by side and see whether they agree.
//
// Why this exists: on 18 September 2026 a board report was drafted three times from three different
// tables, and twice it was wrong — once counting lost and rejected leads as enrolments, once counting
// enrolment records instead of children. Both were caught by the owner holding a LineLeader screenshot
// next to the number, not by anything in this repo. This makes that check take ten seconds and removes
// the need to take anyone's word for it.
//
//   npm run ll-check              every centre
//   npm run ll-check -- Bardia    one centre
//
// Read-only. Touches nothing.
require("dotenv").config();
const db = require("../db/db");

// The stages LineLeader's bar shows, left to right, with its own labels.
const BAR = [
  [1,  "New Family"],
  [2,  "Engaged"],
  [13, "Pre Open"],
  [11, "Tour Sched"],
  [3,  "Tour Compl"],
  [4,  "Waitlist"],
  [12, "Pre-Offered"],
  [5,  "Offer"],
];

const SHORT = (n) => (n || "")
  .replace(/Futuro Childcare\s*(and|&)\s*Education\s*-?\s*/i, "")
  .replace(/^Leppington Heath$/i, "Heath Rd")
  .trim();

const filter = (process.argv[2] || "").toLowerCase();

const centres = db.prepare(
  `SELECT DISTINCT centre_name FROM ll_pipeline_members WHERE centre_name NOT LIKE '%Z-Test%' ORDER BY centre_name`
).all().map((r) => r.centre_name).filter((n) => !filter || n.toLowerCase().includes(filter));

if (!centres.length) {
  console.error(filter ? `No centre matching "${process.argv[2]}".` : "No LineLeader data stored yet.");
  process.exit(1);
}

// When the stored figures were pulled. A LineLeader screen is live, so the two will differ by however
// long ago this ran — that drift is expected and is the first thing to check before chasing a gap.
const pulled = db.prepare(`SELECT MAX(updated_at) AS at FROM ll_pipeline_members`).get();
const snap = db.prepare(`SELECT MAX(snapshot_date) AS d FROM ll_pipeline`).get();

console.log("");
console.log("  LineLeader reconciliation — what this dashboard holds");
console.log("  " + "=".repeat(64));
console.log("  Stored counts pulled : " + (pulled && pulled.at ? pulled.at + " UTC" : "never"));
console.log("  Stage snapshot dated : " + (snap && snap.d ? snap.d : "none"));
console.log("");
console.log("  Open each centre's LineLeader Action Dashboard and compare the");
console.log("  'Child Counts' bar with the row below. They should agree to within");
console.log("  the funnel movement since the pull date above.");
console.log("");

const memberQ = db.prepare(
  `SELECT COUNT(DISTINCT child_id) AS n FROM ll_pipeline_members WHERE centre_name = ? AND status_id = ?`
);
const funnelQ = db.prepare(
  `SELECT count AS n FROM ll_pipeline WHERE snapshot_date = ? AND centre_name = ? AND status_id = ?`
);

let anyGap = false;

for (const centre of centres) {
  const label = SHORT(centre);
  console.log("  " + label);
  console.log("  " + "-".repeat(64));

  const header = BAR.map(([, nm]) => nm.padStart(12)).join("");
  console.log("  " + " ".repeat(10) + header);

  const mem = BAR.map(([id]) => memberQ.get(centre, id).n);
  console.log("  " + "ours".padEnd(10) + mem.map((n) => String(n).padStart(12)).join(""));

  const fun = BAR.map(([id]) => {
    const r = snap && snap.d ? funnelQ.get(snap.d, centre, id) : null;
    return r ? r.n : 0;
  });
  console.log("  " + "snapshot".padEnd(10) + fun.map((n) => String(n).padStart(12)).join(""));

  const total = mem.reduce((a, b) => a + b, 0);
  console.log("  " + " ".repeat(10) + ("live total " + total).padStart(BAR.length * 12));

  // Pre Open is the stage the sync is known to drop (services/snapshot.js PIPELINE_STATUSES omits 13).
  // Call it out per centre rather than leave a silent zero that looks like a real count.
  if (mem[2] === 0 && fun[2] > 0) {
    anyGap = true;
    console.log("  " + "!".padEnd(10) + "Pre Open reads 0 here but the snapshot saw " + fun[2] +
      " — this stage is not captured (status 13).");
  }
  console.log("");
}

if (anyGap) {
  console.log("  ! At least one centre is missing its Pre Open children. Until PIPELINE_STATUSES in");
  console.log("    services/snapshot.js includes status 13 and a sync has run, those centres read low.");
  console.log("");
}
console.log("  If a row disagrees by more than the funnel could have moved since the pull,");
console.log("  the stored data is wrong — not the screen. Say so before it reaches a board pack.");
console.log("");
