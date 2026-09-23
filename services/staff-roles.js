// Resolve a role group for each OWNA staff member, so reports can include or exclude
// centre managers, kitchen staff and so on.
//
// Role data lives in EMPLOYMENT HERO (`employee.jobTitle`) — OWNA has no job title, only a coarse
// `staffType` (which does at least flag `kitchenstaff`). So we join OWNA → EH:
//   1. by employeeCode → externalId  (exact, the same key the timesheet sync posts on)
//   2. failing that, by normalised name
// Name matching is fine for grouping a REPORT. It must never be used to post payroll.
require("dotenv").config();
const path = require("path");
const { eh } = require(path.join(__dirname, "eh"));

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const firstLast = (first, last) => { const f = norm(first).split(" ")[0] || ""; const l = norm(last).split(" ").pop() || ""; return (f + " " + l).trim(); };

// Order matters: the most specific pattern must win (Assistant Centre Manager before Centre Manager).
const RULES = [
  { group: "acm",        label: "Assistant Centre Manager", re: /assistant\s+cent(er|re)\s+manager|^acm\b/i },
  { group: "cm",         label: "Centre Manager",           re: /cent(er|re)\s+manager/i },
  { group: "kitchen",    label: "Kitchen",                  re: /\bchef\b|kitchen\s*hand|\bcook\b|assistant to exec/i },
  { group: "cleaner",    label: "Cleaner",                  re: /\bcleaner\b|cleaning/i },
  { group: "maintenance",label: "Maintenance",              re: /maintenance|general hand/i },
  { group: "headoffice", label: "Head office / support",    re: /\b(coo|cfo|ceo)\b|operations manager|people\s*(&|and)\s*culture|administration manager|quality and curriculum|project manager|recruitment|enrolment officer|payroll|finance/i },
  { group: "educator",   label: "Educator / teacher",       re: /educator|teacher|room leader|educational leader|\bcse\b|support worker|trainee|\bece?t\b/i },
];

function groupFor(jobTitle, ownaStaffType) {
  // EH jobTitle WINS. OWNA's staffType is a permissions flag, not a role: several educators are
  // tagged `kitchenstaff` there (e.g. an Early Childhood Educator at Bardia, a Support Worker at
  // Heath Rd), and trusting it first wrongly excluded them from educator reporting.
  const t = String(jobTitle || "").trim();
  if (t) { for (const r of RULES) if (r.re.test(t)) return { group: r.group, label: r.label, via: "eh jobTitle" }; }
  const st = String(ownaStaffType || "").toLowerCase();
  if (st === "kitchenstaff") return { group: "kitchen", label: "Kitchen", via: "owna staffType" };
  if (st === "maintenance") return { group: "maintenance", label: "Maintenance", via: "owna staffType" };
  if (st === "agency") return { group: "educator", label: "Educator / teacher (agency)", via: "owna staffType" };
  if (t) return { group: "other", label: t, via: "eh jobTitle (unmatched)" };
  return { group: "unknown", label: "(no role found)", via: "none" };
}

// Returns { byStaffId: Map(ownaStaffId -> {name, employeeCode, jobTitle, group, label, matchedBy}), stats }
async function resolveRoles(ownaStaff) {
  let emps = [];
  try { emps = await eh.allEmployees(); } catch (e) { emps = []; }
  const byExt = new Map(), byName = new Map();
  for (const e of emps) {
    if (e.externalId) byExt.set(String(e.externalId).trim().toLowerCase(), e);
    for (const key of [firstLast(e.firstName, e.surname), firstLast(e.preferredName, e.surname)]) {
      if (!key) continue;
      if (byName.has(key)) byName.set(key, "AMBIGUOUS"); else byName.set(key, e);
    }
  }
  const byStaffId = new Map();
  const stats = { total: 0, viaCode: 0, viaName: 0, ambiguous: 0, unmatched: 0, ehLoaded: emps.length };
  for (const s of ownaStaff) {
    stats.total++;
    const code = String(s.employeeCode || "").trim().toLowerCase();
    let e = code ? byExt.get(code) : null;
    let matchedBy = e ? "employeeCode" : null;
    if (!e) {
      const hit = byName.get(firstLast(s.firstname, s.surname));
      if (hit === "AMBIGUOUS") { stats.ambiguous++; matchedBy = "name (ambiguous - not used)"; }
      else if (hit) { e = hit; matchedBy = "name"; }
    }
    if (matchedBy === "employeeCode") stats.viaCode++;
    else if (matchedBy === "name") stats.viaName++;
    else if (!e) stats.unmatched++;
    const g = groupFor(e && e.jobTitle, s.staffType);
    byStaffId.set(String(s.id), {
      name: [s.firstname, s.surname].filter(Boolean).join(" "),
      employeeCode: s.employeeCode || null,
      staffType: s.staffType || null,
      jobTitle: (e && e.jobTitle) || null,
      group: g.group, label: g.label,
      matchedBy: matchedBy || "no EH match",
    });
  }
  return { byStaffId, stats };
}

module.exports = { resolveRoles, groupFor, RULES, norm, firstLast };
