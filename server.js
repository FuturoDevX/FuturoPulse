require("dotenv").config();
const path = require("path");
const express = require("express");
const cron = require("node-cron");

const { requireLogin } = require("./middleware/auth");
const { sessionMiddleware } = require("./middleware/session");
const { runSnapshotOnce, errSummary } = require("./services/snapshot");

const app = express();
const PORT = process.env.PORT || 3002;
const isProd = process.env.NODE_ENV === "production";

if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.includes("change-me"))) {
  console.error("Refusing to start in production without a real SESSION_SECRET.");
  process.exit(1);
}

app.locals.privacyContact = process.env.PRIVACY_CONTACT || "the Privacy Officer";
// The line at the foot of the sidebar. Left empty on purpose: the repo records no Futuro tagline and
// the dashboard should not invent one. Set BRAND_TAGLINE and it appears; leave it and the slot is
// simply not rendered.
app.locals.brandTagline = (process.env.BRAND_TAGLINE || "").trim();
// Every stored timestamp is UTC (SQLite datetime('now')). Views must render it in Sydney, never raw
// and never through the host's zone — so they all go through this one helper.
app.locals.sydneyStamp = require("./services/calendar").sydneyStamp;
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "256kb" })); // for the "Ask your data" fetch API
// The two self-hosted faces never change without changing their filename, and a centre director opens
// this on a phone many times a day. Serve them with a long cache so they are fetched once, not four
// files on every page view. Everything else in /public (the stylesheet especially) keeps the default
// revalidate-every-time behaviour, so a restyle still appears on the next load.
app.use("/fonts", express.static(path.join(__dirname, "public/fonts"), { immutable: true, maxAge: "365d" }));
app.use(express.static(path.join(__dirname, "public")));

if (isProd) app.set("trust proxy", 1);
// Sessions are kept in the app's own SQLite file, so a deploy or restart no longer signs everyone out.
// Cookie flags, the expiry and the store's pruning all live in middleware/session.js.
app.use(sessionMiddleware({ secure: isProd }));

// Expose a flash-style message + helpers to all views.
app.use((req, res, next) => {
  res.locals.msg = req.query.msg || null;
  res.locals.currentPath = req.path;
  next();
});

// ===== Under construction =====
// MAINTENANCE=1 puts the whole dashboard behind a holding page: every route answers 503 with
// views/maintenance.ejs. Sign-in still works and admin or ops still get the real dashboard, so the
// people doing the work can keep checking it while trial users see the holding page. Turn it on and
// off with the environment variable on the host — no deploy of code required, just a restart.
const MAINTENANCE = /^(1|true|on|yes)$/i.test(String(process.env.MAINTENANCE || "").trim());
const MAINTENANCE_ROLES = ["admin", "ops_manager"];
if (MAINTENANCE) console.warn("[maintenance] MAINTENANCE is on — everyone except admin/ops sees the holding page");
app.use((req, res, next) => {
  if (!MAINTENANCE) return next();
  // Let people sign in (and out), and let static assets through, or an admin cannot reach the login
  // form or the page cannot style itself.
  if (req.path === "/login" || req.path === "/logout" || req.path === "/healthz") return next();
  // A staff survey link is not part of the dashboard and must keep working while the dashboard is
  // behind the holding page: the invitation has already gone to 221 personal inboxes with a closing
  // date on it, and an educator who clicks it must get the survey, not an under-construction notice.
  if (req.path.startsWith("/s/")) return next();
  const user = req.session && req.session.user;
  if (user && MAINTENANCE_ROLES.includes(user.role)) return next();
  res.status(503);
  res.set("Retry-After", "3600");           // tell crawlers and monitors this is temporary, not gone
  res.set("Cache-Control", "no-store");
  return res.render("maintenance", { user: user || null });
});

// Public
app.use("/", require("./routes/auth"));
// Also public, and deliberately so: the eNPS survey magic link (/s/:token). A respondent is an educator
// on their own phone, not a dashboard user — requiring a login would both defeat the point and destroy
// the anonymity, because the app would then know who was answering. It is rate-limited in the router.
app.use("/", require("./routes/survey"));

