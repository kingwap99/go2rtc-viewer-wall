import {VideoRTC} from './video-rtc.js';

/* =====================================================================
 * go2rtc Viewer Wall
 * 版面與互動鏡射自 opencast-grid（kingwap99）的核心設計：
 *   - 中央大視窗（Hero）＋ 外圈小視窗（Mini）
 *   5×5 = 中間 1 個大視窗 + 外圈 16 個小視窗（4×4: 12 個、6×6: 20 個、7×7: 24 個）
 *   - 點小視窗 → 切換成中央大視窗（同一個播放 session 沿用）
 *   - 大視窗單按 → 全螢幕，再按/Esc 恢復
 *   - 翻頁（‹ 1/2 ›）、音訊淡入淡出
 * 播放核心沿用 go2rtc 的 VideoRTC（WebRTC → MSE → HLS → MJPEG）
 * ===================================================================== */

const $ = sel => document.querySelector(sel);

function element(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key === 'text') node.textContent = value;
    else if (key === 'checked' || key === 'disabled' || key === 'muted') node[key] = Boolean(value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

function toast(message, duration = 2600) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.remove('hidden');
  setTimeout(() => node.classList.add('hidden'), duration);
}

const LS = {
  selected: 'g2rwall:selected',
  mode: 'g2rwall:mode',
  page: 'g2rwall:page',
  featured: 'g2rwall:featured',
  vol: 'g2rwall:vol',
};

/* 牆面共用設定：真正的一份存在伺服器端 /api/wall（所有瀏覽器共用），
   localStorage 降級成「離線後備快取」，不再是最終依據。
   —— 換一台電腦／換一個瀏覽器打開，看到的牆面完全一樣。 */
let wallServer = {selected: [], mode: '5x5', page: 0, featured: null, vol: 0.7, updated: 0};
let wallPushTimer = null;
const wallPending = {};

function wallKey(value) { return JSON.stringify(value); }

/* 只送出與伺服器現況不同的欄位；相同就不送，避免多個瀏覽器互相回寫造成乒乓 */
function pushWall(patch) {
  let dirty = false;
  for (const [key, value] of Object.entries(patch)) {
    if (wallKey(value) === wallKey(wallServer[key])) continue;
    wallPending[key] = value;
    dirty = true;
  }
  if (!dirty) return;
  clearTimeout(wallPushTimer);
  wallPushTimer = setTimeout(flushWall, 300);
}

async function flushWall() {
  clearTimeout(wallPushTimer);
  wallPushTimer = null;
  const body = {...wallPending};
  for (const key of Object.keys(wallPending)) delete wallPending[key];
  if (Object.keys(body).length === 0) return;
  try {
    const res = await fetch('/api/wall', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data && typeof data.updated === 'number') wallServer = {...wallServer, ...data};
  } catch (e) { /* 伺服器不可用時，localStorage 後備仍然有效 */ }
}

/* 套用共用設定到本機狀態並同步 UI；doRender=false 表示只更新狀態不重繪 */
function applyWallState(w, doRender = true) {
  if (Array.isArray(w.selected)) state.selected = w.selected.slice();
  if (['4x4', '5x5', '6x6', '7x7'].includes(w.mode)) state.mode = w.mode;
  state.featured = w.featured || null;
  if (typeof w.vol === 'number') state.heroVolume = Math.min(1, Math.max(0, w.vol));
  const page = Number.isFinite(w.page) ? Math.max(0, Math.trunc(w.page)) : 0;
  state.page = Math.min(page, Math.max(0, pageCount() - 1));

  localStorage.setItem(LS.selected, JSON.stringify(state.selected));
  localStorage.setItem(LS.mode, state.mode);
  localStorage.setItem(LS.page, String(state.page));
  localStorage.setItem(LS.vol, String(state.heroVolume));
  if (state.featured) localStorage.setItem(LS.featured, state.featured);

  document.querySelectorAll('#mode-group button').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.mode === state.mode));

  for (const name of [...state.pools.keys()]) {
    if (!state.selected.includes(name)) dropPool(name);
  }
  if (doRender) render();
}

/* 讀取伺服器上的共用設定；updated=0 代表從沒存過（改用 localStorage 後備） */
async function loadWall() {
  try {
    const data = await api('/api/wall');
    if (data && typeof data.updated === 'number') {
      wallServer = {...wallServer, ...data};
      return data.updated > 0 ? data : null;
    }
  } catch (e) { /* 忽略，走後備 */ }
  return null;
}

/* 輪詢共用設定，讓其他分頁／電腦的改動自動反映過來 */
async function pollWall() {
  if (wallPushTimer || Object.keys(wallPending).length > 0) return;
  try {
    const data = await api('/api/wall');
    if (!data || typeof data.updated !== 'number') return;
    if (data.updated > wallServer.updated + 0.0005) {
      wallServer = {...wallServer, ...data};
      applyWallState(data);
    }
  } catch (e) { /* 忽略 */ }
}

