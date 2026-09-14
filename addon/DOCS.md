# go2rtc Viewer Wall

Show all your [go2rtc](https://github.com/AlexxIT/go2rtc) cameras on a single
web wall. The layout and interactions mirror
[opencast-grid](https://github.com/kingwap99/opencast-grid): one centre hero
window plus a ring of mini windows. Playback uses go2rtc's VideoRTC with
automatic WebRTC -> MSE -> HLS -> MJPEG fallback.

The wall is embedded in Home Assistant: just click **go2rtc Viewer Wall** in the
sidebar to open it.

## Configuration

| Option | Default | Description |
| ------ | ------- | ----------- |
| `go2rtc_url` | `http://localhost:1984` | Address of your go2rtc instance. `localhost:1984` matches the official go2rtc add-on when it uses host networking. |

The add-on uses **host networking**, so it can talk to your other host-networked
add-ons (camera devices are often only reachable from the host network).

## Usage

1. Start the add-on.
2. Open it from the Home Assistant sidebar, or directly at
   `http://<your-home-assistant-host>:8082/`.
3. Choose the go2rtc URL if it is not the default, then pick the cameras you
   want to watch. Selection, layout, hero window and volume are shared by every
   browser that opens the same page.

## Persistence

The wall's shared settings live in
`/config/go2rtc_viewer_wall.yaml` - the same folder as
`go2rtc.yaml` - so you can hand-edit them like the go2rtc config:

    # go2rtc viewer wall
    selected:
      - front_door
      - backyard
    mode: 4x4
    featured: front_door
    vol: 0.7

Edits are picked up while the add-on is running (the page polls every
4 seconds). The file is rewritten whenever you change the wall in the browser,
and because it sits in the HA config folder it is included in Home Assistant
backups. The go2rtc URL itself stays configured in the add-on options.
