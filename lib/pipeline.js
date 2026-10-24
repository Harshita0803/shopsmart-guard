// ============================================================
// pipeline.js — one message, start to finish
// ------------------------------------------------------------
// The SAME function runs:
//   - the live website (api/chat.js)
//   - the Attack Lab (side-by-side baseline vs protected)
//   - the evaluation script (eval/run.js)
// So the numbers in the report come from the exact code
// people can try on the website.
//
// Order of steps:
//   1. retrieve product pages (and add an uploaded document)
//   2. Layer 1: input filter  (user message + untrusted docs)
//   3. Layer 2: LLM judge     (user message + untrusted docs)
//   4. Layer 3: build prompt  (privilege separation on/off)
//   5. call the model
//   6. Layer 4: output filter
//   7. record findings for the dashboard
// ============================================================

import { retrieve } from "./store.js";
import { chat } from "./llm.js";
import { baselinePrompt, protectedPrompt, SAFE_REFUSAL } from "./prompts.js";
import { inputFilter, llmJudge, outputFilter } from "./defenses.js";
import { scanReply } from "./detectors.js";

// Named configurations. "baseline" and "full" are the main
// before/after comparison. The single-layer ones show what
// each layer does on its own (an "ablation study").
export const CONFIGS = {
  baseline: { privilegeSeparation: false, inputFilter: false, judge: false, outputFilter: false },
  privsep_only: { privilegeSeparation: true, inputFilter: false, judge: false, outputFilter: false },
  input_filter_only: { privilegeSeparation: false, inputFilter: true, judge: false, outputFilter: false },
  judge_only: { privilegeSeparation: false, inputFilter: false, judge: true, outputFilter: false },
  output_filter_only: { privilegeSeparation: false, inputFilter: false, judge: false, outputFilter: true },
  full: { privilegeSeparation: true, inputFilter: true, judge: true, outputFilter: true },
};

export const MAX_MESSAGE = 1500;
export const MAX_DOC = 4000;
export const MAX_TURNS = 10;

/**
 * @param {object} o
 * @param {Array}  o.messages  chat history, last item = new user message
 * @param {object} o.layers    which defenses are on (see CONFIGS)
 * @param {string} o.document  optional uploaded document text
 */
export async function runChat({ messages, layers, document }) {
  const t0 = Date.now();
  const L = { ...CONFIGS.baseline, ...(layers || {}) };
  const history = (messages || []).slice(-MAX_TURNS);
  const last = history[history.length - 1];
  if (!last || last.role !== "user") throw new Error("Last message must be from the user.");
  const userText = String(last.content).slice(0, MAX_MESSAGE);
  const trace = [];
  const done = (reply, blockedBy) => ({
    reply,
    blocked: Boolean(blockedBy),
    blockedBy: blockedBy || null,
    trace,
    retrieved: retrievedIds,
    quarantined,
    findings: scanReply(reply),
    layers: L,
    ms: Date.now() - t0,
  });

  // ---- 1. Retrieval ----
  let docs = retrieve(userText);
  if (document && String(document).trim()) {
    docs.push({ id: "uploaded-document", title: "Customer uploaded document", trust: "uploaded", text: String(document).slice(0, MAX_DOC) });
  }
  const quarantined = [];
  const retrievedIds = docs.map((d) => d.id);
  trace.push({ step: "retrieval", detail: docs.length ? docs.map((d) => `${d.id} (${d.trust})`).join(", ") : "no documents matched" });
  const untrusted = () => docs.filter((d) => d.trust !== "internal");

  // ---- 2. Layer 1: input filter ----
  if (L.inputFilter) {
    const r = inputFilter(userText);
    trace.push({ step: "input_filter", result: r.flagged ? "BLOCK" : "pass", detail: r.rule || "no rule matched" });
    if (r.flagged) return done(SAFE_REFUSAL, `input_filter:${r.rule}`);
    for (const d of untrusted()) {
      const rd = inputFilter(d.text);
      if (rd.flagged) {
        quarantined.push({ id: d.id, by: `input_filter:${rd.rule}` });
        trace.push({ step: "input_filter", result: "QUARANTINE DOC", detail: `${d.id} (${rd.rule})` });
      }
    }
    docs = docs.filter((d) => !quarantined.some((q) => q.id === d.id));
  } else trace.push({ step: "input_filter", result: "off" });

  // ---- 3. Layer 2: LLM judge ----
  if (L.judge) {
    // The judge sees earlier user turns too, so slow multi-turn
    // attacks are visible as a whole.
    const earlier = history.filter((m) => m.role === "user").slice(-3, -1).map((m) => m.content);
    const text = earlier.length ? `Earlier customer messages:\n${earlier.join("\n")}\n\nLatest customer message:\n${userText}` : userText;
    let j;
    try {
      j = await llmJudge(text, "customer message");
    } catch (e) {
      trace.push({ step: "llm_judge", result: "BLOCK", detail: "judge unavailable, failing closed" });
      return done(SAFE_REFUSAL, "llm_judge:error");
    }
    trace.push({ step: "llm_judge", result: j.verdict === "BLOCK" ? "BLOCK" : "pass", detail: j.reason });
    if (j.verdict === "BLOCK") return done(SAFE_REFUSAL, "llm_judge");
    for (const d of untrusted()) {
      let jd;
      try {
        jd = await llmJudge(d.text, "document retrieved for the chatbot");
      } catch {
        jd = { verdict: "BLOCK", reason: "judge error" };
      }
      if (jd.verdict === "BLOCK") {
        quarantined.push({ id: d.id, by: "llm_judge" });
        trace.push({ step: "llm_judge", result: "QUARANTINE DOC", detail: `${d.id}: ${jd.reason}` });
      }
    }
    docs = docs.filter((d) => !quarantined.some((q) => q.id === d.id));
  } else trace.push({ step: "llm_judge", result: "off" });

  // ---- 4. Layer 3: privilege separation ----
  const system = L.privilegeSeparation ? protectedPrompt(docs) : baselinePrompt(docs);
  trace.push({
    step: "privilege_separation",
    result: L.privilegeSeparation ? "on" : "off",
    detail: L.privilegeSeparation ? "secret NOT in prompt; documents wrapped as untrusted data" : "secret IS in prompt; documents pasted as instructions",
  });

  // ---- 5. Model call ----
  const modelMessages = history.slice(0, -1).map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_MESSAGE) }));
  modelMessages.push({ role: "user", content: userText });
  const reply = await chat({ system, messages: modelMessages, maxTokens: 300, temperature: 0.3 });
  trace.push({ step: "model", result: "answered", detail: `${reply.length} characters` });

  // ---- 6. Layer 4: output filter ----
  if (L.outputFilter) {
    const o = outputFilter(reply);
    trace.push({ step: "output_filter", result: o.flagged ? "BLOCK" : "pass", detail: o.flagged ? o.findings.map((f) => `${f.type}(${f.how})`).join(", ") : "reply looks clean" });
    if (o.flagged) return done(SAFE_REFUSAL, `output_filter:${o.findings[0].type}`);
  } else trace.push({ step: "output_filter", result: "off" });

  return done(reply, null);
}
