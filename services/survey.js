// eNPS survey — the owner's spec of 16 September 2026: "trial the eNPS first, all centres, magic links
// emailed, anonymous, 3 questions."
//
// ============================ THE ANONYMITY GUARANTEE ============================
// Two tables, deliberately severed, with no foreign key between them:
//
//   survey_invitations   token, round, centre, issued/sent, spent or not — and NOTHING about a person. No name,
//                        no employee id, no email address. The address is needed at SEND TIME only: the
//                        export reads it from payroll, writes it into the file the admin mail-merges
//                        from, and drops it. It is never written to this database. Nor is a person
//                        implied by a row's POSITION — see exportRows() for why that had to be bought
//                        with a key rather than assumed. The one column that says WHOSE a row is,
//                        assign_rank, says it only to someone holding that key: it is an HMAC of the
//                        round, the centre and a payroll id, the key lives in the environment, and
//                        without it the value is 64 hex characters that match nothing.
//   survey_responses     round, centre, score, the two free-text answers, the DAY it was submitted —
//                        and nothing that says which invitation it came from.
//
// When someone submits, submit() below marks the token used in one table and inserts the answer in the
// other, in one transaction, with no value passed from the first row to the second beyond the round and
// the centre. That is what makes the response rate and the chase-up possible while leaving nobody —
// including an administrator with the database file in front of them — able to connect an answer to a
// person.
//
// The leak is time, and a day is not coarse enough to close it. If the invitation side recorded the day
// a token was spent, (round, centre, day) would be a three-column join between the two tables: on any
// day one person at a centre answers, that join returns a single invitation, and the mail-merge file
// names them. So only the response side carries a day — survey_responses.submitted_on. The invitation
// side records THAT a token was spent and never when. The invitation rowid is no help either: it is
// assigned when the round is generated, not when the token is spent.
//
// The round and the centre ARE carried on both sides, because per-centre reporting is the point. They
// are group attributes, not a joining value: the smallest centre has four staff, which is exactly why
// MIN_RESPONSES below exists and why no centre is reported until at least that many answers stand
// behind it. A centre with fewer than MIN_RESPONSES people invited can never reach that threshold, so
// its answers are not carried under it at all — see reportingBucket() — and a withheld centre publishes
// no invited count and no response rate, because the two together give the withheld count back exactly.
// ================================================================================
const crypto = require("crypto");
const db = require("../db/db");
const cal = require("./calendar");
const { eh } = require("./eh");
// One mapping, not two: which OWNA centre a payroll location belongs to is already solved for wages and
// for the talent pipeline, and is reused here rather than copied.
const talent = require("./eh-talent");

// A centre is not reported until this many people have answered for it. Oran Park has 4 staff and
// Cobbitty 9, so a per-centre figure below this would identify people rather than describe a centre.
// Answers below the threshold are NOT discarded — they count in the group total.
const MIN_RESPONSES = 5;

// eNPS, the standard definition: 9-10 promote, 0-6 detract, 7-8 are passive and count in the
// denominator only.
const PROMOTER_FROM = 9;
const DETRACTOR_TO = 6;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Free text is two boxes on a page anyone can open. Cap them so a single submission cannot fill the disk.
const MAX_TEXT = 2000;

// The centre as question 1 words it. The stored name is "Futuro Childcare & Education - Austral"; the
// question is "How likely are you to recommend Futuro Austral?", so the label is the tail. Same
// transformation the views already use for the nav and the page headings.
function centreLabel(name) {
  return String(name || "").replace(/Futuro Childcare (and|&) Education\s*-?\s*/i, "").replace(/^Futuro\s+/i, "").trim();
}
// A payroll location that is not a centre — head office and similar. They are staff and they get the
// survey; their question reads "…recommend Futuro Early Learning?", which is the thing they work for.
const NO_CENTRE_LABEL = "Early Learning";

// ---- The three questions, verbatim ---------------------------------------------------------------
// Only the first is required. Kept here so the page, the email draft and the tests cannot drift apart.
function questions(label) {
  return [
    { key: "score", required: true, text: `How likely are you to recommend Futuro ${label}?` },
    { key: "reason", required: false, text: "What is the reason for your score?" },
    { key: "other", required: false, text: "Any other feedback you would like to add?" },
  ];
}

