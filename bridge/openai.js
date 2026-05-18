// OpenAI Realtime API WebSocket session.
// Audio in/out: PCM16 @ 24kHz (we resample to/from Asterisk's slin16 16kHz).
import WebSocket from "ws";
import { TOOL_SCHEMAS, execTool } from "./tools.js";
import { menuForPrompt } from "./menu.js";
import { logEvent, updateSession } from "./supabase.js";

const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17"}`;
const VOICE = process.env.VOICE || "coral";

function systemPrompt() {
  return [
    "You are Ada, the Sweet Spot Cafe's phone-ordering assistant.",
    "",
    "PERSONA: Casual, brief, fast — like a friendly human dispatcher. ONE short sentence per turn. No filler. British English.",
    "",
    "MENU (this is the COMPLETE menu — never invent items not listed):",
    menuForPrompt(),
    "",
    "CORE RULES",
    "- When the caller orders something, IMMEDIATELY call add_item. DO NOT ask about size — the greeting tells the caller all prices are Regular by default. Only use a non-Regular size if the caller themselves volunteers the word 'small' or 'large' as part of their order.",
    "- SIZES ARE FIXED: EVERY waffle and EVERY cookie dough comes in exactly three sizes — Small (£5.25), Regular (£6.45), Large (£7.95). If the caller asks what sizes are available, tell them all three. Never invent a 2-size answer.",
    "- DEFAULT SIZE = Regular. Pass size: 'Reg' to add_item unless the caller said 'small' or 'large'. Do NOT ask 'small, regular, or large?' — silently use Regular.",
    "- After each add, read the running total spoken as words ('six pounds and forty-five pence', never the £ symbol).",
    "- After at least one item, ask 'Anything else?' — UNLESS you owe the caller a follow-up question first.",
    "- Cookie Dough → ALWAYS ask base flavour: 'milk, white, or double chocolate?'.",
    "- Milkshake → ALWAYS ask: 'with whipped cream, yes or no?'.",
    "- If the caller asks for the menu, say 'I'll send it to your phone' — do NOT read it out loud.",
    "- If you hear a name like 'I'm John' or 'this is Sarah', call set_customer_name immediately. Do not invent names.",
    "- When the caller closes ('that's it', 'that's all', 'nothing else', 'place the order'), call read_back_cart, read it back, then call confirm_order.",
    "- After confirm_order succeeds: tell the caller their receipt number (spell each character), the total in words, collection in about 15 minutes, payment on collection, then say goodbye.",
    "",
    "NEVER",
    "- Never guess. Never auto-correct what the caller said.",
    "- Never say the £ symbol — always speak currency as words.",
    "- Never read the full menu out loud.",
    "- Never invent items, flavours, sizes, or prices.",
    "- If the caller asks for something not on the menu, apologise once and suggest the closest match from the menu above.",
  ].join("\n");
}