const state = {
  go2rtc: '',
  streams: {},           // name -> go2rtc api/streams 資料
  aliases: {},           // name -> h264 可播對應串流（或自身）
  streamsError: null,
  selected: [],          // 依序排列的攝像頭名稱
  mode: localStorage.getItem(LS.mode) || '5x5',
  page: Number(localStorage.getItem(LS.page) || 0),
  featured: localStorage.getItem(LS.featured) || null,
  fullscreen: false,
  modeBefore: '5x5',
  pageBefore: 0,
  paused: false,
  heroMuted: false,
  heroVolume: Number(localStorage.getItem(LS.vol) || 0.7),
  autoFocus: false,      // 是否已自動把大視窗換到有畫面的相機
  pools: new Map(),      // name -> {name, eff, st, forcedMJPEG, lastMode}
  views: new Map(),      // name -> 常駐的 .channel 元素（切換大小視窗只換位置，不重建）
  heroSlot: null,        // 外圈顯示「目前大視窗」的空位
  heroPlayer: null,
  statusTimer: null,
  streamTimer: null,
  wallTimer: null,
  hideTimer: null,
};

/* ---------------- 播放元素（VideoRTC 包裝） ---------------- */
class WallStream extends VideoRTC {
  oninit() {
    super.oninit();
    this.video.controls = false;
    this.video.muted = true;
  }

  /* VideoRTC 原本要等元素連上 DOM 才在 oninit() 建立 this.video，
     但這個牆面的 Hero / Mini 共用同一個 play session，會在元素還沒進頁面時
     就設定靜音與音量（未進 DOM 的 this.video 會是 null 而丟錯），
     所以這裡提供一個「先確保 <video> 存在」的入口。 */
  ensureVideo() {
    if (!this.video) this.oninit();
    return this;
  }

  onopen() {
    // 降級 MJPEG 或換頁釋放時，舊 socket 的 open 事件可能晚一步才到，
    // 此時 this.ws 已被 ondisconnect() 清空，直接結束避免丟錯中斷。
    if (!this.ws || !this.video) return;
    const result = super.onopen();
    this.onmessage['stream'] = msg => {
      if (['webrtc', 'mse', 'hls', 'mp4', 'mjpeg'].includes(msg.type)) {
        this.dispatchEvent(new CustomEvent('wallmode', {detail: msg.type.toUpperCase()}));
      } else if (msg.type === 'error') {
        this.dispatchEvent(new CustomEvent('wallerror', {detail: msg.value}));
      }
    };
    return result;
  }

  /* 降級 MJPEG 時我們會主動 ondisconnect()+onconnect()，
     舊 socket 的 close 事件常常晚於新連線才送達，
     若不忽略就會把新連線的 this.ws 清成 null（接著 onopen 直接丟錯）。
     只有「目前這個 socket 真的已經關閉」時才交給原本的 onclose 去重連。 */
  onclose() {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return false;
    return super.onclose();
  }

  onpcvideo(ev) {
    super.onpcvideo(ev);
    if (this.pcState !== WebSocket.CLOSED) {
      this.dispatchEvent(new CustomEvent('wallmode', {detail: 'RTC'}));
    }
  }
}
customElements.define('wall-stream', WallStream);

/* ---------------- 工具 ---------------- */
function modeCount() { return {'4x4': 4, '5x5': 5, '6x6': 6, '7x7': 7}[state.mode] || 5; }
function visiblePageSize() { return 4 * modeCount() - 4; }
function pageCount() { return Math.max(1, Math.ceil(state.selected.length / visiblePageSize())); }
function pageCameras() {
  const start = (state.page % pageCount()) * visiblePageSize();
  return state.selected.slice(start, start + visiblePageSize());
}

function perimeterCells(count) {
  const cells = [];
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (row === 0 || row === count - 1 || column === 0 || column === count - 1) cells.push({row, column});
    }
  }
  return cells;
}

function centerGeometry(count, width, height) {
  const cellWidth = width / count;
  const cellHeight = height / count;
  const span = count - 2;
  return {
    left: (width - cellWidth * span) / 2,
    top: (height - cellHeight * span) / 2,
    width: cellWidth * span,
    height: cellHeight * span,
  };
}

function isOnline(name) {
  const info = state.streams[name];
  return Boolean(info && info.producers && info.producers.some(p => p.id != null));
}
function effectiveName(name) {
  const alias = state.aliases[name];
  return alias && state.streams[alias] ? alias : name;
}
function aliasHint(name) {
  const eff = effectiveName(name);
  return eff === name ? '' : '→ ' + eff;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  return res.json();
}

