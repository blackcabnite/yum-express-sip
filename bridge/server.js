// Sweet Spot voice bridge: Asterisk ARI <-> OpenAI Realtime.
// Asterisk leg: G.722 @ 16 kHz wideband, RTP PT=9 (static).
// OpenAI leg:   slin16 LE @ 16 kHz (same rate as G.722 PCM — no resampling).
// G.722 RFC 3551 quirk: RTP timestamp clock is 8 kHz even though audio is 16 kHz.
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
const MAX_QUEUE_FRAMES   = 75;     // 1.5s @ 50fps — keep latency low for phone agent

const AST_FORMAT    = process.env.AST_FORMAT || "g722";
const FORCED_RTP_PT = process.env.RTP_PT ? parseInt(process.env.RTP_PT, 10) : 9;

const RTP_PORT_TOP          = RTP_PORT_BASE + 200;
const REMOTE_TIMEOUT_MS     = 5000;
const AUDIO_IDLE_TIMEOUT_MS = 45000;
const CALL_MAX_DURATION_MS  = 15 * 60 * 1000;

// Set-based port allocator — no collisions between concurrent calls.
const portsInUse = new Set();
function pickRtpPort() {
  for (let p = RTP_PORT_BASE; p < RTP_PORT_TOP; p += 2) {
    if (!portsInUse.has(p)) { portsInUse.add(p); return p; }
  }
  throw new Error(`no free RTP port in ${RTP_PORT_BASE}-${RTP_PORT_TOP}`);
}
function releaseRtpPort(p) { portsInUse.delete(p); }

// Active sessions — used for graceful SIGTERM/SIGINT drain.
const sessions = new Set();

// ---------- RTP helpers -------------------------------------------
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

