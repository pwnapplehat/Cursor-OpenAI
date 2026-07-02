#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "============================================"
echo "  Cursor OpenAI Gateway"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found on this computer."
  echo
  echo "Please install Node.js 18 or newer from https://nodejs.org (the \"LTS\" download is fine),"
  echo "then run this script again."
  echo
  if command -v open >/dev/null 2>&1; then open "https://nodejs.org"; fi
  exit 1
fi

# A gateway from this folder may already be running (e.g. installed via
# autostart/, or started in another terminal). Starting a second copy would
# not fail loudly - the gateway's initial-boot port fallback would silently
# bind the NEXT port up, leaving two gateways for one repo. Detect that and
# open the existing dashboard instead.
RUNNING_PORT="$(node scripts/check-running.mjs 2>/dev/null || true)"
if [ -n "$RUNNING_PORT" ]; then
  echo "A gateway from this folder is already running at http://localhost:$RUNNING_PORT"
  echo "(likely the autostart/ background service - see autostart/README.md)."
  echo "Opening its dashboard instead of starting a second copy."
  echo
  echo "To stop the running gateway first: autostart/linux/uninstall.sh --stop-running (or your service manager)."
  if command -v open >/dev/null 2>&1; then open "http://localhost:$RUNNING_PORT"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$RUNNING_PORT"
  fi
  exit 0
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies - this only happens once, it may take a minute..."
  npm install
fi

if [ ! -f "dist/index.js" ]; then
  echo "Building the gateway - this only happens once..."
  npm run build
fi

if [ ! -f ".env" ]; then
  echo "No .env file found - the setup wizard will open in your browser to configure everything."
  echo
fi

echo "Starting the gateway... a browser window should open automatically."
echo "Press Ctrl+C to stop the gateway."
echo

npm start