/* ---------------- 狀態讀取 ---------------- */
async function loadSettings() {
  try {
    const data = await api('/api/settings');
    state.go2rtc = data.go2rtc || data.default || '';
    $('#g2r-url').textContent = 'go2rtc：' + state.go2rtc;
  } catch (e) {
    toast('無法讀取伺服器設定');
  }
}

async function refreshStreams(silent = true) {
  try {
    const data = await api('/api/streams');
    if (data.error) {
      state.streamsError = data.error;
      state.streams = {};
    } else {
      state.streamsError = null;
      state.streams = data.streams || {};
      state.aliases = data.aliases || {};
      if (data.go2rtc && data.go2rtc !== state.go2rtc) {
        state.go2rtc = data.go2rtc;
        $('#g2r-url').textContent = 'go2rtc：' + state.go2rtc;
      }
    }
  } catch (e) {
    state.streamsError = '無法連線伺服器';
    state.streams = {};
  }
  if (!silent) { renderStreamList(); renderSelectedList(); }
  updateSummary();
  refreshBadges();
}

function updateSummary() {
  const names = Object.keys(state.streams);
  const on = names.filter(isOnline).length;
  const el = $('#summary');
  if (state.streamsError) {
    el.textContent = '⚠ ' + state.streamsError;
    el.style.color = '#eab308';
  } else {
    el.textContent = names.length ? '在線 ' + on + ' / ' + names.length + '　已選 ' + state.selected.length : '';
    el.style.color = '';
  }
}

/* ---------------- 播放池 ---------------- */
/* 完整協定鏈：優先用不轉檔的 WebRTC/MSE，失敗才退回 MJPEG */
const FULL_MODES = 'webrtc,mse,hls,mjpeg';

function getPool(name) {
  if (state.pools.has(name)) return state.pools.get(name);
  const eff = effectiveName(name);
  const st = document.createElement('wall-stream');
  st.mode = FULL_MODES;
  st.media = 'video,audio';
  st.visibilityThreshold = 0;
  st.visibilityCheck = false;
  // background = true：不再因為元素被抽離 DOM 而斷線。
  // 每次重繪 surface 都會抽離所有播放元素，若照 VideoRTC 預設會排程 ondisconnect，
  // 造成 MediaSource 被拆掉後 updateend 還在跑（SourceBuffer InvalidStateError）與反覆重連。
  // 連線生命週期改由本檔的播放池決定（換頁釋放、移除相機時 dropPool）。
  st.background = true;
  st.ensureVideo();
  st.src = '/api/ws?src=' + encodeURIComponent(eff);
  const entry = {name, eff, st, forcedMJPEG: false, lastMode: '—', dead: false, mediaErrored: false, reviveAt: 0, reviveCount: 0};
  // 只認「切到 MJPEG 之後」才發生的解碼錯誤，避免 MSE 階段的舊錯誤誤判成無訊號
  st.video.addEventListener('error', () => { entry.mediaErrored = true; });
  st.addEventListener('wallmode', e => { entry.lastMode = e.detail; refreshBadges(); });
  state.pools.set(name, entry);
  return entry;
}

function dropPool(name) {
  const entry = state.pools.get(name);
  if (entry) {
    entry.st.remove();
    entry.st.ondisconnect();
    state.pools.delete(name);
  }
  removeView(name);
}

function fadeVolume(video, target, duration) {
  if (!video) return Promise.resolve();
  const start = video.volume;
  const startedAt = performance.now();
  return new Promise(resolve => {
    const step = now => {
      const progress = Math.min((now - startedAt) / duration, 1);
      const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
      video.volume = start + (target - start) * eased;
      if (progress < 1) requestAnimationFrame(step);
      else { video.volume = target; resolve(); }
    };
    requestAnimationFrame(step);
  });
}

/* ---------------- 版面繪製 ---------------- */
/* 元素常駐架構：每台相機只有一個 .channel 元素（內含自己的 <wall-stream>），
   切換大/小視窗只改 left/top/width/height 與 .is-hero 類別，
   <video> 永遠不會離開它的父元素 → 不會重新連線、不會閃黑、不會中斷畫面。 */
function placeChannel(el, box) {
  el.style.left = box.left + 'px';
  el.style.top = box.top + 'px';
  el.style.width = box.width + 'px';
  el.style.height = box.height + 'px';
}

function ensureChannel(name) {
  const cached = state.views.get(name);
  if (cached) return cached;
  const el = createChannel(name);
  $('#surface').append(el);
  state.views.set(name, el);
  return el;
}

function removeView(name) {
  const el = state.views.get(name);
  if (!el) return;
  el.remove();
  state.views.delete(name);
}