// Stateful linear resampler (PCM16 LE). Keeps the last input sample and a
// fractional read position across calls so chunk boundaries don't click.
// Returns { out, state } where state must be passed back in next call.
function resamplePCM16(input, fromRate, toRate, state) {
  if (fromRate === toRate) return { out: input, state };
  const inSamples = input.length / 2;
  if (inSamples === 0) return { out: Buffer.alloc(0), state };

  const ratio = fromRate / toRate;            // input samples per output sample
  const prev = state?.prev ?? input.readInt16LE(0);
  let phase = state?.phase ?? 0;              // fractional source position carried across chunks
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

// ─── Anti-alias low-pass (11-tap Hann-windowed sinc) ────────────────────────
// Applied to 24 kHz PCM16 BEFORE decimation to 16 kHz. Without it, energy
// above ~7 kHz folds back as aliasing → audible "trail"/lispy hiss after AI
// speech (especially on sibilants). Coefficients precomputed for fc=7kHz @
// 24kHz sample rate. State carries the last (N-1) samples across calls so
// chunk boundaries don't click.
const LPF_TAPS = (() => {
  const N = 11;                          // odd → linear phase, integer group delay = 5
  const fc = 7000 / 24000;               // normalized cutoff (cycles/sample)
  const M = (N - 1) / 2;
  const h = new Float32Array(N);
  let sum = 0;
  for (let n = 0; n < N; n++) {
    const k = n - M;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
    h[n] = sinc * hann;
    sum += h[n];
  }
  for (let n = 0; n < N; n++) h[n] /= sum;   // unity DC gain
  return h;
})();
const LPF_N = LPF_TAPS.length;

function lowpassPCM16(input, state) {
  const inSamples = input.length / 2;
  if (inSamples === 0) return { out: input, state };
  const hist = state?.hist ?? new Int16Array(LPF_N - 1); // zeros on first call
  const total = hist.length + inSamples;
  const buf = new Int16Array(total);
  for (let i = 0; i < hist.length; i++) buf[i] = hist[i];
  for (let i = 0; i < inSamples; i++) buf[hist.length + i] = input.readInt16LE(i * 2);

  const out = Buffer.alloc(inSamples * 2);
  for (let i = 0; i < inSamples; i++) {
    let acc = 0;
    // Convolution: y[i] = Σ h[k] * x[i + (N-1) - k]   (so output aligns with newest sample chain)
    for (let k = 0; k < LPF_N; k++) acc += LPF_TAPS[k] * buf[i + (LPF_N - 1 - k)];
    const v = Math.max(-32768, Math.min(32767, Math.round(acc)));
    out.writeInt16LE(v, i * 2);
  }

  const newHist = new Int16Array(LPF_N - 1);
  for (let i = 0; i < newHist.length; i++) newHist[i] = buf[total - newHist.length + i];
  return { out, state: { hist: newHist } };
}

// ─── Caller-side audio conditioning ─────────────────────────────────────────
// Applied to incoming slin16 (16 kHz PCM16 from Asterisk) BEFORE upsampling
// to 24 kHz for OpenAI. Three stages, all stateful across chunks:
//   1) One-pole high-pass (~60 Hz) — kills line rumble / DC offset.
//   2) Soft-knee noise gate — attenuates background noise gradually instead
//      of hard-cutting (preserves soft consonants like 's', 'f', 'th').
//   3) Smoothed RMS auto-gain — boosts quiet talkers toward a target RMS
//      without pumping. Gain change is rate-limited per chunk.
// Ported from the Python taxi bridge; tuned for 16 kHz instead of 8 kHz.

// One-pole HPF coefficient: a = exp(-2π * fc / fs), fc=60Hz @ 16kHz ≈ 0.9765
const HPF_A = Math.exp((-2 * Math.PI * 60) / 16000);

// Noise-gate thresholds (PCM16 amplitude units)
const GATE_LOW = 25;        // below this: heavy attenuation
const GATE_HIGH = 75;       // above this: pass through
const GATE_FLOOR = 0.15;    // residual gain below the knee (not zero — keeps room tone natural)

// AGC
const AGC_TARGET_RMS = 2500;
const AGC_MIN = 0.8;
const AGC_MAX = 3.0;
const AGC_SMOOTH = 0.2;     // 0..1, higher = faster gain tracking
const AGC_RMS_FLOOR = 30;   // don't apply gain to near-silence

// ─── Output-side noise gate (model → caller) ────────────────────────────────
// G.722 ADPCM amplifies low-level noise into an audible hash, especially
// during pauses between words. Compute per-frame RMS and zero the frame if
// it's below threshold. Stateful with HANGOVER: once a loud sub-frame
// opens the gate, it stays open for HOLD_FRAMES quiet frames so the
// natural decay/tail of each word passes through (no end-of-sentence
// clipping). Processes in 20ms (640-byte @ 16 kHz mono PCM16) sub-frames.
const OUT_GATE_RMS    = 200;   // open threshold (↑ less hiss, ↓ softer onsets)
const OUT_GATE_HOLD   = 12;    // sub-frames to stay open after last loud frame (~240ms)
const OUT_FRAME_BYTES = 640;   // 20ms @ 16 kHz, 16-bit mono
function outputNoiseGate(pcm16, state) {
  if (pcm16.length === 0) return { out: pcm16, state: state || { hold: 0 } };
  let hold = state?.hold ?? 0;
  const out = Buffer.alloc(pcm16.length);
  for (let off = 0; off < pcm16.length; off += OUT_FRAME_BYTES) {
    const end = Math.min(off + OUT_FRAME_BYTES, pcm16.length);
    const n = (end - off) / 2;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const s = pcm16.readInt16LE(off + i * 2);
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / n);
    if (rms >= OUT_GATE_RMS) {
      hold = OUT_GATE_HOLD;
      pcm16.copy(out, off, off, end);
    } else if (hold > 0) {
      hold--;
      pcm16.copy(out, off, off, end);
    } // else leave zeros (Buffer.alloc default)
  }
  return { out, state: { hold } };
}

