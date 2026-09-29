#!/usr/bin/env bash
# Install go2rtc Viewer Wall: start now + a system LaunchDaemon (starts at boot, restarts on crash).
# Requires sudo (it will ask for your password).
#
#   bash install.sh            # inside a checkout: install this copy, listening on 8082
#   bash install.sh 9000       # ... on another port
#   DRY_RUN=1 bash install.sh  # print the LaunchDaemon it would write, install nothing
#
# From anywhere, without cloning first (downloads to ~/go2rtc-viewer-wall):
#
#   curl -fsSL https://raw.githubusercontent.com/kingwap99/go2rtc-viewer-wall/main/install.sh | bash
#
# G2RW_DIR picks another download folder, G2RW_REF another branch or tag.
#
# com.go2rtc.wall.plist is a template: this script substitutes this machine's
# directory, user and interpreter into it, so a checkout works wherever it lives.
# Do not copy the template straight to /Library/LaunchDaemons.
set -euo pipefail

PORT="${1:-8082}"
case "$PORT" in
  ''|*[!0-9]*)
    echo "port must be a number, got '$PORT'" >&2
    exit 1
    ;;
esac

REPO_SLUG="kingwap99/go2rtc-viewer-wall"
REF="${G2RW_REF:-main}"
DEST="${G2RW_DIR:-$HOME/go2rtc-viewer-wall}"
LABEL="com.go2rtc.wall"
DRY_RUN="${DRY_RUN:-0}"

APP_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "$PWD")"
PLIST_TEMPLATE="$APP_DIR/$LABEL.plist"
PLIST_DST="/Library/LaunchDaemons/$LABEL.plist"
RUN_USER="${SUDO_USER:-$(id -un)}"
PYTHON_BIN="$(command -v python3 || true)"

is_checkout() {
  [ -f "$1/server.py" ] && [ -f "$1/$LABEL.plist" ] && [ -f "$1/index.html" ]
}

# Running from a checkout installs that copy. Running from anywhere else - the piped
# one-liner, an unrelated shell - downloads the repository first, so "download and
# install" is one command.
if ! is_checkout "$APP_DIR"; then
  if is_checkout "$DEST"; then
    echo "using the existing checkout in $DEST"
  else
    if [ "$DRY_RUN" = "1" ]; then
      echo "no checkout here - would download $REPO_SLUG ($REF) to $DEST" >&2
      exit 0
    fi
    if [ -e "$DEST" ]; then
      echo "$DEST exists but is not a go2rtc Viewer Wall checkout; set G2RW_DIR to use another folder" >&2
      exit 1
    fi
    if ! command -v curl >/dev/null 2>&1; then
      echo "curl not found - clone the repository yourself and run install.sh inside it" >&2
      exit 1
    fi
    echo "downloading $REPO_SLUG ($REF) to $DEST"
    mkdir -p "$DEST"
    if ! curl -fsSL "https://codeload.github.com/$REPO_SLUG/tar.gz/refs/heads/$REF" \
        | tar -xz -C "$DEST" --strip-components=1; then
      echo "download failed - remove $DEST and try again" >&2
      exit 1
    fi
    echo "downloaded to $DEST"
  fi
  APP_DIR="$DEST"
  PLIST_TEMPLATE="$APP_DIR/$LABEL.plist"
fi

if [ ! -f "$PLIST_TEMPLATE" ]; then
  echo "missing $PLIST_TEMPLATE - copy it together with server.py" >&2
  exit 1
fi
if [ ! -f "$APP_DIR/server.py" ]; then
  echo "missing $APP_DIR/server.py - this is not a complete checkout" >&2
  exit 1
fi
if [ -z "$PYTHON_BIN" ]; then
  echo "python3 not found in PATH - install Python 3 (or the Xcode Command Line Tools) first" >&2
  exit 1
fi
# launchd gives the daemon no shell and no PATH, so the interpreter has to work on
# its own. /usr/bin/python3 is the Command Line Tools shim on macOS: without CLT it
# only prompts for an install, which under launchd is a permanent crash loop.
if ! "$PYTHON_BIN" -c 'import http.server, json, select, socket, urllib.request' >/dev/null 2>&1; then
  echo "$PYTHON_BIN cannot import the standard library modules server.py needs." >&2
  echo "Run this as your normal user (not 'sudo bash install.sh') so it uses your PATH python3." >&2
  exit 1
fi
if [ "$RUN_USER" = "$(id -un)" ] && [ ! -w "$APP_DIR" ]; then
  echo "$APP_DIR is not writable, but the daemon writes server.log there" >&2
  exit 1
fi

# Fill the template with this machine's values (a checkout can live anywhere, so the
# plist cannot hardcode a home directory, a user name or an interpreter).
render_plist() {
  G2RW_APP_DIR="$APP_DIR" \
  G2RW_PYTHON_BIN="$PYTHON_BIN" \
  G2RW_RUN_USER="$RUN_USER" \
  G2RW_LABEL="$LABEL" \
  G2RW_PORT="$PORT" \
  "$PYTHON_BIN" - "$PLIST_TEMPLATE" <<'PY'
import os
import sys

text = open(sys.argv[1], encoding="utf-8").read()
for key, value in {
    "__APP_DIR__": os.environ["G2RW_APP_DIR"],
    "__PYTHON_BIN__": os.environ["G2RW_PYTHON_BIN"],
    "__RUN_USER__": os.environ["G2RW_RUN_USER"],
    "__LABEL__": os.environ["G2RW_LABEL"],
    "__PORT__": os.environ["G2RW_PORT"],
}.items():
    text = text.replace(key, value)
sys.stdout.write(text)
PY
}

if [ "$DRY_RUN" = "1" ]; then
  render_plist
  echo "(DRY_RUN=1: nothing was installed)" >&2
  exit 0
fi

sudo launchctl bootout "system/$LABEL" 2>/dev/null || true

# Free the port if server.py was also started by hand: otherwise the daemon binds
# nothing and KeepAlive turns that into a crash loop.
if command -v lsof >/dev/null 2>&1; then
  STALE_PID="$(lsof -ti ":$PORT" 2>/dev/null || true)"
  if [ -n "$STALE_PID" ]; then
    echo "stopping the process already listening on $PORT (pid $STALE_PID)"
    kill $STALE_PID 2>/dev/null || true
    sleep 1
  fi
fi

render_plist | plutil -lint - >/dev/null
render_plist | sudo tee "$PLIST_DST" >/dev/null
sudo chmod 644 "$PLIST_DST"
sudo chown root:wheel "$PLIST_DST"
sudo launchctl bootstrap system "$PLIST_DST" 2>/dev/null || sudo launchctl load "$PLIST_DST"

# A wrong interpreter or a busy port leaves a daemon that crash-loops under
# KeepAlive, so prove it is serving before reporting success.
HEALTHY=0
if command -v curl >/dev/null 2>&1; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      HEALTHY=1
      break
    fi
    sleep 0.5
  done
else
  echo "curl not found - skipping the post-install health check" >&2
  HEALTHY=1
fi

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)"
if [ "$HEALTHY" = "1" ]; then
  echo "installed and running: http://$LAN_IP:$PORT/  (open it from any device on your LAN)"
else
  echo "installed, but http://127.0.0.1:$PORT/api/health never answered." >&2
  echo "the daemon is probably crash-looping; check:" >&2
  echo "  tail -n 40 $APP_DIR/server.log" >&2
  echo "  sudo launchctl print system/$LABEL" >&2
  exit 1
fi
