// WhatsApp Business Cloud API — send text messages to owner + customer
const GRAPH = "https://graph.facebook.com/v21.0";

function normalizeMsisdn(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d]/g, "");
  if (!digits) return null;
  // Meta accepts E.164 with leading '+'. Strip leading 0s/00s if present.
  const trimmed = digits.replace(/^0+/, "");
  return "+" + trimmed;
}

async function sendText(to, body) {
  const phoneId = process.env.WA_PHONE_ID;
  const token = process.env.WA_TOKEN;
  if (!phoneId || !token) {
    console.warn("[wa] WA_PHONE_ID/WA_TOKEN not set — skipping send to", to);
    return null;
  }
  const normalized = normalizeMsisdn(to);
  if (!normalized) {
    console.warn("[wa] skip send: empty/invalid msisdn", to);
    return null;
  }
  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalized,
      type: "text",
      text: { body },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) console.error("[wa] send failed", res.status, "to=", normalized, JSON.stringify(json));
  return json;
}

export function buildOwnerMessage({ receiptNo, customerName, callerMsisdn, cart, totalPence }) {
  const lines = cart.map((l) => `• ${l.qty}× ${l.size ? l.size + " " : ""}${l.name}  £${(l.lineTotal / 100).toFixed(2)}`);
  return [
    `🍦 NEW ORDER — ${receiptNo}`,
    "",
    `Customer: ${customerName || "(no name)"}`,
    `Phone: ${callerMsisdn || "(withheld)"}`,
    "",
    "Order:",
    ...lines,
    "",
    `Total: £${(totalPence / 100).toFixed(2)}`,
  ].join("\n");
}

export function buildCustomerMessage({ receiptNo, cart, totalPence }) {
  const lines = cart.map((l) => `• ${l.qty}× ${l.size ? l.size + " " : ""}${l.name}`);
  return [
    `Hi from Sweet Spot — your order:`,
    "",
    `Receipt: ${receiptNo}`,
    ...lines,
    "",
    `Total: £${(totalPence / 100).toFixed(2)}`,
    "",
    `Collection ~15 min. Pay on collection.`,
  ].join("\n");
}

export async function notifyOrder({ order, callerMsisdn }) {
  const owner = process.env.OWNER_MSISDN;
  const cart = order.items;
  const totalPence = order.total_pence;
  const tasks = [];
  if (owner) {
    tasks.push(sendText(owner, buildOwnerMessage({
      receiptNo: order.receipt_no, customerName: order.customer_name,
      callerMsisdn, cart, totalPence,
    })));
  }
  if (callerMsisdn) {
    tasks.push(sendText(callerMsisdn, buildCustomerMessage({
      receiptNo: order.receipt_no, cart, totalPence,
    })));
  }
  await Promise.allSettled(tasks);
}