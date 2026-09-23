#!/usr/bin/env node
/*
 * OWNA staff sign-in/out report, broken down BY ROOM within a centre. READ-ONLY.
 *
 * How OWNA records it (verified 2026-09-22 at Austral):
 *   "centre checkin"  — arrives on site. roomId empty, roomName = the centre.
 *   "signin"          — moves INTO a room. roomName is the room (roomId is sometimes blank for
 *                       pseudo-rooms like Break/Admin, so roomName is the authority).
 *   "centre checkout" — leaves site.
 * A room stay therefore runs from one signin to the next signin in a DIFFERENT room, or to
 * centre checkout. Repeated taps into the same room are merged.
 *
 * Usage: node scripts/owna-room-report.js <centreId|alias> [days] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *   e.g. node scripts/owna-room-report.js austral 60
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");
const m = require(path.join(__dirname, "..", "services", "metrics"));
const { resolveRoles } = require(path.join(__dirname, "..", "services", "staff-roles"));

const OBASE = (process.env.OWNA_BASE_URL || "https://api.owna.com.au").replace(/\/$/, "");
const OKEY = process.env.OWNA_API_KEY || "";
const TZ = "Australia/Sydney";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fT = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const fD = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const lt = (iso) => fT.format(new Date(iso));
const ld = (iso) => fD.format(new Date(iso));

// "Floor" = rostered on the floor with children. A room counts as floor ONLY if it is an actual
// child room (Room One..Six, Cot Room, etc.). Everything else — breaks, admin, programming,
// kitchen/cleaning duties, study, off-site — is non-contact. Verified against Austral's room names
// 2026-09-22; note OWNA has several "... - Out of Service" / "Away from Service" pseudo-rooms.
const FLOOR = /^(room\b|cot\b|nursery\b|toddler|preschool|junior|senior)/i;
const STUDY = /^study\b/i;
// Child-contact spaces that are not named "Room N". Confirmed with Christo 2026-09-22: the Atelier
// is a children's studio, and on an Excursion staff are supervising children off-site. "School
// Leavers" is included for consistency with "Room 7- SCHOOL LEAVERS", which already counted as floor.
const EXTRA_FLOOR = /^(atelier|excursion|school\s*leavers)\b/i;
// Three-way split, requested 2026-09-22: study is paid time that is neither on the floor nor an
// ordinary break, so it is reported on its own rather than lumped into non-contact.
function roomType(room) {
  const r = String(room).trim();
  if (STUDY.test(r)) return "study";
  if (EXTRA_FLOOR.test(r)) return "floor";
  if (FLOOR.test(r) && !/out of service|away from/i.test(r)) return "floor";
  return "non-contact";
}

async function oget(p, attempt = 0) {
  const MAX = 4;
  let r, t;
  try {
    r = await fetch(OBASE + p, { signal: AbortSignal.timeout(45000), headers: { "x-api-key": OKEY, Accept: "application/json" } });
    t = await r.text();
  } catch (err) {
    if (attempt < MAX) { await sleep(500 * 2 ** attempt); return oget(p, attempt + 1); }
    throw new Error(`OWNA ${p}: ${err.message}`);
  }
  let b; try { b = JSON.parse(t); } catch { b = t; }
  if (!r.ok) {
    if ((r.status === 429 || r.status >= 500) && attempt < MAX) { await sleep(500 * 2 ** attempt); return oget(p, attempt + 1); }
    throw new Error(`OWNA ${r.status} ${p}`);
  }
  if (typeof b !== "object" || b === null) throw new Error(`OWNA ${p}: non-JSON response (content filter?)`);
  return Array.isArray(b) ? b : (b.data || []);
}

// Walk every page of the OWNA staff list (it defaults to ~10 rows).
async function staffAll(centreId) {
  const out = [];
  for (let skip = 0; ;) {
    const page = await oget(`/api/staff/${centreId}/list?take=500&skip=${skip}`);
    const rows = Array.isArray(page) ? page : [];
    out.push(...rows); skip += rows.length;
    if (!rows.length || rows.length < 500) break;
    if (skip > 50000) break;
  }
  return out;
}

const ALIAS = { austral: /austral/i, bardia: /bardia/i, gwh: /gledswood/i, gledswood: /gledswood/i, heath: /heath/i, lhr: /heath/i };
const shortName = (n) => (n || "").replace(/Futuro Childcare (and|&) Education\s*-?\s*/i, "").replace(/^Futuro\s+/, "").trim();
const csvCell = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;

