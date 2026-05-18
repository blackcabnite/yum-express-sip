// OpenAI Realtime tool definitions + executors operating on a CallState.
import { findItem, priceOf, hasSizes, sizesOf, generateReceiptNo } from "./menu.js";
import { updateSession, logEvent, createOrder } from "./supabase.js";
import { notifyOrder } from "./whatsapp.js";

export function newCallState({ sessionId, callerMsisdn }) {
  return {
    sessionId,
    callerMsisdn,
    customerName: null,
    cart: [], // [{ id, name, size, qty, unitPence, lineTotal }]
    confirmed: false,
    order: null,
  };
}

function recalc(line) { line.lineTotal = line.unitPence * line.qty; return line; }
function cartTotal(cart) { return cart.reduce((s, l) => s + l.lineTotal, 0); }

async function syncCart(state) {
  await updateSession(state.sessionId, { cart: state.cart });
}

function normaliseSize(size) {
  const s = String(size || "").toLowerCase().trim();
  if (!s) return null;
  if (/^(sml|small)\b/.test(s)) return "Sml";
  if (/^(lrg|large)\b/.test(s)) return "Lrg";
  if (/^(reg|regular)\b/.test(s)) return "Reg";
  return size;
}

function normaliseAddArgs(args = {}) {
  const next = { ...args };
  const rawName = String(next.name || "");
  const q = rawName.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (/\b(?:carrot|karrot|kara)\s+chai\b/.test(q)) next.name = "Karak Chai";
  if (/\bsweet\s+spot\s+specials?\b/.test(q) && !/\b(cookie|dough|cheesecake|sundae)\b/.test(q)) {
    next.name = "Sweet Spot Special Waffle";
    if (!next.size) next.size = "Reg";
  }
  next.size = normaliseSize(next.size);
  return next;
}

function normaliseBatchItems(args = {}) {
  const source = Array.isArray(args.items) ? args.items : Array.isArray(args) ? args : [];
  return source
    .map((item) => normaliseAddArgs(item || {}))
    .filter((item) => String(item.name || "").trim());
}

export const TOOL_SCHEMAS = [
  {
    type: "function",
    name: "record_items",
    description: "Add one or more ordered items to the cart in a single call. Default waffles and cookie dough to Reg unless the caller explicitly said small or large. Sweet Spot Special without a category means Sweet Spot Special Waffle Reg. carrot/karrot chai means Karak Chai.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              size: { type: "string", description: "Sml, Reg, or Lrg. Use Reg by default for sized desserts." },
              qty: { type: "integer", minimum: 1, default: 1 },
            },
            required: ["name"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    type: "function",
    name: "add_item",
    description: "Add an item to the order immediately. For waffles and cookie dough, NEVER ask for size first: default to Reg unless the caller explicitly said small or large in this same request. If caller says Sweet Spot Special without a category, add Sweet Spot Special Waffle Reg. If caller says carrot/karrot chai, add Karak Chai.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Item name as the caller said it (e.g. 'kinder waffle', 'oreo shake')." },
        size: { type: "string", description: "Size variant. Use Reg by default for waffles/cookie dough. Use Sml only if caller said small; use Lrg only if caller said large. Omit if N/A." },
        qty: { type: "integer", minimum: 1, default: 1 },
      },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "remove_item",
    description: "Remove an item from the cart by name (and optional size).",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, size: { type: "string" } },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "set_customer_name",
    description: "Record the customer's name when they tell you.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    type: "function",
    name: "read_back_cart",
    description: "Get a structured snapshot of the current cart and total to read back to the caller.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "confirm_order",
    description: "Finalize the order, generate a receipt number, persist it, and send WhatsApp confirmations. Only call after the caller has clearly indicated they're done (e.g. 'that's it', 'all done').",
    parameters: { type: "object", properties: {} },
  },
];

