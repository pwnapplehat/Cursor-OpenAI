#!/usr/bin/env bash
# Installs a per-user LaunchAgent for the Cursor-OpenAI gateway on macOS.
# launchd is the standard, supervised way to run a per-user background
# service on macOS (auto-restart on crash via KeepAlive, starts at login).
#
# NOTE: unlike the Windows/Linux uninstall scripts, `launchctl unload` on
# macOS always stops the running job as part of removing it - launchd has
# no separate "disable but leave the current instance running" concept.
# That's documented in uninstall.sh too so it isn't a surprise.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LABEL="com.cursor-openai.gateway"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "Cursor-OpenAI Gateway - install autostart (macOS)"
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
mkdir -p "$HOME/Library/LaunchAgents"

# Paths are interpolated into XML below - escape the three characters XML
# treats specially, so a clone living under e.g. "~/Code & Tools/" still
# produces a valid plist instead of one launchd silently rejects.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
NODE_BIN_XML="$(xml_escape "$NODE_BIN")"
PROJECT_ROOT_XML="$(xml_escape "$PROJECT_ROOT")"

# The gateway auto-opens the dashboard in a browser on every boot when
# AUTO_OPEN_BROWSER is unset (it defaults to true, for interactive
# start.sh first-runs). A LaunchAgent popping a browser at every login and
# crash-restart is wrong - so unless the user made an explicit choice in
# .env, suppress it via the agent's environment (dotenv never overrides
# variables already set by the environment).
AUTO_OPEN_ENV_BLOCK=""
if ! grep -qE '^[[:space:]]*AUTO_OPEN_BROWSER[[:space:]]*=' "$PROJECT_ROOT/.env" 2>/dev/null; then
  AUTO_OPEN_ENV_BLOCK="    <key>EnvironmentVariables</key>
    <dict>
        <key>AUTO_OPEN_BROWSER</key>
        <string>false</string>
    </dict>"
fi

# Note: launchd appends to StandardOutPath/StandardErrorPath forever - it
# has no built-in rotation, and nothing rotates these on macOS the way the
# Windows/cron-fallback launchers rotate to *.log.1. Fine for personal use;
# if the request log gets heavy, wire logs/gateway.log into newsyslog(8).
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN_XML</string>
        <string>$PROJECT_ROOT_XML/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_ROOT_XML</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>$PROJECT_ROOT_XML/logs/gateway.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_ROOT_XML/logs/gateway.err.log</string>
    <key>ProcessType</key>
    <string>Background</string>
$AUTO_OPEN_ENV_BLOCK
</dict>
</plist>
EOF

# unload first in case a previous version of the job is already loaded,
# so re-running this script is idempotent instead of erroring.
launchctl unload -w "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load -w "$PLIST_PATH"

echo
echo "Installed and started launch agent: $LABEL"
echo "  Status: launchctl list | grep $LABEL"
echo "  Logs:   $PROJECT_ROOT/logs/gateway.log"

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
  echo "Could not confirm health on port $PORT within 20s - check $PROJECT_ROOT/logs/gateway.err.log"
fi
