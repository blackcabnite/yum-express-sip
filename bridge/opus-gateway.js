// ============================================================================
//  Sweet Spot Opus SIP gateway (EXPERIMENTAL — runs alongside server.js)
// ============================================================================
//
//  Why this exists
//  ----------------
//  ARI ExternalMedia cannot negotiate Opus: it has no SDP offer/answer, so
//  there is no way to map a dynamic RTP payload type like 111 → opus/48000/2.
//  This gateway is a tiny local SIP UAS that DOES do SDP, so Asterisk can
//  Dial(PJSIP/ai-opus/...) into it with real Opus end-to-end.
//
//  Path
//  ----
//    WhatsApp (Opus/SRTP) → Asterisk → PJSIP/ai-opus → THIS gateway (Opus/RTP)
//      → @discordjs/opus decode → 48k PCM16 → downsample 24k → OpenAI Realtime
//      → 24k PCM16 → upsample 48k → @discordjs/opus encode → RTP → Asterisk
//
//  Status: first working version. Single concurrent call. Plain RTP (Asterisk
//  side is loopback, so no SRTP needed). Run as its own systemd service on
//  port 5070; the production G.722 bridge keeps running on its own.
//
//  Run: PORT_SIP=5070 RTP_PORT=40000 node opus-gateway.js
// ============================================================================
import "dotenv/config";
import dgram from "node:dgram";
import os from "node:os";
import sip from "sip";
import { OpusEncoder } from "@discordjs/opus";
import { openOpenAIRealtime } from "./openai.js";
import { newCallState } from "./tools.js";
import { createSession, endSession, logEvent } from "./supabase.js";

// ─── Config ─────────────────────────────────────────────────────────────────
const SIP_PORT     = parseInt(process.env.SIP_PORT || "5070", 10);
const SIP_HOST     = process.env.SIP_HOST || "127.0.0.1";
const RTP_PORT     = parseInt(process.env.RTP_PORT || "40000", 10);
const RTP_HOST     = process.env.RTP_HOST || "127.0.0.1";
const OPUS_PT      = 111;        // dynamic PT we advertise in SDP
const PTIME_MS     = 20;
const SR_OPUS      = 48000;      // Opus always clocks at 48kHz in RTP
const SAMPLES_20MS_48K = 960;    // 48000 * 0.02
const SAMPLES_20MS_24K = 480;

// ─── Opus codec (mono, 48kHz) ───────────────────────────────────────────────
const opusEnc = new OpusEncoder(SR_OPUS, 1);
const opusDec = new OpusEncoder(SR_OPUS, 1);
try { opusEnc.setBitrate(32000); } catch {}

