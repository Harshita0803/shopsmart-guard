// Local server for VS Code: `npm run dev`, then open http://localhost:3000
// It serves /public and routes /api/* to the same files Vercel uses.
// No packages needed.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// Load .env (OPENAI_API_KEY etc.) without extra packages.
if (existsSync(path.join(root, ".env"))) {
  for (const line of readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".csv": "text/csv" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5).replace(/[^a-z0-9_-]/gi, "");
      const file = path.join(root, "api", `${name}.js`);
      if (!existsSync(file)) return res.writeHead(404).end("Not found");
      const mod = await import(pathToFileURL(file).href);
      return mod.default(req, res);
    }
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    if (!p || p.endsWith("/")) p += "index.html";
    const file = path.join(root, "public", p);
    if (!file.startsWith(path.join(root, "public")) || !existsSync(file)) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch (e) {
    console.error(e);
    res.writeHead(500).end("Server error");
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  const mock = process.env.LLM_MOCK === "1" || !process.env.OPENAI_API_KEY;
  console.log(`ShopSmart AI running at http://localhost:${port}`);
  console.log(mock ? "MODE: MOCK (no API key found, fake model answers)" : `MODE: REAL (${process.env.OPENAI_MODEL || "gpt-4o-mini"})`);
});
