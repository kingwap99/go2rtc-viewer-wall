#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
go2rtc Viewer Wall — 輕量 HTTP 伺服器（僅用 Python 標準庫）

為什麼需要代理：
  * go2rtc 的 /api/streams 不回 CORS header，跨來源 fetch 會被瀏覽器擋下
  * go2rtc 的 WebSocket（/api/ws）會拒絕帶 Origin 的握手（403），
    瀏覽器一定帶 Origin，所以必須由本伺服器代為建立上游 WS 再中繼

功能：
  * 提供靜態網頁（index.html / css / js）
  * GET  /api/settings       回傳目前 go2rtc 網址
  * PUT  /api/settings       更新 go2rtc 網址（可加 ?dry=1 只測不存）
  * GET  /api/wall           回傳牆面共用設定（選了哪些攝像頭／版面／大視窗／音量）
  * PUT  /api/wall           更新牆面共用設定（所有瀏覽器共用同一份）
  * GET  /api/streams        代理 go2rtc 串流列表（含 1.5s 快取）
  * GET  /api/ws             瀏覽器 WebSocket 中繼到 go2rtc
  * GET  /api/<其他>          HTTP 代理（hls / frame.jpg / mjpeg 等）

執行：python3 server.py [port]   （預設 8082）
"""

import base64
import hashlib
import json
import os
import select
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
SETTINGS_FILE = os.path.join(ROOT, "settings.json")
WALL_FILE = os.path.join(ROOT, "wall.json")
DEFAULT_GO2RTC = "http://192.168.1.10:1984"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("WALL_PORT", "8082"))
BIND = os.environ.get("WALL_BIND", "0.0.0.0")
STREAMS_TTL = 1.5   # 秒，串流列表快取
CONFIG_TTL = 60.0   # 秒，go2rtc 設定快取

_lock = threading.Lock()
_streams_cache = {"ts": 0.0, "data": None, "error": None}
_config_cache = {"ts": 0.0, "aliases": {}}

# 牆面共用設定：只存這些欄位，所有瀏覽器讀寫同一份 wall.json
WALL_FIELDS = ("selected", "mode", "page", "featured", "vol")
WALL_DEFAULTS = {"selected": [], "mode": "5x5", "page": 0, "featured": None, "vol": 0.7}
WALL_MODES = ("4x4", "5x5", "6x6", "7x7")
_wall_lock = threading.Lock()


def load_settings():
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            url = str(json.load(f).get("go2rtc", "") or "").strip().rstrip("/")
        return url or DEFAULT_GO2RTC
    except Exception:
        return DEFAULT_GO2RTC


def save_settings(url):
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump({"go2rtc": url}, f, ensure_ascii=False, indent=2)


# ---- 牆面共用設定（wall.json） -------------------------------------------
def _clean_wall(raw):
    """把任意輸入收斂成合法欄位，避免壞資料讓前端炸掉。"""
    src = raw if isinstance(raw, dict) else {}
    wall = {}

    selected = src.get("selected")
    if not isinstance(selected, list):
        selected = WALL_DEFAULTS["selected"]
    wall["selected"] = [str(x) for x in selected if isinstance(x, (str, int, float))][:128]

    mode = src.get("mode")
    wall["mode"] = mode if mode in WALL_MODES else WALL_DEFAULTS["mode"]

    try:
        wall["page"] = max(0, int(src.get("page") or 0))
    except (TypeError, ValueError):
        wall["page"] = 0

    featured = src.get("featured")
    wall["featured"] = str(featured) if featured else None

    try:
        vol = float(src.get("vol", WALL_DEFAULTS["vol"]))
    except (TypeError, ValueError):
        vol = WALL_DEFAULTS["vol"]
    wall["vol"] = min(1.0, max(0.0, vol))

    try:
        wall["updated"] = float(src.get("updated") or 0.0)
    except (TypeError, ValueError):
        wall["updated"] = 0.0
    return wall


def load_wall():
    try:
        with open(WALL_FILE, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        raw = {}
    return _clean_wall(raw)


def save_wall(patch):
    """以現有內容為底，覆蓋 patch 內的欄位後整份寫回（原子寫入）。"""
    with _wall_lock:
        merged = load_wall()
        if isinstance(patch, dict):
            for key in WALL_FIELDS:
                if key in patch:
                    merged[key] = patch[key]
        merged = _clean_wall(merged)
        merged["updated"] = time.time()
        tmp = WALL_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)
        os.replace(tmp, WALL_FILE)
        return merged


def go2rtc_fetch(path, timeout=5, base=None):
    """向指定的 go2rtc（預設備案設定值）抓取資料，回傳 bytes / status / content-type。"""
    url = (base or load_settings()).rstrip("/") + path
    req = urllib.request.Request(url, headers={"User-Agent": "go2rtc-viewer-wall/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.status, r.headers.get("Content-Type", "application/octet-stream")


WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WallHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        self._cc_sent = False
        super().__init__(*args, directory=ROOT, **kwargs)

    # 靜態檔（index.html / js / css）加上 no-cache：瀏覽器每次都會回伺服器驗證，
    # 檔案沒變回 304、有變就拿到新內容，避免使用者重新整理後仍執行到舊版 JS。
    def end_headers(self):
        if not self._cc_sent and not self.path.split("?", 1)[0].startswith("/api/"):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        self._cc_sent = False
        super().end_headers()

    # ---- 小工具 -----------------------------------------------------------
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cc_sent = True
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def log_message(self, fmt, *args):  # 靜音預設記錄
        pass

    # ---- GET ---------------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/ws" and self.headers.get("Upgrade", "").lower() == "websocket":
            self.handle_ws_relay()
            return
        if path == "/api/settings":
            self.send_json({"go2rtc": load_settings(), "default": DEFAULT_GO2RTC})
        elif path == "/api/wall":
            self.send_json(load_wall())
        elif path == "/api/streams":
            self.handle_streams()
        elif path == "/api/health":
            self.send_json({"ok": True, "go2rtc": load_settings()})
        elif path.startswith("/api/"):
            self.handle_proxy()
        else:
            super().do_GET()

    def handle_streams(self):
        now = time.time()
        with _lock:
            cached = _streams_cache
            if cached["data"] is not None and now - cached["ts"] < STREAMS_TTL:
                data, error = cached["data"], cached["error"]
            else:
                data, error = None, None
                try:
                    body, _status, _ct = go2rtc_fetch("/api/streams")
                    data = json.loads(body.decode("utf-8"))
                except urllib.error.HTTPError as e:
                    error = "go2rtc 回應錯誤 HTTP %s" % e.code
                except Exception as e:
                    reason = getattr(e, "reason", e)
                    error = "無法連線 go2rtc：%s" % reason
                cached.update({"ts": now, "data": data, "error": error})
        if data is not None:
            aliases = self.build_aliases(data)
            self.send_json({"go2rtc": load_settings(), "streams": data, "aliases": aliases})
        else:
            self.send_json({"go2rtc": load_settings(), "error": error, "streams": {}}, status=502)

    # ---- H.264 對應版解析（從 go2rtc 設定中的 ffmpeg 轉碼串流推導） -----------
    def build_aliases(self, streams):
        """回傳 { 串流名稱: "h264對應串流名稱或自身" }。
        例如 rsliving → rsliving_h264、no15 → no15_homekit、backyard → backyard。
        判定標準：設定中 ffmpeg:<base>#video=h264 的串流，base 就是它的來源。"""
        base_map = {}   # baseName -> [transcodedKeys]
        with _lock:
            cc = _config_cache
            if time.time() - cc["ts"] > CONFIG_TTL:
                try:
                    body, _st, _ct = go2rtc_fetch("/api/config")
                    raw = body.decode("utf-8", "ignore")
                    entries = self._parse_stream_entries(raw)
                    for key, value in entries.items():
                        for v in (value if isinstance(value, list) else [value]):
                            v = str(v).strip()
                            if v.startswith("ffmpeg:") and "#video=h264" in v:
                                base = v[len("ffmpeg:"):].split("#", 1)[0].strip()
                                if base:
                                    base_map.setdefault(base, []).append(key)
                    cc.update({"ts": time.time(), "aliases": base_map})
                except Exception:
                    cc.update({"ts": time.time()})
            base_map = cc["aliases"]

        aliases = {}
        names = set(streams.keys())
        for name in names:
            cands = base_map.get(name, [])
            # 偏好 <name>_h264，其次 <name>_homekit，再來其他（皆有行最前面的優先）
            pick = None
            for pref in (name + "_h264", name + "_homekit"):
                if pref in cands and pref in names:
                    pick = pref
                    break
            if pick is None:
                for c in cands:
                    if c in names:
                        pick = c
                        break
            aliases[name] = pick or name
        return aliases

    @staticmethod
    def _parse_stream_entries(raw):
        """粗略解析 yaml 的 streams 區塊：回傳 { key: value 或 [values] }。"""
        entries = {}
        in_streams = False
        last_key = None
        for line in raw.splitlines():
            if line.startswith("streams:"):
                in_streams = True
                continue
            if not line.strip():
                continue
            if line[0] not in (" ", "\t"):  # 非縮排的頂層 key
                in_streams = False
                continue
            if not in_streams:
                continue
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if line.startswith("    - "):  # 串流對應多來源
                if last_key is not None:
                    entries.setdefault(last_key, []).append(line[6:].strip())
                continue
            if line.startswith("  ") and ":" in line:
                key, _, value = line[2:].partition(":")
                key = key.strip()
                value = value.strip()
                if value:
                    entries[key] = value
                    last_key = key
                else:
                    last_key = key
        return entries

    # ---- WebSocket 中繼 ----------------------------------------------------
    def handle_ws_relay(self):
        client = self.connection
        client.settimeout(90)
        try:
            # 握手 header 已由 BaseHTTPRequestHandler 解析完畢
            client_key = self.headers.get("Sec-WebSocket-Key", "")
            if not client_key:
                self.send_json({"error": "missing websocket key"}, 400)
                return

            base = load_settings().rstrip("/")
            parsed = urllib.parse.urlsplit(base)
            host = parsed.hostname
            port = parsed.port or (443 if parsed.scheme == "https" else 80)

            upstream = socket.create_connection((host, port), timeout=10)
            upstream.settimeout(90)
            upstream_key = base64.b64encode(os.urandom(16)).decode("ascii")
            request = (
                "GET %s HTTP/1.1\r\n"
                "Host: %s:%d\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Key: %s\r\n"
                "Sec-WebSocket-Version: 13\r\n"
                "\r\n" % (self.path, host, port, upstream_key)
            )
            upstream.sendall(request.encode("ascii"))
            up_head, _up_rest = self._read_http_head(upstream)
            if not up_head.startswith(b"HTTP/1.1 101"):
                upstream.close()
                self.send_json({"error": "上游 go2rtc 握手失敗"}, 502)
                return

            accept = base64.b64encode(
                hashlib.sha1((client_key + WS_GUID).encode("ascii")).digest()
            ).decode("ascii")
            response = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Accept: %s\r\n"
                "\r\n" % accept
            )
            client.sendall(response.encode("ascii"))
            self._relay(client, upstream)
        except Exception:
            pass
        finally:
            try:
                client.close()
            except OSError:
                pass

    @staticmethod
    def _read_http_head(sock, maxlen=65536):
        buf = b""
        while b"\r\n\r\n" not in buf:
            try:
                chunk = sock.recv(4096)
            except (socket.timeout, OSError):
                break
            if not chunk:
                break
            buf += chunk
            if len(buf) > maxlen:
                break
        head, _, _rest = buf.partition(b"\r\n\r\n")
        return head, _rest

    @staticmethod
    def _relay(a, b):
        sockets = [a, b]
        while True:
            try:
                ready, _, _ = select.select(sockets, [], [], 60)
            except (socket.timeout, OSError):
                return
            if not ready:
                return
            for s in ready:
                try:
                    data = s.recv(65536)
                except OSError:
                    return
                if not data:
                    return
                other = b if s is a else a
                try:
                    other.sendall(data)
                except OSError:
                    return

    # ---- HTTP 代理（/api/* 其餘路徑） ---------------------------------------
    def handle_proxy(self):
        url = load_settings().rstrip("/") + self.path
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "go2rtc-viewer-wall/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                status = resp.status
                ctype = resp.headers.get("Content-Type", "application/octet-stream")
        except urllib.error.HTTPError as e:
            body = e.read()
            status = e.code
            ctype = e.headers.get("Content-Type", "text/plain")
        except Exception as e:
            reason = getattr(e, "reason", e)
            self.send_json({"error": "proxy error: %s" % reason}, 502)
            return
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---- PUT ---------------------------------------------------------------
    def do_PUT(self):
        path, _, query = self.path.partition("?")
        dry = "dry=1" in query
        if path == "/api/wall":
            try:
                payload = json.loads(self.read_body().decode("utf-8") or "{}")
            except Exception:
                self.send_json({"error": "invalid JSON"}, 400)
                return
            if not isinstance(payload, dict):
                self.send_json({"error": "expect JSON object"}, 400)
                return
            self.send_json(save_wall(payload))
            return
        if path != "/api/settings":
            self.send_json({"error": "not found"}, 404)
            return
        try:
            payload = json.loads(self.read_body().decode("utf-8") or "{}")
        except Exception:
            self.send_json({"error": "invalid JSON"}, 400)
            return
        url = str(payload.get("go2rtc") or "").strip()
        if not url:
            self.send_json({"error": "go2rtc url 不可為空"}, 400)
            return
        if not url.startswith(("http://", "https://")):
            url = "http://" + url
        url = url.rstrip("/")
        try:
            body, _status, _ct = go2rtc_fetch("/api/streams", timeout=5, base=url)
            count = len(json.loads(body.decode("utf-8")))
        except Exception as e:
            reason = getattr(e, "reason", e)
            self.send_json({"error": "無法連線 %s：%s" % (url, reason)}, 502)
            return
        if not dry:
            save_settings(url)
            with _lock:
                _streams_cache.update({"ts": 0.0, "data": None, "error": None})
        self.send_json({"ok": True, "go2rtc": url, "streamCount": count})


def main():
    server = ThreadingHTTPServer((BIND, PORT), partial(WallHandler))
    print("go2rtc Viewer Wall  http://0.0.0.0:%d/  (go2rtc: %s)" % (PORT, load_settings()), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
