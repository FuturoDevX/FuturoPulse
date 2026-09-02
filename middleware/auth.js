function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  res.locals.user = req.session.user; // available in every view
  next();
}

// Admin and Ops Manager can trigger refreshes and manage users; viewers are read-only.
function requireAdminOrOps(req, res, next) {
  if (!req.session.user || !["admin", "ops_manager"].includes(req.session.user.role)) {
    return res.status(403).render("error", { message: "Admin or Ops Manager access required." });
  }
  next();
}

module.exports = { requireLogin, requireAdminOrOps };
