// OWNA → Employment Hero timesheet push — the library the dashboard button calls.
//
// The CLI (scripts/eh-timesheet-post.js) and this module both build their lines with
// services/eh-timesheet.js buildTimesheets(), so the screen and the command line can never
// disagree about what would be posted.
//
// SAFETY, in the order it is enforced:
//   1. preview() writes NOTHING. The button shows a preview first; posting is a second, explicit step.
//   2. Refuses any date already inside a FINALISED pay run — those hours are paid.
//   3. Conflict guard: if the employee already has ANY timesheet overlapping that shift, from any
//      source (the manual FileImport, EH's own WorkZone clock), the line is skipped. Most days most
//      educators already have one, so without this a push would double-pay.
//   4. Idempotent: every line carries externalId `owna:{staffId}:{startEpoch}`. Re-running skips
//      anything already posted.
//   5. Posts as status "Submitted" — a draft for a centre director to approve. Never "Approved".
//   6. undo() deletes only lines this tool created (externalId prefix `owna:`).
require("dotenv").config();
const path = require("path");
const db = require(path.join(__dirname, "..", "db", "db"));
const { eh } = require(path.join(__dirname, "eh"));
const ts = require(path.join(__dirname, "eh-timesheet"));

// OWNA centre → the EH location to post against. EH calls Gledswood Hills "GWH", so name matching
// alone is not enough; this table is the contract.
const EH_LOCATION = [
  { match: /austral/i, ehName: "Futuro Austral" },
  { match: /bardia/i, ehName: "Futuro Bardia" },
  { match: /gledswood/i, ehName: "Futuro GWH" },
  { match: /heath/i, ehName: "Futuro Heath Rd" },
  { match: /oran/i, ehName: "Futuro Oran Park" },
  { match: /cobbitty/i, ehName: "Futuro Cobbitty" },
];

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;
const centreRow = (ownaId) => db.prepare("SELECT owna_id, name FROM centres WHERE owna_id = ?").get(ownaId);

// A pay run whose period covers `date` and is finalised means those hours are already paid.
//
// FAILS CLOSED. This read r.payPeriodStarting directly, and that field name appears nowhere else in this
// codebase: services/eh-labour.js, which runs against live Employment Hero data, uses only
// payPeriodEnding and datePaid, and so does every payrun fixture in tests/. If KeyPay does not return
// payPeriodStarting then String(undefined).slice(0,10) is "undefined", "undefined" <= "2026-09-23" is
// false in JavaScript, the find() never matches, and the single guard standing between this tool and an
// already-paid pay period silently does nothing.
//
// So a period whose START cannot be read is treated as covering everything up to its END. That refuses
// more than strictly necessary, which is the right direction: the cost of a false refusal is a message
// on a screen, and the cost of a false pass is paying someone twice.
const DATE10 = /^\d{4}-\d{2}-\d{2}$/;
const d10 = (v) => String(v == null ? "" : v).slice(0, 10);

function finalisedRunCovering(runs, date) {
  return (runs || []).find((r) => {
    if (!r || !r.isFinalised) return false;
    const end = d10(r.payPeriodEnding);
    if (!DATE10.test(end) || date > end) return false;      // after the period, or unreadable: not covered
    const start = d10(r.payPeriodStarting);
    return !DATE10.test(start) || start <= date;            // unreadable start => treat as covering
  });
}

// Everything the screen needs, and nothing written anywhere.
async function preview({ ownaId, from, to }) {
  const centre = centreRow(ownaId);
  if (!centre) throw new Error("Unknown centre.");
  if (!eh.hasCreds()) throw new Error("Employment Hero credentials are not configured on this server.");
  to = to || from;

  const dates = ts.dateRange(from, to);
  const runs = await eh.payRunsCached();
  for (const d of dates) {
    const r = finalisedRunCovering(runs, d);
    if (r) {
      return {
        centre, from, to, blocked: true,
        blockedReason: `${d} falls inside a finalised pay run (${String(r.payPeriodStarting).slice(0, 10)} to ` +
          `${String(r.payPeriodEnding).slice(0, 10)}, paid ${String(r.datePaid).slice(0, 10)}). Those hours are already paid.`,
        lines: [], conflicts: [], unmapped: [], quarantined: [], alreadyPosted: [], noLocation: [], issues: [],
      };
    }
  }

  const locs = await eh.locationsCached();
  const rule = EH_LOCATION.find((r) => r.match.test(centre.name));
  const loc = rule && locs.find((l) => l.name === rule.ehName);

  const existing = await eh.timesheetsBetween(from, to);
  const byExternalId = new Map();
  const byEmployee = {};
  existing.forEach((t) => {
    if (t.externalId) byExternalId.set(String(t.externalId), t);
    (byEmployee[t.employeeId] ||= []).push(t);
  });

  const built = await ts.buildTimesheets({ centres: [centre], from, to });
  const lines = [], conflicts = [], alreadyPosted = [], noLocation = [];
  for (const l of built.lines) {
    if (byExternalId.has(l.dedupeKey)) { alreadyPosted.push({ ...l, ehId: byExternalId.get(l.dedupeKey).id }); continue; }
    if (!loc) { noLocation.push(l); continue; }
    const clash = (byEmployee[l.employeeId] || []).find((t) =>
      overlaps(l.startLocalISO, l.endLocalISO, String(t.startTime), String(t.endTime)));
    if (clash) {
      conflicts.push({ ...l, clash: { id: clash.id, start: String(clash.startTime).slice(11, 16), end: String(clash.endTime).slice(11, 16), status: clash.status, source: clash.source } });
      continue;
    }
    lines.push({ ...l, locationId: loc.id });
  }
  lines.sort((a, b) => (a.payDate + a.startLocal).localeCompare(b.payDate + b.startLocal));

  // Anything already posted by this tool can be reversed.
  const undoable = existing.filter((t) => String(t.externalId || "").startsWith("owna:"));

  return {
    centre, from, to, blocked: false, blockedReason: null,
    ehLocation: loc ? { id: loc.id, name: loc.name } : null,
    lines, conflicts, alreadyPosted, noLocation,
    unmapped: built.unmapped, quarantined: built.quarantined, issues: built.issues,
    existingCount: existing.length, undoableCount: undoable.length,
    stats: built.stats,
  };
}

