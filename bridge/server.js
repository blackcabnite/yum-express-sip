// ============================================================================
//  Sweet Spot voice bridge: Asterisk ARI <-> OpenAI Realtime
// ============================================================================
//
//  Audio path:
//    Caller (WhatsApp Opus) ⇄ Asterisk ⇄ G.722 RTP @ 8kHz clock / 16kHz audio
//      ⇄ this bridge ⇄ slin16 PCM @ 16kHz ⇄ OpenAI Realtime (resampled to 24k
//      inside openai.js).
//
//  G.722 quirk: RFC 3551 says G.722 uses an 8kHz RTP timestamp clock even
//  though the audio is 16kHz wideband. So ts_inc = 160 per 20ms packet, not 320.
//
//  Hard-won design decisions (lessons from a long debugging day):
//
//  1. Outbound RTP MUST be paced at 20ms intervals. OpenAI delivers audio in
//     100-250ms bursts; without pacing, Asterisk's jitter buffer drops most
//     of it. Pacer is clock-driven via `nextSendAt += FRAME_MS`.
//
//  2. Burst cap is small (3 frames per 5ms tick = 60ms max future). Larger
//     bursts overflow Asterisk's buffer; smaller is gentler. Queue still
//     drains promptly because we keep dripping while it's non-empty.
//
//  3. Seed `remote` from channelvars BEFORE inbound RTP — so we can play the
//     greeting immediately on call answer. Don't overwrite from inbound rinfo
//     after that; Asterisk's TX port may differ from RX port.
//
//  4. Carry partial-frame leftovers across enqueue() calls. OpenAI deltas
//     aren't 20ms-aligned; without a carry buffer, ~half a frame is lost
//     at every chunk boundary → audio sounds clipped.
//
//  5. Cleanup is idempotent (StasisEnd can fire on either leg, sometimes both).
//
//  6. Barge-in: when caller speaks, drain queue + tell OpenAI to cancel its
//     response. Without this, the AI keeps talking over interruptions.
//
//  7. Watchdogs: no-remote, no-AI-audio, max-duration. Catch silent failures.
//
// ============================================================================
import "dotenv/config";
import ariClient from "ari-client";
import dgram from "node:dgram";
import http from "node:http";
import { execFile } from "node:child_process";
import { G722Encoder, G722Decoder } from "g722-spandsp";
import { createSession, endSession, logEvent } from "./supabase.js";
import { newCallState } from "./tools.js";
import { openOpenAIRealtime } from "./openai.js";

// ─── Config ─────────────────────────────────────────────────────────────────
const ARI_URL              = process.env.ARI_URL || "http://127.0.0.1:8088";
const ARI_USER             = process.env.ARI_USER || "sweetspot";
const ARI_PASS             = process.env.ARI_PASS;
const APP_NAME             = "sweetspot";
const PUBLIC_HOST          = process.env.PUBLIC_HOST || "127.0.0.1";
const AST_FORMAT           = process.env.AST_FORMAT || "g722";
// PT: 9 = G.722 static. slin16 has no static PT; Asterisk typically negotiates
// a dynamic PT (often 118). Override via RTP_PT env when using slin16.
const FORCED_RTP_PT        = process.env.RTP_PT
  ? parseInt(process.env.RTP_PT, 10)
  : (AST_FORMAT === "slin16" ? 118 : 9);
const USE_SLIN16           = AST_FORMAT === "slin16";

const FRAME_MS             = 20;
const FRAME_BYTES_SLIN16   = 640;     // 320 samples × 2 bytes @ 16kHz × 20ms
const FRAME_BYTES_G722     = 160;     // 64kbps × 20ms / 8
// G.722: 8 kHz RTP clock (RFC 3551 quirk) → 160/frame.
// slin16: real 16 kHz clock → 320/frame.
const TS_INC_PER_FRAME     = USE_SLIN16 ? 320 : 160;
// Outbound on-wire frame size depends on codec.
const FRAME_BYTES_OUT      = USE_SLIN16 ? FRAME_BYTES_SLIN16 : FRAME_BYTES_G722;
const MAX_QUEUE_FRAMES     = 3000;    // 60s cap; long AI replies must buffer fully without dropping frames
const MAX_BURST_PER_TICK   = 1;       // NEVER catch up faster than real time; prevents speed-up/tripping

const RTP_PORT_BASE        = 14000;
const RTP_PORT_TOP         = 14200;
const REMOTE_TIMEOUT_MS    = 5000;
const AUDIO_IDLE_TIMEOUT_MS = 45000;
const CALL_MAX_DURATION_MS = 15 * 60 * 1000;