// ---- Rounds --------------------------------------------------------------------------------------
function createRound({ name, opens_on, closes_on, kind = "enps" }) {
  const nm = String(name || "").trim().slice(0, 120);
  if (!nm) throw new Error("Give the round a name.");
  if (!DATE_RE.test(opens_on) || !DATE_RE.test(closes_on)) throw new Error("Opening and closing dates are required (YYYY-MM-DD).");
  if (closes_on < opens_on) throw new Error("The closing date cannot be before the opening date.");
  const info = db.prepare(`INSERT INTO survey_rounds (kind, name, opens_on, closes_on, created_at)
    VALUES (?,?,?,?,datetime('now'))`).run(kind, nm, opens_on, closes_on);
  return round(info.lastInsertRowid);
}
function round(id) { return db.prepare("SELECT * FROM survey_rounds WHERE id = ?").get(id) || null; }
function rounds() { return db.prepare("SELECT * FROM survey_rounds ORDER BY opens_on DESC, id DESC").all(); }
// Move a round's closing date — the one thing an admin realistically needs to change mid-flight.
function setClosesOn(id, closes_on) {
  const r = round(id);
  if (!r) throw new Error("No such round.");
  if (!DATE_RE.test(closes_on)) throw new Error("A closing date is required (YYYY-MM-DD).");
  if (closes_on < r.opens_on) throw new Error("The closing date cannot be before the opening date.");
  db.prepare("UPDATE survey_rounds SET closes_on = ? WHERE id = ?").run(closes_on, id);
  return round(id);
}
// upcoming | open | closed, on the Sydney date. Both dates are inclusive.
function roundState(r, today = cal.today()) {
  if (!r) return "closed";
  if (today < r.opens_on) return "upcoming";
  if (today > r.closes_on) return "closed";
  return "open";
}
// The round a result page should show by default: the one that is open, else the most recently closed.
function currentRound(today = cal.today()) {
  const all = rounds();
  return all.find((r) => roundState(r, today) === "open")
    || all.filter((r) => roundState(r, today) === "closed").sort((a, b) => (a.closes_on < b.closes_on ? 1 : -1))[0]
    || all[0] || null;
}

// ---- Invitations ---------------------------------------------------------------------------------
// 32 random bytes, base64url. Long enough that guessing one is not a strategy, and URL-safe so the
// magic link survives a mail merge intact.
function newToken() { return crypto.randomBytes(32).toString("base64url"); }

// Issue one token per RANK that does not have one yet, and return every invitation for that round
// grouped by centre. Called by the export; safe to call again, and that is the point — a rank is a
// person's own keyed value (see exportRows), so calling this a second time mints a row for a new starter
// and nothing at all for anybody who already has one. It is idempotent per person rather than per
// headcount, which is what stops a re-run handing someone a second live link.
function ensureInvitations(roundId, wantByCentre, today = cal.today()) {
  const r = round(roundId);
  if (!r) throw new Error("No such round.");
  // issued_on is a ROUND-WIDE date, which is the whole of what it is allowed to be: a row carrying its
  // own date is a row that can be told from its neighbours, and at a centre where one person started
  // this week, "the invitation issued on Tuesday" and "the person who started on Tuesday" are the same
  // sentence. So a token minted for a new starter joins the date the round was issued on.
  const issuedOn = (db.prepare("SELECT MIN(issued_on) d FROM survey_invitations WHERE round_id = ?").get(roundId) || {}).d || today;
  const ins = db.prepare(`INSERT INTO survey_invitations (token, round_id, owna_id, centre_label, issued_on, assign_rank)
    VALUES (?,?,?,?,?,?)`);
  // Over the whole ROUND, not one centre of it: a rank names one person, and the unique index on
  // (round_id, assign_rank) says so too. A payroll record that turns up under two locations must still
  // come away with one token rather than a constraint error.
  const have = new Set(db.prepare(`SELECT assign_rank FROM survey_invitations
    WHERE round_id = ? AND assign_rank IS NOT NULL`).all(roundId).map((x) => x.assign_rank));
  db.transaction(() => {
    for (const { owna_id, centre_label, ranks } of wantByCentre) {
      // In RANK order, never in the order the caller holds its people. The caller reads payroll, and
      // payroll order is a name for every row: mint a centre's tokens in payroll order and rowid order
      // pairs them off against the payroll list for anyone holding this file, with no key and nothing
      // kept. Rank order is the keyed order, which without the key is no order at all.
      for (const rank of [...(ranks || [])].sort()) {
        if (have.has(rank)) continue;
        ins.run(newToken(), roundId, owna_id, centre_label, issuedOn, rank);
        have.add(rank);            // a payroll list that names someone twice must still get one token
      }
    }
  })();
  return invitationPool(roundId);
}

