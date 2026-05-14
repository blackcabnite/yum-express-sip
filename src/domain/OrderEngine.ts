// OrderEngine — pure functions over OrderLine[].
//
// No I/O, no React, no refs. Every function is deterministic and returns
// new state; the caller decides where to store it.

import type { OrderLine, Size } from "./types";

// ─── ID generation ──────────────────────────────────────────────────────────
function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ol_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Normalization ──────────────────────────────────────────────────────────
function norm(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// ─── Pricing ────────────────────────────────────────────────────────────────
export function totalPence(order: readonly OrderLine[]): number {
  return order.reduce((sum, l) => sum + l.unitPence * l.qty, 0);
}

export function formatPence(p: number): string {
  return `£${(p / 100).toFixed(2)}`;
}

/** Spoken form: "four pounds ninety-nine" for read-back by the model. */
export function spokenPounds(p: number): string {
  const pounds = Math.floor(p / 100);
  const pence = p % 100;
  const head = pounds === 1 ? "one pound" : `${pounds} pounds`;
  if (pence === 0) return head;
  return `${head} ${pence < 10 ? "and " : ""}${pence}`;
}

// ─── Cart operations ────────────────────────────────────────────────────────
export interface AddItemSpec {
  readonly base: string;
  readonly size: Size | null;
  readonly qty: number;
  readonly unitPence: number;
  readonly category?: string;
  readonly notes?: string;
  readonly defaulted?: boolean;
}

/**
 * Add items. Identical lines (same base+size+notes) merge.
 * Returns new order + touched line IDs.
 */
export function addItems(
  order: readonly OrderLine[],
  items: readonly AddItemSpec[],
): { order: OrderLine[]; touchedIds: string[] } {
  const next: OrderLine[] = [...order];
  const touched: string[] = [];

  for (const item of items) {
    const key = `${norm(item.base)}|${item.size ?? ""}|${norm(item.notes ?? "")}`;
    const existingIdx = next.findIndex(
      (l) => `${norm(l.base)}|${l.size ?? ""}|${norm(l.notes ?? "")}` === key,
    );
    if (existingIdx >= 0) {
      const existing = next[existingIdx];
      const merged: OrderLine = { ...existing, qty: existing.qty + item.qty };
      next[existingIdx] = merged;
      touched.push(merged.id);
    } else {
      const fresh: OrderLine = {
        id: newId(),
        base: item.base,
        size: item.size,
        qty: item.qty,
        unitPence: item.unitPence,
        category: item.category,
        notes: item.notes,
        defaulted: item.defaulted,
      };
      next.push(fresh);
      touched.push(fresh.id);
    }
  }

  return { order: next, touchedIds: touched };
}

/**
 * Remove qty units of a base. If qty omitted or >= line qty, remove the
 * whole line. Returns new order + removed summaries.
 */
export function removeItems(
  order: readonly OrderLine[],
  spec: readonly { base: string; qty?: number }[],
): { order: OrderLine[]; removed: { base: string; qty: number; size: Size | null }[] } {
  const next: OrderLine[] = [...order];
  const removed: { base: string; qty: number; size: Size | null }[] = [];

  for (const { base, qty } of spec) {
    const target = norm(base);
    // Remove from most-recent first (matches caller intent "take that off").
    for (let i = next.length - 1; i >= 0; i--) {
      const line = next[i];
      if (norm(line.base) !== target) continue;
      const toRemove = qty == null ? line.qty : Math.min(qty, line.qty);
      removed.push({ base: line.base, qty: toRemove, size: line.size });
      if (toRemove >= line.qty) {
        next.splice(i, 1);
      } else {
        next[i] = { ...line, qty: line.qty - toRemove };
      }
      if (qty != null) break;
    }
  }

  return { order: next, removed };
}

/**
 * Change size for qty units of an item. Splits the line if qty < line qty.
 */
export function changeSize(
  order: readonly OrderLine[],
  spec: { base: string; toSize: Size; qty?: number; newUnitPence: number },
): { order: OrderLine[]; touchedIds: string[]; movedQty: number; oldSize: Size | null } | null {
  const target = norm(spec.base);
  const idx = findLastIndex(order, (l) => norm(l.base) === target && l.size !== null);
  if (idx < 0) return null;

  const line = order[idx];
  if (line.size === spec.toSize) {
    return { order: [...order], touchedIds: [line.id], movedQty: 0, oldSize: line.size };
  }

  const moveQty = spec.qty == null ? line.qty : Math.min(spec.qty, line.qty);
  const next: OrderLine[] = [...order];

  if (moveQty >= line.qty) {
    next[idx] = { ...line, size: spec.toSize, unitPence: spec.newUnitPence, defaulted: false };
    return { order: next, touchedIds: [line.id], movedQty: moveQty, oldSize: line.size };
  }

  // Split.
  next[idx] = { ...line, qty: line.qty - moveQty };
  const fresh: OrderLine = {
    id: newId(),
    base: line.base,
    size: spec.toSize,
    qty: moveQty,
    unitPence: spec.newUnitPence,
    category: line.category,
    notes: line.notes,
  };
  next.splice(idx + 1, 0, fresh);
  return { order: next, touchedIds: [line.id, fresh.id], movedQty: moveQty, oldSize: line.size };
}

// ─── Receipt ────────────────────────────────────────────────────────────────
export function generateReceiptNo(now: Date = new Date()): string {
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `VO-${yy}${mm}${dd}-${rand}`;
}

export function summarize(order: readonly OrderLine[]): string {
  return order
    .map((l) => {
      const sz = l.size ? ` (${l.size})` : "";
      const nt = l.notes ? ` [${l.notes}]` : "";
      return `${l.qty}× ${l.base}${sz}${nt}`;
    })
    .join(", ");
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function findLastIndex<T>(arr: readonly T[], predicate: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (predicate(arr[i])) return i;
  return -1;
}
