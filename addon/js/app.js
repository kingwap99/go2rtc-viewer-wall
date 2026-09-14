import {VideoRTC} from './video-rtc.js';

/* =====================================================================
 * go2rtc Viewer Wall
 * Layout and interactions mirror the core design of opencast-grid (kingwap99):
 *   - a centre hero window plus a ring of mini windows
 *   5x5 = 1 centre hero + 16 minis (4x4: 12, 6x6: 20, 7x7: 24)
 *   - click a mini -> it becomes the centre hero (same playback session kept)
 *   - click the hero -> fullscreen; click again or Esc to go back
 *   - paging (< 1/2 >), audio fade in/out
 * Playback is built on go2rtc's VideoRTC (WebRTC -> MSE -> HLS -> MJPEG).
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

/* Shared wall settings: the real copy lives on the server (/api/wall) and every browser
   shares it. localStorage is demoted to an offline fallback, no longer the source of truth,
   so another computer or another browser opens exactly the same wall. */
let wallServer = {selected: [], mode: '5x5', page: 0, featured: null, vol: 0.7, updated: 0};
let wallPushTimer = null;
const wallPending = {};

function wallKey(value) { return JSON.stringify(value); }

/* Only send fields that differ from the server state, so browsers cannot ping-pong writes */
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
  } catch (e) { /* when the server is down the localStorage fallback still works */ }
}

/* Apply shared settings to the local state and sync the UI; doRender=false skips the redraw */
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

/* Read the shared settings from the server; updated=0 means never saved (use the fallback) */
async function loadWall() {
  try {
    const data = await api('/api/wall');
    if (data && typeof data.updated === 'number') {
      wallServer = {...wallServer, ...data};
      return data.updated > 0 ? data : null;
    }
  } catch (e) { /* ignore and use the fallback */ }
  return null;
}

/* Poll the shared settings so changes from other tabs or computers show up here */
async function pollWall() {
  if (wallPushTimer || Object.keys(wallPending).length > 0) return;
  try {
    const data = await api('/api/wall');
    if (!data || typeof data.updated !== 'number') return;
    if (data.updated > wallServer.updated + 0.0005) {
      wallServer = {...wallServer, ...data};
      applyWallState(data);
    }
  } catch (e) { /* ignore */ }
}

const state = {
  go2rtc: '',
  streams: {},           // name -> go2rtc api/streams payload
  aliases: {},           // name -> playable h264 counterpart (or itself)
  streamsError: null,
  selected: [],          // camera names, in wall order
  mode: localStorage.getItem(LS.mode) || '5x5',
  page: Number(localStorage.getItem(LS.page) || 0),
  featured: localStorage.getItem(LS.featured) || null,
  fullscreen: false,
  modeBefore: '5x5',
  pageBefore: 0,
  paused: false,
  heroMuted: false,
  heroVolume: Number(localStorage.getItem(LS.vol) || 0.7),
  autoFocus: false,      // whether the hero was already moved to a camera with a picture
  pools: new Map(),      // name -> {name, eff, st, forcedMJPEG, lastMode}
  views: new Map(),      // name -> long-lived .channel element (swapping only moves it)
  heroSlot: null,        // the ring slot that shows which camera is currently the hero
  heroPlayer: null,
  statusTimer: null,
  streamTimer: null,
  wallTimer: null,
  hideTimer: null,
};

/* ---------------- playback element (VideoRTC wrapper) ---------------- */
class WallStream extends VideoRTC {
  oninit() {
    super.oninit();
    this.video.controls = false;
    this.video.muted = true;
  }

  /* Upstream VideoRTC only creates this.video in oninit(), which needs the element to be
     connected to the DOM. This wall shares one play session between hero and mini and sets
     mute/volume before the element enters the page (this.video would still be null and
     throw), so expose an entry point that makes sure <video> exists first. */
  ensureVideo() {
    if (!this.video) this.oninit();
    return this;
  }

