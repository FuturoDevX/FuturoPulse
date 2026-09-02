const express = require("express");
const { requireAdminOrOps } = require("../middleware/auth");
const { runSnapshot, lastRun } = require("../services/snapshot");
const { owna } = require("../services/owna");
const router = express.Router();

let refreshing = false;

// Manual "Refresh now" — pulls a fresh snapshot from OWNA on demand.
router.post("/refresh", requireAdminOrOps, async (req, res) => {
  if (refreshing) return res.redirect("/?msg=" + encodeURIComponent("A refresh is already running."));
  if (!owna.hasKey()) return res.redirect("/?msg=" + encodeURIComponent("OWNA_API_KEY is not configured."));
  refreshing = true;
  // Kick off in the background; the page shows progress via lastRun status.
  runSnapshot()
    .catch((e) => console.error("[refresh]", e.message))
    .finally(() => { refreshing = false; });
  res.redirect("/?msg=" + encodeURIComponent("Refresh started — reload in a moment to see updated figures."));
});

router.get("/status", requireAdminOrOps, (req, res) => {
  res.json({ refreshing, lastRun: lastRun() });
});


const db = require("../db/db");
const m = require("../services/metrics");

// Weekly labour budget entry (per centre standing targets).
router.get("/labour-budget", requireAdminOrOps, (req, res) => {
  const centres = db.prepare(`SELECT DISTINCT eh_centre FROM labour_weekly ORDER BY eh_centre`).all().map((r) => r.eh_centre);
  res.render("admin-labour-budget", { title: "Wage Budgets", centres, budgets: m.labourBudgets(), saved: req.query.saved });
});
router.post("/labour-budget", requireAdminOrOps, (req, res) => {
  const centres = db.prepare(`SELECT DISTINCT eh_centre FROM labour_weekly`).all().map((r) => r.eh_centre);
  for (const c of centres) {
    const num = (v) => { const n = parseFloat(String(v).replace(/[^0-9.]/g, "")); return isNaN(n) ? null : n; };
    const wages = num(req.body["wages_" + c]);
    const hours = num(req.body["hours_" + c]);
    const occ = num(req.body["occ_" + c]);
    const support = num(req.body["support_" + c]);
    if (wages != null || hours != null || occ != null || support != null) m.saveLabourBudget(c, "default", { wages, hours, occ, support });
  }
  res.redirect("/admin/labour-budget?saved=1");
});

module.exports = router;
