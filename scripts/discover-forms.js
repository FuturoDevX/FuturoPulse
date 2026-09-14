// CLI entry: `npm run discover-forms` — maps what OWNA's two form systems actually hold, so the
// question "what can we get from forms?" is answered from the live tenant rather than from the spec.
//
// Nothing is written to the database. This is a read-only survey.
//
// OWNA exposes forms twice over, and the spec types neither payload:
//   /api/formsubmission/*  staff-completed template forms — answers sit in `values` (string) and `data`
//   /api/customform/*      custom form responses          — answers sit in `formresponses`
// There is no endpoint that lists form templates, so the only way to learn which forms a service runs
// is to pull submissions and group them by formtemplateid / formid. That is what this does.
//
// NOTE on 415: OWNA answers "You do not have authority to make this API Call" with HTTP 415, not 403.
// A 415 from a form route therefore means the API key is not scoped for forms — it does NOT mean the
// request was malformed, and it does NOT mean the tenant has no forms. This script says so explicitly,
// because the two readings lead to completely different next steps.
//
// Field VALUES are never printed. For each discovered field the report gives the name, the type, how
// often it is filled and a shape hint (date / number / boolean / free text + length) — enough to map a
// payload into columns without putting children's or staff answers on a terminal or into a file.
// Pass --raw to print one un-redacted sample per template when you need to eyeball an ambiguous field;
// treat that output as personal information and do not commit it.
//
// Usage:
//   npm run discover-forms                 last 90 days, every centre
//   node scripts/discover-forms.js --days 365
//   node scripts/discover-forms.js --raw   include one raw sample per template (PII — see above)
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { apiGet, getAll, owna, fmtDate } = require("../services/owna");

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true);
};
const DAYS = Number(flag("days", 90)) || 90;
const RAW = Boolean(flag("raw", false));

const to = new Date();
const from = new Date(Date.now() - DAYS * 864e5);

// ---------------------------------------------------------------- shape inference

// Describe a value without disclosing it: what kind of thing is this, not what does it say.
function hint(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === "object") return "object";
  const s = String(v).trim();
  if (s === "") return "empty";
  if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(s)) return "date";
  if (/^-?\d+(\.\d+)?$/.test(s)) return "numeric-string";
  if (/^(true|false|yes|no|y|n)$/i.test(s)) return "boolean-string";
  if (/^data:image\//.test(s) || /^https?:\/\//.test(s)) return `url/dataurl len=${s.length}`;
  return `text len=${s.length}`;
}

// A form payload may be a JSON string, an object, or an array of {question, answer} pairs.
// Normalise all three into flat field paths so one report can describe any of them.
function flatten(value, prefix, out) {
  let v = value;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("{") || s.startsWith("[")) { try { v = JSON.parse(s); } catch { /* leave as text */ } }
  }
  if (v === null || v === undefined || typeof v !== "object") {
    out.push([prefix || "(scalar)", hint(v)]);
    return;
  }
  if (Array.isArray(v)) {
    // The common OWNA shape: a list of answered questions. Key on the question, not the index,
    // so the same question lines up across submissions.
    const labelKey = ["question", "label", "name", "title", "key", "fieldname"].find((k) => v[0] && typeof v[0] === "object" && k in v[0]);
    const valueKey = ["answer", "value", "response", "val"].find((k) => v[0] && typeof v[0] === "object" && k in v[0]);
    if (labelKey && valueKey) {
      for (const item of v) flatten(item[valueKey], `${prefix}[${String(item[labelKey]).slice(0, 60)}]`, out);
      return;
    }
    for (const item of v.slice(0, 1)) flatten(item, `${prefix}[]`, out);
    return;
  }
  for (const [k, val] of Object.entries(v)) flatten(val, prefix ? `${prefix}.${k}` : k, out);
}

