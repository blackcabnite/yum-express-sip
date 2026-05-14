import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mint")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          return Response.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
        }
        let body: { model?: string; voice?: string } = {};
        try { body = await request.json(); } catch {}
        const model = body.model ?? "gpt-4o-mini-realtime-preview-2024-12-17";
        const voice = body.voice ?? "shimmer";
        const upstream = await fetch("https://api.openai.com/v1/realtime/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, voice }),
        });
        if (!upstream.ok) {
          const text = await upstream.text().catch(() => "");
          console.error(`[mint] OpenAI ${upstream.status}: ${text}`);
          return Response.json({ error: `OpenAI ${upstream.status}` }, { status: 502 });
        }
        const session = await upstream.json() as {
          client_secret?: { value: string; expires_at: number };
          model?: string; voice?: string;
        };
        return Response.json({
          client_secret: session.client_secret,
          model: session.model,
          voice: session.voice,
        });
      },
    },
  },
});