// Turn one staff member's ordered events for a day into room stays.
function roomStays(events) {
  const evs = events.slice().sort((a, b) => new Date(a.statusDate) - new Date(b.statusDate));
  const stays = [];
  let cur = null;      // { room, start }
  let onSite = false;
  const close = (at, why) => {
    if (cur) {
      const mins = Math.round((new Date(at) - new Date(cur.start)) / 60000);
      if (mins > 0) stays.push({ room: cur.room, start: cur.start, end: at, mins, closedBy: why });
      cur = null;
    }
  };
  for (const e of evs) {
    const st = String(e.status || "");
    if (/centre\s*checkin/i.test(st)) { onSite = true; close(e.statusDate, "checkin"); continue; }
    if (/centre\s*checkout/i.test(st)) { close(e.statusDate, "checkout"); onSite = false; continue; }
    if (/^signin$/i.test(st)) {
      const room = (e.roomName || "").trim();
      // A signin whose roomName is just the centre carries no room information.
      if (!room || /childcare|education/i.test(room)) continue;
      if (cur && cur.room === room) continue;           // repeated tap into the same room
      close(e.statusDate, "moved");
      cur = { room, start: e.statusDate };
    }
  }
  if (cur) stays.push({ room: cur.room, start: cur.start, end: null, mins: null, closedBy: "never closed" });
  return { stays, onSiteSeen: onSite };
}

