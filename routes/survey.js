// The magic link. PUBLIC — mounted in server.js BEFORE requireLogin, because a survey respondent is an
// educator on their own phone, not a dashboard user: making them sign in would both defeat the point and
// destroy the anonymity, since the app would then know exactly who was answering.
//
// Everything the page can tell a visitor is deliberately the same for a token that never existed, a token
// already spent and a round that has closed: one friendly page, no hint about which. Otherwise the route
// is an oracle for guessing tokens and for finding out who has already answered.
const express = require("express");
const survey = require("../services/survey");
const cal = require("../services/calendar");
const router = express.Router();

// ---- Rate limit ------------------------------------------------------------------------------------
// A public route that takes a secret in the URL is a guessing target, and a public route that writes to
// the database is a flooding target. A fixed window per client address covers both; it is in memory,
// which is right for one process and is not a security boundary on its own — the token itself is 32
// random bytes, and this only stops the volume.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_GETS = Number(process.env.SURVEY_RATE_GETS || 40);
const MAX_POSTS = Number(process.env.SURVEY_RATE_POSTS || 10);
const hits = new Map(); // ip -> { until, get, post }
function overLimit(req, kind) {
  const now = Date.now();
  // Sweep rather than let one entry per address accumulate for the life of the process.
  if (hits.size > 5000) for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
  const ip = req.ip || "unknown";
  let h = hits.get(ip);
  if (!h || h.until <= now) { h = { until: now + WINDOW_MS, get: 0, post: 0 }; hits.set(ip, h); }
  h[kind] += 1;
  return kind === "post" ? h.post > MAX_POSTS : h.get > MAX_GETS;
}
function resetRateLimit() { hits.clear(); }

// A survey page must never be cached — a shared or centre iPad would otherwise show the next person the
// last person's answers — and must not be indexable or framed.
function surveyHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.set("Referrer-Policy", "no-referrer"); // the token is IN the URL: it must not travel to any other site
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
}

// The one unusable outcome. Plain, friendly, no error, and identical whatever the real reason was.
function closedPage(res, status = 200) {
  surveyHeaders(res);
  return res.status(status).render("survey-closed", { title: "Futuro staff survey", privacyContact: res.app.locals.privacyContact });
}

router.get("/s/:token", (req, res) => {
  if (overLimit(req, "get")) return closedPage(res, 429);
  const st = survey.tokenState(req.params.token, cal.today());
  if (st.state !== "open") return closedPage(res);
  surveyHeaders(res);
  res.render("survey", {
    title: "Futuro staff survey",
    token: req.params.token, label: st.label, questions: st.questions,
    closesOn: st.round.closes_on, closesLabel: survey.friendlyDate(st.round.closes_on),
    err: null,
    privacyContact: res.app.locals.privacyContact,
  });
});

router.post("/s/:token", (req, res) => {
  if (overLimit(req, "post")) return closedPage(res, 429);
  const out = survey.submit(req.params.token, req.body, cal.today());
  if (out.ok) {
    surveyHeaders(res);
    return res.render("survey-thanks", { title: "Thank you", privacyContact: res.app.locals.privacyContact });
  }
  // A missing or out-of-range score is the only thing worth re-asking for: it is the one required
  // question, and re-rendering keeps what they already typed.
  if (out.reason === "score") {
    surveyHeaders(res);
    const st = survey.tokenState(req.params.token, cal.today());
    if (st.state !== "open") return closedPage(res); // it closed between the two reads
    return res.status(400).render("survey", {
      title: "Futuro staff survey",
      token: req.params.token, label: out.label, questions: out.questions,
      closesOn: st.round.closes_on, closesLabel: survey.friendlyDate(st.round.closes_on),
      err: "Please choose a number from 0 to 10 for the first question.",
      answers: { reason: req.body && req.body.reason, other: req.body && req.body.other },
      privacyContact: res.app.locals.privacyContact,
    });
  }
  return closedPage(res);
});

module.exports = router;
module.exports.resetRateLimit = resetRateLimit;
