#!/usr/bin/env bash
# Sweet Spot voice bridge installer — run on the VPS as root.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")" && pwd)}"
APP_DIR=/opt/sweetspot-bridge
ENV_DIR=/etc/sweetspot

echo "==> Installing Node.js 20 if missing"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Copying bridge to $APP_DIR"
mkdir -p "$APP_DIR"
cp -r "$REPO_DIR"/{package.json,server.js,menu.js,tools.js,supabase.js,whatsapp.js,openai.js} "$APP_DIR/"
cd "$APP_DIR"
npm install --omit=dev

echo "==> Creating $ENV_DIR/.env (only if missing)"
mkdir -p "$ENV_DIR"
if [[ ! -f "$ENV_DIR/.env" ]]; then
  cp "$REPO_DIR/.env.example" "$ENV_DIR/.env"
  chmod 600 "$ENV_DIR/.env"
  echo "    !! Edit $ENV_DIR/.env and fill in OPENAI_API_KEY, SUPABASE_*, WA_*, ARI_PASS"
fi

echo "==> Installing Asterisk configs (backups created)"
for f in ari.conf http.conf extensions.conf; do
  if [[ -f "/etc/asterisk/$f" ]]; then
    cp "/etc/asterisk/$f" "/etc/asterisk/$f.bak.$(date +%s)"
  fi
  cp "$REPO_DIR/asterisk/$f" "/etc/asterisk/$f"
done

# Patch ARI password into ari.conf from the env file
if [[ -f "$ENV_DIR/.env" ]]; then
  ARI_PASS_VAL=$(grep -E '^ARI_PASS=' "$ENV_DIR/.env" | cut -d= -f2-)
  if [[ -n "$ARI_PASS_VAL" && "$ARI_PASS_VAL" != "change-me-strong-password" ]]; then
    sed -i "s|REPLACE_WITH_ARI_PASS|$ARI_PASS_VAL|g" /etc/asterisk/ari.conf
  else
    echo "    !! ARI_PASS in $ENV_DIR/.env is unset/default — set it then re-run this installer"
  fi
fi

echo "==> Installing systemd service"
cp "$REPO_DIR/sweetspot-bridge.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable sweetspot-bridge.service

echo "==> Restarting Asterisk to load new ARI/HTTP/dialplan"
systemctl restart asterisk
sleep 2

echo "==> Starting bridge"
systemctl restart sweetspot-bridge.service
sleep 1
systemctl status sweetspot-bridge.service --no-pager | head -10

echo ""
echo "Done. Tail logs with:  journalctl -u sweetspot-bridge -f"