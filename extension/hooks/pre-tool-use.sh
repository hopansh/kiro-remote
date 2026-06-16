#!/bin/sh
# Kiro Pre Tool Use Hook — Kiro Remote Control
# Receives JSON on stdin: { hook_event_name, session_id, tool_name, tool_input }

RELAY_URL="http://localhost:3737"
PAYLOAD=$(cat)  # read stdin

# Check if relay is running
if ! curl -sf "$RELAY_URL/health" > /dev/null 2>&1; then
  exit 0  # relay not running, allow through
fi

# Post event to relay — relay will ask phone if approval needed
RESPONSE=$(printf '%s' "$PAYLOAD" | curl -sf \
  -X POST \
  -H "Content-Type: application/json" \
  -d @- \
  "$RELAY_URL/hook/pre-tool-use" 2>/dev/null)

EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  exit 0  # relay error, allow through (fail open)
fi

# Relay returns { "action": "allow" | "deny", "reason": "..." }
ACTION=$(printf '%s' "$RESPONSE" | grep -o '"action":"[^"]*"' | cut -d'"' -f4)

if [ "$ACTION" = "deny" ]; then
  REASON=$(printf '%s' "$RESPONSE" | grep -o '"reason":"[^"]*"' | cut -d'"' -f4)
  printf 'Denied by Kiro Remote Control: %s\n' "$REASON" >&2
  exit 1
fi

exit 0
