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

// ===== "Today" in Sydney =====
// Every DATE-level decision in the app (what today is, which month is current, how far back a window
// reaches) must be made in the centres' own time zone. `new Date().toISOString()` is always UTC no
// matter what TZ is set to, so between midnight and 10am Sydney (11am while daylight saving is on)
// it still reads yesterday's date. Intl with timeZone 'Australia/Sydney' applies the gazetted DST
// rules (starts the first Sunday in October, ends the first Sunday in April) instead of a hard-coded
// +10/+11 offset; en-CA formats as YYYY-MM-DD, the convention used throughout.
const TIME_ZONE = "Australia/Sydney";
const SYDNEY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

// Tests need the app to believe it is a particular instant — a DST boundary, a month or
// financial-year rollover, the 23:30 UTC window where Sydney is already tomorrow. Replacing the
// global Date does that, but it stops the clock for EVERYTHING else in the process as well,
// including the timers Node's own fetch uses to age out a keep-alive socket. A test that awaits an
// HTTP request under a stopped clock therefore leaves a connection that never times out, so
// server.close() never calls back and the whole test file hangs after its assertions have passed.
// So the app's notion of now is injectable here, in the one place every date decision already flows
// through, and nothing else in the process is touched. Production never calls setNow.
let nowFn = () => new Date();
function setNow(at) {
  nowFn = at == null ? () => new Date()
    : typeof at === "function" ? at
    : () => new Date(at);
}
// The Sydney calendar date (YYYY-MM-DD) at instant `at` — defaults to now.
function sydneyDate(at) { return SYDNEY_FMT.format(at === undefined ? nowFn() : at); }
// The current Sydney date. This is "today" everywhere in the app.
function today(at) { return sydneyDate(at); }
// The current Sydney month (YYYY-MM).
function currentMonth(at) { return sydneyDate(at).slice(0, 7); }

// Render a stored timestamp for a reader, in Sydney. SQLite's datetime('now') is UTC and is stored
// space-separated ('2026-09-12 16:20:31'), which V8 parses as LOCAL time — so handing it straight to
// toLocaleString() showed a run that finished 2:20am on 13 Sep as 4:20pm on 12 Sep: ten hours and a
// whole calendar day early, on the one stamp a reader checks to judge whether the numbers are current.
// Marking the value as UTC and pinning timeZone fixes both halves, and leaves nothing to the host's TZ.
function sydneyStamp(ts) {
  if (!ts) return "";
  const s = String(ts).trim().replace(" ", "T");
  const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : s + "Z"); // already zoned? leave it alone
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString("en-AU", { timeZone: TIME_ZONE, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

// Calendar arithmetic on YYYY-MM-DD strings, done in UTC so the host's zone can never shift the
// result. Callers pass a Sydney date in and get a Sydney date back.
function addDays(dateStr, n) { const d = toUtc(dateStr); d.setUTCDate(d.getUTCDate() + n); return fmt(d); }
// `n` days before / after today in Sydney.
function daysAgo(n, at) { return addDays(today(at), -n); }
function daysAhead(n, at) { return addDays(today(at), n); }

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

module.exports = { NSW_HOLIDAYS, isHoliday, isWeekday, isOperatingDay, holidaysKnown, operatingDayList, operatingDays, unknownHolidayYears,
  TIME_ZONE, sydneyDate, today, currentMonth, sydneyStamp, addDays, daysAgo, daysAhead, setNow };
