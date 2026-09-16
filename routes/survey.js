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
// the database is a flooding target. In memory, which is right for one process, and not a security
// boundary on its own — the token itself is 32 random bytes, and this only stops the volume.
//
// The bucket that matters is the TOKEN, not the address. An address is shared: a whole centre answers on
// the centre's one wifi, and behind the proxy chain several centres can look like one client. One token
// is one respondent, so a handful of attempts each is the real limit. The address bucket is kept only as
// a wide flood cap, wide enough that the largest centre answering in one staff meeting never reaches it.
const WINDOW_MS = 10 * 60 * 1000;
const maxGets = () => Number(process.env.SURVEY_RATE_GETS || 300);
const maxPosts = () => Number(process.env.SURVEY_RATE_POSTS || 300);
const maxTokenPosts = () => Number(process.env.SURVEY_RATE_TOKEN_POSTS || 5);

// `trust proxy 1` strips one hop, and the one hop Render appends is Cloudflare's edge — so req.ip alone
// is the CDN, never the respondent, and every centre lands in a handful of buckets. Cloudflare puts the
// real client address in cf-connecting-ip. A client reaching Render directly could of course write that
// header itself, but all that buys is a fresh share of a deliberately wide flood cap — what protects a
// respondent's own link is the per-token cap, which no header can move.
function clientAddr(req) {
  const cf = String((req.headers && req.headers["cf-connecting-ip"]) || "").split(",")[0].trim();
  return cf || req.ip || "unknown";
}

const hits = new Map(); // "ip:<addr>" | "tok:<token>" -> { until, get, post }
function bump(key, kind, now) {
  let h = hits.get(key);
  if (!h || h.until <= now) { h = { until: now + WINDOW_MS, get: 0, post: 0 }; hits.set(key, h); }
  h[kind] += 1;
  return h[kind];
}
function overLimit(req, kind, token) {
  const now = Date.now();
  // Sweep rather than let one entry per address accumulate for the life of the process.
  if (hits.size > 5000) for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
  const n = bump("ip:" + clientAddr(req), kind, now);
  const flooding = kind === "post" ? n > maxPosts() : n > maxGets();
  if (kind !== "post") return flooding;
  return bump("tok:" + String(token || ""), "post", now) > maxTokenPosts() || flooding;
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

// Being throttled is NOT one of those reasons, and must not wear that page: the token is still unspent,
// and someone told their link is dead will not come back. Its own page, and Retry-After. This leaks
// nothing extra — the 429 already tells the outside world the throttle apart from the closed page.
function busyPage(res) {
  surveyHeaders(res);
  res.set("Retry-After", String(Math.ceil(WINDOW_MS / 1000)));
  return res.status(429).render("survey-busy", { title: "Futuro staff survey", privacyContact: res.app.locals.privacyContact });
}

router.get("/s/:token", (req, res) => {
  if (overLimit(req, "get", req.params.token)) return busyPage(res);
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
  if (overLimit(req, "post", req.params.token)) return busyPage(res);
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
