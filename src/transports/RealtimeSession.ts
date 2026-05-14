// RealtimeSession — the only place WebRTC + OpenAI Realtime are touched.
//
// Security: the OpenAI API key NEVER crosses the browser. The session is
// minted by a server endpoint (Supabase edge function in prod, local Node
// in dev). Only the ephemeral client_secret is returned.

import { Emitter } from "@/domain/Emitter";
import { ResponseTracker } from "@/domain/ResponseTracker";
import { isRealtimeEvent, type RealtimeEvent, type SessionConfig, type ToolCall, type ToolName, type ToolResult } from "@/domain/types";

export interface RealtimeEvents {
  /** session.updated has been acknowledged; safe to start the greeting. */
  ready: void;
  /** Outbound AI audio track — pipe to the transport. */
  outboundAudio: { track: MediaStreamTrack };
  /** Full transcript for one AI response. */
  aiTranscript: { text: string; responseId: string };
  /** Streaming partial of AI speech. */
  aiTranscriptDelta: { delta: string; partialSoFar: string; responseId: string };
  aiAudioStarted: { responseId: string };
  aiAudioEnded: { responseId: string };
  callerTranscript: { text: string };
  callerTranscriptDelta: { delta: string; partialSoFar: string };
  callerSpeechStarted: void;
  callerSpeechStopped: void;
  toolCall: ToolCall;
  responseEnded: { responseId: string; cancelled: boolean };
  error: { message: string };
}

export class RealtimeSession {
  readonly events = new Emitter<RealtimeEvents>();
  readonly responses = new ResponseTracker();

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private partialAi = "";
  private partialCaller = "";
  private sessionConfigured = false;

  constructor(
    private readonly cfg: SessionConfig,
    /** Server-side mint. Returns ONLY the ephemeral client_secret. */
    private readonly mintSession: () => Promise<{ clientSecret: string }>,
  ) {}

