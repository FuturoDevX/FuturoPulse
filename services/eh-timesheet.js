// OWNA → Employment Hero timesheet sync — CORE (read-only build; posting lives in a separate, gated step).
//
// This module turns OWNA clock events into the exact timesheet lines we would create in EH.
// It performs only GET calls. It never writes to OWNA or EH. The dry-run CLI and any future
// live poster both call buildTimesheets() so the two can never drift apart.
//
// Mapping key (the ONLY key we post on): OWNA staff.employeeCode === EH employee.externalId (ftXXXXXX).
// Name matching is a reconciliation aid (see eh-timesheet-reconcile.js) — never a posting key.
//
// Breaks: Employment Hero applies unpaid breaks automatically via its award / pay-condition rules
// engine. We therefore post the ACTUAL clocked start/end and deduct NOTHING here.
require("dotenv").config();
const path = require("path");
const { eh } = require(path.join(__dirname, "eh"));

const OBASE = (process.env.OWNA_BASE_URL || "https://api.owna.com.au").replace(/\/$/, "");
const OKEY = process.env.OWNA_API_KEY || "";
const TZ = "Australia/Sydney";
const BID = process.env.EH_PAYROLL_BUSINESS_ID || "";

// Data-quality thresholds (edge cases surfaced by the POC).
const MIN_SHIFT_MINUTES = 3;   // shorter than this = double-tap noise → drop
const MAX_SHIFT_HOURS = 12;    // longer than this = almost certainly a missed checkout → QUARANTINE, never auto-post

