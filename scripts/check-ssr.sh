#!/bin/sh
# PRD §14.1: the manifest must be server-rendered or it does not exist to an agent.
# Usage: sh scripts/check-ssr.sh [url] [term]
set -eu
URL="${1:-http://localhost:3000/}"
TERM_="${2:-X402 Git}"
COUNT=$(curl -sf "$URL" | grep -c "$TERM_" || true)
if [ "$COUNT" -gt 0 ]; then
  echo "ok: '$TERM_' appears $COUNT time(s) in server HTML at $URL"
else
  echo "FAIL: '$TERM_' not found in server HTML at $URL" >&2
  exit 1
fi
