const db = require("../db/db");

// Roles:
//   viewer       read-only, all centres, AGGREGATES ONLY (no named children/families/staff) — the demo/trial role
//   centre       read-only, own centre only
//   exec         read-only, all centres, may see identified records
//   ops_manager  exec + can edit action plans / wage budgets / trigger refresh / generate AI briefings
//   admin        everything + user management
const SEE_ALL_ROLES = ["admin", "exec", "ops_manager", "viewer"];
const WRITE_ROLES = ["admin", "ops_manager"];

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  const current = db.prepare("SELECT id, email, name, role, location_id, password_hash FROM users WHERE id = ?").get(req.session.user.id);
  if (!current || ![...SEE_ALL_ROLES, "centre"].includes(current.role) ||
      (req.session.authVersion && req.session.authVersion !== current.password_hash)) {
    return req.session.destroy(() => res.redirect("/login"));
  }
  if (current.role === "centre" && (!current.location_id || !db.prepare("SELECT 1 FROM centres WHERE owna_id = ?").get(current.location_id))) {
    return res.status(403).render("error", { message: "Your account needs a valid centre assignment. Please contact an administrator." });
  }
  const { password_hash, ...user } = current;
  req.session.user = user;
  req.session.authVersion = password_hash;
  res.locals.user = user;
  res.locals.scopedOwnaId = scopedOwnaId(req); // null = all centres
  res.locals.canSeeIdentified = canSeeIdentified(req);
  next();
}

// May this login see named children, families or staff? The demo/trial 'viewer' role may not.
function canSeeIdentified(req) {
  const u = req.session && req.session.user;
  return !!u && ["admin", "exec", "ops_manager", "centre"].includes(u.role);
}
function requireIdentified(req, res, next) {
  if (!canSeeIdentified(req)) return res.status(403).render("error", { message: "This page shows named children and families. Your login sees aggregates only." });
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
  if (!req.session.user || !WRITE_ROLES.includes(req.session.user.role)) {
    return res.status(403).render("error", { message: "Admin access required." });
  }
  next();
}

// The owna_id a centre-scoped user is limited to, or null for see-all roles.
function scopedOwnaId(req) {
  const u = req.session && req.session.user;
  if (u && SEE_ALL_ROLES.includes(u.role)) return null;
  if (u && u.role === "centre" && u.location_id) return u.location_id;
  return "__DENIED_SCOPE__";
}

// Block centre users from group (all-centre) pages.
function blockScoped(req, res, next) {
  if (scopedOwnaId(req)) return res.status(403).render("error", { message: "This page shows all centres — your login is limited to your centre. Use Overview or your centre page." });
  next();
}

module.exports = { requireLogin, requireAdmin, requireAdminOrOps, requireIdentified, canSeeIdentified, scopedOwnaId, blockScoped, SEE_ALL_ROLES, WRITE_ROLES };
