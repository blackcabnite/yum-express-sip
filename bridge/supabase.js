import { createClient } from "@supabase/supabase-js";

export const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export async function createSession({ callerMsisdn, channelId }) {
  const { data, error } = await sb
    .from("sweetspot_call_sessions")
    .insert({
      caller_msisdn: callerMsisdn || null,
      asterisk_channel_id: channelId,
      status: "active",
      cart: [],
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateSession(id, patch) {
  const { error } = await sb.from("sweetspot_call_sessions").update(patch).eq("id", id);
  if (error) console.error("[sb] updateSession", error.message);
}

export async function endSession(id) {
  await updateSession(id, { status: "ended", ended_at: new Date().toISOString() });
}

export async function logEvent(sessionId, kind, text, payload) {
  const { error } = await sb.from("sweetspot_call_events").insert({
    session_id: sessionId,
    kind,
    text: text ?? null,
    payload: payload ?? null,
  });
  if (error) console.error("[sb] logEvent", error.message);
}

export async function createOrder({ sessionId, callerMsisdn, customerName, receiptNo, cart, totalPence }) {
  const { data, error } = await sb
    .from("sweetspot_orders")
    .insert({
      session_id: sessionId,
      caller_msisdn: callerMsisdn || null,
      customer_name: customerName || null,
      receipt_no: receiptNo,
      items: cart,
      total_pence: totalPence,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function markWhatsAppSent(orderId) {
  await sb.from("sweetspot_orders").update({ whatsapp_sent_at: new Date().toISOString() }).eq("id", orderId);
}