// ---------- Per-call handler --------------------------------------
async function handleCall(ari, channel) {
  const tag = `[${channel.id.slice(-6)}]`;
  const callerMsisdn = channel.caller?.number || null;
  const startedAt = Date.now();
  console.log(`${tag} [call] start ch=${channel.id} caller=${callerMsisdn} astFormat=${AST_FORMAT} pt=${FORCED_RTP_PT}`);

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
  console.log(`${tag} [rtp] listening udp4 0.0.0.0:${localPort}`);

  let remote     = null;
  const remotePt = FORCED_RTP_PT;     // 9 = G.722
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
    console.log(`${tag} [ari] externalMedia ${externalChan.id} -> ${PUBLIC_HOST}:${localPort} format=${AST_FORMAT} pt=${remotePt}`);
  } catch (e) {
    console.error(`${tag} [call] externalMedia failed`, e.message);
    await channel.hangup().catch(() => {});
    sock.close();
    releaseRtpPort(localPort);
    return;
  }

  try {
    const remoteAddr = (await getChannelVar(ari, externalChan.id, "UNICASTRTP_LOCAL_ADDRESS")) || "127.0.0.1";
    const remotePort = await getChannelVar(ari, externalChan.id, "UNICASTRTP_LOCAL_PORT");
    if (remotePort) {
      remote = { address: remoteAddr, port: parseInt(remotePort, 10) };
      console.log(`${tag} [rtp] seeded remote ${remote.address}:${remote.port}`);
    }
  } catch (e) {
    console.warn(`${tag} [rtp] channelvar lookup failed: ${e.message}`);
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
  let partialOutbound = Buffer.alloc(0);   // leftover slin16 16k bytes (< 640)
  let lastAudioActivityAt = Date.now();

  function enqueueOutbound(pcm16Slin16k) {
    lastAudioActivityAt = Date.now();
    const combined  = partialOutbound.length ? Buffer.concat([partialOutbound, pcm16Slin16k]) : pcm16Slin16k;
    const remainder = combined.length % FRAME_BYTES_SLIN16;
    const usable    = combined.length - remainder;
    partialOutbound = remainder ? combined.slice(usable) : Buffer.alloc(0);

    for (let off = 0; off < usable; off += FRAME_BYTES_SLIN16) {
      const slin16Frame = combined.slice(off, off + FRAME_BYTES_SLIN16);  // 640 B = 320 samples 16k PCM
      const g722Frame   = g722Enc.encode(slin16Frame);                    // -> 160 B G.722
      if (outQueue.length >= MAX_QUEUE_FRAMES) { outQueue.shift(); droppedFrames++; }
      outQueue.push(g722Frame);
    }
    startPacer();
  }

  function startPacer() {
    if (pacerTimer) return;
    nextSendAt = Date.now();
    pacerTimer = setInterval(() => {
      if (!remote) return;
      const now = Date.now();
      if (now - nextSendAt > 200) nextSendAt = now;
      // One packet per tick — never burst. 5ms tick still drains 20ms frames
      // fast enough; queue grows during AI bursts, drains 1 pkt / 5 ms until caught up.
      if (outQueue.length > 0 && now >= nextSendAt) {
        const slice = outQueue.shift();
        const pkt = buildRtpPacket({ seq: seq++, ts, ssrc, payload: slice, pt: remotePt });
        ts = (ts + TS_INC_PER_FRAME) >>> 0;
        sock.send(pkt, remote.port, remote.address, (e) => {
          if (e) console.error(`${tag} [rtp] send err`, e.message);
        });
        outboundCount++;
        if (!firstSentLogged) {
          console.log(
            `${tag} [rtp] FIRST paced packet -> ${remote.address}:${remote.port} ` +
            `pt=${remotePt} payload=${slice.length}B header=12B total=${pkt.length}B ` +
            `ts_inc=${TS_INC_PER_FRAME}/pkt seq=${(seq - 1) & 0xffff} ssrc=0x${ssrc.toString(16)}`
          );
          firstSentLogged = true;
        }
        nextSendAt += FRAME_MS;
      }
    }, 5);
  }

  const oa = openOpenAIRealtime({
    state,
    onAudioToCaller(pcm16Slin16k) {
      if (!remote) return;
      enqueueOutbound(pcm16Slin16k);
    },
    // Barge-in: caller started speaking → drop queued AI audio so it stops mid-sentence.
    // Requires openai.js to fire this on input_audio_buffer.speech_started. If older
    // openai.js doesn't call it, no harm — just no barge-in.
    onCallerSpeechStarted() {
      if (outQueue.length > 0) {
        console.log(`${tag} [barge-in] dropped ${outQueue.length} queued frames`);
        outQueue.length = 0;
        partialOutbound = Buffer.alloc(0);
      }
    },
    onClose() {},
  });

  // ---------- inbound: RTP G.722 -> slin16 16k -> OpenAI ----------
  let rxBytes = 0;
  let rxPackets = 0;
  const rxTimer = setInterval(() => {
    console.log(
      `${tag} [rtp] hb caller->bridge ${rxPackets}p ${rxBytes}b ` +
      `(avg ${rxPackets ? (rxBytes / rxPackets).toFixed(0) : 0}B/pkt, ${(rxPackets / 5).toFixed(1)} pps) | ` +
      `bridge->caller ${outboundCount}p sent · ${outQueue.length} queued · ${droppedFrames} dropped · pt=${remotePt}`
    );
    rxBytes = 0; rxPackets = 0;
  }, 5000);

  sock.on("message", (pkt, rinfo) => {
    if (!remote) {
      remote = rinfo;
      console.log(`${tag} [rtp] no seeded remote; using inbound source ${rinfo.address}:${rinfo.port}`);
    }
    const payload = rtpPayload(pkt);
    if (!payload || !payload.length) return;
    rxBytes += payload.length;
    rxPackets++;
    // G.722 -> slin16 LE @ 16 kHz, straight to OpenAI
    const slin16Buf = g722Dec.decode(payload);
    lastAudioActivityAt = Date.now();
    oa.pushCallerAudio(slin16Buf);
  });

  // ---------- Watchdogs ----------
  const remoteWatchdog = setTimeout(() => {
    if (!remote) console.warn(`${tag} [⚠] no remote address after ${REMOTE_TIMEOUT_MS}ms — TX won't send`);
  }, REMOTE_TIMEOUT_MS);
  const idleWatchdog = setInterval(() => {
    const idle = Date.now() - lastAudioActivityAt;
    if (idle > AUDIO_IDLE_TIMEOUT_MS) {
      console.warn(`${tag} [⚠] no audio activity for ${(idle/1000).toFixed(0)}s — pipeline may be stuck`);
    }
  }, 10000);
  const maxDurationWatchdog = setTimeout(() => {
    console.warn(`${tag} [⚠] hit max duration ${CALL_MAX_DURATION_MS/60000}m — hanging up`);
    cleanup("max_duration");
  }, CALL_MAX_DURATION_MS);

  const sess = { tag, cleanup: null };
  sessions.add(sess);
  let cleaned = false;
  const cleanup = async (why) => {
    if (cleaned) return;
    cleaned = true;
    const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`${tag} [call] end (${why}) dur=${dur}s · sent ${outboundCount}p queued=${outQueue.length} dropped=${droppedFrames}`);
    clearInterval(rxTimer);
    clearInterval(idleWatchdog);
    clearTimeout(remoteWatchdog);
    clearTimeout(maxDurationWatchdog);
    if (pacerTimer) clearInterval(pacerTimer);
    try { oa.close(); } catch {}
    try { sock.close(); } catch {}
    releaseRtpPort(localPort);
    try { await bridge.destroy(); } catch {}
    try { await externalChan.hangup(); } catch {}
    try { await logEvent(state.sessionId, "call_end", why); } catch {}
    try { await endSession(state.sessionId); } catch {}
    try { g722Enc.reset?.(); g722Dec.reset?.(); } catch {}
    sessions.delete(sess);
  };
  sess.cleanup = cleanup;
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
  ari.on("WebSocketReconnecting", () => console.warn("[ari] ws reconnecting"));
  ari.on("WebSocketConnected",    () => console.log("[ari] ws connected"));
  ari.on("WebSocketMaxRetries",   () => {
    console.error("[ari] ws gave up — exiting (systemd will restart)");
    process.exit(1);
  });
  await ari.start(APP_NAME);
  console.log(`[bridge] listening as ARI app "${APP_NAME}"`);

  // Graceful shutdown — drain active calls before exit
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      console.log(`[bridge] ${sig} — draining ${sessions.size} active session(s)`);
      for (const s of sessions) {
        try { await s.cleanup(`shutdown_${sig}`); } catch {}
      }
      process.exit(0);
    });
  }
}

