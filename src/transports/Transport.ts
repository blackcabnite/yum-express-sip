// Transport — interface every call source (mock, SIP, future ones) implements.
//
// The FSM only sees this interface. It doesn't know whether the call is
// real telephony or a browser mic. That's how MockTransport and SipTransport
// can be swapped without touching any business logic.

import type { Emitter } from "@/domain/Emitter";
import type { CallerInfo } from "@/domain/types";

export interface AcceptedCall {
  /** The PC that's already negotiated with the caller side. */
  readonly pc: RTCPeerConnection;
  /** The caller's audio stream (mic, PSTN, whatever). */
  readonly callerStream: MediaStream;
}

export interface TransportEvents {
  ready: void;
  registered: { user: string; domain: string };
  incoming: { caller: CallerInfo; accept: () => Promise<AcceptedCall>; reject: () => void };
  ended: void;
  error: { message: string };
}

export interface Transport {
  readonly events: Emitter<TransportEvents>;
  /** Start the transport (register SIP, get mic permission, etc.). */
  connect(): Promise<void>;
  /** Shut down. Idempotent. */
  disconnect(): Promise<void>;
  /** Hang up the current call if any. */
  hangup(): Promise<void>;
  /**
   * Pipe an outbound audio track to the caller. The FSM gets the AI's
   * audio from RealtimeSession and asks the transport to deliver it.
   */
  sendOutboundAudio(track: MediaStreamTrack): void;
}
