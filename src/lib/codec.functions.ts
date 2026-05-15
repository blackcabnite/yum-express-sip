import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

function adminConfig() {
  const url = process.env.BRIDGE_ADMIN_URL;
  const token = process.env.BRIDGE_ADMIN_TOKEN;
  if (!url || !token) {
    throw new Error("BRIDGE_ADMIN_URL or BRIDGE_ADMIN_TOKEN not configured");
  }
  return { url: url.replace(/\/$/, ""), token };
}

export const getCodecMode = createServerFn({ method: "GET" }).handler(async () => {
  const { url, token } = adminConfig();
  const res = await fetch(`${url}/admin/codec`, {
    method: "GET",
    headers: { "X-Admin-Token": token },
  });
  if (!res.ok) {
    return { mode: "unknown" as const, error: `bridge ${res.status}` };
  }
  const data = (await res.json()) as { mode: string; details?: string };
  return { mode: (data.mode as "opus" | "g722" | "unknown") ?? "unknown", details: data.details };
});

export const setCodecMode = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ mode: z.enum(["opus", "g722"]) }).parse(input))
  .handler(async ({ data }) => {
    const { url, token } = adminConfig();
    const res = await fetch(`${url}/admin/codec`, {
      method: "POST",
      headers: { "X-Admin-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: data.mode }),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; mode?: string; log?: string };
    if (!res.ok || !json.ok) {
      throw new Error(json.log || `bridge ${res.status}`);
    }
    return { mode: (json.mode as "opus" | "g722" | "unknown") ?? "unknown", log: json.log };
  });