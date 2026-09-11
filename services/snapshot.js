// Pulls a rolling window from OWNA and aggregates it into daily_metrics + ccs_payments.
// Safe to re-run: everything is upserted by (centre, day) / (centre, week).
const db = require("../db/db");
const { owna } = require("./owna");
const { lineleader } = require("./lineleader");
const { runLabourSnapshot } = require("./eh-labour");

const WINDOW_DAYS = parseInt(process.env.SNAPSHOT_WINDOW_DAYS || "120", 10);
// How far FORWARD to pull scheduled/booked data (OWNA bookings + LineLeader expected starts).
const FORWARD_DAYS = parseInt(process.env.SNAPSHOT_FORWARD_DAYS || "90", 10);

// LineLeader locations that aren't real centres.
const LL_EXCLUDE = new Set(["Staff Location", "Z-Test Location"]);

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function daysAhead(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
const today = () => new Date().toISOString().slice(0, 10);

// Match an OWNA centre name to a LineLeader centre (handles the Heath Rd <-> Leppington Heath alias).
function matchLlCentre(ownaName, llCentres) {
  const norm = (s) => (s || "").toLowerCase().replace(/futuro childcare (and|&) education/g, "").replace(/[^a-z]/g, "");
  const aliases = { heathrd: "leppingtonheath" };
  const key = norm(ownaName);
  const target = aliases[key] || key;
  return llCentres.find((c) => {
    const n = norm(c.values ? c.values.name : c.name);
    return n && target && (n.includes(target) || target.includes(n));
  });
}

// Sum of room capacities = licensed places for the centre.
async function centreCapacity(centreId) {
  const rooms = await owna.listRooms(centreId);
  return rooms.reduce((s, r) => s + (Number(r.capacity) || 0), 0);
}

const upsertCentre = db.prepare(`
  INSERT INTO centres (owna_id, name, alias, suburb, state, capacity, enrolled, closed, approval_no, last_updated)
  VALUES (@owna_id, @name, @alias, @suburb, @state, @capacity, @enrolled, @closed, @approval_no, @last_updated)
  ON CONFLICT(owna_id) DO UPDATE SET
    name=@name, alias=@alias, suburb=@suburb, state=@state, capacity=@capacity,
    enrolled=@enrolled, closed=@closed, approval_no=@approval_no, last_updated=@last_updated
`);

const upsertDaily = db.prepare(`
  INSERT INTO daily_metrics (owna_id, metric_date, capacity, booked, attended, absent, casual, fee_total)
  VALUES (@owna_id, @metric_date, @capacity, @booked, @attended, @absent, @casual, @fee_total)
  ON CONFLICT(owna_id, metric_date) DO UPDATE SET
    capacity=@capacity, booked=@booked, attended=@attended, absent=@absent,
    casual=@casual, fee_total=@fee_total
`);

const upsertCcs = db.prepare(`
  INSERT INTO ccs_payments (owna_id, week_starting, amount)
  VALUES (@owna_id, @week_starting, @amount)
  ON CONFLICT(owna_id, week_starting) DO UPDATE SET amount=@amount
`);

// ----- Error summaries & per-source sync health -----
// The upstream clients (owna / eh / lineleader) throw "<source> <status> <path>" and never include a
// response body, so an error's name + message is safe to log and store. Keep it one line and bounded.
// Two exceptions the clients cannot control: undici echoes the offending header VALUE in its
// header-validation TypeError (a credential with a stray newline), and any library may quote an
// input. So every configured secret is redacted from the text, and header errors lose their quotes.
const SECRET_NAME = /KEY|SECRET|PASSWORD|PASSPHRASE|TOKEN|USERNAME/i;
function secretValues() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!SECRET_NAME.test(k) || !v) continue;
    const whole = String(v).replace(/\s+/g, " ").trim();
    if (whole.length >= 6) out.push(whole);
    for (const part of whole.split(" ")) if (part.length >= 6) out.push(part);
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}
function errSummary(e) {
  const msg = e && e.message != null ? String(e.message) : String(e);
  const name = e && e.name && e.name !== "Error" ? e.name + ": " : "";
  let text = (name + msg).replace(/\s+/g, " ").trim();
  if (/invalid header (value|name)|Headers\.(append|set)/i.test(text)) text = text.replace(/"[^"]*"/g, '"[redacted]"');
  for (const v of secretValues()) text = text.split(v).join("[redacted]");
  return text.slice(0, 240) || "unknown error";
}

