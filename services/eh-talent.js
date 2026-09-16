// Talent pipeline — turns Employment Hero's /employee records into COUNTS per centre per month
// (talent_monthly, talent_group_monthly, talent_reasons_monthly). Runs as a nightly snapshot step and
// on demand as `npm run talent-snapshot`.
//
// PRIVACY: an EH employee record carries the person's name, date of birth, tax file number, bank
// accounts, address and emergency contacts. Nothing from it is written here but counts, a centre id, a
// month and an ATO cessation code. No name, no employee id, no date of birth — not in the tables, not
// in the log line, not in the source_sync detail. The record is read, counted and dropped.
//
// THE OWNER'S RULES (14 September 2026), enforced here so no reader has to remember them:
//   1. Terminations are reported whole, voluntarily, and by reason. Payroll has no "Resignation" code —
//      a resignation IS 'Voluntary cessation' — so voluntary is reported as its own figure.
//   2. Casuals are not turnover: excluded from the headcount denominator AND from the leaver count.
//   3. Casuals are group-level only. The centre against a casual in payroll is an administrative home,
//      not where the hours were worked, so no casual figure is written per centre at all.
//   4. Someone who never started is not a leaver: inferred from endDate on or before startDate, never
//      from a tenure threshold. Someone who worked a fortnight and left IS turnover.
const db = require("../db/db");
const cal = require("./calendar");
const { eh } = require("./eh");
// One classifier, not two: the centre a payroll location belongs to and the OWNA centre it maps to are
// already solved in services/eh-labour.js for wages, and are reused here rather than copied.
const { ownaIdFor, centreLocation } = require("./eh-labour");
// And one classifier for the role, in its own file so the owner can read the rule and /admin/pay-scales
// can show it: a person's role is their PAY CLASSIFICATION (payRateTemplate), not their job title.
const cls = require("./classification");

// Payroll locations that are not a centre (Futuro HQ, the food project) still employ real people, and
// dropping them would make the group headcount smaller than the sum of its parts. They get their own
// bucket. It is NOT a casual bucket — casuals never appear per "centre" at all.
const NO_CENTRE = "(support office)";
// Safety rail only: a nonsense start date in payroll must not turn into thousands of month rows.
const MAX_HISTORY_MONTHS = 240;

// ---- The ATO Single Touch Payroll cessation codes -------------------------------------------------
// Voluntary cessation is how a resignation is recorded; there is no separate resignation code, which is
// why `voluntary` is flagged here and stated on the page. Transfer and Deceased are in the STP set but
// unused by this tenant so far — they are listed so they group correctly the day they appear, and any
// code NOT listed (a future addition, a renamed one) is carried through under its own label rather than
// dropped into an "other" bin that hides it.
const CESSATION_REASONS = Object.freeze([
  { key: "voluntary", label: "Voluntary cessation", voluntary: true },
  { key: "contract", label: "Contract cessation", voluntary: false },
  { key: "dismissal", label: "Dismissal", voluntary: false },
  { key: "redundancy", label: "Redundancy", voluntary: false },
  { key: "ill_health", label: "Ill health", voluntary: false },
  { key: "transfer", label: "Transfer", voluntary: false },
  { key: "deceased", label: "Deceased", voluntary: false },
]);
const normReason = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const REASON_BY_NORM = new Map(CESSATION_REASONS.map((r) => [normReason(r.label), r]));

// A termination reason as stored: a known STP code keeps its canonical key and label; an unrecognised
// one keeps its own text (a KeyPay enum value, not free text) so it can be read, counted and asked
// about rather than silently folded into someone else's number.
function reasonOf(raw) {
  const n = normReason(raw);
  if (!n) return { key: "not_recorded", label: "Not recorded", voluntary: false };
  const known = REASON_BY_NORM.get(n);
  if (known) return known;
  return { key: "other:" + n.replace(/\s+/g, "_").slice(0, 40), label: String(raw).trim().slice(0, 60), voluntary: false };
}

