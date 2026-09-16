// Pay classification — one place, so the owner can read the rule and correct it.
//
// THE OWNER'S RULE (16 September 2026): a person's ROLE is their PAY CLASSIFICATION, not their job
// title. Payroll carries it on the employee record as `payRateTemplate`. The talent step used to guess
// the role from `jobTitle`; this module replaces that guess for role classification.
//
// The mapping, verbatim from the owner:
//   Permanent - Teachers - Long Day Care Centres - Level 1..5  ->  ECT
//   Permanent CSE Level 1 - Introductory Educator              ->  Trainee
//   Permanent CSE Level 2 - Educator                           ->  Trainee
//   Permanent CSE Level 3 - Qualified Educator                 ->  Cert 3
//   Permanent CSE Level 4 - Experienced Educator               ->  Cert 3
//   Permanent CSE Level 5 - Advanced Educator                  ->  Dip
//   Permanent CSE Level 6 - Room Leader                        ->  Dip
// That list covers 140 of the 221 people on payroll. The other 81 are real people and are NOT dropped:
//   * CASUAL equivalents ("Casual CSE Level 5 - Advanced Educator") are the SAME SCALE on a casual
//     contract, so they match on the LEVEL. The scale's Permanent/Casual prefix is not stripped and is
//     not consulted — the family and the level decide, because "Permanent - Teachers ... Level 3" and
//     "Permanent CSE Level 3" are DIFFERENT scales that happen to share a level number.
//   * CSE Level 7 (Assistant Director) and Level 8 (Director) are Management, not educators.
//   * Support Worker scales are Support — kitchen and cleaning, which /wages already treats as its own
//     cost centre. Their "L1.1" / "L3.1" is a support-worker step, NEVER a CSE level, so that family is
//     tested first and its numbers are never read as a level.
//   * A suffix such as "17 yrs" (a junior rate) is noise around the level, not a different scale.
//   * Anything still unmatched is "Unclassified" — counted, shown, and listed on /admin/pay-scales with
//     the number of people on it, so an unmapped or wrongly-mapped scale is visible rather than folded
//     into somebody else's number. 13 people carry no payRateTemplate at all; they land here too.
//
// PRIVACY: a payRateTemplate is a pay scale, not personal data — no name, no employee id, no date of
// birth passes through this module, and none is stored by the caller.
"use strict";

// The reporting categories, in the order the owner reads them.
const CATEGORIES = Object.freeze([
  { key: "ect", label: "ECT" },
  { key: "dip", label: "Dip" },
  { key: "cert3", label: "Cert 3" },
  { key: "trainee", label: "Trainee" },
  { key: "management", label: "Management" },
  { key: "support", label: "Support" },
  { key: "unclassified", label: "Unclassified" },
]);
const CATEGORY_KEYS = Object.freeze(CATEGORIES.map((c) => c.key));
const LABEL = new Map(CATEGORIES.map((c) => [c.key, c.label]));

// CSE level -> category. A level that is not in here is NOT guessed at: it becomes Unclassified and
// shows up on the admin mapping page for the owner to rule on.
const CSE_LEVELS = Object.freeze({ 1: "trainee", 2: "trainee", 3: "cert3", 4: "cert3", 5: "dip", 6: "dip", 7: "management", 8: "management" });

// What a scale is a scale FOR. Support worker is tested first: "Permanent Support Worker L1.1 (On
// Commencement)" carries a number that must never be read as a CSE level.
function familyOf(scale) {
  if (/support\s*worker/i.test(scale)) return "support_worker";
  if (/\bteachers?\b/i.test(scale)) return "teacher";
  if (/\bcse\b/i.test(scale)) return "cse";
  return null;
}
// The level, read only where the word "Level" says so — so "17 yrs" cannot become a level, and the
// Permanent/Casual prefix is irrelevant to it.
function levelOf(scale) {
  const m = /\blevel\s*(\d{1,2})\b/i.exec(scale);
  return m ? Number(m[1]) : null;
}

const normalise = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

// Classify one payRateTemplate. Always returns a category — never null, never a throw — because a
// person on a scale nobody has mapped still has to be counted somewhere a reader can see.
function classify(payRateTemplate) {
  const scale = normalise(payRateTemplate);
  const out = (key, matched, why) => ({ scale, key, label: LABEL.get(key), family: familyOf(scale), level: levelOf(scale), matched, why });
  if (!scale) return { scale: "", key: "unclassified", label: LABEL.get("unclassified"), family: null, level: null, matched: false, why: "no pay classification recorded in payroll" };
  const family = familyOf(scale), level = levelOf(scale);
  if (family === "support_worker") return out("support", true, "Support Worker scale — kitchen and cleaning");
  if (family === "teacher") return out("ect", true, "Teachers scale" + (level == null ? "" : ` — Level ${level}`));
  if (family === "cse") {
    const key = level == null ? null : CSE_LEVELS[level];
    if (key) return out(key, true, `CSE Level ${level}`);
    return out("unclassified", false, level == null ? "a CSE scale with no level to match on" : `CSE Level ${level} is not in the owner's mapping`);
  }
  return out("unclassified", false, "no rule matches this pay scale");
}

const categoryOf = (payRateTemplate) => classify(payRateTemplate).key;
const labelOf = (key) => LABEL.get(key) || key;
// What a scale with nothing recorded is called wherever one is listed.
const NO_SCALE_LABEL = "(no pay classification recorded)";

module.exports = { CATEGORIES, CATEGORY_KEYS, CSE_LEVELS, classify, categoryOf, labelOf, familyOf, levelOf, normalise, NO_SCALE_LABEL };
