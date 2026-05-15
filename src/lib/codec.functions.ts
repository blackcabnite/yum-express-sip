import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

function isValidHttpUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeAdminConfig(urlValue: string | undefined, tokenValue: string | undefined) {
  let url = urlValue?.trim();
  let token = tokenValue?.trim();

  if (!isValidHttpUrl(url) && isValidHttpUrl(token)) {
    [url, token] = [token, url];
  }

  if (!url || !token) {
    throw new Error("BRIDGE_ADMIN_URL or BRIDGE_ADMIN_TOKEN not configured");
  }
  if (!isValidHttpUrl(url)) {
    throw new Error("BRIDGE_ADMIN_URL must be a full http(s) URL");
  }

  return { url: url.replace(/\/$/, ""), token };
}

export const getCodecMode = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { url, token } = normalizeAdminConfig(process.env.BRIDGE_ADMIN_URL, process.env.BRIDGE_ADMIN_TOKEN);
    const res = await fetch(`${url}/admin/codec`, {
      method: "GET",
      headers: { "X-Admin-Token": token },
    });
    if (!res.ok) {
      return { mode: "unknown" as const, error: `bridge ${res.status}` };
    }
    const data = (await res.json()) as { mode: string; details?: string };
    return { mode: (data.mode as "opus" | "g722" | "unknown") ?? "unknown", details: data.details };
  } catch (error) {
    console.error("Codec bridge status failed", error);
    return { mode: "unknown" as const, error: error instanceof Error ? error.message : "bridge unavailable" };
  }
});

export const setCodecMode = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ mode: z.enum(["opus", "g722"]) }).parse(input))
  .handler(async ({ data }) => {
    const { url, token } = normalizeAdminConfig(process.env.BRIDGE_ADMIN_URL, process.env.BRIDGE_ADMIN_TOKEN);
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