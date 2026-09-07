// "Ask your data" — natural-language Q&A over the dashboard, using tool calls.
//
// Claude is given a set of safe, parameterised tools (services/ai-tools.js) and decides which to
// call. It never writes SQL, and every tool enforces centre scoping, so a centre-scoped login can
// only ever retrieve its own centre's numbers. Waitlist tools return counts only — no names.
const m = require("./metrics");
const ai = require("./ai");
const tools = require("./ai-tools");

const short = (n) => (n || "").replace(/Futuro Childcare (and|&) Education\s*-?\s*/i, "").replace(/^Futuro\s+/, "").trim();
const numOrNull = (v) => (v == null || Number.isNaN(v) ? null : v);

// Current-state snapshot (also exposed as the `current_state` tool).
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
    return {
      centre: short(r.name), suburb: r.suburb || null,
      capacity: r.capacity, enrolled: r.enrolled,
      occupancy_pct: r.occupancy, attendance_pct: r.attendance_rate, revenue_this_week: r.fee_total,
      labour_week: lab.week || null,
      wages_pct_of_revenue: numOrNull(lab.wage_pct), margin_pct_after_wages: numOrNull(lab.margin_pct), total_wages_this_week: numOrNull(lab.all_wages),
      turnover_yoy_pct: numOrNull(pc.turnover), enps: numOrNull(pc.enps),
    };
  });

  const t = m.totals(ov);
  const ctx = {
    as_of: { today: m.todayStr(), latest_data_week_ending: range.to, currency: "AUD" },
    definitions: "All percentages are 0-100. revenue/wages are AUD for the latest completed week. wages_pct_of_revenue: lower is better. margin_pct_after_wages: higher is better. turnover_yoy_pct: rolling 12-month staff turnover, lower is better. enps ranges -100..100. Occupancy can exceed 100% when casual bookings push a centre over its licensed places.",
    centres,
  };
  // Group-level aggregates are for see-all roles only — a centre-scoped login must not receive them.
  if (!scopedOwnaId) {
    ctx.group_this_week = { occupancy_pct: t.occupancy, attendance_pct: t.attendance_rate, revenue_this_week: t.fee_total, centre_count: centres.length };
    ctx.group_occupancy_trend_monthly = (m.occupancyTrendGroup(8) || []).map((x) => ({ month: x.month, occupancy_pct: x.occupancy }));
    try { const p = m.llPipeline(); if (p && p.totals) ctx.enrolment_pipeline_totals = p.totals; } catch (e) {}
  }
  return ctx;
}

function systemPrompt(scopedName) {
  return [
    "You are the data analyst for Futuro, an Australian early-learning (childcare) group.",
    `Today's date is ${m.todayStr()}. Timezone Australia/Sydney. Currency AUD. Australian spelling and DD/MM date conventions in prose.`,
    scopedName ? `IMPORTANT: this user is limited to ${scopedName}. Only discuss that centre; the tools will refuse anything else.` : "",
    "",
    "Answer using the TOOLS. Never invent a number. If a tool returns an error, an empty result, or a period outside the data window, say so plainly rather than guessing.",
    "Resolve relative dates yourself before calling a tool. Childcare operates Mon-Fri, so 'the week of 11 January' means Mon 11 Jan to Fri 15 Jan. If a month has already passed this year, assume the user means next year.",
    "",
    "CRITICAL — how to read future occupancy, and you must convey this:",
    "OWNA rolls current recurring enrolments forward indefinitely, so future `occupancy_for_period` numbers are an OVER-estimate: children who will leave have not been deducted. This matters most in January/February, when many 4-5 year olds depart for the school year. Never present a future booked figure as a forecast.",
    "",
    "For any forward-looking question, give a layered breakdown rather than a single number:",
    "  1. Booked now (recurring enrolments rolled forward) — label it a ceiling, not a forecast",
    "  2. Expected starts in/before that period (call expected_starts) — incoming committed children, and which weekdays they want",
    "  3. Waitlist demand wanting care from that period (call waitlist) — unmet demand, by status",
    "Then give your read: which days will be tightest, and what is genuinely uncertain. Note that 'Waitlist' status is soft interest whereas 'Offer Accepted'/'Pre-Offered' are close to converting.",
    "",
    "LABEL EVERY NUMBER WITH THE WINDOW IT COVERS. Each tool echoes back the `filters` it actually used — report that range in your prose. Never describe a 4-month total as if it were one month, and never call a single-centre figure group-wide. If you widen a query, say so.",
    "For \'waitlist wanting care then\', query the whole MONTH containing the period as well as the exact week — families rarely name an exact start date. Report both (\'N wanting care that week, M across January\') so the reader sees true demand.",
    "",
    "Waitlist and pipeline tools return counts and breakdowns only — child and family names are withheld by policy. Do not ask for them or imply they are available.",
    "Format: short Markdown. Lead with the answer. Use real figures. Bullets over paragraphs. Keep it tight — this is read on a phone between rooms.",
  ].filter(Boolean).join("\n");
}

// question: string; history: [{role:'user'|'assistant', content}]; scopedOwnaId: string|null
async function ask(question, history, scopedOwnaId) {
  let scopedName = null;
  if (scopedOwnaId) {
    const c = m.centre(scopedOwnaId);
    scopedName = c ? short(c.name) : "your centre";
  }
  const prior = (history || [])
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim())
    .slice(-6)
    .map((t) => ({ role: t.role, content: t.content.slice(0, 4000) }));

  const messages = prior.concat([{ role: "user", content: String(question).slice(0, 1000) }]);
  const { text, toolCalls } = await ai.completeWithTools({
    system: systemPrompt(scopedName),
    messages,
    tools: tools.TOOL_SPECS,
    runTool: (name, input) => tools.runTool(name, input, scopedOwnaId || null),
    maxTokens: 1400,
  });
  return { answer: text, toolCalls };
}

const EXAMPLES = [
  "What will occupancy be the week of 11 January?",
  "How many families are waiting for care at Austral in January?",
  "Which centres are over budget on wages?",
  "Where is attendance weakest this week?",
  "How many children are due to start next month, and on which days?",
];

module.exports = { gatherContext, ask, EXAMPLES };