/* 外圈那個「目前大視窗」的空位（與 opencast-grid 相同：大視窗仍佔一個外圈格位） */
function ensureHeroSlot() {
  if (state.heroSlot) return state.heroSlot;
  const index = element('span');
  const name = element('span', {className: 'mini-name'});
  const slot = element('div', {className: 'hero-slot hidden'},
    element('div', {className: 'mini-placeholder'},
      element('div', {className: 'flag', text: '🎥'}),
      element('div', {text: '目前大視窗'}),
    ),
    element('div', {className: 'mini-overlay'},
      element('div', {className: 'mini-topline'}, index,
        element('span', {className: 'mini-live'}, element('span', {className: 'live-dot on'}))),
      element('div', {className: 'mini-bottomline'}, name,
        element('span', {className: 'mini-status mode', text: '大視窗'})),
    ),
  );
  slot._index = index;
  slot._name = name;
  state.heroSlot = slot;
  $('#surface').append(slot);
  return slot;
}

/* 釋放不在本頁的播放 session 與元素（換頁／移除相機才用得到） */
function releaseOtherPages(page) {
  const keep = new Set(page);
  for (const key of [...state.pools.keys()]) if (!keep.has(key)) dropPool(key);
  for (const name of [...state.views.keys()]) if (!keep.has(name)) removeView(name);
}

function render() {
  const surface = $('#surface');
  const empty = $('#empty-state');

  if (state.selected.length === 0) {
    releaseOtherPages([]);
    if (state.heroSlot) state.heroSlot.classList.add('hidden');
    state.heroPlayer = null;
    empty.classList.remove('hidden');
    $('#toolbar').classList.remove('is-hidden');
    updateSummary();
    return;
  }
  empty.classList.add('hidden');
  $('#toolbar').classList.toggle('is-hidden', state.fullscreen);

  const count = modeCount();
  const width = surface.clientWidth || window.innerWidth;
  const height = surface.clientHeight || (window.innerHeight - 60);
  const cellWidth = width / count;
  const cellHeight = height / count;
  const page = pageCameras();
  if (page.length === 0) return;

  const featured = page.includes(state.featured) ? state.featured : page[0];
  state.featured = featured;
  localStorage.setItem(LS.featured, featured);
  pushWall({featured});

  releaseOtherPages(page);

  const cells = perimeterCells(count);
  const center = centerGeometry(count, width, height);
  const slot = ensureHeroSlot();

  page.forEach((name, index) => {
    const el = ensureChannel(name);
    const isHero = name === featured;
    el._parts.index.textContent = '#' + String(state.selected.indexOf(name) + 1).padStart(2, '0');
    el._parts.status.textContent = isHero ? '大視窗' : (state.pools.get(name).lastMode || '—');
    el.classList.toggle('is-hero', isHero);

    if (state.fullscreen) {
      // 全螢幕只留下大視窗，其餘元素隱藏但連線仍在（回來時不必重連）
      el.classList.toggle('hidden', !isHero);
      el.classList.toggle('is-fullscreen', isHero);
      if (isHero) { el.style.left = ''; el.style.top = ''; el.style.width = ''; el.style.height = ''; }
      return;
    }

    el.classList.remove('hidden');
    el.classList.remove('is-fullscreen');
    const cell = cells[index];
    placeChannel(el, isHero
      ? {left: center.left, top: center.top, width: center.width, height: center.height}
      : {left: cell.column * cellWidth, top: cell.row * cellHeight, width: cellWidth, height: cellHeight});
  });

  if (state.fullscreen) {
    slot.classList.add('hidden');
  } else {
    const cell = cells[page.indexOf(featured)];
    slot.classList.remove('hidden');
    placeChannel(slot, {left: cell.column * cellWidth, top: cell.row * cellHeight, width: cellWidth, height: cellHeight});
    slot._index.textContent = '#' + String(state.selected.indexOf(featured) + 1).padStart(2, '0');
    slot._name.textContent = featured;
  }

  // 小視窗一律靜音，只有大視窗套用設定音量
  for (const entry of state.pools.values()) {
    if (entry.st.video) entry.st.video.muted = true;
  }
  state.heroPlayer = getPool(featured).st;
  if (state.heroPlayer.video) {
    state.heroPlayer.video.muted = state.heroMuted;
    state.heroPlayer.video.volume = state.heroVolume;
  }

  renderPageControls();
  updateSummary();
  refreshBadges();
  showControls();
}

/* 一台相機 = 一個常駐元素：同時具備小視窗與大視窗的外觀，用 .is-hero 切換。
   <wall-stream> 只建立一次，之後切換大小視窗只會改變這個元素的位置與大小。 */