// ---- Roles ---------------------------------------------------------------------------------------
// SUPERSEDED 16 September 2026 for role classification: the owner's rule is that a person's role is
// their pay classification, which services/classification.js maps and which is what every page now
// shows. This job-title guess is still computed — it is one pass over records already in hand — and is
// still the only other signal about someone whose pay scale is missing, but no page reads it.
// Same shape as the job-title tests in services/eh-labour.js: match the title, most specific first.
// Each person gets ONE primary role, so the mix adds up to the headcount rather than double-counting
// the educational leader who is also a teacher. Order is the precedence, and it is stated on the page.
const ROLES = Object.freeze([
  { key: "edu_leader", label: "Educational leader", re: /educational\s*leader/i },
  { key: "ect", label: "Early childhood teacher", re: /early\s*childhood\s*teacher|\bect\b|\bteacher\b/i },
  { key: "management", label: "Management", re: /manager|director|\bcoo\b|\bcfo\b|\bceo\b|coordinator|officer/i },
  { key: "room_leader", label: "Room leader", re: /room\s*leader|\blead\s*educator\b/i },
  { key: "support", label: "Kitchen, cleaning & maintenance", re: /chef|kitchen|cook|clean|maintenance|garden/i },
  { key: "educator", label: "Educator", re: /educator|\bcse\b|trainee|support\s*worker|assistant/i },
]);
const ROLE_KEYS = Object.freeze(ROLES.map((r) => r.key).concat("other"));
// "Early Childhood Educator" must not read as a teacher, so support/educator titles are tested for
// first where they overlap: an "Assistant to Executive Chef" is kitchen, not an assistant educator.
function roleOf(jobTitle) {
  const t = String(jobTitle || "");
  if (/chef|kitchen|cook|clean|maintenance/i.test(t)) return "support";
  if (/educator/i.test(t) && !/educational\s*leader/i.test(t)) return /room\s*leader/i.test(t) ? "room_leader" : "educator";
  for (const r of ROLES) if (r.re.test(t)) return r.key;
  return "other";
}