  onopen() {
    // After an MJPEG fallback or a page release the old socket's open event can arrive late;
    // this.ws is already cleared by ondisconnect(), so bail out instead of throwing.
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

  /* An MJPEG fallback calls ondisconnect()+onconnect() ourselves, and the old socket's close
     event often arrives after the new connection was made. Ignoring that would wipe the new
     this.ws to null (and the next onopen would throw), so only hand over to the original
     onclose when the socket being closed really is the current one. */
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

/* ---------------- helpers ---------------- */
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

/* ---------------- state loading ---------------- */
async function loadSettings() {
  try {
    const data = await api('/api/settings');
    state.go2rtc = data.go2rtc || data.default || '';
    $('#g2r-url').textContent = 'go2rtc: ' + state.go2rtc;
  } catch (e) {
    toast('cannot read server settings');
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
        $('#g2r-url').textContent = 'go2rtc: ' + state.go2rtc;
      }
    }
  } catch (e) {
    state.streamsError = 'cannot reach server';
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
    el.textContent = names.length ? 'online ' + on + ' / ' + names.length + '  ·  selected ' + state.selected.length : '';
    el.style.color = '';
  }
}

/* ---------------- playback pool ---------------- */
/* Full protocol chain: prefer untranscoded WebRTC/MSE and only fall back to MJPEG */
const FULL_MODES = 'webrtc,mse,hls,mjpeg';

