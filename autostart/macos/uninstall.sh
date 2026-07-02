#!/usr/bin/env bash
# Removes the LaunchAgent installed by install.sh. `launchctl unload` stops
# the running instance as part of this - macOS/launchd has no separate
# "stop autostarting but leave it running" mode the way systemd/Task
# Scheduler do, so there is no -StopRunning-style flag here: removing the
# agent and stopping it are the same operation on this platform.
set -uo pipefail

LABEL="com.cursor-openai.gateway"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$PLIST_PATH" ]; then
  launchctl unload -w "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "Removed launch agent: $PLIST_PATH"
  echo "(the running gateway process was stopped by 'launchctl unload' above)"
else
  echo "No autostart hook was installed (nothing to remove)."
fi

echo
echo "Autostart uninstalled."
