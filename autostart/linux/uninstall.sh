#!/usr/bin/env bash
# Removes whichever autostart hook install.sh created (systemd --user
# service, or the cron @reboot fallback). By default this only stops it
# from launching again in the future - a currently-running gateway is left
# alone. Pass --stop-running to also stop it right now.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVICE_NAME="cursor-openai-gateway.service"
UNIT_PATH="$HOME/.config/systemd/user/$SERVICE_NAME"
MARKER="managed-by: Cursor-OpenAI autostart/linux/install.sh"

STOP_RUNNING=0
[ "${1:-}" = "--stop-running" ] && STOP_RUNNING=1

# Same PID verification run.sh uses: never treat (let alone kill) a PID
# whose command line doesn't look like this gateway - after a reboot the
# PID file can be stale and the number recycled by an unrelated process.
pid_is_gateway() {
  kill -0 "$1" 2>/dev/null || return 1
  if [ -r "/proc/$1/cmdline" ]; then
    tr '\0' ' ' < "/proc/$1/cmdline" | grep -q 'index\.js' || return 1
  fi
  return 0
}

removed_something=0

if command -v systemctl >/dev/null 2>&1 && [ -f "$UNIT_PATH" ]; then
  echo "Found systemd --user service - disabling it..."
  if [ "$STOP_RUNNING" -eq 1 ]; then
    systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
  else
    systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
  fi
  rm -f "$UNIT_PATH"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Removed $UNIT_PATH"
  removed_something=1
fi

if crontab -l 2>/dev/null | grep -qF "$MARKER"; then
  crontab -l 2>/dev/null | grep -vF "$MARKER" | crontab -
  echo "Removed @reboot cron entry."
  removed_something=1

  if [ "$STOP_RUNNING" -eq 1 ]; then
    PID_FILE="$PROJECT_ROOT/.cursor-gateway/autostart.pid"
    if [ -f "$PID_FILE" ]; then
      pid="$(cat "$PID_FILE" 2>/dev/null || true)"
      if [ -n "$pid" ] && pid_is_gateway "$pid"; then
        echo "Stopping running gateway (PID $pid)..."
        kill "$pid" 2>/dev/null || true
        sleep 1
        kill -9 "$pid" 2>/dev/null || true
      elif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "PID file points at PID $pid, but that process doesn't look like this gateway (recycled PID?) - leaving it alone."
      fi
      rm -f "$PID_FILE"
    fi
  fi
fi

if [ "$removed_something" -eq 0 ]; then
  echo "No autostart hook was installed (nothing to remove)."
elif [ "$STOP_RUNNING" -eq 0 ]; then
  echo
  echo "Note: a currently-running gateway is left running (systemd service"
  echo "disable without --now leaves an already-started unit up; the cron"
  echo "fallback's process was never touched either). Re-run with"
  echo "--stop-running to also stop it, or stop it manually."
fi

echo
echo "Autostart uninstalled."
