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
    "You are the friendly phone-order taker for Sweet Spot, a UK dessert shop.",
    "Speak warmly and briefly. Use British English. Prices are in pounds and pence.",
    "Workflow: greet → take order → confirm each item as you add it → ask for the customer's name → read the cart back with the total → call confirm_order when they say 'that's it' / 'all done' / similar.",
    "Tools:",
    "- Always use add_item for any item the caller asks for; never assume a size — if the item has variants, ASK which size before adding.",
    "- Use remove_item if they change their mind.",
    "- Use set_customer_name as soon as you hear their name.",
    "- Use read_back_cart before confirming.",
    "- Use confirm_order ONLY after they explicitly indicate they're done.",
    "After confirm_order succeeds, tell the caller their receipt number (spell each character) and total, say collection is about 15 minutes, payment on collection, then say goodbye.",
    "If asked for something not on the menu, apologise and suggest the closest match.",
    "",
    "MENU:",
    menuForPrompt(),
  ].join("\n");
}

// Linear resampling between 16k and 24k (PCM16 LE).
function resamplePCM16(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const inSamples = input.length / 2;
  const outSamples = Math.floor(inSamples * toRate / fromRate);
  const out = Buffer.alloc(outSamples * 2);
  const ratio = inSamples / outSamples;
  for (let i = 0; i < outSamples; i++) {
    const srcF = i * ratio;
    const i0 = Math.floor(srcF);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const t = srcF - i0;
    const s0 = input.readInt16LE(i0 * 2);
    const s1 = input.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 * (1 - t) + s1 * t), i * 2);
  }
  return out;
}

export function openOpenAIRealtime({ state, onAudioToCaller, onClose }) {
  const ws = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let audioOutBuf = []; // queued PCM16 24k chunks from model

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
        const pcm24 = Buffer.from(msg.delta, "base64");
        // ── AUDIO PATH DEBUG (model → bridge) ─────────────────────────
        // OpenAI Realtime emits PCM16 LE @ 24kHz. Asterisk externalMedia is
        // configured for slin24, so we forward verbatim — no resampling.
        if (!openOpenAIRealtime._audDbg) openOpenAIRealtime._audDbg = { n: 0, bytesIn: 0, bytesOut: 0, t0: Date.now() };
        const d = openOpenAIRealtime._audDbg;
        d.n++; d.bytesIn += pcm24.length; d.bytesOut += pcm24.length;
        if (d.n <= 3) {
          const inSamples = pcm24.length / 2;
          console.log(
            `[ai-audio] delta#${d.n} PCM16@24k bytes=${pcm24.length} samples=${inSamples} ms=${(inSamples/24).toFixed(1)} ` +
            `frames20ms=${(pcm24.length/960).toFixed(2)} (passthrough, no resample)`
          );
        }
        const dt = Date.now() - d.t0;
        if (dt >= 5000) {
          console.log(
            `[ai-audio] 5s summary deltas=${d.n} ${d.bytesIn}B@24k passthrough ` +
            `(${(d.bytesIn/2/24/1000).toFixed(2)}s audio) rate=${(d.n/(dt/1000)).toFixed(1)} deltas/s`
          );
          d.n = 0; d.bytesIn = 0; d.bytesOut = 0; d.t0 = Date.now();
        }
        onAudioToCaller(pcm24);
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
      // Asterisk now sends us slin24 (PCM16 LE @ 24kHz) directly — forward verbatim.
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm16Slin.toString("base64") }));
    },
    close() { try { ws.close(); } catch {} },
  };
}