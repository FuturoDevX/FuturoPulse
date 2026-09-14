// Retention purge — deletes what this dashboard is no longer allowed to keep.
//
// Runs as the LAST step of the nightly snapshot (services/snapshot.js, the same best-effort step()
// wrapper as every other source, so a failure marks the run partial and shows on the status page),
// and on demand as `npm run purge` (scripts/purge-run.js).
//
// Three rules this job is built around:
//   1. It reports COUNTS, never content. What a deleted row said is not written to the log, to
//      source_sync, or to anything else — that would move the data rather than remove it.
//   2. It never deletes a row it cannot PROVE is past its period. Every WHERE clause runs the stored
//      value through SQLite's date(), which returns NULL for anything it cannot parse, and compares
//      the NORMALISED date. A NULL, an empty string, "unknown", a half-written stamp — none of them
//      are provably old, so all of them are KEPT. (A shaped-but-impossible date such as 2025-02-30
//      normalises FORWARD, to 2 March, so it too errs towards keeping.) A row a human has to look at
//      is a far smaller problem than a row deleted early.
//   3. It is safe to run twice and safe to run on an empty database: every statement is a DELETE
//      with a WHERE, so a second run finds nothing left to match and removes 0.
const fs = require("fs");
const db = require("../db/db");
const cal = require("./calendar");

// ===== The retention periods — the owner's decision of 14 September 2026 =====
// One place. Nothing anywhere else in the codebase may carry a retention number.
//
//   AI briefings            12 months   generated commentary, no personal information, but it ages out
//   Staff feedback          12 months   from the REVIEW, and only once reviewed or dismissed (see below)
//   Nightly run log         90 days     snapshot_runs and the `note` column on each of those rows
//   Exit detail              2 years    child_exits — the row-level departure records
//   Exit aggregate           7 years    exits_monthly — counts per centre per month, no per-child row
//   Signed-in session        8 hours    from the last request. NOT purged here — see SESSIONS below
//
// Kept INDEFINITELY and deliberately untouched by this job: occupancy (daily_metrics, ccs_payments),
// wages (labour_weekly, labour_budget) and incident numbers (incidents_monthly). None of them carries
// personal information, and they are the history every trend on the dashboard is drawn from.
const DEFAULTS = Object.freeze({
  aiBriefingMonths: 12,
  feedbackMonths: 12,
  runLogDays: 90,
  exitDetailMonths: 24,   // 2 years
  exitAggregateMonths: 84, // 7 years
});

// Each period is overridable by environment variable, so a period can be changed without a code
// change (documented in render.yaml and docs/outstanding.md). The defaults above remain the owner's
// approved numbers and are what a deployment falls back to.
const ENV = Object.freeze({
  aiBriefingMonths: "RETAIN_AI_BRIEFINGS_MONTHS",
  feedbackMonths: "RETAIN_FEEDBACK_MONTHS",
  runLogDays: "RETAIN_RUN_LOG_DAYS",
  exitDetailMonths: "RETAIN_EXIT_DETAIL_MONTHS",
  exitAggregateMonths: "RETAIN_EXIT_AGGREGATE_MONTHS",
});

// Sessions are the one table with a period that this job does NOT enforce, because something else
// already does and two sweeps of the same table would only disagree. A row in `sessions` expires
// eight hours after that user's last request (middleware/session.js MAX_AGE_MS), expired rows are
// refused on read, and the store deletes them every fifteen minutes and again at boot. Confirmed,
// not duplicated. tests/retention.test.js asserts SESSION_HOURS still matches what the store enforces,
// so the two cannot drift apart silently.
const SESSION_HOURS = 8;
const SESSIONS = "sessions expire 8h after the last request and are swept by the session store, not here";

// Reclaiming the freed pages is part of deleting: a row released into SQLite's free list is still
// readable in the file. Set RETENTION_RECLAIM=0 only if the VACUUM ever becomes too slow to sit in
// the nightly run — the deletions themselves are unaffected either way.
const reclaimEnabled = () => (process.env.RETENTION_RECLAIM || "1").trim() !== "0";

// Resolve the periods for this run. A malformed, zero or negative override is IGNORED rather than
// obeyed — RETAIN_RUN_LOG_DAYS="ninety" must not become 0 and wipe the whole run log — and the
// caller is told which one was ignored.
function periods(log = () => {}) {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const raw = (process.env[ENV[key]] || "").trim();
    const n = raw === "" ? NaN : Number(raw);
    const usable = Number.isInteger(n) && n > 0;
    out[key] = usable ? n : fallback;
    if (raw !== "" && !usable) {
      log(`[purge] ignoring ${ENV[key]}="${raw}" — not a positive whole number of periods; keeping the approved ${fallback}`);
    }
  }
  return out;
}

// n months before a YYYY-MM-DD date, clamped to the end of the target month (1 month before 31 March
// is 28 February, not 3 March). Calendar arithmetic on strings, as everywhere else in this codebase.
function monthsBefore(dateStr, n) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const total = y * 12 + (m - 1) - n;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const pad = (v, w = 2) => String(v).padStart(w, "0");
  return `${pad(ny, 4)}-${pad(nm + 1)}-${pad(Math.min(d, lastDay))}`;
}

// The oldest value each table may still hold, as at Sydney date `at`. A row dated EXACTLY the cutoff
// is exactly its period old and is kept; only strictly older goes. That is what makes "one day inside
// and one day outside" a meaningful boundary rather than an off-by-one.
function cutoffs(p, at) {
  return {
    ai_briefings: monthsBefore(at, p.aiBriefingMonths),
    feedback: monthsBefore(at, p.feedbackMonths),
    snapshot_runs: cal.addDays(at, -p.runLogDays),
    child_exits: monthsBefore(at, p.exitDetailMonths),
    exits_monthly: monthsBefore(at, p.exitAggregateMonths).slice(0, 7), // YYYY-MM
  };
}

