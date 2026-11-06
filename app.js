/* =========================================================
   Комната — видеовстречи по одной ссылке
   Полностью клиентское приложение:
   - PeerJS cloud используется только как «знакомство» (сигналинг)
   - видео/аудио идёт напрямую между браузерами (WebRTC, mesh)
   - чат и картинки — по WebRTC DataChannel (без сервера)
   ========================================================= */

(() => {
  'use strict';

  /* ---------------- константы ---------------- */

  const MAX_PEERS = 10;
  const PEER_ID_PREFIX = 'komnata';
  const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  const LS_NAME = 'komnata.name.v2';
  const LS_SERVER = 'komnata.server.v4';
  const NAME_PREFIX = 'Генерал';

  function defaultSignalHost() {
    return 'signal.generalskay.site';
  }

  const DEFAULT_SERVER = {
    host: defaultSignalHost(),
    port: 443,
    path: '/',
    secure: true,
    key: 'peerjs'
  };

  const FALLBACK_SERVER = {
    host: 'signal.generalskay.site',
    port: 443,
    path: '/',
    secure: true,
    key: 'peerjs'
  };

  const STUN_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }
  ];
  const LS_TURN = 'komnata.turn.v1';

  const AUDIO_CONSTRAINTS = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };

  const VIDEO_CONSTRAINTS = {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 24, max: 30 },
    facingMode: 'user'
  };

  const IMG_MAX_SIDE = 1400;
  const IMG_MAX_CHARS = 190000;
  const IMG_CHUNK = 8000;
  const IMG_INLINE_LIMIT = 6000;

  const CHAT_HISTORY_LIMIT = 14;

  /* ---------------- состояние ---------------- */

  const state = {
    view: 'home',
    room: '',
    slot: 0,
    name: '',
    peer: null,
    peers: new Map(),
    tiles: new Map(),
    chat: [],
    seen: new Set(),
    incomingFiles: new Map(),
    unread: 0,
    chatOpen: false,
    joined: false,
    connecting: false,
    leaving: false,
    micOn: true,
    camOn: true,
    micReal: false,
    camReal: false,
    screenOn: false,
    micTrack: null,
    camTrack: null,
    screenStream: null,
    audioCtx: null,
    mediaInited: false,
    mediaError: '',
    turn: null,
    repairTimer: null,
    server: { ...DEFAULT_SERVER },
    offerRetry: null
  };

  /* ---------------- DOM ---------------- */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const els = {};

  function cacheEls() {
    els.home = $('#view-home');
    els.lobby = $('#view-lobby');
    els.room = $('#view-room');
    els.joinForm = $('#join-form');
    els.joinCode = $('#join-code');
    els.joinError = $('#join-error');
    els.btnCreate = $('#btn-create');
    els.lobbyCode = $('#lobby-code');
    els.lobbyVideo = $('#lobby-video');
    els.lobbyPlaceholder = $('#lobby-placeholder');
    els.lobbyMic = $('#lobby-mic');
    els.lobbyCam = $('#lobby-cam');
    els.lobbySelfName = $('#lobby-self-name');
    els.lobbyStatus = $('#lobby-status');
    els.nameInput = $('#name-input');
    els.btnEnter = $('#btn-enter');
    els.roomCodeLabel = $('#room-code-label');
    els.roomCount = $('#room-count');
    els.connChip = $('#conn-chip');
    els.connText = $('#conn-text');
    els.connBanner = $('#conn-banner');
    els.connBannerText = $('#conn-banner-text');
    els.grid = $('#grid');
    els.stageEmpty = $('#stage-empty');
    els.emptyLink = $('#empty-link');
    els.roomBody = $('#room-body');
    els.chatPanel = $('#chat-panel');
    els.chatBody = $('#chat-body');
    els.chatEmpty = $('#chat-empty');
    els.chatInput = $('#chat-input');
    els.chatBadge = $('#chat-badge');
    els.fileInput = $('#file-input');
    els.toasts = $('#toasts');
    els.modal = $('#modal');
    els.modalContent = $('#modal-content');
    els.audioSink = $('#audio-sink');
    els.btnMic = $('#btn-mic');
    els.btnCam = $('#btn-cam');
    els.btnScreen = $('#btn-screen');
    els.btnChat = $('#btn-chat');
    els.btnLeave = $('#btn-leave');
    els.btnSend = $('#btn-send');
    els.btnAttach = $('#btn-attach');
    els.dock = $('#dock');
  }

  /* ---------------- утилиты ---------------- */

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function clampText(value, max) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function withRank(name) {
    const clean = name || 'Гость';
    return NAME_PREFIX ? NAME_PREFIX + ' ' + clean : clean;
  }

  function isAutoclawHost() {
    return /(^|\.)autoclawai\.space$/i.test(location.hostname);
  }

  function escapeAttr(value) {
    return String(value).replace(/"/g, '&quot;');
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function formatRoom(code) {
    if (!code) return '—';
    return code.length === 6 ? code.slice(0, 3) + '-' + code.slice(3) : code;
  }

  function normalizeRoom(raw) {
    let value = String(raw || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) {
      try {
        value = new URL(value).searchParams.get('r') || '';
      } catch {
        value = '';
      }
    }
    value = value.toLowerCase().replace(/[^a-z0-9]/g, '');
    return value.length >= 3 && value.length <= 16 ? value : '';
  }

  function generateRoom() {
    const buf = new Uint32Array(6);
    crypto.getRandomValues(buf);
    let out = '';
    for (let i = 0; i < 6; i += 1) out += ROOM_ALPHABET[buf[i] % ROOM_ALPHABET.length];
    return out;
  }

  function roomLink(code) {
    if (!code) return '';
    if (!/^https?:$/.test(location.protocol) || !location.host) return '';
    return location.origin + location.pathname + '?r=' + encodeURIComponent(code);
  }

  function isShareableUrl() {
    return /^https?:$/.test(location.protocol) && !!location.host;
  }

  function peerIdFor(room, slot) {
    return PEER_ID_PREFIX + '-' + room + '-' + slot;
  }

  function toast(text, ms = 2800) {
    if (!els.toasts || !text) return;
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = text;
    els.toasts.appendChild(node);
    setTimeout(() => {
      node.classList.add('toast-out');
      setTimeout(() => node.remove(), 220);
    }, ms);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.className = 'visually-hidden';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }

  function setIcon(button, iconId) {
    const use = button && button.querySelector('use');
    if (use) use.setAttribute('href', iconId);
  }

  /* ---------------- переключение экранов ---------------- */

  function showView(name) {
    state.view = name;
    document.body.dataset.view = name;
    els.home.hidden = name !== 'home';
    els.lobby.hidden = name !== 'lobby';
    els.room.hidden = name !== 'room';
  }

  function setLobbyStatus(text, isError) {
    if (!els.lobbyStatus) return;
    els.lobbyStatus.textContent = text || '';
    els.lobbyStatus.dataset.error = isError ? 'true' : 'false';
  }

  /* ---------------- медиа ---------------- */

  function makeBlackVideoTrack() {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!canvas.captureStream) return null;
    const stream = canvas.captureStream(1);
    return stream.getVideoTracks()[0] || null;
  }

  function makeSilentAudioTrack() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      state.audioCtx = ctx;
      return dest.stream.getAudioTracks()[0] || null;
    } catch {
      return null;
    }
  }

  async function initLocalMedia() {
    if (state.mediaInited) return;
    state.mediaInited = true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      state.micTrack = makeSilentAudioTrack();
      state.camTrack = makeBlackVideoTrack();
      state.micReal = false;
      state.camReal = false;
      state.micOn = false;
      state.camOn = false;
      state.mediaError = 'unsupported';
      return;
    }

    let audioTrack = null;
    let videoTrack = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_CONSTRAINTS,
        video: VIDEO_CONSTRAINTS
      });
      audioTrack = stream.getAudioTracks()[0] || null;
      videoTrack = stream.getVideoTracks()[0] || null;
    } catch (err) {
      state.mediaError = (err && err.name) || 'Error';
      try {
        const a = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        audioTrack = a.getAudioTracks()[0] || null;
      } catch {}
      try {
        const v = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
        videoTrack = v.getVideoTracks()[0] || null;
      } catch {}
    }

    state.micTrack = audioTrack || makeSilentAudioTrack();
    state.camTrack = videoTrack || makeBlackVideoTrack();
    state.micReal = !!audioTrack;
    state.camReal = !!videoTrack;
    state.micOn = !!audioTrack;
    state.camOn = !!videoTrack;

    if (state.micTrack) state.micTrack.enabled = state.micOn;
    if (state.camTrack) state.camTrack.enabled = state.camOn;
  }

  async function tryAcquireMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      const track = stream.getAudioTracks()[0];
      if (!track) return false;
      if (state.micTrack) {
        try { state.micTrack.stop(); } catch {}
      }
      state.micTrack = track;
      state.micReal = true;
      state.micTrack.enabled = true;
      for (const entry of state.peers.values()) {
        if (entry.audioSender) {
          try { await entry.audioSender.replaceTrack(track); } catch {}
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async function tryAcquireCam() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
      const track = stream.getVideoTracks()[0];
      if (!track) return false;
      if (state.camTrack) {
        try { state.camTrack.stop(); } catch {}
      }
      state.camTrack = track;
      state.camReal = true;
      state.camTrack.enabled = true;
      if (!state.screenOn) replaceOutgoingVideo(track);
      refreshLocalVideo();
      return true;
    } catch {
      return false;
    }
  }

  function currentVideoTrack() {
    if (state.screenOn && state.screenStream) {
      const track = state.screenStream.getVideoTracks()[0];
      if (track) return track;
    }
    return state.camTrack;
  }

  function replaceOutgoingVideo(track) {
    if (!track) return;
    for (const entry of state.peers.values()) {
      if (entry.videoSender) {
        try { entry.videoSender.replaceTrack(track).catch(() => {}); } catch {}
      }
    }
  }

  async function toggleMic() {
    if (!state.micOn && !state.micReal) {
      const ok = await tryAcquireMic();
      if (!ok) {
        toast('Микрофон недоступен — разрешите доступ в браузере');
        return;
      }
    }
    state.micOn = !state.micOn;
    if (state.micTrack) state.micTrack.enabled = state.micOn;
    syncControls();
    broadcastState();
  }

  async function toggleCam() {
    if (!state.camOn && !state.camReal) {
      const ok = await tryAcquireCam();
      if (!ok) {
        toast('Камера недоступна — разрешите доступ в браузере');
        return;
      }
      state.camOn = true;
      syncControls();
      broadcastState();
      return;
    }
    state.camOn = !state.camOn;
    if (state.camTrack) state.camTrack.enabled = state.camOn;
    syncControls();
    broadcastState();
  }

  /* ---------------- демонстрация экрана ---------------- */

  async function toggleScreen() {
    if (state.screenOn) {
      stopScreen();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('Этот браузер не умеет показывать экран');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false
      });
    } catch {
      return;
    }
    state.screenStream = stream;
    state.screenOn = true;
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('ended', () => stopScreen());
      replaceOutgoingVideo(track);
    }
    refreshLocalVideo();
    updateTile('self');
    syncControls();
    broadcastState();
    applyBitratePolicy();
    toast('Вы показываете экран');
  }

  function stopScreen(silent) {
    if (!state.screenOn) return;
    state.screenOn = false;
    const stream = state.screenStream;
    state.screenStream = null;
    if (stream) {
      stream.getTracks().forEach((track) => {
        try { track.stop(); } catch {}
      });
    }
    replaceOutgoingVideo(state.camTrack);
    refreshLocalVideo();
    updateTile('self');
    syncControls();
    broadcastState();
    if (!silent) toast('Демонстрация экрана остановлена');
  }

  /* ---------------- сетка плиток ---------------- */

  function createTile(key) {
    const root = document.createElement('div');
    root.className = 'tile';
    root.dataset.video = 'off';
    root.dataset.screen = 'false';

    const video = document.createElement('video');
    video.className = 'tile-video';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;

    const fallback = document.createElement('div');
    fallback.className = 'tile-fallback';
    const initial = document.createElement('span');
    initial.className = 'tile-initial';
    initial.textContent = '?';
    fallback.appendChild(initial);

    const top = document.createElement('div');
    top.className = 'tile-top';
    const screenBadge = document.createElement('span');
    screenBadge.className = 'badge badge-screen';
    screenBadge.textContent = 'Экран';
    screenBadge.hidden = true;
    top.appendChild(screenBadge);

    const bottom = document.createElement('div');
    bottom.className = 'tile-bottom';
    const nameEl = document.createElement('span');
    nameEl.className = 'tile-name';
    nameEl.textContent = 'Гость';
    const flags = document.createElement('span');
    flags.className = 'tile-flags';
    flags.innerHTML = '<svg class="icon"><use href="#i-mic-off"></use></svg>';
    flags.hidden = true;
    bottom.appendChild(nameEl);
    bottom.appendChild(flags);

    const status = document.createElement('div');
    status.className = 'tile-status';
    status.textContent = 'Подключаемся…';
    status.hidden = true;

    root.appendChild(video);
    root.appendChild(fallback);
    root.appendChild(top);
    root.appendChild(bottom);
    root.appendChild(status);

    const tile = { key, el: root, video, fallback, initial, screenBadge, nameEl, flags, status };
    state.tiles.set(key, tile);
    els.grid.appendChild(root);
    updateGridColumns();
    return tile;
  }

  function removeTile(key) {
    const tile = state.tiles.get(key);
    if (!tile) return;
    try { tile.video.srcObject = null; } catch {}
    tile.el.remove();
    state.tiles.delete(key);
    updateGridColumns();
  }

  function updateGridColumns() {
    const count = state.tiles.size;
    els.grid.dataset.count = String(count);
    layoutGrid();
  }

  function layoutGrid() {
    const count = state.tiles.size;
    if (!count) return;
    const stage = els.grid;
    const width = stage ? stage.clientWidth : 0;
    const height = stage ? stage.clientHeight : 0;
    if (!width || !height) return;

    const gap = 10;
    const mobile = window.innerWidth <= 760;
    let cols;
    if (mobile) cols = 1;
    else if (count === 1) cols = 1;
    else if (count === 2) cols = width / height > 1.15 ? 2 : 1;
    else if (count <= 4) cols = 2;
    else if (count <= 9) cols = 3;
    else cols = 4;

    const rows = Math.ceil(count / cols);
    const availW = (width - gap * (cols - 1)) / cols;
    const availH = (height - gap * (rows - 1)) / rows;
    let tileW = availW;
    let tileH = (tileW * 9) / 16;
    if (tileH > availH) {
      tileH = availH;
      tileW = (tileH * 16) / 9;
    }
    tileW = Math.max(120, Math.floor(tileW));
    tileH = Math.max(68, Math.floor(tileH));

    els.grid.style.gridTemplateColumns = 'repeat(' + cols + ', ' + tileW + 'px)';
    els.grid.style.gridAutoRows = tileH + 'px';
    els.grid.style.justifyContent = 'center';
    els.grid.style.alignContent = mobile ? 'start' : 'center';
    els.grid.style.height = mobile ? 'auto' : '100%';
  }

  function refreshLocalVideo() {
    const tile = state.tiles.get('self');
    if (!tile) return;
    const track = currentVideoTrack();
    if (!track) return;
    const current = tile.video.srcObject && tile.video.srcObject.getVideoTracks
      ? tile.video.srcObject.getVideoTracks()[0]
      : null;
    if (current !== track) {
      try {
        tile.video.srcObject = new MediaStream([track]);
        const p = tile.video.play();
        if (p && p.catch) p.catch(() => {});
      } catch {}
    }
  }

  function updateTile(key) {
    const tile = state.tiles.get(key);
    if (!tile) return;
    const isSelf = key === 'self';
    let name = state.name || 'Вы';
    let camOn = state.camOn;
    let micOn = state.micOn;
    let screenOn = state.screenOn;
    let connected = true;

    if (!isSelf) {
      const entry = state.peers.get(key);
      if (!entry) return;
      name = entry.name || 'Гость';
      camOn = !!entry.camOn;
      micOn = entry.micOn !== false;
      screenOn = !!entry.screenOn;
      connected = !!entry.connected;
    }

    tile.el.dataset.video = (camOn || screenOn) ? 'on' : 'off';
    tile.el.dataset.screen = screenOn ? 'true' : 'false';
    tile.el.dataset.mirror = (isSelf && !screenOn) ? 'true' : 'false';
    tile.nameEl.textContent = isSelf ? withRank(state.name || 'Гость') + ' (вы)' : withRank(name);
    tile.initial.textContent = (name.trim()[0] || '?').toUpperCase();
    tile.screenBadge.hidden = !screenOn;
    tile.flags.hidden = micOn;
    tile.status.hidden = connected || isSelf;
    if (!connected) tile.status.textContent = 'Подключаемся…';
  }

  function buildSelfTile() {
    if (state.tiles.has('self')) return;
    createTile('self');
    updateTile('self');
    refreshLocalVideo();
  }

  function ensurePeerTile(slot) {
    if (!state.tiles.has(slot)) createTile(slot);
    updateTile(slot);
  }

  function updateEmptyState() {
    const others = activeSlots().length;
    const show = state.joined && others === 0;
    els.stageEmpty.hidden = !show;
    if (show) {
      const link = roomLink(state.room);
      els.emptyLink.textContent = link || 'Код комнаты: ' + formatRoom(state.room);
    }
  }

  /* ---------------- чат ---------------- */

  function setChatOpen(open) {
    state.chatOpen = !!open;
    els.roomBody.dataset.chat = open ? 'true' : 'false';
    els.btnChat.dataset.on = open ? 'true' : 'false';
    if (open) {
      state.unread = 0;
      updateChatBadge();
      setTimeout(() => els.chatInput.focus(), 60);
      scrollChat(true);
    }
    setTimeout(layoutGrid, 260);
  }

  function updateChatBadge() {
    const count = state.unread;
    els.chatBadge.textContent = count > 99 ? '99+' : String(count);
    els.chatBadge.hidden = count === 0;
    els.btnChat.dataset.badge = String(count);
  }

  function scrollChat(force) {
    const body = els.chatBody;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
    if (force || nearBottom) {
      requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    }
  }

  function hideChatEmpty() {
    if (els.chatEmpty) els.chatEmpty.hidden = true;
  }

  function renderMessage(msg) {
    if (msg.system) {
      const node = document.createElement('div');
      node.className = 'msg-system';
      node.textContent = msg.text;
      els.chatBody.appendChild(node);
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    if (msg.self) wrap.dataset.self = 'true';

    const head = document.createElement('div');
    head.className = 'msg-head';
    const name = document.createElement('span');
    name.className = 'msg-name';
    name.textContent = msg.self ? 'Вы' : withRank(msg.name || 'Гость');
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(msg.ts);
    head.appendChild(name);
    head.appendChild(time);
    wrap.appendChild(head);

    if (msg.text) {
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.textContent = msg.text;
      wrap.appendChild(bubble);
    }

    if (msg.image && msg.image.url) {
      const img = document.createElement('img');
      img.className = 'msg-image';
      img.src = msg.image.url;
      img.alt = 'Изображение в чате';
      img.loading = 'lazy';
      img.addEventListener('click', () => openImageModal(msg.image.url));
      wrap.appendChild(img);
    }

    els.chatBody.appendChild(wrap);
  }

  function addChat(msg) {
    hideChatEmpty();
    state.chat.push(msg);
    if (state.chat.length > 300) state.chat.shift();
    renderMessage(msg);
    if (!msg.system && !msg.self && !state.chatOpen) {
      state.unread += 1;
      updateChatBadge();
    }
    if (msg.system) {
      scrollChat();
    } else {
      scrollChat(msg.self);
    }
  }

  function addSystem(text) {
    addChat({ system: true, text, ts: Date.now() });
  }

  function openImageModal(url) {
    const content = document.createElement('div');
    const img = document.createElement('img');
    img.className = 'modal-img';
    img.src = url;
    img.alt = 'Изображение';
    content.appendChild(img);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const link = document.createElement('a');
    link.className = 'btn btn-ghost btn-sm';
    link.href = url;
    link.download = 'image.jpg';
    link.textContent = 'Скачать';
    actions.appendChild(link);
    content.appendChild(actions);
    openModal(content);
  }

  async function sendChatText() {
    const text = els.chatInput.value.replace(/\s+$/g, '');
    if (!text.trim()) return;
    els.chatInput.value = '';
    autosizeInput();
    const msg = { id: uid(), ts: Date.now(), name: state.name, text: text.slice(0, 2000), image: null, self: true };
    addChat(msg);
    broadcastChat({ ...msg, self: false }, true);
  }

  async function sendFiles(files) {
    const list = Array.from(files || []).filter((f) => f && f.type && f.type.indexOf('image/') === 0);
    if (!list.length) return;
    for (const file of list.slice(0, 4)) {
      try {
        const image = await prepareImage(file);
        const msg = { id: uid(), ts: Date.now(), name: state.name, text: '', image, self: true };
        addChat(msg);
        broadcastChat({ ...msg, self: false }, true);
      } catch {
        toast('Не удалось обработать картинку');
      }
    }
  }

  function broadcastChat(msg, self) {
    const slots = activeSlots();
    for (const slot of slots) sendChatTo(slot, msg);
    if (self) scrollChat(true);
  }

  function sendChatTo(slot, msg) {
    const image = msg.image;
    if (image && image.url && image.url.length > IMG_INLINE_LIMIT) {
      const parts = [];
      for (let i = 0; i < image.url.length; i += IMG_CHUNK) parts.push(image.url.slice(i, i + IMG_CHUNK));
      sendTo(slot, {
        k: 'file-begin',
        id: msg.id,
        ts: msg.ts,
        name: msg.name,
        text: msg.text || '',
        w: image.w,
        h: image.h,
        mime: image.mime || 'image/jpeg',
        parts: parts.length
      });
      parts.forEach((part, index) => sendTo(slot, { k: 'file-part', id: msg.id, i: index, data: part }));
      sendTo(slot, { k: 'file-end', id: msg.id });
      return;
    }
    sendTo(slot, { k: 'chat', msg: { id: msg.id, ts: msg.ts, name: msg.name, text: msg.text || '', image: image || null } });
  }

  function onIncomingFilePart(slot, data) {
    let buffer = state.incomingFiles.get(data.id);
    if (!buffer && data.k === 'file-begin') {
      buffer = {
        id: data.id, ts: data.ts, name: data.name, text: data.text || '',
        w: data.w, h: data.h, mime: data.mime, parts: data.parts,
        chunks: new Array(data.parts), got: 0, at: Date.now()
      };
      state.incomingFiles.set(data.id, buffer);
      return;
    }
    if (!buffer) return;
    if (data.k === 'file-part' && typeof data.i === 'number') {
      if (buffer.chunks[data.i] == null) {
        buffer.chunks[data.i] = data.data;
        buffer.got += 1;
      }
      return;
    }
    if (data.k === 'file-end') {
      state.incomingFiles.delete(data.id);
      if (buffer.got !== buffer.parts) return;
      const url = buffer.chunks.join('');
      receiveChat(slot, {
        id: buffer.id, ts: buffer.ts, name: buffer.name, text: buffer.text,
        image: { url, w: buffer.w, h: buffer.h, mime: buffer.mime }
      });
    }
  }

  function receiveChat(slot, msg) {
    if (!msg || !msg.id) return;
    if (state.seen.has(msg.id)) return;
    state.seen.add(msg.id);
    if (state.seen.size > 500) {
      const first = state.seen.values().next().value;
      state.seen.delete(first);
    }
    const entry = state.peers.get(slot);
    addChat({
      id: msg.id,
      ts: msg.ts || Date.now(),
      name: msg.name || (entry && entry.name) || 'Гость',
      text: (msg.text || '').slice(0, 2000),
      image: msg.image || null,
      self: false
    });
  }

  async function prepareImage(file) {
    const bitmap = await loadBitmap(file);
    const scale = Math.min(1, IMG_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (bitmap.close) try { bitmap.close(); } catch {}

    let quality = 0.82;
    let url = canvas.toDataURL('image/jpeg', quality);
    while (url.length > IMG_MAX_CHARS && quality > 0.42) {
      quality -= 0.1;
      url = canvas.toDataURL('image/jpeg', quality);
    }
    let w = width;
    let h = height;
    let guard = 0;
    while (url.length > IMG_MAX_CHARS * 1.4 && guard < 3) {
      guard += 1;
      w = Math.max(1, Math.round(w * 0.75));
      h = Math.max(1, Math.round(h * 0.75));
      const small = document.createElement('canvas');
      small.width = w;
      small.height = h;
      small.getContext('2d').drawImage(canvas, 0, 0, w, h);
      url = small.toDataURL('image/jpeg', 0.6);
    }
    return { url, w, h, mime: 'image/jpeg' };
  }

  function loadBitmap(file) {
    return new Promise((resolve, reject) => {
      if (window.createImageBitmap) {
        createImageBitmap(file).then(resolve).catch(() => {
          fallback();
        });
      } else {
        fallback();
      }
      function fallback() {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
        img.src = url;
      }
    });
  }

  function autosizeInput() {
    const ta = els.chatInput;
    ta.style.height = 'auto';
    ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
  }

  /* ---------------- сигналинг ---------------- */

  function loadTurn() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_TURN) || 'null');
      if (saved && saved.urls) return saved;
    } catch {}
    return null;
  }

  function iceServers() {
    const list = STUN_SERVERS.slice();
    const turn = state.turn;
    if (turn && turn.urls) {
      const urls = String(turn.urls).split(',').map((item) => item.trim()).filter(Boolean);
      if (urls.length) {
        list.push({
          urls,
          username: turn.username || undefined,
          credential: turn.credential || undefined
        });
      }
    }
    return list;
  }

  function loadServer() {
    const params = new URLSearchParams(location.search);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_SERVER) || 'null'); } catch {}
    const server = { ...DEFAULT_SERVER, ...(saved || {}) };
    if (params.get('srv')) server.host = params.get('srv');
    if (params.get('sport')) server.port = Number(params.get('sport')) || 443;
    if (params.get('spath')) server.path = params.get('spath');
    if (params.get('skey')) server.key = params.get('skey');
    if (params.get('ssecure')) server.secure = params.get('ssecure') !== '0';
    return server;
  }

  function saveServer(server) {
    try { localStorage.setItem(LS_SERVER, JSON.stringify(server)); } catch {}
    state.server = server;
  }

  function sessionToken() {
    try {
      let token = sessionStorage.getItem('komnata.token.v1');
      if (!token) {
        const buf = new Uint8Array(16);
        crypto.getRandomValues(buf);
        token = Array.from(buf, (byte) => byte.toString(16).padStart(2, '0')).join('');
        sessionStorage.setItem('komnata.token.v1', token);
      }
      return token;
    } catch {
      return '';
    }
  }

  function peerOptions() {
    const s = state.server;
    return {
      debug: 0,
      host: s.host,
      port: Number(s.port) || 443,
      path: s.path || '/',
      secure: s.secure !== false,
      key: s.key || 'peerjs',
      token: sessionToken(),
      config: { iceServers: iceServers() }
    };
  }

  function openPeer(id) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let peer;
      try {
        peer = new window.Peer(id, peerOptions());
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { peer.destroy(); } catch {}
        const err = new Error('timeout');
        err.type = 'timeout';
        reject(err);
      }, 12000);

      peer.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(peer);
      });

      peer.on('error', (err) => {
        if (settled) {
          handlePeerRuntimeError(err);
          return;
        }
        settled = true;
        clearTimeout(timer);
        try { peer.destroy(); } catch {}
        reject(err);
      });
    });
  }

  async function acquireSlot(room) {
    const candidates = [];
    const seen = new Set();
    const add = (server) => {
      if (server && server.host && !seen.has(server.host)) {
        seen.add(server.host);
        candidates.push(server);
      }
    };
    add({ ...state.server });
    add({ ...DEFAULT_SERVER });
    add({ ...FALLBACK_SERVER });

    let lastError = null;
    for (const server of candidates) {
      state.server = server;
      try {
        const slot = await acquireSlotOnServer(room);
        return slot;
      } catch (err) {
        if (err && err.message === 'full') throw err;
        lastError = err;
      }
    }
    const error = new Error('signal');
    error.cause = lastError;
    throw error;
  }

  async function pickSlot(room) {
    try {
      const res = await fetch('https://' + state.server.host + '/peerjs/slot?room=' + encodeURIComponent(room), {
        cache: 'no-store'
      });
      if (!res.ok) return 0;
      const data = await res.json();
      const slot = Number(data.slot);
      return slot >= 1 && slot <= MAX_PEERS ? slot : 0;
    } catch {
      return 0;
    }
  }

  async function openSlot(room, slot) {
    const peer = await openPeer(peerIdFor(room, slot));
    state.peer = peer;
    state.slot = slot;
    attachPeerEvents(peer);
    return slot;
  }

  async function openSlotWithRetry(room, slot, attempts = 3) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await openSlot(room, slot);
      } catch (err) {
        lastError = err;
        if (err && err.type === 'unavailable-id') throw err;
        if (state.peer) {
          try { state.peer.destroy(); } catch {}
          state.peer = null;
        }
        await new Promise((resolve) => setTimeout(resolve, 700 + attempt * 600));
      }
    }
    throw lastError;
  }

  async function acquireSlotOnServer(room) {
    const preferred = await pickSlot(room);
    if (preferred) {
      try {
        return await openSlotWithRetry(room, preferred);
      } catch (err) {
        if (err && err.type !== 'unavailable-id') {
          const error = new Error('signal');
          error.cause = err;
          throw error;
        }
      }
    }

    let sawUnavailable = false;
    for (let slot = 1; slot <= MAX_PEERS; slot += 1) {
      try {
        return await openSlot(room, slot);
      } catch (err) {
        const type = err && err.type;
        if (type === 'unavailable-id') {
          sawUnavailable = true;
          continue;
        }
        if (type === 'timeout' || type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
          const error = new Error('signal');
          error.cause = err;
          throw error;
        }
        throw err;
      }
    }
    const error = new Error(sawUnavailable ? 'full' : 'signal');
    throw error;
  }

  function attachPeerEvents(peer) {
    peer.on('connection', (conn) => {
      const meta = conn.metadata || {};
      const slot = Number(meta.slot);
      if (!slot || slot < 1 || slot > MAX_PEERS) {
        try { conn.close(); } catch {}
        return;
      }
      wireConnection(conn, slot);
    });

    peer.on('disconnected', () => {
      setConnState('connecting', 'Переподключение');
      try { peer.reconnect(); } catch {}
    });

    peer.on('open', () => {
      if (!state.joined) return;
      setConnState('online', 'На связи');
      setBanner('');
    });

    peer.on('close', () => {
      setConnState('offline', 'Нет связи');
    });
  }

  function handlePeerRuntimeError(err) {
    const type = err && err.type;
    if (type === 'peer-unavailable') return;
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      setConnState('connecting', 'Переподключение');
    }
  }

  function wireConnection(conn, slot) {
    let entry = state.peers.get(slot);
    if (entry && entry.gone) {
      state.peers.delete(slot);
      entry = null;
    }
    entry = entry || getEntry(slot);
    if (!entry.conns) entry.conns = new Set();
    entry.conns.add(conn);

    conn.on('open', () => {
      entry.conn = conn;
      entry.connOpen = true;
      sendTo(slot, {
        k: 'hello',
        slot: state.slot,
        name: state.name,
        mic: state.micOn,
        cam: state.camOn,
        screen: state.screenOn
      });
      ensurePeerTile(slot);
      updateCount();
      updateEmptyState();
      setTimeout(() => {
        if (entry.connected || !entry.conn || !entry.conn.open) return;
        if (state.slot < slot) startOffer(slot, true);
        else sendTo(slot, { k: 'retry' });
      }, 12000);
    });

    conn.on('data', (data) => onData(slot, data));

    conn.on('close', () => {
      if (entry.conns) entry.conns.delete(conn);
      if (entry.conn === conn) {
        let next = null;
        if (entry.conns) {
          for (const candidate of entry.conns) {
            if (candidate.open) { next = candidate; break; }
          }
        }
        entry.conn = next;
      }
      if (!entry.conn) onPeerGone(slot, true);
    });

    conn.on('error', () => {});
  }

  function connectToSlots() {
    if (!state.peer || !state.peer.open) return;
    for (let slot = 1; slot <= MAX_PEERS; slot += 1) {
      if (slot === state.slot) continue;
      const entry = state.peers.get(slot);
      if (entry && entry.conn && entry.conn.open) continue;
      if (entry && entry.pending) continue;
      connectSlot(slot);
    }
  }

  function connectSlot(slot) {
    if (!state.peer || !state.peer.open) return;
    const entry = getEntry(slot);
    let conn;
    try {
      conn = state.peer.connect(peerIdFor(state.room, slot), {
        reliable: true,
        serialization: 'json',
        metadata: { slot: state.slot, name: state.name }
      });
    } catch {
      return;
    }
    entry.pending = true;
    setTimeout(() => { entry.pending = false; }, 4000);
    conn.on('open', () => { entry.pending = false; });
    conn.on('error', () => { entry.pending = false; });
    wireConnection(conn, slot);
  }

  function getEntry(slot) {
    let entry = state.peers.get(slot);
    if (!entry) {
      entry = {
        slot,
        name: 'Гость',
        conn: null,
        conns: new Set(),
        pc: null,
        connected: false,
        connOpen: false,
        offering: false,
        micOn: true,
        camOn: true,
        screenOn: false,
        remoteStream: null,
        audioEl: null,
        pendingIce: [],
        videoSender: null,
        audioSender: null,
        retryTimer: null,
        gone: false
      };
      state.peers.set(slot, entry);
    }
    return entry;
  }

  function activeSlots() {
    const list = [];
    for (const [slot, entry] of state.peers.entries()) {
      if (entry.conn && entry.conn.open && !entry.gone) list.push(slot);
    }
    return list;
  }

  function sendTo(slot, msg) {
    const entry = state.peers.get(slot);
    if (!entry || !entry.conn || !entry.conn.open) return;
    try { entry.conn.send(msg); } catch {}
  }

  function broadcastState() {
    const payload = { k: 'state', mic: state.micOn, cam: state.camOn, screen: state.screenOn, name: state.name };
    for (const slot of activeSlots()) sendTo(slot, payload);
    updateTile('self');
  }

  function onData(slot, data) {
    if (!data || typeof data !== 'object') return;
    const entry = getEntry(slot);

    if (data.k === 'file-begin' || data.k === 'file-part' || data.k === 'file-end') {
      onIncomingFilePart(slot, data);
      return;
    }

    switch (data.k) {
      case 'hello': {
        entry.name = clampText(data.name, 24) || 'Гость';
        entry.micOn = !!data.mic;
        entry.camOn = !!data.cam;
        entry.screenOn = !!data.screen;
        ensurePeerTile(slot);
        updateTile(slot);
        updateCount();
        updateEmptyState();
        sendHistory(slot);
        maybeStartMedia(slot);
        break;
      }
      case 'ready': {
        if (state.slot < slot) startOffer(slot);
        break;
      }
      case 'retry': {
        if (state.slot < slot) startOffer(slot, true);
        break;
      }
      case 'sdp': {
        onRemoteSdp(slot, data);
        break;
      }
      case 'ice': {
        onRemoteIce(slot, data.c);
        break;
      }
      case 'state': {
        entry.micOn = !!data.mic;
        entry.camOn = !!data.cam;
        entry.screenOn = !!data.screen;
        if (data.name) entry.name = clampText(data.name, 24) || entry.name;
        updateTile(slot);
        break;
      }
      case 'chat': {
        receiveChat(slot, data.msg);
        break;
      }
      case 'hist': {
        (data.items || []).forEach((msg) => receiveChat(slot, msg));
        break;
      }
      case 'bye': {
        onPeerGone(slot, false);
        break;
      }
      default: break;
    }
  }

  function sendHistory(slot) {
    const items = state.chat.filter((m) => !m.system).slice(-CHAT_HISTORY_LIMIT);
    let budget = 600000;
    const out = [];
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const msg = items[i];
      const imageSize = msg.image && msg.image.url ? msg.image.url.length : 0;
      const size = imageSize + (msg.text || '').length;
      if (imageSize > IMG_MAX_CHARS) continue;
      if (size > budget) break;
      budget -= size;
      out.unshift({
        id: msg.id, ts: msg.ts, name: msg.name, text: msg.text || '', image: msg.image || null
      });
    }
    for (const msg of out) sendChatTo(slot, msg);
  }

  /* ---------------- WebRTC ---------------- */

  function maybeStartMedia(slot) {
    if (!state.joined) return;
    if (state.slot < slot) startOffer(slot);
    else sendTo(slot, { k: 'ready' });
  }

  function ensurePC(slot) {
    const entry = getEntry(slot);
    if (entry.pc) return entry.pc;

    const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' });
    entry.pc = pc;

    const outStream = new MediaStream();
    if (state.micTrack) {
      try { entry.audioSender = pc.addTrack(state.micTrack, outStream); } catch {}
    }
    const videoTrack = currentVideoTrack();
    if (videoTrack) {
      try { entry.videoSender = pc.addTrack(videoTrack, outStream); } catch {}
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
      if (pc.remoteDescription && pc.remoteDescription.type) {
        sendTo(slot, { k: 'ice', c: candidate });
      } else {
        entry.pendingIce.push(candidate);
      }
    };

    pc.ontrack = (event) => {
      const track = event.track;
      if (!track) return;
      if (track.kind === 'audio') {
        if (!entry.audioEl) {
          const audio = document.createElement('audio');
          audio.autoplay = true;
          audio.playsInline = true;
          els.audioSink.appendChild(audio);
          entry.audioEl = audio;
          audio.addEventListener('click', () => {
            const p = audio.play();
            if (p && p.catch) p.catch(() => {});
          });
        }
        if (!entry.remoteAudioStream) entry.remoteAudioStream = new MediaStream();
        entry.remoteAudioStream.getAudioTracks().forEach((t) => entry.remoteAudioStream.removeTrack(t));
        entry.remoteAudioStream.addTrack(track);
        entry.audioEl.srcObject = entry.remoteAudioStream;
        const playing = entry.audioEl.play();
        if (playing && playing.catch) playing.catch(() => {});
      } else {
        if (!entry.remoteStream) entry.remoteStream = new MediaStream();
        entry.remoteStream.getVideoTracks().forEach((t) => entry.remoteStream.removeTrack(t));
        entry.remoteStream.addTrack(track);
        const tile = state.tiles.get(slot) || createTile(slot);
        try {
          tile.video.srcObject = entry.remoteStream;
          const p = tile.video.play();
          if (p && p.catch) p.catch(() => {});
        } catch {}
      }
    };

    pc.onconnectionstatechange = () => {
      const connState = pc.connectionState;
      if (connState === 'connected') {
        entry.connected = true;
        clearTimeout(entry.retryTimer);
        setConnState('online', 'На связи');
        updateTile(slot);
        applyBitratePolicy();
      } else if (connState === 'failed') {
        entry.connected = false;
        updateTile(slot);
        if (state.slot < slot) startOffer(slot, true);
      } else if (connState === 'disconnected') {
        entry.connected = false;
        updateTile(slot);
      }
    };

    return pc;
  }

  async function startOffer(slot, iceRestart) {
    const entry = getEntry(slot);
    if (!entry.conn || !entry.conn.open) return;
    if (entry.offering) return;
    if (!iceRestart && entry.connected) return;
    const pc = ensurePC(slot);
    if (pc.signalingState !== 'stable') return;
    entry.offering = true;
    try {
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await pc.setLocalDescription(offer);
      sendTo(slot, { k: 'sdp', sdp: pc.localDescription });
      clearTimeout(entry.retryTimer);
      entry.retryTimer = setTimeout(() => {
        if (!entry.connected && entry.conn && entry.conn.open) startOffer(slot, true);
      }, 9000);
    } catch {
      /* игнорируем: повторим по таймеру */
    } finally {
      entry.offering = false;
    }
  }

  async function onRemoteSdp(slot, data) {
    const entry = getEntry(slot);
    if (!data.sdp || !data.sdp.type) return;
    const pc = ensurePC(slot);
    if (pc.currentRemoteDescription && pc.currentRemoteDescription.sdp === data.sdp.sdp) return;
    try {
      if (data.sdp.type === 'offer' && pc.signalingState !== 'stable') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setLocalDescription({ type: 'rollback' });
        }
      }
      await pc.setRemoteDescription(data.sdp);
      await flushIce(entry, pc);
      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendTo(slot, { k: 'sdp', sdp: pc.localDescription });
      }
    } catch {
      /* повторная попытка будет по таймеру */
    }
  }

  async function flushIce(entry, pc) {
    const list = entry.pendingIce.splice(0);
    for (const candidate of list) {
      try { await pc.addIceCandidate(candidate); } catch {}
    }
  }

  async function onRemoteIce(slot, candidate) {
    if (!candidate) return;
    const entry = getEntry(slot);
    const pc = entry.pc;
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      try { await pc.addIceCandidate(candidate); } catch {}
    } else {
      entry.pendingIce.push(candidate);
    }
  }

  function applyBitratePolicy() {
    const count = activeSlots().length;
    const kbps = count >= 6 ? 320 : count >= 4 ? 520 : count >= 2 ? 850 : 1400;
    if (state.screenOn) {
      /* экран важнее качества лица — оставляем полосу */
    }
    for (const entry of state.peers.values()) {
      const sender = entry.videoSender;
      if (!sender || !sender.getParameters) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = (state.screenOn ? Math.max(kbps, 900) : kbps) * 1000;
        const p = sender.setParameters(params);
        if (p && p.catch) p.catch(() => {});
      } catch {}
    }
  }

  function onPeerGone(slot, quiet) {
    const entry = state.peers.get(slot);
    if (!entry || entry.gone) return;
    entry.gone = true;
    const name = entry.name;
    clearTimeout(entry.retryTimer);
    if (entry.conn) { try { entry.conn.close(); } catch {} }
    if (entry.pc) { try { entry.pc.close(); } catch {} }
    if (entry.audioEl) entry.audioEl.remove();
    removeTile(slot);
    state.peers.delete(slot);
    if (!quiet && !state.leaving && name) addSystem(name + ' вышел из комнаты');
    updateCount();
    updateEmptyState();
    applyBitratePolicy();
  }

  function updateCount() {
    const count = activeSlots().length + 1;
    els.roomCount.textContent = String(Math.min(count, MAX_PEERS));
    updateEmptyState();
  }

  function setConnState(stateName, text) {
    els.connChip.dataset.state = stateName;
    els.connText.textContent = text;
  }

  function setBanner(text) {
    if (!text) {
      els.connBanner.hidden = true;
      els.connBannerText.textContent = '';
      return;
    }
    els.connBannerText.textContent = text;
    els.connBanner.hidden = false;
  }

  function syncControls() {
    els.btnMic.dataset.on = state.micOn ? 'true' : 'false';
    els.btnCam.dataset.on = state.camOn ? 'true' : 'false';
    els.btnScreen.dataset.on = state.screenOn ? 'true' : 'false';
    els.btnChat.dataset.on = state.chatOpen ? 'true' : 'false';
    setIcon(els.btnMic, state.micOn ? '#i-mic' : '#i-mic-off');
    setIcon(els.btnCam, state.camOn ? '#i-cam' : '#i-cam-off');
    setIcon(els.btnScreen, '#i-screen');
    setIcon(els.btnChat, '#i-chat');

    els.lobbyMic.setAttribute('aria-pressed', state.micOn ? 'true' : 'false');
    els.lobbyCam.setAttribute('aria-pressed', state.camOn ? 'true' : 'false');
    setIcon(els.lobbyMic, state.micOn ? '#i-mic' : '#i-mic-off');
    setIcon(els.lobbyCam, state.camOn ? '#i-cam' : '#i-cam-off');
    els.lobbySelfName.textContent = withRank(state.name || 'Гость');
  }

  function updateLobbyPreview() {
    if (!els.lobbyVideo) return;
    if (state.camOn && state.camTrack) {
      const current = els.lobbyVideo.srcObject && els.lobbyVideo.srcObject.getVideoTracks
        ? els.lobbyVideo.srcObject.getVideoTracks()[0]
        : null;
      if (current !== state.camTrack) {
        els.lobbyVideo.srcObject = new MediaStream([state.camTrack]);
        const p = els.lobbyVideo.play();
        if (p && p.catch) p.catch(() => {});
      }
      els.lobbyPlaceholder.hidden = true;
    } else {
      els.lobbyVideo.srcObject = null;
      els.lobbyPlaceholder.hidden = false;
    }
  }

  /* ---------------- вход / выход ---------------- */

  async function openLobby(code) {
    state.room = code;
    state.name = state.name || '';
    if (isShareableUrl()) {
      try { history.replaceState(null, '', location.pathname + '?r=' + encodeURIComponent(code)); } catch {}
    }
    els.lobbyCode.textContent = formatRoom(code);
    els.nameInput.value = state.name || '';
    setLobbyStatus('');
    showView('lobby');
    syncControls();
    updateLobbyPreview();
    await initLocalMedia();
    syncControls();
    updateLobbyPreview();
    if (state.mediaError === 'NotAllowedError' || state.mediaError === 'SecurityError') {
      setLobbyStatus('Камера и микрофон запрещены. Разрешите доступ в адресной строке браузера.', true);
    } else if (!state.camReal && !state.micReal) {
      setLobbyStatus('Устройства не найдены — можно войти и общаться в чате.', true);
    } else {
      setLobbyStatus('Нажмите «Войти в комнату», чтобы подключиться к участникам.');
    }
  }

  function goHome() {
    if (state.joined) leaveRoom();
    state.room = '';
    if (isShareableUrl()) {
      try { history.replaceState(null, '', location.pathname); } catch {}
    }
    showView('home');
  }

  async function createRoom() {
    const code = generateRoom();
    await openLobby(code);
  }

  async function joinByCode() {
    const raw = els.joinCode.value;
    const code = normalizeRoom(raw);
    if (!code) {
      els.joinError.textContent = 'Код состоит из букв и цифр, минимум 3 символа.';
      els.joinCode.focus();
      return;
    }
    els.joinError.textContent = '';
    await openLobby(code);
  }

  async function enterRoom() {
    if (state.connecting || state.joined) return;
    const typed = clampText(els.nameInput.value, 24);
    state.name = typed || 'Гость';
    try { localStorage.setItem(LS_NAME, state.name); } catch {}

    const display = encodeURIComponent(withRank(state.name));
    const jitsiUrl = 'https://meet.jit.si/komnata-' + state.room +
      '#config.prejoinPageEnabled=false&config.prejoinConfig.enabled=false' +
      '&config.disableDeepLinking=true&userInfo.displayName="' + display + '"';
    setLobbyStatus('Открываем комнату…');
    location.href = jitsiUrl;
    return;

    state.connecting = true;
    state.leaving = false;
    els.btnEnter.disabled = true;
    setLobbyStatus('Подключаемся к комнате…');

    showView('room');
    els.roomCodeLabel.textContent = formatRoom(state.room);
    document.title = formatRoom(state.room) + ' — Комната';
    setConnState('connecting', 'Подключение');
    setBanner('');
    buildSelfTile();
    syncControls();
    updateEmptyState();
    updateCount();

    try {
      await initLocalMedia();
      const slot = await acquireSlot(state.room);
      state.joined = true;
      state.slot = slot;
      state.connecting = false;
      els.btnEnter.disabled = false;
      setConnState('online', 'На связи');
      addSystem('Вы вошли в комнату');
      if (window.innerWidth > 980) setChatOpen(true);
      connectToSlots();
      setTimeout(connectToSlots, 3500);
      setTimeout(connectToSlots, 9000);
      updateCount();
      updateEmptyState();
      applyBitratePolicy();
      startRepairLoop();
      setLobbyStatus('');
    } catch (err) {
      const reason = err && err.message;
      console.error('join failed:', reason, err && err.type, err && err.cause);
      state.connecting = false;
      els.btnEnter.disabled = false;
      if (reason === 'full') {
        showRoomError('Комната заполнена', 'В этой комнате уже 10 человек. Попросите ссылку на другую комнату или создайте новую.');
      } else {
        showRoomError(
          'Не удалось подключиться',
          isAutoclawHost()
            ? 'Хостинг AutoClaw блокирует внешние соединения (CSP), поэтому браузеры не могут найти друг друга. Видео заработает сразу после публикации сайта на Netlify (или другом хостинге) — это бесплатно и займёт пару минут. Инструкция уже внутри сайта.'
            : 'Сервер знакомства недоступен. Проверьте интернет, отключите блокировщики или укажите свой сервер сигнализации в настройках.'
        );
      }
      setConnState('offline', 'Нет связи');
    }
  }

  function showRoomError(title, text) {
    const content = document.createElement('div');
    const h = document.createElement('h3');
    h.className = 'modal-title';
    h.textContent = title;
    const p = document.createElement('p');
    p.className = 'modal-body-text';
    p.textContent = text;
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const back = document.createElement('button');
    back.className = 'btn btn-ghost btn-sm';
    back.type = 'button';
    back.textContent = 'На главную';
    back.addEventListener('click', () => { closeModal(); goHome(); });
    const retry = document.createElement('button');
    retry.className = 'btn btn-primary btn-sm';
    retry.type = 'button';
    retry.textContent = 'Попробовать снова';
    retry.addEventListener('click', () => {
      closeModal();
      showView('lobby');
      enterRoom();
    });
    actions.appendChild(back);
    if (isAutoclawHost()) {
      const guide = document.createElement('a');
      guide.className = 'btn btn-ghost btn-sm';
      guide.href = 'guide.html';
      guide.textContent = 'Инструкция';
      actions.appendChild(guide);
    }
    actions.appendChild(retry);
    content.appendChild(h);
    content.appendChild(p);
    content.appendChild(actions);
    openModal(content);
  }

  function leaveRoom() {
    state.leaving = true;
    if (state.screenOn) stopScreen(true);
    for (const slot of Array.from(state.peers.keys())) {
      sendTo(slot, { k: 'bye' });
      onPeerGone(slot, true);
    }
    if (state.peer) {
      try { state.peer.destroy(); } catch {}
      state.peer = null;
    }
    state.joined = false;
    state.slot = 0;
    state.connecting = false;
    stopRepairLoop();
    els.btnEnter.disabled = false;
    state.chat = [];
    state.seen.clear();
    state.unread = 0;
    state.incomingFiles.clear();
    if (els.chatEmpty) els.chatEmpty.hidden = false;
    updateChatBadge();
    removeTile('self');
    els.chatBody.querySelectorAll('.msg, .msg-system').forEach((n) => n.remove());
    setChatOpen(false);
    setBanner('');
    state.leaving = false;
    document.title = 'Комната — видеовстречи по одной ссылке';
  }

  /* ---------------- модальные окна ---------------- */

  function openModal(node) {
    els.modalContent.innerHTML = '';
    els.modalContent.appendChild(node);
    els.modal.hidden = false;
  }

  function closeModal() {
    els.modal.hidden = true;
    els.modalContent.innerHTML = '';
  }

  function openServerSettings() {
    const content = document.createElement('div');
    content.innerHTML = [
      '<h3 class="modal-title" id="modal-title">Сервер сигнализации</h3>',
      '<p class="modal-sub">Через него браузеры находят друг друга. Видео и чат идут напрямую и сервер не хранит.</p>',
      '<div class="settings-grid">',
      '  <label class="field-label full">Хост<input class="input" id="srv-host" autocomplete="off" spellcheck="false"></label>',
      '  <label class="field-label">Порт<input class="input" id="srv-port" inputmode="numeric" autocomplete="off"></label>',
      '  <label class="field-label">Путь<input class="input" id="srv-path" autocomplete="off" spellcheck="false"></label>',
      '  <label class="field-label full">Ключ (key)<input class="input" id="srv-key" autocomplete="off" spellcheck="false"></label>',
      '</div>',
      '<p class="settings-hint">TURN нужен только для сложных сетей (мобильный интернет, строгий NAT). Если видео не соединяется — возьмите бесплатный TURN в Metered (metered.ca) или ExpressTURN и вставьте выданные значения.</p>',
      '<div class="settings-grid">',
      '  <label class="field-label full">TURN URL<input class="input" id="turn-url" placeholder="turn:host:3478,turns:host:5349" autocomplete="off" spellcheck="false"></label>',
      '  <label class="field-label">Логин<input class="input" id="turn-user" autocomplete="off" spellcheck="false"></label>',
      '  <label class="field-label">Пароль<input class="input" id="turn-pass" autocomplete="off" spellcheck="false"></label>',
      '</div>',
      '<p class="settings-hint">По умолчанию используется прокси на Cloudflare (komnata-signal.ivanovmoney336.workers.dev) — он нужен, потому что прямой PeerJS Cloud в России блокируется. Если переименовали воркер или поднимаете свой PeerServer — впишите адрес здесь.</p>',
      '<div class="modal-actions">',
      '  <button class="btn btn-ghost btn-sm" id="srv-reset" type="button">Сбросить</button>',
      '  <button class="btn btn-primary btn-sm" id="srv-save" type="button">Сохранить</button>',
      '</div>'
    ].join('');

    openModal(content);

    const host = content.querySelector('#srv-host');
    const port = content.querySelector('#srv-port');
    const path = content.querySelector('#srv-path');
    const key = content.querySelector('#srv-key');
    host.value = state.server.host;
    port.value = String(state.server.port);
    path.value = state.server.path;
    key.value = state.server.key;
    const turnUrl = content.querySelector('#turn-url');
    const turnUser = content.querySelector('#turn-user');
    const turnPass = content.querySelector('#turn-pass');
    turnUrl.value = state.turn ? state.turn.urls : '';
    turnUser.value = state.turn ? (state.turn.username || '') : '';
    turnPass.value = state.turn ? (state.turn.credential || '') : '';

    content.querySelector('#srv-save').addEventListener('click', () => {
      const next = {
        host: host.value.trim() || DEFAULT_SERVER.host,
        port: Number(port.value) || 443,
        path: path.value.trim() || '/',
        secure: (Number(port.value) || 443) !== 80,
        key: key.value.trim() || 'peerjs'
      };
      saveServer(next);
      const urls = turnUrl.value.trim();
      if (urls) {
        state.turn = { urls, username: turnUser.value.trim(), credential: turnPass.value.trim() };
        try { localStorage.setItem(LS_TURN, JSON.stringify(state.turn)); } catch {}
      } else {
        state.turn = null;
        try { localStorage.removeItem(LS_TURN); } catch {}
      }
      closeModal();
      toast('Настройки сохранены. Применится при следующем входе в комнату.');
    });

    content.querySelector('#srv-reset').addEventListener('click', () => {
      saveServer({ ...DEFAULT_SERVER });
      state.turn = null;
      try { localStorage.removeItem(LS_TURN); } catch {}
      host.value = DEFAULT_SERVER.host;
      port.value = String(DEFAULT_SERVER.port);
      path.value = DEFAULT_SERVER.path;
      key.value = DEFAULT_SERVER.key;
      turnUrl.value = '';
      turnUser.value = '';
      turnPass.value = '';
      toast('Вернули настройки по умолчанию');
    });
  }

  function diagnosticsText() {
    const lines = [];
    const peer = state.peer;
    lines.push('Комната: ' + formatRoom(state.room));
    lines.push('Вы: слот ' + (state.slot || '—') + ' · ' + (state.name || 'Гость'));
    lines.push('Сигналинг: ' + (peer ? (peer.destroyed ? 'destroyed' : peer.disconnected ? 'disconnected' : peer.open ? 'open' : 'connecting') : 'нет') + ' @ ' + state.server.host);
    lines.push('TURN: ' + (state.turn && state.turn.urls ? state.turn.urls : 'не задан (только STUN)'));
    lines.push('Участников: ' + (activeSlots().length + 1));
    lines.push('URL: ' + location.href);
    const visible = [...state.peers.entries()].filter(([, entry]) => (entry.conn && entry.conn.open) || entry.pc);
    if (!visible.length) lines.push('Других участников нет');
    for (const [slot, entry] of visible) {
      const data = entry.conn && entry.conn.open ? 'open' : 'closed';
      const pcState = entry.pc ? entry.pc.connectionState : '—';
      const iceState = entry.pc ? entry.pc.iceConnectionState : '—';
      lines.push('Слот ' + slot + ' · ' + entry.name + ' · data: ' + data + ' · pc: ' + pcState + ' · ice: ' + iceState);
    }
    return lines.join('\n');
  }

  function openDiagnostics() {
    const content = document.createElement('div');
    const title = document.createElement('h3');
    title.className = 'modal-title';
    title.id = 'modal-title';
    title.textContent = 'Состояние связи';
    const sub = document.createElement('p');
    sub.className = 'modal-sub';
    sub.textContent = 'Нажмите «Скопировать» и пришлите текст — по нему видно, на каком шаге застряло соединение.';
    const pre = document.createElement('pre');
    pre.className = 'diag-pre';
    pre.textContent = diagnosticsText();

    const actions = document.createElement('div');
    actions.className = 'invite-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-primary btn-sm';
    copyBtn.textContent = 'Скопировать';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(diagnosticsText());
      toast(ok ? 'Диагностика скопирована' : 'Не удалось скопировать');
    });

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'btn btn-ghost btn-sm';
    checkBtn.textContent = 'Проверить связь';
    checkBtn.addEventListener('click', () => {
      connectToSlots();
      retryMedia();
      setTimeout(() => { pre.textContent = diagnosticsText(); }, 2500);
      toast('Проверяю соединения…');
    });

    actions.appendChild(copyBtn);
    actions.appendChild(checkBtn);
    content.appendChild(title);
    content.appendChild(sub);
    content.appendChild(pre);
    content.appendChild(actions);
    openModal(content);
  }

  function retryMedia() {
    for (const [slot, entry] of state.peers.entries()) {
      if (!entry.conn || !entry.conn.open || entry.connected) continue;
      if (state.slot < slot) startOffer(slot, true);
      else sendTo(slot, { k: 'retry' });
    }
  }

  function startRepairLoop() {
    stopRepairLoop();
    state.repairTimer = setInterval(() => {
      if (!state.joined || state.connecting || document.hidden) return;
      const peer = state.peer;
      if (!peer || peer.destroyed) return;
      if (!peer.open) {
        try { peer.reconnect(); } catch {}
        return;
      }
      if (activeSlots().length === 0) connectToSlots();
      retryMedia();
    }, 12000);
  }

  function stopRepairLoop() {
    if (state.repairTimer) {
      clearInterval(state.repairTimer);
      state.repairTimer = null;
    }
  }

  /* ---------------- обработчики ---------------- */

  function bindEvents() {
    els.btnCreate.addEventListener('click', createRoom);

    els.joinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      joinByCode();
    });

    els.joinCode.addEventListener('input', () => { els.joinError.textContent = ''; });

    els.lobbyCode.addEventListener('dblclick', copyRoomLink);

    $('#lobby-back').addEventListener('click', goHome);
    $('#lobby-copy').addEventListener('click', copyRoomLink);
    $('#btn-copy-top').addEventListener('click', copyRoomLink);
    $('#empty-copy').addEventListener('click', copyRoomLink);
    $('#btn-invite').addEventListener('click', openInvite);
    $('#room-count-chip').addEventListener('click', openDiagnostics);
    $('#chat-close').addEventListener('click', () => setChatOpen(false));

    els.nameInput.addEventListener('input', () => {
      state.name = clampText(els.nameInput.value, 24);
      els.lobbySelfName.textContent = withRank(state.name || 'Гость');
    });

    els.btnEnter.addEventListener('click', enterRoom);

    els.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        enterRoom();
      }
    });

    els.lobbyMic.addEventListener('click', toggleMic);
    els.lobbyCam.addEventListener('click', toggleCam);

    els.btnMic.addEventListener('click', toggleMic);
    els.btnCam.addEventListener('click', toggleCam);
    els.btnScreen.addEventListener('click', toggleScreen);
    els.btnChat.addEventListener('click', () => setChatOpen(!state.chatOpen));
    els.btnLeave.addEventListener('click', () => {
      leaveRoom();
      goHome();
    });
    els.btnLeave.addEventListener('dblclick', (e) => e.preventDefault());

    $('#conn-retry').addEventListener('click', retrySignaling);

    $('#wordmark').addEventListener('click', (event) => {
      event.preventDefault();
      if (state.joined) {
        if (!window.confirm('Выйти из комнаты?')) return;
      }
      leaveRoom();
      goHome();
    });

    $('#btn-server').addEventListener('click', openServerSettings);

    $('#modal-x').addEventListener('click', closeModal);
    els.modal.addEventListener('click', (event) => {
      if (event.target && event.target.dataset && event.target.dataset.close) closeModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !els.modal.hidden) closeModal();
    });

    els.btnSend.addEventListener('click', sendChatText);
    els.chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendChatText();
      }
    });
    els.chatInput.addEventListener('input', autosizeInput);

    els.btnAttach.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', () => {
      sendFiles(els.fileInput.files);
      els.fileInput.value = '';
    });

    els.chatInput.addEventListener('paste', (event) => {
      const items = (event.clipboardData && event.clipboardData.items) || [];
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length) {
        event.preventDefault();
        sendFiles(files);
      }
    });

    let dragDepth = 0;
    els.chatPanel.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
      event.preventDefault();
      dragDepth += 1;
      els.chatPanel.dataset.drop = 'true';
    });
    els.chatPanel.addEventListener('dragover', (event) => {
      if (!event.dataTransfer) return;
      event.preventDefault();
    });
    els.chatPanel.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) els.chatPanel.dataset.drop = 'false';
    });
    els.chatPanel.addEventListener('drop', (event) => {
      event.preventDefault();
      dragDepth = 0;
      els.chatPanel.dataset.drop = 'false';
      if (event.dataTransfer && event.dataTransfer.files) sendFiles(event.dataTransfer.files);
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) resumePlayback();
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        layoutGrid();
        if (state.view === 'lobby') updateLobbyPreview();
      }, 140);
    });

    window.addEventListener('beforeunload', () => {
      for (const slot of activeSlots()) sendTo(slot, { k: 'bye' });
    });
  }

  function resumePlayback() {
    for (const tile of state.tiles.values()) {
      const p = tile.video.play();
      if (p && p.catch) p.catch(() => {});
    }
    for (const entry of state.peers.values()) {
      if (entry.audioEl) {
        const p = entry.audioEl.play();
        if (p && p.catch) p.catch(() => {});
      }
    }
  }

  async function copyRoomLink() {
    const link = roomLink(state.room);
    if (!link) {
      const ok = await copyText(formatRoom(state.room));
      toast(ok ? 'Скопирован код комнаты' : 'Скопируйте код вручную: ' + formatRoom(state.room));
      return;
    }
    const ok = await copyText(link);
    toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать — выделите ссылку вручную');
  }

  function openInvite() {
    if (!state.room) return;
    const link = roomLink(state.room);
    const content = document.createElement('div');

    const title = document.createElement('h3');
    title.className = 'modal-title';
    title.id = 'modal-title';
    title.textContent = 'Пригласите в комнату';

    const sub = document.createElement('p');
    sub.className = 'modal-sub';
    sub.textContent = link
      ? 'Отправьте ссылку друзьям — они зайдут с любого устройства без установки. В комнате до 10 человек.'
      : 'Сейчас доступен только код комнаты. После публикации сайта ссылка будет вести прямо в эту комнату.';

    const field = document.createElement('input');
    field.className = 'input invite-link';
    field.type = 'text';
    field.readOnly = true;
    field.value = link || formatRoom(state.room);
    field.addEventListener('focus', () => field.select());

    const actions = document.createElement('div');
    actions.className = 'invite-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-primary';
    copyBtn.textContent = link ? 'Скопировать ссылку' : 'Скопировать код';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(link || formatRoom(state.room));
      toast(ok ? 'Ссылка скопирована' : 'Выделите ссылку и скопируйте вручную');
    });
    actions.appendChild(copyBtn);

    if (link && navigator.share) {
      const shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.className = 'btn btn-ghost';
      shareBtn.textContent = 'Отправить…';
      shareBtn.addEventListener('click', async () => {
        try {
          await navigator.share({ title: 'Комната ' + formatRoom(state.room), text: 'Заходите в комнату', url: link });
        } catch {}
      });
      actions.appendChild(shareBtn);
    }

    content.appendChild(title);
    content.appendChild(sub);
    content.appendChild(field);

    if (!link) {
      const note = document.createElement('p');
      note.className = 'settings-hint';
      note.textContent = 'Сейчас сайт открыт локально, поэтому ссылка ведёт внутрь приложения и у друзей не откроется. После публикации она будет такой:';
      content.appendChild(note);

      const sample = document.createElement('p');
      sample.className = 'settings-hint';
      const code = document.createElement('code');
      code.textContent = 'https://ваш-сайт.netlify.app/?r=' + state.room;
      sample.appendChild(code);
      content.appendChild(sample);
    } else if (isAutoclawHost()) {
      const note = document.createElement('p');
      note.className = 'settings-hint';
      note.textContent = 'В предпросмотре AutoClaw внешние соединения заблокированы — для видеосвязи откройте сайт на своём домене (инструкция внутри). Ссылка и чат работают.';
      content.appendChild(note);
    }

    content.appendChild(actions);
    openModal(content);

    if (link) {
      copyText(link).then((ok) => { if (ok) toast('Ссылка скопирована'); });
    }
  }

  async function retrySignaling() {
    setBanner('');
    setConnState('connecting', 'Переподключение');
    if (state.peer) {
      try { state.peer.destroy(); } catch {}
      state.peer = null;
    }
    try {
      const slot = await acquireSlot(state.room);
      state.joined = true;
      state.slot = slot;
      setConnState('online', 'На связи');
      connectToSlots();
      setTimeout(connectToSlots, 3000);
    } catch {
      setConnState('offline', 'Нет связи');
      setBanner('Сервер знакомства недоступен. Попробуйте ещё раз или укажите свой сервер.');
    }
  }

  /* ---------------- инициализация ---------------- */

  async function init() {
    cacheEls();
    const note = $('#preview-note');
    if (note) {
      if (isAutoclawHost()) {
        note.hidden = false;
      } else if (!isShareableUrl()) {
        note.textContent = 'Сайт открыт локально — ссылка-приглашение появится после публикации. Сейчас можно скопировать код комнаты.';
        note.hidden = false;
      }
    }
    if (new URLSearchParams(location.search).has('debug')) {
      window.__komnata = { state };
    }
    state.server = loadServer();
    state.turn = loadTurn();
    try { state.name = localStorage.getItem(LS_NAME) || ''; } catch {}
    bindEvents();
    setChatOpen(false);
    updateChatBadge();
    syncControls();
    updateGridColumns();

    if (!window.Peer) {
      toast('Не загрузилась библиотека связи. Обновите страницу.');
    }

    const params = new URLSearchParams(location.search);
    const room = normalizeRoom(params.get('r') || '');
    if (room) {
      await openLobby(room);
    } else {
      showView('home');
      setTimeout(() => { try { els.joinCode.focus(); } catch {} }, 50);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