// One row per upstream source. A failed run keeps the rows/meta of the last successful one so a
// page can say "showing pay periods to X from the import on Y" while flagging today's failure.
const upsertSync = db.prepare(`
  INSERT INTO source_sync (source, last_attempt, last_success, status, detail, rows, meta_json)
  VALUES (@source, datetime('now'), CASE WHEN @status = 'ok' THEN datetime('now') END, @status, @detail, @rows, @meta_json)
  ON CONFLICT(source) DO UPDATE SET
    last_attempt = datetime('now'),
    last_success = CASE WHEN excluded.status = 'ok' THEN datetime('now') ELSE source_sync.last_success END,
    status       = excluded.status,
    detail       = excluded.detail,
    rows         = CASE WHEN excluded.status = 'ok' THEN excluded.rows      ELSE source_sync.rows      END,
    meta_json    = CASE WHEN excluded.status = 'ok' THEN excluded.meta_json ELSE source_sync.meta_json END
`);
function recordSync(source, status, detail = null, { rows = null, meta = null } = {}) {
  upsertSync.run({ source, status, detail: detail == null ? null : String(detail).slice(0, 240), rows, meta_json: meta ? JSON.stringify(meta) : null });
}
const withMeta = (r) => (r ? { ...r, meta: r.meta_json ? JSON.parse(r.meta_json) : null } : null);
function sourceSync() { return db.prepare(`SELECT * FROM source_sync ORDER BY source`).all().map(withMeta); }
function sourceSyncFor(source) { return withMeta(db.prepare(`SELECT * FROM source_sync WHERE source = ?`).get(source)); }

async function runSnapshot({ windowDays = WINDOW_DAYS, forwardDays = FORWARD_DAYS, log = console.log } = {}) {
  const from = daysAgo(windowDays);
  const to = daysAhead(forwardDays); // include future scheduled bookings
  const run = db.prepare(
    `INSERT INTO snapshot_runs (started_at, status, window_from, window_to) VALUES (datetime('now'),'running',?,?)`
  ).run(from, to);
  const runId = run.lastInsertRowid;
  let rowsWritten = 0;

  try {
    const centres = await owna.listCentres();
    log(`[snapshot] ${centres.length} centres, window ${from} → ${to}`);

    for (const c of centres) {
      const capacity = await centreCapacity(c.id);
      upsertCentre.run({
        owna_id: c.id,
        name: c.name || "",
        alias: c.alias || null,
        suburb: c.suburb || null,
        state: c.state || null,
        capacity,
        enrolled: Number(c.children) || 0,
        closed: c.closed ? 1 : 0,
        approval_no: c.serviceApprovalNumber || null,
        last_updated: c.lastUpdated || null,
      });

      // Attendance → aggregate per day.
      const att = await owna.attendance(c.id, from, to);
      const byDay = new Map();
      for (const r of att) {
        const day = (r.attendanceDate || "").slice(0, 10);
        if (!day) continue;
        let m = byDay.get(day);
        if (!m) { m = { booked: 0, attended: 0, absent: 0, casual: 0, fee_total: 0 }; byDay.set(day, m); }
        m.booked += 1;
        if (r.attending) m.attended += 1; else m.absent += 1;
        if (r.casualBooking) m.casual += 1;
        m.fee_total += Number(r.fee) || 0;
      }
      const writeDays = db.transaction((entries) => {
        for (const [day, m] of entries) {
          upsertDaily.run({
            owna_id: c.id, metric_date: day, capacity,
            booked: m.booked, attended: m.attended, absent: m.absent,
            casual: m.casual, fee_total: Math.round(m.fee_total * 100) / 100,
          });
          rowsWritten += 1;
        }
      });
      writeDays([...byDay.entries()]);

      // CCS payments → aggregate per clearing week.
      try {
        const ccs = await owna.ccsPayments(c.id, from, to);
        const byWeek = new Map();
        for (const p of ccs) {
          const wk = (p.weekStarting || p.clearingDocumentDate || "").slice(0, 10);
          if (!wk) continue;
          byWeek.set(wk, (byWeek.get(wk) || 0) + (Number(p.amount) || 0));
        }
        const writeCcs = db.transaction((entries) => {
          for (const [wk, amt] of entries) {
            upsertCcs.run({ owna_id: c.id, week_starting: wk, amount: Math.round(amt * 100) / 100 });
          }
        });
        writeCcs([...byWeek.entries()]);
      } catch (e) {
        log(`[snapshot] CCS pull failed for ${c.name}: ${errSummary(e)}`);
      }

      log(`[snapshot] ${c.name}: ${att.length} bookings, ${byDay.size} days, capacity ${capacity}`);
    }

    recordSync("owna", "ok", `${centres.length} centres, ${rowsWritten} day-rows`, { rows: rowsWritten, meta: { from, to, centres: centres.length } });

    // Best-effort sub-steps. A failure never fails the OWNA snapshot, but it IS recorded — per source
    // in source_sync, in this run's note, and in the log — so a stalled feed is visible, not silent.
    const problems = [];
    const step = async (source, label, fn, summarise) => {
      try {
        const r = await fn();
        if (r && r.skipped) { recordSync(source, "skipped", r.reason || "not configured"); return r; }
        const sm = (summarise && r) ? summarise(r) : {};
        if (sm.problem) { // resolved, but not a usable result: keep last-good data, flag the run
          recordSync(source, "error", sm.problem);
          problems.push(`${label}: ${sm.problem}`);
          log(`[snapshot] ${label}: ${sm.problem}`);
          return r;
        }
        recordSync(source, "ok", sm.detail || null, { rows: sm.rows ?? null, meta: sm.meta || null });
        return r;
      } catch (e) {
        const why = errSummary(e);
        recordSync(source, "error", why);
        problems.push(`${label} failed: ${why}`);
        log(`[snapshot] ${label} failed: ${why}`);
        return null;
      }
    };

    // Per-centre loops swallow individual failures so one bad centre cannot sink the rest; these
    // turn "every call failed" into a problem and "some failed" into a visible note.
    const coverage = (r, unit) => (r.failed ? ` (${r.failed} of ${r.attempts} ${unit} failed: ${r.firstError})` : "");
    const outage = (r, what) => (r.attempts && r.failed === r.attempts ? `every OWNA ${what} call failed: ${r.firstError}` : null);

    // LineLeader pipeline.
    await step("lineleader", "LineLeader pull", () => runLineLeaderSnapshot({ windowDays, forwardDays, log }), (r) => ({
      problem: r.failures && r.failures.length ? `LineLeader ${r.failures.join("; ")}` : null,
      rows: r.cells ?? null,
      detail: r.cells != null ? `${r.cells} pipeline cells, ${r.started} starts, ${r.withdrawn} withdrawals` : "nothing pulled",
    }));

    // Employment Hero payroll → weekly wages per centre.
    await step("eh_labour", "EH payroll import", () => runLabourSnapshot({ log }), (r) => {
      const periods = (r.reconciliation || []).map((x) => x.period_ending).filter(Boolean).sort();
      const latest = periods[periods.length - 1] || null;
      if (!r.weeks) return { problem: "Employment Hero returned no finalised pay runs; wages left as previously imported" };
      return {
        rows: r.rows ?? null,
        detail: `${r.runs} finalised pay runs over ${r.weeks} pay periods to ${latest}`,
        meta: { weeks: r.weeks || 0, runs: r.runs || 0, latest_period: latest, total_wages: r.total_wages ?? null },
      };
    });

    // Exit report (OWNA departures + LineLeader reasons).
    await step("exits", "exit report", () => runExitReport({ log }), (r) => ({
      problem: outage(r, "children"), rows: r.total ?? null,
      detail: r.total != null ? `${r.total} departures, ${r.matched} with a LineLeader reason${coverage(r, "centres")}` : "exit report rebuilt",
    }));

    // Child incidents (safety).
    await step("incidents", "incidents", () => runIncidents({ windowDays, log }),
      (r) => ({ problem: outage(r, "incident"), rows: r.rows ?? null, detail: `${r.rows} centre-months${coverage(r, "centres")}` }));

    // Weekly staff roster.
    await step("roster", "roster", () => runRoster({ log }),
      (r) => ({ problem: outage(r, "roster"), rows: r.rows ?? null, detail: `${r.rows} centre-weeks${coverage(r, "centre-weeks")}` }));

    const status = problems.length ? "partial" : "ok";
    db.prepare(
      `UPDATE snapshot_runs SET finished_at=datetime('now'), status=?, rows_written=?, note=? WHERE id=?`
    ).run(status, rowsWritten, problems.length ? problems.join("; ").slice(0, 1000) : null, runId);
    log(`[snapshot] done (${status}) — ${rowsWritten} day-rows written${problems.length ? `; ${problems.length} source(s) failed` : ""}`);
    return { ok: true, status, rowsWritten, from, to, problems };
  } catch (e) {
    const why = errSummary(e);
    recordSync("owna", "error", why);
    db.prepare(
      `UPDATE snapshot_runs SET finished_at=datetime('now'), status='error', note=? WHERE id=?`
    ).run(why, runId);
    log(`[snapshot] ERROR: ${why}`);
    throw e;
  }
}