const fmtTime = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const fmtDate = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const localTime = (iso) => fmtTime.format(new Date(iso));
const localDate = (iso) => fmtDate.format(new Date(iso));
// The filter below admits any "centre check…" status, so these must classify everything that filter
// lets through. They used to be /checkin/i and /checkout/i — no space allowed — while the filter was
// /centre\s*check/i, which does allow one. A status spelled "centre check in" therefore passed the
// filter, matched neither of these, and was dropped: no span, no issue, no error. The educator simply
// would not be paid for that day and nothing on any screen would say so.
const isIn = (s) => /check\s*in/i.test(s);
const isOut = (s) => /check\s*out/i.test(s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// OWNA drops connections and rate-limits under the volume of a multi-centre pull, so retry
// transport errors and 429/5xx with backoff. A partial pull must never look like "no shifts".
async function oget(p, attempt = 0) {
  const MAX = 4;
  let r, t;
  try {
    r = await fetch(OBASE + p, { signal: AbortSignal.timeout(45000), headers: { "x-api-key": OKEY, Accept: "application/json" } });
    t = await r.text();
  } catch (err) {
    if (attempt < MAX) { await sleep(500 * 2 ** attempt); return oget(p, attempt + 1); }
    throw new Error(`OWNA ${p}: ${err.message} (after ${MAX + 1} attempts)`);
  }
  let b; try { b = JSON.parse(t); } catch { b = t; }
  if (!r.ok) {
    if ((r.status === 429 || r.status >= 500) && attempt < MAX) { await sleep(500 * 2 ** attempt); return oget(p, attempt + 1); }
    throw new Error(`OWNA ${r.status} ${p}: ${String(JSON.stringify(b)).slice(0, 160)}`);
  }
  // A captive portal / DNS filter (e.g. NetAlerts, DNSFilter) answers 200 with an HTML block
  // page. Parsed loosely that yields zero rows, which would read as "nobody worked today" and
  // silently post an empty payroll. Never treat a non-JSON 200 as data.
  if (typeof b !== "object" || b === null) {
    const hint = /<!DOCTYPE html|dnsfilter|blocked|Website Filtered/i.test(String(t))
      ? "the response is an HTML block page — a DNS/content filter is intercepting api.owna.com.au"
      : "the response was not JSON";
    throw new Error(`OWNA ${p}: ${hint}. Refusing to treat this as an empty result.`);
  }
  return Array.isArray(b) ? { rows: b, total: b.length } : { rows: (b && b.data) || [], total: (b && b.totalCount) ?? ((b && b.data) || []).length };
}

// Walk EVERY page of a paginated OWNA list endpoint. The POC's single fetch returned ~10 of 122
// staff, which silently unmapped ~everyone — this is the fix.
async function staffAll(centreId) {
  const out = []; let skip = 0;
  for (;;) {
    const { rows, total } = await oget(`/api/staff/${centreId}/list?take=500&skip=${skip}`);
    out.push(...rows); skip += rows.length;
    if (!rows.length || skip >= total) break;
    if (skip > 50000) break;
  }
  return out;
}

// Pair a staff member's checkin/checkout events into worked spans (handles split shifts).
function pairSpans(events) {
  const evs = events.filter((e) => /centre\s*check/i.test(e.status))
    .sort((a, b) => new Date(a.statusDate) - new Date(b.statusDate));
  const spans = []; const issues = [];
  let open = null;
  for (const e of evs) {
    if (isIn(e.status)) { if (open) issues.push(`double check-in ${localTime(open.statusDate)} then ${localTime(e.statusDate)} (first ignored)`); open = e; }
    else if (isOut(e.status)) {
      if (!open) { issues.push(`check-out ${localTime(e.statusDate)} with no matching check-in`); continue; }
      spans.push({ in: open.statusDate, out: e.statusDate }); open = null;
    }
    // Belt and braces for the same failure: a clock event this code cannot classify is REPORTED, never
    // discarded in silence. Losing a shift is invisible; losing it with a line on the screen is not.
    else issues.push(`clock event "${String(e.status).slice(0, 40)}" at ${localTime(e.statusDate)} was not recognised as a check-in or check-out and has been ignored`);
  }
  if (open) issues.push(`check-in ${localTime(open.statusDate)} never checked out (missed tap or still on shift)`);
  return { spans, issues };
}

// Stable idempotency key for one worked span — used to dedupe on re-runs and against existing EH timesheets.
function dedupeKey(staffId, span) {
  return `owna:${staffId}:${Math.floor(new Date(span.in).getTime() / 1000)}`;
}

// The EXACT body we would POST to EH. Field names marked (confirm) are validated against the live
// KeyPay API at go-live; the shape mirrors a KeyPay timesheet line. No break is included by design.
function toPayload(line) {
  return {
    endpoint: `POST /api/v2/business/${BID}/timesheet`,
    employeeId: line.employeeId,                 // EH numeric id (resolved from externalId)
    startTime: line.startLocalISO,               // actual clock-in, Australia/Sydney
    endTime: line.endLocalISO,                   // actual clock-out
    unitType: "Hours",
    // location/workType: EH applies its award rules (incl. breaks) from these + the employee's setup.
    locationName: line.locationName,             // (confirm) → map centre to EH locationId at go-live
    externalReference: line.dedupeKey,           // (confirm) idempotency guard against double-posting
    comments: "Imported from OWNA clock-in/out",
    // status intent: create as DRAFT/Submitted for a centre director to APPROVE — never straight to a pay run.
    status: "Submitted (draft — awaiting approval)",
  };
}

// Read OWNA + EH and build every timesheet line for [from..to] across the given centres.
// Returns { lines, quarantined, skipped, unmapped, issues, stats } — and writes NOTHING.
async function buildTimesheets({ centres, from, to }) {
  const dates = dateRange(from, to);
  const emps = await (eh.employeesCached ? eh.employeesCached() : eh.allEmployees());
  const ehByExt = new Map();
  emps.forEach((e) => { if (e.externalId) ehByExt.set(String(e.externalId).trim().toLowerCase(), e); });

  const lines = [], quarantined = [], skipped = [], unmapped = [], issues = [];

  for (const c of centres) {
    const staff = await staffAll(c.owna_id);
    const staffById = new Map(staff.map((s) => [String(s.id), s]));

    for (const date of dates) {
      const { rows: log } = await oget(`/api/staff/log/${c.owna_id}/${date}`);
      const byStaff = {}; log.forEach((r) => { (byStaff[String(r.staffId)] ||= []).push(r); });

      for (const sid of Object.keys(byStaff)) {
        const s = staffById.get(sid) || {};
        const name = [s.firstname, s.surname].filter(Boolean).join(" ") || byStaff[sid][0].staffName || "(unknown)";
        const { spans, issues: shiftIssues } = pairSpans(byStaff[sid]);
        shiftIssues.forEach((msg) => issues.push({ centre: c.name, name, msg }));
        if (!spans.length) continue;

        const code = (s.employeeCode || "").trim();
        const ehEmp = code ? ehByExt.get(code.toLowerCase()) : null;

        for (const sp of spans) {
          const grossMins = Math.round((new Date(sp.out) - new Date(sp.in)) / 60000);
          const base = {
            centre: c.name, locationName: c.name, name, staffId: sid,
            employeeCode: code || null,
            payDate: localDate(sp.in),
            startLocal: localTime(sp.in), endLocal: localTime(sp.out),
            startLocalISO: `${localDate(sp.in)}T${localTime(sp.in)}:00`,
            endLocalISO: `${localDate(sp.out)}T${localTime(sp.out)}:00`,
            grossHours: +(grossMins / 60).toFixed(2),
            dedupeKey: dedupeKey(sid, sp),
          };

          // Edge-case gates (order matters).
          if (grossMins <= 0) { skipped.push({ ...base, reason: "zero/negative span (double-tap)" }); continue; }
          if (grossMins < MIN_SHIFT_MINUTES) { skipped.push({ ...base, reason: `under ${MIN_SHIFT_MINUTES}m (double-tap)` }); continue; }
          if (grossMins > MAX_SHIFT_HOURS * 60) { quarantined.push({ ...base, reason: `over ${MAX_SHIFT_HOURS}h — likely missed checkout; needs human review` }); continue; }

          if (!ehEmp) { unmapped.push({ ...base, reason: !code ? "no employeeCode in OWNA" : `code ${code} not in EH` }); continue; }

          lines.push({ ...base, employeeId: ehEmp.id, externalId: ehEmp.externalId, ehName: [ehEmp.firstName, ehEmp.surname].filter(Boolean).join(" ") });
        }
      }
    }
  }

  const stats = {
    dates: dates.length,
    postable: lines.length,
    quarantined: quarantined.length,
    unmapped: unmapped.length,
    skipped: skipped.length,
    grossHours: +(lines.reduce((a, l) => a + l.grossHours, 0)).toFixed(1),
  };
  return { lines, quarantined, skipped, unmapped, issues, stats };
}

function dateRange(from, to) {
  const out = []; const d = new Date(from + "T00:00:00Z"); const end = new Date((to || from) + "T00:00:00Z");
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out.length ? out : [from];
}

module.exports = { buildTimesheets, pairSpans, toPayload, dedupeKey, staffAll, dateRange, localTime, localDate, TZ, MIN_SHIFT_MINUTES, MAX_SHIFT_HOURS };
