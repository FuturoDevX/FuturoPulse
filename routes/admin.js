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
const cal = require("../services/calendar");

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

// Approved places per centre — the licensed count on the service approval (ACECQA National Register).
// OWNA cannot supply it (its room capacities are how the rooms are configured, not what the service is
// licensed for), so it is maintained here and every licensed-places denominator divides by it.
// The occupancy target each centre is judged against is edited here too, beside the licensed count it is a
// percentage of — the COE page links to this form. It is NOT a second copy: the field reads and writes the
// same labour_budget.budget_occ row the wage-budget page uses, through m.saveOccupancyTarget().
router.get("/places", requireAdminOrOps, (req, res) => {
  res.render("admin-places", {
    title: "Approved Places",
    rows: m.placesAdminRows(),
    max: m.MAX_APPROVED_PLACES,
    maxTarget: m.MAX_TARGET_PCT,
    defaultTarget: m.GROUP_TARGET_PCT,
    saved: req.query.saved, savedTargets: req.query.targets, err: req.query.err,
    lastRun: lastRun(),
  });
});
router.post("/places", requireAdminOrOps, (req, res) => {
  const rows = m.placesAdminRows();
  const errors = [];
  const writes = [];
  const targetWrites = [];
  for (const c of rows) {
    if (Object.prototype.hasOwnProperty.call(req.body, "places_" + c.owna_id)) {
      const parsed = m.parseApprovedPlaces(req.body["places_" + c.owna_id]);
      if (parsed.error) errors.push(`${c.name}: approved places ${parsed.error}`);
      else if (parsed.value !== c.approved_places) writes.push([c.owna_id, parsed.value]);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "target_" + c.owna_id)) {
      const parsed = m.parseOccupancyTarget(req.body["target_" + c.owna_id]);
      if (parsed.error) errors.push(`${c.name}: target ${parsed.error}`);
      else if (parsed.value !== c.target_stored) {
        // A centre payroll has never seen has no Employment Hero name to key the row on. Say so rather than
        // inventing one — that would be the second, drifting copy this shares a row to avoid.
        if (!c.target_eh_centre) errors.push(`${c.name}: no payroll centre name yet, so a target cannot be stored against it`);
        else targetWrites.push([c.owna_id, parsed.value]);
      }
    }
  }
  // Reject the whole submission on a bad value rather than saving half of it: a partly applied form leaves
  // the user unsure which centres took and which did not.
  if (errors.length) return res.redirect("/admin/places?err=" + encodeURIComponent(errors.join(" · ")));
  db.transaction(() => {
    writes.forEach(([id, v]) => m.saveApprovedPlaces(id, v));
    targetWrites.forEach(([id, v]) => m.saveOccupancyTarget(id, v));
  })();
  res.redirect("/admin/places?saved=" + writes.length + "&targets=" + targetWrites.length);
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


// ===== People & Culture data (admin or ops) =====
// Admin-or-ops, like every other standing-data form (/admin/wage-budget, /admin/places,
// /admin/pipeline-targets): from 16 September this page is where the owner's turnover numbers are
// typed, and an ops manager maintains them the same way they maintain a wage budget.
router.get("/pc", requireAdminOrOps, (req, res) => {
  const month = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? req.query.month : cal.currentMonth();
  const centres = db.prepare("SELECT owna_id, name FROM centres WHERE ll_id IS NOT NULL AND (opening IS NULL OR opening = 0) ORDER BY name").all();
  const data = {}; db.prepare("SELECT * FROM pc_metrics WHERE month = ?").all(month).forEach((r) => { data[r.owna_id] = r; });
  // Removed 16 September: the spreadsheet-versus-payroll comparison card. The owner now enters
  // turnover, so there is one figure and nothing to compare it against.
  res.render("admin-pc", {
    title: "P&C Entry", month, thisMonth: cal.currentMonth(), centres, data, targets: m.pcTargets(),
    turnoverRows: m.pcTurnoverEntries(month),
    turnoverMonths: m.pcTurnoverMonths(),
    turnover: m.pcTurnoverReport(null, month),
    msg: req.query.msg, err: req.query.err,
  });
});
// The owner's turnover numbers: every operating centre saved at once, for the selected month.
// A field left blank is stored as NOT ENTERED, which is not zero and must come back blank.
router.post("/pc/turnover", requireAdminOrOps, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.body.month || "") ? req.body.month : cal.currentMonth();
  const rows = m.pcTurnoverEntries(month);
  const sent = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
  db.transaction(() => {
    for (const c of rows) {
      // Only touch a centre the submission actually carried. The form posts all three fields for every
      // centre, so clearing them is still how a row is removed; but a partial POST must not silently
      // erase the centres it said nothing about.
      if (!sent("res_" + c.owna_id) && !sent("term_" + c.owna_id) && !sent("head_" + c.owna_id)) continue;
      m.savePcTurnoverEntry(c.owna_id, month, {
        resignations: req.body["res_" + c.owna_id],
        terminations: req.body["term_" + c.owna_id],
        headcount: req.body["head_" + c.owna_id],
      });
    }
  })();
  res.redirect("/admin/pc?month=" + encodeURIComponent(month) + "&msg=" + encodeURIComponent("Turnover saved for " + month + "."));
});
// Upload the HR SharePoint P&C workbooks (eNPS Data / Turnover Analysis) — same flow as Q&C.
router.post("/pc/import", requireAdminOrOps, upload.single("workbook"), (req, res) => {
  if (!req.file) return res.redirect("/admin/pc?err=" + encodeURIComponent("No file uploaded."));
  try {
    const r = importPcWorkbook(req.file.buffer);
    res.redirect("/admin/pc?msg=" + encodeURIComponent(`Imported ${r.kinds.join(" + ")} — ${r.rows} rows across ${r.centres} centres, ${r.months} months.`));
  } catch (e) {
    res.redirect("/admin/pc?err=" + encodeURIComponent("Import failed: " + e.message));
  }
});
// eNPS DATA comes from the SharePoint upload (POST /pc/import) and turnover from POST /pc/turnover;
// this only saves target lines.
router.post("/pc", requireAdminOrOps, (req, res) => {
  const num = (v) => { const n = parseFloat(String(v).replace(/[^0-9.-]/g, "")); return isNaN(n) ? null : n; };
  ["enps", "family_nps", "turnover", "checkin_pct", "psych_safety"].forEach((k) => { const v = num(req.body["target_" + k]); if (v != null) m.savePcTarget(k, v); });
  res.redirect("/admin/pc?msg=" + encodeURIComponent("Targets saved."));
});