// ===== Child incidents -> per-centre per-month safety counts =====
async function runIncidents({ windowDays = WINDOW_DAYS, log = console.log } = {}) {
  const from = daysAgo(windowDays), to = today();
  const centres = await owna.listCentres();
  const upsert = db.prepare(`INSERT INTO incidents_monthly (owna_id, month, total, injuries, illness, serious, reportable, updated_at)
    VALUES (@owna_id,@month,@total,@injuries,@illness,@serious,@reportable,datetime('now'))
    ON CONFLICT(owna_id, month) DO UPDATE SET total=@total, injuries=@injuries, illness=@illness, serious=@serious, reportable=@reportable, updated_at=datetime('now')`);
  const flag = (v) => v === true || ["yes", "y", "true", "1"].includes(String(v).trim().toLowerCase());
  // Classify from OWNA's structured `affected` array (e.g. ["Cut/open wound"], ["High temperature"]).
  // Serious Incident (National Regulations reg 12): OWNA's own report asks "emergency services attend?"
  // and "medical attention sought from a registered practitioner/hospital?" — the two reg-12 criteria.
  // The explicit "Is this a Serious Incident?" Yes/No is NOT returned by the API, so we derive it from
  // those two booleans. `serious` = emergency services attended; `reportable` = serious incident (either flag).
  const ILLNESS  = /temperature|fever|rash|vomit|diarrh|nausea|illness|infectious|respiratory|hand.?foot|unwell|\bsick\b|cough/;
  const NONINJURY = /behaviour|behavior|meltdown|recount of events|no injury|no mark|no visible|no sign|monitor/;
  let rows = 0, failed = 0, firstError = null;
  for (const c of centres) {
    let inc;
    try { inc = await owna.childIncidents(c.id, from, to); } catch (e) { failed += 1; firstError = firstError || errSummary(e); log(`[incidents] ${c.name}: ${errSummary(e)}`); continue; }
    const byMonth = new Map();
    for (const r of inc) {
      const month = (r.incidentDate || "").slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      let m = byMonth.get(month); if (!m) { m = { total: 0, injuries: 0, illness: 0, serious: 0, reportable: 0 }; byMonth.set(month, m); }
      m.total += 1;
      const affected = (Array.isArray(r.affected) ? r.affected : []).map((x) => String(x).toLowerCase());
      const joined = affected.join(" | ");
      const isIllness = ILLNESS.test(joined);
      const isNonInjury = NONINJURY.test(joined);
      if (isIllness) m.illness += 1;
      else if (affected.length && !isNonInjury) m.injuries += 1;
      const emerg = flag(r.emergencyServices), med = flag(r.medicalAttention);
      if (emerg) m.serious += 1;                 // emergency services attended
      if (emerg || med) m.reportable += 1;       // serious incident (reg 12): emergency services OR medical attention
    }
    const write = db.transaction((entries) => { for (const [month, m] of entries) { upsert.run({ owna_id: c.id, month, ...m }); rows += 1; } });
    write([...byMonth.entries()]);
  }
  log(`[incidents] ${rows} centre-months written${failed ? `, ${failed} of ${centres.length} centres failed` : ""}`);
  return { ok: true, rows, attempts: centres.length, failed, firstError };
}

