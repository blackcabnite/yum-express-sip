// ResponseTracker — id-based replacement for the boolean "response in flight"
// ref pattern.
//
// The original lesson: a single boolean + a 5-second wall-clock watchdog
// can't represent the real shape of in-flight Realtime responses. Two
// responses created within ~50ms (debounce race), or a cancel/done race,
// produce stuck or duplicated state.
//
// This tracks by id. The Realtime API guarantees one response in flight at
// a time, so id-equality is sufficient.

export interface ActiveResponse {
  readonly id: string;
  readonly createdAt: number;
  /** True when this response was triggered by our own code (vs server-VAD). */
  readonly codeLed: boolean;
}

export class ResponseTracker {
  private active: ActiveResponse | null = null;
  private pending: { codeLed: boolean } | null = null;

  /** Claim a slot for a response.create. Returns true if the caller may send it. */
  tryStart(opts: { codeLed: boolean }): boolean {
    if (this.active !== null) {
      this.pending = { codeLed: opts.codeLed };
      return false;
    }
    this.active = { id: "<pending>", createdAt: Date.now(), codeLed: opts.codeLed };
    return true;
  }

  /** Called when the server confirms the response started, with the real id. */
  onResponseCreated(id: string): void {
    if (this.active) {
      this.active = { ...this.active, id };
    } else {
      // Server-initiated response we didn't trigger (server-VAD reply).
      this.active = { id, createdAt: Date.now(), codeLed: false };
    }
  }

  /** Called for response.done | completed | cancelled | failed. */
  onResponseEnded(id: string): { hadPending: boolean; pendingCodeLed: boolean } {
    if (this.active && this.active.id !== id && this.active.id !== "<pending>") {
      // Unknown id ending — ignore. The current active one is still in flight.
      return { hadPending: false, pendingCodeLed: false };
    }
    this.active = null;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      return { hadPending: true, pendingCodeLed: p.codeLed };
    }
    return { hadPending: false, pendingCodeLed: false };
  }

  /** Clear pending — used after confirm_order when no further responses should fire. */
  clearPending(): void {
    this.pending = null;
  }

  isActive(): boolean {
    return this.active !== null;
  }

  current(): ActiveResponse | null {
    return this.active;
  }

  /**
   * Stale-state recovery: if `active` was claimed but no event arrived for
   * `staleMs`, clear it. Belt-and-braces — if the FSM is well-behaved this
   * never fires. Returns true if it did.
   */
  reapStale(now: number, staleMs: number): boolean {
    if (!this.active) return false;
    if (now - this.active.createdAt < staleMs) return false;
    this.active = null;
    return true;
  }
}
