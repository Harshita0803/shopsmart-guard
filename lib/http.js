// Small helpers shared by the API routes (works on Vercel and in dev-server.js).

export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body; // Vercel already parsed it
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64_000) throw new Error("Request too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// Best-effort rate limit, kept in memory. On Vercel each server
// instance has its own memory, so this is a speed bump, not a wall.
// The real money guard is the monthly budget limit on the OpenAI
// project (see README).
const hits = new Map();
export function rateLimited(ip, limit = Number(process.env.RATE_LIMIT_PER_MIN || 20)) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > limit;
}

export function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}
