#!/usr/bin/env bash
# setup-cloudflare-tunnel.sh — one-shot setup for exposing the Ani-Chan Bot
# REST API (port 3000) to the internet via a Cloudflare Tunnel, so your
# website / Discord bot can reach the same MongoDB-backed data without
# touching the bot's WhatsApp connection.
#
# Usage (on the machine running the bot, e.g. your Termux phone or VPS):
#   bash scripts/setup-cloudflare-tunnel.sh <api-hostname> [tunnel-name]
#
# Example:
#   bash scripts/setup-cloudflare-tunnel.sh api.ani-chan.example.com ani-chan-bot
#
# Prerequisites:
#   1. cloudflared installed  (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
#   2. Your domain's DNS is managed by Cloudflare (the tunnel creates the
#      CNAME for <api-hostname> automatically).
#   3. Bot API enabled in .env: API_ENABLED="true", API_PORT=3000
#
# What it does:
#   - logs you into Cloudflare (opens a browser once) if needed
#   - creates the tunnel (once) and installs its credentials
#   - writes cloudflared.config.yml pointing <api-hostname> at localhost:3000
#   - routes the hostname through the tunnel
#   - prints the exact command to run the tunnel alongside the bot

set -euo pipefail

HOSTNAME="${1:-}"
TUNNEL_NAME="${2:-ani-chan-bot}"
API_PORT="${API_PORT:-3000}"

if [[ -z "$HOSTNAME" ]]; then
  echo "Usage: bash scripts/setup-cloudflare-tunnel.sh <api-hostname> [tunnel-name]"
  echo "Example: bash scripts/setup-cloudflare-tunnel.sh api.ani-chan.example.com"
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "❌ cloudflared not found. Install it first:"
  echo "   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

CONFIG_DIR="$HOME/.cloudflared"
CONFIG_FILE="cloudflared.config.yml"
mkdir -p "$CONFIG_DIR"

echo "➡️  Authenticating with Cloudflare (a browser window opens once)..."
cloudflared tunnel login || true

echo "➡️  Creating tunnel '$TUNNEL_NAME' (skips if it already exists)..."
if cloudflared tunnel list --name "$TUNNEL_NAME" 2>/dev/null | grep -q "$TUNNEL_NAME"; then
  echo "   Tunnel already exists."
else
  cloudflared tunnel create "$TUNNEL_NAME"
fi

TUNNEL_ID="$(cloudflared tunnel list --name "$TUNNEL_NAME" --output json 2>/dev/null | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -n1)"
if [[ -z "$TUNNEL_ID" ]]; then
  echo "❌ Could not resolve tunnel ID for '$TUNNEL_NAME'."
  exit 1
fi
echo "   Tunnel ID: $TUNNEL_ID"

echo "➡️  Writing $CONFIG_FILE ..."
cat > "$CONFIG_FILE" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CONFIG_DIR/$TUNNEL_ID.json

ingress:
  - hostname: $HOSTNAME
    service: http://localhost:$API_PORT
  - service: http_status:404
EOF

echo "➡️  Routing $HOSTNAME through the tunnel..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" || true

echo
echo "✅ Setup complete!"
echo
echo "   Start the bot first (API must be listening on port $API_PORT):"
echo "     npm start            # or: pm2 start ecosystem.config.cjs"
echo
echo "   Then, in another terminal, run the tunnel:"
echo "     cloudflared tunnel run $TUNNEL_NAME"
echo
echo "   Your API is then live at:  https://$HOSTNAME/api/health"
echo "   (read-only endpoints are public; /api/admin/* requires X-API-Key from .env)"