main().catch((e) => { console.error("[bridge] fatal", e); process.exit(1); });

// ---------- admin HTTP (codec switch) ----------
import http from 'node:http';
import { execFile } from 'node:child_process';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ADMIN_PORT  = parseInt(process.env.ADMIN_PORT || '8090', 10);
const SWITCH_SH   = '/opt/sweetspot-voice/bridge/asterisk/switch-codec.sh';

http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const auth = req.headers.authorization || '';
  if (ADMIN_TOKEN && auth !== `Bearer ${ADMIN_TOKEN}`) return send(401, { error: 'unauthorized' });
  if (req.url !== '/admin/codec') return send(404, { error: 'not found' });

  if (req.method === 'GET') {
    execFile('sudo', [SWITCH_SH, 'status'], (err, stdout) => {
      if (err) return send(500, { mode: 'unknown', error: String(err) });
      const m = /pjsip\.opus\.conf/.test(stdout) ? 'opus'
              : /pjsip\.conf/.test(stdout)      ? 'g722'
              : 'unknown';
      send(200, { ok: true, mode: m, log: stdout.trim() });
    });
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      let mode;
      try { mode = JSON.parse(body).mode; } catch { return send(400, { error: 'bad json' }); }
      if (mode !== 'opus' && mode !== 'g722') return send(400, { error: 'mode must be opus|g722' });
      execFile('sudo', [SWITCH_SH, mode], (err, stdout, stderr) => {
        if (err) return send(500, { ok: false, error: String(err), log: stderr });
        send(200, { ok: true, mode, log: stdout.trim() });
      });
    });
    return;
  }

  send(405, { error: 'method not allowed' });
}).listen(ADMIN_PORT, '0.0.0.0', () => console.log(`[admin] listening on :${ADMIN_PORT}`));
