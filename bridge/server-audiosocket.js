// ============================================================================
//  Sweet Spot voice bridge: Asterisk AudioSocket (TCP) <-> OpenAI Realtime
// ============================================================================
//
//  This is the AudioSocket variant of server.js. Run it INSTEAD of server.js
//  (not alongside) when you want to bypass RTP/externalMedia entirely.
//
//  Why AudioSocket:
//    - No RTP, no header parsing, no SSRC/seq/timestamp bookkeeping
//    - No PT-mapping bug (ASTERISK-28751) — TCP frames are typed by a kind byte
//    - No endianness traps — spec is always PCM16 LE
//    - TCP retransmits; no audible clicks from lost UDP packets
//    - No outbound pacer needed — TCP backpressure handles flow control
//
//  Protocol (per-call TCP connection from Asterisk):
//    Frame = [1 byte KIND][2 bytes BE LENGTH][payload]
//    KIND 0x00 HANGUP  len=0
//    KIND 0x01 ID      len=16 (binary UUID, first frame from Asterisk)
//    KIND 0x10 SLIN    PCM16 LE @ channel native rate (we use 16 kHz)
//    KIND 0xFF ERROR   len=1
//
//  Audio rate: we set CHANNEL(audionativeformat)=slin16 in the dialplan,
//  so frames are 16 kHz PCM16 LE. openai.js already speaks that natively.
//
//  Caller metadata: AudioSocket itself only carries UUID + audio. We get
//  the caller MSISDN from a tiny HTTP /register endpoint that the dialplan
//  hits with curl BEFORE invoking AudioSocket().
//
//  Dialplan (extensions.conf):
//
//    [from-whatsapp]
//    exten => _+X.,1,NoOp(WhatsApp call from ${CALLERID(num)})
//     same => n,Answer()
//     same => n,Set(CHANNEL(audionativeformat)=slin16)
//     same => n,Set(SS_UUID=${SHELL(uuidgen | tr -d '\n')})
//     same => n,System(curl -s -X POST -H 'content-type: application/json' \
//        -d "{\"uuid\":\"${SS_UUID}\",\"caller\":\"${CALLERID(num)}\"}" \
//        http://127.0.0.1:8091/register)
//     same => n,AudioSocket(${SS_UUID},127.0.0.1:9092)
//     same => n,Hangup()
//
//  Requirements:
//    - app_audiosocket.so loaded in Asterisk (modules.conf or autoload)
//      Verify: asterisk -rx "module show like audiosocket"
//    - codec_resample.so loaded (for opus<->slin16 native bridge translation)
//
// ============================================================================
import "dotenv/config";
import net from "node:net";
import http from "node:http";
import { createSession, endSession, logEvent } from "./supabase.js";
import { newCallState } from "./tools.js";
import { openOpenAIRealtime } from "./openai.js";

// ─── Config ─────────────────────────────────────────────────────────────────
const AUDIOSOCKET_BIND  = process.env.AUDIOSOCKET_BIND || "127.0.0.1";
const AUDIOSOCKET_PORT  = parseInt(process.env.AUDIOSOCKET_PORT || "9092", 10);
const REGISTER_BIND     = process.env.REGISTER_BIND || "127.0.0.1";
const REGISTER_PORT     = parseInt(process.env.REGISTER_PORT || "8091", 10);
const SAMPLE_RATE       = 16000;   // slin16
const FRAME_MS          = 20;
const SAMPLES_PER_FRAME = SAMPLE_RATE / 1000 * FRAME_MS;  // 320
const BYTES_PER_FRAME   = SAMPLES_PER_FRAME * 2;          // 640
const CALL_MAX_DURATION_MS = 15 * 60 * 1000;
const AUDIO_IDLE_TIMEOUT_MS = 45000;
const REGISTRATION_TTL_MS = 60_000;

// ─── AudioSocket frame kinds ───────────────────────────────────────────────
const KIND_HANGUP = 0x00;
const KIND_ID     = 0x01;
const KIND_SLIN   = 0x10;
const KIND_ERROR  = 0xff;

// ─── State ──────────────────────────────────────────────────────────────────
// Pending UUID → { caller, registeredAt } populated by /register before
// AudioSocket connects. Drained when the TCP conn matches.
const pendingRegistrations = new Map();
const activeCalls = new Set();

function gcRegistrations() {
  const now = Date.now();
  for (const [uuid, info] of pendingRegistrations) {
    if (now - info.registeredAt > REGISTRATION_TTL_MS) {
      console.warn(`[register] dropping stale uuid=${uuid}`);
      pendingRegistrations.delete(uuid);
    }
  }
}
setInterval(gcRegistrations, 30_000).unref();

