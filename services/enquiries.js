// Weekly enquiry counts from LineLeader, and the refresh that fills them.
//
// Read path and write path are deliberately separate. The read is a SQLite query and is instant; the
// refresh pulls every family row from LineLeader and takes minutes, so it only ever runs when something
// asks for it — the nightly snapshot, or an admin pressing the button. Same shape as ai_briefings.
//
// WHY THE FUNNEL IS TRACED THROUGH CHILDREN, NOT FAMILIES. LineLeader's family status is not maintained:
// of 1,499 families created in the last twelve months, 1,188 still sit at "New Family" and exactly one
// has ever reached "Tour Completed", while their children progress normally. A funnel built on family
// status reports near-zero conversion and is nonsense. So a lead's outcome is the furthest stage any of
// that family's enrolment records reached.
const db = require("../db/db");
const cal = require("./calendar");
const ll = require("./lineleader");

// LineLeader spells centres differently from OWNA — "Leppington Heath" is Heath Rd — and a lead can name
// a centre that has no OWNA id at all (a site that has not opened). Map what we can, keep the rest by
// their LineLeader name so an unmapped centre is visible rather than silently dropped.
// LineLeader spells centres differently from OWNA and a lead can name a site with no OWNA id at all.
// An explicit alias table rather than fuzzy matching: "Leppington Heath" is Heath Rd and nothing about
// the strings says so, and a near-miss that silently maps Oran Park onto Park Rd would be worse than no
// mapping. Anything unmatched keeps its LineLeader name and is reported as unmapped, never dropped.
const ALIAS = [
  [/leppington|heath/i, "heath rd"],
  [/gledswood/i,        "gledswood hills"],
  [/oran\s*park/i,      "oran park"],
  [/park\s*rd|park\s*road/i, "park rd"],
  [/cobbitty/i,         "cobbitty"],
  [/austral/i,          "austral"],
  [/bardia/i,           "bardia"],
];
function centreMap() {
  const out = new Map();
  for (const c of db.prepare(`SELECT owna_id, name FROM centres`).all()) {
    const short = String(c.name).replace(/Futuro Childcare\s*(and|&)\s*Education\s*-?\s*/i, "").trim().toLowerCase();
    out.set(short, c.owna_id);
  }
  return out;
}
function matchCentre(llName, map) {
  if (!llName) return null;
  // Oran Park must be tested before Park Rd, or "Oran Park" matches the Park Rd pattern.
  for (const [re, short] of ALIAS) if (re.test(llName)) return map.get(short) || null;
  const plain = String(llName).replace(/Futuro Childcare\s*(and|&)\s*Education\s*-?\s*/i, "").trim().toLowerCase();
  return map.get(plain) || null;
}

// The furthest stage a family's children reached. Ranked, because a family with two children counts at
// the better outcome — one child enrolling is not undone by a sibling's enquiry lapsing.
const RANK = { 1: 1, 2: 2, 11: 3, 3: 4, 4: 5, 13: 5, 12: 6, 5: 7, 8: 8, 6: 9, 7: 9, 9: 0, 10: 0 };
const REACHED_WAITLIST = 5, REACHED_OFFER = 6, ENROLLED = 9;

const upsert = db.prepare(`
  INSERT INTO enquiry_weekly (week_start, owna_id, ll_centre, leads, reached_waitlist, reached_offer, enrolled, refreshed_at)
  VALUES (@week_start, @owna_id, @ll_centre, @leads, @reached_waitlist, @reached_offer, @enrolled, datetime('now'))
  ON CONFLICT(week_start, ll_centre) DO UPDATE SET
    owna_id=@owna_id, leads=@leads, reached_waitlist=@reached_waitlist,
    reached_offer=@reached_offer, enrolled=@enrolled, refreshed_at=datetime('now')
`);