// ─── Port allocator (Set-based, no leaks under concurrent calls) ────────────
const portsInUse = new Set();
function pickRtpPort() {
  for (let p = RTP_PORT_BASE; p < RTP_PORT_TOP; p += 2) {
    if (!portsInUse.has(p)) { portsInUse.add(p); return p; }
  }
  throw new Error(`no free RTP port in ${RTP_PORT_BASE}-${RTP_PORT_TOP}`);
}
function releaseRtpPort(p) { portsInUse.delete(p); }

// Module-level session registry — used for clean SIGTERM/SIGINT shutdown.
const sessions = new Set();

// ─── RTP helpers ────────────────────────────────────────────────────────────
function rtpPayload(pkt) {
  if (pkt.length < 12) return null;
  const cc  = pkt[0] & 0x0f;
  const ext = (pkt[0] & 0x10) !== 0;
  let off = 12 + cc * 4;
  if (ext && pkt.length >= off + 4) {
    const extLen = pkt.readUInt16BE(off + 2);
    off += 4 + extLen * 4;
  }
  return pkt.slice(off);
}

function buildRtpPacket({ seq, ts, ssrc, payload, pt }) {
  const hdr = Buffer.alloc(12);
  hdr[0] = 0x80;
  hdr[1] = pt & 0x7f;
  hdr.writeUInt16BE(seq & 0xffff, 2);
  hdr.writeUInt32BE(ts >>> 0, 4);
  hdr.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([hdr, payload]);
}

async function getChannelVar(ari, channelId, variable, retries = 8) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await ari.channels.getChannelVar({ channelId, variable });
      if (r?.value) return r.value;
    } catch {}
    await new Promise(res => setTimeout(res, 50));
  }
  return null;
}

