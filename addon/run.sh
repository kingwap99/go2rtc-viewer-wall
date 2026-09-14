#!/bin/sh
set -e

# Home Assistant add-ons receive their options as /data/options.json.
OPTIONS=/data/options.json
GO2RTC_URL="http://localhost:1984"

if [ -f "$OPTIONS" ]; then
  GO2RTC_URL=$(python3 -c 'import json; print(json.load(open("/data/options.json")).get("go2rtc_url", "http://localhost:1984"))')
fi

export GO2RTC_URL
# Keep wall.json / settings.json in /data so the wall survives container rebuilds.
export WALL_DATA_DIR=/data
# Shared wall settings live as YAML next to go2rtc.yaml, hand-editable like it.
export WALL_CONFIG_FILE=/config/go2rtc_viewer_wall.yaml

cd /app
exec python3 server.py
