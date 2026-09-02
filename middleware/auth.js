const db = require("../db/db");

// Roles: admin (full + user mgmt + refresh), exec (see all, read-only), centre (own centre only).
// Legacy 'ops_manager'/'viewer' are treated as see-all.
const SEE_ALL_ROLES = ["admin", "exec", "ops_manager", "viewer"];

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  res.locals.user = req.session.user;
  res.locals.scopedOwnaId = scopedOwnaId(req); // null = all centres
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).render("error", { message: "Admin access required." });
  }
  next();
}

// Admin or Ops can trigger refreshes; kept for the refresh button.
function requireAdminOrOps(req, res, next) {
  if (!req.session.user || !["admin", "ops_manager", "exec"].includes(req.session.user.role)) {
    return res.status(403).render("error", { message: "Admin access required." });
  }
  next();
}

// The owna_id a centre-scoped user is limited to, or null for see-all roles.
function scopedOwnaId(req) {
  const u = req.session && req.session.user;
  if (!u) return null;
  if (u.role === "centre" && u.location_id) return u.location_id;
  return null;
}

// Block centre users from group (all-centre) pages.
function blockScoped(req, res, next) {
  if (scopedOwnaId(req)) return res.status(403).render("error", { message: "This page shows all centres — your login is limited to your centre. Use Overview or your centre page." });
  next();
}

module.exports = { requireLogin, requireAdmin, requireAdminOrOps, scopedOwnaId, blockScoped, SEE_ALL_ROLES };
