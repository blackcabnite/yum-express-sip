# AudioSocket Bridge (parallel server)

This is an **alternative** to `server.js`. It uses Asterisk's AudioSocket
(`app_audiosocket`) over plain TCP instead of `externalMedia` over RTP.

## Why bother

- Bypasses ASTERISK-28751 (the slin16 PT-mapping bug)
- No RTP header parsing, no SSRC/seq/timestamp bookkeeping
- No pacer needed — TCP backpressure handles flow control
- No endianness traps — spec is always PCM16 LE
- Cleaner code (~250 lines vs 510)

## Prereqs (one-time, on the Asterisk box)

```bash
# 1. Make sure app_audiosocket is loaded
asterisk -rx "module show like audiosocket"
# If empty:
asterisk -rx "module load app_audiosocket.so"
# To persist, add to /etc/asterisk/modules.conf [modules] section:
#   load => app_audiosocket.so

# 2. uuidgen must exist (it does on every modern Linux)
which uuidgen
```

## Dialplan (`/etc/asterisk/extensions.conf`)

Replace each `Stasis(sweetspot)` block with:

```
exten => _+X.,1,NoOp(WhatsApp call from ${CALLERID(num)})
 same => n,Answer()
 same => n,Set(CHANNEL(audionativeformat)=slin16)
 same => n,Set(SS_UUID=${SHELL(uuidgen | tr -d '\n')})
 same => n,System(curl -s -X POST -H 'content-type: application/json' -d "{\"uuid\":\"${SS_UUID}\",\"caller\":\"${CALLERID(num)}\"}" http://127.0.0.1:8091/register)
 same => n,AudioSocket(${SS_UUID},127.0.0.1:9092)
 same => n,Hangup()
```

Then: `asterisk -rx "dialplan reload"`

## Systemd unit (parallel — don't run both bridges at once)

```bash
cat > /etc/systemd/system/sweetspot-bridge-as.service <<'EOF'
[Unit]
Description=Sweet Spot voice bridge (AudioSocket variant)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/sweetspot-bridge
EnvironmentFile=/etc/sweetspot/.env
ExecStart=/usr/bin/node /opt/sweetspot-bridge/server-audiosocket.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
```

## Test it

```bash
# Stop the RTP bridge first
systemctl stop sweetspot-bridge

# Start the AudioSocket bridge
systemctl start sweetspot-bridge-as
journalctl -u sweetspot-bridge-as -f

# Make a test call. You should see:
#   [register] uuid=... caller=+44...
#   [<uuid8>] [call] start caller=+44...
#   [<uuid8>] [hb] in=...B out=...B
```

## Rollback

```bash
systemctl stop sweetspot-bridge-as
# Restore the original Stasis dialplan, or keep the AudioSocket dialplan
# alongside in a different context if you want both.
systemctl start sweetspot-bridge
```

## Files

- `server-audiosocket.js` — the bridge (self-contained, reuses `openai.js`,
  `tools.js`, `supabase.js`)
- No new npm deps required