export async function execTool(state, name, args) {
  switch (name) {
    case "record_items": {
      const items = normaliseBatchItems(args);
      if (!items.length) return { ok: false, error: "No valid items supplied." };
      const added = [];
      const errors = [];
      for (const itemArgs of items) {
        const result = await execTool(state, "add_item", itemArgs);
        if (result.ok) added.push(result.added);
        else errors.push({ item: itemArgs, error: result.error });
      }
      return { ok: errors.length === 0, added, errors, cart: state.cart, total_pence: cartTotal(state.cart) };
    }

    case "add_item": {
      args = normaliseAddArgs(args);
      const item = findItem(args.name);
      if (!item) {
        await logEvent(state.sessionId, "tool_add_miss", args.name, args);
        return { ok: false, error: `Item "${args.name}" not found on the menu.` };
      }
      let size = args.size || null;
      if (hasSizes(item) && !size) {
        size = "Reg";
      }
      if (size && hasSizes(item) && !item.sizes[size]) {
        return { ok: false, error: `Size "${size}" not available for ${item.base}. Available: ${sizesOf(item).join(", ")}.` };
      }
      const qty = Math.max(1, args.qty || 1);
      const unitPence = priceOf(item, size);
      const line = recalc({ id: item.id, name: item.base, size, qty, unitPence, lineTotal: 0 });
      // Merge if identical line exists
      const existing = state.cart.find((l) => l.id === item.id && l.size === size);
      if (existing) { existing.qty += qty; recalc(existing); }
      else state.cart.push(line);
      await syncCart(state);
      await logEvent(state.sessionId, "cart_add", `${qty}× ${size || ""} ${item.base}`.trim(), { item: item.id, size, qty });
      return { ok: true, added: { name: item.base, size, qty, unitPence }, cart: state.cart, total_pence: cartTotal(state.cart) };
    }

    case "remove_item": {
      const item = findItem(args.name);
      if (!item) return { ok: false, error: `Not on menu: ${args.name}` };
      const before = state.cart.length;
      state.cart = state.cart.filter((l) => !(l.id === item.id && (!args.size || l.size === args.size)));
      await syncCart(state);
      await logEvent(state.sessionId, "cart_remove", item.base, { item: item.id, size: args.size || null });
      return { ok: true, removed: before - state.cart.length, cart: state.cart, total_pence: cartTotal(state.cart) };
    }

    case "set_customer_name": {
      state.customerName = String(args.name || "").trim().slice(0, 80) || null;
      await updateSession(state.sessionId, { customer_name: state.customerName });
      await logEvent(state.sessionId, "name_captured", state.customerName);
      return { ok: true, customer_name: state.customerName };
    }

    case "read_back_cart": {
      return { cart: state.cart, total_pence: cartTotal(state.cart), customer_name: state.customerName };
    }

    case "confirm_order": {
      if (!state.cart.length) return { ok: false, error: "Cart is empty." };
      if (state.confirmed) return { ok: true, already: true, order: state.order };
      const receiptNo = generateReceiptNo();
      const totalPence = cartTotal(state.cart);
      const order = await createOrder({
        sessionId: state.sessionId,
        callerMsisdn: state.callerMsisdn,
        customerName: state.customerName,
        receiptNo,
        cart: state.cart,
        totalPence,
      });
      state.confirmed = true;
      state.order = order;
      await updateSession(state.sessionId, { status: "confirmed", current_intent: "confirmed" });
      await logEvent(state.sessionId, "order_confirmed", receiptNo, { total_pence: totalPence });
      // Fire WhatsApp messages without blocking the voice response
      notifyOrder({ order, callerMsisdn: state.callerMsisdn })
        .then(() => logEvent(state.sessionId, "whatsapp_sent", receiptNo))
        .catch((e) => logEvent(state.sessionId, "whatsapp_error", String(e)));
      return { ok: true, receipt_no: receiptNo, total_pence: totalPence };
    }

    default:
      return { ok: false, error: `Unknown tool ${name}` };
  }
}