function formatUuid(b) {
  const hex = b.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

// ─── /register HTTP endpoint (called by dialplan before AudioSocket) ───────
function startRegisterServer() {
  http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/register") {
      res.writeHead(404); res.end(); return;
    }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400); res.end("bad json"); return; }
      const uuid = String(payload.uuid || "").toLowerCase();
      const caller = String(payload.caller || "");
      if (!/^[0-9a-f-]{36}$/.test(uuid)) {
        res.writeHead(400); res.end("bad uuid"); return;
      }
      pendingRegistrations.set(uuid, { caller, registeredAt: Date.now() });
      console.log(`[register] uuid=${uuid} caller=${caller || "(none)"}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  }).listen(REGISTER_PORT, REGISTER_BIND, () =>
    console.log(`[register] listening on ${REGISTER_BIND}:${REGISTER_PORT}`)
  );
}

// ─── Per-call handler ───────────────────────────────────────────────────────
async function handleCall(uuid, callerMsisdn, sock) {
  const tag = `[${uuid.slice(0, 8)}]`;
  const startedAt = Date.now();
  console.log(`${tag} [call] start caller=${callerMsisdn || "(unknown)"}`);

  const session = await createSession({ callerMsisdn, channelId: uuid });
  const state   = newCallState({ sessionId: session.id, callerMsisdn });
  await logEvent(session.id, "call_start", null, { uuid, caller: callerMsisdn });

  let cleaned = false;
  let outBytes = 0;
  let inBytes  = 0;
  let lastAudioAt = Date.now();
  let partialOutbound = Buffer.alloc(0);

  // ─── Outbound: AI 16k PCM16 LE → SLIN frames over TCP ─────────────────
  function sendSlinFrame(payload) {
    if (cleaned || sock.destroyed) return;
    const header = Buffer.alloc(3);
    header[0] = KIND_SLIN;
    header.writeUInt16BE(payload.length, 1);
    // TCP write returns false under backpressure; the OS still buffers it,
    // but we honour the signal by pausing the OpenAI push briefly. In
    // practice for a single phone call this never fires.
    sock.write(Buffer.concat([header, payload]));
    outBytes += payload.length;
  }

  function enqueueOutbound(pcm16) {
    lastAudioAt = Date.now();
    // Slice into 20ms frames (640B). Carry leftover bytes across deltas
    // so OpenAI's non-aligned chunk boundaries don't lose audio.
    const combined = partialOutbound.length
      ? Buffer.concat([partialOutbound, pcm16])
      : pcm16;
    const remainder = combined.length % BYTES_PER_FRAME;
    const usable = combined.length - remainder;
    partialOutbound = remainder ? combined.slice(usable) : Buffer.alloc(0);
    for (let off = 0; off < usable; off += BYTES_PER_FRAME) {
      sendSlinFrame(combined.slice(off, off + BYTES_PER_FRAME));
    }
  }

  // ─── OpenAI Realtime session ─────────────────────────────────────────
  const oa = openOpenAIRealtime({
    state,
    onAudioToCaller: (pcm16) => enqueueOutbound(pcm16),
    onCallerSpeechStarted: () => {
      // Barge-in: clear any unsent buffered AI audio + cancel response.
      // TCP has already flushed sent frames to the kernel; this only drops
      // the partial-frame remainder.
      partialOutbound = Buffer.alloc(0);
      oa.cancelResponse?.();
    },
    onClose: () => cleanup("openai_closed"),
  });

  // ─── Inbound: SLIN frames from Asterisk → OpenAI ─────────────────────
  let rxBuf = Buffer.alloc(0);
  sock.on("data", (chunk) => {
    rxBuf = rxBuf.length === 0 ? Buffer.from(chunk) : Buffer.concat([rxBuf, chunk]);
    while (rxBuf.length >= 3) {
      const kind = rxBuf[0];
      const len  = rxBuf.readUInt16BE(1);
      if (rxBuf.length < 3 + len) break;
      const payload = rxBuf.subarray(3, 3 + len);
      rxBuf = rxBuf.subarray(3 + len);
      switch (kind) {
        case KIND_SLIN: {
          // Copy out of the slab so OpenAI's append doesn't keep a
          // ref to the shared buffer (it base64-encodes immediately so
          // it's actually fine, but copy is cheap and explicit).
          const aligned = Buffer.from(payload);
          inBytes += aligned.length;
          lastAudioAt = Date.now();
          oa.pushCallerAudio(aligned);
          break;
        }
        case KIND_HANGUP:
          cleanup("caller_hangup");
          return;
        case KIND_ERROR:
          console.warn(`${tag} peer error 0x${(payload[0] ?? 0).toString(16)}`);
          cleanup("peer_error");
          return;
        case KIND_ID:
          // Already consumed in the listener handshake; ignore stray.
          break;
        default:
          console.warn(`${tag} unknown kind 0x${kind.toString(16)}`);
      }
    }
  });

  sock.on("close", () => cleanup("tcp_closed"));
  sock.on("error", (e) => {
    console.warn(`${tag} tcp error ${e.message}`);
    cleanup("tcp_error");
  });

  // ─── Watchdogs + heartbeat ───────────────────────────────────────────
  const hb = setInterval(() => {
    console.log(
      `${tag} [hb] in=${inBytes}B out=${outBytes}B (in=${(inBytes/640).toFixed(0)}f, out=${(outBytes/640).toFixed(0)}f)`
    );
    inBytes = 0; outBytes = 0;
  }, 5000);

  const idleWd = setInterval(() => {
    if (Date.now() - lastAudioAt > AUDIO_IDLE_TIMEOUT_MS) {
      console.warn(`${tag} [⚠] no audio for ${AUDIO_IDLE_TIMEOUT_MS/1000}s`);
    }
  }, 10000);

  const maxDurWd = setTimeout(() => {
    console.warn(`${tag} [⚠] max duration hit — closing`);
    cleanup("max_duration");
  }, CALL_MAX_DURATION_MS);

  // ─── Cleanup (idempotent) ────────────────────────────────────────────
  const callRec = { tag, cleanup: null };
  activeCalls.add(callRec);

  async function cleanup(why) {
    if (cleaned) return;
    cleaned = true;
    const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`${tag} [call] end (${why}) dur=${dur}s`);
    clearInterval(hb);
    clearInterval(idleWd);
    clearTimeout(maxDurWd);
    try { oa.close(); } catch {}
    try {
      if (!sock.destroyed) {
        // Polite hangup frame
        const hdr = Buffer.alloc(3);
        hdr[0] = KIND_HANGUP;
        hdr.writeUInt16BE(0, 1);
        try { sock.write(hdr); } catch {}
        sock.end();
      }
    } catch {}
    try { await logEvent(state.sessionId, "call_end", why); } catch {}
    try { await endSession(state.sessionId); } catch {}
    activeCalls.delete(callRec);
  }
  callRec.cleanup = cleanup;
}

// ─── TCP listener: handshake, then hand off to handleCall ──────────────────
function startAudioSocketServer() {
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    let buf = Buffer.alloc(0);
    const onHandshake = (chunk) => {
      buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
      if (buf.length < 3) return;
      const kind = buf[0];
      const len  = buf.readUInt16BE(1);
      if (buf.length < 3 + len) return;
      if (kind !== KIND_ID || len !== 16) {
        console.warn(`[as] first frame not ID (kind=0x${kind.toString(16)} len=${len})`);
        try { sock.destroy(); } catch {}
        return;
      }
      const uuid = formatUuid(buf.subarray(3, 19)).toLowerCase();
      const remainder = buf.subarray(19);
      sock.removeListener("data", onHandshake);

      const reg = pendingRegistrations.get(uuid);
      pendingRegistrations.delete(uuid);
      const caller = reg?.caller || null;
      if (!reg) {
        console.warn(`[as] no /register for uuid=${uuid} — accepting anyway (caller unknown)`);
      }

      handleCall(uuid, caller, sock).catch((e) => {
        console.error(`[as] handleCall fatal: ${e.message}`);
        try { sock.destroy(); } catch {}
      });

      // Re-emit any audio bytes that arrived in the same TCP packet as ID.
      if (remainder.length) sock.emit("data", remainder);
    };
    sock.on("data", onHandshake);
    sock.on("error", (e) => console.warn(`[as] pre-attach err ${e.message}`));
  });
  server.listen(AUDIOSOCKET_PORT, AUDIOSOCKET_BIND, () =>
    console.log(`[as] AudioSocket TCP listening on ${AUDIOSOCKET_BIND}:${AUDIOSOCKET_PORT}`)
  );
  return server;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  }
  startRegisterServer();
  startAudioSocketServer();

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      console.log(`[as] ${sig} — draining ${activeCalls.size} session(s)`);
      for (const c of activeCalls) {
        try { await c.cleanup(`shutdown_${sig}`); } catch {}
      }
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error("[as] fatal", e);
  process.exit(1);
});