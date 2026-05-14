import { createFileRoute } from "@tanstack/react-router";
import { ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import "@/voiceorder.css";

const VoiceOrderApp = lazy(() => import("@/ui/App"));

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <ClientOnly fallback={<div style={{ padding: 32, fontFamily: "monospace" }}>Loading voice agent…</div>}>
      <Suspense fallback={<div style={{ padding: 32, fontFamily: "monospace" }}>Loading voice agent…</div>}>
        <VoiceOrderApp />
      </Suspense>
    </ClientOnly>
  );
}