// Accumulate field paths across many submissions so the report can show a fill rate per field.
function tally(store, rows, payloadKeys) {
  for (const row of rows) {
    const seen = new Set();
    for (const pk of payloadKeys) {
      if (!(pk in row) || row[pk] === null || row[pk] === "") continue;
      const out = [];
      flatten(row[pk], pk, out);
      for (const [field, h] of out) {
        if (seen.has(field)) continue;
        seen.add(field);
        const e = store.get(field) || { filled: 0, hints: new Map() };
        if (h !== "null" && h !== "empty") e.filled++;
        e.hints.set(h.replace(/len=\d+/, "len=n"), (e.hints.get(h.replace(/len=\d+/, "len=n")) || 0) + 1);
        store.set(field, e);
      }
    }
  }
}

function report(lines, title, store, total) {
  lines.push(`\n#### ${title}  (${total} submissions sampled)`);
  if (!store.size) { lines.push("_No fields — the payload was empty on every sampled row._"); return; }
  lines.push("", "| Field | Filled | Looks like |", "|---|---|---|");
  const sorted = [...store.entries()].sort((a, b) => b[1].filled - a[1].filled);
  for (const [field, e] of sorted) {
    const pct = total ? Math.round((e.filled / total) * 100) : 0;
    const kinds = [...e.hints.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k).join(", ");
    lines.push(`| \`${field}\` | ${e.filled}/${total} (${pct}%) | ${kinds} |`);
  }
}

// ---------------------------------------------------------------- probes

// Try each documented route for a family; the first that answers wins. A 404/403 on one route is
// information, not a failure — it tells us which shape of that endpoint this tenant actually serves.
function explain(status) {
  if (status === 415) return "DENIED — key not scoped for this endpoint (OWNA sends 415, not 403)";
  if (status === 401) return "DENIED — key rejected";
  if (status === 404) return "route not served by this tenant";
  return `failed ${status}`;
}

async function probe(routes) {
  const attempts = [];
  for (const [label, p] of routes) {
    try {
      const body = await apiGet(p, { query: { take: 1, skip: 0 } });
      const rows = Array.isArray(body) ? body : (body && body.data) || [];
      attempts.push({ label, path: p, ok: true, total: body && typeof body.totalCount === "number" ? body.totalCount : rows.length });
    } catch (e) {
      attempts.push({ label, path: p, ok: false, status: e.status || "?", why: explain(e.status) });
    }
  }
  return attempts;
}