function createChannel(name) {
  const entry = getPool(name);
  const el = element('div', {className: 'channel', 'data-cam': name});

  const index = element('span', {text: '#'});
  const status = element('span', {className: 'mini-status mode', text: entry.lastMode});
  const overlay = element('div', {className: 'mini-overlay'},
    element('div', {className: 'mini-topline'}, index,
      element('span', {className: 'mini-live'}, element('span', {className: 'live-dot'}))),
    element('div', {className: 'mini-bottomline'},
      element('span', {className: 'mini-name', text: name}), status),
  );
  const loading = element('div', {className: 'mini-loading'},
    element('div', {className: 'spinner'}), '連線中…');

  const miniRemove = element('button', {className: 'mini-remove', text: '✕', title: '從牆面移除'});
  miniRemove.addEventListener('click', ev => { ev.stopPropagation(); removeCamera(name); });

  const heroMode = element('div', {className: 'hero-mode', text: '大視窗 · ' + entry.lastMode});
  const info = element('div', {className: 'hero-info'},
    element('div', {className: 'hero-live'}, element('span', {className: 'live-dot'}), 'LIVE'),
    element('div', {className: 'hero-name', text: name}),
    element('div', {className: 'hero-meta', text: '點擊放大 · 外圈點擊切換大視窗'}),
  );

  const sound = element('button', {className: 'hero-sound', text: state.heroMuted ? '🔇' : '🔊', title: '聲音'});
  sound.addEventListener('click', ev => {
    ev.stopPropagation();
    state.heroMuted = !state.heroMuted;
    if (entry.st.video) entry.st.video.muted = state.heroMuted;
    sound.textContent = state.heroMuted ? '🔇' : '🔊';
  });
  const pause = element('button', {className: 'hero-pause', text: state.paused ? '▶' : '⏸', title: '全部暫停'});
  pause.addEventListener('click', ev => {
    ev.stopPropagation();
    toggleAllPlayback();
    pause.textContent = state.paused ? '▶' : '⏸';
  });
  const heroRemove = element('button', {className: 'hero-remove', text: '✕', title: '從牆面移除'});
  heroRemove.addEventListener('click', ev => { ev.stopPropagation(); removeCamera(name); });
  const controls = element('div', {className: 'hero-controls'}, sound, pause, heroRemove);

  const volume = element('div', {className: 'hero-volume'},
    element('input', {type: 'range', min: '0', max: '1', step: '0.05', value: String(state.heroVolume)}));
  volume.addEventListener('click', ev => ev.stopPropagation());
  volume.querySelector('input').addEventListener('input', ev => {
    state.heroVolume = Number(ev.target.value);
    localStorage.setItem(LS.vol, String(state.heroVolume));
    pushWall({vol: state.heroVolume});
    if (entry.st.video) entry.st.video.volume = state.heroVolume;
  });

  el.append(entry.st, loading, overlay, miniRemove,
    element('div', {className: 'hero-gradient'}), heroMode, info, controls, volume);

  el.addEventListener('click', () => {
    if (el.classList.contains('is-hero')) toggleFullscreen();
    else setFeatured(name);
  });
  el.addEventListener('pointermove', showControls);
  el.addEventListener('pointerdown', showControls);

  el._parts = {index, status, loading};
  return el;
}

function renderPageControls() {
  const old = document.querySelector('.page-controls');
  if (old) old.remove();
  state.pageControls = null;
  if (pageCount() <= 1 || state.fullscreen) return;
  state.pageControls = element('div', {className: 'page-controls'},
    element('button', {disabled: state.page <= 0, text: '‹'}),
    element('span', {text: (state.page % pageCount()) + 1 + ' / ' + pageCount()}),
    element('button', {disabled: state.page >= pageCount() - 1, text: '›'}),
  );
  const buttons = state.pageControls.querySelectorAll('button');
  buttons[0].addEventListener('click', () => changePage(-1));
  buttons[1].addEventListener('click', () => changePage(1));
  $('#surface').append(state.pageControls);
}

/* ---------------- 狀態燈號巡覽 ---------------- */
/* 由 <video> 目前的來源判斷實際協定（go2rtc 的 WS 不一定會回報協定訊息） */
function detectMode(st) {
  const v = st.video;
  if (!v) return '—';
  if (v.srcObject && v.srcObject.constructor && v.srcObject.constructor.name === 'MediaStream') return 'RTC';
  if (v.poster) return 'MJPEG';
  if (v.src.startsWith('blob:')) return 'MSE';
  if (v.src.startsWith('data:application/vnd.apple')) return 'HLS';
  return v.videoWidth > 0 ? 'LIVE' : '—';
}

function refreshBadges() {
  for (const entry of state.pools.values()) {
    const st = entry.st;
    const live = st.video && st.video.videoWidth > 0;
    if (st.video) st.video.classList.toggle('is-playing', Boolean(live));
    const mode = detectMode(st);
    if (mode !== '—') entry.lastMode = mode;
    document.querySelectorAll('[data-cam]').forEach(n => {
      if (n.dataset.cam !== entry.name) return;
      const dot = n.querySelector('.live-dot');
      if (dot) dot.className = 'live-dot ' + (live ? 'on' : 'off');
      const loading = n.querySelector('.mini-loading');
      if (loading) {
        loading.classList.toggle('hidden', live);
        const label = loading.lastChild;
        if (label && label.nodeType === Node.TEXT_NODE) {
          label.textContent = entry.dead && !live ? '無訊號' : '連線中…';
        }
      }
      const status = n.querySelector('.mini-status.mode');
      if (status && status.textContent !== '大視窗') status.textContent = entry.lastMode;
      const heroMode = n.querySelector('.hero-mode');
      if (heroMode) heroMode.textContent = '大視窗 · ' + entry.lastMode;
    });
  }
}

