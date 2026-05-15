// Sweet Spot voice bridge: Asterisk ARI <-> OpenAI Realtime.
// PATCH: paces outbound RTP at exactly 20ms intervals. OpenAI delivers audio
// in bursts (10-20 frames at a time); without pacing Asterisk's jitter buffer
// overflows and most audio gets dropped before reaching Meta.
import "dotenv/config";
import ariClient from "ari-client";
import dgram from "node:dgram";
import { createSession, endSession, logEvent } from "./supabase.js";
import { newCallState } from "./tools.js";
import { openOpenAIRealtime } from "./openai.js";

const ARI_URL = process.env.ARI_URL || "http://127.0.0.1:8088";
const ARI_USER = process.env.ARI_USER || "sweetspot";
const ARI_PASS = process.env.ARI_PASS;
const APP_NAME = "sweetspot";
const PUBLIC_HOST = process.env.PUBLIC_HOST || "127.0.0.1";
const RTP_PORT_BASE = 14000;
const FRAME_MS = 20;
const FRAME_SAMPLES = 320;          // 16kHz × 20ms = 320 samples
const FRAME_BYTES = 640;            // 320 samples × 2 bytes/sample
const MAX_QUEUE_FRAMES = 50;        // ~1s — beyond this, drop oldest to keep latency bounded
let nextPort = RTP_PORT_BASE;

function pickRtpPort() {
  const p = nextPort;
  nextPort = nextPort + 2;
  if (nextPort > RTP_PORT_BASE + 200) nextPort = RTP_PORT_BASE;
  return p;
}

function rtpPayload(pkt) {
  if (pkt.length < 12) return null;
  const cc = pkt[0] & 0x0f;
  const ext = (pkt[0] & 0x10) !== 0;
  let off = 12 + cc * 4;
  if (ext && pkt.length >= off + 4) {
    const extLen = pkt.readUInt16BE(off + 2);
    off += 4 + extLen * 4;
  }
  return pkt.slice(off);
}

function buildRtpPacket({ seq, ts, ssrc, payload, pt = 96 }) {
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
    await new Promise((res) => setTimeout(res, 50));
  }
  return null;
}

