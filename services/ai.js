// Thin Claude API client. Calls the Anthropic Messages API directly over fetch (Node 18+),
// so there's no extra dependency and it runs unchanged on Render.
//
// Config (environment):
//   ANTHROPIC_API_KEY   required to enable any AI feature (server-side only — never expose it)
//   AI_MODEL            optional model override (default: claude-sonnet-5)
const MODEL = process.env.AI_MODEL || "claude-sonnet-5";
const API_URL = "https://api.anthropic.com/v1/messages";

function isEnabled() { return !!process.env.ANTHROPIC_API_KEY; }

// Completion. Pass `user` (a string, single-turn) or `messages` (an array of {role,content}
// for multi-turn). Returns Claude's text. Throws with a readable message on failure.
async function complete({ system, user, messages, maxTokens = 1024, model = MODEL, temperature }) {
  if (!isEnabled()) throw new Error("ANTHROPIC_API_KEY is not set — add it to the environment to enable AI features.");
  const msgs = messages && messages.length ? messages : [{ role: "user", content: user }];
  const body = { model, max_tokens: maxTokens, messages: msgs };
  if (system) body.system = system;
  if (temperature != null) body.temperature = temperature;

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
    });
  } catch (e) {
    throw new Error("Could not reach the Claude API: " + e.message);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Claude API returned ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

module.exports = { isEnabled, complete, MODEL };