// ===== Weekly staff roster -> per-centre per-week rostered hours + hours/booking =====
const ROSTER_DOW = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
function recentMondays(n) {
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const out = []; const d = new Date();
  d.setHours(12, 0, 0, 0); // noon local avoids any DST/tz edge
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to this week's Monday
  for (let i = 0; i < n; i++) { out.push(ymd(d)); d.setDate(d.getDate() - 7); }
  return out;
}
async function runRoster({ weeks = 14, log = console.log } = {}) {
  const centres = await owna.listCentres();
  const mondays = recentMondays(weeks);
  const upsert = db.prepare(`INSERT INTO roster_weekly (owna_id, week_starting, total_hours, days_json, leave_json, updated_at)
    VALUES (@owna_id,@week_starting,@total_hours,@days_json,@leave_json,datetime('now'))
    ON CONFLICT(owna_id, week_starting) DO UPDATE SET total_hours=@total_hours, days_json=@days_json, leave_json=@leave_json, updated_at=datetime('now')`);
  let rows = 0, attempts = 0, failed = 0, firstError = null;
  const loggedCentre = new Set();
  for (const c of centres) {
    for (const wk of mondays) {
      let r;
      attempts += 1;
      try { r = await owna.weeklyRoster(c.id, wk); } catch (e) {
        failed += 1; firstError = firstError || errSummary(e);
        if (!loggedCentre.has(c.id)) { loggedCentre.add(c.id); log(`[roster] ${c.name} ${wk}: ${errSummary(e)} (further weeks for this centre not logged)`); }
        continue;
      }
      if (!r) continue;
      // rosteredhours is an array of single-day objects each carrying that day's hours + hoursperbooking.
      const rh = {};
      (r.rosteredhours || []).forEach((o) => { for (const d of ROSTER_DOW) if (o[d] != null) rh[d] = { hours: Number(o[d]) || 0, hpb: o.hoursperbooking != null ? Number(o.hoursperbooking) : null }; });
      let total = 0;
      const days = ROSTER_DOW.map((d) => {
        const shifts = Array.isArray(r[d]) ? r[d] : [];
        const staff = new Set(shifts.map((s) => s.staffid));
        const h = rh[d] ? rh[d].hours : 0; total += h;
        return { day: d, hours: Math.round(h * 10) / 10, hpb: rh[d] ? rh[d].hpb : null, shifts: shifts.length, staff: staff.size };
      });
      const leave = (Array.isArray(r.leave) ? r.leave : []).map((l) => ({ staff: l.staff, leavetype: l.leavetype, day: l.day, hours: l.hours }));
      upsert.run({ owna_id: c.id, week_starting: wk, total_hours: Math.round(total * 10) / 10, days_json: JSON.stringify(days), leave_json: JSON.stringify(leave) });
      rows += 1;
    }
  }
  log(`[roster] ${rows} centre-weeks written${failed ? `, ${failed} of ${attempts} calls failed` : ""}`);
  return { ok: true, rows, attempts, failed, firstError };
}

function lastRun() {
  return db.prepare(`SELECT * FROM snapshot_runs ORDER BY id DESC LIMIT 1`).get();
}

