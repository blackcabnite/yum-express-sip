// Sweet Spot voice bridge: Asterisk ARI <-> OpenAI Realtime.
import "dotenv/config";
import ariClient from "ari-client";
import dgram from "node:dgram";
import net from "node:net";
import { createSession, endSession, logEvent } from "./supabase.js";
import { newCallState } from "./tools.js";
import { openOpenAIRealtime } from "./openai.js";

const ARI_URL = process.env.ARI_URL || "http://127.0.0.1:8088";
const ARI_USER = process.env.ARI_USER || "sweetspot";
const ARI_PASS = process.env.ARI_PASS;
const APP_NAME = "sweetspot";
const PUBLIC_HOST = process.env.PUBLIC_HOST || "127.0.0.1"; // Asterisk reaches us here
const RTP_PORT_BASE = 14000;
let nextPort = RTP_PORT_BASE;

function pickRtpPort() {
  const p = nextPort;
  nextPort = nextPort + 2;
  if (nextPort > RTP_PORT_BASE + 200) nextPort = RTP_PORT_BASE;
  return p;
}

// Strip 12-byte RTP header → return PCM16 payload (slin16).
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

// Build a minimal RTP packet for slin16 (96 dynamic) — Asterisk ExternalMedia accepts this fine.
function buildRtpPacket({ seq, ts, ssrc, payload, pt = 96 }) {
  const hdr = Buffer.alloc(12);
  hdr[0] = 0x80;
  hdr[1] = pt & 0x7f;
  hdr.writeUInt16BE(seq & 0xffff, 2);
  hdr.writeUInt32BE(ts >>> 0, 4);
  hdr.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([hdr, payload]);
}

async function handleCall(ari, channel) {
  const callerMsisdn = channel.caller?.number || null;
  console.log(`[call] start ch=${channel.id} caller=${callerMsisdn}`);

  const session = await createSession({ callerMsisdn, channelId: channel.id });
  const state = newCallState({ sessionId: session.id, callerMsisdn });
  await logEvent(session.id, "call_start", null, { channel_id: channel.id, caller: callerMsisdn });

  // 1) Open UDP socket for our side of the external-media RTP.
  const localPort = pickRtpPort();
  const sock = dgram.createSocket("udp4");
  await new Promise((res, rej) => {
    sock.once("error", rej);
    sock.bind(localPort, "0.0.0.0", () => res());
  });

  let remote = null;
  let remotePt = 118; // Asterisk's slin16 dynamic PT — learned from first inbound packet
  let outboundPcm = Buffer.alloc(0);
  let seq = Math.floor(Math.random() * 65535);
  let ts = 0;
  const ssrc = Math.floor(Math.random() * 0xffffffff);

  // 2) Create the ExternalMedia channel (Asterisk dials us back over RTP).
  let externalChan;
  try {
    externalChan = await ari.channels.externalMedia({
      app: APP_NAME,
      external_host: `${PUBLIC_HOST}:${localPort}`,
      format: "slin16",
    });
  } catch (e) {
    console.error("[call] externalMedia failed", e.message);
    await channel.hangup().catch(() => {});
    sock.close();
    return;
  }

  // 3) Bridge the caller channel <-> external-media channel.
  const bridge = ari.Bridge();
  await bridge.create({ type: "mixing" });
  await bridge.addChannel({ channel: [channel.id, externalChan.id] });

  // 4) OpenAI Realtime session — pipes audio both ways.
  const oa = openOpenAIRealtime({
    state,
    onAudioToCaller(pcm16Slin) {
      if (!remote) return;
      outboundPcm = Buffer.concat([outboundPcm, pcm16Slin]);
      // Chunk to 20ms frames @ 16kHz = 320 samples = 640 bytes.
      const FRAME = 640;
      while (outboundPcm.length >= FRAME) {
        const slice = outboundPcm.slice(0, FRAME);
        outboundPcm = outboundPcm.slice(FRAME);
        const pkt = buildRtpPacket({ seq: seq++, ts, ssrc, payload: slice, pt: remotePt });
        ts = (ts + 320) >>> 0;
        sock.send(pkt, remote.port, remote.address, (e) => { if (e) console.error("[rtp] send", e.message); });
      }
    },
    onClose() { /* handled by hangup */ },
  });

  // 5) Caller audio in → OpenAI.
  let rxBytes = 0;
  let rxPackets = 0;
  const rxTimer = setInterval(() => {
    if (rxPackets) console.log(`[rtp] caller→bridge ${rxPackets} pkts / ${rxBytes} bytes (last 5s)`);
    rxBytes = 0; rxPackets = 0;
  }, 5000);
  sock.on("message", (pkt, rinfo) => {
    if (!remote) {
      remote = rinfo;
      if (pkt.length >= 2) remotePt = pkt[1] & 0x7f;
      console.log(`[rtp] remote ${rinfo.address}:${rinfo.port} pt=${remotePt}`);
    }
    const payload = rtpPayload(pkt);
    if (payload && payload.length) {
      rxBytes += payload.length;
      rxPackets++;
      oa.pushCallerAudio(payload);
    }
  });

  // 6) Cleanup on hangup.
  const cleanup = async (why) => {
    console.log(`[call] end ch=${channel.id} (${why})`);
    clearInterval(rxTimer);
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
    // Skip the external-media channel itself
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