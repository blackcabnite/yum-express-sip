#!/usr/bin/env bash
# Switch Asterisk between the current (G.722/narrowband Opus) config and
# the new fullband Opus config — without losing either. Symlinks
# /etc/asterisk/pjsip.conf and /etc/asterisk/codecs.conf to the chosen
# variant inside this repo, then reloads Asterisk.
#
# Usage:
#   sudo ./switch-codec.sh opus     # fullband Opus 48 kHz
#   sudo ./switch-codec.sh g722     # original config (default)
#   sudo ./switch-codec.sh status   # show which variant is active

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETC=/etc/asterisk
MODE="${1:-status}"

backup_once() {
  local f="$1"
  if [[ -f "$f" && ! -L "$f" && ! -f "$f.orig" ]]; then
    cp -a "$f" "$f.orig"
    echo "[switch] backed up original $f → $f.orig"
  fi
}

link() {
  local src="$1" dst="$2"
  backup_once "$dst"
  ln -sf "$src" "$dst"
  echo "[switch] $dst → $src"
}

case "$MODE" in
  opus)
    link "$REPO_DIR/pjsip.opus.conf"   "$ETC/pjsip.conf"
    link "$REPO_DIR/codecs.opus.conf"  "$ETC/codecs.conf"
    ;;
  g722|default)
    link "$REPO_DIR/pjsip.conf"          "$ETC/pjsip.conf"
    link "$REPO_DIR/codecs.default.conf" "$ETC/codecs.conf"
    ;;
  status)
    for f in "$ETC/pjsip.conf" "$ETC/codecs.conf"; do
      if [[ -L "$f" ]]; then
        echo "$f → $(readlink "$f")"
      else
        echo "$f (not managed by switch-codec.sh)"
      fi
    done
    exit 0
    ;;
  *)
    echo "Usage: $0 {opus|g722|status}" >&2
    exit 2
    ;;
esac

echo "[switch] reloading Asterisk…"
asterisk -rx 'module reload res_pjsip.so' >/dev/null
asterisk -rx 'module reload codec_opus.so' >/dev/null || true
asterisk -rx 'core reload' >/dev/null
echo "[switch] done. Active mode: $MODE"