function conditionCallerPCM16(input, state) {
  const n = input.length / 2;
  if (n === 0) return { out: input, state };

  // HPF state carried across chunks
  let hpfPrevIn = state?.hpfPrevIn ?? 0;
  let hpfPrevOut = state?.hpfPrevOut ?? 0;
  let gain = state?.gain ?? 1.0;

  // Stage 1: HPF, write to float buffer
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = input.readInt16LE(i * 2);
    const y = HPF_A * (hpfPrevOut + x - hpfPrevIn);
    f[i] = y;
    hpfPrevIn = x;
    hpfPrevOut = y;
  }

  // Stage 2: soft-knee gate
  for (let i = 0; i < n; i++) {
    const a = Math.abs(f[i]);
    let g;
    if (a >= GATE_HIGH) g = 1.0;
    else if (a <= GATE_LOW) g = GATE_FLOOR;
    else {
      const t = (a - GATE_LOW) / (GATE_HIGH - GATE_LOW); // 0..1
      g = GATE_FLOOR + (1.0 - GATE_FLOOR) * t;
    }
    f[i] *= g;
  }

  // Stage 3: smoothed AGC
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += f[i] * f[i];
  const rms = Math.sqrt(sumSq / n);
  if (rms > AGC_RMS_FLOOR) {
    const target = Math.max(AGC_MIN, Math.min(AGC_MAX, AGC_TARGET_RMS / rms));
    gain = gain + AGC_SMOOTH * (target - gain);
    for (let i = 0; i < n; i++) f[i] *= gain;
  }

  // Pack back to PCM16 with clipping
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(f[i])));
    out.writeInt16LE(v, i * 2);
  }

  return { out, state: { hpfPrevIn, hpfPrevOut, gain } };
}

