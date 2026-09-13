#!/usr/bin/env bash
# 安裝 go2rtc Viewer Wall：立即啟動 + system LaunchDaemon（開機自動、崩潰重啟）
# 需要 sudo（會提示輸入密碼）
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_SRC="$APP_DIR/com.go2rtc.wall.plist"
PLIST_DST="/Library/LaunchDaemons/com.go2rtc.wall.plist"

if [ ! -f "$PLIST_SRC" ]; then
  echo "缺少 $PLIST_SRC，請與 server.py 一起拷貝" >&2
  exit 1
fi

sudo launchctl bootout system/com.go2rtc.wall 2>/dev/null || true
PID=\$(lsof -ti :8082 2>/dev/null || true); [ -n "\$PID" ] && kill \$PID 2>/dev/null || true

sudo cp "$PLIST_SRC" "$PLIST_DST"
sudo chmod 644 "$PLIST_DST"
sudo launchctl bootstrap system "$PLIST_DST" 2>/dev/null || sudo launchctl load "$PLIST_DST"
sleep 2

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)"
echo "已安裝：http://${LAN_IP}:8082/  （網內任何裝置均可開啟）"
