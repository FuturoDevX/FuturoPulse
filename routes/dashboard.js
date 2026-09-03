const express = require("express");
const m = require("../services/metrics");
const { blockScoped, scopedOwnaId, requireAdminOrOps } = require("../middleware/auth");
const { lastRun } = require("../services/snapshot");
const router = express.Router();

// Validate/normalise a ?from&to range, falling back to the default window.
function resolveRange(req) {
  const def = m.defaultRange();
  const re = /^\d{4}-\d{2}-\d{2}$/;
  let from = re.test(req.query.from) ? req.query.from : def.from;
  let to = re.test(req.query.to) ? req.query.to : def.to;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

// Build "from=…&to=…" preset query strings anchored to the latest data date.
function presetsFor() {
  const to = m.defaultRange().to;
  const back = (n) => { const d = new Date(to); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  return {
    week: `from=${back(6)}&to=${to}`,
    month: `from=${back(29)}&to=${to}`,
    quarter: `from=${back(89)}&to=${to}`,
    year: `from=${back(364)}&to=${to}`,
  };
}

// Forward-looking presets anchored to today (the booked/scheduled horizon).
function fwdPresetsFor() {
  const today = m.todayStr();
  const ahead = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  return {
    next7: `from=${today}&to=${ahead(7)}`,
    next30: `from=${today}&to=${ahead(30)}`,
    next90: `from=${today}&to=${ahead(90)}`,
    next180: `from=${today}&to=${ahead(180)}`,
  };
}

// Overview: all centres side by side.
router.get("/", (req, res) => {
  const { from, to } = resolveRange(req);
  let rows = m.overview(from, to);
  const scoped = scopedOwnaId(req);
  if (scoped) rows = rows.filter((r) => r.owna_id === scoped);
  res.render("overview", {
    title: "Operations Overview",
    from, to,
    rows,
    totals: m.totals(rows),
    presets: presetsFor(),
    fwdPresets: fwdPresetsFor(),
    llMap: m.llByOwnaCentre(),
    fcast: m.forwardOccupancyByCentre(30),
    pcGroup: m.pcGroupLatest(),
    lastRun: lastRun(),
  });
});

// Enrolment pipeline / waitlist (LineLeader).
router.get("/pipeline", blockScoped, (req, res) => {
  const p = m.llPipeline();
  res.render("pipeline", { title: "Enrolment Pipeline", pipeline: p, lastRun: lastRun() });
});

// Per-centre enrolment pipeline drill-down (stages, members, tours, waitlist trend).
router.get("/centre/:id/pipeline", (req, res) => {
  const c = m.centre(req.params.id);
  if (!c) return res.status(404).render("error", { message: "Centre not found." });
  const scoped = scopedOwnaId(req);
  if (scoped && c.owna_id !== scoped) return res.status(403).render("error", { message: "You can only view your own centre." });
  const detail = m.centrePipelineDetail(c.owna_id);
  res.render("centre-pipeline", { title: c.name + " — Pipeline", centre: c, detail, today: m.todayStr(), lastRun: lastRun() });
});

// Monthly action plans (view; exec/admin edit).
const AP_CATS = [["urgent","Short-term urgent actions"],["bau","Recurring / BAU actions"],["support","Support-office jobs"],["keep","Keep in mind"]];
function apCentresFor(req) {
  const scoped = scopedOwnaId(req);
  const all = m.centres().filter((c) => c.ll_id != null || true);
  return scoped ? all.filter((c) => c.owna_id === scoped) : all;
}
function apResolve(req) {
  const centres = apCentresFor(req);
  const scoped = scopedOwnaId(req);
  const owna = scoped || (centres.find((c) => c.owna_id === req.query.owna) ? req.query.owna : (centres[0] && centres[0].owna_id));
  const months = m.actionPlanMonths(); const now = new Date().toISOString().slice(0,7);
  const month = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : (months[0] || now);
  return { centres, owna, months: months.length ? months : [now], month };
}
router.get("/action-plans", (req, res) => {
  const { centres, owna, months, month } = apResolve(req);
  const centre = m.centre(owna);
  res.render("action-plan", { title: "Action Plans", centres, owna, months, month, centre,
    data: owna ? m.actionPlanGet(owna, month) : null, cats: AP_CATS, canEdit: ["admin","exec","ops_manager"].includes(req.session.user.role) });
});
router.get("/action-plans/edit", requireAdminOrOps, (req, res) => {
  const centres = m.centres(); const owna = centres.find((c)=>c.owna_id===req.query.owna) ? req.query.owna : centres[0].owna_id;
  const month = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : new Date().toISOString().slice(0,7);
  res.render("action-plan-edit", { title: "Edit Action Plan", centres, owna, month, centre: m.centre(owna), data: m.actionPlanGet(owna, month), cats: AP_CATS });
});
router.post("/action-plans/edit", requireAdminOrOps, (req, res) => {
  const owna = req.body.owna; const month = req.body.month;
  const areas = {}; m.AP_AREAS.forEach((a) => { areas[a.key] = { rating: req.body["rating_"+a.key] || "", reason: req.body["reason_"+a.key] || "" }; });
  m.saveActionPlan(owna, month, req.body.overall || "", req.body.context || "", areas);
  const items = [];
  AP_CATS.forEach(([cat]) => { for (let i=0;i<6;i++){ items.push({ category: cat, focus_area: req.body[`f_${cat}_${i}`]||"", actions: req.body[`a_${cat}_${i}`]||"", owner: req.body[`o_${cat}_${i}`]||"", status: req.body[`s_${cat}_${i}`]||"" }); } });
  m.replaceActionItems(owna, month, items);
  res.redirect(`/action-plans?owna=${owna}&month=${month}`);
});

// Safety & Incidents (OWNA child incident reports, rolling 12 months).
router.get("/safety", (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : null;
  const rep = m.incidentsReport(scopedOwnaId(req), 12, month);
  res.render("safety", { title: "Safety & Incidents", rep, lastRun: lastRun() });
});

// Quality & Compliance (from uploaded audits) — navigate by centre and audit period.
router.get("/qc", (req, res) => {
  const scoped = scopedOwnaId(req);
  // List all operating centres so you can navigate between them even before every audit is uploaded.
  const all = m.centres().filter((c) => c.owna_id && c.capacity > 0);
  const centresList = (scoped ? all.filter((c) => c.owna_id === scoped) : all).map((c) => ({ owna_id: c.owna_id, name: c.name }));
  const owna = scoped || (centresList.find((c) => c.owna_id === req.query.owna) ? req.query.owna : (centresList[0] && centresList[0].owna_id));
  const terms = owna ? m.qcTerms(owna) : [];
  const term = terms.find((t) => t.term === req.query.term) ? req.query.term : (terms[0] && terms[0].term);
  res.render("qc", {
    title: "Quality & Compliance",
    centres: centresList, owna, terms, term,
    audit: owna ? m.qcCentre(owna, term) : null,
    trend: owna ? m.qcTrend(owna) : [],
    lastRun: lastRun(),
  });
});

// People & Culture (manual metrics vs targets).
router.get("/pc", (req, res) => {
  const months = m.pcMonths();
  const month = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? req.query.month : (months[0] || new Date().toISOString().slice(0,7));
  res.render("pc", { title: "People & Culture", months, month, rows: m.pcForMonth(month, scopedOwnaId(req)), targets: m.pcTargets(), lastRun: lastRun() });
});

// Labour & margin (Employment Hero payroll + OWNA revenue).
router.get("/labour", blockScoped, (req, res) => {
  const weeks = m.labourWeeks(16);
  const week = weeks.includes(req.query.week) ? req.query.week : weeks[0];
  res.render("labour", {
    title: "Wages & Margin",
    weeks, week,
    rows: week ? m.labourForWeek(week) : [],
    trend: m.labourTrend(null, 16),
    lastRun: lastRun(),
  });
});

// Enrolment projection / scenario (OWNA occupancy + CRM pipeline).
router.get("/projection", blockScoped, (req, res) => {
  const scope = ["committed", "likely", "all"].includes(req.query.scope) ? req.query.scope : "likely";
  const days = [30, 90, 180].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 90;
  res.render("projection", { title: "Enrolment Projection", proj: m.projection(scope, days), lastRun: lastRun() });
});

// Exit report (OWNA departures + LineLeader reasons), group-wide.
router.get("/exits", blockScoped, (req, res) => {
  res.render("exits", {
    title: "Exit Report",
    summary: m.exitsSummary(),
    reasons: m.exitReasons(null),
    asAt: m.exitsLatestDate(),
    lastRun: lastRun(),
  });
});

// Drill-down: one centre.
router.get("/centre/:id", (req, res) => {
  const { from, to } = resolveRange(req);
  const c = m.centre(req.params.id);
  if (!c) return res.status(404).render("error", { message: "Centre not found." });
  const scoped = scopedOwnaId(req);
  if (scoped && c.owna_id !== scoped) return res.status(403).render("error", { message: "You can only view your own centre." });

  const daily = m.centreDaily(c.owna_id, from, to);
  const today = m.todayStr();
  const agg = daily.reduce((a, d) => {
    a.booked += d.booked; a.casual += d.casual; a.fee_total += d.fee_total; a.days += 1;
    if (d.metric_date <= today) { // attendance only known for past/today
      a.pastBooked += d.booked; a.attended += d.attended; a.absent += d.absent; a.pastDays += 1;
    }
    return a;
  }, { booked: 0, attended: 0, absent: 0, casual: 0, fee_total: 0, days: 0, pastBooked: 0, pastDays: 0 });
  const capacityDays = c.capacity * agg.days;
  const pipeline = m.llForCentre(c.owna_id);
  const labour = m.centreLabourLatest(c.owna_id);
  // Centre hub: latest action plan, P&C and Q&C for this centre.
  const apMonth = m.actionPlanMonths(1)[0] || m.todayStr().slice(0, 7);
  const actionPlan = m.actionPlanGet(c.owna_id, apMonth);
  const pcMonth = m.pcMonths(1)[0];
  const pcRow = pcMonth ? m.pcForMonth(pcMonth, c.owna_id)[0] : null;

  res.render("centre", {
    title: c.name,
    from, to,
    centre: c,
    daily,
    summary: {
      ...agg,
      fee_total: m.round(agg.fee_total),
      occupancy: m.pct(agg.booked, capacityDays),
      attendance_rate: m.pct(agg.attended, agg.pastBooked),
      ccs_total: m.ccsTotal(c.owna_id, from, to),
      avg_daily_booked: agg.days ? Math.round(agg.booked / agg.days) : 0,
    },
    presets: presetsFor(),
    fwdPresets: fwdPresetsFor(),
    today: m.todayStr(),
    pipeline,
    occTrend: m.occupancyTrend(c.owna_id, 24),
    exits: m.centreExits(c.owna_id, "past", 100),
    exitsUpcoming: m.centreExits(c.owna_id, "upcoming", 100),
    exitReasons: m.exitReasons(c.owna_id),
    labour,
    labourTrend: m.labourTrend(c.owna_id, 12),
    insights: m.centreInsights(c.owna_id, c.capacity, m.pct(agg.booked, capacityDays), pipeline, labour),
    actionPlan, apMonth,
    pcRow, pcMonth, pcTargets: m.pcTargets(),
    qc: m.qcCentre(c.owna_id),
    lastRun: lastRun(),
  });
});

module.exports = router;