function startTimers() {
  state.statusTimer = setInterval(() => {
    const now = Date.now();
    for (const entry of state.pools.values()) {
      const st = entry.st;
      const live = st.video && st.video.videoWidth > 0;
      if (live) {
        // 有畫面就回到乾淨狀態，之後若再斷線可以重新走完整協定鏈
        entry.dead = false;
        entry.mediaErrored = false;
        entry.reviveAt = 0;
        entry.reviveCount = 0;
        continue;
      }
      const waited = now - st.connectTS;
      if (entry.dead) {
        // 卡死（連 MJPEG 都拿不到畫面）時隔一段時間用完整協定鏈重連一次，
        // 避免一次短暫壅塞（大量分頁同時連線）就被永久鎖在無訊號。
        // 最多重試 3 次，之後就不再打擾，讓它維持「無訊號」。
        if (entry.reviveCount >= 3) continue;
        if (!entry.reviveAt) entry.reviveAt = now + 60000;
        if (now >= entry.reviveAt) {
          entry.dead = false;
          entry.forcedMJPEG = false;
          entry.mediaErrored = false;
          entry.reviveAt = 0;
          entry.reviveCount += 1;
          st.mode = FULL_MODES;
          st.ondisconnect();
          st.onconnect();
        }
        continue;
      }
      // 已經降級 MJPEG 仍讓瀏覽器報錯（例：HEVC 完全無法解碼）→ 直接判定無訊號
      if (entry.forcedMJPEG && entry.mediaErrored && waited > 3000) {
        entry.dead = true;
        continue;
      }
      if (waited < 12000) continue;
      if (!entry.forcedMJPEG && (st.wsState === WebSocket.OPEN || st.pcState !== WebSocket.CLOSED)) {
        // RTC/MSE 已連上但沒有畫面 → 降級 MJPEG（HEVC 沒有 H.264 對應版時常見）
        entry.forcedMJPEG = true;
        entry.mediaErrored = false;   // 重新計算 MJPEG 階段的錯誤
        st.mode = 'mjpeg';
        st.ondisconnect();
        st.onconnect();
        st.connectTS = Date.now();
      } else if (entry.forcedMJPEG && waited > 15000) {
        entry.dead = true;   // 連 MJPEG 都拿不到畫面
      }
    }
    autoFocusHero();
    refreshBadges();
  }, 2000);
  state.streamTimer = setInterval(() => refreshStreams(true), 15000);
  // 共用設定輪詢：其他分頁／電腦改了牆面，這裡跟著動
  state.wallTimer = setInterval(pollWall, 4000);
}

/* 大視窗若卡在「確定沒畫面」的相機（常見：go2rtc 端的 HEVC 串流），
   自動換到本頁第一個有畫面的相機；只自動切一次，之後完全由使用者點選決定。 */
function autoFocusHero() {
  if (state.autoFocus) return;
  const cur = state.pools.get(state.featured);
  if (!cur) return;
  if (cur.st.video && cur.st.video.videoWidth > 0) return;   // 大視窗已經有畫面
  const waited = Date.now() - cur.st.connectTS;
  // 明確失敗（解碼錯誤）或已判定無訊號，才讓位；否則再等等
  if (!((cur.mediaErrored && waited > 4000) || cur.dead || waited > 15000)) return;
  const candidate = [...state.pools.values()].find(e => e !== cur && e.st.video && e.st.video.videoWidth > 0);
  if (!candidate) return;
  state.autoFocus = true;
  setFeatured(candidate.name);
}

/* ---------------- 互動 ---------------- */
async function setFeatured(name) {
  if (!name || state.featured === name) return;
  const oldHero = state.heroPlayer;
  if (oldHero) {
    await fadeVolume(oldHero.video, 0, 350);
    oldHero.video.muted = true;
  }
  state.featured = name;
  localStorage.setItem(LS.featured, name);
  pushWall({featured: name});
  render();
  const st = getPool(name).st;
  st.video.muted = state.heroMuted;
  st.video.volume = 0;
  await fadeVolume(st.video, state.heroVolume, 500);
}

function removeCamera(name) {
  state.selected = state.selected.filter(n => n !== name);
  localStorage.setItem(LS.selected, JSON.stringify(state.selected));
  pushWall({selected: state.selected});
  if (state.featured === name) state.featured = null;
  pushWall({featured: state.featured});
  state.page = Math.min(state.page, pageCount() - 1);
  dropPool(name);
  render();
  toast('已移除 ' + name);
}

