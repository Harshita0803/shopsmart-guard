// GET /api/library — the test sets, so the Attack Lab can show them.
// Safe to expose: it contains attack TEXT, not the secret.

import { ATTACKS, HELD_OUT, LEGIT, HARD_NEGATIVES } from "../lib/attacks.js";
import { CONFIGS } from "../lib/pipeline.js";
import { llmInfo } from "../lib/llm.js";
import { sendJson } from "../lib/http.js";

const plain = (list) => list.map((x) => ({ ...x, expect: x.expect ? String(x.expect) : undefined }));

export default function handler(req, res) {
  sendJson(res, 200, {
    attacks: plain(ATTACKS),
    heldOut: plain(HELD_OUT),
    legit: plain(LEGIT),
    hardNegatives: plain(HARD_NEGATIVES),
    configs: CONFIGS,
    model: llmInfo(),
    passcodeRequired: Boolean(process.env.DEMO_PASSCODE),
  });
}
