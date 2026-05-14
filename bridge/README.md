# Sweet Spot Voice Bridge

Asterisk receives WhatsApp Business calls over SIP/TLS, the bridge connects them
to OpenAI Realtime (voice-to-voice), the model takes the order using tools that
write live to the Lovable dashboard's Supabase tables, then sends WhatsApp
confirmations to the owner and the caller.

```
WhatsApp ──SIP/TLS:5061──► Asterisk ──Stasis──► bridge (Node.js)
                                                  │
                                  ExternalMedia (RTP slin16 16kHz)
                                                  │
                                          OpenAI Realtime (PCM16 24kHz)
                                                  │
                          tools: add_item, remove_item, set_customer_name,
                                 read_back_cart, confirm_order
                                                  │
                          Supabase: sweetspot_call_sessions / events / orders
                                                  │
                          WhatsApp Cloud API → owner + customer
```

## Deploy on the VPS

```bash
# 1) Get the bridge folder onto the VPS (e.g. via scp or git)
scp -r bridge root@161.35.166.115:/root/sweetspot-bridge-src

# 2) Run the installer
ssh root@161.35.166.115
cd /root/sweetspot-bridge-src
chmod +x install.sh && ./install.sh

# 3) Edit /etc/sweetspot/.env, fill values, re-run installer
nano /etc/sweetspot/.env
./install.sh

# 4) Tail logs
journalctl -u sweetspot-bridge -f
```

## Required env values

- `OPENAI_API_KEY` — from https://platform.openai.com/api-keys (Realtime API access)
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — from Lovable Cloud (already
  in this project's secrets)
- `WA_PHONE_ID` and `WA_TOKEN` — Meta Business Manager (same credentials used
  to configure the SIP endpoint earlier)
- `OWNER_MSISDN` — your WhatsApp number to receive new-order pings, in
  international format with no `+` (e.g. `447700900123`)
- `ARI_PASS` — invent a strong password; the installer wires it into
  `/etc/asterisk/ari.conf`

## Test

1. Place a test call to your WhatsApp Business number.
2. Watch `journalctl -u sweetspot-bridge -f` — you should see `[call] start`,
   `[rtp] remote …`, OpenAI events.
3. Open the Lovable dashboard `/` route — the call appears live with
   transcripts and the cart fills as the AI takes the order.
4. After "that's it", the order appears in `/orders` and WhatsApp messages
   land on owner + caller.

## Files

- `server.js` — ARI orchestrator + RTP plumbing
- `openai.js` — Realtime WebSocket, audio resampling, tool dispatch
- `tools.js` — tool definitions and cart logic
- `menu.js` — menu, pricing, receipt generator
- `supabase.js` — DB writes (sessions, events, orders)
- `whatsapp.js` — Meta Cloud API sends
- `asterisk/` — `ari.conf`, `http.conf`, `extensions.conf` to drop into `/etc/asterisk/`
- `sweetspot-bridge.service` — systemd unit
- `install.sh` — one-shot installer