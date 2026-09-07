// Thin Claude API client. Calls the Anthropic Messages API directly over fetch (Node 18+),
// so there's no extra dependency and it runs unchanged on Render.
//
// Config (environment):
//   ANTHROPIC_API_KEY   required to enable any AI feature (server-side only — never expose it)
//   AI_MODEL            optional model override (default: claude-sonnet-5)
//   AI_TIMEOUT_MS       optional per-request timeout (default 45000)
const MODEL = process.env.AI_MODEL || "claude-sonnet-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS, 10) || 45000;

function isEnabled() { return !!process.env.ANTHROPIC_API_KEY; }

// One raw call to the Messages API. Returns the full response body.
async function call(body) {
  if (!isEnabled()) throw new Error("ANTHROPIC_API_KEY is not set — add it to the environment to enable AI features.");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`The AI request timed out after ${Math.round(TIMEOUT_MS / 1000)}s. Please try again.`);
    throw new Error("Could not reach the Claude API: " + e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    let msg = t.slice(0, 300);
    try { const j = JSON.parse(t); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
    throw new Error(`Claude API ${res.status}: ${msg}`);
  }
  return res.json();
}

const textOf = (data) => (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();

// Completion. Pass `user` (a string, single-turn) or `messages` (an array of {role,content}
// for multi-turn). Returns Claude's text.
async function complete({ system, user, messages, maxTokens = 1024, model = MODEL, temperature }) {
  const msgs = messages && messages.length ? messages : [{ role: "user", content: user }];
  const body = { model, max_tokens: maxTokens, messages: msgs };
  if (system) body.system = system;
  if (temperature != null) body.temperature = temperature;
  return textOf(await call(body));
}

// Agentic tool loop: Claude may call tools; `runTool(name, input)` executes them and we feed
// the results back until it produces a final answer. Bounded by maxRounds.
// Returns { text, toolCalls: [{name, input}] } so callers can show their work.
async function completeWithTools({ system, messages, tools, runTool, maxTokens = 1200, model = MODEL, maxRounds = 6 }) {
  const convo = messages.slice();
  const toolCalls = [];
  for (let round = 0; round < maxRounds; round++) {
    const body = { model, max_tokens: maxTokens, messages: convo, tools };
    if (system) body.system = system;
    const data = await call(body);

    if (data.stop_reason !== "tool_use") {
      return { text: textOf(data), toolCalls };
    }
    // Record the assistant turn verbatim (tool_use blocks must be echoed back).
    convo.push({ role: "assistant", content: data.content });
    const results = [];
    for (const block of data.content) {
      if (block.type !== "tool_use") continue;
      toolCalls.push({ name: block.name, input: block.input });
      let out;
      try { out = await runTool(block.name, block.input); }
      catch (e) { out = { error: String(e.message || e) }; }
      results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out).slice(0, 30000) });
    }
    convo.push({ role: "user", content: results });
  }
  // Ran out of rounds — ask for a final answer with no further tools.
  const finalData = await call({ model, max_tokens: maxTokens, system, messages: convo.concat([{ role: "user", content: "Answer now using what you have gathered; do not request more data." }]) });
  return { text: textOf(finalData), toolCalls };
}

module.exports = { isEnabled, complete, completeWithTools, MODEL, TIMEOUT_MS };
