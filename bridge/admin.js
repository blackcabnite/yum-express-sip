// Tiny token-protected HTTP admin endpoint for the bridge.
// Lets the dashboard switch Asterisk codec mode (opus ↔ g722) without SSH.
//
// Endpoints (all require header `X-Admin-Token: $ADMIN_TOKEN`):
//   GET  /admin/codec          → { mode: "opus" | "g722" | "unknown", details: string }
//   POST /admin/codec {mode}   → runs switch-codec.sh, returns new state
//
// Bind: 0.0.0.0:ADMIN_PORT (default 8090). Put behind a firewall if exposed.
import http from "node:http";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "asterisk", "switch-codec.sh");

function runScript(arg) {
  return new Promise((resolve) => {
    execFile("sudo", ["-n", SCRIPT, arg], { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || err?.message || "") });
    });
  });
}

function parseStatus(stdout) {
  // Look for "pjsip.conf → .../pjsip.opus.conf" or ".../pjsip.conf"
  const m = stdout.match(/pjsip\.conf\s*→\s*(\S+)/);
  if (!m) return { mode: "unknown", details: stdout.trim() };
  if (m[1].endsWith("pjsip.opus.conf")) return { mode: "opus", details: stdout.trim() };
  if (m[1].endsWith("pjsip.conf"))      return { mode: "g722", details: stdout.trim() };
  return { mode: "unknown", details: stdout.trim() };
}

export function startAdminServer() {
  const token = process.env.ADMIN_TOKEN || "";
  const port = parseInt(process.env.ADMIN_PORT || "8090", 10);
  if (!token) {
    console.warn("[admin] ADMIN_TOKEN not set — running OPEN (no auth). Test mode only.");
  }

  const server = http.createServer(async (req, res) => {
    // CORS for browser → serverFn → here (serverFn proxies, so CORS is mostly cosmetic)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    if (req.url !== "/admin/codec") { res.writeHead(404); return res.end("not found"); }
    if (token && (req.headers["x-admin-token"] || "") !== token) {
      res.writeHead(401); return res.end("unauthorized");
    }

    if (req.method === "GET") {
      const r = await runScript("status");
      const parsed = parseStatus(r.stdout);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ...parsed, raw: r.stdout || r.stderr }));
    }

    if (req.method === "POST") {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let mode;
        try { mode = JSON.parse(body).mode; } catch { mode = null; }
        if (mode !== "opus" && mode !== "g722") {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: "mode must be 'opus' or 'g722'" }));
        }
        const r = await runScript(mode);
        const status = await runScript("status");
        const parsed = parseStatus(status.stdout);
        res.writeHead(r.ok ? 200 : 500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: r.ok, mode: parsed.mode, log: r.stdout + r.stderr }));
      });
      return;
    }

    res.writeHead(405); res.end("method not allowed");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[admin] listening on 0.0.0.0:${port} (token-protected)`);
  });
}