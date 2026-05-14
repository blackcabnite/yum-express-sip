// PhaseRail — visualizes the current call phase against the full set of
// possible phases. The FSM is the architecture's centerpiece, so it gets
// pride of place in the UI.

import type { CallPhase } from "@/domain/types";

const PHASE_ORDER: readonly { phase: CallPhase; label: string }[] = [
  { phase: "idle",        label: "idle" },
  { phase: "ready",       label: "ready" },
  { phase: "ringing",     label: "ringing" },
  { phase: "bridging",    label: "bridging" },
  { phase: "listening",   label: "listening" },
  { phase: "aiSpeaking",  label: "ai speaking" },
  { phase: "toolPending", label: "tool" },
  { phase: "confirming",  label: "confirming" },
  { phase: "wrappingUp",  label: "wrapping up" },
  { phase: "ended",       label: "ended" },
];

export function PhaseRail({ current }: { current: CallPhase }): JSX.Element {
  const currentIdx = PHASE_ORDER.findIndex((p) => p.phase === current);
  return (
    <div className="phase-rail" role="status" aria-label={`Call phase: ${current}`}>
      {PHASE_ORDER.map((p, i) => {
        const state =
          p.phase === current ? "active"
          : i < currentIdx ? "past"
          : "future";
        return (
          <span key={p.phase} className={`pill pill-${state}`}>
            <span className="dot" />
            {p.label}
          </span>
        );
      })}
    </div>
  );
}