// ===== Pay classification map (read-only) =====
// The owner's rule of 16 September is that a person's role is their PAY CLASSIFICATION. This page shows
// the mapping being applied — every distinct scale payroll carries, the people on it, and the category
// it lands in — so an unmapped or wrongly-mapped scale is visible instead of quietly folded into
// "Unclassified". Read-only for now: the mapping lives in services/classification.js.
router.get("/pay-scales", requireAdminOrOps, (req, res) => {
  res.render("admin-pay-scales", { title: "Pay classification", scales: m.talentPayScales(), talentSync: sourceSyncFor("talent") });
});


// ===== eNPS survey rounds (admin / ops) =====
// Round management lives here; the RESULTS live on People & Culture, which is where eNPS already is.
const survey = require("../services/survey");
const surveyMail = require("../services/survey-mail");

// The address the magic links must point at. PUBLIC_HOSTNAME is the canonical one when it is set —
// links in an email outlive the request that made them, so they must not be built from whatever host
// header a proxy happened to forward.
function publicBase(req) {
  const host = (process.env.PUBLIC_HOSTNAME || "").trim();
  return host ? "https://" + host.replace(/^https?:\/\//, "").replace(/\/+$/, "") : req.protocol + "://" + req.get("host");
}

// The state of the one send that may be running, held in memory because it belongs to this process and
// nothing else needs it afterwards — the durable record of what was delivered is survey_deliveries,
// keyed on the token. `dry` is the last dry run's report for this round.
const IDLE_SEND = { running: false, mode: null, roundId: null, startedAt: null, finishedAt: null,
  total: 0, queued: 0, done: 0, sent: 0, failed: 0, skipped: 0, stopped: null, error: null };
let send = { ...IDLE_SEND };
let dryRun = null; // { roundId, at, ...report }

function surveyPageModel(req) {
  const all = survey.rounds();
  const selected = all.find((r) => String(r.id) === String(req.query.round)) || survey.currentRound() || null;
  const counts = selected
    ? db.prepare(`SELECT COUNT(*) invited, SUM(used) used,
                         MAX(sent_on) last_sent FROM survey_invitations WHERE round_id = ?`).get(selected.id)
    : { invited: 0, used: 0, last_sent: null };
  const base = publicBase(req);
  return {
    title: "Staff survey",
    rounds: all, selected,
    state: selected ? survey.roundState(selected) : null,
    counts,
    senders: surveyMail.senders(),
    // The draft the owner asked for, shown with a real centre name and a sample link so it can be read
    // as a staff member would receive it. The sample token is not a real invitation.
    draft: survey.invitationEmail({
      centre: "Austral",
      link: survey.linkFor(base, surveyMail.TEST_LINK_TOKEN), // the same sample link the test send carries
      closesOn: selected ? selected.closes_on : "",
      contact: req.app.locals.privacyContact,
    }),
    // Per-centre chase-up numbers. They live here, behind requireAdminOrOps, and not on People &
    // Culture: a small centre's exact count shown to every logged-in user is close to naming the people
    // in it. Counted off the invitation table alone — spent links, never answers — so nothing here
    // touches what anybody said.
    centreCounts: selected ? db.prepare(`SELECT centre_label, COUNT(*) invited, SUM(used) answered
                                         FROM survey_invitations WHERE round_id = ?
                                         GROUP BY owna_id, centre_label ORDER BY centre_label`).all(selected.id) : [],
    base, today: cal.today(),
    // Sending: what Graph can do right now, what has actually been delivered for this round, and the
    // run in flight if there is one. Delivery counts come off survey_deliveries, so they survive a
    // restart and are what the Retry button counts.
    graph: surveyMail.graphAvailability(),
    deliveries: selected ? surveyMail.deliveryCounts(selected.id) : { sent: 0, failed: 0, last_error: null, last_on: null },
    send: selected && send.roundId === selected.id ? send : { ...IDLE_SEND },
    dryRun: dryRun && selected && dryRun.roundId === selected.id ? dryRun : null,
    sendRate: surveyMail.MESSAGES_PER_MINUTE,
    minResponses: survey.MIN_RESPONSES,
    payrollReady: require("../services/eh").eh.hasCreds(),
    msg: req.query.msg, err: req.query.err,
  };
}

router.get("/survey", requireAdminOrOps, (req, res) => res.render("admin-survey", surveyPageModel(req)));

router.post("/survey", requireAdminOrOps, (req, res) => {
  try {
    const r = survey.createRound({ name: req.body.name, opens_on: (req.body.opens_on || "").trim(), closes_on: (req.body.closes_on || "").trim() });
    res.redirect("/admin/survey?round=" + r.id + "&msg=" + encodeURIComponent("Round created. Generate the mail-merge file when you are ready to send."));
  } catch (e) {
    res.redirect("/admin/survey?err=" + encodeURIComponent(e.message));
  }
});

router.post("/survey/:id/closes", requireAdminOrOps, (req, res) => {
  try {
    survey.setClosesOn(parseInt(req.params.id, 10), (req.body.closes_on || "").trim());
    res.redirect("/admin/survey?round=" + req.params.id + "&msg=" + encodeURIComponent("Closing date updated."));
  } catch (e) {
    res.redirect("/admin/survey?round=" + req.params.id + "&err=" + encodeURIComponent(e.message));
  }
});

// The mail-merge export. Built in this request from payroll and streamed straight back: the addresses
// are in the response and in nothing else — no file on the server, no row in the database.
router.get("/survey/:id/export.csv", requireAdminOrOps, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rows, round, noEmail } = await survey.exportRows(id, { baseUrl: publicBase(req) });
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.set("X-Staff-Without-Email", String(noEmail)); // so the count is visible without opening the file
    res.set("Content-Disposition", `attachment; filename="futuro-enps-${String(round.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${cal.today()}.csv"`);
    res.send(survey.csv(rows));
  } catch (e) {
    res.redirect("/admin/survey?round=" + id + "&err=" + encodeURIComponent("Could not build the export: " + e.message));
  }
});

