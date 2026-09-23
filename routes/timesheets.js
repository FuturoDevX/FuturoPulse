// OWNA → Employment Hero timesheet push.
//
// Deliberately a two-step flow, not a one-click push. On a typical day most educators ALREADY have
// a timesheet in EH from the manual spreadsheet import, so a blind push would double-pay them. The
// screen shows what would be created and what is being skipped, and only then offers to post.
//
// Everything posts as a DRAFT ("Submitted") for a centre director to approve in EH. Nothing here can
// put hours into a pay run on its own.
const express = require("express");
const { requireAdminOrOps } = require("../middleware/auth");
const cal = require("../services/calendar");
const push = require("../services/timesheet-push");
const db = require("../db/db");

const router = express.Router();
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const centreRow = (id) => db.prepare("SELECT owna_id, name FROM centres WHERE owna_id = ?").get(id);

// A centre-scoped login may only ever act on its own centre.
function guardCentre(req, res, next) {
  const scoped = res.locals.scopedOwnaId;
  if (scoped && scoped !== req.params.ownaId) {
    return res.status(403).render("error", { message: "That centre is outside your access." });
  }
  if (!centreRow(req.params.ownaId)) return res.status(404).render("error", { message: "Unknown centre." });
  next();
}

const backTo = (res, ownaId, from, to, key, text) =>
  res.redirect(`/timesheets/${ownaId}?from=${from}&to=${to}&${key}=` + encodeURIComponent(text));

// ===== Preview (writes nothing) =====
router.get("/:ownaId", requireAdminOrOps, guardCentre, async (req, res) => {
  const centre = centreRow(req.params.ownaId);
  // Default to yesterday: today's shifts are still open, so half the staff have no check-out yet.
  const from = isDate(req.query.from) ? req.query.from : cal.addDays(cal.today(), -1);
  const to = isDate(req.query.to) ? req.query.to : from;
  let data = null, error = null;
  try {
    data = await push.preview({ ownaId: centre.owna_id, from, to });
  } catch (e) {
    error = String(e.message || e).slice(0, 300);
  }
  res.render("timesheet-push", {
    title: "Push timesheets",
    centre, from, to, data, error,
    history: push.history(centre.owna_id, 10),
    today: cal.today(),
    msg: req.query.msg || null,
    err: req.query.err || null,
  });
});

// ===== Push (writes to payroll) =====
router.post("/:ownaId/push", requireAdminOrOps, guardCentre, async (req, res) => {
  const { ownaId } = req.params;
  const from = isDate(req.body.from) ? req.body.from : cal.addDays(cal.today(), -1);
  const to = isDate(req.body.to) ? req.body.to : from;
  // The preview the user saw is re-run inside push(), so a stale screen cannot post something the
  // guards would now refuse. This field only confirms they pressed the second button knowingly.
  if (String(req.body.confirm || "") !== "yes") {
    return backTo(res, ownaId, from, to, "err", "Nothing was posted — the confirmation box was not ticked.");
  }
  try {
    const out = await push.push({ ownaId, from, to, byUser: req.session.user });
    if (!out.created.length && !out.failed.length) {
      return backTo(res, ownaId, from, to, "msg", "Nothing to post — every shift was already in Employment Hero or was skipped.");
    }
    const bits = [`${out.created.length} timesheet(s) created as drafts`];
    if (out.verified >= 0) bits.push(`${out.verified} confirmed present in Employment Hero`);
    if (out.failed.length) bits.push(`${out.failed.length} failed`);
    return backTo(res, ownaId, from, to, out.failed.length ? "err" : "msg",
      bits.join(" · ") + ". They need a director's approval in Employment Hero before they can be paid.");
  } catch (e) {
    return backTo(res, ownaId, from, to, "err", "Nothing was posted: " + String(e.message || e).slice(0, 250));
  }
});

// ===== Undo (removes only what this tool created) =====
router.post("/:ownaId/undo", requireAdminOrOps, guardCentre, async (req, res) => {
  const { ownaId } = req.params;
  const from = isDate(req.body.from) ? req.body.from : cal.addDays(cal.today(), -1);
  const to = isDate(req.body.to) ? req.body.to : from;
  try {
    const out = await push.undo({ ownaId, from, to, byUser: req.session.user });
    return backTo(res, ownaId, from, to, out.failed.length ? "err" : "msg",
      `Removed ${out.deleted.length} of ${out.found} timesheet(s) this tool had created.` +
      (out.failed.length ? ` ${out.failed.length} could not be removed — check Employment Hero.` : ""));
  } catch (e) {
    return backTo(res, ownaId, from, to, "err", "Could not undo: " + String(e.message || e).slice(0, 250));
  }
});

module.exports = router;