// One-time deep history backfill of OWNA occupancy/fees into daily_metrics.
// The nightly snapshot never deletes old rows, so backfilled history persists.
// Pulls in monthly chunks to keep each request small.
async function runOwnaBackfill({ backDays = 730, log = console.log } = {}) {
  const start = new Date(Date.now() - backDays * 864e5);
  const today = new Date();
  const centres = await owna.listCentres();
  log(`[backfill] ${centres.length} centres, ${start.toISOString().slice(0, 10)} → ${today.toISOString().slice(0, 10)}`);
  let rows = 0;
  for (const c of centres) {
    const capacity = await centreCapacity(c.id);
    // Walk month by month.
    let cur = new Date(start);
    while (cur < today) {
      const from = cur.toISOString().slice(0, 10);
      const next = new Date(cur); next.setMonth(next.getMonth() + 1);
      const to = (next < today ? next : today).toISOString().slice(0, 10);
      try {
        const att = await owna.attendance(c.id, from, to);
        const byDay = new Map();
        for (const r of att) {
          const day = (r.attendanceDate || "").slice(0, 10);
          if (!day || day < from || day > to) continue;
          let m = byDay.get(day);
          if (!m) { m = { booked: 0, attended: 0, absent: 0, casual: 0, fee_total: 0 }; byDay.set(day, m); }
          m.booked += 1;
          if (r.attending) m.attended += 1; else m.absent += 1;
          if (r.casualBooking) m.casual += 1;
          m.fee_total += Number(r.fee) || 0;
        }
        const write = db.transaction((entries) => {
          for (const [day, m] of entries) {
            upsertDaily.run({ owna_id: c.id, metric_date: day, capacity,
              booked: m.booked, attended: m.attended, absent: m.absent,
              casual: m.casual, fee_total: Math.round(m.fee_total * 100) / 100 });
            rows += 1;
          }
        });
        write([...byDay.entries()]);
      } catch (e) { log(`[backfill] ${c.name} ${from}: ${errSummary(e)}`); }
      cur = next;
    }
    log(`[backfill] ${c.name} done`);
  }
  log(`[backfill] complete — ${rows} day-rows`);
  return { ok: true, rows };
}

// ===== Exit report: OWNA departures enriched with LineLeader withdrawal reasons =====

// Only report exits within this look-back (older departures aren't operationally useful).
const EXIT_LOOKBACK_DAYS = parseInt(process.env.EXIT_LOOKBACK_DAYS || "365", 10);

// OWNA stores dates as local-midnight in UTC (e.g. 2025-03-05T13:00:00Z = 6 Mar AEDT),
// so convert to the Sydney calendar date before comparing/keying. LineLeader plain dates
// (YYYY-MM-DD) pass through unchanged.
function localDate(s) {
  if (!s) return null;
  const d0 = String(s).slice(0, 10);
  if (d0.startsWith("0001") || d0.startsWith("1900") || d0 === "2000-01-01") return null;
  try {
    const d = new Date(s);
    if (isNaN(d)) return d0;
    return d.toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" }); // YYYY-MM-DD
  } catch { return d0; }
}
// Normalised child key for cross-system matching: first+last name + local dob.
function childKey(name, dob) {
  const n = (name || "").toLowerCase().replace(/[^a-z]/g, "");
  return `${n}|${localDate(dob) || ""}`;
}

const upsertExit = db.prepare(`
  INSERT INTO child_exits (owna_id, child_key, child_name, dob, room, start_date, finish_date, tenure_days, upcoming, reason, reason_source, updated_at)
  VALUES (@owna_id, @child_key, @child_name, @dob, @room, @start_date, @finish_date, @tenure_days, @upcoming, @reason, @reason_source, datetime('now'))
  ON CONFLICT(owna_id, child_key, finish_date) DO UPDATE SET
    child_name=@child_name, dob=@dob, room=@room, start_date=@start_date, tenure_days=@tenure_days,
    upcoming=@upcoming, reason=@reason, reason_source=@reason_source, updated_at=datetime('now')
`);

async function runExitReport({ log = console.log } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = daysAgo(EXIT_LOOKBACK_DAYS);

  // 1) Build a LineLeader reason map keyed by name|dob (withdrawals over a wide window).
  const reasonMap = new Map();
  if (lineleader.hasCreds()) {
    try {
      const isoSec = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
      const from = isoSec(new Date(Date.now() - (EXIT_LOOKBACK_DAYS + 120) * 864e5));
      const to = isoSec(new Date(Date.now() + 30 * 864e5));
      const wd = await lineleader.enrolmentsWithdrawn(from, to);
      for (const r of wd) {
        const nm = r.child && r.child.values && r.child.values.name;
        const dob = r.child && r.child.values && r.child.values.birthdate;
        const reason = r.withdrawn && r.withdrawn.reason && r.withdrawn.reason.values && r.withdrawn.reason.values.value;
        if (nm) reasonMap.set(childKey(nm, dob), reason || null);
      }
      log(`[exits] LineLeader withdrawal reasons: ${reasonMap.size}`);
    } catch (e) {
      log(`[exits] LineLeader reason map failed: ${errSummary(e)}`);
    }
  }

  // 2) OWNA children with a finishDate → the authoritative exit list.
  let total = 0, matched = 0, failed = 0, firstError = null;
  // Operating centres only — pre-opening centres are LineLeader-only and have no OWNA children yet.
  const centres = db.prepare(`SELECT owna_id, name FROM centres WHERE (opening IS NULL OR opening = 0)`).all();
  for (const c of centres) {
    let kids;
    try { kids = await owna.listChildren(c.owna_id); } catch (e) { failed += 1; firstError = firstError || errSummary(e); log(`[exits] ${c.name}: children pull failed: ${errSummary(e)}`); continue; }
    const write = db.transaction((list) => {
      db.prepare(`DELETE FROM child_exits WHERE owna_id = ?`).run(c.owna_id); // full rebuild per centre
      for (const k of list) {
        const finish = localDate(k.finishDate);
        if (!finish || finish < cutoff) continue; // only exits within look-back (past or upcoming)
        const name = `${k.firstname || ""} ${k.surname || ""}`.trim();
        const dob = localDate(k.dob);
        // Earliest sensible start on/before the finish date (OWNA sometimes has a future
        // officialstartdate placeholder — ignore any start that is after the finish).
        const startCandidates = [localDate(k.activeFrom), localDate(k.officialstartdate)]
          .filter(Boolean).filter((d) => d <= finish).sort();
        const start = startCandidates[0] || null;
        const tenure = start ? Math.round((new Date(finish) - new Date(start)) / 864e5) : null;
        const key = childKey(name, dob);
        const hasReason = reasonMap.has(key);
        const reason = hasReason ? reasonMap.get(key) : null;
        if (hasReason) matched += 1;
        upsertExit.run({
          owna_id: c.owna_id, child_key: key, child_name: name, dob, room: k.room || null,
          start_date: start, finish_date: finish, tenure_days: tenure,
          upcoming: finish > today ? 1 : 0,
          reason: reason || (hasReason ? "Unknown" : null),
          reason_source: hasReason ? "lineleader" : null,
        });
        total += 1;
      }
    });
    write(kids);
  }
  log(`[exits] ${total} exits (within ${EXIT_LOOKBACK_DAYS}d), ${matched} matched to a LineLeader reason`);
  return { ok: true, total, matched, attempts: centres.length, failed, firstError };
}