const backToSurvey = (res, id, kind, text) =>
  res.redirect("/admin/survey" + (id ? "?round=" + id + "&" : "?") + kind + "=" + encodeURIComponent(text));

// Send the round from a Futuro mailbox through Microsoft Graph. Backgrounded like the OWNA refresh:
// Exchange caps a mailbox at about 30 messages a minute, so 221 invitations take roughly eight minutes
// — far longer than a request may hold open. The page polls /admin/survey/:id/send-status.
//
// THIS IS ALSO THE RETRY. graphSendRound skips every token already recorded as delivered, so pressing it
// again after a failure covers exactly the people who never got a link and nobody is sent two.
router.post("/survey/:id/send", requireAdminOrOps, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const avail = surveyMail.graphAvailability();
  if (!avail.available) return backToSurvey(res, id, "err", avail.reason);
  if (send.running) return backToSurvey(res, id, "msg", "A send is already running.");
  const round = survey.round(id);
  if (!round) return backToSurvey(res, null, "err", "No such round.");

  send = { ...IDLE_SEND, running: true, mode: "send", roundId: id, startedAt: Date.now() };
  const contact = req.app.locals.privacyContact;
  survey.exportRows(id, { baseUrl: publicBase(req) })
    .then((out) => surveyMail.graphSendRound(out.rows, {
      roundId: id, closesOn: round.closes_on, contact,
      onProgress: (p) => { if (send.roundId === id) Object.assign(send, p); },
    }))
    .then((r) => { Object.assign(send, r, { error: null }); })
    .catch((e) => {
      // A stopped run carries its own counts; anything else (payroll unreachable, say) sent nothing.
      if (typeof e.sent === "number") Object.assign(send, { sent: e.sent, failed: e.failed, skipped: e.skipped, done: e.done, total: e.total, stopped: e.klass || "stopped" });
      // redact(): nothing here should ever carry the client secret, and this line is rendered.
      send.error = surveyMail.redact(e.message);
    })
    .finally(() => { send.running = false; send.finishedAt = Date.now(); });
  res.redirect("/admin/survey?round=" + id + "&msg=" + encodeURIComponent("Sending started — the page will show progress as it goes."));
});

