// Feedback from users trialling the dashboard: store, list, count, triage.
const db = require("../db/db");

// Areas and categories offered on the form (value + label). Kept here so the form and
// the admin list share one source of truth.
const AREAS = [
  "Overview", "People & Culture", "Quality & Compliance", "Action Plans",
  "Rostering", "Enrolment Pipeline", "Wages & Margin", "Safety & Incidents",
  "AI weekly briefing", "A specific centre page", "General / whole app",
];
const CATEGORIES = [
  ["missing", "Something missing — a metric/report/view I'd want"],
  ["data", "How the data is displayed (charts vs tables, what to show first)"],
  ["ui", "User interface / design"],
  ["ux", "User experience — navigation, speed, mobile"],
  ["bug", "Bug or error"],
  ["idea", "Idea / suggestion"],
  ["other", "Other"],
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map(([k, v]) => [k, v]));

function add(f) {
  db.prepare(`INSERT INTO feedback (created_at, user_email, user_name, user_role, area, category, rating, message, page, status)
    VALUES (datetime('now'), @user_email, @user_name, @user_role, @area, @category, @rating, @message, @page, 'new')`).run(f);
}
function list(status) {
  return status
    ? db.prepare("SELECT * FROM feedback WHERE status=? ORDER BY id DESC").all(status)
    : db.prepare("SELECT * FROM feedback ORDER BY id DESC").all();
}
function counts() {
  const c = { new: 0, reviewed: 0, dismissed: 0, total: 0 };
  db.prepare("SELECT status, COUNT(*) n FROM feedback GROUP BY status").all().forEach((r) => { c[r.status] = r.n; c.total += r.n; });
  return c;
}
function newCount() { return db.prepare("SELECT COUNT(*) n FROM feedback WHERE status='new'").get().n; }
// Triage. Stamp reviewed_at when the row leaves 'new', because the owner's retention period runs
// twelve months from the REVIEW, not from the submission (services/retention.js). Sending a row back
// to 'new' clears the stamp: it is waiting on a human again, and the clock restarts when it is next
// dealt with. Re-reviewing an already-reviewed row restamps it, which only ever keeps it longer.
function setStatus(id, status) {
  db.prepare(`UPDATE feedback SET status=?, reviewed_at = CASE WHEN ?='new' THEN NULL ELSE datetime('now') END WHERE id=?`)
    .run(status, status, id);
}

module.exports = { AREAS, CATEGORIES, CAT_LABEL, add, list, counts, newCount, setStatus };
