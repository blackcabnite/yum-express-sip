// Sweet Spot voice bridge: Asterisk ARI <-> OpenAI Realtime.
// Asterisk leg: G.722 @ 16 kHz wideband, RTP PT=9 (static).
// OpenAI leg:   slin16 LE @ 16 kHz (openai.js resamples 24k<->16k).
// G.722 RFC 3551 quirk: RTP timestamp clock is 8 kHz even though audio is 16 kHz.
//
// Jitter fixes vs prior revision:
//   - MAX_QUEUE_FRAMES raised 500 → 1500 (~30s headroom for OpenAI bursts)
//   - Pacer tick 5ms → 2ms; per-tick burst cap 50 → 200
//   - Pacer uses setImmediate catch-up so G.722 encoding can't starve send loop
import "dotenv/config";
import ariClient from "ari-client";
import dgram from "node:dgram";
import { G722Encoder, G722Decoder } from "g722-spandsp";
import { createSession, endSession, logEvent } from "./supabase.js";
import { newCallState } from "./tools.js";
import { openOpenAIRealtime } from "./openai.js";

const ARI_URL   = process.env.ARI_URL  || "http://127.0.0.1:8088";
const ARI_USER  = process.env.ARI_USER || "sweetspot";
const ARI_PASS  = process.env.ARI_PASS;
const APP_NAME  = "sweetspot";
const PUBLIC_HOST = process.env.PUBLIC_HOST || "127.0.0.1";
const RTP_PORT_BASE = 14000;

const FRAME_MS           = 20;
const FRAME_BYTES_SLIN16 = 640;   // 320 samples * 2 bytes @ 16 kHz / 20 ms
const FRAME_BYTES_G722   = 160;   // 64 kbps * 20 ms / 8 = 160 B
const TS_INC_PER_FRAME   = 160;   // RFC 3551: G.722 uses 8 kHz RTP clock
const MAX_QUEUE_FRAMES   = 1500;  // ~30s headroom — OpenAI bursts hard

const AST_FORMAT    = process.env.AST_FORMAT || "g722";
const FORCED_RTP_PT = process.env.RTP_PT ? parseInt(process.env.RTP_PT, 10) : 9;

let nextPort = RTP_PORT_BASE;
function pickRtpPort() {
  const p = nextPort;
  nextPort += 2;
  if (nextPort > RTP_PORT_BASE + 200) nextPort = RTP_PORT_BASE;
  return p;
}

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
    await new Promise((res) => setTimeout(res, 50));
  }
  return null;
}

