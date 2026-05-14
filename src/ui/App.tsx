import * as React from "react";
// App.tsx — the demo page.
//
// Selects MockTransport or SipTransport based on VITE_TRANSPORT env var.
// State lives in CallSession; this component renders snapshots.

import { useEffect, useMemo } from "react";
import { MENU } from "@/domain/menu";
import { MenuLookup } from "@/domain/MenuLookup";
import { formatPence } from "@/domain/OrderEngine";
import { CallSession, type OrderDispatcher, type ScriptedLines } from "@/session/CallSession";
import { RealtimeSession } from "@/transports/RealtimeSession";
import { MockTransport } from "@/transports/MockTransport";
import { SipTransport } from "@/transports/SipTransport";
import type { Transport } from "@/transports/Transport";
import { SYSTEM_PROMPT, buildWhisperBias } from "@/config/prompt";
import { TOOLS } from "@/config/tools";
import { useCallSession, useManagedSession } from "@/ui/useCallSession";
import { PhaseRail } from "@/ui/components/PhaseRail";
import { OrderPanel } from "@/ui/components/OrderPanel";
import { TranscriptPanel } from "@/ui/components/TranscriptPanel";

// ─── Scripted lines ────────────────────────────────────────────────────────
const LINES: ScriptedLines = {
  greeting: "Hi there — welcome. What can I get you today?",
  signoff: ({ name, summary, totalSpoken, receiptSpoken }) => {
    const namePart = name && name !== "there" ? `, ${name}` : "";
    return `Right${namePart}, you're all set — ${summary}, coming to ${totalSpoken}. Your order number is ${receiptSpoken}. We'll have it ready in five minutes. Thanks so much!`;
  },
  menuSent: "Have a think and just let me know when you're ready to order.",
  wrapUpPrompt: (total) => `Before you go — want me to send that through? That's ${total} all in. Just say yes.`,
  didntCatch: "Sorry, I didn't quite catch that — could you say it again?",
  alreadyConfirmed: "That order's already gone through. Anything else I can do for a new order?",
};

// ─── Server-side secret fetchers ───────────────────────────────────────────
async function mintRealtimeSession(): Promise<{ clientSecret: string }> {
  const resp = await fetch("/api/mint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!resp.ok) throw new Error(`Session mint failed: ${resp.status}`);
  const data = (await resp.json()) as { client_secret?: { value?: string } };
  const cs = data.client_secret?.value;
  if (!cs) throw new Error("Mint endpoint returned no client_secret");
  return { clientSecret: cs };
}

async function fetchSipPassword(): Promise<string> {
  const resp = await fetch("/api/sip-auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!resp.ok) throw new Error(`SIP auth fetch failed: ${resp.status}`);
  const data = (await resp.json()) as { password?: string };
  if (!data.password) throw new Error("SIP auth endpoint returned no password");
  return data.password;
}

// ─── Dispatcher ────────────────────────────────────────────────────────────
const dispatcher: OrderDispatcher = {
  async dispatch(input) {
    console.log("[dispatcher] order received", input);
    return { ok: true };
  },
};

// ─── Transport selection ───────────────────────────────────────────────────
type TransportMode = "mock" | "sip";

function buildTransport(): { transport: Transport; mode: TransportMode } {
  const mode = ((import.meta.env.VITE_TRANSPORT as string | undefined) ?? "mock").toLowerCase();
  if (mode === "sip") {
    const wssUrl = import.meta.env.VITE_SIP_WSS_URL as string | undefined;
    const user = import.meta.env.VITE_SIP_USER as string | undefined;
    const domain = import.meta.env.VITE_SIP_DOMAIN as string | undefined;
    if (!wssUrl || !user || !domain) {
      throw new Error(
        "VITE_TRANSPORT=sip but VITE_SIP_WSS_URL / VITE_SIP_USER / VITE_SIP_DOMAIN not all set. " +
        "See .env.example.",
      );
    }
    return {
      transport: new SipTransport(
        { wssUrl, user, domain },
        async () => ({ password: await fetchSipPassword() }),
      ),
      mode: "sip",
    };
  }
  return { transport: new MockTransport(), mode: "mock" };
}

// ─── App ───────────────────────────────────────────────────────────────────
export default function App(): React.ReactElement {
  const { transport, mode } = useMemo(() => buildTransport(), []);

  const session = useMemo(() => {
    const realtime = new RealtimeSession(
      {
        model: "gpt-4o-mini-realtime-preview-2024-12-17",
        voice: "shimmer",
        systemPrompt: SYSTEM_PROMPT,
        whisperBiasPrompt: buildWhisperBias(uniqueBases(MENU.map((m) => m.base))),
        tools: TOOLS,
        vad: "server",
      },
      mintRealtimeSession,
    );
    const menu = new MenuLookup(MENU);
    return new CallSession(transport, realtime, menu, dispatcher, LINES);
  }, [transport]);

  useManagedSession(session);
  const state = useCallSession(session);

  // Mock-only: simulate an incoming call. SIP calls just arrive.
  const startMockCall = (): void => {
    if (transport instanceof MockTransport) {
      transport.primeAudio();
      transport.startMockCall("Demo caller");
    }
  };

  useEffect(() => {
    if (state.error) console.error("[session] error:", state.error);
  }, [state.error]);

  const inCall = ["ringing", "bridging", "listening", "aiSpeaking", "toolPending", "confirming", "wrappingUp"].includes(state.phase);

  return (
    <main className="app">
      <header className="header">
        <div>
          <h1>voiceorder</h1>
          <p className="subtitle">
            FSM-driven voice ordering — <span className="transport-tag">{mode}</span> transport · OpenAI Realtime
          </p>
        </div>
        <div className="cta">
          {mode === "mock" && state.phase === "ready" && (
            <button className="btn primary" onClick={startMockCall}>Start mock call</button>
          )}
          {mode === "sip" && state.phase === "ready" && (
            <span className="awaiting">awaiting call…</span>
          )}
          {inCall && <button className="btn" onClick={() => void transport.hangup()}>Hang up</button>}
        </div>
      </header>

      <PhaseRail current={state.phase} />

      {state.error && <div className="error">⚠ {state.error}</div>}

      <section className="caller-row">
        <span className="label">Caller</span>
        <span className="value">
          {state.caller ? `${state.caller.displayName}${state.caller.msisdn ? ` · ${state.caller.msisdn}` : ""}` : "—"}
        </span>
      </section>

      <div className="grid">
        <OrderPanel order={state.order} receipt={state.receipt} format={formatPence} />
        <TranscriptPanel transcript={state.transcript} />
      </div>
    </main>
  );
}

function uniqueBases(arr: readonly string[]): readonly string[] {
  return Array.from(new Set(arr));
}
