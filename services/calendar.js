// NSW operating-day calendar: an operating day is a weekday that is not a NSW public holiday.
// Dates are YYYY-MM-DD strings throughout (the same convention as daily_metrics.metric_date).
// Extend NSW_HOLIDAYS each year when the NSW Government gazettes the next list. A year with no
// entry falls back to weekdays only — callers can footnote that via unknownHolidayYears().
const NSW_HOLIDAYS = {
  2025: ["01-01", "01-27", "04-18", "04-19", "04-20", "04-21", "04-25", "06-09", "10-06", "12-25", "12-26"],
  2026: ["01-01", "01-26", "04-03", "04-04", "04-05", "04-06", "04-25", "06-08", "10-05", "12-25", "12-26", "12-28"],
  2027: ["01-01", "01-26", "03-26", "03-27", "03-28", "03-29", "04-25", "06-14", "10-04", "12-25", "12-26", "12-27", "12-28"],
};
const HOLIDAY_SET = new Set(Object.entries(NSW_HOLIDAYS).flatMap(([y, days]) => days.map((d) => `${y}-${d}`)));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const toUtc = (dateStr) => new Date(dateStr + "T00:00:00Z");
const fmt = (d) => d.toISOString().slice(0, 10);

function isHoliday(dateStr) { return HOLIDAY_SET.has(dateStr); }
function isWeekday(dateStr) { const dow = toUtc(dateStr).getUTCDay(); return dow >= 1 && dow <= 5; }
function isOperatingDay(dateStr) { return DATE_RE.test(dateStr) && isWeekday(dateStr) && !isHoliday(dateStr); }
function holidaysKnown(year) { return Array.isArray(NSW_HOLIDAYS[Number(year)]); }

// Operating days in [from, to] inclusive, as a list of YYYY-MM-DD strings.
function operatingDayList(from, to) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return [];
  const out = [];
  const end = toUtc(to);
  for (const d = toUtc(from); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const s = fmt(d);
    if (isOperatingDay(s)) out.push(s);
  }
  return out;
}

// Count of operating days in [from, to] inclusive.
function operatingDays(from, to) { return operatingDayList(from, to).length; }

// Calendar years touched by [from, to] that have no holiday list yet (weekdays-only fallback applied).
function unknownHolidayYears(from, to) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return [];
  const [a, b] = from <= to ? [from, to] : [to, from];
  const out = [];
  for (let y = Number(a.slice(0, 4)); y <= Number(b.slice(0, 4)); y++) if (!holidaysKnown(y)) out.push(y);
  return out;
}

module.exports = { NSW_HOLIDAYS, isHoliday, isWeekday, isOperatingDay, holidaysKnown, operatingDayList, operatingDays, unknownHolidayYears };
