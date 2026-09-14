# go2rtc Viewer Wall

Show all your [go2rtc](https://github.com/AlexxIT/go2rtc) cameras on a single
web wall. The layout and interactions mirror
[opencast-grid](https://github.com/kingwap99/opencast-grid): one centre hero
window plus a ring of mini windows. Playback uses go2rtc's VideoRTC with
automatic WebRTC -> MSE -> HLS -> MJPEG fallback.

## Configuration

| Option | Default | Description |
| ------ | ------- | ----------- |
| `go2rtc_url` | `http://localhost:1984` | Address of your go2rtc instance. `localhost:1984` matches the official go2rtc add-on when it uses host networking. |
| `port` | `8082` | TCP port the wall listens on. |

The add-on uses **host networking**, so it can talk to your other host-networked
add-ons (camera devices are often only reachable from the host network).

## Usage

1. Start the add-on.
2. Open `http://<your-home-assistant-host>:8082/`.
3. Choose the go2rtc URL if it is not the default, then pick the cameras you
   want to watch. Selection, layout, hero window and volume are shared by every
   browser that opens the same page.

## Persistence

Wall layout and settings are stored in the add-on's `/data` folder, so they
survive add-on updates and container rebuilds.