function toggleAllPlayback() {
  state.paused = !state.paused;
  for (const entry of state.pools.values()) {
    if (state.paused) entry.st.video.pause();
    else entry.st.video.play().catch(() => {});
  }
}

function toggleFullscreen() {
  if (state.fullscreen) {
    state.mode = state.modeBefore;
    state.page = state.pageBefore;
    state.fullscreen = false;
  } else {
    state.modeBefore = state.mode;
    state.pageBefore = state.page;
    state.fullscreen = true;
  }
  render();
}

function changePage(delta) {
  state.page = Math.max(0, Math.min(pageCount() - 1, (state.page % pageCount()) + delta));
  localStorage.setItem(LS.page, String(state.page));
  pushWall({page: state.page});
  render();
}

function selectMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  state.page = Math.min(state.page, pageCount() - 1);
  localStorage.setItem(LS.mode, mode);
  pushWall({mode, page: state.page});
  render();
}

function showControls() {
  $('#toolbar').classList.toggle('is-hidden', state.fullscreen);
  const pages = document.querySelector('.page-controls');
  if (pages) pages.classList.remove('is-hidden');
  clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(() => {
    if (!state.fullscreen && !document.querySelector('.modal:not(.hidden)')) {
      $('#toolbar').classList.add('is-hidden');
      const p = document.querySelector('.page-controls');
      if (p) p.classList.add('is-hidden');
    }
  }, 5000);
}

/* ---------------- 攝像頭選擇視窗 ---------------- */
function openPicker() {
  if (state.fullscreen) toggleFullscreen();
  refreshStreams(false);
  $('#modal-picker').classList.remove('hidden');
  renderStreamList();
  renderSelectedList();
}

function closeModal(sel) { $(sel).classList.add('hidden'); }

function renderStreamList() {
  const list = $('#stream-list');
  const q = $('#picker-search').value.trim().toLowerCase();
  list.innerHTML = '';
  const names = Object.keys(state.streams)
    .filter(n => !q || n.toLowerCase().includes(q))
    .sort((a, b) => (isOnline(b) - isOnline(a)) || a.localeCompare(b));
  $('#picker-all-info').textContent = '（' + names.length + '）';
  if (names.length === 0) {
    const msg = state.streamsError ? '⚠ ' + state.streamsError : (q ? '沒有符合的串流' : 'go2rtc 沒有串流');
    list.append(element('div', {className: 'stream-row', text: msg}));
    return;
  }
  for (const name of names) {
    const hint = aliasHint(name);
    const row = element('div', {className: 'stream-row'},
      element('input', {type: 'checkbox', checked: state.selected.includes(name), 'data-name': name}),
      element('span', {className: 'dot' + (isOnline(name) ? ' on' : '')}),
      element('span', {className: 'row-name', text: name}),
      element('span', {className: 'row-src', text: (isOnline(name) ? '在線' : '離線（選取後自動喚醒）') + (hint ? '　' + hint : '')}),
    );
    row.querySelector('input').addEventListener('change', ev => {
      const n = ev.target.dataset.name;
      if (ev.target.checked) {
        if (!state.selected.includes(n)) { state.selected.push(n); saveSelected(); }
      } else {
        state.selected = state.selected.filter(x => x !== n);
        saveSelected();
      }
      renderSelectedList();
      renderStreamList();
    });
    list.append(row);
  }
}

function renderSelectedList() {
  const list = $('#selected-list');
  list.innerHTML = '';
  $('#picker-count').textContent = state.selected.length + ' 個已選';
  if (state.selected.length === 0) {
    list.append(element('div', {className: 'stream-row', text: '尚未選擇'}));
    return;
  }
  state.selected.forEach((name, i) => {
    const row = element('div', {className: 'stream-row selected-row'},
      element('span', {className: 'dot' + (isOnline(name) ? ' on' : '')}),
      element('span', {className: 'row-name', text: name}),
      element('div', {className: 'updown'},
        element('button', {text: '↑', title: '往前', disabled: i === 0}),
        element('button', {text: '↓', title: '往後', disabled: i === state.selected.length - 1}),
      ),
    );
    const btns = row.querySelectorAll('.updown button');
    btns[0].addEventListener('click', () => {
      [state.selected[i - 1], state.selected[i]] = [state.selected[i], state.selected[i - 1]];
      saveSelected(); renderSelectedList(); renderStreamList();
    });
    btns[1].addEventListener('click', () => {
      [state.selected[i], state.selected[i + 1]] = [state.selected[i + 1], state.selected[i]];
      saveSelected(); renderSelectedList(); renderStreamList();
    });
    list.append(row);
  });
}

