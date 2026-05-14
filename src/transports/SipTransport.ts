// SipTransport — production telephony transport.
//
// Implements the same Transport interface as MockTransport. The FSM doesn't
// know which is plugged in — that's the point of the interface.
//
// What this does:
//   1. Registers a SIP user agent over WebSocket against your PBX.
//   2. Waits for INVITEs. When one arrives, extracts the caller's MSISDN
//      from the SIP headers (with the trunk-self bug fixed).
//   3. Accepts the call. sip.js negotiates SDP and creates an
//      RTCPeerConnection between us and the PBX.
//   4. Pulls the caller's audio off the PC's receivers and emits it as
//      part of the `incoming.accept()` return — the FSM pipes that into
//      RealtimeSession, which forwards to OpenAI.
//   5. When the AI speaks, RealtimeSession emits `outboundAudio`. The FSM
//      forwards the track to `sendOutboundAudio()`, which replaces the
//      SIP PC's audio sender — and the caller hears the AI through PSTN.
//   6. Handles BYE (caller hangup) and our own hangup() (timer-driven).
//
// Note on the local mic: sip.js calls getUserMedia by default when accepting,
// because it doesn't know we'll be replacing the outbound track. We mute the
// captured mic track immediately so the caller doesn't hear our environment
// during the brief window before the AI starts speaking. The track is
// replaced (not removed) on sendOutboundAudio, so SDP renegotiation isn't
// needed — replaceTrack is a same-mid swap.
//
// What's required externally:
//   • An Asterisk/FreeSWITCH/etc. PBX with WebSocket transport (chan_pjsip,
//     transport_wss). See docs/TELEPHONY.md.
//   • A SIP extension for this UA, configured with WebSocket auth.
//   • A PSTN trunk routed to that extension (Twilio, Telnyx, etc.).
//   • The SIP password fetched from your server (NEVER hardcoded in the
//     browser bundle).

import { Emitter } from "@/domain/Emitter";
import type { CallerInfo } from "@/domain/types";
import { extractCaller } from "./sip/clid";
import type {
  SipInvitation,
  SipJs,
  SipRegisterer,
  SipUserAgent,
} from "./sip/sipjs-types";
import type { AcceptedCall, Transport, TransportEvents } from "./Transport";

export interface SipConfig {
  readonly wssUrl: string;        // e.g. "wss://pbx.example.com:8089/ws"
  readonly user: string;          // SIP extension username, e.g. "ada-web"
  readonly domain: string;        // SIP domain, e.g. "pbx.example.com"
}

/** Per-session credential fetcher. Returns the SIP password to register with. */
export type SipPasswordFetcher = () => Promise<{ password: string }>;

export interface SipTransportOptions {
  /** Override for tests — production loads sip.js from a CDN script tag. */
  readonly loadSipJs?: () => Promise<SipJs>;
}

export class SipTransport implements Transport {
  readonly events = new Emitter<TransportEvents>();

  private ua: SipUserAgent | null = null;
  private registerer: SipRegisterer | null = null;
  private currentInvitation: SipInvitation | null = null;
  private currentPc: RTCPeerConnection | null = null;
  private mutedMicTrack: MediaStreamTrack | null = null;

  constructor(
    private readonly cfg: SipConfig,
    private readonly fetchPassword: SipPasswordFetcher,
    private readonly opts: SipTransportOptions = {},
  ) {}

  // ─── Public API ───────────────────────────────────────────────────────────
  async connect(): Promise<void> {
    const sipjs = await (this.opts.loadSipJs?.() ?? defaultLoadSipJs());

    const { password } = await this.fetchPassword();
    if (!password) {
      throw new Error("SIP password is empty — check your mint endpoint");
    }

    const uri = sipjs.UserAgent.makeURI(`sip:${this.cfg.user}@${this.cfg.domain}`);
    if (!uri) throw new Error(`Invalid SIP URI: sip:${this.cfg.user}@${this.cfg.domain}`);

    this.ua = new sipjs.UserAgent({
      uri,
      transportOptions: { server: this.cfg.wssUrl },
      authorizationUsername: this.cfg.user,
      authorizationPassword: password,
      displayName: "voiceorder agent",
      logBuiltinEnabled: false,
      logLevel: "warn",
      delegate: {
        onDisconnect: (err) => {
          this.events.emit("error", {
            message: `SIP WebSocket disconnected: ${err?.message ?? "unknown reason"}`,
          });
        },
        onInvite: (invitation) => this.onInvite(sipjs, invitation),
      },
    });

    await this.ua.start();

    this.registerer = new sipjs.Registerer(this.ua, { expires: 300 });
    this.registerer.stateChange.addListener((state) => {
      if (state === "Registered") {
        this.events.emit("ready", undefined);
        this.events.emit("registered", { user: this.cfg.user, domain: this.cfg.domain });
      } else if (state === "Unregistered") {
        // Lost registration — surface but don't tear down (auto-reregister).
        console.warn("[SipTransport] registration lost");
      }
    });
    await this.registerer.register();
  }

  async disconnect(): Promise<void> {
    await this.hangup();
    try { await this.registerer?.unregister(); } catch { /* noop */ }
    try { await this.ua?.stop(); } catch { /* noop */ }
    this.registerer = null;
    this.ua = null;
    this.events.clear();
  }

  async hangup(): Promise<void> {
    if (this.currentInvitation) {
      await safeBye(this.currentInvitation);
      this.currentInvitation = null;
    }
    this.currentPc = null;
    if (this.mutedMicTrack) {
      try { this.mutedMicTrack.stop(); } catch { /* noop */ }
      this.mutedMicTrack = null;
    }
  }

