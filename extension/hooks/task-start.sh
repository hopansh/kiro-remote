#!/bin/sh
# Kiro Task Start Hook — Kiro Remote Control
RELAY_URL="http://localhost:3737"
PAYLOAD=$(cat)

if ! curl -sf "$RELAY_URL/icon-192.png" > /dev/null 2>&1; then
  exit 0
fi

TOKEN_FILE="$HOME/.kiro-remote/token"
[ -f "$TOKEN_FILE" ] || exit 0
TOKEN=$(cat "$TOKEN_FILE")

printf '%s' "$PAYLOAD" | curl -sf \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d @- \
  "$RELAY_URL/hook/task-start" > /dev/null 2>&1

exit 0
