#!/data/data/com.termux/files/usr/bin/bash
# Probes a set of current Gemini model names against your real GEMINI_API_KEY
# (read from .env) and reports which ones your key/project can actually use.
# Run this once, note the working model names, then set GEMINI_TEXT_MODEL /
# GEMINI_IMAGE_MODEL in .env to whatever passed — no code changes needed.
#
# Deliberately does NOT use `set -e` — a single curl failure (flaky mobile
# data, a cert hiccup, etc.) must not kill the whole probe before it's
# checked every model. Each request is independent and reports its own
# result; the loop always continues.
#
# All scratch files live in ./.probe_tmp (inside this project folder), NOT
# /tmp — Termux is sandboxed by Android and doesn't provide a system-wide
# /tmp the way normal Linux does, so anything hardcoded to /tmp/... silently
# fails there. A folder next to this script is always writable.

cd "$(dirname "$0")" 2>/dev/null || true

KEY=$(grep -E '^GEMINI_API_KEY=' .env | cut -d '=' -f2-)
if [ -z "$KEY" ]; then
  echo "❌ Could not read GEMINI_API_KEY from .env in $(pwd)"
  exit 1
fi

SCRATCH="./.probe_tmp"
mkdir -p "$SCRATCH"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

OUT_FILE="$SCRATCH/probe_out.json"
ERR_FILE="$SCRATCH/probe_err.txt"

# Quick reachability check first, so a total network-down state gets one
# clear message instead of 8 confusing per-model failures.
if ! curl -sS --connect-timeout 10 --max-time 15 -o /dev/null "https://generativelanguage.googleapis.com/" 2>"$ERR_FILE"; then
  echo "❌ Can't reach generativelanguage.googleapis.com at all right now."
  echo "   curl said:"
  sed 's/^/   /' "$ERR_FILE"
  echo "   Check your Airtel/MTN connection and try again — nothing below will work until this does."
  exit 1
fi
echo "✅ Network reachable — starting model probes."
echo ""

probe_model() {
  local MODEL="$1"
  local BODY="$2"

  local CODE
  CODE=$(curl -sS --connect-timeout 10 --max-time 25 \
    -o "$OUT_FILE" -w "%{http_code}" \
    "https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent" \
    -H "x-goog-api-key: $KEY" \
    -H "Content-Type: application/json" \
    -d "$BODY" 2>"$ERR_FILE")
  local CURL_EXIT=$?

  if [ "$CURL_EXIT" -ne 0 ]; then
    echo "⚠️  $MODEL — curl itself failed (exit $CURL_EXIT): $(tr '\n' ' ' < "$ERR_FILE")"
  elif [ "$CODE" = "200" ]; then
    echo "✅ $MODEL — WORKS"
  else
    local REASON
    REASON=$(grep -o '"message":[^,}]*' "$OUT_FILE" 2>/dev/null | head -1)
    echo "❌ $MODEL — HTTP $CODE $REASON"
  fi
}

echo "── Text models (generateContent) ──────────────────────────"
TEXT_BODY='{"contents":[{"parts":[{"text":"Say OK"}]}]}'
for MODEL in gemini-3.5-flash gemini-3.1-flash-lite gemini-3-flash gemini-flash-latest gemini-2.5-flash-lite; do
  probe_model "$MODEL" "$TEXT_BODY"
done

echo ""
echo "── Image models (generateContent, responseModalities:[IMAGE]) ──"
IMAGE_BODY='{"contents":[{"parts":[{"text":"a small red circle"}]}],"generationConfig":{"responseModalities":["IMAGE"]}}'
for MODEL in gemini-2.5-flash-image gemini-3.1-flash-image gemini-3-pro-image; do
  probe_model "$MODEL" "$IMAGE_BODY"
done

echo ""
echo "Set GEMINI_TEXT_MODEL and GEMINI_IMAGE_MODEL in .env to whichever came back ✅ WORKS."
echo "If everything above shows ⚠️ curl failures instead of ✅/❌, that's a connection problem, not a model/key problem — retry when your signal is better."
