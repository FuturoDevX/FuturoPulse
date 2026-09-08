// Operations briefing for the date range currently selected on the Overview page.
// Gathers this-range-vs-previous-equal-length-range numbers, asks Claude to write a short
// plain-English briefing, and caches it per range (ai_briefings, keyed "<from>..<to>") so the
// page load is instant and the API is only called when someone generates/refreshes.
const db = require("../db/db");
const m = require("./metrics");
const ai = require("./ai");

const shortName = (n) => (n || "").replace(/Futuro Childcare (and|&) Education\s*-?\s*/i, "").replace(/^Futuro\s+/, "").trim();
const utc = (d) => new Date(d + "T00:00:00Z");
const ymd = (dt) => dt.toISOString().slice(0, 10);
const shift = (d, n) => { const t = utc(d); t.setUTCDate(t.getUTCDate() + n); return ymd(t); };
const spanDays = (from, to) => Math.round((utc(to) - utc(from)) / 86400000) + 1;
const keyOf = (from, to) => `${from}..${to}`;
const pretty = (d) => { const t = utc(d); return t.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };

// Assemble the data packet the briefing is written from, for an arbitrary range.
function gatherRangeData(from, to) {
  const today = m.todayStr();
  const len = spanDays(from, to);
  const prevTo = shift(from, -1), prevFrom = shift(prevTo, -(len - 1));

  const rows = m.overview(from, to);
  const prevRows = m.overview(prevFrom, prevTo);
  const prevBy = {}; prevRows.forEach((r) => { prevBy[r.owna_id] = r; });

  const centres = rows.map((r) => {
    const p = prevBy[r.owna_id] || {};
    return {
      centre: shortName(r.name),
      occupancy_pct: r.occupancy,
      occupancy_pct_prev: p.occupancy != null ? p.occupancy : null,
      attendance_pct: r.attendance_rate,
      revenue: r.fee_total,
      revenue_prev: p.fee_total != null ? p.fee_total : null,
      enrolled: r.enrolled,
      capacity: r.capacity,
    };
  });

  const t = m.totals(rows), tp = m.totals(prevRows);
  const pc = m.pcGroupLatest() || {};
  const isFuture = to > today;
  const isPartlyFuture = !isFuture && from <= today && to >= today;

  return {
    period: { from, to, days: len, label: `${pretty(from)} to ${pretty(to)}` },
    compared_with: { from: prevFrom, to: prevTo, label: `${pretty(prevFrom)} to ${pretty(prevTo)}` },
    today,
    period_is_entirely_in_the_future: isFuture,
    period_includes_future_dates: isPartlyFuture,
    group: {
      occupancy_pct: t.occupancy, occupancy_pct_prev: tp.occupancy,
      attendance_pct: t.attendance_rate,
      revenue: t.fee_total, revenue_prev: tp.fee_total,
      enrolled: t.enrolled, capacity: t.capacity,
    },
    people: { turnover_yoy_pct: pc.turnover, enps: pc.enps, family_nps: pc.family_nps, as_of: pc.month },
    centres,
  };
}

function buildPrompt(data) {
  const fwd = data.period_is_entirely_in_the_future || data.period_includes_future_dates;
  const system = [
    "You are the operations analyst for Futuro, an Australian early-learning (childcare) group.",
    "You write a concise operations briefing for the leadership team from the supplied data.",
    "Be specific and use the numbers. Compare the selected period against the comparison period given.",
    "Occupancy and attendance are percentages; revenue is in AUD; turnover is a rolling 12-month rate (lower is better).",
    "Never invent data that isn't provided. If prior-period figures are null, don't fabricate a trend.",
    fwd ? "IMPORTANT: this period includes FUTURE dates. Future bookings are current recurring enrolments rolled forward and do NOT deduct children who will leave (notably the Jan/Feb school transition), so they OVER-state. Present them as bookings-on-the-books, a ceiling — never as a forecast. Attendance for future dates is meaningless (nobody has attended yet) — do not comment on it." : "",
    "Open with the period you are describing, so the reader knows the briefing matches the dates they selected.",
    "Format as short Markdown: a one-line **Headline**, then **What moved** (3-5 bullets, name centres), then **Watch list** (1-3 bullets). Keep it under ~200 words. Australian spelling.",
  ].filter(Boolean).join(" ");
  const user = `Selected period: ${data.period.label} (${data.period.days} days). Comparison period: ${data.compared_with.label}.\n\nData as JSON:\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n\nWrite the briefing for the selected period.`;
  return { system, user };
}

async function generateBriefing(from, to) {
  const def = m.defaultRange();
  const f = from || def.from, t = to || def.to;
  const data = gatherRangeData(f, t);
  const { system, user } = buildPrompt(data);
  const content = await ai.complete({ system, user, maxTokens: 900 });
  db.prepare(`INSERT INTO ai_briefings (period_key, period_from, period_to, content, model, created_at)
    VALUES (@key,@from,@to,@content,@model,datetime('now'))
    ON CONFLICT(period_key) DO UPDATE SET period_from=@from, period_to=@to, content=@content, model=@model, created_at=datetime('now')`)
    .run({ key: keyOf(f, t), from: f, to: t, content, model: ai.MODEL });
  return getForRange(f, t);
}

// The cached briefing for exactly this range, or null.
function getForRange(from, to) {
  if (!from || !to) return null;
  return db.prepare("SELECT * FROM ai_briefings WHERE period_key = ?").get(keyOf(from, to)) || null;
}
function getLatest() {
  return db.prepare("SELECT * FROM ai_briefings ORDER BY created_at DESC LIMIT 1").get() || null;
}

module.exports = { gatherRangeData, buildPrompt, generateBriefing, getForRange, getLatest, prettyRange: (f, t) => `${pretty(f)} to ${pretty(t)}` };