// Everything below requires a login
app.use(requireLogin);
app.use((req,res,next) => {
  // "same-origin", not "no-referrer". The goal is that a dashboard URL — which can name a centre —
  // never leaks to another site, and same-origin does that. no-referrer also stripped the Origin
  // header from the browser's own form submissions (Chrome ties the two), which made every write on
  // this site look cross-site to the guard below and refused it.
  res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "same-origin");
  res.set("X-Content-Type-Options", "nosniff"); res.set("X-Frame-Options", "DENY");
  // Reject a write whose Origin is a genuinely different site. This is belt and braces — the session
  // cookie is already SameSite=lax, which is what actually stops a cross-site POST carrying a login.
  //
  // It used to compare the Origin's host to the raw `Host` header, and that refused every write on
  // the deployed site: this runs behind Cloudflare in front of Render, and the host a proxy forwards
  // is not reliably the one the browser used (a port may be added or dropped, and the original may
  // arrive only as X-Forwarded-Host). The result was a bare "Forbidden" on every form submission —
  // saving places, generating a briefing — with nothing logged to explain it.
  //
  // So compare hostnames, and accept any hostname this request could legitimately have been made to.
  // An attacker's origin matches none of them, which is the case this guard exists for.
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
    const hostname = (v) => { try { return new URL(/^https?:\/\//.test(v) ? v : "https://" + v).hostname.toLowerCase(); } catch { return null; } };
    const originHost = hostname(req.headers.origin);
    const permitted = new Set([
      req.hostname,                                  // honours X-Forwarded-Host when trust proxy is set
      hostname(req.get("host")),                     // the raw Host header
      hostname((req.get("x-forwarded-host") || "").split(",")[0].trim()), // first hop, if a proxy set it
      hostname(process.env.PUBLIC_HOSTNAME || ""),   // the canonical address, if configured
    ].filter(Boolean).map((h) => String(h).toLowerCase()));
    if (!originHost || !permitted.has(originHost)) {
      // Log the values that disagreed so this is diagnosable from the logs rather than guessed at.
      // Hostnames only: never a query string, a body, or anything identifying a child or a family.
      console.warn(`[origin] refused ${req.method} ${req.path}: origin ${originHost || "unparseable"}, permitted ${[...permitted].join(" ") || "none"}`);
      return res.status(403).render("error", {
        message: "That form was submitted from a different web address than the one you are signed in to, so it was refused. " +
          "Reload the page and try again. If it keeps happening, tell your administrator the address shown in the browser bar.",
        // Shown to admin and ops only (views/error.ejs), so the next refusal can be read off the
        // screen rather than dug out of the host's logs. Hostnames and method only.
        detail: `origin: ${originHost || "null / unparseable"}\npermitted: ${[...permitted].join(", ") || "none"}\nrequest: ${req.method} ${req.path}`,
      });
    }
  }
  next();
});
// Centre list for the sidebar, available to every authenticated view.
const metrics = require("./services/metrics");
const feedbackSvc = require("./services/feedback");
app.use((req, res, next) => {
  const all = metrics.centres();
  const scoped = res.locals.scopedOwnaId;
  res.locals.navCentres = scoped ? all.filter((c) => c.owna_id === scoped) : all;
  res.locals.fbNewCount = (res.locals.user && res.locals.user.role === "admin") ? feedbackSvc.newCount() : 0;
  next();
});
app.use("/admin", require("./routes/admin"));
app.use("/reports", require("./routes/reports"));
app.use("/", require("./routes/dashboard"));

app.use((req, res) => res.status(404).render("error", { message: "Page not found." }));
app.use((err, req, res, next) => {
  // Log the error type and where it happened — never the full object, which can carry request data.
  console.error("[error] request failed");
  res.status(500).render("error", { message: "Something went wrong." });
});

// Nightly snapshot. The zone is pinned here rather than inherited from the host's TZ, so the job
// fires at 2:15am in Sydney wherever this runs (render.yaml also sets TZ=Australia/Sydney).
const cronExpr = process.env.SNAPSHOT_CRON || "15 2 * * *";
const CRON_TZ = require("./services/calendar").TIME_ZONE;
if (require.main === module && cron.validate(cronExpr)) {
  cron.schedule(cronExpr, () => {
    console.log("[cron] nightly OWNA snapshot starting");
    // Through the same single-flight as the buttons: a manual refresh still running at 2:15am must not
    // have a second run started on top of it.
    const { started } = runSnapshotOnce();
    if (!started) console.log("[cron] a snapshot is already running — not starting a second");
  }, { timezone: CRON_TZ });
  console.log(`[cron] nightly snapshot scheduled: ${cronExpr} (${CRON_TZ})`);
} else if (require.main === module) {
  console.warn(`[cron] invalid SNAPSHOT_CRON "${cronExpr}" — nightly snapshot disabled`);
}

if (require.main === module) app.listen(PORT, () => console.log(`Futuro Pulse on http://localhost:${PORT}`));
module.exports = app;
