#!/usr/bin/env bash
# Installs a per-user autostart hook for the Cursor-OpenAI gateway on Linux.
#
# Prefers a systemd --user service (proper supervision: auto-restart on
# crash, journald logs with automatic rotation, clean enable/disable).
# Falls back to a `@reboot` cron entry (using run.sh, which does its own
# PID-file + port-guard + nohup dance) on systems where systemd --user
# isn't usable, e.g. some WSL distros without systemd enabled, or minimal
# containers.
#
# Safe to re-run: both the systemd unit and the cron entry are written
# idempotently (marked with a comment this script recognizes on re-run).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVICE_NAME="cursor-openai-gateway.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$SERVICE_NAME"
MARKER="managed-by: Cursor-OpenAI autostart/linux/install.sh"

echo "Cursor-OpenAI Gateway - install autostart (Linux)"
echo "Project: $PROJECT_ROOT"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node was not found on PATH." >&2
  echo "Install Node.js 22.13+ (https://nodejs.org) and re-run this script." >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
echo "Found Node.js: $NODE_BIN"

cd "$PROJECT_ROOT"

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install
fi
if [ ! -f dist/index.js ]; then
  echo "Building the gateway (first run only)..."
  npm run build
fi

if [ -f "$PROJECT_ROOT/.env" ]; then
  chmod 600 "$PROJECT_ROOT/.env" || true
fi

mkdir -p "$PROJECT_ROOT/logs"

# Port resolution mirrors the gateway's own precedence (src/config.ts +
# src/configStore.ts): settings.json (dashboard overlay, wins) -> .env's
# PORT (last assignment wins, quotes/inline comments tolerated) -> 8787.
resolve_port() {
  port=""
  if [ -f "$PROJECT_ROOT/.cursor-gateway/settings.json" ]; then
    port="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]{1,5}' "$PROJECT_ROOT/.cursor-gateway/settings.json" 2>/dev/null | grep -oE '[0-9]{1,5}' | head -n1)"
  fi
  if [ -z "$port" ] && [ -f "$PROJECT_ROOT/.env" ]; then
    port="$(grep -E '^[[:space:]]*PORT[[:space:]]*=' "$PROJECT_ROOT/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | cut -d'#' -f1 | grep -oE '[0-9]{1,5}' | head -n1)"
  fi
  printf '%s' "${port:-8787}"
}

# The gateway auto-opens the dashboard in a browser on every boot when
# AUTO_OPEN_BROWSER is unset (it defaults to true, for interactive
# start.sh first-runs). A supervised service popping a browser at every
# (re)start is wrong - so unless the user made an explicit choice in
# .env, suppress it via the service environment (dotenv never overrides
# variables already set by the environment).
AUTO_OPEN_ENV_LINE=""
if ! grep -qE '^[[:space:]]*AUTO_OPEN_BROWSER[[:space:]]*=' "$PROJECT_ROOT/.env" 2>/dev/null; then
  AUTO_OPEN_ENV_LINE="Environment=AUTO_OPEN_BROWSER=false"
fi

used_systemd=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
  echo "Using systemd --user service."

  # Mechanism switch: if a previous install fell back to a cron @reboot entry
  # (e.g. this box was WSL without systemd back then), remove it now - leaving
  # both registered would start two competing gateways at every boot. The
  # runners' race resolution converges them, but a duplicate registration
  # should never persist.
  if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "$MARKER"; then
    crontab -l 2>/dev/null | grep -vF "$MARKER" | crontab -
    echo "Removed the previous cron @reboot fallback entry (systemd is usable now - it takes over)."
  fi

  if [ -f "$UNIT_PATH" ]; then
    echo "Autostart was already installed - refreshing the systemd unit."
  fi

  mkdir -p "$UNIT_DIR"
  # Logs deliberately go to journald (systemd's default) rather than
  # StandardOutput=append: files - journald rotates automatically, while
  # append: files grow forever with nothing in this toolkit to rotate them
  # (the *.log.1 rotation in run.sh only runs in the cron-fallback path).
  cat > "$UNIT_PATH" <<EOF