  async start(callerStream: MediaStream): Promise<void> {
    const { clientSecret } = await this.mintSession();

    const pc = new RTCPeerConnection();
    this.pc = pc;

    pc.ontrack = (e) => {
      if (e.track.kind === "audio") {
        this.events.emit("outboundAudio", { track: e.track });
      }
    };

    callerStream.getTracks().forEach((t) => pc.addTrack(t, callerStream));

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onmessage = (e) => this.handleEvent(e.data);
    dc.onclose = () => this.events.emit("error", { message: "Data channel closed" });

    const dcOpen = new Promise<void>((resolve, reject) => {
      const tid = setTimeout(() => reject(new Error("DC open timeout")), 10_000);
      dc.onopen = () => { clearTimeout(tid); resolve(); };
    });

    // SDP exchange — ephemeral key, not the parent.
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpResp = await fetch(
      `https://api.openai.com/v1/realtime?model=${encodeURIComponent(this.cfg.model)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      },
    );
    if (!sdpResp.ok) throw new Error(`OpenAI SDP exchange failed: ${sdpResp.status}`);
    const answerSdp = await sdpResp.text();
    if (pc.signalingState === "closed") return; // Caller bailed mid-handshake.
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    await dcOpen;

    // Configure the session. Wait for session.updated before declaring ready —
    // prevents the greeting firing with default Whisper config.
    this.sendJson({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: this.cfg.systemPrompt,
        voice: this.cfg.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1", prompt: this.cfg.whisperBiasPrompt },
        input_audio_noise_reduction: { type: "far_field" },
        turn_detection: this.buildTurnDetection(),
        tools: this.cfg.tools,
        tool_choice: "auto",
        temperature: 0.7,
        max_response_output_tokens: "inf",
      },
    });

    await this.waitForSessionUpdated(5000);
    this.events.emit("ready", undefined);
  }

  private buildTurnDetection(): unknown {
    if (this.cfg.vad === "semantic") {
      return {
        type: "semantic_vad",
        eagerness: "low",
        create_response: true,
        interrupt_response: false,
      };
    }
    return {
      type: "server_vad",
      threshold: 0.75,
      prefix_padding_ms: 500,
      silence_duration_ms: 1150,
      create_response: true,
      interrupt_response: false,
    };
  }

  private async waitForSessionUpdated(timeoutMs: number): Promise<void> {
    if (this.sessionConfigured) return;
    await new Promise<void>((resolve, reject) => {
      const tid = setTimeout(() => reject(new Error("session.updated timeout")), timeoutMs);
      const poll = setInterval(() => {
        if (this.sessionConfigured) {
          clearTimeout(tid);
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });
  }

  /** Have the AI speak a scripted line (greeting, recovery, etc.). */
  speakScripted(line: string, opts: { maxTokens?: number } = {}): void {
    this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Say exactly this, word-for-word, then stop: "${line}"` }],
      },
    });
    if (this.responses.tryStart({ codeLed: true })) {
      this.sendJson({
        type: "response.create",
        response: {
          instructions: `Speak ONLY this verbatim: "${line}"`,
          max_output_tokens: opts.maxTokens ?? 200,
        },
      });
    }
  }

  cancelResponse(): void {
    if (!this.responses.isActive()) return;
    this.sendJson({ type: "response.cancel" });
  }

  sendToolResult(callId: string, result: ToolResult): void {
    this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ ok: result.ok, spoken: result.spoken, ...(result.debug ?? {}) }),
      },
    });
    if (result.silent || result.spoken.trim() === "") return;
    if (this.responses.tryStart({ codeLed: true })) {
      this.sendJson({ type: "response.create" });
    }
  }

  async stop(): Promise<void> {
    try { this.dc?.close(); } catch { /* noop */ }
    try { this.pc?.close(); } catch { /* noop */ }
    this.dc = null;
    this.pc = null;
  }

  // ─── Event dispatch ───────────────────────────────────────────────────────
  private handleEvent(raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (!isRealtimeEvent(parsed)) return;
    this.dispatch(parsed);
  }

  private dispatch(ev: RealtimeEvent): void {
    switch (ev.type) {
      case "session.updated":
        this.sessionConfigured = true;
        return;

      case "response.created":
        this.responses.onResponseCreated(ev.response.id);
        return;

      case "response.done":
      case "response.completed":
      case "response.cancelled":
      case "response.failed": {
        const cancelled = ev.type === "response.cancelled" || ev.type === "response.failed";
        const { hadPending, pendingCodeLed } = this.responses.onResponseEnded(ev.response.id);
        this.events.emit("responseEnded", { responseId: ev.response.id, cancelled });
        if (hadPending) {
          setTimeout(() => {
            if (this.responses.tryStart({ codeLed: pendingCodeLed })) {
              this.sendJson({ type: "response.create" });
            }
          }, 80);
        }
        return;
      }

      case "response.audio.delta":
        this.events.emit("aiAudioStarted", { responseId: ev.response_id });
        return;

      case "response.audio.done":
        this.events.emit("aiAudioEnded", { responseId: ev.response_id });
        return;

      case "response.audio_transcript.delta":
        this.partialAi += ev.delta;
        this.events.emit("aiTranscriptDelta", {
          delta: ev.delta,
          partialSoFar: this.partialAi,
          responseId: ev.response_id,
        });
        return;

      case "response.audio_transcript.done":
        this.events.emit("aiTranscript", { text: ev.transcript, responseId: ev.response_id });
        this.partialAi = "";
        return;

      case "response.function_call_arguments.done": {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(ev.arguments) as Record<string, unknown>; } catch { /* noop */ }
        this.events.emit("toolCall", { name: ev.name as ToolName, args, callId: ev.call_id });
        return;
      }

      case "conversation.item.input_audio_transcription.delta":
        this.partialCaller += ev.delta;
        this.events.emit("callerTranscriptDelta", { delta: ev.delta, partialSoFar: this.partialCaller });
        return;

      case "conversation.item.input_audio_transcription.completed":
        this.events.emit("callerTranscript", { text: ev.transcript });
        this.partialCaller = "";
        return;

      case "input_audio_buffer.speech_started":
        this.events.emit("callerSpeechStarted", undefined);
        return;

      case "input_audio_buffer.speech_stopped":
        this.events.emit("callerSpeechStopped", undefined);
        return;

      case "error":
        this.events.emit("error", { message: ev.error.message });
        return;
    }
  }

  private sendJson(obj: unknown): void {
    const dc = this.dc;
    if (!dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify(obj));
  }
}
