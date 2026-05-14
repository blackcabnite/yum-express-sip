// MenuLookup — pure menu search. No external state.
//
// Constructed once with the menu data; serves queries as a value object.

import type { MenuItem, Size } from "./types";

const CATEGORY_KEYWORDS: ReadonlyArray<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(latte|cappuccino|americano|mocha|espresso|flat\s*white|macchiato)\b/i, category: "coffee" },
  { pattern: /\b(tea|chai)\b/i, category: "tea" },
  { pattern: /\bhot\s*chocolate|\bhot\s*choc\b/i, category: "hot_chocolate" },
  { pattern: /\b(brownie|cookie|croissant|cheesecake|pain\s*au\s*chocolat|muffin|scone)\b/i, category: "pastry" },
  { pattern: /\b(juice|water|smoothie)\b/i, category: "cold_drink" },
];

function norm(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export interface MenuLookupResult {
  readonly item: MenuItem;
  readonly base: string;
  readonly category: string;
}

export class MenuLookup {
  private readonly items: readonly MenuItem[];
  private readonly byNormalizedBase: Map<string, MenuItem[]>;

  constructor(items: readonly MenuItem[]) {
    this.items = items;
    const map = new Map<string, MenuItem[]>();
    for (const it of items) {
      const k = norm(it.base);
      let bucket = map.get(k);
      if (!bucket) {
        bucket = [];
        map.set(k, bucket);
      }
      bucket.push(it);
    }
    this.byNormalizedBase = map;
  }

  all(): readonly MenuItem[] {
    return this.items;
  }

  /** Detect a category hint inside free-form text. Returns null if none. */
  categoryHint(text: string): string | null {
    for (const { pattern, category } of CATEGORY_KEYWORDS) {
      if (pattern.test(text)) return category;
    }
    return null;
  }

  /** Does this base have Small/Regular/Large variants? */
  hasSizes(base: string): boolean {
    const variants = this.byNormalizedBase.get(norm(base)) ?? [];
    return variants.some((v) => v.size !== null);
  }

  /**
   * Find the menu item matching a free-text request.
   *   1. Exact base-name match.
   *   2. Category-hinted token-overlap match.
   *   3. Best Jaccard match across all bases (threshold 0.5).
   */
  find(request: string, size?: Size | null): MenuLookupResult | null {
    const reqNorm = norm(request);
    if (!reqNorm) return null;

    const wantedSize = size ?? null;

    // 1. Direct base-name match.
    const direct = this.byNormalizedBase.get(reqNorm);
    if (direct && direct.length > 0) {
      const hit = pickBySize(direct, wantedSize);
      if (hit) return { item: hit, base: hit.base, category: hit.category };
    }

    // 2 + 3. Category-hint scope, then token-overlap match.
    const hint = this.categoryHint(request);
    const candidates = hint ? this.items.filter((m) => m.category === hint) : this.items;

    let best: MenuItem | null = null;
    let bestScore = 0;

    for (const it of candidates) {
      const baseNorm = norm(it.base);
      if (baseNorm === reqNorm) {
        const variants = this.byNormalizedBase.get(baseNorm) ?? [it];
        const fix = pickBySize(variants, wantedSize);
        if (fix) return { item: fix, base: fix.base, category: fix.category };
      }
      const score = jaccard(reqNorm, baseNorm);
      if (score > bestScore) {
        bestScore = score;
        best = it;
      }
    }

    if (best && bestScore >= 0.5) {
      const variants = this.byNormalizedBase.get(norm(best.base)) ?? [best];
      const fix = pickBySize(variants, wantedSize);
      if (fix) return { item: fix, base: fix.base, category: fix.category };
    }

    return null;
  }
}

function pickBySize(variants: readonly MenuItem[], wantedSize: Size | null): MenuItem | null {
  if (variants.length === 0) return null;
  if (variants.length === 1 && variants[0].size === null) return variants[0];
  if (wantedSize) {
    return variants.find((v) => v.size === wantedSize) ?? variants[0];
  }
  return (
    variants.find((v) => v.size === "Regular") ??
    variants.find((v) => v.size === "Small") ??
    variants[0]
  );
}

function jaccard(a: string, b: string): number {
  const ta = new Set(a.split(/\s+/).filter(Boolean));
  const tb = new Set(b.split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  ta.forEach((t) => {
    if (tb.has(t)) inter++;
  });
  return inter / Math.max(ta.size, tb.size);
}