// ===== LineLeader pipeline snapshot =====

const upsertLlCentre = db.prepare(`
  INSERT INTO ll_centres (ll_id, name, active) VALUES (@ll_id, @name, @active)
  ON CONFLICT(ll_id) DO UPDATE SET name=@name, active=@active
`);
const upsertLlPipeline = db.prepare(`
  INSERT INTO ll_pipeline (snapshot_date, ll_id, centre_name, status_id, status_name, count)
  VALUES (@snapshot_date, @ll_id, @centre_name, @status_id, @status_name, @count)
  ON CONFLICT(snapshot_date, ll_id, status_id) DO UPDATE SET
    centre_name=@centre_name, status_name=@status_name, count=@count
`);
const upsertLlEnrol = db.prepare(`
  INSERT INTO ll_enrolments (enrollment_id, ll_id, centre_name, child_id, status_id, start_date, withdrawn_date, updated_at)
  VALUES (@enrollment_id, @ll_id, @centre_name, @child_id, @status_id, @start_date, @withdrawn_date, datetime('now'))
  ON CONFLICT(enrollment_id) DO UPDATE SET
    ll_id=@ll_id, centre_name=@centre_name, child_id=@child_id, status_id=@status_id,
    start_date=COALESCE(@start_date, start_date),
    withdrawn_date=COALESCE(@withdrawn_date, withdrawn_date),
    updated_at=datetime('now')
`);

const nameOf = (r, k) => (r[k] && r[k].values && r[k].values.name) || null;

const DAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_ABBR = { monday: "mo", tuesday: "tu", wednesday: "we", thursday: "th", friday: "fr", saturday: "sa", sunday: "su" };
function scheduleDays(sched) {
  if (!sched) return "";
  return DAY_KEYS.filter((d) => sched[d] && (sched[d].am || sched[d].pm)).map((d) => DAY_ABBR[d]).join(",");
}
// Pipeline statuses that could still convert to an enrolment (exclude Enrolled/Alumni/Withdrawn/Lost/Rejected).
const PIPELINE_STATUSES = new Set([1, 2, 11, 3, 4, 12, 5]);

const upsertPipelineStart = db.prepare(`
  INSERT INTO ll_pipeline_starts (enrollment_id, ll_id, owna_id, centre_name, child_name, status_id, expected_start, days_csv, updated_at)
  VALUES (@enrollment_id, @ll_id, @owna_id, @centre_name, @child_name, @status_id, @expected_start, @days_csv, datetime('now'))
  ON CONFLICT(enrollment_id) DO UPDATE SET
    ll_id=@ll_id, owna_id=@owna_id, centre_name=@centre_name, child_name=@child_name,
    status_id=@status_id, expected_start=@expected_start, days_csv=@days_csv, updated_at=datetime('now')
`);

const linkCentreLl = db.prepare(`UPDATE centres SET ll_id = ? WHERE owna_id = ?`);