// The invitations a round already has, grouped by centre. Reads, and only reads — the preview in
// exportRows() runs on this alone, so that looking at a round cannot bring its tokens into existence.
//
// rowid order is creation order. It is a STABLE order and not a meaningful one: which person takes
// which of these rows is decided by the rank each row carries, so a rowid is not an employee number.
function invitationPool(roundId) {
  const all = db.prepare(`SELECT rowid AS rid, token, owna_id, centre_label, used, assign_rank
                          FROM survey_invitations WHERE round_id = ? ORDER BY rowid`).all(roundId);
  const byCentre = new Map();
  for (const inv of all) {
    const k = inv.owna_id == null ? "" : inv.owna_id;
    if (!byCentre.has(k)) byCentre.set(k, []);
    byCentre.get(k).push(inv);
  }
  return byCentre;
}

function invitation(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  return db.prepare("SELECT * FROM survey_invitations WHERE token = ?").get(token) || null;
}

// What the public magic-link page should do with this token. Deliberately ONE unusable outcome rather
// than several: an unknown token, a spent token and a closed round all come back as `closed`, so the
// page cannot be used to find out which tokens exist. See routes/survey.js.
function tokenState(token, today = cal.today()) {
  const inv = invitation(token);
  if (!inv) return { state: "closed" };
  const r = round(inv.round_id);
  if (!r || roundState(r, today) !== "open" || inv.used) return { state: "closed" };
  return { state: "open", invitation: inv, round: r, label: inv.centre_label, questions: questions(inv.centre_label) };
}

function parseScore(v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  if (!/^(10|[0-9])$/.test(String(v).trim())) return null;
  return Number(String(v).trim());
}
const cleanText = (v) => {
  const s = String(v == null ? "" : v).replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT);
  return s || null;
};

// Which centre an answer may be FILED under, which is not always the centre the invitation was issued
// for. A centre with fewer than MIN_RESPONSES people invited can never reach the reporting threshold, so
// a per-centre figure for it will never be published — while the stored row would still read "one of
// these four named people wrote this" to anyone holding the file or writing the next query against it.
// Carrying the centre there buys no report and costs the guarantee, so the answer is filed under the
// group bucket instead, where it counts in the group figure exactly as before.
function reportingBucket(inv) {
  const n = db.prepare("SELECT COUNT(*) n FROM survey_invitations WHERE round_id = ? AND owna_id IS ?").get(inv.round_id, inv.owna_id).n;
  return n >= MIN_RESPONSES
    ? { owna_id: inv.owna_id, centre_label: inv.centre_label }
    : { owna_id: null, centre_label: NO_CENTRE_LABEL };
}

