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
        log(`[snapshot] CCS pull failed for ${c.name}: ${e.message}`);
      }

      log(`[snapshot] ${c.name}: ${att.length} bookings, ${byDay.size} days, capacity ${capacity}`);
    }

    // LineLeader pipeline (best-effort — never fail the OWNA snapshot over it).
    try {
      await runLineLeaderSnapshot({ windowDays, forwardDays, log });
    } catch (e) {
      log(`[snapshot] LineLeader pull failed: ${e.message}`);
    }

    // Employment Hero labour (best-effort).
    try { await runLabourSnapshot({ log }); } catch (e) { log(`[snapshot] EH labour failed: ${e.message}`); }

    // Exit report (OWNA departures + LineLeader reasons) — best-effort.
    try {
      await runExitReport({ log });
    } catch (e) {
      log(`[snapshot] exit report failed: ${e.message}`);
    }

    // Child incidents (safety) — best-effort.
    try { await runIncidents({ windowDays, log }); } catch (e) { log(`[snapshot] incidents failed: ${e.message}`); }

    db.prepare(
      `UPDATE snapshot_runs SET finished_at=datetime('now'), status='ok', rows_written=? WHERE id=?`
    ).run(rowsWritten, runId);
    log(`[snapshot] done — ${rowsWritten} day-rows written`);
    return { ok: true, rowsWritten, from, to };
  } catch (e) {
    db.prepare(
      `UPDATE snapshot_runs SET finished_at=datetime('now'), status='error', note=? WHERE id=?`
    ).run(String(e.message || e), runId);
    log(`[snapshot] ERROR: ${e.message}`);
    throw e;
  }
}


// ===== Child incidents -> per-centre per-month safety counts =====
async function runIncidents({ windowDays = WINDOW_DAYS, log = console.log } = {}) {
  const from = daysAgo(windowDays), to = today();
  const centres = await owna.listCentres();
  const upsert = db.prepare(`INSERT INTO incidents_monthly (owna_id, month, total, injuries, reportable, updated_at)
    VALUES (@owna_id,@month,@total,@injuries,@reportable,datetime('now'))
    ON CONFLICT(owna_id, month) DO UPDATE SET total=@total, injuries=@injuries, reportable=@reportable, updated_at=datetime('now')`);
  const injTxt = (v) => { const t = String(v || "").trim().toLowerCase(); return t && t !== "n/a" && t !== "na" && t !== "none"; };
  let rows = 0;
  for (const c of centres) {
    let inc;
    try { inc = await owna.childIncidents(c.id, from, to); } catch (e) { log(`[incidents] ${c.name}: ${e.message}`); continue; }
    const byMonth = new Map();
    for (const r of inc) {
      const month = (r.incidentDate || "").slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      let m = byMonth.get(month); if (!m) { m = { total: 0, injuries: 0, reportable: 0 }; byMonth.set(month, m); }
      m.total += 1;
      if (injTxt(r.injurytrauma)) m.injuries += 1;
      const reportable = injTxt(r.regulatoryAuthority) || r.regulatoryAuthorityDatetime || r.emergencyServices || r.medicalAttention;
      if (reportable) m.reportable += 1;
    }
    const write = db.transaction((entries) => { for (const [month, m] of entries) { upsert.run({ owna_id: c.id, month, ...m }); rows += 1; } });
    write([...byMonth.entries()]);
  }
  log(`[incidents] ${rows} centre-months written`);
  return { ok: true, rows };
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
      } catch (e) { log(`[backfill] ${c.name} ${from}: ${e.message}`); }
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
      log(`[exits] LineLeader reason map failed: ${e.message}`);
    }
  }

  // 2) OWNA children with a finishDate → the authoritative exit list.
  let total = 0, matched = 0;
  const centres = db.prepare(`SELECT owna_id, name FROM centres`).all();
  for (const c of centres) {
    let kids;
    try { kids = await owna.listChildren(c.owna_id); } catch (e) { log(`[exits] ${c.name}: children pull failed: ${e.message}`); continue; }
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
  return { ok: true, total, matched };
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
  if (!lineleader.hasCreds()) { log("[LineLeader] no credentials — skipping"); return { skipped: true }; }
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
  } catch (e) { log(`[LineLeader] members pull failed: ${e.message}`); }

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
  } catch (e) { log(`[LineLeader] tours pull failed: ${e.message}`); }

  log(`[LineLeader] pipeline cells=${cells}, started=${started.length}, withdrawn=${withdrawn.length}, projection starts=${psN}`);
  return { ok: true, centres: centres.length, cells, started: started.length, withdrawn: withdrawn.length };
}

module.exports = { runSnapshot, runLineLeaderSnapshot, runExitReport, runOwnaBackfill, runIncidents, lastRun };
