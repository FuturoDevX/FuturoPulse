// OWNA Childcare Portal API client.
// Docs: https://api.owna.com.au/swagger/index.html
// Auth: single API key sent as the "x-api-key" header.
//
// List endpoints return { data: [...], totalCount, errors } and page via take/skip.
// Attendance additionally REQUIRES a `sort` query param (bare field name, e.g. "attendanceDate").
require("dotenv").config();

const BASE = (process.env.OWNA_BASE_URL || "https://api.owna.com.au").replace(/\/$/, "");
const KEY = (process.env.OWNA_API_KEY || "").trim();
const PAGE = 500; // rows per page when walking a list endpoint

if (!KEY) {
  console.warn("[owna] OWNA_API_KEY is not set — API calls will fail. Fill it into .env.");
}

// Futuro runs a DNS-filtering agent on the machine itself (the resolver is 127.0.0.1), and it decides
// per lookup. Even with api.owna.com.au allow-listed the verdict flaps: a single probe succeeds five
// times out of five, then the next minute the same call is intercepted. A nightly snapshot makes several
// hundred calls, so it will meet a blocked moment almost every run — and one was enough to kill it.
//
// Two shapes to survive, both transient and both worth retrying:
//   · the interception itself, which fails the TLS handshake (UNABLE_TO_VERIFY_LEAF_SIGNATURE) because
//     the agent presents its own certificate and Node ships its own CA list
//   · the block page, HTTP 200 with a "Website Filtered" body
// A 4xx from OWNA is NOT retried — that is OWNA answering, and asking again will not change its mind.
const RETRIES = Number(process.env.OWNA_RETRIES || 4);
const RETRY_BASE_MS = Number(process.env.OWNA_RETRY_MS || 1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function transient(e) {
  if (e && e.notJson && e.filtered) return true;
  const code = (e && e.cause && e.cause.code) || (e && e.code) || "";
  return /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED|CERT_|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(String(code))
    || /fetch failed/i.test(String(e && e.message));
}

async function apiGet(path, opts = {}) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try { return await apiGetOnce(path, opts); }
    catch (e) {
      last = e;
      if (!transient(e) || attempt === RETRIES) throw e;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt));   // 1.5s, 3s, 6s, 12s
    }
  }
  throw last;
}

async function apiGetOnce(path, { query } = {}) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { "x-api-key": KEY, Accept: "application/json" } });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = undefined; }
  if (!res.ok) {
    // Status + path only. Never include the response body — it may contain children's or staff records.
    const err = new Error(`OWNA ${res.status} ${path}`);
    err.status = res.status;
    throw err;
  }
  // A 200 is not the same as an answer. Futuro's network runs a DNS filter that intercepts this host and
  // serves its own block page — HTTP 200, content-type text/html, a 515-byte "Website Filtered" document.
  // This used to be caught by JSON.parse and then handed back as a STRING, which getAll() read as "no
  // rows": every pull returned zero, the nightly run recorded itself as ok, and the feed was dead for
  // eight days before anyone noticed. A response that is not JSON is a failure, and says which host did it.
  if (body === undefined) {
    const ct = res.headers.get("content-type") || "no content-type";
    const filtered = /dnsfilter|website filtered|blocked/i.test(text);
    const err = new Error(
      `OWNA ${path}: expected JSON, got ${ct}` +
      (filtered ? " — this looks like a network filter's block page, not OWNA. The host is being intercepted." : "")
    );
    err.status = res.status;
    err.notJson = true;
    err.filtered = filtered;
    throw err;
  }
  return body;
}

// Walk a paginated list endpoint until every row is collected.
//
// getAll returns the rows. getAllWithMeta returns them alongside what the walk actually did, because
// "how many rows came back" and "did we get everything" are different questions and only the first one
// was ever asked. The walk exits on `skip >= totalCount`, advancing skip by rows RECEIVED — so if OWNA
// repeats a row across pages (runCoeSnapshot has always deduplicated for exactly this reason), skip runs
// ahead of the unique rows held and the walk stops early, with nothing to show it did. Reported, not
// guessed at: the caller decides whether a short walk is worth retrying or refusing.
// `key` turns a row into its identity. Give one and the walk deduplicates as it goes, which is the only
// way it can tell how many rows it HOLDS from how many it was HANDED — and those differ. OWNA repeats
// rows across pages (runCoeSnapshot has deduplicated by hand since it was written), and the exit test
// advances by rows received, so a walk can sail past totalCount while still missing real rows and report
// itself complete. Pass `seen` to share one identity set across several walks, so a row repeated across
// two requests is held once.
async function getAllWithMeta(path, { query, key, seen } = {}) {
  const out = [];
  const ids = seen || (key ? new Set() : null);
  // Two different questions, so two different sets. `local` is what THIS request delivered, and it is
  // what "did we get everything we asked for?" must be judged on. `ids` may be shared across requests,
  // so a booking that legitimately appears at the seam between two months is held once — but that is a
  // boundary, not a loss, and counting it as one would make every chunk after the first look short.
  const local = key ? new Set() : null;
  let skip = 0, pages = 0, total = null, stop = "exhausted", dupes = 0, held = 0;
  for (;;) {
    const q = { take: PAGE, skip, ...query };
    const body = await apiGet(path, { query: q });
    const rows = Array.isArray(body) ? body : (body && body.data) || [];
    if (pages === 0) total = body && typeof body.totalCount === "number" ? body.totalCount : null;
    for (const r of rows) {
      if (!key) { out.push(r); held += 1; continue; }
      const k = key(r);
      if (k == null) { out.push(r); held += 1; continue; }  // unkeyable rows are kept, never dropped
      if (local.has(k)) { dupes += 1; continue; }           // OWNA repeated it inside this walk
      local.add(k);
      held += 1;
      if (ids && ids.has(k)) continue;                      // already held from an earlier request
      if (ids) ids.add(k);
      out.push(r);
    }
    pages += 1;
    const effTotal = total == null ? rows.length : total;
    skip += rows.length;
    if (rows.length === 0) { stop = "empty-page"; break; }
    if (skip >= effTotal) { stop = total == null ? "no-total-count" : "reached-total"; break; }
    if (skip > 200000) { stop = "safety-stop"; break; }
  }
  return {
    rows: out,
    meta: {
      pages, stop,
      received: skip,                 // rows OWNA handed over for this range, repeats included
      held,                           // distinct rows it actually delivered for this range
      duplicates: dupes,
      total_count: total,
      // Short means: OWNA said how many rows exist and we hold fewer. With no count at all, a walk that
      // filled its one and only page is suspect — that is exactly how a silent truncation presents.
      short: total == null ? (pages === 1 && skip >= PAGE) : held < total,
    },
  };
}

