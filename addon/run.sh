#!/usr/bin/env bash
set -e

# Home Assistant add-ons receive their options as /data/options.json.
OPTIONS=/data/options.json
PORT=8082
GO2RTC_URL="http://localhost:1984"

if [ -f "$OPTIONS" ]; then
  PORT=$(python3 -c 'import json; print(json.load(open("/data/options.json")).get("port", 8082))')
  GO2RTC_URL=$(python3 -c 'import json; print(json.load(open("/data/options.json")).get("go2rtc_url", "http://localhost:1984"))')
fi

export GO2RTC_URL
# Keep wall.json / settings.json in /data so the wall survives container rebuilds.
export WALL_DATA_DIR=/data
export WALL_PORT="$PORT"

cd /app
exec python3 server.py "$PORT"
