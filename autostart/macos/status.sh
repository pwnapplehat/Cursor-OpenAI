#!/usr/bin/env bash
# Read-only status report for the macOS LaunchAgent.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LABEL="com.cursor-openai.gateway"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "Cursor-OpenAI Gateway - autostart status (macOS)"
echo "Project: $PROJECT_ROOT"
echo

if [ -f "$PLIST_PATH" ]; then
  echo "Autostart:  installed ($PLIST_PATH)"
  if launchctl list | grep -q "$LABEL"; then
    echo "Process:    RUNNING"
    launchctl list | grep "$LABEL"
  else
    echo "Process:    NOT running (agent installed but not currently loaded)"
  fi
else
  echo "Autostart:  NOT installed"
fi

echo
# Port resolution mirrors the gateway's own precedence: settings.json
# (dashboard overlay, wins) -> .env PORT (last wins, quotes/comments
# tolerated) -> 8787.
PORT=""
if [ -f "$PROJECT_ROOT/.cursor-gateway/settings.json" ]; then
  PORT="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]{1,5}' "$PROJECT_ROOT/.cursor-gateway/settings.json" 2>/dev/null | grep -oE '[0-9]{1,5}' | head -n1)"
fi
if [ -z "$PORT" ] && [ -f "$PROJECT_ROOT/.env" ]; then
  PORT="$(grep -E '^[[:space:]]*PORT[[:space:]]*=' "$PROJECT_ROOT/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | cut -d'#' -f1 | grep -oE '[0-9]{1,5}' | head -n1)"
fi
PORT="${PORT:-8787}"
if command -v curl >/dev/null 2>&1 && curl -sf "http://127.0.0.1:$PORT/health" 2>/dev/null; then
  echo
  echo "Health: OK (http://localhost:$PORT/health)"
else
  echo "Health: no response on port $PORT"
fi
