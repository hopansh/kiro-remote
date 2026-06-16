#!/bin/sh
# Kiro Post Tool Use Hook — Kiro Remote Control
RELAY_URL="http://localhost:3737"
PAYLOAD=$(cat)

if ! curl -sf "$RELAY_URL/health" > /dev/null 2>&1; then
  exit 0
fi

printf '%s' "$PAYLOAD" | curl -sf \
  -X POST \
  -H "Content-Type: application/json" \
  -d @- \
  "$RELAY_URL/hook/post-tool-use" > /dev/null 2>&1

exit 0
