#!/bin/sh
# Kiro Pre Tool Use Hook — Kiro Remote Control
RELAY_URL="http://localhost:3737"
PAYLOAD=$(cat)

# Check if relay is running
if ! curl -sf "$RELAY_URL/icon-192.png" > /dev/null 2>&1; then
  exit 0  # relay not running, allow through
fi

# Read the session token from the token file
TOKEN_FILE="$HOME/.kiro-remote/token"
if [ ! -f "$TOKEN_FILE" ]; then
  exit 0  # no token, allow through
fi
TOKEN=$(cat "$TOKEN_FILE")

# Post event to relay with token auth
RESPONSE=$(printf '%s' "$PAYLOAD" | curl -sf \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d @- \
  "$RELAY_URL/hook/pre-tool-use" 2>/dev/null)

if [ $? -ne 0 ]; then
  exit 0  # relay error, allow through (fail open)
fi

# Relay returns { "action": "allow" | "deny", "reason": "..." }
ACTION=$(printf '%s' "$RESPONSE" | grep -o '"action":"[^"]*"' | cut -d'"' -f4)

if [ "$ACTION" = "deny" ]; then
  REASON=$(printf '%s' "$RESPONSE" | grep -o '"reason":"[^"]*"' | cut -d'"' -f4)
  printf 'Denied by Kiro Remote: %s\n' "$REASON" >&2
  exit 1
fi

exit 0