// Record an answer. Returns { ok: true } or { ok: false, reason: 'closed' | 'score' }.
//
// >>> THE SEVERING HAPPENS HERE. <<<
// One transaction, two tables, and the only values that cross from the invitation to the response are
// the round and the centre — group attributes both, never the token, never the invitation's rowid,
// never a timestamp finer than a day. After this returns there is nothing in the database, and nothing
// derivable from it, that ties this answer back to the invitation that produced it, and therefore
// nothing that ties it back to a person. A test in tests/enps.test.js proves it.
function submit(token, answers, today = cal.today()) {
  const st = tokenState(token, today);
  if (st.state !== "open") return { ok: false, reason: "closed" };
  const score = parseScore(answers && answers.score);
  if (score === null) return { ok: false, reason: "score", label: st.label, questions: st.questions };
  const inv = st.invitation;
  const reason = cleanText(answers && answers.reason);
  const other = cleanText(answers && answers.other);
  const done = db.transaction(() => {
    // Spend the token. A flag, not a date: the day is written on the response side only, so it cannot be
    // matched back. The WHERE clause re-checks `used` so two submissions racing on the same token cannot
    // both write an answer.
    const spent = db.prepare("UPDATE survey_invitations SET used = 1 WHERE token = ? AND used = 0").run(token).changes;
    if (!spent) return false;
    const bucket = reportingBucket(inv);
    db.prepare(`INSERT INTO survey_responses (round_id, owna_id, centre_label, score, reason, other, submitted_on)
      VALUES (?,?,?,?,?,?,?)`).run(inv.round_id, bucket.owna_id, bucket.centre_label, score, reason, other, today);
    return true;
  })();
  return done ? { ok: true } : { ok: false, reason: "closed" };
}

// ---- The arithmetic ------------------------------------------------------------------------------
// eNPS = %promoters (9-10) − %detractors (0-6). 7-8 are passives: they are in the denominator and in
// neither percentage, which is what drags a score of all-sevens to zero rather than leaving it undefined.
function enps(scores) {
  // Number(null) is 0 and Number(false) is 0, and a 0 is a detractor — so the coercion has to be fenced
  // off, or a missing value would silently count as the worst possible answer.
  const list = (scores || [])
    .filter((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== ""))
    .map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 10);
  const n = list.length;
  const promoters = list.filter((s) => s >= PROMOTER_FROM).length;
  const detractors = list.filter((s) => s <= DETRACTOR_TO).length;
  const passives = n - promoters - detractors;
  return {
    n, promoters, passives, detractors,
    // Rounded to a whole number, like every other NPS figure on the dashboard.
    enps: n ? Math.round((promoters / n) * 100 - (detractors / n) * 100) : null,
  };
}

