#!/usr/bin/env bash
# Fallback launcher used only when systemd --user isn't usable (some WSL
# distros without systemd enabled, minimal containers, etc). When the
# systemd unit from install.sh IS active, systemd calls node directly and
# this script is not involved at all - systemd supervises the process
# itself, which is a better fit than reimplementing that here.
#
# Guarantees (mirroring the Windows Gateway-Runner.ps1 exactly):
#   - Single-instance via a PID file, with the PID verified against
#     /proc/<pid>/cmdline so a recycled PID is never mistaken for the
#     gateway.
#   - Port-occupancy guard: if the configured port is already served by a
#     healthy gateway this script wasn't tracking, adopt it (when its PID
#     can be identified) instead of starting a duplicate; if the port is
#     held by anything NOT answering /health, refuse loudly rather than
#     letting node silently drift onto a fallback port.
#   - Post-launch health confirmation with crash detection.
#
# Deliberately `set -u -o pipefail` without -e: every failure path below is
# handled explicitly with its own log message and exit code.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="$PROJECT_ROOT/.cursor-gateway"
LOG_DIR="$PROJECT_ROOT/logs"
PID_FILE="$STATE_DIR/autostart.pid"

mkdir -p "$STATE_DIR" "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S %z')] $1" >> "$LOG_DIR/autostart.log"
}

# True when $1 is a live PID whose command line looks like this gateway
# (node ... index.js). Falls back to "yes" if /proc/<pid>/cmdline can't be
# read - better to wrongly skip a launch than to wrongly double-launch.
pid_is_gateway() {
  kill -0 "$1" 2>/dev/null || return 1
  if [ -r "/proc/$1/cmdline" ]; then
    tr '\0' ' ' < "/proc/$1/cmdline" | grep -q 'index\.js' || return 1
  fi
  return 0
}

# Port resolution mirrors the gateway's own precedence (src/config.ts +
# src/configStore.ts): settings.json (dashboard overlay, wins) -> .env's
# PORT (last assignment wins, quotes/inline comments tolerated) -> 8787.
resolve_port() {
  port=""
  if [ -f "$STATE_DIR/settings.json" ]; then
    port="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]{1,5}' "$STATE_DIR/settings.json" 2>/dev/null | grep -oE '[0-9]{1,5}' | head -n1)"
  fi
  if [ -z "$port" ] && [ -f "$PROJECT_ROOT/.env" ]; then
    port="$(grep -E '^[[:space:]]*PORT[[:space:]]*=' "$PROJECT_ROOT/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | cut -d'#' -f1 | grep -oE '[0-9]{1,5}' | head -n1)"
  fi
  if [ -z "$port" ] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    port=8787
  fi
  printf '%s' "$port"
}

# 0 = healthy, 1 = not healthy, 2 = cannot determine (no curl/wget).
check_health() {
  if command -v curl >/dev/null 2>&1; then
    curl -sf --max-time 3 "http://127.0.0.1:$1/health" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O /dev/null "http://127.0.0.1:$1/health" 2>/dev/null
  else
    return 2
  fi
}

# True when something is listening on 127.0.0.1:$1 (bash /dev/tcp probe -
# no external tools needed; the fd only exists inside the subshell).
port_occupied() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# --- 1. Single-instance guard (our own PID file) -----------------------------
if [ -f "$PID_FILE" ]; then
  existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && pid_is_gateway "$existing_pid"; then
    log "Already running as PID $existing_pid. Nothing to do."
    exit 0
  fi
  # Stale: process exited, or the PID was recycled by something else.
  rm -f "$PID_FILE"
fi

PORT="$(resolve_port)"

# --- 2. Port-occupancy guard (catches anything the PID file doesn't know) ----
if port_occupied "$PORT"; then
  check_health "$PORT"
  health_rc=$?
  if [ "$health_rc" -eq 0 ]; then
    # A healthy gateway is already serving the port. Adopt its PID when we
    # can identify it (own-user processes are visible to `ss -p` without
    # root); otherwise leave it untracked - either way, the goal (exactly
    # one healthy gateway, no duplicate) is already met.
    listener_pid=""
    if command -v ss >/dev/null 2>&1; then
      listener_pid="$(ss -ltnp 2>/dev/null | awk -v port=":$PORT" '$4 ~ port"$"' | grep -oE 'pid=[0-9]+' | head -n1 | cut -d= -f2)"
    fi
    if [ -n "$listener_pid" ] && pid_is_gateway "$listener_pid"; then
      echo "$listener_pid" > "$PID_FILE"
      log "Port $PORT already served by a healthy gateway (PID $listener_pid) not previously tracked - adopted it instead of starting a duplicate."
    else
      log "Port $PORT is served by a healthy gateway, but its PID could not be identified as a directly-managed node process (Docker? another supervisor?). Leaving it untracked; not starting a duplicate."
    fi
    exit 0
  else
    log "ERROR: port $PORT is already in use and not answering /health (or curl/wget is unavailable to verify). Refusing to start a second, conflicting instance. Free the port or change PORT in .env, then retry."
    exit 1
  fi
