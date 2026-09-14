# Changelog

## 1.0.3

- Wall settings now live in /config/go2rtc_viewer_wall.yaml, hand-editable YAML
  in the same folder as go2rtc.yaml. Standalone installs keep wall.json.

## 1.0.2

- Fixed black / "no signal" tiles after the ingress update: the WebSocket relay
  now keeps the `?src=` query when forwarding to go2rtc.

## 1.0.1

- Embedded in the Home Assistant sidebar (ingress); direct access on port 8082 still works.

## 1.0.0

- Initial Home Assistant add-on release.
- Host networking, configurable go2rtc URL and listen port.
- Wall layout and settings persisted under /data.
