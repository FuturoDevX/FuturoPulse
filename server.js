require("dotenv").config();
const path = require("path");
const express = require("express");
const cron = require("node-cron");

const { requireLogin } = require("./middleware/auth");
const { sessionMiddleware } = require("./middleware/session");
const { runSnapshot, errSummary } = require("./services/snapshot");

const app = express();
const PORT = process.env.PORT || 3002;
const isProd = process.env.NODE_ENV === "production";

if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.includes("change-me"))) {
  console.error("Refusing to start in production without a real SESSION_SECRET.");
  process.exit(1);
}

app.locals.privacyContact = process.env.PRIVACY_CONTACT || "the Privacy Officer";
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "256kb" })); // for the "Ask your data" fetch API
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

// Public
app.use("/", require("./routes/auth"));

// Everything below requires a login
app.use(requireLogin);
app.use((req,res,next) => {
  res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "no-referrer");
  res.set("X-Content-Type-Options", "nosniff"); res.set("X-Frame-Options", "DENY");
  if (!["GET","HEAD","OPTIONS"].includes(req.method) && req.headers.origin) {
    let host; try { host = new URL(req.headers.origin).host; } catch { return res.sendStatus(403); }
    if (host !== req.get("host")) return res.sendStatus(403);
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
    runSnapshot().catch((e) => console.error("[cron] snapshot failed:", errSummary(e)));
  }, { timezone: CRON_TZ });
  console.log(`[cron] nightly snapshot scheduled: ${cronExpr} (${CRON_TZ})`);
} else if (require.main === module) {
  console.warn(`[cron] invalid SNAPSHOT_CRON "${cronExpr}" — nightly snapshot disabled`);
}

if (require.main === module) app.listen(PORT, () => console.log(`Futuro Pulse on http://localhost:${PORT}`));
module.exports = app;