// The tables this job touches, in the order it touches them. Every clause guards with
// `date(...) IS NOT NULL` first: see rule 2 at the top of this file.
const TABLES = ["ai_briefings", "feedback", "snapshot_runs", "child_exits", "exits_monthly"];
const STATEMENTS = {
  // Cached weekly briefings, keyed by the range they cover; created_at is a UTC datetime.
  ai_briefings: `DELETE FROM ai_briefings
                  WHERE date(created_at) IS NOT NULL AND date(created_at) < @cut`,

  // Only feedback somebody has actually dealt with, and the twelve months run from the REVIEW rather
  // than from the submission — that is the period the owner set, and measuring from created_at would
  // delete a two-year-old complaint the same night someone finally read it. A 'new' row survives
  // however old it is: it is still waiting on a human, and its reviewed_at is NULL, so both halves of
  // this clause refuse it. A row whose status is NULL or unrecognised is not 'reviewed or dismissed'
  // either, and a row triaged before reviewed_at existed has NULL there — neither is provably past
  // its period, so both are kept.
  feedback: `DELETE FROM feedback
              WHERE status IN ('reviewed','dismissed')
                AND date(reviewed_at) IS NOT NULL AND date(reviewed_at) < @cut`,

  // The nightly run log, including each row's `note` (the note is a column on this table, so the row
  // going takes it). The single most recent run is always kept regardless of age: it is what the
  // status page reads to say when the data was last refreshed, it holds no personal information, and
  // a dashboard that has been idle for 90 days should still be able to say so.
  snapshot_runs: `DELETE FROM snapshot_runs
                   WHERE date(started_at) IS NOT NULL AND date(started_at) < @cut
                     AND id <> (SELECT MAX(id) FROM snapshot_runs)`,

  // Row-level departure detail. Already de-identified (no name, no date of birth — child_key is a
  // salted hash whose salt is never stored), and now also time-limited.
  child_exits: `DELETE FROM child_exits
                 WHERE date(finish_date) IS NOT NULL AND date(finish_date) < @cut`,

  // The monthly aggregate the detail is folded into before it goes. Counts only, so it lives far
  // longer — seven years — and it is what keeps exits-by-year and tenure history intact after the
  // per-child rows above have been removed.
  exits_monthly: `DELETE FROM exits_monthly
                   WHERE date(month || '-01') IS NOT NULL
                     AND substr(date(month || '-01'), 1, 7) < @cut`,
};

const fileBytes = () => {
  try { return fs.statSync(db.name).size; } catch { return null; }
};

// Run the purge. Synchronous (better-sqlite3), so the snapshot's `await step(...)` and the CLI can
// both just call it. Returns counts, cutoffs and the periods used — never a deleted row's content.
function runPurge({ log = console.log } = {}) {
  const at = cal.today();                 // Sydney, like every other date decision in this app
  const p = periods(log);
  const cut = cutoffs(p, at);

  // One transaction: either the whole night's purge applies or none of it does, so a failure part
  // way through can never leave one table trimmed and another not.
  const removed = db.transaction(() => {
    const out = {};
    for (const table of TABLES) out[table] = db.prepare(STATEMENTS[table]).run({ cut: cut[table] }).changes;
    return out;
  })();

  const total = TABLES.reduce((n, t) => n + removed[t], 0);
  const counts = TABLES.map((t) => `${t} ${removed[t]}`).join(", ");

  // Give the deleted rows' pages back to the operating system. A DELETE only moves a page onto
  // SQLite's free list, where the old bytes are still there to be read out of the file.
  let reclaimedBytes = null, reclaimError = null;
  if (total > 0 && reclaimEnabled()) {
    const before = fileBytes();
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      db.pragma("wal_checkpoint(TRUNCATE)"); // land the rewrite in the file, not just in a new WAL
      const after = fileBytes();
      reclaimedBytes = before != null && after != null ? before - after : null;
    } catch (e) {
      // The rows are gone either way; only the page reclaim failed. Say so rather than fail the run.
      reclaimError = String((e && e.message) || e).slice(0, 120);
    }
  }

  const detail = (total ? `removed ${total} rows — ${counts}` : `nothing past its period — ${counts}`)
    + (reclaimError ? `; pages not reclaimed: ${reclaimError}` : "")
    + `; ${SESSIONS}`;

  log(`[purge] as at ${at}: ${total ? `removed ${total} rows (${counts})` : `nothing past its period (${counts})`}`);
  for (const t of TABLES) log(`[purge]   ${t}: kept back to ${cut[t]}, removed ${removed[t]}`);
  if (reclaimedBytes != null) log(`[purge] reclaimed ${reclaimedBytes} bytes (WAL checkpoint + VACUUM) so removed rows are not recoverable from the database file`);
  if (reclaimError) log(`[purge] WARNING: pages could not be reclaimed (${reclaimError}) — the rows are deleted, but the freed pages still hold their bytes`);
  log(`[purge] ${SESSIONS}`);

  return { at, periods: p, cutoffs: cut, removed, total, detail, sessions: SESSIONS, reclaimedBytes, reclaimError };
}

// STATEMENTS is exported so a test can read the SQL this job actually runs — in particular, that not
// one clause names `sessions`, and that every clause guards with date(...) IS NOT NULL.
module.exports = { runPurge, periods, cutoffs, monthsBefore, DEFAULTS, ENV, TABLES, STATEMENTS, SESSION_HOURS, SESSIONS };
