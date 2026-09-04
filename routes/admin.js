const express = require("express");
const { requireAdminOrOps, requireAdmin } = require("../middleware/auth");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { importAuditBuffer } = require("../services/qc-import");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
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
router.get("/wage-budget", requireAdminOrOps, (req, res) => {
  const centres = db.prepare(`SELECT DISTINCT eh_centre FROM labour_weekly ORDER BY eh_centre`).all().map((r) => r.eh_centre);
  res.render("admin-labour-budget", { title: "Wage Budgets", centres, budgets: m.labourBudgets(), saved: req.query.saved });
});
router.post("/wage-budget", requireAdminOrOps, (req, res) => {
  const centres = db.prepare(`SELECT DISTINCT eh_centre FROM labour_weekly`).all().map((r) => r.eh_centre);
  for (const c of centres) {
    const num = (v) => { const n = parseFloat(String(v).replace(/[^0-9.]/g, "")); return isNaN(n) ? null : n; };
    const wages = num(req.body["wages_" + c]);
    const hours = num(req.body["hours_" + c]);
    const occ = num(req.body["occ_" + c]);
    const support = num(req.body["support_" + c]);
    if (wages != null || hours != null || occ != null || support != null) m.saveLabourBudget(c, "default", { wages, hours, occ, support });
  }
  res.redirect("/admin/wage-budget?saved=1");
});


// ===== User management (admin only) =====
router.get("/users", requireAdmin, (req, res) => {
  const users = db.prepare(`SELECT id, email, name, role, location_id FROM users ORDER BY role, email`).all();
  const centres = db.prepare(`SELECT owna_id, name FROM centres ORDER BY name`).all();
  res.render("admin-users", { title: "Users", users, centres, msg: req.query.msg, err: req.query.err });
});
router.post("/users", requireAdmin, (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const name = (req.body.name || "").trim();
  const role = ["admin", "exec", "centre"].includes(req.body.role) ? req.body.role : "exec";
  const location_id = role === "centre" ? (req.body.location_id || null) : null;
  const password = req.body.password || "";
  if (!email || password.length < 6) return res.redirect("/admin/users?err=" + encodeURIComponent("Email and a 6+ char password are required."));
  if (role === "centre" && !location_id) return res.redirect("/admin/users?err=" + encodeURIComponent("Pick a centre for a centre-scoped user."));
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) return res.redirect("/admin/users?err=" + encodeURIComponent("That email already exists."));
  db.prepare("INSERT INTO users (email, name, password_hash, role, location_id) VALUES (?,?,?,?,?)")
    .run(email, name, bcrypt.hashSync(password, 10), role, location_id);
  res.redirect("/admin/users?msg=" + encodeURIComponent("User added: " + email));
});
router.post("/users/:id/delete", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.session.user.id) return res.redirect("/admin/users?err=" + encodeURIComponent("You can't delete your own account."));
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  res.redirect("/admin/users?msg=" + encodeURIComponent("User removed."));
});
router.post("/users/:id/reset", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const password = req.body.password || "";
  if (password.length < 6) return res.redirect("/admin/users?err=" + encodeURIComponent("New password must be 6+ chars."));
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 10), id);
  res.redirect("/admin/users?msg=" + encodeURIComponent("Password reset."));
});


// ===== People & Culture entry (admin) =====
router.get("/pc", requireAdmin, (req, res) => {
  const month = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? req.query.month : new Date().toISOString().slice(0,7);
  const centres = db.prepare("SELECT owna_id, name FROM centres WHERE ll_id IS NOT NULL AND (opening IS NULL OR opening = 0) ORDER BY name").all();
  const data = {}; db.prepare("SELECT * FROM pc_metrics WHERE month = ?").all(month).forEach((r) => { data[r.owna_id] = r; });
  res.render("admin-pc", { title: "P&C Entry", month, centres, data, targets: m.pcTargets(), msg: req.query.msg });
});
router.post("/pc", requireAdmin, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.body.month) ? req.body.month : new Date().toISOString().slice(0,7);
  const num = (v) => { const n = parseFloat(String(v).replace(/[^0-9.-]/g, "")); return isNaN(n) ? null : n; };
  const centres = db.prepare("SELECT owna_id FROM centres WHERE ll_id IS NOT NULL AND (opening IS NULL OR opening = 0)").all();
  for (const c of centres) {
    m.savePcMetric(c.owna_id, month, {
      enps: num(req.body["enps_" + c.owna_id]), family_nps: num(req.body["familynps_" + c.owna_id]),
      turnover: num(req.body["turnover_" + c.owna_id]),
      checkin_due: num(req.body["due_" + c.owna_id]), checkin_completed: num(req.body["done_" + c.owna_id]),
      psych_safety: num(req.body["psych_" + c.owna_id]),
    });
  }
  ["enps", "family_nps", "turnover", "checkin_pct", "psych_safety"].forEach((k) => { const v = num(req.body["target_" + k]); if (v != null) m.savePcTarget(k, v); });
  res.redirect("/admin/pc?month=" + month + "&msg=" + encodeURIComponent("Saved."));
});


// ===== Quality & Compliance upload (admin) =====
router.get("/qc", requireAdmin, (req, res) => {
  const centres = db.prepare("SELECT owna_id, name FROM centres WHERE (opening IS NULL OR opening = 0) AND capacity > 0 ORDER BY name").all();
  res.render("admin-qc", { title: "Q&C Data", summary: m.qcSummary(), centres, msg: req.query.msg, err: req.query.err });
});
router.post("/qc/upload", requireAdmin, upload.single("audit"), (req, res) => {
  if (!req.file) return res.redirect("/admin/qc?err=" + encodeURIComponent("No file uploaded."));
  try {
    const r = importAuditBuffer(req.file.buffer, (req.body.term || "").trim(), (req.body.owna || "").trim() || null);
    res.redirect("/admin/qc?msg=" + encodeURIComponent(`Imported ${r.centre}: ${r.overall_pct}% overall, ${r.qa} QAs, ${r.actions} actions.`));
  } catch (e) {
    res.redirect("/admin/qc?err=" + encodeURIComponent("Import failed: " + e.message));
  }
});

module.exports = router;