// ─── Resamplers (linear, stateful) ──────────────────────────────────────────
// 48k mono PCM16 <-> 24k mono PCM16. Same algorithm as openai.js but inline.
function resamplePCM16(input, fromRate, toRate, state) {
  if (fromRate === toRate) return { out: input, state };
  const inSamples = input.length / 2;
  if (inSamples === 0) return { out: Buffer.alloc(0), state };
  const ratio = fromRate / toRate;
  const prev = state?.prev ?? input.readInt16LE(0);
  let phase = state?.phase ?? 0;
  const outSamples = Math.floor((inSamples - phase) / ratio);
  const out = Buffer.alloc(Math.max(0, outSamples) * 2);
  const readAt = (idx) => {
    if (idx < 0) return prev;
    if (idx >= inSamples) return input.readInt16LE((inSamples - 1) * 2);
    return input.readInt16LE(idx * 2);
  };
  for (let i = 0; i < outSamples; i++) {
    const srcF = phase + i * ratio;
    const i0 = Math.floor(srcF);
    const t = srcF - i0;
    const v = Math.round(readAt(i0) * (1 - t) + readAt(i0 + 1) * t);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  phase = phase + outSamples * ratio - inSamples;
  while (phase < 0) phase += ratio;
  return { out, state: { phase, prev: input.readInt16LE((inSamples - 1) * 2) } };
}

// ─── RTP helpers ────────────────────────────────────────────────────────────
function buildRtp({ pt, seq, ts, ssrc, payload }) {
  const hdr = Buffer.alloc(12);
  hdr[0] = 0x80;
  hdr[1] = pt & 0x7f;
  hdr.writeUInt16BE(seq & 0xffff, 2);
  hdr.writeUInt32BE(ts >>> 0, 4);
  hdr.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([hdr, payload]);
}
function parseRtp(pkt) {
  if (pkt.length < 12) return null;
  const pt = pkt[1] & 0x7f;
  const seq = pkt.readUInt16BE(2);
  const ts = pkt.readUInt32BE(4);
  const ssrc = pkt.readUInt32BE(8);
  const csrcCount = pkt[0] & 0x0f;
  const headerLen = 12 + csrcCount * 4;
  return { pt, seq, ts, ssrc, payload: pkt.subarray(headerLen) };
}

// ─── SDP ────────────────────────────────────────────────────────────────────
function makeSdp({ host, port }) {
  return [
    "v=0",
    `o=- ${Date.now()} 1 IN IP4 ${host}`,
    "s=sweetspot-opus",
    `c=IN IP4 ${host}`,
    "t=0 0",
    `m=audio ${port} RTP/AVP ${OPUS_PT}`,
    `a=rtpmap:${OPUS_PT} opus/48000/2`,
    `a=fmtp:${OPUS_PT} minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000`,
    `a=ptime:${PTIME_MS}`,
    "a=sendrecv",
    "",
  ].join("\r\n");
}
function parseSdpMedia(sdp) {
  const lines = (sdp || "").split(/\r?\n/);
  let host = null, port = null;
  for (const ln of lines) {
    if (ln.startsWith("c=IN IP4 ")) host = ln.slice(9).trim();
    if (ln.startsWith("m=audio ")) {
      const m = ln.match(/^m=audio\s+(\d+)/);
      if (m) port = parseInt(m[1], 10);
    }
  }
  return { host, port };
}

// ─── Per-call state ─────────────────────────────────────────────────────────
const calls = new Map(); // callId -> { rtp, remote, openai, state, paceTimer }

function startCall({ callId, remote }) {
  if (calls.has(callId)) return calls.get(callId);
  console.log(`[opus] call start ${callId} remote=${remote.host}:${remote.port}`);

  const rtp = dgram.createSocket("udp4");
  rtp.bind(RTP_PORT, "0.0.0.0");

  const sendState = { seq: Math.floor(Math.random() * 65535), ts: Math.floor(Math.random() * 1e9), ssrc: Math.floor(Math.random() * 1e9) };
  let upState = null;   // 24k → 48k (model → caller)
  let downState = null; // 48k → 24k (caller → model)

  // Outbound pacing queue: array of Opus payloads (one 20ms frame each)
  const outQueue = [];
  let nextSendAt = Date.now();
  let carry = Buffer.alloc(0); // pcm48k carry for non-aligned chunks

  function pump() {
    const now = Date.now();
    while (outQueue.length && now >= nextSendAt) {
      const payload = outQueue.shift();
      const pkt = buildRtp({ pt: OPUS_PT, seq: sendState.seq++, ts: sendState.ts, ssrc: sendState.ssrc, payload });
      sendState.ts = (sendState.ts + SAMPLES_20MS_48K) >>> 0;
      rtp.send(pkt, remote.port, remote.host);
      nextSendAt += PTIME_MS;
    }
    if (nextSendAt < now - 200) nextSendAt = now; // recover from sleeps
  }
  const paceTimer = setInterval(pump, 5);

  // ─── OpenAI Realtime ──────────────────────────────────────────────────────
  const state = newCallState({ callId, caller: callId });
  state.sessionId = null;
  createSession({ channelId: callId, caller: callId }).then((s) => {
    state.sessionId = s?.id || null;
  }).catch(() => {});

  const openai = openOpenAIRealtime({
    state,
    onAudioToCaller: (pcm16_16k) => {
      // openai.js gives us 16k PCM (it already downsamples 24k→16k for the
      // G.722 path). We want 48k for Opus, so first go 16k→48k.
      const r = resamplePCM16(pcm16_16k, 16000, 48000, upState);
      upState = r.state;
      const merged = Buffer.concat([carry, r.out]);
      const frameBytes = SAMPLES_20MS_48K * 2;
      const frames = Math.floor(merged.length / frameBytes);
      for (let i = 0; i < frames; i++) {
        const pcm = merged.subarray(i * frameBytes, (i + 1) * frameBytes);
        try {
          const encoded = opusEnc.encode(pcm);
          outQueue.push(encoded);
        } catch (e) {
          console.error("[opus] encode err", e.message);
        }
      }
      carry = merged.subarray(frames * frameBytes);
      // Safety cap: ~60s of queued audio
      if (outQueue.length > 3000) {
        console.warn(`[opus] queue cap hit q=${outQueue.length}, dropping oldest`);
        outQueue.splice(0, outQueue.length - 3000);
      }
    },
    onCallerSpeechStarted: () => {
      if (outQueue.length) {
        console.log(`[opus] barge-in, drop ${outQueue.length} queued frames`);
        outQueue.length = 0;
        carry = Buffer.alloc(0);
      }
    },
    onClose: () => cleanup("openai_closed"),
  });

  // ─── Inbound RTP: Opus → PCM16 16k → OpenAI ───────────────────────────────
  let hbIn = 0, hbOut = 0, hbT = Date.now();
  rtp.on("message", (pkt, rinfo) => {
    const r = parseRtp(pkt);
    if (!r) return;
    if (r.pt !== OPUS_PT) return; // ignore comfort noise / DTMF
    try {
      const pcm48 = opusDec.decode(r.payload); // Buffer of PCM16 LE @ 48k mono
      // 48k → 16k for openai.js (its pushCallerAudio resamples 16k→24k internally)
      const d = resamplePCM16(pcm48, 48000, 16000, downState);
      downState = d.state;
      openai.pushCallerAudio(d.out);
      hbIn++;
    } catch (e) {
      console.error("[opus] decode err", e.message);
    }
  });

  setInterval(() => {
    const dt = Date.now() - hbT;
    if (dt < 5000) return;
    console.log(`[opus hb] in=${hbIn}p out=${outQueue.length}q nextDelay=${nextSendAt - Date.now()}ms`);
    hbIn = 0; hbOut = 0; hbT = Date.now();
  }, 5000).unref();

  function cleanup(reason) {
    if (!calls.has(callId)) return;
    console.log(`[opus] call end ${callId} (${reason})`);
    calls.delete(callId);
    clearInterval(paceTimer);
    try { openai.close(); } catch {}
    try { rtp.close(); } catch {}
    if (state.sessionId) endSession(state.sessionId, reason).catch(() => {});
  }

  const entry = { rtp, remote, openai, state, paceTimer, cleanup };
  calls.set(callId, entry);
  return entry;
}

// ─── SIP UAS ────────────────────────────────────────────────────────────────
sip.start({ port: SIP_PORT, address: "0.0.0.0", logger: { send: () => {}, recv: () => {} } }, (rq) => {
  try {
    if (rq.method === "INVITE") {
      const callId = rq.headers["call-id"];
      const { host: rHost, port: rPort } = parseSdpMedia(rq.content);
      if (!rHost || !rPort) {
        sip.send(sip.makeResponse(rq, 488, "Not Acceptable Here"));
        return;
      }
      // 100 trying
      sip.send(sip.makeResponse(rq, 100, "Trying"));

      // Start call (binds RTP, opens OpenAI)
      startCall({ callId, remote: { host: rHost, port: rPort } });

      // 200 OK with our SDP
      const ok = sip.makeResponse(rq, 200, "OK");
      ok.headers.to.params.tag = Math.random().toString(36).slice(2, 10);
      ok.headers["content-type"] = "application/sdp";
      ok.content = makeSdp({ host: SIP_HOST, port: RTP_PORT });
      ok.headers.contact = [{ uri: `sip:opus-gw@${SIP_HOST}:${SIP_PORT}` }];
      sip.send(ok);
      return;
    }
    if (rq.method === "ACK") return;
    if (rq.method === "BYE") {
      const callId = rq.headers["call-id"];
      const entry = calls.get(callId);
      if (entry) entry.cleanup("caller_bye");
      sip.send(sip.makeResponse(rq, 200, "OK"));
      return;
    }
    if (rq.method === "OPTIONS") {
      sip.send(sip.makeResponse(rq, 200, "OK"));
      return;
    }
    sip.send(sip.makeResponse(rq, 501, "Not Implemented"));
  } catch (e) {
    console.error("[sip] handler err", e);
  }
});

console.log(`[opus-gateway] SIP UAS listening on ${SIP_HOST}:${SIP_PORT}, RTP ${RTP_HOST}:${RTP_PORT}, host=${os.hostname()}`);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));