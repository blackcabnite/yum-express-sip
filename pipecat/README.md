# Sweet Spot — Pipecat Bot

Voice ordering bot built on [Pipecat](https://github.com/pipecat-ai/pipecat),
based on the official `p2p-webrtc/pipecat-cloud` example. It mirrors the
menu, tool calls, and Supabase persistence logic from the Node bridge
(`bridge/tools.js`, `bridge/menu.js`, `bridge/supabase.js`) so you can run
them side-by-side and cut over once it's solid.

## Pipeline

```
caller audio -> Deepgram STT -> OpenAI LLM (+ tools) -> Cartesia TTS -> caller
                          ^                  |
                          |                  v
                       Silero VAD       Supabase (cart / events / orders)
```

## Required env vars

Copy `env.example` to `.env` and fill in:

- `OPENAI_API_KEY`
- `DEEPGRAM_API_KEY`
- `CARTESIA_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CARTESIA_VOICE_ID` (optional — defaults to British Reading Lady)
- `WA_PHONE_ID`, `WA_TOKEN`, `OWNER_MSISDN` (optional, for WhatsApp receipts)
- `ENV=local` for local dev, `ENV=production` for Pipecat Cloud

## Run locally

```bash
cd pipecat
uv sync                # or: python -m pip install -r requirements.txt
uv run bot.py          # opens a local SmallWebRTC test page
```

## Deploy to Pipecat Cloud

```bash
pcc deploy
```

(See the upstream example README for the full Pipecat Cloud flow.)

## Why this exists

The OpenAI Realtime + Asterisk path was fighting three problems at once —
tool-call delivery, VAD/barge-in tuning, and systemd permissions. Pipecat
decouples STT/LLM/TTS so each stage is observable, Silero VAD is far less
twitchy than Realtime server VAD, and Pipecat Cloud removes the VPS.