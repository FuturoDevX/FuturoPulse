// Parse a Futuro compliance-audit .xlsx (Summary + Compliance Action Plan sheets).
const XLSX = require("xlsx");
const db = require("../db/db");

function cell(v) { return v == null ? "" : String(v).trim(); }
function dateStr(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v); const m = s.match(/\d{4}-\d{2}-\d{2}/); return m ? m[0] : s.slice(0, 10);
}

function matchCentre(name) {
  const norm = (s) => (s || "").toLowerCase().replace(/futuro|childcare|education|gc&e|and|&/g, "").replace(/[^a-z]/g, "");
  const key = norm(name);
  const centres = db.prepare("SELECT owna_id, name FROM centres").all();
  return centres.find((c) => { const n = norm(c.name); return n && key && (n.includes(key) || key.includes(n)); });
}

function parseAudit(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sum = XLSX.utils.sheet_to_json(wb.Sheets["Summary"], { header: 1, blankrows: false });
  let centreName = "", auditor = "", auditDate = null;
  let qaHeaderRow = -1;
  sum.forEach((row, i) => {
    const a = cell(row[0]);
    if (/centre name/i.test(a)) centreName = cell(row[1]);
    if (/person completing/i.test(a)) auditor = cell(row[1]);
    if (/audit date/i.test(a)) auditDate = dateStr(row[1]);
    if (/quality area/i.test(a) && /line item/i.test(cell(row[1]))) qaHeaderRow = i;
  });
  const qa = [];
  if (qaHeaderRow >= 0) {
    for (let i = qaHeaderRow + 1; i < sum.length; i++) {
      const row = sum[i]; const name = cell(row[0]);
      const m = name.match(/^QA\s*([1-7])/i);
      if (!m) continue;
      const items = Number(row[1]) || 0, y = Number(row[2]) || 0, n = Number(row[3]) || 0;
      const pct = row[5] != null ? Math.round(Number(row[5]) * 1000) / 10 : (items ? Math.round(y / items * 1000) / 10 : null);
      qa.push({ code: "QA" + m[1], name: name.replace(/^QA\s*[1-7]\s*/i, "").trim(), items, y, n, pct });
    }
  }
  const overall = qa.reduce((a, q) => ({ y: a.y + q.y, items: a.items + q.items }), { y: 0, items: 0 });
  const overall_pct = overall.items ? Math.round(overall.y / overall.items * 1000) / 10 : null;

  // Compliance Action Plan sheet
  const actions = [];
  const apSheet = wb.Sheets["Compliance Action Plan"];
  if (apSheet) {
    const rows = XLSX.utils.sheet_to_json(apSheet, { header: 1, blankrows: false });
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const qaCol = cell(r[0]), issue = cell(r[1]), action = cell(r[2]);
      if (!qaCol && !issue && !action) continue;
      if (!issue && !action) continue;
      actions.push({ quality_area: qaCol, issue, action, progress: cell(r[3]),
        priority: cell(r[4]), owner: cell(r[5]), due_date: dateStr(r[6]), completed: cell(r[7]) });
    }
  }
  return { centreName, auditor, auditDate, qa, overall_pct, actions };
}

function importAuditBuffer(buffer, term) {
  const p = parseAudit(buffer);
  const c = matchCentre(p.centreName);
  if (!c) throw new Error(`Could not match "${p.centreName}" to a centre.`);
  // Each audit is one row per (centre, term). Re-uploading the same term replaces it; a new term is added,
  // so history accumulates and trends can be tracked over time.
  const auditTerm = (term && term.trim()) || p.auditDate || "Unknown";
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO qc_audits (owna_id, term, centre_name, auditor, audit_date, overall_pct, qa_json, uploaded_at)
      VALUES (?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(owna_id, term) DO UPDATE SET centre_name=excluded.centre_name, auditor=excluded.auditor, audit_date=excluded.audit_date,
        overall_pct=excluded.overall_pct, qa_json=excluded.qa_json, uploaded_at=datetime('now')`)
      .run(c.owna_id, auditTerm, p.centreName, p.auditor, p.auditDate, p.overall_pct, JSON.stringify(p.qa));
    db.prepare("DELETE FROM qc_actions WHERE owna_id = ? AND term = ?").run(c.owna_id, auditTerm);
    const ins = db.prepare(`INSERT INTO qc_actions (owna_id, term, quality_area, issue, action, progress, priority, owner, due_date, completed) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const a of p.actions) ins.run(c.owna_id, auditTerm, a.quality_area, a.issue, a.action, a.progress, a.priority, a.owner, a.due_date, a.completed);
  });
  tx();
  return { centre: c.name, owna_id: c.owna_id, term: auditTerm, qa: p.qa.length, actions: p.actions.length, overall_pct: p.overall_pct };
}

module.exports = { parseAudit, importAuditBuffer };
