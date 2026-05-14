// LeakGuard — every "AI said something forbidden, cancel the response" rule
// lives here. Rules run in order; first hit wins.
//
// Why one ordered table instead of scattered handlers: order matters and
// must be visible. Tests assert ruleIds() so reordering is intentional.

import type { OrderLine } from "./types";

export interface LeakGuardContext {
  readonly confirmed: boolean;
  readonly order: readonly OrderLine[];
  readonly now: number;
  readonly menuSentAt: number | null;
  readonly callerMsisdn: string | null;
}

export type LeakAction =
  | { kind: "send_menu" }
  | { kind: "wrap_up_prompt" }
  | { kind: "currency_correction" }
  | { kind: "self_reference" };

export interface LeakHit {
  readonly ruleId: string;
  readonly action: LeakAction;
}

interface Rule {
  readonly id: string;
  readonly test: (text: string, ctx: LeakGuardContext) => boolean;
  readonly action: (ctx: LeakGuardContext) => LeakAction;
}

// Tuning constants. Named so the next reader knows what was tuned and why.
const MENU_RESEND_COOLDOWN_MS = 30_000;
const MIN_GOODBYE_PARTIAL_LEN = 8;

const RULES: readonly Rule[] = [
  // 1. Menu mention — replace with scripted "menu sent" recovery.
  {
    id: "menu_leak",
    test: (text, ctx) => {
      if (ctx.menuSentAt && ctx.now - ctx.menuSentAt < MENU_RESEND_COOLDOWN_MS) return false;
      if (!ctx.callerMsisdn) return false;
      const menuMention = /\bmenu\b/i.test(text);
      const refusal =
        /\b(can'?t|cannot|unable to|not able to|unfortunately)\b.{0,30}\b(send|share|show|give|provide)\b/i.test(text);
      return menuMention || refusal;
    },
    action: () => ({ kind: "send_menu" }),
  },

  // 2. Goodbye with items still in cart and no confirm — wrap-up prompt.
  {
    id: "goodbye_with_cart",
    test: (text, ctx) => {
      if (ctx.confirmed) return false;
      if (ctx.order.length === 0) return false;
      if (text.length < MIN_GOODBYE_PARTIAL_LEN) return false;
      return (
        /\b(good\s*bye|bye[\s!.,]*bye|have a (great|good|nice|lovely) (day|evening|one)|take care|talk soon)\b/i.test(text)
        || /\byou'?re welcome\b/i.test(text)
      );
    },
    action: () => ({ kind: "wrap_up_prompt" }),
  },

  // 3. Wrong currency (USD/EUR) — correct to GBP.
  {
    id: "currency_leak",
    test: (text) => /\$|€|\bdollars?\b|\beuros?\b/i.test(text),
    action: () => ({ kind: "currency_correction" }),
  },

  // 4. AI adopted caller's perspective ("I'd like to order…").
  {
    id: "self_reference",
    test: (text) => /\bi'?d like to order\b|\bcan i (have|get)\b/i.test(text),
    action: () => ({ kind: "self_reference" }),
  },
];

export function runRules(partialText: string, ctx: LeakGuardContext): LeakHit | null {
  for (const rule of RULES) {
    if (rule.test(partialText, ctx)) {
      return { ruleId: rule.id, action: rule.action(ctx) };
    }
  }
  return null;
}

export function ruleIds(): readonly string[] {
  return RULES.map((r) => r.id);
}