export function openOpenAIRealtime({ state, onAudioToCaller, onCallerSpeechStarted, onClose }) {
  const ws = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // Per-direction resampler state (carried across deltas to avoid boundary clicks).
  let downState = null;   // 24k → 16k (model → caller)
  let upState = null;     // 16k → 24k (caller → model)
  let lpfState = null;    // anti-alias LPF state for 24k → 16k path
  let condState = null;   // caller-side conditioning state (HPF + gate + AGC)
  // Skip first ~40ms of each model response — OpenAI's first delta sometimes
  // contains a brief audio glitch (pop/click) before the voice properly starts.
  const SKIP_BYTES_PER_RESPONSE = 24000 * 2 * 0.04; // 40ms @ 24kHz PCM16 = 1920B
  let skipRemaining = 0;
  let activeResponseId = null;

  function sendSafe(obj) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  ws.on("open", () => {
    sendSafe({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: VOICE,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        instructions: systemPrompt(),
        turn_detection: { type: "server_vad", threshold: 0.3, prefix_padding_ms: 300, silence_duration_ms: 700 },
        input_audio_transcription: { model: "whisper-1" },
        tools: TOOL_SCHEMAS,
        tool_choice: "auto",
        temperature: 0.7,
      },
    });
    // Greet the caller immediately
    sendSafe({
      type: "response.create",
      response: { modalities: ["audio", "text"], instructions: "Greet the caller warmly with EXACTLY this line, nothing more: 'Hi, you've reached Sweet Spot — all prices are based on the regular size unless you ask for a small or large. What can I get for you today?'" },
    });
  });

  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case "response.audio.delta": {
        let pcm24 = Buffer.from(msg.delta, "base64");
        // OpenAI emits PCM16 LE @ 24 kHz. Asterisk on this VPS has no
        // slin24 translation paths, so resample down to 16 kHz (slin16).
        // Anti-alias LPF (fc=7 kHz) applied BEFORE decimation — without it
        // energy above 8 kHz folds back as a constant high-freq hiss that
        // G.722's ADPCM then encodes audibly. State is persistent for the
        // whole call (NEVER reset per-response) so chunk boundaries stay
        // glitch-free.
        const lp = lowpassPCM16(pcm24, lpfState);
        lpfState = lp.state;
        const r = resamplePCM16(lp.out, 24000, 16000, downState);
        downState = r.state;
        let pcm16 = r.out;
        if (pcm16.length === 0) break;
        // Output noise gate: silence between words is encoded as low-level
        // noise by both OpenAI and G.722 — gate frames whose RMS is below
        // ~250 to true zero so the caller hears clean silence (Asterisk
        // fills with comfort noise). Threshold is conservative; raise to
        // 400 if hiss persists, lower to 150 if soft consonants get cut.
        pcm16 = outputNoiseGate(pcm16);
        if (!openOpenAIRealtime._audDbg) openOpenAIRealtime._audDbg = { n: 0, bytesIn: 0, bytesOut: 0, t0: Date.now() };
        const d = openOpenAIRealtime._audDbg;
        d.n++; d.bytesIn += pcm24.length; d.bytesOut += pcm16.length;
        if (d.n <= 3) {
          console.log(
            `[ai-audio] delta#${d.n} 24k=${pcm24.length}B → 16k=${pcm16.length}B ` +
            `frames20ms=${(pcm16.length/640).toFixed(2)}`
          );
        }
        const dt = Date.now() - d.t0;
        if (dt >= 5000) {
          console.log(
            `[ai-audio] 5s deltas=${d.n} in=${d.bytesIn}B@24k out=${d.bytesOut}B@16k ` +
            `(${(d.bytesOut/2/16/1000).toFixed(2)}s audio) rate=${(d.n/(dt/1000)).toFixed(1)}/s`
          );
          d.n = 0; d.bytesIn = 0; d.bytesOut = 0; d.t0 = Date.now();
        }
        onAudioToCaller(pcm16);
        break;
      }
      case "response.created": {
        activeResponseId = msg.response?.id || null;
        // Intentionally do NOT reset downState/lpfState here. Resetting
        // mid-call restarts the resampler with phase=0 and prev=first
        // sample, which produces a small click at the start of each AI
        // turn — that was the artefact riding over the audio.
        break;
      }
      case "response.done":
      case "response.cancelled": {
        activeResponseId = null;
        break;
      }
      case "input_audio_buffer.speech_started": {
        onCallerSpeechStarted?.();
        break;
      }
      case "response.audio_transcript.done": {
        if (msg.transcript) {
          await updateSession(state.sessionId, { last_ai_line: msg.transcript });
          await logEvent(state.sessionId, "ai_speech", msg.transcript);
        }
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        if (msg.transcript) {
          await updateSession(state.sessionId, { last_caller_transcript: msg.transcript });
          await logEvent(state.sessionId, "caller_speech", msg.transcript);
        }
        break;
      }
      case "response.function_call_arguments.done": {
        const { name, call_id, arguments: argStr } = msg;
        let args = {}; try { args = JSON.parse(argStr || "{}"); } catch {}
        let result;
        try { result = await execTool(state, name, args); }
        catch (e) { result = { ok: false, error: String(e) }; }
        sendSafe({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id, output: JSON.stringify(result) },
        });
        sendSafe({ type: "response.create" });
        break;
      }
      case "error": {
        console.error("[openai] error", JSON.stringify(msg.error || msg));
        await logEvent(state.sessionId, "openai_error", msg.error?.message || "unknown", msg);
        break;
      }
    }
  });

  ws.on("close", (code, reason) => {
    console.log("[openai] closed", code, reason?.toString());
    onClose?.();
  });
  ws.on("error", (e) => console.error("[openai] ws error", e.message));

  return {
    pushCallerAudio(pcm16Slin) {
      if (ws.readyState !== WebSocket.OPEN) return;
      // Asterisk sends slin16 (PCM16 LE @ 16kHz). Condition first (HPF +
      // noise gate + AGC) to help OpenAI's VAD/transcription on soft/noisy
      // callers, THEN upsample to 24kHz for OpenAI Realtime.
      const c = conditionCallerPCM16(pcm16Slin, condState);
      condState = c.state;
      const r = resamplePCM16(c.out, 16000, 24000, upState);
      upState = r.state;
      const pcm24 = r.out;
      if (pcm24.length === 0) return;
      sendSafe({ type: "input_audio_buffer.append", audio: pcm24.toString("base64") });
    },
    cancelResponse() {
      if (!activeResponseId) return;
      sendSafe({ type: "response.cancel" });
      activeResponseId = null;
    },
    close() { try { ws.close(); } catch {} },
  };
}