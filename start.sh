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
