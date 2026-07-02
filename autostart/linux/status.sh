#!/usr/bin/env bash
# Read-only status report: which autostart mechanism (if any) is installed,
# whether the process is running, and whether it answers /health.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVICE_NAME="cursor-openai-gateway.service"
UNIT_PATH="$HOME/.config/systemd/user/$SERVICE_NAME"
MARKER="managed-by: Cursor-OpenAI autostart/linux/install.sh"

echo "Cursor-OpenAI Gateway - autostart status (Linux)"
echo "Project: $PROJECT_ROOT"
echo

if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files "$SERVICE_NAME" 2>/dev/null | grep -q "$SERVICE_NAME"; then
  echo "Autostart:  systemd --user service installed"
  echo "Logs:       journalctl --user -u $SERVICE_NAME -f"
  echo
  systemctl --user status "$SERVICE_NAME" --no-pager 2>/dev/null || true
elif [ -f "$UNIT_PATH" ]; then
  # Unit file exists on disk but systemd --user isn't answering right now
  # (no user D-Bus session, e.g. over a bare ssh/cron context).
  echo "Autostart:  systemd unit file present ($UNIT_PATH),"
  echo "            but systemd --user is not reachable from this shell -"
  echo "            re-check from a normal login session."
elif crontab -l 2>/dev/null | grep -qF "$MARKER"; then
  echo "Autostart:  cron @reboot entry installed (systemd fallback mode)"
  PID_FILE="$PROJECT_ROOT/.cursor-gateway/autostart.pid"
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  # Verify the command line too - after a reboot the PID file is stale and
  # the number may have been recycled by an unrelated process.
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && { [ ! -r "/proc/$pid/cmdline" ] || tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'index\.js'; }; then
    echo "Process:    RUNNING (PID $pid)"
  else
    echo "Process:    NOT running"
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