async function runLineLeaderSnapshot({ windowDays = WINDOW_DAYS, forwardDays = FORWARD_DAYS, log = console.log } = {}) {
  if (!lineleader.hasCreds()) { log("[LineLeader] no credentials — skipping"); return { skipped: true, reason: "no LineLeader credentials configured" }; }
  const failures = []; // best-effort parts that failed; reported to the run as a problem
  const today = new Date().toISOString().slice(0, 10);
  // LineLeader rejects millisecond precision — use whole-second ISO (…Z).
  const isoSec = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const fromISO = isoSec(new Date(Date.now() - windowDays * 864e5));
  const toISO = isoSec(new Date());
  const fwdISO = isoSec(new Date(Date.now() + forwardDays * 864e5)); // future expected starts

  const centres = (await lineleader.centres()).filter((c) => {
    const nm = c.values ? c.values.name : c.name;
    return nm && !LL_EXCLUDE.has(nm);
  });
  const statuses = await lineleader.statuses();
  log(`[LineLeader] ${centres.length} centres, ${statuses.length} pipeline stages`);

  // Link OWNA centres to their LineLeader counterpart (by name, Heath Rd -> Leppington Heath).
  let linked = 0;
  for (const oc of db.prepare(`SELECT owna_id, name FROM centres`).all()) {
    const m = matchLlCentre(oc.name, centres);
    if (m) { linkCentreLl.run(m.id, oc.owna_id); linked += 1; }
  }
  log(`[LineLeader] linked ${linked} OWNA centres to LineLeader`);

  // Pipeline: family count per centre per status (X-Total-Count, cheap).
  let cells = 0;
  for (const c of centres) {
    const nm = c.values ? c.values.name : c.name;
    upsertLlCentre.run({ ll_id: c.id, name: nm, active: c.active === false ? 0 : 1 });
    for (const s of statuses) {
      const snm = s.values ? s.values.name : s.name;
      const n = await lineleader.familyCount(s.id, c.id);
      upsertLlPipeline.run({ snapshot_date: today, ll_id: c.id, centre_name: nm, status_id: s.id, status_name: snm, count: n });
      cells += 1;
    }
  }

  // Enrolments: expected starts across past window AND future (forecast), plus withdrawals in window.
  const started = await lineleader.enrolmentsStarted(fromISO, fwdISO);
  const withdrawn = await lineleader.enrolmentsWithdrawn(fromISO, toISO);
  const writeEnrol = db.transaction((rows, dateKey) => {
    for (const r of rows) {
      const wd = r.withdrawn;
      upsertLlEnrol.run({
        enrollment_id: r.id,
        ll_id: r.center && r.center.id,
        centre_name: nameOf(r, "center"),
        child_id: r.child && r.child.id,
        status_id: (r.child && r.child.values && r.child.values.status) || null,
        start_date: dateKey === "start" ? (r.expected_start_date || null) : null,
        withdrawn_date: dateKey === "withdrawn" ? (typeof wd === "string" ? wd.slice(0, 10) : (wd && wd.date ? String(wd.date).slice(0, 10) : null)) : null,
      });
    }
  });
  writeEnrol(started, "start");
  writeEnrol(withdrawn, "withdrawn");

  // Pipeline starts (with weekly schedule) for the enrolment projection — rebuild each run.
  // Make sure pre-opening LineLeader-only centres (ll-<id> rows) exist BEFORE we map pipeline rows to
  // centres — otherwise Cobbitty/Oran Park rows are written with owna_id NULL and vanish from every
  // per-centre view until the next successful run.
  try { ensureOpeningCentres({ log }); } catch (e) { failures.push("opening-centres failed: " + errSummary(e)); log(`[LineLeader] opening-centres failed: ${errSummary(e)}`); }
  const llToOwna = new Map(db.prepare(`SELECT ll_id, owna_id FROM centres WHERE ll_id IS NOT NULL`).all().map((r) => [r.ll_id, r.owna_id]));
  const today2 = new Date().toISOString().slice(0, 10);
  const writePs = db.transaction((rows) => {
    db.prepare(`DELETE FROM ll_pipeline_starts`).run();
    let n = 0;
    for (const r of rows) {
      const status = r.child && r.child.values && r.child.values.status;
      const start = r.expected_start_date ? String(r.expected_start_date).slice(0, 10) : null;
      if (!start || start < today2) continue;          // future starts only
      if (!PIPELINE_STATUSES.has(status)) continue;    // still-convertible pipeline only
      const llId = r.center && r.center.id;
      upsertPipelineStart.run({
        enrollment_id: r.id, ll_id: llId, owna_id: llToOwna.get(llId) || null,
        centre_name: nameOf(r, "center"), child_name: r.child && r.child.values && r.child.values.name,
        status_id: status, expected_start: start, days_csv: scheduleDays(r.schedule),
      });
      n += 1;
    }
    return n;
  });
  const psN = writePs(started);

  // Pipeline MEMBERS (per child) for the centre drill-down + waitlist trend.
  const statusName = new Map(statuses.map((s) => [s.id, s.values ? s.values.name : s.name]));
  const PIPELINE_MEMBER_STATUSES = [1, 2, 11, 3, 4, 12, 5];
  const llLocalDate = (s) => (s ? String(s).slice(0, 10) : null);
  try {
    const members = await lineleader.enrolmentsByStatus(PIPELINE_MEMBER_STATUSES);
    const byChild = new Map();
    for (const r of members) {
      const cid = r.child && r.child.id;
      if (!cid) continue;
      // keep the most recently added enrolment per child
      const prev = byChild.get(cid);
      if (!prev || (r.id || 0) > (prev.id || 0)) byChild.set(cid, r);
    }
    const writeMembers = db.transaction((list) => {
      db.prepare(`DELETE FROM ll_pipeline_members`).run();
      for (const r of list) {
        const llId = r.center && r.center.id;
        const st = r.child && r.child.values && r.child.values.status;
        db.prepare(`
          INSERT INTO ll_pipeline_members (child_id, ll_id, owna_id, centre_name, child_name, family_name, status_id, status_name, wait_list_date, expected_start, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
          ON CONFLICT(child_id) DO UPDATE SET ll_id=excluded.ll_id, owna_id=excluded.owna_id, centre_name=excluded.centre_name,
            child_name=excluded.child_name, family_name=excluded.family_name, status_id=excluded.status_id, status_name=excluded.status_name,
            wait_list_date=excluded.wait_list_date, expected_start=excluded.expected_start, updated_at=datetime('now')
        `).run(
          r.child.id, llId, llToOwna.get(llId) || null, nameOf(r, "center"),
          r.child.values && r.child.values.name, r.family && r.family.values && r.family.values.name,
          st, statusName.get(st) || null,
          llLocalDate(r.wait_list_date), r.expected_start_date ? String(r.expected_start_date).slice(0, 10) : null
        );
      }
      return list.length;
    });
    const mN = writeMembers([...byChild.values()]);
    log(`[LineLeader] pipeline members=${mN}`);
  } catch (e) { failures.push("members pull failed: " + errSummary(e)); log(`[LineLeader] members pull failed: ${errSummary(e)}`); }

  // Scheduled TOURS (and orientation days) for the drill-down.
  try {
    const tourTypes = [[89, "Tour"], [758, "Orientation Day"]];
    const allTours = [];
    for (const [tid] of tourTypes) allTours.push(...(await lineleader.tasksOfType(tid)));
    const writeTours = db.transaction((list) => {
      db.prepare(`DELETE FROM ll_tours`).run();
      for (const t of list) {
        const llId = t.center && t.center.id;
        db.prepare(`
          INSERT INTO ll_tours (task_id, ll_id, owna_id, centre_name, family_name, type_name, tour_date, is_completed, is_cancelled, result, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
          ON CONFLICT(task_id) DO UPDATE SET ll_id=excluded.ll_id, owna_id=excluded.owna_id, centre_name=excluded.centre_name,
            family_name=excluded.family_name, type_name=excluded.type_name, tour_date=excluded.tour_date,
            is_completed=excluded.is_completed, is_cancelled=excluded.is_cancelled, result=excluded.result, updated_at=datetime('now')
        `).run(
          t.id, llId, llToOwna.get(llId) || null, nameOf(t, "center"),
          t.family && t.family.values && t.family.values.name,
          t.type && t.type.values && t.type.values.value,
          t.due_date_time || null, t.is_completed ? 1 : 0, t.is_cancelled ? 1 : 0,
          t.result && t.result.values && (t.result.values.value || t.result.values.name) || null
        );
      }
      return list.length;
    });
    const tN = writeTours(allTours);
    log(`[LineLeader] tours=${tN}`);
  } catch (e) { failures.push("tours pull failed: " + errSummary(e)); log(`[LineLeader] tours pull failed: ${errSummary(e)}`); }

  log(`[LineLeader] pipeline cells=${cells}, started=${started.length}, withdrawn=${withdrawn.length}, projection starts=${psN}`);
  return { ok: true, centres: centres.length, cells, started: started.length, withdrawn: withdrawn.length, failures };
}

