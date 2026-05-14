// useCallSession — React subscribes to immutable state snapshots from the FSM.
// React owns view; state lives in CallSession. No refs in components.

import { useEffect, useMemo, useRef } from "react";
import { useSyncExternalStore } from "react";
import type { CallSession } from "@/session/CallSession";
import type { SessionState } from "@/domain/types";

export function useCallSession(session: CallSession): SessionState {
  const subscribe = useMemo(
    () => (cb: () => void) => session.events.on("state", cb),
    [session],
  );
  const getSnapshot = useMemo(() => () => session.getState(), [session]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Start the session on mount, stop on unmount. StrictMode-safe via ref. */
export function useManagedSession(session: CallSession): void {
  const startedRef = useRef<boolean>(false);
  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      session.start().catch((err) => {
        console.error("[useManagedSession] start failed", err);
      });
    }
    return () => {
      void session.stop();
      startedRef.current = false;
    };
  }, [session]);
}
