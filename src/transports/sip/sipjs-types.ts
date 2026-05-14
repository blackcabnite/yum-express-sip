// Narrow type declarations for sip.js.
//
// We deliberately do NOT import types from "sip.js" — that would couple our
// typecheck to having the package installed, and to whatever shape they ship
// in their next release. Instead we declare the surface area we actually use.
//
// If sip.js changes a signature, this file is where you'll find out, in one
// place, with one set of compiler errors.

export interface SipJs {
  UserAgent: SipUserAgentCtor;
  Registerer: SipRegistererCtor;
  SessionState: { readonly Established: string; readonly Terminated: string };
}

export interface SipUserAgentCtor {
  new (opts: SipUserAgentOptions): SipUserAgent;
  makeURI(uri: string): SipUri | undefined;
}

export interface SipUri {
  // Opaque to us — sip.js consumes it internally.
  readonly _opaque?: never;
}

export interface SipUserAgentOptions {
  uri: SipUri;
  transportOptions: { server: string };
  authorizationUsername: string;
  authorizationPassword: string;
  displayName?: string;
  logBuiltinEnabled?: boolean;
  logLevel?: "debug" | "log" | "warn" | "error";
  delegate?: SipUserAgentDelegate;
}

export interface SipUserAgentDelegate {
  onConnect?: () => void;
  onDisconnect?: (err?: { message?: string }) => void;
  onInvite?: (invitation: SipInvitation) => void;
}

export interface SipUserAgent {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SipRegistererCtor {
  new (ua: SipUserAgent, opts?: { expires?: number }): SipRegisterer;
}

export interface SipRegisterer {
  register(opts?: SipRegistererRegisterOptions): Promise<void>;
  unregister(): Promise<void>;
  stateChange: { addListener(fn: (state: string) => void): void };
}

export interface SipRegistererRegisterOptions {
  requestDelegate?: {
    onAccept?: (response: SipIncomingResponse) => void;
    onReject?: (response: SipIncomingResponse) => void;
  };
}

export interface SipIncomingResponse {
  readonly message?: {
    statusCode?: number;
    reasonPhrase?: string;
  };
}

export interface SipInvitation {
  readonly state: string;
  readonly remoteIdentity?: {
    displayName?: string;
    uri?: { user?: string };
  };
  readonly request?: { headers: Record<string, unknown> };
  readonly incomingInviteRequest?: { message?: { headers: Record<string, unknown> } };
  readonly sessionDescriptionHandler?: { peerConnection?: RTCPeerConnection };
  accept(opts: SipAcceptOptions): Promise<void>;
  bye(): Promise<unknown>;
  reject(): void;
  stateChange: { addListener(fn: (state: string) => void): void };
}

export interface SipAcceptOptions {
  sessionDescriptionHandlerOptions?: {
    constraints?: MediaStreamConstraints;
  };
}