function getPool(name) {
  if (state.pools.has(name)) return state.pools.get(name);
  const eff = effectiveName(name);
  const st = document.createElement('wall-stream');
  st.mode = FULL_MODES;
  st.media = 'video,audio';
  st.visibilityThreshold = 0;
  st.visibilityCheck = false;
  // background = true: the connection no longer dies when the element leaves the DOM.
  // Every surface redraw detaches all playback elements and the VideoRTC default would
  // schedule ondisconnect, tearing down the MediaSource while updateend is still running
  // (SourceBuffer InvalidStateError) and reconnecting over and over. The connection
  // lifecycle is owned by the pool in this file instead (dropPool on paging / removal).
  st.background = true;
  st.ensureVideo();
  st.src = '/api/ws?src=' + encodeURIComponent(eff);
  const entry = {name, eff, st, forcedMJPEG: false, lastMode: '—', dead: false, mediaErrored: false, reviveAt: 0, reviveCount: 0};
  // Only count decode errors that happen after the MJPEG switch, so a stale MSE error is
  // not mistaken for "no signal"
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

/* ---------------- layout drawing ---------------- */
/* Persistent elements: each camera has exactly one .channel element (holding its own
   <wall-stream>). Switching hero/mini only changes left/top/width/height and the .is-hero
   class, so the <video> never leaves its parent -> no reconnect, no black flash, no break. */
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

/* The ring slot that shows the current hero (as in opencast-grid, the hero still occupies
   one ring slot) */
function ensureHeroSlot() {
  if (state.heroSlot) return state.heroSlot;
  const index = element('span');
  const name = element('span', {className: 'mini-name'});
  const slot = element('div', {className: 'hero-slot hidden'},
    element('div', {className: 'mini-placeholder'},
      element('div', {className: 'flag', text: '🎥'}),
      element('div', {text: 'current hero'}),
    ),
    element('div', {className: 'mini-overlay'},
      element('div', {className: 'mini-topline'}, index,
        element('span', {className: 'mini-live'}, element('span', {className: 'live-dot on'}))),
      element('div', {className: 'mini-bottomline'}, name,
        element('span', {className: 'mini-status mode', text: 'Hero'})),
    ),
  );
  slot._index = index;
  slot._name = name;
  state.heroSlot = slot;
  $('#surface').append(slot);
  return slot;
}

/* Release playback sessions and elements that are not on this page (paging / removal) */
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
    el._parts.status.textContent = isHero ? 'Hero' : (state.pools.get(name).lastMode || '—');
    el.classList.toggle('is-hero', isHero);

    if (state.fullscreen) {
      // in fullscreen keep only the hero; the rest stay hidden but connected (no reconnect)
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

  // minis are always muted, only the hero uses the configured volume
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

/* One camera = one persistent element that can look like a mini or like the hero,
   switched by .is-hero. <wall-stream> is created once; swapping only moves and resizes
   this same element. */
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
    element('div', {className: 'spinner'}), 'connecting…');

  const miniRemove = element('button', {className: 'mini-remove', text: '✕', title: 'Remove from wall'});
  miniRemove.addEventListener('click', ev => { ev.stopPropagation(); removeCamera(name); });

  const heroMode = element('div', {className: 'hero-mode', text: 'Hero · ' + entry.lastMode});
  const info = element('div', {className: 'hero-info'},
    element('div', {className: 'hero-live'}, element('span', {className: 'live-dot'}), 'LIVE'),
    element('div', {className: 'hero-name', text: name}),
    element('div', {className: 'hero-meta', text: 'click to enlarge · click a mini to swap'}),
  );

  const sound = element('button', {className: 'hero-sound', text: state.heroMuted ? '🔇' : '🔊', title: 'Sound'});
  sound.addEventListener('click', ev => {
    ev.stopPropagation();
    state.heroMuted = !state.heroMuted;
    if (entry.st.video) entry.st.video.muted = state.heroMuted;
    sound.textContent = state.heroMuted ? '🔇' : '🔊';
  });
  const pause = element('button', {className: 'hero-pause', text: state.paused ? '▶' : '⏸', title: 'Pause all'});
  pause.addEventListener('click', ev => {
    ev.stopPropagation();
    toggleAllPlayback();
    pause.textContent = state.paused ? '▶' : '⏸';
  });
  const heroRemove = element('button', {className: 'hero-remove', text: '✕', title: 'Remove from wall'});
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

/* ---------------- status badge sweep ---------------- */
/* Guess the live protocol from the <video> source (go2rtc's WS does not always report it) */
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
          label.textContent = entry.dead && !live ? 'no signal' : 'connecting…';
        }
      }
      const status = n.querySelector('.mini-status.mode');
      if (status && status.textContent !== 'Hero') status.textContent = entry.lastMode;
      const heroMode = n.querySelector('.hero-mode');
      if (heroMode) heroMode.textContent = 'Hero · ' + entry.lastMode;
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
        // a picture means the tile is healthy again, so a later drop can retry the full chain
        entry.dead = false;
        entry.mediaErrored = false;
        entry.reviveAt = 0;
        entry.reviveCount = 0;
        continue;
      }
      const waited = now - st.connectTS;
      if (entry.dead) {
        // When a tile is stuck (not even MJPEG gives a picture) retry the full protocol chain
        // after a while, so one short congestion spike (many tabs connecting at once) cannot
        // lock it on "no signal" forever. At most 3 retries, then leave it alone.
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
      // MJPEG is already in use and the browser still errors (e.g. HEVC cannot be decoded at
      // all) -> declare it offline
      if (entry.forcedMJPEG && entry.mediaErrored && waited > 3000) {
        entry.dead = true;
        continue;
      }
      if (waited < 12000) continue;
      if (!entry.forcedMJPEG && (st.wsState === WebSocket.OPEN || st.pcState !== WebSocket.CLOSED)) {
        // RTC/MSE connected but there is no picture -> fall back to MJPEG (common when an
        // HEVC stream has no H.264 counterpart)
        entry.forcedMJPEG = true;
        entry.mediaErrored = false;   // recount errors for the MJPEG stage
        st.mode = 'mjpeg';
        st.ondisconnect();
        st.onconnect();
        st.connectTS = Date.now();
      } else if (entry.forcedMJPEG && waited > 15000) {
        entry.dead = true;   // not even MJPEG gives a picture
      }
    }
    autoFocusHero();
    refreshBadges();
  }, 2000);
  state.streamTimer = setInterval(() => refreshStreams(true), 15000);
  // shared settings poll: follow changes made by other tabs or computers
  state.wallTimer = setInterval(pollWall, 4000);
}