function bodyFor(line) {
  return {
    employeeId: line.employeeId,
    startTime: line.startLocalISO,
    endTime: line.endLocalISO,
    locationId: line.locationId,
    externalId: line.dedupeKey,
    comments: "Imported from OWNA clock-in/out",
    status: "Submitted", // draft — a director approves it in EH
  };
}

// Posts the lines preview() produced. Re-previews first so a stale screen cannot post something the
// guards would now refuse.
async function push({ ownaId, from, to, byUser }) {
  const pv = await preview({ ownaId, from, to });
  if (pv.blocked) throw new Error(pv.blockedReason);
  if (!pv.lines.length) return { ...pv, created: [], failed: [], verified: 0 };

  const created = [], failed = [];
  for (const l of pv.lines) {
    try {
      const res = await eh.createTimesheet(bodyFor(l));
      created.push({ name: l.name, payDate: l.payDate, start: l.startLocal, end: l.endLocal, hours: l.grossHours, ehId: res.id, status: res.status });
    } catch (e) {
      failed.push({ name: l.name, payDate: l.payDate, error: String(e.message).slice(0, 200) });
    }
  }
  // Read back so success is proven, not assumed.
  let verified = 0;
  try {
    const after = await eh.timesheetsBetween(from, to);
    const seen = new Set(after.map((t) => String(t.id)));
    verified = created.filter((c) => seen.has(String(c.ehId))).length;
  } catch { verified = -1; }

  logPush({ ownaId, centre: pv.centre.name, from, to, action: "push", byUser, created: created.length, failed: failed.length, verified });
  return { ...pv, created, failed, verified };
}

// Deletes only what this tool created in the range.
async function undo({ ownaId, from, to, byUser }) {
  const centre = centreRow(ownaId);
  if (!centre) throw new Error("Unknown centre.");
  const existing = await eh.timesheetsBetween(from, to || from);
  const built = await ts.buildTimesheets({ centres: [centre], from, to: to || from });
  // Only this centre's people: match on the employee ids this centre's OWNA staff resolve to.
  const mine = new Set(built.lines.concat(built.unmapped || []).map((l) => String(l.employeeId)));
  const ours = existing.filter((t) => String(t.externalId || "").startsWith("owna:") && mine.has(String(t.employeeId)));
  const deleted = [], failed = [];
  for (const t of ours) {
    try { await eh.deleteTimesheet(t.id); deleted.push(t.id); }
    catch (e) { failed.push({ id: t.id, error: String(e.message).slice(0, 200) }); }
  }
  logPush({ ownaId, centre: centre.name, from, to: to || from, action: "undo", byUser, created: deleted.length, failed: failed.length, verified: deleted.length });
  return { centre, deleted, failed, found: ours.length };
}

// Payroll writes get an audit row: who, when, what, how many. Names are NOT stored — the EH
// timesheet itself is the record of who; this table answers "who pressed the button".
function logPush({ ownaId, centre, from, to, action, byUser, created, failed, verified }) {
  try {
    db.prepare(`INSERT INTO timesheet_push_log (owna_id, centre_name, date_from, date_to, action, user_id, user_email, created_count, failed_count, verified_count)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(ownaId, centre, from, to, action, (byUser && byUser.id) || null, (byUser && byUser.email) || null, created, failed, verified);
  } catch (e) { console.warn("[timesheet-push] could not write audit row"); }
}

function history(ownaId, limit = 20) {
  try {
    return db.prepare(`SELECT * FROM timesheet_push_log ${ownaId ? "WHERE owna_id = ?" : ""} ORDER BY id DESC LIMIT ?`)
      .all(...(ownaId ? [ownaId, limit] : [limit]));
  } catch { return []; }
}

module.exports = { preview, push, undo, history, finalisedRunCovering, EH_LOCATION };
