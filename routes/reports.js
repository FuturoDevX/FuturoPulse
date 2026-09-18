// Reports — admin only.
//
// These pages put OWNA and LineLeader figures side by side for a board pack, so they carry more together
// than any single page does: continuation, occupancy, waitlist depth, and the enquiry funnel by centre.
// requireAdmin rather than requireAdminOrOps: this is the pack that goes to the board, and until someone
// decides otherwise it stays with the person who presents it.
const express = require("express");
const { requireAdmin } = require("../middleware/auth");
const report = require("../services/report-enrolment");
const enquiries = require("../services/enquiries");
const marketing = require("../services/marketing");
const m = require("../services/metrics");
const cal = require("../services/calendar");

const router = express.Router();
router.use(requireAdmin);

router.get("/enrolment", (req, res) => {
  const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 26, 6), 104);
  res.render("report-enrolment", {
    title: "Enrolment report",
    model: report.build({ weeks }),
    weeks,
    channels: marketing.CHANNELS,
    centres: m.centres().filter((c) => !c.opening),
    allCentres: m.centres(),
    msg: req.query.msg || null,
    err: req.query.err || null,
  });
});

// Built in this request and streamed straight back — nothing is stored, the same rule the eNPS export
// follows. One row per centre per month, both measures together, and the coverage that produced the
// occupancy figure so a thin month cannot be quoted as a result.
router.get("/enrolment.csv", (req, res) => {
  const model = report.build({ weeks: 26 });
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Cache-Control", "no-store");
  res.set("Content-Disposition", `attachment; filename="futuro-enrolment-${cal.today()}.csv"`);
  res.send(report.csv(model));
});

// The enquiry pull takes minutes — fifteen pages of family records at nine seconds each — so it never
// runs on a page render. This is the button.
router.post("/enrolment/refresh", async (req, res) => {
  try {
    const r = await enquiries.refresh({ log: (line) => console.log(line) });
    if (r.skipped) return res.redirect("/reports/enrolment?err=" + encodeURIComponent(r.reason));
    res.redirect("/reports/enrolment?msg=" + encodeURIComponent(
      `Enquiries refreshed — ${r.families} families since ${r.since}, ${r.cells} week-centre cells.`));
  } catch (e) {
    console.error("[reports] enquiry refresh failed");
    res.redirect("/reports/enrolment?err=" + encodeURIComponent("Refresh failed: " + String(e.message).slice(0, 160)));
  }
});

// Marketing initiatives — the markers on the enquiry line. LineLeader's own campaign field is attached
// to 13 of 1,039 families this year, so this is where what actually happened gets recorded.
router.post("/enrolment/initiative", (req, res) => {
  const r = marketing.save({
    id: req.body.id || null,
    starts_on: (req.body.starts_on || "").trim(),
    ends_on: (req.body.ends_on || "").trim() || null,
    owna_id: (req.body.owna_id || "").trim() || null,
    title: req.body.title,
    channel: (req.body.channel || "").trim() || null,
    detail: req.body.detail,
    source: req.body.source,
  });
  if (!r.ok) return res.redirect("/reports/enrolment?err=" + encodeURIComponent(r.errs.join(" ")));
  res.redirect("/reports/enrolment?msg=" + encodeURIComponent("Initiative saved."));
});

router.post("/enrolment/initiative/:id/delete", (req, res) => {
  marketing.remove(req.params.id);
  res.redirect("/reports/enrolment?msg=" + encodeURIComponent("Initiative removed."));
});

module.exports = router;