// Progress, polled by the page. Counts only: no address, no token, nothing about who.
router.get("/survey/:id/send-status", requireAdminOrOps, (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.set("Cache-Control", "no-store");
  res.json({ ...(send.roundId === id ? send : IDLE_SEND), deliveries: surveyMail.deliveryCounts(id) });
});

// Dry run: resolve the recipients, build every message, report what would go where — and send nothing.
// It makes no network call to Microsoft at all, so it is safe before the tenant work is finished.
router.post("/survey/:id/dry-run", requireAdminOrOps, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const round = survey.round(id);
  if (!round) return backToSurvey(res, null, "err", "No such round.");
  try {
    const out = await survey.exportRows(id, { baseUrl: publicBase(req) });
    const report = await surveyMail.graphDryRun(out.rows, { roundId: id, closesOn: round.closes_on, contact: req.app.locals.privacyContact });
    dryRun = { roundId: id, at: cal.today(), noEmail: out.noEmail, ...report };
    backToSurvey(res, id, "msg", `Dry run: ${report.queued} message(s) would be sent, nothing was. About ${report.minutes} minute(s) at ${report.ratePerMinute} a minute.`);
  } catch (e) {
    backToSurvey(res, id, "err", "Could not build the dry run: " + surveyMail.redact(e.message));
  }
});

// One real message to a nominated address, so the owner sees it land in a real inbox before 221 go out.
// The address is never echoed back into the redirect: a query string lands in proxy and server logs, and
// this one is a person's address.
router.post("/survey/:id/test", requireAdminOrOps, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const round = survey.round(id);
  if (!round) return backToSurvey(res, null, "err", "No such round.");
  try {
    const out = await surveyMail.graphSendTest((req.body && req.body.email) || "", {
      baseUrl: publicBase(req), centre: "Austral",
      closesOn: round.closes_on, contact: req.app.locals.privacyContact,
    });
    backToSurvey(res, id, "msg", `Test message sent from ${out.sender}. Check that inbox — the link in it is the sample link, not a real invitation.`);
  } catch (e) {
    backToSurvey(res, id, "err", "Test send failed: " + surveyMail.redact(e.message));
  }
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
