#!/usr/bin/env bash
# Install go2rtc Viewer Wall: start now + a system LaunchDaemon (starts at boot, restarts on crash)
# Requires sudo (it will ask for your password)
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_SRC="$APP_DIR/com.go2rtc.wall.plist"
PLIST_DST="/Library/LaunchDaemons/com.go2rtc.wall.plist"

if [ ! -f "$PLIST_SRC" ]; then
  echo "missing $PLIST_SRC - copy it together with server.py" >&2
  exit 1
fi

sudo launchctl bootout system/com.go2rtc.wall 2>/dev/null || true
PID=\$(lsof -ti :8082 2>/dev/null || true); [ -n "\$PID" ] && kill \$PID 2>/dev/null || true

sudo cp "$PLIST_SRC" "$PLIST_DST"
sudo chmod 644 "$PLIST_DST"
sudo launchctl bootstrap system "$PLIST_DST" 2>/dev/null || sudo launchctl load "$PLIST_DST"
sleep 2

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)"
echo "installed: http://${LAN_IP}:8082/  (open it from any device on your LAN)"
