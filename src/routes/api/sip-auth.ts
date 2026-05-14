import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/sip-auth")({
  server: {
    handlers: {
      POST: async () => {
        const password = process.env.SIP_PASSWORD;
        if (!password) {
          return Response.json({ error: "SIP_PASSWORD not configured" }, { status: 501 });
        }
        return Response.json({ password });
      },
    },
  },
});
