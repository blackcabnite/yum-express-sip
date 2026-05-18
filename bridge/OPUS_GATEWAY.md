# Opus end-to-end gateway (experimental)

Runs **alongside** the existing G.722 bridge (`server.js`) — does not replace
it. You can flip WhatsApp over to Opus by changing the dialplan context, and
flip back instantly if anything misbehaves.

## Architecture

```
WhatsApp Opus/SRTP
      │
      ▼
  Asterisk PJSIP (whatsapp endpoint, allow=opus)
      │   Dial(PJSIP/ai-opus/...) — local SIP/UDP to 127.0.0.1:5070
      ▼
  opus-gateway.js  (this file)
      │  ── SIP UAS answers with SDP advertising opus/48000/2 PT 111
      │  ── RTP on 127.0.0.1:40000 (loopback, plain RTP — no SRTP needed)
      │  ── @discordjs/opus decode → 48k PCM16 → 16k → openai.js
      │  ── openai.js ↔ OpenAI Realtime (PCM16 24k internally)
      │  ── 16k → 48k → @discordjs/opus encode → RTP back
      ▼
  Asterisk → WhatsApp Opus
```

Why this and not ARI ExternalMedia: ExternalMedia has no SDP, so dynamic-PT
codecs like Opus (PT 111) can't be negotiated. A real SIP UAS solves it.

## Install

```bash
cd /opt/sweetspot-bridge
npm install                # picks up @discordjs/opus + sip from package.json

# Asterisk config
cp asterisk/pjsip-opus-ai.conf  /etc/asterisk/
cp asterisk/extensions-opus.conf /etc/asterisk/
# In /etc/asterisk/pjsip.conf add:    #include "pjsip-opus-ai.conf"
# In /etc/asterisk/extensions.conf add: #include "extensions-opus.conf"
asterisk -rx "module reload res_pjsip.so"
asterisk -rx "dialplan reload"

# Systemd
cp opus-gateway.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now opus-gateway
journalctl -u opus-gateway -f
```

## Switching WhatsApp traffic to the Opus path

In `pjsip.conf`, change the `[whatsapp]` endpoint's `context=` from
`whatsapp-inbound` (G.722 / Stasis bridge) to `whatsapp-inbound-opus`
(Dial into the gateway). Reload:

```bash
asterisk -rx "module reload res_pjsip.so"
```

Roll back: change `context=` back to `whatsapp-inbound`, reload. Calls
immediately route through the proven G.722 bridge again.

## What is intentionally minimal in v1

- One concurrent call (single RTP port). Multi-call needs a port pool.
- No SRTP on the loopback leg (not needed — 127.0.0.1).
- No re-INVITE / hold / DTMF handling.
- No jitter buffer on inbound — Opus PLC + the 20ms pacer on the way back
  cover most of it; revisit if you hear glitches.
- No comfort-noise generation. Asterisk handles silence.

## Debug checklist if a call fails

1. `journalctl -u opus-gateway -f` — does it log `call start` on INVITE?
2. `asterisk -rx "pjsip show endpoint ai-opus"` — endpoint present?
3. `tcpdump -i lo -nn port 5070 or portrange 40000-40100` — SIP + RTP flowing?
4. Heartbeat line `[opus hb] in=Xp out=Yq` should show steady `in` packets
   (~50/s) once audio starts.
5. If `in=0` but call connects: Asterisk negotiated a different codec —
   verify `allow=opus` on both endpoints.