# $MARKER
[Unit]
Description=Cursor-OpenAI Gateway (OpenAI-compatible bridge to Cursor)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_ROOT
ExecStart=$NODE_BIN $PROJECT_ROOT/dist/index.js
Restart=on-failure
RestartSec=5
SyslogIdentifier=cursor-openai-gateway
$AUTO_OPEN_ENV_LINE

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"
  used_systemd=1

  echo
  echo "Installed and started: $SERVICE_NAME"
  echo "  Status:  systemctl --user status $SERVICE_NAME"
  echo "  Logs:    journalctl --user -u $SERVICE_NAME -f"
  echo
  echo "IMPORTANT: a systemd --user service only starts once you log in by"
  echo "default. For it to also start at boot before any interactive login"
  echo "(e.g. a headless server), run once (may prompt for your password):"
  echo "  loginctl enable-linger \"$USER\""
else
  echo "systemd --user is not usable here (no user session, or systemd isn't"
  echo "PID 1 - common on some WSL distros without 'systemd=true' in wsl.conf,"
  echo "or minimal containers). Falling back to a cron @reboot entry."

  if ! command -v crontab >/dev/null 2>&1; then
    echo "ERROR: neither systemd --user nor crontab is available on this system." >&2
    echo "Install cron (e.g. 'apt install cron') or enable systemd, then re-run." >&2
    exit 1
  fi

  RUN_SCRIPT="$SCRIPT_DIR/run.sh"
  chmod +x "$RUN_SCRIPT"

  # Reverse mechanism switch: a systemd unit file left over from an earlier
  # install would ALSO fire if systemd ever becomes usable again on this box,
  # alongside the cron entry being added now. systemctl isn't reachable from
  # here (that's why we're on the fallback path), so it can't be disabled
  # cleanly - remove the unit file itself and say so.
  if [ -f "$UNIT_PATH" ]; then
    rm -f "$UNIT_PATH"
    echo "Removed a leftover systemd unit file ($UNIT_PATH) from a previous install"
    echo "(systemd isn't reachable from this shell, so the cron entry takes over)."
  fi

  existing_crontab="$(crontab -l 2>/dev/null || true)"
  if echo "$existing_crontab" | grep -qF "$MARKER"; then
    echo "Autostart was already installed - cron entry already present, leaving it as-is."
  else
    # The run.sh path is quoted in the cron line because cron hands the
    # command to /bin/sh - unquoted, a project path containing spaces
    # would break the entry.
    { printf '%s\n' "$existing_crontab"; echo "@reboot \"$RUN_SCRIPT\" # $MARKER"; } | grep -v '^[[:space:]]*$' | crontab -
    echo "Added @reboot cron entry."
  fi

  echo "Starting it now (this is what will also happen at your next boot)..."
  "$RUN_SCRIPT"
fi

PORT="$(resolve_port)"

if ! command -v curl >/dev/null 2>&1; then
  echo
  echo "curl is not installed, so this script can't confirm /health itself."
  echo "Check manually: http://localhost:$PORT/health"
  exit 0
fi

echo
echo "Waiting for the gateway to answer /health on port $PORT..."
healthy=0
i=0
while [ "$i" -lt 20 ]; do
  sleep 1
  if curl -sf --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  i=$((i + 1))
done

if [ "$healthy" -eq 1 ]; then
  echo "Gateway is up and healthy: http://localhost:$PORT"
else
  echo "Could not confirm health on port $PORT within 20s."
  if [ "$used_systemd" -eq 1 ]; then
    echo "Check: journalctl --user -u $SERVICE_NAME -n 50 --no-pager"
  else
    echo "Check the logs in $PROJECT_ROOT/logs/ (gateway.err.log, autostart.log)"
  fi
fi
