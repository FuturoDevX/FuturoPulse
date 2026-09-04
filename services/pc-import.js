// Parse the HR SharePoint P&C workbooks (a sheet per centre) into pc_metrics:
//   • "eNPS Data.xlsx"                     — sheets GWH/Bardia/Austral/LHR, rows: Date ("Quarter 2 2026") | eNPS
//   • "Turnover Analysis Working Document" — sheets "Turnover <centre>", rows: Month | Headcount | Leavers | MoM Turnover | YoY Turnover
// Uploaded (like the Q&C audit) — no SharePoint credentials needed.
const XLSX = require("xlsx");
const db = require("../db/db");

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

// Sheet name (e.g. "Turnover GWH", "LHR") -> owna_id, by centre keyword.
function centreForSheet(sheetName) {
  const s = (sheetName || "").toLowerCase();
  const key = /gwh|gledswood/.test(s) ? /gledswood/
    : /bardia/.test(s) ? /bardia/
    : /austral/.test(s) ? /austral/
    : /lhr|leppington|heath/.test(s) ? /heath/ : null;
  if (!key) return null;
  const c = db.prepare("SELECT owna_id, name FROM centres WHERE owna_id IS NOT NULL").all().find((c) => key.test((c.name || "").toLowerCase()));
  return c ? c.owna_id : null;
}

function parseMonth(v) { // "March '24" / "June'26" -> "2024-03"
  const m = String(v || "").trim().toLowerCase().match(/([a-z]+)\s*'?\s*(\d{4}|\d{2})/);
  if (!m || !MONTHS[m[1]]) return null;
  const yr = m[2].length === 2 ? "20" + m[2] : m[2];
  return `${yr}-${String(MONTHS[m[1]]).padStart(2, "0")}`;
}
function parseQuarter(v) { // "Quarter 2 2026" -> "2026-06" (quarter-end month)
  const m = String(v || "").trim().match(/quarter\s*([1-4])\s*(\d{4})/i);
  if (!m) return null;
  return `${m[2]}-${String(Number(m[1]) * 3).padStart(2, "0")}`;
}
// A turnover cell may be a fraction (0.057) or already a percent (5.7); normalise to a percent number.
function asPct(x) { const n = Number(x); if (isNaN(n)) return null; return Math.round((n <= 2 ? n * 100 : n) * 10) / 10; }
const asInt = (x) => { const n = Number(x); return isNaN(n) ? null : Math.round(n); };

function parsePcWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const out = []; const kinds = new Set();
  for (const name of wb.SheetNames) {
    const owna_id = centreForSheet(name);
    if (!owna_id) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false });
    if (!rows.length) continue;
    const header = rows[0].map((x) => String(x || "").toLowerCase());
    const col = (re) => header.findIndex((h) => re.test(h));

    if (col(/^date$/) >= 0 && col(/enps/) >= 0) { // eNPS workbook
      kinds.add("eNPS");
      const di = col(/^date$/), ei = col(/enps/);
      for (let i = 1; i < rows.length; i++) {
        const month = parseQuarter(rows[i][di]); const v = asInt(rows[i][ei]);
        if (month && v != null) out.push({ owna_id, month, fields: { enps: v } });
      }
    } else if (col(/month/) >= 0 && col(/headcount/) >= 0) { // Turnover workbook
      kinds.add("turnover");
      const mi = col(/month/), hi = col(/headcount/), li = col(/leaver/), momi = col(/mom/), yoyi = col(/yoy/);
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]; const month = parseMonth(r[mi]); if (!month) continue;
        const f = {};
        if (hi >= 0 && asInt(r[hi]) != null) f.headcount = asInt(r[hi]);
        if (li >= 0 && asInt(r[li]) != null) f.leavers = asInt(r[li]);
        if (momi >= 0 && asPct(r[momi]) != null) f.turnover_mom = asPct(r[momi]);
        if (yoyi >= 0 && asPct(r[yoyi]) != null) f.turnover = asPct(r[yoyi]);
        if (Object.keys(f).length) out.push({ owna_id, month, fields: f });
      }
    }
  }
  return { kinds: [...kinds], rows: out };
}

// Merge specific fields into a pc_metrics row without clobbering the others (manual eNPS/psych/etc.).
function mergePc(owna_id, month, fields) {
  const cols = Object.keys(fields); if (!cols.length) return;
  db.prepare("INSERT OR IGNORE INTO pc_metrics (owna_id, month, updated_at) VALUES (?,?,datetime('now'))").run(owna_id, month);
  const set = cols.map((c) => `${c}=@${c}`).join(", ");
  db.prepare(`UPDATE pc_metrics SET ${set}, updated_at=datetime('now') WHERE owna_id=@owna_id AND month=@month`).run({ owna_id, month, ...fields });
}

function importPcWorkbook(buffer) {
  const { kinds, rows } = parsePcWorkbook(buffer);
  if (!rows.length) throw new Error("No recognisable P&C data found. Upload the “eNPS Data” or “Turnover Analysis Working Document” workbook (a sheet per centre).");
  db.transaction(() => { for (const r of rows) mergePc(r.owna_id, r.month, r.fields); })();
  return { kinds, rows: rows.length, centres: new Set(rows.map((r) => r.owna_id)).size, months: new Set(rows.map((r) => r.month)).size };
}

module.exports = { parsePcWorkbook, importPcWorkbook };
