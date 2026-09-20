// Is the data behind this dashboard actually arriving?
//
// One assessment, read by two things that must never disagree: the unauthenticated /healthz endpoint an
// external monitor polls, and the status dot in the header of every page. If those two ever told
// different stories the dot would be worthless, so they share this function rather than each deciding.
//
// WHY THIS EXISTS. A feed can stop and leave no mark anyone sees. The OWNA pull returned nothing for
// eight days in September 2026 while recording itself as a success; the COE step can fail on a night the
// day-rows step succeeds, so the page prints today's date over older figures. source_sync has always
// held the truth — nothing ever went and looked at it.
//
// WHAT IT REPORTS: statuses, ages and counts. Never source_sync.detail, which is free text from an
// upstream error and has no business on an endpoint anyone on the internet can poll.
const db = require("../db/db");

// The feeds the board's figures are built from. A failure here is worth waking up for.
// The rest — incidents, roster, exits, retention — are reported but do not by themselves mean "down".
const CRITICAL = new Set(["owna", "coe", "lineleader", "eh_labour", "talent"]);

// The snapshot runs nightly at 02:15 Sydney. One missed night puts the newest success about 26 hours
// back, which is the point at which "it is running late" becomes "it did not run". Deliberately not
// 24: a slow run that finishes at 03:00 must not raise an alarm every single morning.
const STALE_AFTER_HOURS = Number(process.env.HEALTH_STALE_HOURS || 26);

const hoursSince = (ts, now) => {
  if (!ts) return null;
  // source_sync stores UTC as "YYYY-MM-DD HH:MM:SS" (SQLite datetime('now')), which Date cannot read
  // without help — parsed as local time it would be hours out, and on a 26-hour threshold that is the
  // difference between "fine" and "down".
  const t = Date.parse(String(ts).replace(" ", "T") + "Z");
  return Number.isFinite(t) ? Math.round(((now - t) / 3600000) * 10) / 10 : null;
};

function feedHealth({ now = Date.now() } = {}) {
  try {
    const sources = db.prepare("SELECT source, status, last_success, last_attempt FROM source_sync ORDER BY source").all();
    const run = db.prepare("SELECT status, finished_at, rows_written FROM snapshot_runs ORDER BY id DESC LIMIT 1").get() || null;

    const problems = [];      // human-readable, generated here — never upstream error text
    const rows = sources.map((s) => {
      const age = hoursSince(s.last_success, now);
      const critical = CRITICAL.has(s.source);
      // "skipped" means not configured (no credentials). That is a deliberate state, not a fault, and a
      // monitor that pages someone because an optional feed is switched off gets muted within a week.
      const configured = s.status !== "skipped";
      const stale = configured && (age === null || age > STALE_AFTER_HOURS);
      const failing = configured && s.status === "error";
      if (failing) problems.push(`${s.source}: last pull failed`);
      else if (stale) problems.push(age === null
        ? `${s.source}: has never completed successfully`
        : `${s.source}: no successful pull for ${age} hours`);
      return { source: s.source, status: s.status || "unknown", critical, configured,
        age_hours: age, stale: !!stale, failing: !!failing };
    });

    const runAge = run ? hoursSince(run.finished_at, now) : null;
    // A run that never finished, or finished too long ago, is itself a fault — this is the case an
    // alert-on-failure scheme cannot see, because nothing threw: the job simply never ran.
    const runStale = !run || runAge === null || runAge > STALE_AFTER_HOURS;
    if (!run) problems.push("no snapshot has ever completed");
    else if (runStale) problems.push(`the nightly snapshot has not completed for ${runAge === null ? "an unknown time" : runAge + " hours"}`);
    else if (run.status === "error") problems.push("the last snapshot run failed outright");

    const criticalBroken = rows.some((r) => r.critical && (r.failing || r.stale));
    const anyBroken = rows.some((r) => r.failing || r.stale);

    const status = (criticalBroken || runStale || (run && run.status === "error")) ? "down"
      : (anyBroken || (run && run.status === "partial")) ? "degraded"
      : "ok";

    return {
      status,
      healthy: status !== "down",                 // what decides the HTTP code
      problems,
      sources: rows,
      last_run: run ? { status: run.status, finished_at: run.finished_at, age_hours: runAge, rows_written: run.rows_written } : null,
      stale_after_hours: STALE_AFTER_HOURS,
    };
  } catch (e) {
    // The health check must never be the thing that breaks. A database it cannot read IS unhealthy, and
    // saying so is more useful than a stack trace — but the message itself is not echoed to the caller.
    console.error("[health] assessment failed:", e && e.name);
    return { status: "down", healthy: false, problems: ["the dashboard could not read its own status"],
      sources: [], last_run: null, stale_after_hours: STALE_AFTER_HOURS };
  }
}

module.exports = { feedHealth, CRITICAL, STALE_AFTER_HOURS };