// ---- Dates ---------------------------------------------------------------------------------------
const d10 = (s) => {
  const v = String(s == null ? "" : s).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
};
const monthOf = (date) => (date ? date.slice(0, 7) : null);
const monthEnd = (ym) => {
  const [y, mo] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`;
};
const addMonths = (ym, n) => {
  const [y, mo] = ym.split("-").map(Number);
  const t = y * 12 + (mo - 1) + n;
  return `${String(Math.floor(t / 12)).padStart(4, "0")}-${String((((t % 12) + 12) % 12) + 1).padStart(2, "0")}`;
};
const monthsBetween = (from, to) => {
  const out = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
};

const isCasual = (e) => String((e && e.employmentType) || "") === "Casual";
// Rule 4: never a tenure threshold. On or before the start date means they never worked a day; one day
// after it means they did, and that is turnover.
const neverStarted = (e) => {
  const s = d10(e && e.startDate), f = d10(e && e.endDate);
  return !!(s && f && f <= s);
};

// The employee's centre, resolved the way payroll's own hierarchy resolves it (eh-labour.centreLocation):
// walk up from the recorded location to the direct child of the organisation, which is the centre or
// cost centre, then map that name to an OWNA centre with eh-labour.ownaIdFor. `primaryLocation` comes
// back as a path ("Futuro Early Learning / Futuro Bardia / Bardia Kitchen"), so it is matched against
// the location list by full path; anything unresolvable falls back to the path's own centre segment.
function buildLocationIndex(locations) {
  const byId = new Map((locations || []).map((l) => [String(l.id), l]));
  const byPath = new Map();
  for (const l of locations || []) {
    const parts = [];
    let cur = l, guard = 0;
    while (cur && guard++ < 50) { parts.unshift(cur.name); cur = cur.parentId == null ? null : byId.get(String(cur.parentId)); }
    byPath.set(parts.join(" / ").toLowerCase(), l);
  }
  return { byId, byPath };
}
function centreOf(primaryLocation, index, locations, centres) {
  const path = String(primaryLocation || "").trim();
  if (!path) return NO_CENTRE;
  let name = null;
  const loc = index.byPath.get(path.toLowerCase());
  if (loc) { try { name = centreLocation(loc.id, locations); } catch { name = null; } }
  if (!name) {
    // The location list did not have it (renamed, archived): read the path itself. The organisation is
    // the first segment, so the centre is the second — the same rule centreLocation applies.
    const segs = path.split("/").map((s) => s.trim()).filter(Boolean);
    name = segs.length > 1 ? segs[1] : null;
  }
  if (!name) return NO_CENTRE;
  return ownaIdFor(name, centres) || NO_CENTRE;
}

// ---- The snapshot ---------------------------------------------------------------------------------
async function runTalentSnapshot({ log = console.log, dryRun = false, today = cal.today() } = {}) {
  if (!eh.hasCreds()) { log("[talent] no payroll credentials — skipping"); return { skipped: true, reason: "no Employment Hero credentials configured" }; }

  const employees = await eh.allEmployees();
  if (!Array.isArray(employees)) throw new Error("Employment Hero returned an invalid employee list.");
  // An empty employee list from a payroll that had hundreds yesterday is an anomaly, not a business
  // with nobody in it. Return WITHOUT touching the tables: the caller flags it, the last good counts
  // stay on the page, and a real outage cannot quietly erase the history. (The wages import treats an
  // empty pay-run response the same way, for the same reason.)
  if (!employees.length) return { ok: true, employees: 0, rows: 0, months: 0, from: null, to: null,
    headcount: 0, casual_headcount: 0, terminations: 0, casual_leavers: 0, never_started: 0,
    turnover_leavers: 0, undated_terminations: 0, centres: 0,
    scales: 0, on_scales: 0, unmapped_scales: 0, unclassified_people: 0 };
  const locations = await eh.locations();
  if (!Array.isArray(locations)) throw new Error("Employment Hero returned an invalid location list.");
  const index = buildLocationIndex(locations);
  const centres = db.prepare(`SELECT owna_id, name FROM centres`).all();

  // Reduce each record to the handful of facts this job counts, then let the record go. Nothing below
  // this loop can see a name, an id or a date of birth, because nothing below is given one.
  const people = [];
  let noEndDate = 0;
  for (const e of employees || []) {
    const start = d10(e && e.startDate);
    const end = d10(e && e.endDate);
    const terminated = String((e && e.status) || "") === "Terminated";
    if (terminated && !end) noEndDate += 1; // a termination we cannot date: counted, never guessed at
    people.push({
      centre: centreOf(e && e.primaryLocation, index, locations, centres),
      casual: isCasual(e),
      never: neverStarted(e),
      // Payroll says they have left but not when. They cannot be a leaver in any month, and leaving
      // them in the headcount would keep them employed for ever, so they are in NO month's counts and
      // the number of them is reported instead of being quietly absorbed.
      undated: terminated && !end,
      // The reported role: the pay scale, mapped. The scale string itself is kept only so the mapping
      // can be listed on /admin/pay-scales — it names a rate, not a person.
      scale: cls.normalise(e && e.payRateTemplate),
      cls: cls.categoryOf(e && e.payRateTemplate),
      role: roleOf(e && e.jobTitle),
      start, end,
      reason: reasonOf(e && e.terminationReason),
    });
  }

  // The window covers every month payroll actually has history for, so the reconciliation on the page
  // is the tenant's whole story rather than a slice of it; clamped so one impossible date cannot make
  // twenty thousand rows.
  const thisMonth = today.slice(0, 7);
  const dates = people.flatMap((p) => [p.start, p.end]).filter(Boolean).sort();
  const floor = addMonths(thisMonth, -MAX_HISTORY_MONTHS);
  const firstMonth = dates.length ? (monthOf(dates[0]) < floor ? floor : monthOf(dates[0])) : thisMonth;
  const months = monthsBetween(firstMonth > thisMonth ? thisMonth : firstMonth, thisMonth);

  const centreRows = new Map();   // `${owna_id}|${month}` -> row
  const groupRows = new Map();    // month -> row
  const reasonRows = new Map();   // `${owna_id}|${month}|${key}` -> row
  const zeros = (prefix) => Object.fromEntries(cls.CATEGORY_KEYS.map((k) => [prefix + k, 0]));
  const blankCentre = (owna_id, month) => ({
    owna_id, month, headcount: 0, starters: 0, leavers: 0, never_started: 0,
    ...zeros("cls_"),   // the reported mix: pay classification, permanent staff only
    ect: 0, edu_leader: 0, room_leader: 0, educator: 0, management: 0, support: 0, other: 0,
  });
  const blankGroup = (month) => ({
    month, headcount: 0, casual_headcount: 0, starters: 0, casual_starters: 0,
    raw_terminations: 0, casual_leavers: 0, never_started: 0, leavers: 0,
    ...zeros("cas_"),   // the casual headcount by category — group level, never per centre
  });
  const centreRow = (owna_id, month) => {
    const k = owna_id + "|" + month;
    if (!centreRows.has(k)) centreRows.set(k, blankCentre(owna_id, month));
    return centreRows.get(k);
  };
  for (const month of months) groupRows.set(month, blankGroup(month));

  for (const month of months) {
    // Headcount is taken on the last day of the month — except the month we are standing in, which is
    // taken TODAY. Asking a half-finished month for its 30th would count someone who has already left
    // this week as gone and someone who starts next week as here, and the headline headcount on the
    // page would then be a number nobody in the building recognises.
    const end = month === thisMonth ? today : monthEnd(month);
    const g = groupRows.get(month);
    for (const p of people) {
      const startedInMonth = p.start && monthOf(p.start) === month;
      const endedInMonth = p.end && monthOf(p.end) === month;

      // --- casuals: group only, and never turnover (rules 2 and 3) ---
      if (p.casual) {
        if (!p.undated && p.start && p.start <= end && (!p.end || p.end >= end)) {
          g.casual_headcount += 1;
          g["cas_" + p.cls] += 1;   // broken down by category, still one group figure
        }
        if (startedInMonth) g.casual_starters += 1;
        if (endedInMonth) { g.raw_terminations += 1; g.casual_leavers += 1; }
        continue;
      }

      // --- never started: counted so it can be shown and subtracted, never a leaver (rule 4) ---
      if (p.never) {
        if (endedInMonth) {
          g.raw_terminations += 1;
          g.never_started += 1;
          centreRow(p.centre, month).never_started += 1;
        }
        continue; // and never in the headcount denominator either
      }

      const row = centreRow(p.centre, month);
      if (!p.undated && p.start && p.start <= end && (!p.end || p.end >= end)) {
        row.headcount += 1;
        row["cls_" + p.cls] += 1;
        row[ROLE_KEYS.includes(p.role) ? p.role : "other"] += 1;
        g.headcount += 1;
      }
      if (startedInMonth) { row.starters += 1; g.starters += 1; }
      if (endedInMonth) {
        row.leavers += 1;
        g.raw_terminations += 1;
        g.leavers += 1;
        const rk = `${p.centre}|${month}|${p.reason.key}`;
        if (!reasonRows.has(rk)) reasonRows.set(rk, { owna_id: p.centre, month, reason_key: p.reason.key, reason_label: p.reason.label, leavers: 0 });
        reasonRows.get(rk).leavers += 1;
      }
    }
    // The basis, by construction rather than by assertion: every termination is in exactly one of the
    // three buckets, so the page's "raw − casuals − never started = turnover" line cannot drift.
    if (g.leavers !== g.raw_terminations - g.casual_leavers - g.never_started) {
      throw new Error("Termination reconciliation failed; no talent counts saved.");
    }
  }

  // ---- The mapping itself, so it can be reviewed rather than taken on trust ----------------------
  // Every distinct pay scale carried by someone employed TODAY, how many people are on it, and which
  // category the rule puts it in. This is what /admin/pay-scales lists, and it is the whole reason the
  // scale string is kept: a scale no rule matches appears there under its own name with its headcount,
  // instead of disappearing into "Unclassified" with nothing to look up.
  const employedNow = (p) => !p.undated && !!p.start && p.start <= today && (!p.end || p.end >= today);
  const scaleRows = new Map();
  for (const p of people) {
    if (!employedNow(p)) continue;
    let r = scaleRows.get(p.scale);
    if (!r) {
      r = { scale: p.scale, category: p.cls, people: 0, permanent: 0, casual: 0, matched: cls.classify(p.scale).matched ? 1 : 0 };
      scaleRows.set(p.scale, r);
    }
    r.people += 1;
    if (p.casual) r.casual += 1; else r.permanent += 1;
  }
  const scaleList = [...scaleRows.values()];
  const onScales = scaleList.reduce((a, r) => a + r.people, 0);
  const unclassifiedPeople = scaleList.filter((r) => r.category === "unclassified").reduce((a, r) => a + r.people, 0);

  const totals = [...groupRows.values()].reduce((a, g) => ({
    raw: a.raw + g.raw_terminations, casual: a.casual + g.casual_leavers,
    never: a.never + g.never_started, leavers: a.leavers + g.leavers,
  }), { raw: 0, casual: 0, never: 0, leavers: 0 });
  const latest = groupRows.get(months[months.length - 1]) || blankGroup(thisMonth);
  const summary = {
    ok: true, employees: people.length, months: months.length,
    rows: centreRows.size + groupRows.size + reasonRows.size + scaleRows.size,
    centre_rows: centreRows.size, group_rows: groupRows.size, reason_rows: reasonRows.size,
    // The classification picture, so a run says how much of payroll the mapping actually covers.
    scales: scaleRows.size, on_scales: onScales,
    unmapped_scales: scaleList.filter((r) => !r.matched).length,
    unclassified_people: unclassifiedPeople,
    from: months[0], to: months[months.length - 1],
    headcount: latest.headcount, casual_headcount: latest.casual_headcount,
    terminations: totals.raw, casual_leavers: totals.casual, never_started: totals.never, turnover_leavers: totals.leavers,
    undated_terminations: noEndDate,
    centres: new Set([...centreRows.values()].map((r) => r.owna_id)).size,
  };
  if (dryRun) return summary;

  const CLS_COLS = cls.CATEGORY_KEYS.map((k) => "cls_" + k).join(",");
  const CLS_VALS = cls.CATEGORY_KEYS.map((k) => "@cls_" + k).join(",");
  const CAS_COLS = cls.CATEGORY_KEYS.map((k) => "cas_" + k).join(",");
  const CAS_VALS = cls.CATEGORY_KEYS.map((k) => "@cas_" + k).join(",");
  const delCentre = db.prepare(`DELETE FROM talent_monthly`);
  const delGroup = db.prepare(`DELETE FROM talent_group_monthly`);
  const delReason = db.prepare(`DELETE FROM talent_reasons_monthly`);
  const delScales = db.prepare(`DELETE FROM talent_pay_scales`);
  const insCentre = db.prepare(`
    INSERT INTO talent_monthly (owna_id, month, headcount, starters, leavers, never_started,
      ${CLS_COLS}, ect, edu_leader, room_leader, educator, management, support, other, updated_at)
    VALUES (@owna_id,@month,@headcount,@starters,@leavers,@never_started,
      ${CLS_VALS},@ect,@edu_leader,@room_leader,@educator,@management,@support,@other,datetime('now'))`);
  const insGroup = db.prepare(`
    INSERT INTO talent_group_monthly (month, headcount, casual_headcount, starters, casual_starters,
      raw_terminations, casual_leavers, never_started, leavers, ${CAS_COLS}, updated_at)
    VALUES (@month,@headcount,@casual_headcount,@starters,@casual_starters,
      @raw_terminations,@casual_leavers,@never_started,@leavers,${CAS_VALS},datetime('now'))`);
  const insScale = db.prepare(`
    INSERT INTO talent_pay_scales (scale, category, people, permanent, casual, matched, updated_at)
    VALUES (@scale,@category,@people,@permanent,@casual,@matched,datetime('now'))`);
  const insReason = db.prepare(`
    INSERT INTO talent_reasons_monthly (owna_id, month, reason_key, reason_label, leavers, updated_at)
    VALUES (@owna_id,@month,@reason_key,@reason_label,@leavers,datetime('now'))`);
  db.transaction(() => {
    // Rebuild the window rather than merge into it: a correction in payroll (a start date fixed, a
    // termination reversed) has to be able to take a count back down, which an upsert alone cannot do.
    delCentre.run(); delGroup.run(); delReason.run(); delScales.run();
    for (const r of centreRows.values()) insCentre.run(r);
    for (const r of groupRows.values()) insGroup.run(r);
    for (const r of reasonRows.values()) insReason.run(r);
    for (const r of scaleList) insScale.run(r);
  })();

  log(`[talent] ${summary.months} months to ${summary.to}: ${summary.headcount} permanent, ${summary.casual_headcount} casual (group), `
    + `${totals.raw} terminations − ${totals.casual} casual − ${totals.never} never started = ${totals.leavers} turnover events`);
  if (noEndDate) log(`[talent] ${noEndDate} terminated record(s) carry no end date and are in no month's counts`);
  log(`[talent] role from pay classification: ${summary.scales} distinct pay scale(s) across ${summary.on_scales} people`
    + (summary.unmapped_scales ? `, ${summary.unmapped_scales} unmapped covering ${summary.unclassified_people} people — see /admin/pay-scales` : ", all mapped"));
  return summary;
}

module.exports = {
  runTalentSnapshot, roleOf, reasonOf, isCasual, neverStarted, centreOf, buildLocationIndex,
  CESSATION_REASONS, ROLES, ROLE_KEYS, NO_CENTRE, monthEnd, addMonths, monthsBetween,
  // The reported role classification, re-exported so a caller needs one require, not two.
  classify: cls.classify, categoryOf: cls.categoryOf, CATEGORIES: cls.CATEGORIES, CATEGORY_KEYS: cls.CATEGORY_KEYS,
};
