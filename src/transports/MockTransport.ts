// MockTransport — browser-only transport for demos and tests.
//
// No SIP, no PSTN. Mic in → speakers out. A "call" begins when the UI
// invokes startMockCall(); a "hangup" terminates it. Used so the project
// can be demoed without provisioning Asterisk, a SIP trunk, or anything else.
//
// Note: The AI's outbound audio is routed to a hidden <audio> element rather
// than back through the WebRTC track topology. That's fine for a demo —
// in production you want SipTransport's bidirectional bridge.

import { Emitter } from "@/domain/Emitter";
import type { Transport, TransportEvents, AcceptedCall } from "./Transport";

export class MockTransport implements Transport {
  readonly events = new Emitter<TransportEvents>();

  private callerStream: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private outboundEl: HTMLAudioElement | null = null;

  constructor() {
    // Lazily create the playback element on first use; some browsers reject
    // <audio> creation before user gesture.
  }

  /** Call from a user gesture (button click) to unlock autoplay. */
  primeAudio(): void {
    if (this.outboundEl) return;
    const el = document.createElement("audio");
    el.autoplay = true;
    el.setAttribute("playsinline", "");
    el.style.display = "none";
    document.body.appendChild(el);
    this.outboundEl = el;
    // Prime: play a silent stream so the element is "user-activated".
    try {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(dest);
      osc.start();
      el.srcObject = dest.stream;
      void el.play().catch(() => {});
      setTimeout(() => { try { osc.stop(); } catch {} ; el.srcObject = null; }, 100);
    } catch { /* noop */ }
  }

  async connect(): Promise<void> {
    // Pre-request mic permission so the first "call" doesn't stall on a
    // permission prompt mid-flow.
    this.events.emit("ready", undefined);
  }

  async disconnect(): Promise<void> {
    await this.hangup();
    this.events.clear();
  }

  /**
   * Simulate an incoming call. The UI calls this from a "Start call" button.
   * The FSM responds via the standard `incoming` event.
   */
  startMockCall(displayName: string = "Demo caller"): void {
    this.events.emit("incoming", {
      caller: { displayName, msisdn: null, source: "mock" },
      accept: () => this.doAccept(),
      reject: () => {
        this.events.emit("ended", undefined);
      },
    });
  }

  async hangup(): Promise<void> {
    if (this.callerStream) {
      this.callerStream.getTracks().forEach((t) => t.stop());
      this.callerStream = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch { /* noop */ }
      this.pc = null;
    }
    if (this.outboundEl) {
      this.outboundEl.srcObject = null;
    }
    this.events.emit("ended", undefined);
  }

  sendOutboundAudio(track: MediaStreamTrack): void {
    if (!this.outboundEl) {
      this.outboundEl = document.createElement("audio");
      this.outboundEl.autoplay = true;
      this.outboundEl.style.display = "none";
      document.body.appendChild(this.outboundEl);
    }
    this.outboundEl.srcObject = new MediaStream([track]);
    void this.outboundEl.play().catch((err) => {
      // Autoplay policy can block this until a user gesture. Surface it.
      this.events.emit("error", { message: `Audio autoplay blocked: ${err.message}` });
    });
  }

  // ─── Internals ────────────────────────────────────────────────────────────
  private async doAccept(): Promise<AcceptedCall> {
    const callerStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    this.callerStream = callerStream;

    // A PC isn't strictly needed for the mock topology, but RealtimeSession
    // expects one in the interface. Create a minimal local one.
    const pc = new RTCPeerConnection();
    this.pc = pc;
    callerStream.getTracks().forEach((t) => pc.addTrack(t, callerStream));

    return { pc, callerStream };
  }
}