// Pull every family created since `since`, work out where each one's children got to, and write the
// weekly counts. Slow by nature — see the note at the top of db/schema.sql on this table.
async function refresh({ since, log = () => {} } = {}) {
  if (!ll.lineleader.hasCreds()) return { skipped: true, reason: "no LineLeader credentials configured" };
  const from = since || cal.addDays(cal.today(), -371);
  const map = centreMap();

  const families = (await ll.getAll("/families", { created_after: from }))
    .filter((f) => !/Z-Test/i.test((f.center && f.center.values && f.center.values.name) || ""));
  log(`[enquiries] ${families.length} families created since ${from}`);

  const cohort = new Map();                                   // family id -> { week, llCentre, ownaId }
  for (const f of families) {
    if (!f.created_date) continue;
    const week = mondayOf(String(f.created_date).slice(0, 10));
    if (!week) continue;
    const llCentre = (f.center && f.center.values && f.center.values.name) || "(no centre)";
    cohort.set(f.id, { week, llCentre, ownaId: matchCentre(llCentre, map) });
  }

  // Every enrolment record, any status, so a lead can be followed to its furthest stage.
  const best = new Map();
  for (const status of [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13]) {
    for (const r of await ll.getAll("/enrollments", { status_ids: [status] })) {
      const fid = r.family && r.family.id;
      if (!cohort.has(fid)) continue;
      const cur = best.get(fid);
      if (cur === undefined || (RANK[status] || 0) > (RANK[cur] || 0)) best.set(fid, status);
    }
  }
  log(`[enquiries] outcome known for ${best.size} of ${cohort.size} leads`);

  const cells = new Map();                                    // "week|llCentre" -> counts
  for (const [fid, c] of cohort) {
    const k = c.week + "|" + c.llCentre;
    if (!cells.has(k)) cells.set(k, { week_start: c.week, owna_id: c.ownaId, ll_centre: c.llCentre,
      leads: 0, reached_waitlist: 0, reached_offer: 0, enrolled: 0 });
    const cell = cells.get(k);
    cell.leads++;
    const rank = RANK[best.get(fid)] || 0;
    if (rank >= REACHED_WAITLIST) cell.reached_waitlist++;
    if (rank >= REACHED_OFFER) cell.reached_offer++;
    if (rank >= ENROLLED) cell.enrolled++;
  }

  const write = db.transaction((list) => { for (const c of list) upsert.run(c); });
  write([...cells.values()]);
  log(`[enquiries] ${cells.size} week-centre cells written`);
  return { families: families.length, cells: cells.size, since: from };
}

function mondayOf(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ""))) return null;
  const t = new Date(d + "T00:00:00Z");
  if (Number.isNaN(t.getTime())) return null;
  return cal.addDays(d, -((t.getUTCDay() + 6) % 7));
}

// ---- read side ----------------------------------------------------------
function weeks({ from, to, ownaId } = {}) {
  const where = [], args = {};
  if (from) { where.push("week_start >= @from"); args.from = from; }
  if (to) { where.push("week_start <= @to"); args.to = to; }
  if (ownaId) { where.push("owna_id = @owna"); args.owna = ownaId; }
  return db.prepare(`
    SELECT week_start, SUM(leads) AS leads, SUM(reached_waitlist) AS reached_waitlist,
           SUM(reached_offer) AS reached_offer, SUM(enrolled) AS enrolled
    FROM enquiry_weekly ${where.length ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY week_start ORDER BY week_start
  `).all(args);
}

function byCentre({ from, to } = {}) {
  const where = [], args = {};
  if (from) { where.push("e.week_start >= @from"); args.from = from; }
  if (to) { where.push("e.week_start <= @to"); args.to = to; }
  return db.prepare(`
    SELECT e.ll_centre, e.owna_id, c.name AS centre_name,
           SUM(e.leads) AS leads, SUM(e.reached_waitlist) AS reached_waitlist,
           SUM(e.reached_offer) AS reached_offer, SUM(e.enrolled) AS enrolled
    FROM enquiry_weekly e LEFT JOIN centres c ON c.owna_id = e.owna_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY e.ll_centre ORDER BY leads DESC
  `).all(args);
}

function lastRefreshed() {
  const r = db.prepare(`SELECT MAX(refreshed_at) AS at, COUNT(*) AS cells FROM enquiry_weekly`).get();
  return r && r.at ? r : null;
}

// matchCentre and centreMap are exported for the tests: the alias table is the part most likely to go
// wrong quietly, because an unmapped centre looks like a centre with no enquiries.
module.exports = { refresh, weeks, byCentre, lastRefreshed, mondayOf, matchCentre, centreMap };