(async () => {
  const args = process.argv.slice(2);
  const centreArg = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) || "austral";
  const daysArg = Number(args.find((a) => /^\d+$/.test(a)) || 60);
  const fromFlag = (args[args.indexOf("--from") + 1] || "").match(/^\d{4}-\d{2}-\d{2}$/) ? args[args.indexOf("--from") + 1] : null;
  const toFlag = (args[args.indexOf("--to") + 1] || "").match(/^\d{4}-\d{2}-\d{2}$/) ? args[args.indexOf("--to") + 1] : null;
  const exFlag = args.indexOf("--exclude");
  const exclude = new Set(exFlag >= 0 ? String(args[exFlag + 1] || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) : []);

  const centres = m.centres();
  const al = ALIAS[centreArg.toLowerCase()];
  const centre = al ? centres.find((c) => al.test(c.name)) : centres.find((c) => c.owna_id === centreArg);
  if (!centre) { console.error(`No centre matched "${centreArg}".`); process.exit(1); }

  const to = toFlag || fD.format(new Date());
  let from = fromFlag;
  if (!from) { const d = new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - (daysArg - 1)); from = d.toISOString().slice(0, 10); }

  const dates = [];
  for (const d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));

  console.log("══════════════════════════════════════════════════════════════════════════");
  console.log(`  ${shortName(centre.name)} — staff sign-in/out by room`);
  console.log(`  ${from} → ${to}  (${dates.length} days)  ·  times in ${TZ}`);
  console.log("══════════════════════════════════════════════════════════════════════════\n");

  // ---- Roles (from EH jobTitle, joined to OWNA staff) ----
  const staff = await staffAll(centre.owna_id);
  const { byStaffId, stats: roleStats } = await resolveRoles(staff);
  const roleOf = (sid) => byStaffId.get(String(sid)) || { name: null, group: "unknown", label: "(not in OWNA staff list)", jobTitle: null, employeeCode: null, matchedBy: "no OWNA staff record" };
  const groupTally = {};
  byStaffId.forEach((v) => { groupTally[v.group] = (groupTally[v.group] || 0) + 1; });
  console.log(`Roles resolved for ${roleStats.total} OWNA staff (${roleStats.ehLoaded} EH employees loaded):`);
  console.log(`  matched by employeeCode ${roleStats.viaCode} · by name ${roleStats.viaName} · ambiguous name ${roleStats.ambiguous} · no EH match ${roleStats.unmatched}`);
  console.log("  groups: " + Object.entries(groupTally).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join(" · "));
  if (exclude.size) console.log(`  EXCLUDING: ${[...exclude].join(", ")}`);
  console.log("");

  const allStays = [], attendance = [], noRoomDays = [];
  const excludedPeople = new Map();
  let events = 0, daysWithData = 0, excludedStays = 0;

  for (const date of dates) {
    const log = await oget(`/api/staff/log/${centre.owna_id}/${date}`);
    if (!log.length) continue;
    daysWithData++; events += log.length;
    const byStaff = {};
    log.forEach((r) => { (byStaff[String(r.staffId)] ||= []).push(r); });

    for (const sid of Object.keys(byStaff)) {
      const evs = byStaff[sid];
      const role = roleOf(sid);
      const name = role.name || evs[0].staffName || "(unknown)";
      if (exclude.has(role.group)) {
        excludedStays++;
        if (!excludedPeople.has(name)) excludedPeople.set(name, { group: role.group, label: role.label, jobTitle: role.jobTitle, days: 0 });
        excludedPeople.get(name).days++;
        continue;
      }
      const { stays } = roomStays(evs);
      const ins = evs.filter((e) => /centre\s*checkin/i.test(e.status)).map((e) => e.statusDate).sort();
      const outs = evs.filter((e) => /centre\s*checkout/i.test(e.status)).map((e) => e.statusDate).sort();
      const onSiteMins = (ins.length && outs.length)
        ? Math.max(0, Math.round((new Date(outs[outs.length - 1]) - new Date(ins[0])) / 60000)) : null;
      attendance.push({ date, name, sid, role: role.group, roleLabel: role.label, jobTitle: role.jobTitle, employeeCode: role.employeeCode, matchedBy: role.matchedBy, firstIn: ins[0] || null, lastOut: outs[outs.length - 1] || null, onSiteMins, roomStays: stays.filter((s) => s.mins).length });
      if (ins.length && !stays.some((s) => s.mins)) noRoomDays.push({ date, name });
      stays.forEach((st) => allStays.push({ date, name, sid, role: role.group, roleLabel: role.label, jobTitle: role.jobTitle, ...st }));
    }
  }

  // ---- Summary by room ----
  const byRoom = {};
  allStays.filter((s) => s.mins).forEach((s) => {
    byRoom[s.room] ||= { mins: 0, visits: 0, staff: new Set(), days: new Set() };
    byRoom[s.room].mins += s.mins; byRoom[s.room].visits++;
    byRoom[s.room].staff.add(s.sid); byRoom[s.room].days.add(s.date);
  });
  const totalMins = Object.values(byRoom).reduce((a, r) => a + r.mins, 0) || 1;
  const rows = Object.entries(byRoom).sort((a, b) => b[1].mins - a[1].mins);

  console.log(`Days with clock activity: ${daysWithData}/${dates.length}   ·   ${events} raw events   ·   ${allStays.filter(s=>s.mins).length} room stays\n`);
  console.log("  Room                       Hours    Share   Visits  Staff  Days  Avg stay  Type");
  console.log("  " + "─".repeat(84));
  for (const [room, r] of rows) {
    const h = r.mins / 60;
    console.log("  " + room.padEnd(26) +
      h.toFixed(1).padStart(7) + "  " + (100 * r.mins / totalMins).toFixed(1).padStart(5) + "%" +
      String(r.visits).padStart(8) + String(r.staff.size).padStart(7) + String(r.days.size).padStart(6) +
      (r.mins / r.visits).toFixed(0).padStart(8) + "m  " + roomType(room));
  }
  const sub = { floor: 0, study: 0, "non-contact": 0 };
  rows.forEach(([rm, r]) => { sub[roomType(rm)] += r.mins; });
  console.log("  " + "─".repeat(84));
  console.log("  " + "TOTAL".padEnd(26) + (totalMins / 60).toFixed(1).padStart(7));
  console.log("\n  Split by category:");
  [["floor", "Floor (child-contact)"], ["study", "Study"], ["non-contact", "Non-contact (breaks, admin, programming, duties)"]]
    .forEach(([k, label]) => console.log("    " + label.padEnd(50) + (sub[k] / 60).toFixed(1).padStart(9) + "h" +
      ("  " + (100 * sub[k] / totalMins).toFixed(1) + "%").padStart(9)));

  // Cross-check: time attributed to rooms must not exceed time actually on site.
  const onSiteTotal = attendance.reduce((a, r) => a + (r.onSiteMins || 0), 0);
  console.log(`\n  Cross-check vs centre check-in/out: ${(totalMins / 60).toFixed(1)}h in rooms against ` +
    `${(onSiteTotal / 60).toFixed(1)}h on site = ${(100 * totalMins / (onSiteTotal || 1)).toFixed(1)}% accounted for.`);

  if (exclude.size) {
    console.log(`\nExcluded ${excludedPeople.size} people (${excludedStays} staff-days) by role:`);
    [...excludedPeople.entries()].sort((a, b) => b[1].days - a[1].days).forEach(([n, v]) =>
      console.log(`  ${n.padEnd(26)} ${String(v.jobTitle || v.label).padEnd(34)} ${v.days} day(s)`));
  }

  const unclosed = allStays.filter((s) => !s.mins).length;
  console.log(`\nData quality:`);
  console.log(`  ${unclosed} room stay(s) never closed (no later signin or checkout) — excluded from totals.`);
  console.log(`  ${noRoomDays.length} staff-day(s) had a centre check-in but NO room sign-in at all.`);
  if (noRoomDays.length) {
    const tally = {}; noRoomDays.forEach((x) => tally[x.name] = (tally[x.name] || 0) + 1);
    const worst = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log("    most often: " + worst.map(([n, c]) => `${n} (${c})`).join(", "));
  }

  // ---- CSV outputs ----
  const out = path.join(os.homedir(), "Desktop");
  const slug = shortName(centre.name).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const f1 = path.join(out, `${slug}-room-stays-${from}_to_${to}.csv`);
  fs.writeFileSync(f1, ["date,staff,staff_id,role_group,job_title,room,room_type,start_time,end_time,minutes,hours,closed_by"]
    .concat(allStays.map((s) => [s.date, s.name, s.sid, s.role, s.jobTitle || "", s.room, roomType(s.room),
      lt(s.start), s.end ? lt(s.end) : "", s.mins ?? "", s.mins ? (s.mins / 60).toFixed(2) : "", s.closedBy].map(csvCell).join(","))).join("\n"));

  const f2 = path.join(out, `${slug}-room-hours-by-day-${from}_to_${to}.csv`);
  const roomNames = rows.map(([r]) => r);
  const pivot = {};
  allStays.filter((s) => s.mins).forEach((s) => { pivot[s.date] ||= {}; pivot[s.date][s.room] = (pivot[s.date][s.room] || 0) + s.mins; });
  fs.writeFileSync(f2, ["date," + roomNames.map(csvCell).join(",") + ",total"]
    .concat(Object.keys(pivot).sort().map((d) => [d].concat(roomNames.map((r) => ((pivot[d][r] || 0) / 60).toFixed(2)))
      .concat([(Object.values(pivot[d]).reduce((a, b) => a + b, 0) / 60).toFixed(2)]).join(","))).join("\n"));

  const f3 = path.join(out, `${slug}-attendance-${from}_to_${to}.csv`);
  fs.writeFileSync(f3, ["date,staff,staff_id,role_group,job_title,employee_code,role_matched_by,first_check_in,last_check_out,on_site_hours,room_stays"]
    .concat(attendance.sort((a, b) => (a.date + a.name).localeCompare(b.date + b.name)).map((a) => [a.date, a.name, a.sid,
      a.role, a.jobTitle || "", a.employeeCode || "", a.matchedBy, a.firstIn ? lt(a.firstIn) : "", a.lastOut ? lt(a.lastOut) : "",
      a.onSiteMins != null ? (a.onSiteMins / 60).toFixed(2) : "", a.roomStays].map(csvCell).join(","))).join("\n"));

  // Per-person summary — the "by people names" view.
  const perPerson = {};
  allStays.filter((s) => s.mins).forEach((s) => {
    const k = s.name;
    perPerson[k] ||= { name: k, role: s.role, jobTitle: s.jobTitle, mins: 0, floor: 0, study: 0, nc: 0, days: new Set(), rooms: {} };
    const p = perPerson[k], t = roomType(s.room);
    p.mins += s.mins; p.days.add(s.date);
    if (t === "floor") p.floor += s.mins; else if (t === "study") p.study += s.mins; else p.nc += s.mins;
    p.rooms[s.room] = (p.rooms[s.room] || 0) + s.mins;
  });
  const onSiteByName = {};
  attendance.forEach((a) => { if (a.onSiteMins) onSiteByName[a.name] = (onSiteByName[a.name] || 0) + a.onSiteMins; });
  const f4 = path.join(out, `${slug}-by-person-${from}_to_${to}.csv`);
  fs.writeFileSync(f4, ["staff,role_group,job_title,days_worked,on_site_hours,room_hours,floor_hours,study_hours,non_contact_hours,floor_pct_of_room_time,top_room"]
    .concat(Object.values(perPerson).sort((a, b) => b.mins - a.mins).map((p) => {
      const top = Object.entries(p.rooms).sort((a, b) => b[1] - a[1])[0];
      return [p.name, p.role, p.jobTitle || "", p.days.size, ((onSiteByName[p.name] || 0) / 60).toFixed(1),
        (p.mins / 60).toFixed(1), (p.floor / 60).toFixed(1), (p.study / 60).toFixed(1), (p.nc / 60).toFixed(1),
        (100 * p.floor / p.mins).toFixed(1), top ? `${top[0]} (${(top[1] / 60).toFixed(0)}h)` : ""].map(csvCell).join(",");
    })).join("\n"));

  console.log(`\n  ${Object.keys(perPerson).length} people included. Top 12 by room time:`);
  console.log("    Staff                     Role          Job title                       Days   Room h  Floor%");
  Object.values(perPerson).sort((a, b) => b.mins - a.mins).slice(0, 12).forEach((p) =>
    console.log("    " + p.name.padEnd(26) + String(p.role).padEnd(14) + String(p.jobTitle || "-").slice(0, 31).padEnd(32) +
      String(p.days.size).padStart(4) + (p.mins / 60).toFixed(0).padStart(9) + (100 * p.floor / p.mins).toFixed(1).padStart(7) + "%"));

  console.log(`\nCSVs written to your Desktop:`);
  [f1, f2, f3, f4].forEach((f) => console.log("  " + path.basename(f)));
  console.log("\n*** READ-ONLY — nothing was written to OWNA or Employment Hero. ***");
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
