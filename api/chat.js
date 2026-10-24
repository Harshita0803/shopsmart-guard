// POST /api/chat — the website's only route that calls the model.
// Body: { messages:[{role,content}], mode:"baseline"|"protected"|"custom", layers?, document?, passcode? }

import { runChat, CONFIGS, MAX_MESSAGE, MAX_DOC, MAX_TURNS } from "../lib/pipeline.js";
import { llmInfo } from "../lib/llm.js";
import { sendJson, readJson, rateLimited, clientIp } from "../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });

  // Optional class passcode, so random visitors cannot spend the API budget.
  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON." });
  }
  if (process.env.DEMO_PASSCODE && body.passcode !== process.env.DEMO_PASSCODE) {
    return sendJson(res, 401, { error: "Passcode required. Ask the team for the demo passcode." });
  }
  if (rateLimited(clientIp(req))) return sendJson(res, 429, { error: "Too many messages. Wait a minute and try again." });

  // Validate input. Never trust the browser.
  const messages = Array.isArray(body.messages) ? body.messages.slice(-MAX_TURNS) : [];
  const clean = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE) }));
  if (!clean.length || clean[clean.length - 1].role !== "user" || !clean[clean.length - 1].content.trim()) {
    return sendJson(res, 400, { error: "Send at least one user message." });
  }
  const document = typeof body.document === "string" ? body.document.slice(0, MAX_DOC) : "";

  let layers;
  if (body.mode === "baseline") layers = CONFIGS.baseline;
  else if (body.mode === "custom" && body.layers && typeof body.layers === "object") {
    layers = Object.fromEntries(Object.keys(CONFIGS.full).map((k) => [k, Boolean(body.layers[k])]));
  } else layers = CONFIGS.full;

  try {
    const result = await runChat({ messages: clean, layers, document });
    return sendJson(res, 200, { ...result, model: llmInfo() });
  } catch (e) {
    console.error("chat failed:", e);
    return sendJson(res, 502, { error: "The AI service did not answer. Try again in a moment." });
  }
}
