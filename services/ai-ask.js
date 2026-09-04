// "Ask your data" — natural-language Q&A over the dashboard.
// Safe by construction: we assemble a compact snapshot of the current data and let Claude
// answer ONLY from it. No SQL is generated or executed, so there's no injection/data-loss risk.
const m = require("./metrics");
const ai = require("./ai");

const short = (n) => (n || "").replace(/Futuro Childcare (and|&) Education\s*-?\s*/i, "").replace(/^Futuro\s+/, "").trim();
const numOrNull = (v) => (v == null || Number.isNaN(v) ? null : v);

// Build the data packet the model answers from. Respects centre scoping: a centre-scoped
// user only ever gets their own centre's numbers.
function gatherContext(scopedOwnaId) {
  const range = m.defaultRange();
  let ov = m.overview(range.from, range.to);
  if (scopedOwnaId) ov = ov.filter((r) => r.owna_id === scopedOwnaId);

  const pcMonth = m.pcMonths(1)[0];
  const pcRows = pcMonth ? m.pcForMonth(pcMonth, scopedOwnaId || undefined) : [];
  const pcBy = {}; pcRows.forEach((r) => { pcBy[r.owna_id] = r; });

  const centres = ov.map((r) => {
    const lab = m.centreLabourLatest(r.owna_id) || {};
    const pc = pcBy[r.owna_id] || {};
    let qcPct = null; try { const q = m.qcSummary(r.owna_id); if (Array.isArray(q) && q.length) qcPct = q[0].overall_pct; else if (q && q.overall_pct != null) qcPct = q.overall_pct; } catch (e) {}
    return {
      centre: short(r.name), suburb: r.suburb || null,
      capacity: r.capacity, enrolled: r.enrolled,
      occupancy_pct: r.occupancy, attendance_pct: r.attendance_rate, revenue_this_week: r.fee_total,
      labour_week: lab.week || null,
      wages_pct_of_revenue: numOrNull(lab.wage_pct), margin_pct_after_wages: numOrNull(lab.margin_pct), total_wages_this_week: numOrNull(lab.all_wages),
      turnover_yoy_pct: numOrNull(pc.turnover), enps: numOrNull(pc.enps),
      latest_audit_overall_pct: qcPct,
    };
  });

  const t = m.totals(ov);
  const occTrend = (m.occupancyTrendGroup(8) || []).map((x) => ({ month: x.month, occupancy_pct: x.occupancy }));
  const ctx = {
    as_of: { today: m.todayStr(), latest_data_week_ending: range.to, currency: "AUD" },
    definitions: "All percentages are 0-100. revenue/wages are AUD for the latest completed week. wages_pct_of_revenue: lower is better. margin_pct_after_wages: higher is better. turnover_yoy_pct: rolling 12-month staff turnover, lower is better. enps ranges -100..100. Occupancy can exceed 100% when casual bookings push a centre over its licensed places.",
    centres,
    group_occupancy_trend_monthly: occTrend,
  };
  if (!scopedOwnaId) {
    ctx.group_this_week = { occupancy_pct: t.occupancy, attendance_pct: t.attendance_rate, revenue_this_week: t.fee_total, centre_count: centres.length };
    try { const p = m.llPipeline(); if (p && p.totals) ctx.enrolment_pipeline_totals = p.totals; } catch (e) {}
  }
  return ctx;
}

const SYSTEM = [
  "You are the data analyst for Futuro, an Australian early-learning (childcare) group.",
  "Answer the user's question using ONLY the JSON data provided with their message. Do not use outside knowledge or invent numbers.",
  "If the data doesn't contain the answer, say so plainly and suggest what's needed — never guess.",
  "Be concise and lead with the answer. Use the actual figures, name centres, and compare where useful. Short Markdown (a sentence or a few bullets). Australian spelling. Currency in AUD.",
  "The data is a current snapshot; if asked about periods not in it, say what you do have.",
].join(" ");

// question: string; history: [{role:'user'|'assistant', content}]; scopedOwnaId: string|null
async function ask(question, history, scopedOwnaId) {
  const ctx = gatherContext(scopedOwnaId);
  const prior = (history || []).filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string").slice(-6)
    .map((t) => ({ role: t.role, content: t.content.slice(0, 4000) }));
  const messages = [
    ...prior,
    { role: "user", content: "DATA (JSON snapshot):\n```json\n" + JSON.stringify(ctx) + "\n```\n\nQuestion: " + String(question).slice(0, 1000) },
  ];
  const answer = await ai.complete({ system: SYSTEM, messages, maxTokens: 800 });
  return { answer };
}

const EXAMPLES = [
  "Which centres are over budget on wages?",
  "How is group occupancy trending?",
  "Which centre has the highest staff turnover?",
  "Where is attendance weakest this week?",
  "Rank the centres by margin after wages.",
];

module.exports = { gatherContext, ask, EXAMPLES };