  /**
   * Swap the outbound audio track on the live SIP PC.
   *
   * This is where the AI's voice meets the PSTN. The CallSession listens
   * for RealtimeSession's `outboundAudio` event and forwards the track here.
   * `replaceTrack` swaps the source within the same SDP m-line, so the
   * caller hears the new track over the existing RTP stream — no
   * renegotiation, no glitch.
   */
  sendOutboundAudio(track: MediaStreamTrack): void {
    const pc = this.currentPc;
    if (!pc) return;
    const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
    if (!sender) {
      this.events.emit("error", { message: "No audio sender on SIP PC — cannot route AI voice" });
      return;
    }
    void sender.replaceTrack(track).catch((err: Error) => {
      this.events.emit("error", { message: `replaceTrack failed: ${err.message}` });
    });
    // We no longer need the muted mic track once the AI track is in place.
    if (this.mutedMicTrack) {
      try { this.mutedMicTrack.stop(); } catch { /* noop */ }
      this.mutedMicTrack = null;
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────
  private onInvite(sipjs: SipJs, invitation: SipInvitation): void {
    // One call at a time. If anything is in flight, BYE it.
    if (this.currentInvitation && this.currentInvitation !== invitation) {
      void safeBye(this.currentInvitation);
    }
    if (invitation.state === sipjs.SessionState.Terminated) return;
    this.currentInvitation = invitation;

    const caller = this.extractCallerInfo(invitation);

    const accept = async (): Promise<AcceptedCall> => {
      await invitation.accept({
        sessionDescriptionHandlerOptions: {
          constraints: {
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
            },
            video: false,
          },
        },
      });
      const pc = invitation.sessionDescriptionHandler?.peerConnection;
      if (!pc) throw new Error("No RTCPeerConnection from sip.js after accept");
      this.currentPc = pc;

      // Mute the local-mic sender immediately. The AI track replaces it
      // moments later via sendOutboundAudio() once the model speaks.
      const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
      if (audioSender?.track) {
        audioSender.track.enabled = false;
        this.mutedMicTrack = audioSender.track;
      }

      // Pull the caller's inbound audio off the PC's receivers.
      const callerStream = await waitForInboundAudio(pc, 3000);

      // Watch for caller hangup (BYE) — sip.js emits Terminated.
      invitation.stateChange.addListener((state) => {
        if (state === sipjs.SessionState.Terminated) {
          this.currentInvitation = null;
          this.currentPc = null;
          if (this.mutedMicTrack) {
            try { this.mutedMicTrack.stop(); } catch { /* noop */ }
            this.mutedMicTrack = null;
          }
          this.events.emit("ended", undefined);
        }
      });

      return { pc, callerStream };
    };

    const reject = (): void => {
      try { invitation.reject(); } catch { /* noop */ }
      this.currentInvitation = null;
    };

    this.events.emit("incoming", { caller, accept, reject });
  }

  private extractCallerInfo(invitation: SipInvitation): CallerInfo {
    const trunkDigits = this.cfg.user.replace(/\D/g, "");
    const displayName =
      invitation.remoteIdentity?.displayName ??
      invitation.remoteIdentity?.uri?.user ??
      "Unknown";
    const fallbackUri = invitation.remoteIdentity?.uri?.user ?? null;
    const headerBag =
      invitation.request ??
      invitation.incomingInviteRequest?.message ??
      null;

    return extractCaller({
      message: headerBag,
      displayName,
      fallbackUri,
      trunkDigits,
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
async function defaultLoadSipJs(): Promise<SipJs> {
  // Load sip.js from a CDN script tag at runtime. This keeps sip.js out of
  // the bundle and out of the typecheck path. The caller is expected to
  // <script src="https://cdn.jsdelivr.net/npm/sip.js@.../sip.min.js"> the
  // library before calling connect(); we poll window.SIP / wait for a
  // "sipjs-ready" event for up to 10s as a safety net.
  const w = globalThis as unknown as { SIP?: SipJs };
  if (w.SIP) return w.SIP;

  return new Promise<SipJs>((resolve, reject) => {
    const start = Date.now();
    const onReady = (): void => {
      if (w.SIP) {
        cleanup();
        resolve(w.SIP);
      }
    };
    const interval = setInterval(() => {
      if (w.SIP) {
        cleanup();
        resolve(w.SIP);
      } else if (Date.now() - start > 10_000) {
        cleanup();
        reject(new Error("sip.js not loaded — include the sip.min.js <script> tag before SipTransport.connect()"));
      }
    }, 100);
    const cleanup = (): void => {
      clearInterval(interval);
      globalThis.removeEventListener?.("sipjs-ready", onReady);
    };
    globalThis.addEventListener?.("sipjs-ready", onReady);
  });
}

async function safeBye(invitation: SipInvitation): Promise<void> {
  try {
    await invitation.bye();
  } catch {
    try { invitation.reject(); } catch { /* noop */ }
  }
}

async function waitForInboundAudio(pc: RTCPeerConnection, maxMs: number): Promise<MediaStream> {
  const found = collectInboundAudio(pc);
  if (found) return found;
  return new Promise<MediaStream>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pc.removeEventListener("track", check);
      reject(new Error("No inbound audio track within timeout"));
    }, maxMs);
    const check = (): void => {
      const s = collectInboundAudio(pc);
      if (s) {
        clearTimeout(timeout);
        pc.removeEventListener("track", check);
        resolve(s);
      }
    };
    pc.addEventListener("track", check);
  });
}

function collectInboundAudio(pc: RTCPeerConnection): MediaStream | null {
  const tracks: MediaStreamTrack[] = [];
  for (const r of pc.getReceivers()) {
    if (r.track && r.track.kind === "audio") tracks.push(r.track);
  }
  if (tracks.length === 0) return null;
  return new MediaStream(tracks);
}
