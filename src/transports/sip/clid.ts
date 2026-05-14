// CLID extraction — pure function from SIP headers to a validated MSISDN.
//
// SIP carriers wedge the real caller number into a variety of headers
// depending on configuration. Common ones: P-Asserted-Identity (carrier-
// trusted identity), Remote-Party-ID (older), Diversion (forwarded calls),
// From (last-resort). We try them in priority order and validate.
//
// The "trunk-self bug" lesson: when the trunk peer sends an INVITE without
// a real CLID, some PBXs populate From: with the trunk's own DID. Comparing
// the extracted digits with `endsWith(trunkDigits)` can falsely reject real
// MSISDNs whose trailing digits happen to match. Use strict equality.

import type { CallerInfo } from "@/domain/types";

export interface SipHeaderBag {
  /** Header name → value(s). Case can vary; we look both ways. */
  readonly headers: Readonly<Record<string, unknown>>;
}

export interface ExtractInput {
  readonly message: SipHeaderBag | null;
  readonly displayName: string;
  readonly fallbackUri: string | null;
  /** Trunk-side digits (your SIP user). Strict-equal rejection. */
  readonly trunkDigits: string;
}

const HEADER_PRIORITY: readonly string[] = [
  "X-Original-From",
  "X-Caller-ID",
  "X-Original-Caller-ID",
  "P-Asserted-Identity",
  "P-Preferred-Identity",
  "Remote-Party-ID",
  "Diversion",
  "Contact",
  "From",
];

/**
 * Extract a CallerInfo from a SIP INVITE's headers. Always returns a result;
 * `msisdn` is null if no usable number was found, with a non-null `source`
 * describing where we looked.
 */
export function extractCaller(input: ExtractInput): CallerInfo {
  const { message, displayName, fallbackUri, trunkDigits } = input;

  if (message?.headers) {
    for (const name of HEADER_PRIORITY) {
      const slot = readHeaderSlot(message.headers, name);
      if (!slot) continue;
      for (const entry of slot) {
        const digits = digitsFromSipValue(entry);
        if (!digits) continue;
        // STRICT equality — fixes the trunk-self false positive.
        if (digits === trunkDigits) continue;
        const validated = validateMsisdn(digits);
        if (validated.msisdn) {
          return { displayName, msisdn: validated.msisdn, source: name };
        }
      }
    }
  }

  // Last resort: the URI user from remoteIdentity.
  const fallbackDigits = (fallbackUri ?? "").replace(/\D/g, "");
  if (fallbackUri && fallbackDigits === trunkDigits) {
    return { displayName, msisdn: null, source: "remoteIdentity (rejected: trunk self)" };
  }
  const validated = validateMsisdn(fallbackDigits);
  return {
    displayName,
    msisdn: validated.msisdn,
    source: "remoteIdentity.uri.user",
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function readHeaderSlot(headers: Readonly<Record<string, unknown>>, name: string): unknown[] | null {
  const raw =
    headers[name] ??
    headers[name.toLowerCase()] ??
    headers[name.toUpperCase()];
  if (raw == null) return null;
  return Array.isArray(raw) ? raw : [raw];
}

/** Extract just the digits from a SIP header value. Handles many shapes. */
export function digitsFromSipValue(entry: unknown): string {
  if (entry == null) return "";
  let raw: string;
  if (typeof entry === "string") raw = entry;
  else if (typeof entry === "object" && entry !== null && "raw" in entry) raw = String((entry as { raw: unknown }).raw ?? "");
  else raw = String(entry);

  // <sip:447424993772@host;tag=...> → "447424993772"
  const angle = raw.match(/<([^>]+)>/);
  const target = angle ? angle[1] : raw;
  const sipUser = target.match(/sip:([^@;]+)/i);
  const candidate = sipUser ? sipUser[1] : target;
  return candidate.replace(/\D/g, "");
}

/** Convert a digit string to a validated E.164-style MSISDN (no plus). */
export function validateMsisdn(raw: string | null): { msisdn: string | null; reason: string | null } {
  if (!raw) return { msisdn: null, reason: "no digits" };
  if (/^(anonymous|unknown|restricted|private)$/i.test(raw.trim())) {
    return { msisdn: null, reason: "caller withheld number" };
  }
  let digits = raw.replace(/\D/g, "");
  if (!digits) return { msisdn: null, reason: "no digits" };
  if (digits.startsWith("00")) digits = digits.slice(2);
  // UK normalisation — adapt if your business is in another country.
  if (digits.startsWith("0") && digits.length >= 10) digits = "44" + digits.slice(1);
  if (digits.length === 10 && digits.startsWith("7")) digits = "44" + digits;
  if (digits.length < 10) return { msisdn: null, reason: `${digits.length} digits — likely SIP extension` };
  if (digits.length > 15) return { msisdn: null, reason: `${digits.length} digits — exceeds E.164` };
  return { msisdn: digits, reason: null };
}