// ─── Per-call handler ───────────────────────────────────────────────────────
async function handleCall(ari, channel) {
  const tag = `[${channel.id.slice(-6)}]`;
  const callerMsisdn = channel.caller?.number || null;
  const startedAt = Date.now();
  console.log(`${tag} [call] start caller=${callerMsisdn} astFormat=${AST_FORMAT} pt=${FORCED_RTP_PT} ts_inc=${TS_INC_PER_FRAME} frame=${FRAME_BYTES_OUT}B`);

  const session = await createSession({ callerMsisdn, channelId: channel.id });
  const state   = newCallState({ sessionId: session.id, callerMsisdn });
  await logEvent(session.id, "call_start", null, { channel_id: channel.id, caller: callerMsisdn });

  // G.722 is stateful ADPCM — predictor state must be fresh per call,
  // otherwise the first audio of a new call decodes as garbage.
  // Only allocate when actually using G.722.
  const g722Enc = USE_SLIN16 ? null : new G722Encoder();
  const g722Dec = USE_SLIN16 ? null : new G722Decoder();

  // Asterisk slin16 on the wire is big-endian PCM16; our internal buffers
  // (and OpenAI) use little-endian. Swap byte order in place on a copy.
  function swap16(buf) {
    const out = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i + 1 < buf.length; i += 2) {
      out[i]     = buf[i + 1];
      out[i + 1] = buf[i];
    }
    return out;
  }

  const localPort = pickRtpPort();
  const sock = dgram.createSocket("udp4");
  await new Promise((res, rej) => {
    sock.once("error", rej);
    sock.bind(localPort, "0.0.0.0", () => res());
  });
  console.log(`${tag} [rtp] listening 0.0.0.0:${localPort}`);

  let remote     = null;
  const remotePt = FORCED_RTP_PT;        // 9 = G.722 static PT
  let seq        = Math.floor(Math.random() * 65535);
  let ts         = 0;
  const ssrc     = Math.floor(Math.random() * 0xffffffff);

  // ─── Create externalMedia channel ────────────────────────────────────────
  let externalChan;
  try {
    externalChan = await ari.channels.externalMedia({
      app: APP_NAME,
      external_host: `${PUBLIC_HOST}:${localPort}`,
      format: AST_FORMAT,
      encapsulation: "rtp",
      transport: "udp",
      connection_type: "client",
      direction: "both",
    });
    console.log(`${tag} [ari] externalMedia ${externalChan.id} → ${PUBLIC_HOST}:${localPort} format=${AST_FORMAT} pt=${remotePt}`);
  } catch (e) {
    console.error(`${tag} [ari] externalMedia failed: ${e.message}`);
    sock.close();
    releaseRtpPort(localPort);
    await channel.hangup().catch(() => {});
    return;
  }

  // Seed remote BEFORE inbound RTP arrives — lets the greeting play immediately.
  try {
    const remoteAddr = (await getChannelVar(ari, externalChan.id, "UNICASTRTP_LOCAL_ADDRESS")) || "127.0.0.1";
    const remotePort = await getChannelVar(ari, externalChan.id, "UNICASTRTP_LOCAL_PORT");
    if (remotePort) {
      remote = { address: remoteAddr, port: parseInt(remotePort, 10) };
      console.log(`${tag} [rtp] seeded remote ${remote.address}:${remote.port}`);
    } else {
      console.warn(`${tag} [rtp] no UNICASTRTP_LOCAL_PORT — will fall back to inbound source`);
    }
  } catch (e) {
    console.warn(`${tag} [rtp] channelvar lookup failed: ${e.message}`);
  }

  const bridge = ari.Bridge();
  await bridge.create({ type: "mixing" });
  await bridge.addChannel({ channel: [channel.id, externalChan.id] });

  // ─── Outbound: AI (slin16 @ 16kHz) → G.722 → paced RTP ──────────────────
  const outQueue = [];
  let droppedFrames = 0;
  let outboundCount = 0;
  let nextSendAt = null;
  let pacerTimer = null;
  let firstSentLogged = false;
  let partialOutbound = Buffer.alloc(0);  // leftover slin16 bytes (< 640)
  let lastAudioActivityAt = Date.now();

  function enqueueOutbound(pcm16Slin16k) {
    lastAudioActivityAt = Date.now();
    // Carry partial-frame bytes across chunks (OpenAI deltas aren't 20ms-aligned).
    const combined  = partialOutbound.length
      ? Buffer.concat([partialOutbound, pcm16Slin16k])
      : pcm16Slin16k;
    const remainder = combined.length % FRAME_BYTES_SLIN16;
    const usable    = combined.length - remainder;
    partialOutbound = remainder ? combined.slice(usable) : Buffer.alloc(0);

    for (let off = 0; off < usable; off += FRAME_BYTES_SLIN16) {
      const slin16Frame = combined.slice(off, off + FRAME_BYTES_SLIN16);  // 640B PCM16
      let outFrame;
      if (USE_SLIN16) {
        // No codec — just byte-swap LE→BE for Asterisk slin16 on the wire.
        outFrame = swap16(slin16Frame);
      } else {
        try {
          outFrame = g722Enc.encode(slin16Frame);                          // → 160B G.722
        } catch (e) {
          console.error(`${tag} [g722] encode err ${e.message}`);
          continue;
        }
      }
      if (outQueue.length >= MAX_QUEUE_FRAMES) {
        outQueue.shift();
        droppedFrames++;
      }
      outQueue.push(outFrame);
    }
    startPacer();
  }

  function startPacer() {
    if (pacerTimer) return;
    nextSendAt = Date.now();
    pacerTimer = setInterval(() => {
      if (!remote || outQueue.length === 0) return;
      const now = Date.now();
      // Resync if we fell way behind (event loop blocked, or long silence).
      // We still send only one packet per tick, so audio never accelerates.
      if (now - nextSendAt > 200) nextSendAt = now;
      let sent = 0;
      while (outQueue.length > 0 && now >= nextSendAt && sent < MAX_BURST_PER_TICK) {
        const slice = outQueue.shift();
        const pkt = buildRtpPacket({ seq: seq++, ts, ssrc, payload: slice, pt: remotePt });
        ts = (ts + TS_INC_PER_FRAME) >>> 0;
        sock.send(pkt, remote.port, remote.address, (e) => {
          if (e) console.error(`${tag} [rtp] send err ${e.message}`);
        });
        outboundCount++;
        sent++;
        if (!firstSentLogged) {
          console.log(
            `${tag} [rtp] FIRST → ${remote.address}:${remote.port} ` +
            `pt=${remotePt} payload=${slice.length}B total=${pkt.length}B ts_inc=${TS_INC_PER_FRAME}/pkt`
          );
          firstSentLogged = true;
        }
        nextSendAt += FRAME_MS;
      }
    }, 5);
  }

  // ─── OpenAI Realtime session ─────────────────────────────────────────────
  const oa = openOpenAIRealtime({
    state,
    onAudioToCaller(pcm16Slin16k) {
      if (!remote) return;
      enqueueOutbound(pcm16Slin16k);
    },
    // Barge-in: caller is speaking → drop queued AI audio so it shuts up
    // instantly. openai.js should also send `response.cancel` to OpenAI.
    onCallerSpeechStarted() {
      if (outQueue.length > 0) {
        console.log(`${tag} [barge-in] dropped ${outQueue.length} queued frames`);
        outQueue.length = 0;
        partialOutbound = Buffer.alloc(0);
      }
      oa.cancelResponse?.();
    },
    onClose() {},
  });

  // ─── Inbound: G.722 RTP → slin16 → OpenAI ────────────────────────────────
  let rxBytes = 0;
  let rxPackets = 0;
  let firstInboundLogged = false;
  sock.on("message", (pkt, rinfo) => {
    if (!remote) {
      remote = rinfo;
      console.log(`${tag} [rtp] no seeded remote — using inbound ${rinfo.address}:${rinfo.port}`);
    }
    if (!firstInboundLogged) {
      const observedPt = pkt.length >= 2 ? (pkt[1] & 0x7f) : -1;
      console.log(`${tag} [rtp] first inbound observed_pt=${observedPt}`);
      firstInboundLogged = true;
    }
    const payload = rtpPayload(pkt);
    if (!payload || !payload.length) return;
    rxBytes += payload.length;
    rxPackets++;
    try {
      let slin16Buf;
      if (USE_SLIN16) {
        // Asterisk slin16 RTP payload is big-endian PCM16 — swap to LE.
        slin16Buf = swap16(payload);
      } else {
        slin16Buf = g722Dec.decode(payload);   // G.722 → slin16 @ 16kHz
      }
      oa.pushCallerAudio(slin16Buf);
    } catch (e) {
      console.error(`${tag} [${USE_SLIN16 ? "slin16" : "g722"}] decode err ${e.message}`);
    }
  });

  // ─── Heartbeats + watchdogs ──────────────────────────────────────────────
  const hbTimer = setInterval(() => {
    console.log(
      `${tag} [hb] in=${rxPackets}p ${rxBytes}b (${(rxPackets/5).toFixed(1)}pps) ` +
      `out=${outboundCount}p q=${outQueue.length} drop=${droppedFrames} pt=${remotePt}`
    );
    rxBytes = 0; rxPackets = 0;
  }, 5000);

  const remoteWatchdog = setTimeout(() => {
    if (!remote) console.warn(`${tag} [⚠] no remote after ${REMOTE_TIMEOUT_MS}ms — TX won't send`);
  }, REMOTE_TIMEOUT_MS);

  const idleWatchdog = setInterval(() => {
    const idle = Date.now() - lastAudioActivityAt;
    if (idle > AUDIO_IDLE_TIMEOUT_MS) {
      console.warn(`${tag} [⚠] no AI audio for ${(idle/1000).toFixed(0)}s`);
    }
  }, 10000);

  const maxDurationWatchdog = setTimeout(() => {
    console.warn(`${tag} [⚠] hit max duration ${CALL_MAX_DURATION_MS/60000}m — hanging up`);
    cleanup("max_duration");
  }, CALL_MAX_DURATION_MS);

  // ─── Cleanup (idempotent) ────────────────────────────────────────────────
  const sess = { tag, cleanup: null };
  sessions.add(sess);
  let cleaned = false;
  async function cleanup(why) {
    if (cleaned) return;
    cleaned = true;
    const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`${tag} [call] end (${why}) dur=${dur}s sent=${outboundCount}p drop=${droppedFrames}`);
    clearInterval(hbTimer);
    clearInterval(idleWatchdog);
    clearTimeout(remoteWatchdog);
    clearTimeout(maxDurationWatchdog);
    if (pacerTimer) clearInterval(pacerTimer);
    try { oa.close(); } catch {}
    try { sock.close(); } catch {}
    releaseRtpPort(localPort);
    try { await bridge.destroy(); } catch {}
    try { await externalChan.hangup(); } catch {}
    try { await channel.hangup(); } catch {}
    try { await logEvent(state.sessionId, "call_end", why); } catch {}
    try { await endSession(state.sessionId); } catch {}
    try { g722Enc?.reset?.(); g722Dec?.reset?.(); } catch {}
    sessions.delete(sess);
  }
  sess.cleanup = cleanup;
  channel.once("StasisEnd",       () => cleanup("caller_hangup"));
  externalChan.once("StasisEnd",  () => cleanup("media_end"));
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  if (!ARI_PASS)                                                   throw new Error("ARI_PASS not set");
  if (!process.env.OPENAI_API_KEY)                                 throw new Error("OPENAI_API_KEY not set");
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  }

  const ari = await ariClient.connect(ARI_URL, ARI_USER, ARI_PASS);
  ari.on("StasisStart", (event, channel) => {
    if (channel.dialplan?.app_data?.includes("externalMedia")) return;
    if (channel.name?.startsWith("UnicastRTP/")) return;
    handleCall(ari, channel).catch((e) => {
      console.error(`[call] fatal ${e.message}`);
      channel.hangup().catch(() => {});
    });
  });
  ari.on("WebSocketReconnecting", () => console.warn("[ari] ws reconnecting"));
  ari.on("WebSocketConnected",    () => console.log("[ari] ws connected"));
  ari.on("WebSocketMaxRetries",   () => {
    console.error("[ari] ws gave up — exiting (systemd will restart)");
    process.exit(1);
  });
  await ari.start(APP_NAME);
  console.log(`[bridge] listening as ARI app "${APP_NAME}"`);

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      console.log(`[bridge] ${sig} — draining ${sessions.size} session(s)`);
      for (const s of sessions) {
        try { await s.cleanup(`shutdown_${sig}`); } catch {}
      }
      process.exit(0);
    });
  }
}

