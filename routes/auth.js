const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db/db");
const router = express.Router();

router.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("login", { error: null });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get((email || "").trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).render("login", { error: "Invalid email or password." });
  }
  req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role, location_id: user.location_id };
  res.redirect("/");
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;
