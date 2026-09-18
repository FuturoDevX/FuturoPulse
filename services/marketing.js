// Marketing initiatives — what was done, when, and where, so the weekly enquiry line can be read
// against it. Entered by hand: LineLeader's own campaign field is attached to 13 of 1,039 families
// created in 2026, carries no UTM data, and 872 of those enquiries arrived as inquiry type "Import",
// so campaign effect is not recoverable from the CRM. See db/schema.sql.
const db = require("../db/db");
const cal = require("./calendar");

const CHANNELS = ["event", "print", "signage", "social", "partner", "digital", "other"];

function list({ from, to, ownaId } = {}) {
  const where = [], args = {};
  if (from) { where.push("m.starts_on >= @from"); args.from = from; }
  if (to) { where.push("m.starts_on <= @to"); args.to = to; }
  // A group-wide initiative (owna_id NULL) shows on every centre, because it affected every centre.
  if (ownaId) { where.push("(m.owna_id = @owna OR m.owna_id IS NULL)"); args.owna = ownaId; }
  return db.prepare(`
    SELECT m.*, c.name AS centre_name
    FROM marketing_initiatives m LEFT JOIN centres c ON c.owna_id = m.owna_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY m.starts_on DESC, m.id DESC
  `).all(args);
}

// Initiatives grouped by the Monday of the week they started, for annotating a weekly series.
// An initiative that ran across weeks is marked on the week it STARTED — that is the week whose
// enquiries it could first have moved.
function byWeek({ from, to, ownaId } = {}) {
  const out = new Map();
  for (const m of list({ from, to, ownaId })) {
    const w = mondayOf(m.starts_on);
    if (!out.has(w)) out.set(w, []);
    out.get(w).push(m);
  }
  return out;
}

function mondayOf(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ""))) return null;
  const t = new Date(d + "T00:00:00Z");
  if (Number.isNaN(t.getTime())) return null;
  return cal.addDays(d, -((t.getUTCDay() + 6) % 7));
}

function valid(row) {
  const errs = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.starts_on || ""))) errs.push("A start date is required, as YYYY-MM-DD.");
  else if (mondayOf(row.starts_on) === null) errs.push("That start date is not a real day.");
  if (row.ends_on && mondayOf(row.ends_on) === null) errs.push("That end date is not a real day.");
  if (row.ends_on && row.ends_on < row.starts_on) errs.push("The end date is before the start date.");
  if (!String(row.title || "").trim()) errs.push("Give it a title — it is what appears on the chart.");
  if (row.channel && !CHANNELS.includes(row.channel)) errs.push("Unknown channel.");
  return errs;
}

function save(row) {
  const errs = valid(row);
  if (errs.length) return { ok: false, errs };
  const args = {
    starts_on: row.starts_on,
    ends_on: row.ends_on || null,
    owna_id: row.owna_id || null,
    title: String(row.title).trim(),
    channel: row.channel || null,
    detail: (row.detail || "").trim() || null,
    source: (row.source || "").trim() || null,
  };
  if (row.id) {
    db.prepare(`UPDATE marketing_initiatives SET starts_on=@starts_on, ends_on=@ends_on, owna_id=@owna_id,
      title=@title, channel=@channel, detail=@detail, source=@source, updated_at=datetime('now')
      WHERE id=@id`).run({ ...args, id: row.id });
    return { ok: true, id: Number(row.id) };
  }
  const r = db.prepare(`INSERT INTO marketing_initiatives (starts_on, ends_on, owna_id, title, channel, detail, source)
    VALUES (@starts_on, @ends_on, @owna_id, @title, @channel, @detail, @source)`).run(args);
  return { ok: true, id: r.lastInsertRowid };
}

function remove(id) {
  return db.prepare(`DELETE FROM marketing_initiatives WHERE id = ?`).run(id).changes;
}

module.exports = { CHANNELS, list, byWeek, mondayOf, valid, save, remove };
