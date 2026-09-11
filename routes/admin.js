const express = require("express");
const { requireAdminOrOps, requireAdmin } = require("../middleware/auth");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { importAuditBuffer } = require("../services/qc-import");
const { importPcWorkbook } = require("../services/pc-import");
const fb = require("../services/feedback");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const { runSnapshot, lastRun, errSummary, sourceSync, sourceSyncFor } = require("../services/snapshot");
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
    .catch((e) => console.error("[refresh] failed:", errSummary(e)))
    .finally(() => { refreshing = false; });
  res.redirect("/?msg=" + encodeURIComponent("Refresh started — reload in a moment to see updated figures."));
});

router.get("/status", requireAdminOrOps, (req, res) => {
  res.json({ refreshing, lastRun: lastRun(), sources: sourceSync() });
});


const db = require("../db/db");
const m = require("../services/metrics");

// Weekly labour budget entry (per centre standing targets).
router.get("/wage-budget", requireAdminOrOps, (req, res) => {
  const centres = db.prepare(`SELECT DISTINCT eh_centre FROM labour_weekly ORDER BY eh_centre`).all().map((r) => r.eh_centre);
  res.render("admin-labour-budget", { title: "Wage Budgets", centres, budgets: m.labourBudgets(), saved: req.query.saved, payroll: sourceSyncFor("eh_labour") });
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

// Monthly lead & tour targets per centre (standing 'default' month), one row per centre incl. pre-opening centres.
router.get("/pipeline-targets", requireAdminOrOps, (req, res) => {
  res.render("admin-pipeline-targets", { title: "Pipeline Targets", centres: m.centres(), targets: m.pipelineTargets(), saved: req.query.saved, lastRun: lastRun() });
});
router.post("/pipeline-targets", requireAdminOrOps, (req, res) => {
  const int = (v) => { const n = parseInt(String(v == null ? "" : v).replace(/[^0-9]/g, ""), 10); return isNaN(n) ? null : n; };
  for (const c of m.centres()) {
    const leads = int(req.body["leads_" + c.owna_id]), tours = int(req.body["tours_" + c.owna_id]);
    if (leads != null || tours != null) m.savePipelineTarget(c.owna_id, "default", { leads, tours });
    else m.deletePipelineTarget(c.owna_id, "default"); // both blank = no target for this centre
  }
  res.redirect("/admin/pipeline-targets?saved=1");
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
  const role = ["viewer", "centre", "exec", "ops_manager", "admin"].includes(req.body.role) ? req.body.role : "viewer";
  const location_id = role === "centre" ? (req.body.location_id || null) : null;
  const password = req.body.password || "";
  if (!email || password.length < 12) return res.redirect("/admin/users?err=" + encodeURIComponent("Email and a 12+ char password are required."));
  if (role === "centre" && (!location_id || !db.prepare("SELECT 1 FROM centres WHERE owna_id = ?").get(location_id))) return res.redirect("/admin/users?err=" + encodeURIComponent("Pick a centre for a centre-scoped user."));
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
  if (password.length < 12) return res.redirect("/admin/users?err=" + encodeURIComponent("New password must be 12+ chars."));
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 10), id);
  res.redirect("/admin/users?msg=" + encodeURIComponent("Password reset."));
});


// ===== People & Culture entry (admin) =====
router.get("/pc", requireAdmin, (req, res) => {
  const month = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? req.query.month : new Date().toISOString().slice(0,7);
  const centres = db.prepare("SELECT owna_id, name FROM centres WHERE ll_id IS NOT NULL AND (opening IS NULL OR opening = 0) ORDER BY name").all();
  const data = {}; db.prepare("SELECT * FROM pc_metrics WHERE month = ?").all(month).forEach((r) => { data[r.owna_id] = r; });
  res.render("admin-pc", { title: "P&C Entry", month, centres, data, targets: m.pcTargets(), msg: req.query.msg, err: req.query.err });
});
// Upload the HR SharePoint P&C workbooks (eNPS Data / Turnover Analysis) — same flow as Q&C.
router.post("/pc/import", requireAdmin, upload.single("workbook"), (req, res) => {
  if (!req.file) return res.redirect("/admin/pc?err=" + encodeURIComponent("No file uploaded."));
  try {
    const r = importPcWorkbook(req.file.buffer);
    res.redirect("/admin/pc?msg=" + encodeURIComponent(`Imported ${r.kinds.join(" + ")} — ${r.rows} rows across ${r.centres} centres, ${r.months} months.`));
  } catch (e) {
    res.redirect("/admin/pc?err=" + encodeURIComponent("Import failed: " + e.message));
  }
});
// P&C metric DATA comes from the SharePoint upload (POST /pc/import); this only saves target lines.
router.post("/pc", requireAdmin, (req, res) => {
  const num = (v) => { const n = parseFloat(String(v).replace(/[^0-9.-]/g, "")); return isNaN(n) ? null : n; };
  ["enps", "family_nps", "turnover", "checkin_pct", "psych_safety"].forEach((k) => { const v = num(req.body["target_" + k]); if (v != null) m.savePcTarget(k, v); });
  res.redirect("/admin/pc?msg=" + encodeURIComponent("Targets saved."));
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

// ---- Feedback review (admin) ----
router.get("/feedback", requireAdmin, (req, res) => {
  const filter = ["new", "reviewed", "dismissed"].includes(req.query.status) ? req.query.status : null;
  res.render("admin-feedback", { title: "Feedback", items: fb.list(filter), counts: fb.counts(), catLabel: fb.CAT_LABEL, filter, msg: req.query.msg });
});
router.post("/feedback/:id/status", requireAdmin, (req, res) => {
  const status = ["new", "reviewed", "dismissed"].includes(req.body.status) ? req.body.status : "reviewed";
  fb.setStatus(parseInt(req.params.id, 10), status);
  res.redirect("/admin/feedback" + (req.body.back ? ("?status=" + encodeURIComponent(req.body.back)) : ""));
});

module.exports = router;