async function main() {
  if (!owna.hasKey()) { console.error("OWNA_API_KEY is not set — fill it into .env first."); process.exit(1); }

  const lines = [];
  lines.push(`# What OWNA forms actually hold`, "");
  lines.push(`Survey of the live tenant, ${fmtDate(from)} to ${fmtDate(to)} (${DAYS} days). Field names and fill rates only — no answers.`, "");
  lines.push(`Generated by \`npm run discover-forms\` on ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z.`, "");

  const centres = await owna.listCentres();
  lines.push(`\n## Centres surveyed: ${centres.length}`, "");

  // ---- route availability, once, against the first centre
  const c0 = centres[0] && (centres[0].id || centres[0].centreId);
  const routes = await probe([
    ["formsubmission by centre", `/api/formsubmission/${c0}/List`],
    ["formsubmission by date range", `/api/formsubmission/${fmtDate(from)}/${fmtDate(to)}/List`],
    ["customform by centre", `/api/customform/${c0}/List`],
    ["customform by centre + range", `/api/customform/${c0}/${fmtDate(from)}/${fmtDate(to)}/List`],
    ["customform by date range", `/api/customform/${fmtDate(from)}/${fmtDate(to)}/List`],
  ]);
  lines.push("## Which routes this tenant serves", "", "| Route | Result |", "|---|---|");
  for (const r of routes) {
    lines.push(`| \`${r.path.replace(c0, "{centreId}")}\` | ${r.ok ? `OK — totalCount ${r.total}` : r.why} |`);
  }

  // ---- pull everything, per centre, for both families
  const families = [
    { name: "formsubmission", payloadKeys: ["values", "data"], templateKey: "formtemplateid",
      route: (cid) => `/api/formsubmission/${cid}/List` },
    { name: "customform", payloadKeys: ["formresponses"], templateKey: "formid",
      route: (cid) => `/api/customform/${cid}/${fmtDate(from)}/${fmtDate(to)}/List` },
  ];

  for (const fam of families) {
    lines.push(`\n## ${fam.name}`, "");
    const all = [];
    const perCentre = [];
    let denied = false;
    for (const c of centres) {
      const cid = c.id || c.centreId;
      const name = c.name || c.centreName || cid;
      try {
        const rows = await getAll(fam.route(cid));
        perCentre.push(`| ${name} | ${rows.length} |`);
        all.push(...rows);
      } catch (e) {
        perCentre.push(`| ${name} | ${explain(e.status)} |`);
        denied = denied || e.status === 415 || e.status === 401;
      }
    }
    lines.push("| Centre | Submissions |", "|---|---|", ...perCentre, "");

    if (!all.length) {
      lines.push(denied
        ? `**Not accessible.** Every centre returned a permission failure, so this says nothing about whether Futuro uses ${fam.name} — only that the API key cannot read it. Ask OWNA to add forms scope to the key, then re-run.`
        : `_No ${fam.name} rows returned for any centre, and no permission error. This tenant genuinely has no ${fam.name} data in the window._`);
      continue;
    }

    // Envelope fields — the documented, typed wrapper around each submission.
    const envelope = new Map();
    tally(envelope, all.map((r) => { const o = { ...r }; for (const k of fam.payloadKeys) delete o[k]; return o; }), Object.keys(all[0]).filter((k) => !fam.payloadKeys.includes(k)));
    report(lines, "Envelope fields", envelope, all.length);

    // Templates — the whole point: which distinct forms exist, discovered by grouping.
    const byTemplate = new Map();
    for (const r of all) {
      const t = r[fam.templateKey] || "(no template id)";
      if (!byTemplate.has(t)) byTemplate.set(t, []);
      byTemplate.get(t).push(r);
    }
    lines.push(`\n### Distinct forms found: ${byTemplate.size}`, "");
    const ranked = [...byTemplate.entries()].sort((a, b) => b[1].length - a[1].length);
    lines.push("| Template id | Submissions | First seen | Last seen |", "|---|---|---|---|");
    for (const [t, rows] of ranked) {
      const dates = rows.map((r) => r.dateAdded || r.submitted).filter(Boolean).sort();
      lines.push(`| \`${t}\` | ${rows.length} | ${(dates[0] || "").slice(0, 10)} | ${(dates[dates.length - 1] || "").slice(0, 10)} |`);
    }

    // Per template, the answer fields — this is the map you build dashboard columns from.
    for (const [t, rows] of ranked) {
      const store = new Map();
      tally(store, rows, fam.payloadKeys);
      report(lines, `Answers in template \`${t}\``, store, rows.length);
      if (RAW && rows[0]) {
        lines.push("", "<details><summary>Raw sample (PERSONAL INFORMATION — do not commit)</summary>", "",
          "```json", JSON.stringify(rows[0], null, 2).slice(0, 4000), "```", "</details>");
      }
    }
  }

  const outPath = path.join(__dirname, "..", "docs", "owna-forms-survey.md");
  fs.writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\n\nWritten to docs/owna-forms-survey.md`);
}

// Exported so tests can exercise the payload parser without touching the network.
module.exports = { flatten, tally, hint };

if (require.main === module) main().catch((e) => {
  console.error("Form discovery failed:", e.message);
  if (String(e.message).includes("fetch failed")) {
    console.error("If this is UNABLE_TO_VERIFY_LEAF_SIGNATURE or a block page, api.owna.com.au is being");
    console.error("intercepted by a DNS/TLS filter on this network. Allowlist it, or run this on the server.");
  }
  process.exit(1);
});
