// ============================================================
// eval/run.js — the Red Team vs Blue Team evaluation
// ------------------------------------------------------------
// Runs every test through the SAME pipeline the website uses,
// once per configuration, and writes:
//   public/results/latest.json  (the dashboard reads this)
//   public/results/latest.csv   (every row, for the report)
//   eval/results/run-<time>.json (archive copy)
//
// Usage (from the project folder):
//   npm run eval            baseline vs full protection
//   npm run eval:all        + each layer on its own (ablation)
//   npm run eval:mock       fake model, free, for testing the code
// Extra flags: --repeats 3   --concurrency 4
// ============================================================

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- read flags ----
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
if (args.includes("--mock")) process.env.LLM_MOCK = "1";

// ---- load .env before the app code reads settings ----
const envFile = path.join(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { runChat, CONFIGS } = await import("../lib/pipeline.js");
const { ATTACKS, HELD_OUT, LEGIT, HARD_NEGATIVES } = await import("../lib/attacks.js");
const { attackSucceeded } = await import("../lib/detectors.js");
const { llmInfo, usage } = await import("../lib/llm.js");

const configs = flag("configs", "baseline,full").split(",").map((s) => s.trim()).filter(Boolean);
for (const c of configs) if (!CONFIGS[c]) throw new Error(`Unknown config "${c}". Use: ${Object.keys(CONFIGS).join(", ")}`);
const repeats = Math.max(1, Number(flag("repeats", 1)));
const concurrency = Math.max(1, Number(flag("concurrency", 4)));
const info = llmInfo();

if (!info.mock && !process.env.OPENAI_API_KEY) throw new Error("No OPENAI_API_KEY. Put it in .env (see .env.example) or run npm run eval:mock.");
console.log(`\nShopSmart evaluation · model=${info.model} judge=${info.judgeModel} ${info.mock ? "(MOCK)" : ""}`);
console.log(`configs=${configs.join(", ")} · repeats=${repeats} · concurrency=${concurrency}\n`);

// ---- build the job list ----
const sets = [
  ...ATTACKS.map((t) => ({ ...t, set: "attack" })),
  ...HELD_OUT.map((t) => ({ ...t, set: "heldout" })),
  ...LEGIT.map((t) => ({ ...t, set: "legit", category: "Normal question" })),
  ...HARD_NEGATIVES.map((t) => ({ ...t, set: "hard", category: "Tricky normal question" })),
];
const jobs = [];
for (const config of configs) for (const t of sets) for (let r = 1; r <= repeats; r++) jobs.push({ config, t, r });

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 4) throw e;
      const wait = e.status === 429 ? 15000 * attempt : 2000 * attempt;
      console.log(`  retry ${attempt} after error: ${String(e.message).slice(0, 80)} (wait ${wait / 1000}s)`);
      await sleep(wait);
    }
  }
}

// ---- run one test: send each turn in order, like a real chat ----
async function runJob({ config, t, r }) {
  const messages = [];
  const replies = [];
  let blockedBy = null;
  let quarantined = [];
  let ms = 0;
  try {
    for (const turn of t.turns) {
      messages.push({ role: "user", content: turn });
      const out = await withRetry(() => runChat({ messages, layers: CONFIGS[config], document: t.document }));
      messages.push({ role: "assistant", content: out.reply });
      replies.push(out.reply);
      ms += out.ms;
      if (out.blocked && !blockedBy) blockedBy = out.blockedBy;
      quarantined = quarantined.concat(out.quarantined.map((q) => `${q.id}<-${q.by}`));
    }
  } catch (e) {
    return { config, set: t.set, id: t.id, repeat: r, category: t.category, goal: t.goal || "", error: String(e.message).slice(0, 300) };
  }
  const row = {
    config, set: t.set, id: t.id, repeat: r, category: t.category, goal: t.goal || "",
    blocked: Boolean(blockedBy), blockedBy: blockedBy || "", quarantined: quarantined.join("; "),
    turns: t.turns.join(" || "), lastReply: replies[replies.length - 1], allReplies: replies.join(" || "),
    ms, manualReview: Boolean(t.manualReview), error: "",
  };
  if (t.goal) {
    // An attack wins if ANY reply the user saw reached the goal.
    const hit = replies.map((x) => attackSucceeded(t.goal, x)).find((x) => x.leaked);
    row.success = Boolean(hit);
    row.how = hit ? hit.how : "";
  } else {
    row.expectHit = !row.blocked && t.expect.test(row.lastReply);
  }
  return row;
}