function saveSelected() {
  localStorage.setItem(LS.selected, JSON.stringify(state.selected));
  pushWall({selected: state.selected});
  updateSummary();
}

/* ---------------- 設定視窗 ---------------- */
function openSettings() {
  $('#settings-url').value = state.go2rtc;
  $('#settings-status').textContent = '';
  $('#settings-status').className = 'settings-status';
  $('#modal-settings').classList.remove('hidden');
}

async function putSettings(url, dry) {
  $('#settings-status').textContent = '連線測試中…';
  $('#settings-status').className = 'settings-status';
  try {
    const res = await fetch('/api/settings' + (dry ? '?dry=1' : ''), {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({go2rtc: url}),
    });
    const data = await res.json();
    const status = $('#settings-status');
    if (res.ok && data.ok) {
      status.className = 'settings-status ok';
      status.textContent = dry
        ? '✅ 連線成功（' + data.streamCount + ' 個串流）'
        : '✅ 已儲存，連到 ' + data.go2rtc + '（' + data.streamCount + ' 個串流）';
      if (!dry) {
        state.go2rtc = data.go2rtc;
        $('#g2r-url').textContent = 'go2rtc：' + state.go2rtc;
        for (const key of [...state.pools.keys()]) dropPool(key);
        render();
        refreshStreams(true);
        toast('go2rtc 網址已更新');
      }
      return true;
    }
    status.className = 'settings-status err';
    status.textContent = '❌ ' + (data.error || '失敗');
    return false;
  } catch (e) {
    $('#settings-status').className = 'settings-status err';
    $('#settings-status').textContent = '❌ 無法連線伺服器';
    return false;
  }
}

/* ---------------- 鍵盤 ---------------- */
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') {
    if (!document.getElementById('modal-picker').classList.contains('hidden')) closeModal('#modal-picker');
    else if (!document.getElementById('modal-settings').classList.contains('hidden')) closeModal('#modal-settings');
    else if (state.fullscreen) toggleFullscreen();
    return;
  }
  if (ev.key === 'f' || ev.key === 'F') { toggleFullscreen(); return; }
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
  if (ev.key === 'ArrowLeft') changePage(-1);
  if (ev.key === 'ArrowRight') changePage(1);
});

/* ---------------- 事件綁定 ---------------- */
function bindEvents() {
  document.querySelectorAll('#mode-group button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
    btn.addEventListener('click', () => {
      selectMode(btn.dataset.mode);
      document.querySelectorAll('#mode-group button').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  $('#btn-picker').addEventListener('click', openPicker);
  $('#btn-empty-picker').addEventListener('click', openPicker);
  $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
  $('#g2r-url').addEventListener('click', openSettings);

  const surface = $('#surface');
  surface.addEventListener('pointermove', showControls);
  surface.addEventListener('pointerdown', showControls);

  $('#picker-search').addEventListener('input', renderStreamList);
  $('#picker-clear').addEventListener('click', () => {
    state.selected = [];
    saveSelected();
    renderSelectedList();
    renderStreamList();
  });
  $('#picker-online').addEventListener('click', () => {
    for (const name of Object.keys(state.streams)) {
      if (isOnline(name) && !state.selected.includes(name)) state.selected.push(name);
    }
    saveSelected();
    renderSelectedList();
    renderStreamList();
  });
  $('#picker-save').addEventListener('click', () => {
    saveSelected();
    state.page = Math.min(state.page, pageCount() - 1);
    closeModal('#modal-picker');
    render();
    toast('已更新牆面（' + state.selected.length + ' 個攝像頭）');
  });

  $('#settings-test').addEventListener('click', () => putSettings($('#settings-url').value.trim(), true));
  $('#settings-save').addEventListener('click', async () => {
    const ok = await putSettings($('#settings-url').value.trim(), false);
    if (ok) closeModal('#modal-settings');
  });

  document.querySelectorAll('.modal-close').forEach(btn =>
    btn.addEventListener('click', () => btn.closest('.modal').classList.add('hidden')));
  document.querySelectorAll('.modal').forEach(m =>
    m.addEventListener('click', ev => { if (ev.target === m) m.classList.add('hidden'); }));
}

/* ---------------- 啟動 ---------------- */
async function init() {
  try { state.selected = JSON.parse(localStorage.getItem(LS.selected) || '[]'); }
  catch (e) { state.selected = []; }
  await loadSettings();
  await refreshStreams(true);
  // 牆面設定以伺服器共用的一份為準；伺服器還沒存過才用本機 localStorage 推上去
  const serverWall = await loadWall();
  if (serverWall) {
    applyWallState(serverWall, false);
  } else {
    pushWall({
      selected: state.selected, mode: state.mode,
      page: state.page, featured: state.featured, vol: state.heroVolume,
    });
  }
  render();
  bindEvents();
  startTimers();
  if (state.selected.length === 0) openPicker();
}

init();