async function getAll(path, { query } = {}) {
  return (await getAllWithMeta(path, { query })).rows;
}

// Attendance, pulled in monthly chunks.
//
// A single request for a long range does not come back whole. Booked child-days for the four operating
// centres, walked over a seven- and a twelve-month window, came back missing whole Monday-to-Friday
// blocks from the MIDDLE of the range — 17 gaps across the four centres, every one of them starting on a
// Monday and ending on a Friday, several with complete weeks on both sides. No pattern of family
// bookings produces that. It is the long request losing pages.
//
// The damage was not the missing days themselves but what was inferred from them: the last date a pull
// happened to return became "the centre's booking horizon", and six months of continuation for two
// centres were blanked on a board report with a footnote telling the reader families had not booked that
// far ahead. They had.
//
// runOwnaBackfill has chunked by month since it was written, with the comment "to keep each request
// small". The two paths that feed the board report did not. Now they all do — one chunk per calendar
// month, deduplicated on (child, date) across chunk boundaries, with each chunk's walk reported so a
// short one is visible instead of silently becoming a shorter horizon.
function monthChunks(from, to) {
  const out = [];
  let y = +from.slice(0, 4), m = +from.slice(5, 7);
  for (;;) {
    const start = `${y}-${String(m).padStart(2, "0")}-01`;
    const endDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = `${y}-${String(m).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
    out.push({ from: start < from ? from : start, to: end > to ? to : end });
    if (end >= to) break;
    m += 1; if (m > 12) { m = 1; y += 1; }
    if (out.length > 400) break;   // a decade of months; this loop must never be the thing that hangs
  }
  return out;
}

// A booking is one child on one day. Rows carrying neither are kept rather than dropped — an unkeyable
// row is a row we do not understand, and discarding it would be a second silent loss.
const attendanceKey = (r) => {
  const day = String((r && r.attendanceDate) || "").slice(0, 10);
  const cid = r && r.childId != null ? String(r.childId) : null;
  return day && cid ? `${cid}|${day}` : null;
};

async function attendanceChunked(centreId, from, to) {
  const chunks = [];
  const seen = new Set();          // shared across chunks: a booking repeated at a boundary is held once
  const rows = [];
  for (const ch of monthChunks(fmtDate(from), fmtDate(to))) {
    const { rows: got, meta } = await getAllWithMeta(
      `/api/attendance/${centreId}/${ch.from}/${ch.to}`,
      { query: { sort: "attendanceDate" }, key: attendanceKey, seen });
    rows.push(...got);
    chunks.push({ ...ch, ...meta });
  }
  return { rows, chunks, short: chunks.filter((c) => c.short) };
}

// Dates: OWNA path params are date-times; a plain YYYY-MM-DD works.
const fmtDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

const owna = {
  hasKey: () => Boolean(KEY),

  async listCentres() {
    return getAll("/api/centre/list");
  },

  async listRooms(centreId) {
    return getAll(`/api/room/${centreId}/list`);
  },

  // All children for a centre (active, finished, upcoming) — carries finishDate/activeFrom.
  async listChildren(centreId) {
    return getAll(`/api/children/${centreId}/list`);
  },

  // Child incident reports for a centre + date range.
  async childIncidents(centreId, from, to) {
    return getAll(`/api/children/incident/${centreId}/${fmtDate(from)}/${fmtDate(to)}`);
  },

  // Booked child-days with fee + attendance + casual flags.
  // Rows only, deduplicated, pulled in monthly chunks. Use attendanceDetailed when the caller needs to
  // know whether the pull was complete — anything that infers a DATE from the result must.
  async attendance(centreId, from, to) {
    return (await attendanceChunked(centreId, from, to)).rows;
  },
  async attendanceDetailed(centreId, from, to) {
    return attendanceChunked(centreId, from, to);
  },

  // CCS subsidy payments clearing in the window.
  async ccsPayments(centreId, from, to) {
    return getAll(`/api/ccs/payments/${centreId}/${fmtDate(from)}/${fmtDate(to)}/list`);
  },

  // Weekly staff roster (weekStarting = Monday, YYYY-MM-DD). Returns the week's roster doc, or null.
  // Shape: { weekstarting, monday..sunday: [shift...], rosteredhours: [{<day>: hours, hoursperbooking}], leave, comments }
  async weeklyRoster(centreId, weekStarting) {
    const body = await apiGet(`/api/roster/${centreId}/${fmtDate(weekStarting)}`);
    const rows = Array.isArray(body) ? body : (body && body.data) || [];
    return rows[0] || null;
  },
};

module.exports = { owna, apiGet, getAll, getAllWithMeta, monthChunks, fmtDate };
