// Shared types. One file, no `any`, no untyped event payloads.
//
// Everything in @/domain, @/transports, @/session, @/ui references this.

// ─── Call phases ────────────────────────────────────────────────────────────
// The session is always in exactly one of these. Transitions are explicit;
// nothing is implied by the combination of multiple refs.
export type CallPhase =
  | "idle"            // Nothing started. Default after construction.
  | "ready"           // Transport ready, waiting for the next call.
  | "ringing"         // Incoming call signalled.
  | "bridging"        // Call accepted, starting Realtime session.
  | "listening"       // Default ordering state — caller's turn.
  | "aiSpeaking"      // Model mid-utterance.
  | "toolPending"     // Tool call executing.
  | "confirming"      // confirm_order fired, dispatching to backend.
  | "wrappingUp"      // Sign-off in progress, hangup armed.
  | "ended";          // Call done. Terminal.

// ─── Order & menu ───────────────────────────────────────────────────────────
export type Size = "Small" | "Regular" | "Large";

export interface MenuItem {
  readonly id: string;          // Stable lookup key. e.g. "latte_regular"
  readonly base: string;        // Display name, e.g. "Latte"
  readonly category: string;    // For category-hinted search.
  readonly size: Size | null;   // null = unsized (espresso, brownie).
  readonly pence: number;       // Integer pence. £3.20 = 320.
}

export interface OrderLine {
  readonly id: string;
  readonly base: string;
  readonly size: Size | null;
  readonly qty: number;
  readonly unitPence: number;
  readonly category?: string;
  readonly notes?: string;
  /** True if size was defaulted to Regular by code (no caller spec). */
  readonly defaulted?: boolean;
}

// ─── Tool calls (the contract with the model) ───────────────────────────────
export type ToolName =
  | "record_items"
  | "change_size"
  | "remove_items"
  | "confirm_order"
  | "set_name";

export interface ToolCall {
  readonly name: ToolName;
  readonly args: Readonly<Record<string, unknown>>;
  readonly callId: string;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly spoken: string;        // Verbatim line for the model to speak.
  readonly silent?: boolean;      // If true, suppress response.create after.
  readonly debug?: Readonly<Record<string, unknown>>;
}

// ─── Caller identity ────────────────────────────────────────────────────────
export interface CallerInfo {
  readonly displayName: string;
  readonly msisdn: string | null;   // E.164 without plus, or null if anonymous.
  readonly source: string;          // Where this CLID came from (debug).
}

// ─── Transcript ─────────────────────────────────────────────────────────────
export type Speaker = "ai" | "caller" | "system" | "tool";

export interface TranscriptLine {
  readonly id: string;
  readonly speaker: Speaker;
  readonly text: string;
  readonly at: number;
}

// ─── Session state — what the UI subscribes to ──────────────────────────────
export interface SessionState {
  readonly phase: CallPhase;
  readonly caller: CallerInfo | null;
  readonly order: readonly OrderLine[];
  readonly transcript: readonly TranscriptLine[];
  readonly receipt: { receiptNo: string; totalPence: number } | null;
  readonly error: string | null;
  readonly callerHasSpoken: boolean;
}

// ─── Realtime API events (typed union — no `any` on the data channel) ──────
// Subset of OpenAI Realtime events we actually use. Extend explicitly when
// adding new shapes — silent any-typed propagation is what made the original
// codebase impossible to refactor.
export type RealtimeEvent =
  | { type: "session.created"; session: { id: string } }
  | { type: "session.updated" }
  | { type: "response.created"; response: { id: string } }
  | { type: "response.done"; response: { id: string } }
  | { type: "response.completed"; response: { id: string } }
  | { type: "response.cancelled"; response: { id: string } }
  | { type: "response.failed"; response: { id: string }; error?: { message?: string } }
  | { type: "response.audio.delta"; response_id: string }
  | { type: "response.audio.done"; response_id: string }
  | { type: "response.audio_transcript.delta"; response_id: string; delta: string }
  | { type: "response.audio_transcript.done"; response_id: string; transcript: string }
  | { type: "response.function_call_arguments.done"; response_id: string; call_id: string; name: string; arguments: string }
  | { type: "conversation.item.input_audio_transcription.delta"; delta: string }
  | { type: "conversation.item.input_audio_transcription.completed"; transcript: string }
  | { type: "input_audio_buffer.speech_started" }
  | { type: "input_audio_buffer.speech_stopped" }
  | { type: "error"; error: { message: string } };

export function isRealtimeEvent(v: unknown): v is RealtimeEvent {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

// ─── Config types ──────────────────────────────────────────────────────────
export interface SessionConfig {
  readonly model: string;
  readonly voice: string;
  readonly systemPrompt: string;
  readonly whisperBiasPrompt: string;
  readonly tools: readonly unknown[];
  readonly vad: "server" | "semantic";
}
