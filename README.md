# go2rtc Viewer Wall

把 go2rtc 的多個串流同時顯示在一個網頁牆面上，版面與互動鏡射自
[opencast-grid](https://github.com/kingwap99/opencast-grid)（IPTV Wall 的網頁版），
播放核心沿用 go2rtc 的 [VideoRTC](https://github.com/AlexxIT/go2rtc)
（WebRTC -> MSE -> HLS -> MJPEG 自動降級）。

## 版面（重點）

- 中央大視窗（Hero）+ 外圈小視窗（Mini），如同 opencast-grid 的 Hero/Ring 設計
- 5×5 = 中間 1 個大視窗 + 外圈 16 個小視窗
  4×4 = 12 個外圈、6×6 = 20 個、7×7 = 24 個
- 點任一小視窗 → 切換成中央大視窗（同一串流 session 沿用，音訊淡入淡出）
- 大視窗單按 → 全螢幕；再按或 Esc → 恢復原本版面（記憶模式與頁數）
- 超過外圈上限時自動翻頁（‹ 1/3 ›，或鍵盤 ←/→）
- 大視窗專屬控制：聲音、全部暫停/播放、移除；音量滑桿

## 其他功能

- 自訂 go2rtc 網址（程式內的預設值只是範例，請在右上角 ⚙️ 設定裡改成你的 go2rtc 位址）
- 從 go2rtc 串流清單勾選要顯示的攝像頭，可排序、搜尋、一次選取「在線」
- 自動選擇「H.264 可播對應檔」：HEVC 原生串流自動改用設定中既有的
  #video=h264 轉碼檔（no15 -> no15_h264、backyard -> backyard_h264、
  rsliving -> rsliving_h264），選單中會以「→」標示；
  沒有對應檔的會 12 秒沒畫面後自動降級 MJPEG
- 選擇、版面、大視窗與音量**存在伺服器端共用一份**（`wall.json`），
  換一台電腦／換一個瀏覽器打開看到的牆面完全一樣；localStorage 只是離線後備
- 每個小視窗的連接模式（RTC/MSE/HLS/MJPEG）與離線燈號即時顯示

## 切換不再重新載入

- 每台攝像頭只有一個常駐元素（`.channel`），內部 `<video>`／WebSocket 從頭到尾不變。
  切換大/小視窗、進出全螢幕、換版面（4×4 ↔ 5×5）只改 `left/top/width/height` 與 class，
  因此畫面不會中斷、不會閃黑、也不會重新連線。
- 只有「翻頁到不在本頁的相機」或「移除相機」才會真的釋放連線。
- 真的無訊號（連 MJPEG 都拿不到畫面）時，最多每 60 秒用完整協定鏈重試一次、最多 3 次，
  避免一次短暫壅塞就被永久鎖在「無訊號」。
- 靜態檔（index.html / js / css）回應 `Cache-Control: no-cache`：
  一般重新整理就會拿到最新版本，不必清快取。

## 共用設定（多台電腦看到同一面牆）

- `GET /api/wall` / `PUT /api/wall`，存成 `wall.json`（與 server.py 同目錄）
- 欄位：`selected`（相機順序）、`mode`（4x4/5x5/6x6/7x7）、`page`、
  `featured`（大視窗）、`vol`（音量），另有 `updated` 時間戳
- 前端每 4 秒輪詢一次；別台電腦改了版面／選台／音量，這裡大約 4 秒內跟著變
- 只送出「與伺服器現況不同」的欄位，避免多分頁互相回寫造成乒乓
- 第一次開啟（伺服器還沒有 wall.json）時，會把該瀏覽器原本的 localStorage 內容推上去，
  所以舊的使用者不用重新選一次

## 執行

只需要 Python 3（標準庫，無第三方套件）：

    python3 server.py [port]      # 預設 8082

瀏覽 http://機器IP:8082/ 。

## 為什麼需要這台伺服器

- go2rtc 的 api/streams 沒有 CORS header，跨來源 fetch 會被瀏覽器擋下
- go2rtc 的 WebSocket 會拒絕帶 Origin 的握手（403），瀏覽器一定帶 Origin

因此本伺服器做兩件事：代理 api/streams（含設定切換），並把 WebSocket
中繼到 go2rtc（網頁全部走同源 :8082，使用者也可以換任何 go2rtc 位址）。

## 安裝為常駐服務（macOS）

    bash install.sh     # 立即啟動 + 設定為 launchd system daemon（需 sudo）

## 檔案

    server.py       HTTP + WebSocket 代理（Python 標準庫）
    index.html      牆面頁面
    css/style.css   樣式（Hero + 外圈版面）
    js/app.js       牆面邏輯（鏡射 opencast-grid 互動）
    js/video-rtc.js go2rtc 播放核心（v1.9.14 原廠未改）
    assets/icon.svg 圖示
    settings.json   目前設定的 go2rtc 網址（自動產生）
    wall.json       共用牆面設定（選台／版面／大視窗／音量，自動產生）
