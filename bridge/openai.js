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
    "- When the caller orders something, IMMEDIATELY call add_item. If it has size variants and they didn't say, ASK first ('small, regular, or large?') — never guess.",
    "- Default size for sized items (waffle / cookie dough) is Regular only if the caller explicitly says 'whatever' or 'normal'.",
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
  const s = state || { pos: 0, last: 0 };     // pos is fractional index into "virtual" stream that includes prev.last at index -1
  // Build a small helper: sample at integer index i where -1 returns s.last
  const readAt = (i) => {
    if (i < 0) return s.last;
    if (i >= inSamples) return input.readInt16LE((inSamples - 1) * 2);
    return input.readInt16LE(i * 2);
  };
  // Determine how many output samples we can produce while staying within available input.
  // pos starts somewhere in [0, 1). Last usable srcF is inSamples - 1 (so i1 = inSamples-1).
  const outSamples = Math.max(0, Math.floor((inSamples - 1 - s.pos) / ratio) + 1);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcF = s.pos + i * ratio;
    const i0 = Math.floor(srcF);
    const i1 = i0 + 1;
    const t = srcF - i0;
    const v = Math.round(readAt(i0) * (1 - t) + readAt(i1) * t);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  // Advance position past consumed input; carry remainder into next call.
  const consumedF = s.pos + outSamples * ratio;
  const newState = {
    pos: consumedF - inSamples,               // negative → next call's pos relative to its input start
    last: input.readInt16LE((inSamples - 1) * 2),
  };
  // Normalize: pos should be in [0, 1) at start of next chunk. Because we read
  // s.last at index -1, a pos of e.g. -0.3 means "next output sits 0.3 samples
  // before the new chunk's first sample" → represent as pos=0.7 with last=prev.
  if (newState.pos < 0) newState.pos = newState.pos + 1; // shift by 1 sample (the carried last)
  return { out, state: newState };
}

export function openOpenAIRealtime({ state, onAudioToCaller, onClose }) {
  const ws = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // Per-direction resampler state (carried across deltas to avoid boundary clicks).
  let downState = null;   // 24k → 16k (model → caller)
  let upState = null;     // 16k → 24k (caller → model)
  // Skip first ~40ms of each model response — OpenAI's first delta sometimes
  // contains a brief audio glitch (pop/click) before the voice properly starts.
  const SKIP_BYTES_PER_RESPONSE = 24000 * 2 * 0.04; // 40ms @ 24kHz PCM16 = 1920B
  let skipRemaining = 0;

  ws.on("open", () => {
    ws.send(JSON.stringify({
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
    }));
    // Greet the caller immediately
    ws.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio", "text"], instructions: "Greet the caller warmly: 'Hi, you've reached Sweet Spot — what can I get for you today?'" },
    }));
  });

  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case "response.audio.delta": {
        let pcm24 = Buffer.from(msg.delta, "base64");
        if (skipRemaining > 0) {
          const drop = Math.min(skipRemaining, pcm24.length);
          pcm24 = pcm24.slice(drop);
          skipRemaining -= drop;
          if (pcm24.length === 0) break;
        }
        // OpenAI emits PCM16 LE @ 24 kHz. Asterisk on this VPS has no
        // slin24 translation paths, so resample down to 16 kHz (slin16).
        const r = resamplePCM16(pcm24, 24000, 16000, downState);
        downState = r.state;
        const pcm16 = r.out;
        if (pcm16.length === 0) break;
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
        // New response starting — arm the leading-glitch skip and reset
        // resampler state so we don't interpolate into stale samples.
        skipRemaining = SKIP_BYTES_PER_RESPONSE;
        downState = null;
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
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id, output: JSON.stringify(result) },
        }));
        ws.send(JSON.stringify({ type: "response.create" }));
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
      // Asterisk sends slin16 (PCM16 LE @ 16kHz). Resample up to 24kHz for OpenAI Realtime.
      const r = resamplePCM16(pcm16Slin, 16000, 24000, upState);
      upState = r.state;
      const pcm24 = r.out;
      if (pcm24.length === 0) return;
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm24.toString("base64") }));
    },
    close() { try { ws.close(); } catch {} },
  };
}