/* If the hero is stuck on a camera that definitely has no picture (commonly an HEVC stream
   on the go2rtc side), move to the first camera on this page that does. This happens once,
   after that the user decides. */
function autoFocusHero() {
  if (state.autoFocus) return;
  const cur = state.pools.get(state.featured);
  if (!cur) return;
  if (cur.st.video && cur.st.video.videoWidth > 0) return;   // the hero already has a picture
  const waited = Date.now() - cur.st.connectTS;
  // only give way on a clear failure (decode error) or a confirmed dead tile, otherwise wait
  if (!((cur.mediaErrored && waited > 4000) || cur.dead || waited > 15000)) return;
  const candidate = [...state.pools.values()].find(e => e !== cur && e.st.video && e.st.video.videoWidth > 0);
  if (!candidate) return;
  state.autoFocus = true;
  setFeatured(candidate.name);
}

/* ---------------- interaction ---------------- */
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
  toast('Removed ' + name);
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

/* ---------------- camera picker ---------------- */
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
  $('#picker-all-info').textContent = '(' + names.length + ')';
  if (names.length === 0) {
    const msg = state.streamsError ? '⚠ ' + state.streamsError : (q ? 'no matching streams' : 'go2rtc has no streams');
    list.append(element('div', {className: 'stream-row', text: msg}));
    return;
  }
  for (const name of names) {
    const hint = aliasHint(name);
    const row = element('div', {className: 'stream-row'},
      element('input', {type: 'checkbox', checked: state.selected.includes(name), 'data-name': name}),
      element('span', {className: 'dot' + (isOnline(name) ? ' on' : '')}),
      element('span', {className: 'row-name', text: name}),
      element('span', {className: 'row-src', text: (isOnline(name) ? 'online' : 'offline (wakes up when selected)') + (hint ? '  ' + hint : '')}),
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
  $('#picker-count').textContent = state.selected.length + ' selected';
  if (state.selected.length === 0) {
    list.append(element('div', {className: 'stream-row', text: 'nothing selected yet'}));
    return;
  }
  state.selected.forEach((name, i) => {
    const row = element('div', {className: 'stream-row selected-row'},
      element('span', {className: 'dot' + (isOnline(name) ? ' on' : '')}),
      element('span', {className: 'row-name', text: name}),
      element('div', {className: 'updown'},
        element('button', {text: '↑', title: 'Move up', disabled: i === 0}),
        element('button', {text: '↓', title: 'Move down', disabled: i === state.selected.length - 1}),
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

/* ---------------- settings dialog ---------------- */
function openSettings() {
  $('#settings-url').value = state.go2rtc;
  $('#settings-status').textContent = '';
  $('#settings-status').className = 'settings-status';
  $('#modal-settings').classList.remove('hidden');
}

async function putSettings(url, dry) {
  $('#settings-status').textContent = 'testing connection…';
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
        ? '✅ connected (' + data.streamCount + ' streams)'
        : '✅ saved, connected to ' + data.go2rtc + ' (' + data.streamCount + ' streams)';
      if (!dry) {
        state.go2rtc = data.go2rtc;
        $('#g2r-url').textContent = 'go2rtc: ' + state.go2rtc;
        for (const key of [...state.pools.keys()]) dropPool(key);
        render();
        refreshStreams(true);
        toast('go2rtc URL updated');
      }
      return true;
    }
    status.className = 'settings-status err';
    status.textContent = '❌ ' + (data.error || 'failed');
    return false;
  } catch (e) {
    $('#settings-status').className = 'settings-status err';
    $('#settings-status').textContent = '❌ cannot reach server';
    return false;
  }
}

/* ---------------- keyboard ---------------- */
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

/* ---------------- event binding ---------------- */
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
    toast('Wall updated (' + state.selected.length + ' cameras)');
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

/* ---------------- startup ---------------- */
async function init() {
  try { state.selected = JSON.parse(localStorage.getItem(LS.selected) || '[]'); }
  catch (e) { state.selected = []; }
  await loadSettings();
  await refreshStreams(true);
  // the shared server copy wins; only seed it from this browser when the server has none
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