async function handleCall(ari, channel) {
  const callerMsisdn = channel.caller?.number || null;
  console.log(`[call] start ch=${channel.id} caller=${callerMsisdn} astFormat=${AST_FORMAT} pt=${FORCED_RTP_PT}`);

  const session = await createSession({ callerMsisdn, channelId: channel.id });
  const state   = newCallState({ sessionId: session.id, callerMsisdn });
  await logEvent(session.id, "call_start", null, { channel_id: channel.id, caller: callerMsisdn });

  // Per-call G.722 codecs (stateful ADPCM — must be fresh per call)
  const g722Enc = new G722Encoder();
  const g722Dec = new G722Decoder();

  const localPort = pickRtpPort();
  const sock = dgram.createSocket("udp4");
  await new Promise((res, rej) => {
    sock.once("error", rej);
    sock.bind(localPort, "0.0.0.0", () => res());
  });
  console.log(`[rtp] listening udp4 0.0.0.0:${localPort}`);

  let remote     = null;
  const remotePt = FORCED_RTP_PT;
  let seq  = Math.floor(Math.random() * 65535);
  let ts   = 0;
  const ssrc = Math.floor(Math.random() * 0xffffffff);

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
    console.log(`[ari] externalMedia ${externalChan.id} -> ${PUBLIC_HOST}:${localPort} format=${AST_FORMAT} pt=${remotePt}`);
  } catch (e) {
    console.error("[call] externalMedia failed", e.message);
    await channel.hangup().catch(() => {});
    sock.close();
    return;
  }

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

  // ---------- outbound: AI(slin16 16k) -> G.722 -> RTP ------------
  const outQueue = [];
  let droppedFrames  = 0;
  let nextSendAt     = null;
  let pacerTimer     = null;
  let outboundCount  = 0;
  let firstSentLogged = false;
  let partialOutbound = Buffer.alloc(0);

  function enqueueOutbound(pcm16Slin16k) {
    const combined  = partialOutbound.length ? Buffer.concat([partialOutbound, pcm16Slin16k]) : pcm16Slin16k;
    const remainder = combined.length % FRAME_BYTES_SLIN16;
    const usable    = combined.length - remainder;
    partialOutbound = remainder ? combined.slice(usable) : Buffer.alloc(0);

    for (let off = 0; off < usable; off += FRAME_BYTES_SLIN16) {
      const slin16Frame = combined.slice(off, off + FRAME_BYTES_SLIN16);
      const g722Frame   = g722Enc.encode(slin16Frame);
      if (outQueue.length >= MAX_QUEUE_FRAMES) { outQueue.shift(); droppedFrames++; }
      outQueue.push(g722Frame);
    }
    startPacer();
  }

  function sendOne(slice) {
    const pkt = buildRtpPacket({ seq: seq++, ts, ssrc, payload: slice, pt: remotePt });
    ts = (ts + TS_INC_PER_FRAME) >>> 0;
    sock.send(pkt, remote.port, remote.address, (e) => {
      if (e) console.error("[rtp] send err", e.message);
    });
    outboundCount++;
    if (!firstSentLogged) {
      console.log(
        `[rtp] FIRST paced packet -> ${remote.address}:${remote.port} ` +
        `pt=${remotePt} payload=${slice.length}B header=12B total=${pkt.length}B ` +
        `ts_inc=${TS_INC_PER_FRAME}/pkt seq=${(seq - 1) & 0xffff} ssrc=0x${ssrc.toString(16)}`
      );
      firstSentLogged = true;
    }
  }

  function startPacer() {
    if (pacerTimer) return;
    nextSendAt = Date.now();
    pacerTimer = setInterval(() => {
      if (!remote) return;
      const now = Date.now();
      // Resync if we drifted way behind (e.g. event loop hiccup) — don't try
      // to flush thousands of packets in one tick.
      if (now - nextSendAt > 200) nextSendAt = now;
      let sent = 0;
      while (outQueue.length > 0 && now >= nextSendAt && sent < 200) {
        sendOne(outQueue.shift());
        sent++;
        nextSendAt += FRAME_MS;
      }
    }, 2);
  }

  const oa = openOpenAIRealtime({
    state,
    onAudioToCaller(pcm16Slin16k) {
      if (!remote) return;
      enqueueOutbound(pcm16Slin16k);
    },
    onClose() {},
  });

  // ---------- inbound: RTP G.722 -> slin16 16k -> OpenAI ----------
  let rxBytes = 0;
  let rxPackets = 0;
  const rxTimer = setInterval(() => {
    console.log(
      `[rtp] hb caller->bridge ${rxPackets}p ${rxBytes}b ` +
      `(avg ${rxPackets ? (rxBytes / rxPackets).toFixed(0) : 0}B/pkt, ${(rxPackets / 5).toFixed(1)} pps) | ` +
      `bridge->caller ${outboundCount}p sent · ${outQueue.length} queued · ${droppedFrames} dropped · pt=${remotePt}`
    );
    rxBytes = 0; rxPackets = 0;
  }, 5000);

  sock.on("message", (pkt, rinfo) => {
    if (!remote) {
      remote = rinfo;
      console.log(`[rtp] no seeded remote; using inbound source ${rinfo.address}:${rinfo.port}`);
    }
    const payload = rtpPayload(pkt);
    if (!payload || !payload.length) return;
    rxBytes += payload.length;
    rxPackets++;
    const slin16Buf = g722Dec.decode(payload);
    oa.pushCallerAudio(slin16Buf);
  });

  let cleaned = false;
  const cleanup = async (why) => {
    if (cleaned) return;
    cleaned = true;
    console.log(`[call] end ch=${channel.id} (${why}) · sent ${outboundCount}p queued=${outQueue.length} dropped=${droppedFrames}`);
    clearInterval(rxTimer);
    if (pacerTimer) clearInterval(pacerTimer);
    try { oa.close(); } catch {}
    try { sock.close(); } catch {}
    try { await bridge.destroy(); } catch {}
    try { await externalChan.hangup(); } catch {}
    try { await logEvent(state.sessionId, "call_end", why); } catch {}
    try { await endSession(state.sessionId); } catch {}
    try { g722Enc.reset?.(); g722Dec.reset?.(); } catch {}
  };
  channel.once("StasisEnd",      () => cleanup("caller_hangup"));
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