fi

cd "$PROJECT_ROOT" || { log "ERROR: cannot cd to $PROJECT_ROOT."; exit 1; }

# --- 3. Prerequisites ----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  log "ERROR: node not found on PATH."
  exit 1
fi

# --- 4. First-run build safety net ---------------------------------------------
if [ ! -d "node_modules" ]; then
  log "node_modules missing - running npm install (first run only)..."
  if ! npm install >> "$LOG_DIR/autostart-npm-install.log" 2>&1; then
    log "ERROR: npm install failed - see $LOG_DIR/autostart-npm-install.log"
    exit 1
  fi
fi

if [ ! -f "dist/index.js" ]; then
  log "dist/index.js missing - running npm run build (first run only)..."
  if ! npm run build >> "$LOG_DIR/autostart-npm-build.log" 2>&1; then
    log "ERROR: npm run build failed - see $LOG_DIR/autostart-npm-build.log"
    exit 1
  fi
fi

# --- 5. Log rotation (keep one previous run, never grow unbounded) -------------
for f in "$LOG_DIR/gateway.log" "$LOG_DIR/gateway.err.log"; do
  [ -f "$f" ] && mv -f "$f" "$f.1"
done

# --- 6. Launch, detached ---------------------------------------------------------
# The gateway auto-opens the dashboard in a browser on every boot when
# AUTO_OPEN_BROWSER is unset (it defaults to true, for interactive
# start.sh first-runs). For an unattended boot-time launch that's wrong -
# so unless the user made an explicit choice in .env, suppress it via the
# child's environment (dotenv never overrides variables already set).
if grep -qE '^[[:space:]]*AUTO_OPEN_BROWSER[[:space:]]*=' "$PROJECT_ROOT/.env" 2>/dev/null; then
  nohup node dist/index.js >> "$LOG_DIR/gateway.log" 2>> "$LOG_DIR/gateway.err.log" &
else
  AUTO_OPEN_BROWSER=false nohup node dist/index.js >> "$LOG_DIR/gateway.log" 2>> "$LOG_DIR/gateway.err.log" &
fi
new_pid=$!
disown "$new_pid" 2>/dev/null || true
echo "$new_pid" > "$PID_FILE"
log "Launched node dist/index.js as PID $new_pid."

# --- 7. Confirm it actually came up ----------------------------------------------
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  log "Note: neither curl nor wget is available, so the /health confirmation was skipped. The process was launched; check $LOG_DIR/gateway.log."
  exit 0
fi

i=0
while [ "$i" -lt 20 ]; do
  sleep 1
  if ! kill -0 "$new_pid" 2>/dev/null; then
    log "ERROR: process exited before becoming healthy. Check $LOG_DIR/gateway.err.log."
    rm -f "$PID_FILE"
    exit 1
  fi
  if check_health "$PORT"; then
    # Startup-race resolution (mirrors the Windows runner). The pre-launch
    # port check is not atomic with the launch: two runners firing at once
    # can both see the port free, and the loser's gateway silently falls
    # back to the next port up. If the configured port's healthy listener
    # is a gateway process that ISN'T the child we just launched, we lost
    # the race: kill our own duplicate and adopt the winner.
    listener_pid=""
    if command -v ss >/dev/null 2>&1; then
      listener_pid="$(ss -ltnp 2>/dev/null | awk -v port=":$PORT" '$4 ~ port"$"' | grep -oE 'pid=[0-9]+' | head -n1 | cut -d= -f2)"
    fi
    if [ -n "$listener_pid" ] && [ "$listener_pid" != "$new_pid" ] && pid_is_gateway "$listener_pid"; then
      log "Lost a startup race: port $PORT is served by PID $listener_pid, not our child $new_pid. Stopping our duplicate and adopting the winner."
      kill "$new_pid" 2>/dev/null || true
      sleep 1
      kill -9 "$new_pid" 2>/dev/null || true
      echo "$listener_pid" > "$PID_FILE"
      exit 0
    fi
    log "Healthy on port $PORT."
    exit 0
  fi
  i=$((i + 1))
done

log "WARNING: process is running (PID $new_pid) but did not answer /health on port $PORT within 20s. Check $LOG_DIR/gateway.log."
exit 0