async function handleCall(ari, channel) {
  const callerMsisdn = channel.caller?.number || null;
  console.log(`[call] start ch=${channel.id} caller=${callerMsisdn}`);

  const session = await createSession({ callerMsisdn, channelId: channel.id });
  const state = newCallState({ sessionId: session.id, callerMsisdn });
  await logEvent(session.id, "call_start", null, { channel_id: channel.id, caller: callerMsisdn });

  const localPort = pickRtpPort();
  const sock = dgram.createSocket("udp4");
  await new Promise((res, rej) => {
    sock.once("error", rej);
    sock.bind(localPort, "0.0.0.0", () => res());
  });
  console.log(`[rtp] listening udp4 0.0.0.0:${localPort}`);

  let remote = null;
  let remotePt = 118;
  let seq = Math.floor(Math.random() * 65535);
  let ts = 0;
  const ssrc = Math.floor(Math.random() * 0xffffffff);

  let externalChan;
  try {
    externalChan = await ari.channels.externalMedia({
      app: APP_NAME,
      external_host: `${PUBLIC_HOST}:${localPort}`,
      format: "slin16",
    });
    console.log(`[ari] externalMedia ${externalChan.id} → ${PUBLIC_HOST}:${localPort}`);
  } catch (e) {
    console.error("[call] externalMedia failed", e.message);
    await channel.hangup().catch(() => {});
    sock.close();
    return;
  }

  // Seed remote destination so we can send audio before any caller-side RTP arrives.
  try {
    const remoteAddr = (await getChannelVar(ari, externalChan.id, "UNICASTRTP_LOCAL_ADDRESS")) || "127.0.0.1";
    const remotePort = await getChannelVar(ari, externalChan.id, "UNICASTRTP_LOCAL_PORT");
    if (remotePort) {
      remote = { address: remoteAddr, port: parseInt(remotePort, 10) };
      console.log(`[rtp] seeded remote ${remote.address}:${remote.port}`);
    }
  } catch (e) {
    console.warn(`[rtp] channelvar lookup failed: ${e.message}`);
  }

  const bridge = ari.Bridge();
  await bridge.create({ type: "mixing" });
  await bridge.addChannel({ channel: [channel.id, externalChan.id] });

  // ─── PACED OUTBOUND RTP ─────────────────────────────────────────────────
  // Buffer 640-byte slin16 frames; emit one every 20ms via a self-correcting
  // timer. OpenAI delivers audio in bursts; Asterisk's jitter buffer drops
  // packets that arrive faster than playout rate. Without this fix, most of
  // the model's audio never reaches the caller — they hear comfort noise.
  const outQueue = [];
  let droppedFrames = 0;
  let nextSendAt = null;
  let pacerTimer = null;
  let outboundCount = 0;
  let firstSentLogged = false;

  function enqueueOutbound(pcm16Slin) {
    for (let off = 0; off < pcm16Slin.length; off += FRAME_BYTES) {
      const slice = pcm16Slin.slice(off, off + FRAME_BYTES);
      if (slice.length < FRAME_BYTES) break;
      if (outQueue.length >= MAX_QUEUE_FRAMES) {
        outQueue.shift();
        droppedFrames++;
      }
      outQueue.push(slice);
    }
    startPacer();
  }

  function startPacer() {
    if (pacerTimer) return;
    nextSendAt = Date.now();
    pacerTimer = setInterval(() => {
      if (!remote) return;
      const now = Date.now();
      let sent = 0;
      while (outQueue.length > 0 && now >= nextSendAt && sent < 5) {
        const slice = outQueue.shift();
        const pkt = buildRtpPacket({ seq: seq++, ts, ssrc, payload: slice, pt: remotePt });
        ts = (ts + FRAME_SAMPLES) >>> 0;
        sock.send(pkt, remote.port, remote.address, (e) => {
          if (e) console.error("[rtp] send err", e.message);
        });
        outboundCount++;
        sent++;
        if (!firstSentLogged) {
          console.log(`[rtp] FIRST paced packet sent to ${remote.address}:${remote.port}`);
          firstSentLogged = true;
        }
        nextSendAt += FRAME_MS;
      }
      if (outQueue.length === 0) {
        nextSendAt = Date.now();
      }
    }, 5);
  }

  const oa = openOpenAIRealtime({
    state,
    onAudioToCaller(pcm16Slin) {
      if (!remote) return;
      enqueueOutbound(pcm16Slin);
    },
    onClose() {},
  });

  let rxBytes = 0;
  let rxPackets = 0;
  const rxTimer = setInterval(() => {
    console.log(`[rtp] hb caller→bridge ${rxPackets}p ${rxBytes}b | bridge→caller ${outboundCount}p sent · ${outQueue.length} queued · ${droppedFrames} dropped`);
    rxBytes = 0; rxPackets = 0;
  }, 5000);
  sock.on("message", (pkt, rinfo) => {
    if (!remote || (remote.address === "127.0.0.1" && remote.port !== rinfo.port)) {
      remote = rinfo;
      if (pkt.length >= 2) remotePt = pkt[1] & 0x7f;
      console.log(`[rtp] inbound remote ${rinfo.address}:${rinfo.port} pt=${remotePt}`);
    }
    const payload = rtpPayload(pkt);
    if (payload && payload.length) {
      rxBytes += payload.length;
      rxPackets++;
      oa.pushCallerAudio(payload);
    }
  });

  const cleanup = async (why) => {
    console.log(`[call] end ch=${channel.id} (${why}) · sent ${outboundCount}p queued=${outQueue.length} dropped=${droppedFrames}`);
    clearInterval(rxTimer);
    if (pacerTimer) clearInterval(pacerTimer);
    try { oa.close(); } catch {}
    try { sock.close(); } catch {}
    try { await bridge.destroy(); } catch {}
    try { await externalChan.hangup(); } catch {}
    await logEvent(state.sessionId, "call_end", why);
    await endSession(state.sessionId);
  };
  channel.once("StasisEnd", () => cleanup("caller_hangup"));
  externalChan.once("StasisEnd", () => cleanup("media_end"));
}

async function main() {
  if (!ARI_PASS) throw new Error("ARI_PASS not set");
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  }

  const ari = await ariClient.connect(ARI_URL, ARI_USER, ARI_PASS);
  ari.on("StasisStart", (event, channel) => {
    if (channel.dialplan?.app_data?.includes("externalMedia")) return;
    if (channel.name?.startsWith("UnicastRTP/")) return;
    handleCall(ari, channel).catch((e) => {
      console.error("[call] fatal", e);
      channel.hangup().catch(() => {});
    });
  });
  await ari.start(APP_NAME);
  console.log(`[bridge] listening as ARI app "${APP_NAME}"`);
}

main().catch((e) => { console.error("[bridge] fatal", e); process.exit(1); });