// ---- Results -------------------------------------------------------------------------------------
// The group figure, one row per centre, and the response rate. `scoped` is a centre-scoped user's
// owna_id: they get their own centre's row and nothing else.
//
// A centre with fewer than MIN_RESPONSES answers is shown as "too few responses to report" — its
// answers still count in the group total, they are simply not reported as that centre's figure. That
// covers the invited count and the response rate as well as the score: see the comment below.
function results(roundId, { scoped = null, today = cal.today() } = {}) {
  const r = round(roundId);
  if (!r) return null;
  const responses = db.prepare("SELECT owna_id, centre_label, score FROM survey_responses WHERE round_id = ?").all(roundId);
  const invited = db.prepare(`SELECT owna_id, centre_label, COUNT(*) invited, SUM(used) used
                              FROM survey_invitations WHERE round_id = ? GROUP BY owna_id, centre_label`).all(roundId);

  const group = enps(responses.map((x) => x.score));
  const totalInvited = invited.reduce((a, x) => a + x.invited, 0);

  const key = (id) => (id == null ? "" : id);
  const byCentre = new Map();
  for (const inv of invited) byCentre.set(key(inv.owna_id), { owna_id: inv.owna_id, label: inv.centre_label, invited: inv.invited, scores: [] });
  for (const x of responses) {
    const k = key(x.owna_id);
    if (!byCentre.has(k)) byCentre.set(k, { owna_id: x.owna_id, label: x.centre_label, invited: 0, scores: [] });
    byCentre.get(k).scores.push(x.score);
  }
  let centres = [...byCentre.values()].map((c) => {
    const e = enps(c.scores);
    const reportable = e.n >= MIN_RESPONSES;
    return {
      owna_id: c.owna_id, label: c.label, responses: e.n,
      // The invited count and the response rate go too. Neither identifies anybody alone, but the rate
      // is rounded to 0.1% — a bijection onto the response count at any headcount Futuro has — so the
      // pair hands back the exact number the threshold just withheld: four invited at 25% is "one of
      // these four named people answered". The chase-up numbers live on /admin/survey instead, which is
      // admin/ops only and is where chasing happens.
      invited: reportable ? c.invited : null,
      response_rate: reportable && c.invited ? Math.round((e.n / c.invited) * 1000) / 10 : null,
      reportable,
      enps: reportable ? e.enps : null,
      promoters: reportable ? e.promoters : null,
      passives: reportable ? e.passives : null,
      detractors: reportable ? e.detractors : null,
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
  if (scoped) centres = centres.filter((c) => c.owna_id === scoped);

  return {
    round: r, state: roundState(r, today),
    group: { ...group, invited: totalInvited, response_rate: totalInvited ? Math.round((group.n / totalInvited) * 1000) / 10 : null },
    centres,
    min_responses: MIN_RESPONSES,
    withheld: centres.filter((c) => !c.reportable).length,
  };
}

// The free text. GROUP LEVEL ONLY and admin/ops only — a comment read beside the centre it came from is
// a much smaller haystack than a comment read beside the whole group. The centre is deliberately not
// returned. Ordered by id, which is submission order within a day and tells a reader nothing, because
// the invitation side carries no order of use to line it up against.
function comments(roundId) {
  return db.prepare(`SELECT submitted_on, score, reason, other FROM survey_responses
                     WHERE round_id = ? AND (reason IS NOT NULL OR other IS NOT NULL) ORDER BY id`).all(roundId);
}

// ---- Who gets one ---------------------------------------------------------------------------------
// Everyone employed today. `eh.allEmployees()` returns past staff as well, so a leaver is filtered out
// here by status and end date rather than assumed away.
function isActiveStaff(e, today) {
  if (!e) return false;
  if (String(e.status || "") === "Terminated") return false;
  const end = String(e.endDate || "").slice(0, 10);
  if (DATE_RE.test(end) && end < today) return false;   // finished before today
  return true;
}

// Active staff, each reduced to the three facts the export needs: a payroll id (to keep the order
// stable between runs — never written to the database), an email address (used to write the file and
// then dropped) and the centre. Nothing else is read off the record.
async function activeStaff({ today = cal.today() } = {}) {
  const employees = await eh.allEmployees();
  if (!Array.isArray(employees)) throw new Error("Employment Hero returned an invalid employee list.");
  const locations = await eh.locations();
  if (!Array.isArray(locations)) throw new Error("Employment Hero returned an invalid location list.");
  const index = talent.buildLocationIndex(locations);
  const centres = db.prepare("SELECT owna_id, name FROM centres").all();
  const nameById = new Map(centres.map((c) => [c.owna_id, c.name]));

  const staff = [], noEmail = [];
  for (const e of employees) {
    if (!isActiveStaff(e, today)) continue;
    const resolved = talent.centreOf(e && e.primaryLocation, index, locations, centres);
    const owna_id = resolved === talent.NO_CENTRE ? null : resolved;
    const centre_label = owna_id ? centreLabel(nameById.get(owna_id)) : NO_CENTRE_LABEL;
    const email = String((e && e.emailAddress) || "").trim();
    // A staff member with no address cannot be invited. Count them and say so on the page rather than
    // writing a blank row into the merge file, which would send nowhere and silently lose a person.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { noEmail.push({ owna_id, centre_label }); continue; }
    staff.push({ id: e.id, email, owna_id, centre_label });
  }
  // A stable order, so regenerating the file for the same round hands the same person the same link.
  staff.sort((a, b) => (Number(a.id) - Number(b.id)) || String(a.id).localeCompare(String(b.id)));
  return { staff, noEmail };
}

// ---- The mail-merge export -------------------------------------------------------------------------
// One row per active staff member: their address, their magic link, their centre. Generated on demand;
// the address goes into the file and nowhere else.
//
// WHICH of a centre's tokens a person gets is decided by a keyed shuffle. It used to be decided by
// POSITION — staff in payroll-id order, invitations in rowid order, paired off — and position is not a
// secret. Both halves of that pairing are available to anyone holding a copy of the database: the
// rowids are in it, and the staff list is the same eh.allEmployees() call this function makes. The
// whole token-to-person map fell out of the two of them, with no kept file needed, so an invitation's
// ordinal position within its centre was in every practical sense the stored employee id the schema
// promises this table does not hold.
//
// So the pairing is an HMAC of (round, centre, payroll id) under a key that lives in the environment and
// never in the database. With the key it is the same pairing every time, which is what makes a reminder
// possible without recording who was sent what. Without it, a database file and the payroll list pair
// nothing: every person in a centre is equally consistent with every one of its invitations.
//
// THE KEY MUST NOT BE KEPT WITH THE BACKUPS. It is the one thing that turns that file back into names.
//
// AND THE RANK IS WRITTEN ON THE INVITATION, at the moment it is issued. That is the difference between
// this and a shuffle. A shuffle gave a person a POSITION in their centre, and a position is a fact about
// their colleagues: change the set of payroll ids at a centre and every position moves, so the pairing
// could only ever be recomputed, never honoured. One resignation plus one new starter at the same centre
// on the same day is such a change while leaving the headcount alone — and the reminder then handed a
// survivor somebody else's link, which is a second live link in a real inbox and a second vote in the
// same eNPS figure. Recording the rank makes a person's token a fact about THEM: a leaver's row is never
// matched again, a joiner gets a freshly minted one, and every survivor keeps the exact token they were
// sent. Nothing is given away that was not already — the rank is the same keyed value the export has
// always computed, and without the key it pairs nobody. See db/schema.sql.
const ASSIGN_KEY = process.env.SURVEY_ASSIGN_KEY || process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
// Both read after the admin route's "Could not build the export: " and after "Last send failed: ".
const STAFF_LIST_MOVED = "the staff list has changed since this round was sent — merge the reminder from the file you saved";
const ASSIGN_KEY_MOVED = "SURVEY_ASSIGN_KEY is not the key this round's links were issued under, so which link is whose "
  + "cannot be worked out — restore that key, or merge the reminder from the file you saved. Nothing has been sent.";
function assignRank(roundId, centreKey, payrollId) {
  return crypto.createHmac("sha256", ASSIGN_KEY).update(`enps-assign|${roundId}|${centreKey}|${payrollId}`).digest("hex");
}

// The link a PREVIEW row carries where the round has no invitation yet. It is deliberately not a token:
// it matches nothing in survey_invitations, it opens the "this survey isn't open" page like any unknown
// token, and graphSendRound() refuses a batch containing it. See `preview` below for why it exists.
const PREVIEW_TOKEN = "PREVIEW-LINK-NOT-A-REAL-TOKEN";

// { preview: true } is READ-ONLY: it mints no token and stamps no sent_on, so it can be run on a whim.
// The dry run on the admin page — the owner's pre-flight, run repeatedly before the real send — goes
// through here, and looking at a round must not bring its tokens into existence.
//
// A preview reports against the invitations that already exist (after a real export or send, that is all
// of them, and the report is exact). Where a person has none yet — a round not issued at all, or a new
// starter since it was — the row carries PREVIEW_TOKEN so the count, the centre and the address are
// still real, which is what the dry run is for, and the link is visibly not anyone's.
async function exportRows(roundId, { baseUrl, today = cal.today(), preview = false } = {}) {
  const r = round(roundId);
  if (!r) throw new Error("No such round.");
  const { staff, noEmail } = await activeStaff({ today });

  const byCentre = new Map();
  for (const p of staff) {
    const k = p.owna_id == null ? "" : p.owna_id;
    if (!byCentre.has(k)) byCentre.set(k, []);
    byCentre.get(k).push(p);
  }
  // Every active person's own rank — their centre, this round and their payroll id under the key, and
  // nothing about anybody else.
  const rankOf = new Map();
  for (const [k, list] of byCentre) for (const p of list) rankOf.set(String(p.id), assignRank(roundId, k, p.id));

  let pool = invitationPool(roundId);
  const byRank = new Map();                       // rank -> the invitation carrying it, over the whole round
  const index = () => { byRank.clear(); for (const list of pool.values()) for (const inv of list) if (inv.assign_rank) byRank.set(inv.assign_rank, inv); };
  index();
  // A person's own row, wherever this round issued it. Their rank carries the centre they worked at when
  // it was issued, so somebody who has TRANSFERRED to another Futuro centre since reads as a leaver at
  // one and a new starter at the other — and minting for them would put a second live link in the inbox
  // of someone who may already have answered. So they are looked for at every centre this round knows
  // about, not only at today's one, and keep the link they were sent.
  const centreKeys = () => [...new Set([...pool.keys(), ...byCentre.keys()])];
  const mine = (p) => {
    const here = byRank.get(rankOf.get(String(p.id)));
    if (here) return here;
    for (const k of centreKeys()) { const there = byRank.get(assignRank(roundId, k, p.id)); if (there) return there; }
    return null;
  };

  // ---- Rounds issued before the rank was recorded ---------------------------------------------------
  // Their rows carry no rank, so there is exactly one way to know whose each one is: the pairing they
  // were handed out with — that centre's people ordered by rank against that centre's rows in rowid
  // order. That pairing is only sound while the centre's people are the same people, which is the count
  // check this export has always made, so it is made here, once, and the answer is written down. After
  // this a round is ranked and nobody's token depends on anybody else again.
  const unranked = [...pool.values()].flat().filter((inv) => !inv.assign_rank);
  if (unranked.length) {
    if (unranked.length !== [...pool.values()].flat().length) throw new Error(STAFF_LIST_MOVED); // half-ranked: cannot happen, never guess
    const moved = [...new Set([...pool.keys(), ...byCentre.keys()])]
      .some((k) => (pool.get(k) || []).length !== (byCentre.get(k) || []).length);
    if (moved) throw new Error(STAFF_LIST_MOVED);
    const adopted = [];
    for (const [k, list] of pool) {
      (byCentre.get(k) || []).map((p) => ({ id: String(p.id), rank: rankOf.get(String(p.id)) }))
        .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id.localeCompare(b.id)))
        .forEach((x, i) => { if (list[i]) { list[i].assign_rank = x.rank; byRank.set(x.rank, list[i]); adopted.push([x.rank, list[i].token]); } });
    }
    if (!preview) {
      const stampRank = db.prepare("UPDATE survey_invitations SET assign_rank = ? WHERE token = ? AND assign_rank IS NULL");
      db.transaction(() => { for (const [rank, token] of adopted) stampRank.run(rank, token); })();
    }
  }

  // ---- The key has to be the same key ---------------------------------------------------------------
  // A rank is an HMAC under ASSIGN_KEY, which falls back to SESSION_SECRET and then to a value minted for
  // this process alone. Change it and nobody's rank matches the row they were sent: every person reads as
  // a new starter, and minting for them all would hand the whole round a SECOND link — the exact thing
  // the rank exists to prevent. So a round that already holds invitations has to still recognise at least
  // one of the people on today's payroll. Recognising nobody is the key moving, not the staff.
  if (byRank.size && staff.length && !staff.some((p) => mine(p))) throw new Error(ASSIGN_KEY_MOVED);

  // Issue a token for anyone who does not have one yet — the whole round on the first export, one new
  // starter afterwards. Anybody the round already holds a row for is not in this list at all, which is
  // what makes running the export again a reminder rather than a second batch of links.
  if (!preview) {
    const wanted = new Map();
    for (const [k, list] of byCentre) for (const p of list) {
      if (mine(p)) continue;
      if (!wanted.has(k)) wanted.set(k, { owna_id: p.owna_id, centre_label: p.centre_label, ranks: [] });
      wanted.get(k).ranks.push(rankOf.get(String(p.id)));
    }
    if (wanted.size) { pool = ensureInvitations(roundId, [...wanted.values()], today); index(); }
  }

  const rows = staff.map((p) => {
    const inv = mine(p);
    // Every person was either matched above or minted one just now, so this cannot fire on a real
    // export; saying so is still better than a TypeError at the admin. A preview is the exception — a
    // round whose tokens have not been minted is exactly what it is there to look at.
    if (!inv && !preview) throw new Error(STAFF_LIST_MOVED);
    // A spent token here is this person's own — the pairing is unchanged, so they answered — and it has
    // to go back out spent. Minting them a fresh one because the flag is set would hand every
    // respondent a second working link on every reminder, which is the same defect from the other side.
    const token = inv ? inv.token : PREVIEW_TOKEN;
    // The centre on the row is the INVITATION's, which is the centre the magic link will ask them about
    // and the centre their answer will be filed under. The two are the same for everybody but a person
    // who has moved centres mid-round, and for them the invitation is the honest one.
    return { email: p.email, centre: inv ? inv.centre_label : p.centre_label, token, link: linkFor(baseUrl, token) };
  });
  // Record that this round has been handed out, so the page can say when it was last sent. Stamped over
  // the ROUND and not over the rows in the file, for the same reason issued_on is round-wide: the row of
  // someone who has since left payroll would otherwise keep an older date than everybody else's and be
  // the one row at that centre a reader could pick out. A preview hands nothing out and writes nothing.
  if (!preview) db.prepare("UPDATE survey_invitations SET sent_on = ? WHERE round_id = ?").run(today, roundId);
  return { rows, noEmail: noEmail.length, round: r, preview };
}

function linkFor(baseUrl, token) {
  return String(baseUrl || "").replace(/\/+$/, "") + "/s/" + token;
}

// RFC 4180 quoting, and a leading apostrophe on anything Excel would otherwise evaluate as a formula —
// this file is opened in Excel by definition, and an address starting with '=' must not become one.
function csv(rows) {
  const cell = (v) => {
    let s = String(v == null ? "" : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const head = ["email", "centre", "link"];
  return [head.join(","), ...rows.map((r) => [r.email, r.centre, r.link].map(cell).join(","))].join("\r\n") + "\r\n";
}

// ---- The invitation email --------------------------------------------------------------------------
// 217 of the 221 addresses are personal ones (gmail and similar), so this lands in a personal inbox. It
// has to say who it is from, why they got it, that it is anonymous and how, how long it takes and when
// it closes — or it reads as spam and nobody opens it.
function invitationEmail({ centre = "Early Learning", link = "", closesOn = "", contact = "" } = {}) {
  const close = closesOn ? friendlyDate(closesOn) : "the closing date";
  const subject = `Your say at Futuro ${centre} — 2 minutes, completely anonymous`;
  const body =
`Hi,

You're getting this because you work at Futuro ${centre}. We'd like to know what it's actually like to work here, so we're running a short anonymous survey — three questions, about two minutes.

Your link: ${link}

It's anonymous, and here is exactly how: the link doesn't carry your name, your email address or your employee number, and the answers are stored in a separate place from the list of links, with nothing joining the two. We can see how many people answered at each centre. We cannot see who said what — and neither can anyone else at Futuro, including whoever has access to the system.

Please don't name colleagues in your answers, so the comments stay safe for everyone to read.

The survey closes on ${close}. The link works once, from any phone or computer, and you don't need to log in to anything.

Thank you — it genuinely changes what we do next.

Futuro Early Learning — People & Culture${contact ? `\nQuestions about privacy: ${contact}` : ""}`;
  return { subject, body };
}
function friendlyDate(d) {
  if (!DATE_RE.test(String(d || ""))) return String(d || "");
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-AU", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
}

module.exports = {
  MIN_RESPONSES, PROMOTER_FROM, DETRACTOR_TO, NO_CENTRE_LABEL, MAX_TEXT,
  centreLabel, questions,
  createRound, round, rounds, setClosesOn, roundState, currentRound,
  newToken, ensureInvitations, invitationPool, invitation, tokenState, parseScore, submit,
  enps, results, comments,
  isActiveStaff, activeStaff, exportRows, PREVIEW_TOKEN, linkFor, csv,
  invitationEmail, friendlyDate,
};
