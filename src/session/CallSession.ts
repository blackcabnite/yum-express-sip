// CallSession — the FSM orchestrator.
//
// The only place that knows the whole picture: a call is happening, the AI
// is in some state, the order has lines, the model just emitted a tool call.
//
// Dependencies are injected so they can be swapped for tests:
//   • Transport       — call source (mock or SIP)
//   • RealtimeSession — OpenAI Realtime wrapper
//   • MenuLookup      — pure menu queries
//   • OrderDispatcher — backend submission (the only side-effect channel)

import { Emitter } from "@/domain/Emitter";
import { runRules, type LeakAction } from "@/domain/LeakGuard";
import { MenuLookup } from "@/domain/MenuLookup";
import {
  addItems,
  changeSize,
  generateReceiptNo,
  removeItems,
  spokenPounds,
  summarize,
  totalPence,
} from "@/domain/OrderEngine";
import type { RealtimeSession } from "@/transports/RealtimeSession";
import type { Transport, AcceptedCall } from "@/transports/Transport";
import type {
  CallPhase,
  CallerInfo,
  SessionState,
  Size,
  ToolCall,
  TranscriptLine,
} from "@/domain/types";

// ─── Order dispatcher — the FSM's only outbound side-effect channel ─────────
export interface OrderDispatcher {
  dispatch(input: {
    receiptNo: string;
    summary: string;
    totalPence: number;
    customerName: string | null;
    customerMsisdn: string | null;
    items: ReadonlyArray<{
      base: string;
      size: Size | null;
      qty: number;
      unitPencePerUnit: number;
      notes?: string;
    }>;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface ScriptedLines {
  greeting: string;
  signoff(args: { name: string; summary: string; totalSpoken: string; receiptSpoken: string }): string;
  menuSent: string;
  wrapUpPrompt(totalSpoken: string): string;
  didntCatch: string;
  alreadyConfirmed: string;
}

export interface CallSessionEvents {
  state: SessionState;
  error: { message: string };
}

// ─── Implementation ─────────────────────────────────────────────────────────
export class CallSession {
  readonly events = new Emitter<CallSessionEvents>();

  private state: SessionState = blankState();
  private hangupTimer: ReturnType<typeof setTimeout> | null = null;
  private dispatched = false;
  private listeners: Array<() => void> = [];

  constructor(
    private readonly transport: Transport,
    private readonly realtime: RealtimeSession,
    private readonly menu: MenuLookup,
    private readonly dispatcher: OrderDispatcher,
    private readonly lines: ScriptedLines,
  ) {
    this.wire();
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  async start(): Promise<void> {
    try {
      await this.transport.connect();
    } catch (err) {
      this.fail(`Transport connect failed: ${(err as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    this.clearHangupTimer();
    try { await this.realtime.stop(); } catch { /* noop */ }
    try { await this.transport.disconnect(); } catch { /* noop */ }
    this.transition("ended");
  }

  getState(): SessionState {
    return this.state;
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────
  private wire(): void {
    this.listeners.push(
      this.transport.events.on("ready", () => this.transition("ready")),
      this.transport.events.on("incoming", (e) => void this.onIncoming(e.caller, e.accept)),
      this.transport.events.on("ended", () => void this.onCallEnded()),
      this.transport.events.on("error", (e) => this.fail(e.message)),

      this.realtime.events.on("ready", () => this.onRealtimeReady()),
      this.realtime.events.on("outboundAudio", (e) => this.transport.sendOutboundAudio(e.track)),
      this.realtime.events.on("aiTranscriptDelta", (e) => this.onAiPartial(e.partialSoFar)),
      this.realtime.events.on("aiTranscript", (e) => this.onAiFinal(e.text)),
      this.realtime.events.on("aiAudioStarted", () => this.update({ phase: "aiSpeaking" })),
      this.realtime.events.on("aiAudioEnded", () => this.onAiAudioEnded()),
      this.realtime.events.on("callerTranscript", (e) => this.onCallerFinal(e.text)),
      this.realtime.events.on("callerSpeechStarted", () => this.update({ callerHasSpoken: true })),
      this.realtime.events.on("toolCall", (t) => void this.onToolCall(t)),
      this.realtime.events.on("responseEnded", () => this.onResponseEnded()),
      this.realtime.events.on("error", (e) => this.fail(e.message)),
    );
  }

  // ─── Transport handlers ───────────────────────────────────────────────────
  private async onIncoming(caller: CallerInfo, accept: () => Promise<AcceptedCall>): Promise<void> {
    this.transition("ringing");
    this.update({ caller });
    try {
      const { callerStream } = await accept();
      this.transition("bridging");
      this.appendTranscript("system", `Call accepted from ${caller.displayName} (${caller.msisdn ?? "anonymous"})`);
      await this.realtime.start(callerStream);
    } catch (err) {
      this.fail(`Bridge failed: ${(err as Error).message}`);
    }
  }

  private async onCallEnded(): Promise<void> {
    this.clearHangupTimer();
    try { await this.realtime.stop(); } catch { /* noop */ }

    // Surface abandoned carts rather than silently dropping.
    if (this.state.order.length > 0 && !this.dispatched) {
      this.appendTranscript("system", `Call ended with ${this.state.order.length} unsent items — cart abandoned`);
      void this.dispatcher.dispatch({
        receiptNo: `ABANDONED-${Date.now()}`,
        summary: summarize(this.state.order),
        totalPence: totalPence(this.state.order),
        customerName: null,
        customerMsisdn: this.state.caller?.msisdn ?? null,
        items: this.state.order.map((l) => ({
          base: l.base,
          size: l.size,
          qty: l.qty,
          unitPencePerUnit: l.unitPence,
          notes: l.notes,
        })),
      }).catch((e) => console.error("[CallSession] abandoned-cart dispatch failed", e));
    }

    this.transition("ready");
    this.update({ order: [], caller: null, receipt: null, callerHasSpoken: false });
    this.dispatched = false;
  }

  // ─── Realtime handlers ────────────────────────────────────────────────────
  private onRealtimeReady(): void {
    this.transition("listening");
    this.realtime.speakScripted(this.lines.greeting, { maxTokens: 200 });
  }

  private onAiPartial(partial: string): void {
    const hit = runRules(partial, {
      confirmed: this.dispatched,
      order: this.state.order,
      now: Date.now(),
      menuSentAt: null,
      callerMsisdn: this.state.caller?.msisdn ?? null,
    });
    if (hit) {
      this.realtime.cancelResponse();
      this.handleLeakAction(hit.action);
    }
  }

  private onAiFinal(text: string): void {
    this.appendTranscript("ai", text);
  }

  private onAiAudioEnded(): void {
    if (this.state.phase === "aiSpeaking") this.transition("listening");
  }

  private onCallerFinal(text: string): void {
    this.appendTranscript("caller", text);
    this.update({ callerHasSpoken: true });
  }

  private onResponseEnded(): void {
    if (this.dispatched) this.realtime.responses.clearPending();
  }

  // ─── Leak actions ─────────────────────────────────────────────────────────
  private handleLeakAction(action: LeakAction): void {
    switch (action.kind) {
      case "send_menu":
        this.realtime.speakScripted(this.lines.menuSent, { maxTokens: 120 });
        return;
      case "wrap_up_prompt":
        this.realtime.speakScripted(
          this.lines.wrapUpPrompt(spokenPounds(totalPence(this.state.order))),
          { maxTokens: 180 },
        );
        return;
      case "currency_correction":
      case "self_reference":
        // Cancel + let the next caller turn drive recovery.
        return;
    }
  }

  // ─── Tool calls ───────────────────────────────────────────────────────────
  private async onToolCall(tool: ToolCall): Promise<void> {
    this.transition("toolPending");

    if (this.dispatched) {
      this.realtime.sendToolResult(tool.callId, { ok: false, spoken: this.lines.alreadyConfirmed });
      this.transition("wrappingUp");
      return;
    }

    try {
      switch (tool.name) {
        case "record_items":  this.handleRecordItems(tool); break;
        case "change_size":   this.handleChangeSize(tool); break;
        case "remove_items":  this.handleRemoveItems(tool); break;
        case "confirm_order": await this.handleConfirmOrder(tool); break;
        case "set_name":      this.handleSetName(tool); break;
        default:
          this.realtime.sendToolResult(tool.callId, { ok: false, spoken: "", silent: true });
      }
    } catch (err) {
      console.error(`[CallSession] tool ${tool.name} failed`, err);
      this.realtime.sendToolResult(tool.callId, { ok: false, spoken: this.lines.didntCatch });
    }

    if (this.state.phase === "toolPending" && !this.dispatched) {
      this.transition("listening");
    }
  }

  private handleRecordItems(tool: ToolCall): void {
    const raw = tool.args.items;
    if (!Array.isArray(raw) || raw.length === 0) {
      this.realtime.sendToolResult(tool.callId, { ok: false, spoken: this.lines.didntCatch });
      return;
    }

    const accepted: Array<{ base: string; size: Size | null; qty: number; unitPence: number; category?: string; notes?: string; defaulted?: boolean }> = [];
    const rejected: string[] = [];

    for (const r of raw) {
      if (typeof r !== "object" || r === null) continue;
      const rec = r as Record<string, unknown>;
      const base = String(rec.item ?? "");
      if (!base) continue;
      const rawSize = typeof rec.size === "string" ? (rec.size as Size) : null;
      const qty = Math.max(1, Number.isFinite(rec.quantity) ? Number(rec.quantity) : 1);
      const notes = typeof rec.notes === "string" && rec.notes.trim()
        ? rec.notes.trim().slice(0, 80)
        : undefined;

      const wantsSized = this.menu.hasSizes(base);
      const effectiveSize: Size | null = rawSize ?? (wantsSized ? "Regular" : null);
      const defaulted = wantsSized && rawSize == null;

      const hit = this.menu.find(base, effectiveSize);
      if (!hit) {
        rejected.push(base);
        continue;
      }
      accepted.push({
        base: hit.base,
        size: hit.item.size,
        qty,
        unitPence: hit.item.pence,
        category: hit.category,
        notes,
        defaulted,
      });
    }

    if (accepted.length === 0) {
      this.realtime.sendToolResult(tool.callId, { ok: false, spoken: this.lines.didntCatch });
      return;
    }

    const { order: nextOrder } = addItems(this.state.order, accepted);
    this.update({ order: nextOrder });

    const spokenSummary = accepted
      .map((a) => `${a.qty > 1 ? `${a.qty} ` : ""}${a.size ? a.size.toLowerCase() + " " : ""}${a.base}`)
      .join(", ");
    const running = spokenPounds(totalPence(nextOrder));
    const spoken = `Got it — ${spokenSummary}. Running total ${running}. Anything else?`;
    this.realtime.sendToolResult(tool.callId, {
      ok: true,
      spoken,
      debug: { accepted: accepted.length, rejected },
    });
  }

  private handleChangeSize(tool: ToolCall): void {
    const baseArg = String(tool.args.item ?? "").trim();
    const toSize = tool.args.size as Size;
    const qty = Number.isFinite(tool.args.qty) ? Number(tool.args.qty) : undefined;
    if (!toSize) {
      this.realtime.sendToolResult(tool.callId, { ok: false, spoken: this.lines.didntCatch });
      return;
    }

    // Empty item arg → most-recent sized line.
    let targetBase = baseArg;
    if (!targetBase) {
      for (let i = this.state.order.length - 1; i >= 0; i--) {
        if (this.state.order[i].size !== null) {
          targetBase = this.state.order[i].base;
          break;
        }
      }
    }
    if (!targetBase) {
      this.realtime.sendToolResult(tool.callId, { ok: false, spoken: "I can't find anything to change the size on yet." });
      return;
    }

    const lookup = this.menu.find(targetBase, toSize);
    if (!lookup) {
      this.realtime.sendToolResult(tool.callId, { ok: false, spoken: `Sorry, I can't find ${targetBase} in that size.` });
      return;
    }
    const result = changeSize(this.state.order, {
      base: targetBase,
      toSize,
      qty,
      newUnitPence: lookup.item.pence,
    });
    if (!result) {
      this.realtime.sendToolResult(tool.callId, { ok: false, spoken: `I haven't got a ${targetBase} on the order to change.` });
      return;
    }
    this.update({ order: result.order });
    const total = spokenPounds(totalPence(result.order));
    this.realtime.sendToolResult(tool.callId, {
      ok: true,
      spoken: `Changed to ${toSize.toLowerCase()}. Running total ${total}. Anything else?`,
    });
  }

  private handleRemoveItems(tool: ToolCall): void {
    const raw = tool.args.items;
    if (!Array.isArray(raw) || raw.length === 0) {
      this.realtime.sendToolResult(tool.callId, { ok: false, spoken: this.lines.didntCatch });
      return;
    }
    const spec: Array<{ base: string; qty?: number }> = [];
    for (const r of raw) {
      if (typeof r !== "object" || r === null) continue;
      const rec = r as Record<string, unknown>;
      const base = String(rec.item ?? "");
      if (!base) continue;
      const qty = Number.isFinite(rec.qty) ? Number(rec.qty) : undefined;
      spec.push({ base, qty });
    }
    const { order: nextOrder, removed } = removeItems(this.state.order, spec);
    this.update({ order: nextOrder });
    if (removed.length === 0) {
      this.realtime.sendToolResult(tool.callId, { ok: false, spoken: "I haven't got that on the order." });
      return;
    }
    const summary = removed.map((r) => `${r.qty}× ${r.base}`).join(", ");
    const total = spokenPounds(totalPence(nextOrder));
    this.realtime.sendToolResult(tool.callId, {
      ok: true,
      spoken: `Taken off ${summary}. Running total ${total}. Anything else?`,
    });
  }

  private async handleConfirmOrder(tool: ToolCall): Promise<void> {
    if (this.state.order.length === 0) {
      this.realtime.sendToolResult(tool.callId, {
        ok: false,
        spoken: "I haven't got anything down yet. What can I get you?",
      });
      return;
    }

    const order = this.state.order;
    const receiptNo = generateReceiptNo();
    const total = totalPence(order);
    const customerName = "there";
    const summary = summarize(order);
    const spoken = this.lines.signoff({
      name: customerName,
      summary,
      totalSpoken: spokenPounds(total),
      receiptSpoken: receiptNo.replace(/-/g, " "),
    });

    this.update({ receipt: { receiptNo, totalPence: total } });
    this.transition("confirming");

    // Await dispatch BEFORE speaking the sign-off. If the backend can't
    // accept the order, the caller hears a recoverable error.
    const dispatchResult = await this.dispatcher.dispatch({
      receiptNo,
      summary,
      totalPence: total,
      customerName: null,
      customerMsisdn: this.state.caller?.msisdn ?? null,
      items: order.map((l) => ({
        base: l.base,
        size: l.size,
        qty: l.qty,
        unitPencePerUnit: l.unitPence,
        notes: l.notes,
      })),
    });

    if (!dispatchResult.ok) {
      this.realtime.sendToolResult(tool.callId, {
        ok: false,
        spoken: "Something went wrong sending the order through — give me a moment.",
        debug: { reason: dispatchResult.reason },
      });
      this.transition("listening");
      return;
    }

    this.dispatched = true;
    this.realtime.sendToolResult(tool.callId, { ok: true, spoken });
    this.transition("wrappingUp");

    // Cancellable hangup timer.
    const estimatedSpeechMs = Math.max(8000, Math.ceil(spoken.length / 14) * 1000);
    this.hangupTimer = setTimeout(() => {
      void this.transport.hangup();
    }, estimatedSpeechMs + 1500);
  }

  private handleSetName(tool: ToolCall): void {
    const name = String(tool.args.name ?? "").trim();
    if (!name) {
      this.realtime.sendToolResult(tool.callId, { ok: false, spoken: "", silent: true });
      return;
    }
    this.realtime.sendToolResult(tool.callId, { ok: true, spoken: "", silent: true });
  }

  // ─── State management ────────────────────────────────────────────────────
  private transition(phase: CallPhase): void {
    if (this.state.phase === phase) return;
    this.update({ phase });
  }

  private update(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.events.emit("state", this.state);
  }

  private appendTranscript(speaker: TranscriptLine["speaker"], text: string): void {
    const line: TranscriptLine = {
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      speaker,
      text,
      at: Date.now(),
    };
    this.update({ transcript: [...this.state.transcript, line] });
  }

  private fail(message: string): void {
    this.update({ error: message });
    this.events.emit("error", { message });
  }

  private clearHangupTimer(): void {
    if (this.hangupTimer) {
      clearTimeout(this.hangupTimer);
      this.hangupTimer = null;
    }
  }
}

// ─── Defaults ──────────────────────────────────────────────────────────────
function blankState(): SessionState {
  return {
    phase: "idle",
    caller: null,
    order: [],
    transcript: [],
    receipt: null,
    error: null,
    callerHasSpoken: false,
  };
}