// Create/refresh "pre-opening" centre records for LineLeader centres that have a real pipeline
// but aren't yet linked to an operating OWNA centre (e.g. Oran Park, Cobbitty). Data-driven so it
// works on a fresh deploy: they appear in the sidebar and get a pipeline-focused centre page.
// Every active LineLeader centre not linked to OWNA becomes a pre-opening centre row. The old
// threshold of 10 pipeline families hid Park Rd (opening 2028) while it had one family.
function ensureOpeningCentres({ minPipeline = 1, log = console.log } = {}) {
  const date = (db.prepare("SELECT MAX(snapshot_date) d FROM ll_pipeline").get() || {}).d;
  if (!date) return { ok: true, n: 0 };
  const linked = new Set(db.prepare("SELECT ll_id FROM centres WHERE ll_id IS NOT NULL AND (opening IS NULL OR opening = 0)").all().map((r) => r.ll_id));
  const cands = db.prepare(`
    SELECT c.ll_id, c.name, COALESCE(SUM(p.count),0) total
    FROM ll_centres c LEFT JOIN ll_pipeline p ON p.ll_id = c.ll_id AND p.snapshot_date = ?
    WHERE c.active = 1 GROUP BY c.ll_id, c.name`).all(date);
  const upsert = db.prepare(`
    INSERT INTO centres (owna_id, name, capacity, enrolled, ll_id, opening, last_updated)
    VALUES (@owna_id, @name, 0, 0, @ll_id, 1, datetime('now'))
    ON CONFLICT(owna_id) DO UPDATE SET name=@name, ll_id=@ll_id, opening=1, last_updated=datetime('now')`);
  let n = 0;
  for (const c of cands) {
    if (linked.has(c.ll_id) || c.total < minPipeline) continue;
    upsert.run({ owna_id: "ll-" + c.ll_id, name: c.name, ll_id: c.ll_id });
    n += 1;
  }
  if (n) log(`[opening] ${n} pre-opening centres ensured`);
  return { ok: true, n };
}

module.exports = { runSnapshot, runLineLeaderSnapshot, runExitReport, runOwnaBackfill, runIncidents, runRoster, ensureOpeningCentres, lastRun, errSummary, recordSync, sourceSync, sourceSyncFor };
