# go2rtc Viewer Wall

Show many go2rtc streams at once on a single web wall. The layout and
interactions mirror [opencast-grid](https://github.com/kingwap99/opencast-grid)
(the web version of an IPTV wall), and playback is built on go2rtc's
[VideoRTC](https://github.com/AlexxIT/go2rtc)
(automatic WebRTC -> MSE -> HLS -> MJPEG fallback).

## Layout

- One centre hero window + a ring of mini windows, like the Hero/Ring design in opencast-grid
- 5x5 = 1 centre hero + 16 mini windows
  4x4 = 12 mini, 6x6 = 20 mini, 7x7 = 24 mini
- Click any mini window to swap it into the centre hero (the same stream session is kept, audio fades in/out)
- Click the hero once for fullscreen; click again or press Esc to go back to the previous layout (mode and page are remembered)
- Extra cameras beyond one ring are paged (`< 1/3 >`, or arrow keys)
- Hero-only controls: sound, pause/resume all, remove; volume slider

## Other features

- Custom go2rtc URL (the built-in default is only an example, set yours in the gear menu)
- Tick the cameras you want from the go2rtc stream list, with search, reordering and a "select all online" button
- Automatic "H.264 playable counterpart": a HEVC-only stream is transparently replaced by an
  existing `#video=h264` transcode of the same camera (e.g. `cam1` -> `cam1_h264`);
  the picker marks those with `->`. Streams without a counterpart fall back to MJPEG
  after 12 seconds without a picture
- Selection, layout, hero and volume are **stored in one shared server-side file** (`wall.json`),
  so another computer or another browser sees exactly the same wall; localStorage is only an offline fallback
- Each mini window shows its live connection mode (RTC/MSE/HLS/MJPEG) and an offline badge

## Switching no longer reloads anything

- Each camera has exactly one long-lived element (`.channel`) whose `<video>`/WebSocket never changes.
  Switching hero/mini, entering or leaving fullscreen and changing the grid (4x4 <-> 5x5) only update
  `left/top/width/height` and classes, so the picture never breaks, never flashes black and never reconnects.
- Only paging to a camera that is not on the current page, or removing a camera, really releases a connection.
- When a stream is genuinely dead (not even MJPEG gives a picture) it is retried with the full
  protocol chain at most once every 60 seconds, up to 3 times, so one short congestion spike does not
  lock a tile on "no signal" forever.
- Static files (index.html / js / css) are served with `Cache-Control: no-cache`, so a normal
  browser reload is enough to pick up a new build.

## Shared settings (one wall across multiple computers)

- `GET /api/wall` / `PUT /api/wall`, stored as `wall.json` next to server.py
- Fields: `selected` (camera order), `mode` (4x4/5x5/6x6/7x7), `page`,
  `featured` (hero camera), `vol` (volume), plus an `updated` timestamp
- The front end polls every 4 seconds, so a layout / camera / volume change made on another
  computer shows up here within about 4 seconds
- It only sends fields that actually differ from the server state, to avoid write ping-pong between tabs
- On the very first load (no `wall.json` yet) the browser pushes its own localStorage content,
  so existing users do not have to re-pick their cameras

## Run

Python 3 only (standard library, no third-party packages):

    python3 server.py [port]      # default 8082

Then open http://<this-machine>:8082/ .

## Why a server is needed

- go2rtc's api/streams sends no CORS header, so a cross-origin fetch is blocked by the browser
- go2rtc's WebSocket rejects handshakes that carry an Origin header (403), and browsers always send one

So this server does two things: it proxies api/streams (including settings changes) and relays
the WebSocket to go2rtc, keeping the whole page same-origin on :8082. You can still point it at any go2rtc.

## Install as a service (macOS)

    bash install.sh     # start now + register as a launchd system daemon (needs sudo)

## Home Assistant add-on

This repository is also a Home Assistant add-on repository:

1. Home Assistant -> Settings -> Add-ons -> Add-on store -> menu (top right) -> Repositories
2. Add `https://github.com/kingwap99/go2rtc-viewer-wall`
3. Install **go2rtc Viewer Wall** and open its Configuration tab:
   - `go2rtc_url` defaults to `http://localhost:1984`, which matches the
     official go2rtc add-on when it uses host networking
   - `port` defaults to `8082`
4. Start the add-on and open `http://<your-home-assistant-host>:8082/`

The add-on runs with host networking so it can reach go2rtc (and your cameras)
on the host network. Camera selection, layout, hero and volume are stored in
the add-on's `/data` folder and survive restarts and updates.

## Files

    server.py       HTTP + WebSocket proxy (Python standard library)
    index.html      the wall page
    css/style.css   styling (hero + ring layout)
    js/app.js       wall logic (mirrors the opencast-grid interactions)
    js/video-rtc.js go2rtc playback core (v1.9.14, unmodified)
    assets/icon.svg icon
    addon/          Home Assistant add-on (config.yaml, Dockerfile, run.sh, DOCS.md)
    repository.yaml Home Assistant add-on repository metadata
    README.md       this document
    settings.json   the configured go2rtc URL (generated automatically)
    wall.json       shared wall settings (cameras / layout / hero / volume, generated automatically)
