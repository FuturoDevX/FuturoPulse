// Session persistence. express-session's default MemoryStore loses every login on restart and leaks
// (its own docs say it is not for production), so sessions live in the SAME SQLite file as the rest of
// the app: better-sqlite3-session-store is handed db/db.js's existing connection, so there is no second
// service, no second file, no second connection, and nothing to fight the app's WAL mode.
//
// Vendor note for the register (outstanding.md, week 5): better-sqlite3-session-store 0.1.0, pinned
// exactly. About 200 lines of SQL against the client it is given, no network of its own, no data leaves
// this process. Licence is GPL-3.0-only, which reaches distributing the software, not running it — this
// app is self-hosted and not distributed, but the licence should be recorded. It also declares date-fns
// as a dependency that its own source never requires; the resolved version is pinned in package-lock.json.
//
// The table it keeps (`sessions`) holds personal information — a signed-in user's id, email, name and
// role — so rows must not accumulate. Every row carries an expiry, expired rows are refused on read
// and swept on a timer, and the cookie's maxAge below is what sets that expiry.
const session = require("express-session");
const db = require("../db/db");
const BaseSqliteStore = require("better-sqlite3-session-store")(session);

// Eight hours from the last request — a working day, so a director signed in at drop-off is still
// signed in at pick-up, and a session left open on a centre iPad is not valid the next morning.
// express-session refreshes the cookie (and the store refreshes the row) on each request, so this is
// eight hours of INACTIVITY, not a hard eight hours from login.
const MAX_AGE_MS = 1000 * 60 * 60 * 8;
const PRUNE_INTERVAL_MS = 1000 * 60 * 15;

// The published store starts its prune timer inside its constructor and keeps no reference to it, so
// the handle is unreachable and the timer holds the process open forever — a test run or a one-off CLI
// that touches this module would never exit. Overriding startInterval (the base constructor calls it,
// after the client and table are ready) keeps the handle and unrefs it, and sweeps once up front so
// rows that expired while the process was down go at boot rather than up to 15 minutes later.
class PrunedSqliteStore extends BaseSqliteStore {
  startInterval() {
    this.clearExpiredSessions();
    this.pruneTimer = setInterval(() => this.clearExpiredSessions(), this.expired.intervalMs);
    if (typeof this.pruneTimer.unref === "function") this.pruneTimer.unref();
  }
  stopPruning() { // for tests and clean shutdowns
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }
}

const store = new PrunedSqliteStore({ client: db, expired: { clear: true, intervalMs: PRUNE_INTERVAL_MS } });

// `secure` is passed in rather than read here so the caller keeps one definition of "are we in prod".
function sessionMiddleware({ secure = false } = {}) {
  return session({
    store,
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false, // only a real login writes a row, so the table cannot fill with drive-by requests
    cookie: { httpOnly: true, sameSite: "lax", secure, maxAge: MAX_AGE_MS },
  });
}

module.exports = { sessionMiddleware, store, MAX_AGE_MS, PRUNE_INTERVAL_MS };
