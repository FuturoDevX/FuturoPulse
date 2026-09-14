// The form payload OWNA returns is untyped, so the survey script has to cope with any of the three
// shapes it could plausibly be. These check the parser handles each without reaching the network.
const test = require("node:test");
const assert = require("node:assert");
const { flatten, tally, hint } = require("../scripts/discover-forms");

const paths = (payload, key = "values") => { const out = []; flatten(payload, key, out); return out; };

test("shape A: values is a JSON string of a flat object", () => {
  const got = paths(JSON.stringify({ nappyChanged: "yes", sleepStart: "2026-09-01T12:30:00", temp: 36.8 }));
  const map = Object.fromEntries(got);
  assert.strictEqual(map["values.nappyChanged"], "boolean-string");
  assert.strictEqual(map["values.sleepStart"], "date");
  assert.strictEqual(map["values.temp"], "number");
});

test("shape B: an array of question/answer pairs keys on the question, not the index", () => {
  const got = paths(JSON.stringify([
    { question: "Was the cot checked?", answer: "Yes" },
    { question: "Room temperature", answer: "22" },
  ]));
  const fields = got.map(([f]) => f);
  assert.ok(fields.includes("values[Was the cot checked?]"), fields.join(","));
  assert.ok(fields.includes("values[Room temperature]"));
});

test("shape C: a nested object flattens to dotted paths", () => {
  const got = paths({ section: { hazard: "none", signedBy: "staff" } });
  const fields = got.map(([f]) => f);
  assert.ok(fields.includes("values.section.hazard"));
  assert.ok(fields.includes("values.section.signedBy"));
});

test("a payload that is not JSON is still described, not thrown away", () => {
  const got = paths("free text note");
  assert.strictEqual(got[0][1], "text len=14");
});

test("no answer value ever appears in the output", () => {
  const secret = "Child ate 3 grapes and vomited";
  const out = paths(JSON.stringify({ note: secret })).flat().join(" ");
  assert.ok(!out.includes(secret), "a value leaked into the shape report");
  assert.ok(!out.includes("grapes"));
});

test("fill rate counts only rows where the field is answered", () => {
  const store = new Map();
  tally(store, [
    { values: JSON.stringify({ a: "yes", b: "" }) },
    { values: JSON.stringify({ a: "no" }) },
  ], ["values"]);
  assert.strictEqual(store.get("values.a").filled, 2);
  assert.strictEqual(store.get("values.b").filled, 0);
});

test("signatures and images are flagged rather than dumped", () => {
  assert.match(hint("data:image/png;base64,iVBORw0KGgoAAAANS"), /^url\/dataurl/);
});
