const express = require("express");
const m = require("../services/metrics");
const { blockScoped, scopedOwnaId } = require("../middleware/auth");
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

// Quality & Compliance (from uploaded audit).
router.get("/qc", (req, res) => {
  const scoped = scopedOwnaId(req);
  const summary = m.qcSummary(scoped).map((sc) => ({ ...sc, actions: (m.qcCentre(sc.owna_id) || {}).actions || [] }));
  res.render("qc", { title: "Quality & Compliance", summary, lastRun: lastRun() });
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
    pipeline: m.llForCentre(c.owna_id),
    occTrend: m.occupancyTrend(c.owna_id, 24),
    exits: m.centreExits(c.owna_id, "past", 100),
    exitsUpcoming: m.centreExits(c.owna_id, "upcoming", 100),
    exitReasons: m.exitReasons(c.owna_id),
    lastRun: lastRun(),
  });
});

module.exports = router;