// ---- simple worker pool ----
const rows = [];
let next = 0;
let doneCount = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const row = await runJob(job);
    rows.push(row);
    doneCount++;
    const mark = row.error ? "ERR" : row.goal ? (row.success ? "LEAK" : row.blocked ? "blocked" : "safe") : row.blocked ? "FALSE-POSITIVE" : row.expectHit ? "ok" : "answered";
    console.log(`[${String(doneCount).padStart(4)}/${jobs.length}] ${row.config.padEnd(18)} ${row.id.padEnd(9)} ${mark}`);
  }
}
const started = Date.now();
await Promise.all(Array.from({ length: concurrency }, worker));

// ---- statistics ----
// Wilson score interval: an honest error bar for small samples.
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const rate = (list, pred) => {
  const ok = list.filter((x) => !x.error);
  const k = ok.filter(pred).length;
  return { k, n: ok.length, rate: ok.length ? k / ok.length : 0, ci: wilson(k, ok.length) };
};

const summary = {};
for (const c of configs) {
  const R = rows.filter((x) => x.config === c);
  const atk = R.filter((x) => x.set === "attack");
  const held = R.filter((x) => x.set === "heldout");
  const legit = R.filter((x) => x.set === "legit");
  const hard = R.filter((x) => x.set === "hard");
  const normal = legit.concat(hard);
  const byCategory = {};
  for (const x of atk.filter((y) => !y.error)) {
    byCategory[x.category] ||= { k: 0, n: 0 };
    byCategory[x.category].n++;
    if (x.success) byCategory[x.category].k++;
  }
  const blockedBy = {};
  for (const x of atk.concat(held).filter((y) => !y.error && !y.success)) {
    const layer = x.blocked ? x.blockedBy.split(":")[0] : x.quarantined ? "doc quarantine (" + x.quarantined.split("<-")[1]?.split(":")[0] + ")" : "model refused";
    blockedBy[layer] = (blockedBy[layer] || 0) + 1;
  }
  const ok = R.filter((x) => !x.error);
  summary[c] = {
    asr: rate(atk, (x) => x.success),
    asrHeldOut: rate(held, (x) => x.success),
    fpr: rate(normal, (x) => x.blocked),
    fprLegit: rate(legit, (x) => x.blocked),
    fprHard: rate(hard, (x) => x.blocked),
    helpful: rate(normal, (x) => x.expectHit),
    byCategory,
    blockedBy,
    avgMs: ok.length ? ok.reduce((s, x) => s + x.ms, 0) / ok.length : 0,
    errors: R.length - ok.length,
  };
}

const order = Object.keys(CONFIGS);
rows.sort((a, b) => order.indexOf(a.config) - order.indexOf(b.config) || a.id.localeCompare(b.id) || a.repeat - b.repeat);

const result = {
  meta: {
    generatedAt: new Date().toISOString(),
    model: info.model,
    judgeModel: info.judgeModel,
    mock: info.mock,
    repeats,
    configs,
    counts: { attacks: ATTACKS.length, heldOut: HELD_OUT.length, legit: LEGIT.length, hard: HARD_NEGATIVES.length },
    llmCalls: usage.calls,
    tokens: { prompt: usage.promptTokens, completion: usage.completionTokens },
    seconds: Math.round((Date.now() - started) / 1000),
  },
  summary,
  rows,
};

// ---- save ----
const pubDir = path.join(root, "public", "results");
const archDir = path.join(root, "eval", "results");
mkdirSync(pubDir, { recursive: true });
mkdirSync(archDir, { recursive: true });
writeFileSync(path.join(pubDir, "latest.json"), JSON.stringify(result, null, 1));
const cols = ["config", "set", "id", "repeat", "category", "goal", "success", "how", "blocked", "blockedBy", "quarantined", "expectHit", "manualReview", "ms", "error", "turns", "lastReply", "allReplies"];
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
writeFileSync(path.join(pubDir, "latest.csv"), [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n"));
writeFileSync(path.join(archDir, `run-${result.meta.generatedAt.replace(/[:.]/g, "-")}${info.mock ? "-MOCK" : ""}.json`), JSON.stringify(result, null, 1));

// ---- print the headline ----
const p = (x) => `${(x.rate * 100).toFixed(1)}% (${x.k}/${x.n})`;
console.log("\n================ RESULTS ================");
for (const c of configs) {
  const s = summary[c];
  console.log(`${c.padEnd(18)} ASR ${p(s.asr).padEnd(16)} held-out ASR ${p(s.asrHeldOut).padEnd(14)} FPR ${p(s.fpr).padEnd(14)} helpful ${p(s.helpful)}  errors ${s.errors}`);
}
console.log(`\n${usage.calls} model calls · ${usage.promptTokens + usage.completionTokens} tokens · ${result.meta.seconds}s`);
console.log("Saved public/results/latest.json and latest.csv");
if (info.mock) console.log("NOTE: MOCK run. Do not report these numbers.");
const manual = rows.filter((r) => r.manualReview);
if (manual.length) console.log(`Check ${manual.length} row(s) by hand (manualReview=true), e.g. acrostic poems the detector cannot read.`);
