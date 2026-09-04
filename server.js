require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");
const cron = require("node-cron");

const { requireLogin } = require("./middleware/auth");
const { runSnapshot } = require("./services/snapshot");

const app = express();
const PORT = process.env.PORT || 3002;
const isProd = process.env.NODE_ENV === "production";

if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.includes("change-me"))) {
  console.error("Refusing to start in production without a real SESSION_SECRET.");
  process.exit(1);
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "256kb" })); // for the "Ask your data" fetch API
app.use(express.static(path.join(__dirname, "public")));

if (isProd) app.set("trust proxy", 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: isProd, maxAge: 1000 * 60 * 60 * 8 },
}));

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
  console.error(err);
  res.status(500).render("error", { message: "Something went wrong." });
});

// Nightly snapshot.
const cronExpr = process.env.SNAPSHOT_CRON || "15 2 * * *";
if (cron.validate(cronExpr)) {
  cron.schedule(cronExpr, () => {
    console.log("[cron] nightly OWNA snapshot starting");
    runSnapshot().catch((e) => console.error("[cron] snapshot failed:", e.message));
  });
  console.log(`[cron] nightly snapshot scheduled: ${cronExpr}`);
} else {
  console.warn(`[cron] invalid SNAPSHOT_CRON "${cronExpr}" — nightly snapshot disabled`);
}

app.listen(PORT, () => console.log(`Futuro Pulse on http://localhost:${PORT}`));