main().catch((e) => { console.error("[bridge] fatal", e); process.exit(1); });

// ═══════════════════════════════════════════════════════════════════════════
//  Admin HTTP — codec switch endpoint
// ═══════════════════════════════════════════════════════════════════════════
//  HARDENED VERSION:
//   - bound to 127.0.0.1 by default (NOT 0.0.0.0 — was internet-reachable!)
//   - refuses to start if ADMIN_TOKEN is not set in env
//   - simple in-memory rate limit (10 req/min per IP)
//   - response time-equalized to mitigate timing attacks on token compare
// ═══════════════════════════════════════════════════════════════════════════
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ADMIN_PORT  = parseInt(process.env.ADMIN_PORT || "8090", 10);
const ADMIN_BIND  = process.env.ADMIN_BIND || "127.0.0.1";   // ← was 0.0.0.0
const SWITCH_SH   = process.env.SWITCH_SH || "/opt/sweetspot-voice/bridge/asterisk/switch-codec.sh";

if (!ADMIN_TOKEN) {
  console.warn("[admin] ADMIN_TOKEN not set — admin HTTP DISABLED (set ADMIN_TOKEN in env to enable)");
} else {
  const rateLimits = new Map();   // ip → [{at: ts}, ...]
  const RATE_WINDOW_MS = 60_000;
  const RATE_MAX = 10;

  function safeEq(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  function rateOk(ip) {
    const now = Date.now();
    const hits = (rateLimits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (hits.length >= RATE_MAX) { rateLimits.set(ip, hits); return false; }
    hits.push(now);
    rateLimits.set(ip, hits);
    return true;
  }

  http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const ip = req.socket.remoteAddress || "unknown";
    if (!rateOk(ip)) return send(429, { error: "rate limited" });

    const auth = req.headers.authorization || "";
    const expected = `Bearer ${ADMIN_TOKEN}`;
    if (!safeEq(auth, expected)) return send(401, { error: "unauthorized" });

    if (req.url !== "/admin/codec") return send(404, { error: "not found" });

    if (req.method === "GET") {
      execFile("sudo", [SWITCH_SH, "status"], (err, stdout) => {
        if (err) return send(500, { mode: "unknown", error: String(err) });
        const m = /pjsip\.opus\.conf/.test(stdout) ? "opus"
                : /pjsip\.conf/.test(stdout)      ? "g722"
                : "unknown";
        send(200, { ok: true, mode: m, log: stdout.trim() });
      });
      return;
    }

    if (req.method === "POST") {
      let body = "";
      req.on("data", c => { body += c; if (body.length > 1024) req.destroy(); });
      req.on("end", () => {
        let mode;
        try { mode = JSON.parse(body).mode; } catch { return send(400, { error: "bad json" }); }
        if (mode !== "opus" && mode !== "g722") return send(400, { error: "mode must be opus|g722" });
        execFile("sudo", [SWITCH_SH, mode], (err, stdout, stderr) => {
          if (err) return send(500, { ok: false, error: String(err), log: stderr });
          send(200, { ok: true, mode, log: stdout.trim() });
        });
      });
      return;
    }

    send(405, { error: "method not allowed" });
  }).listen(ADMIN_PORT, ADMIN_BIND, () => console.log(`[admin] listening on ${ADMIN_BIND}:${ADMIN_PORT}`));
}
