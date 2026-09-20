const { ipcRenderer } = require('electron');

// --- Логгер ---
function logEvent(type, data = {}) {
  const entry = {
    t: Date.now(),
    iso: new Date().toISOString(),
    pid: 'renderer',
    type,
    ...data
  };
  try { console.log(`[${type}]`, data); } catch (e) {}
  try { ipcRenderer.send('log-write', entry); } catch (e) {}
}

let ROOM = 'test-room-1';
let SIGNALING_URL = 'ws://localhost:8080';

// --- DOM ---
const statusEl = document.getElementById('status');
const trackTitleEl = document.getElementById('trackTitle');
const trackQueueEl = document.getElementById('trackQueue');
const seekRow = document.getElementById('seekRow');
const seekBar = document.getElementById('seekBar');
const timeCurrentEl = document.getElementById('timeCurrent');
const timeTotalEl = document.getElementById('timeTotal');
const searchRow = document.getElementById('searchRow');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const searchResultsEl = document.getElementById('searchResults');
const playRow = document.getElementById('playRow');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const volumeRow = document.getElementById('volumeRow');
const volumeBar = document.getElementById('volumeBar');
const volumeLabel = document.getElementById('volumeLabel');
const muteBtn = document.getElementById('muteBtn');
const waveBtn = document.getElementById('waveBtn');
const queuePanel = document.getElementById('queuePanel');
const queueList = document.getElementById('queueList');

const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const ymTokenInput = document.getElementById('ymTokenInput');
const ymUidInput = document.getElementById('ymUidInput');
const signalingUrlInput = document.getElementById('signalingUrlInput');
const roomNameInput = document.getElementById('roomNameInput');
const settingsSaveBtn = document.getElementById('settingsSaveBtn');
const settingsCancelBtn = document.getElementById('settingsCancelBtn');
const logBtn = document.getElementById('logBtn');

// --- Аудио ---
const audio = new Audio();
audio.crossOrigin = 'anonymous';
let audioReady = false;
let isSeeking = false;
let isReloading = false;

// --- Состояние ---
let ws;
let pc = null;
let dataChannel = null;
let role = null;
let isHost = false;

let clockOffset = 0;
const pingSamples = [];
const PING_SAMPLE_COUNT = 8;
const LEAD_TIME_MS = 500;
const RESYNC_INTERVAL_MS = 30000;

let virtualPosition = 0;
let isPlaying = false;
let positionTimer = null;

// --- Плейлист ---
let playlist = [];
let playlistIndex = -1;
let playlistMode = null;
let waveSessionId = null;
let isLoadingNext = false;
let isAdvancing = false;
let isPlayCurrentBusy = false;

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
      urls: [
        'turn:turn.evan-brass.net',
        'turn:turn.evan-brass.net?transport=tcp',
        'turns:turn.evan-brass.net:443?transport=tcp'
      ],
      username: 'user',
      credential: 'password'
    }
  ]
};

// --- Утилиты ---
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function snapshotState() {
  return {
    audioReady,
    isReloading,
    isAdvancing,
    isSeeking,
    isPlaying,
    paused: audio.paused,
    currentTime: Number(audio.currentTime.toFixed(3)),
    duration: Number((audio.duration || 0).toFixed(3)),
    playlistIndex,
    playlistLen: playlist.length,
    playlistMode,
    waveSessionId,
    isHost,
    dataChannelState: dataChannel ? dataChannel.readyState : 'none',
    wsState: ws ? ws.readyState : 'none',
    clockOffset: Number(clockOffset.toFixed(2))
  };
}

// --- WebSocket ---
function initWebSocket() {
  logEvent('ws:init', { url: SIGNALING_URL, room: ROOM });
  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => {
    logEvent('ws:open', { url: SIGNALING_URL });
    statusEl.textContent = 'Подключено к signaling, ждём партнёра...';
    const joinMsg = { type: 'join', room: ROOM };
    ws.send(JSON.stringify(joinMsg));
    logEvent('ws:send', { msg: joinMsg });
  };

  ws.onerror = (e) => {
    logEvent('ws:error', { message: e.message || 'unknown' });
    statusEl.textContent = 'Ошибка подключения к signaling-серверу';
  };

  ws.onclose = (e) => {
    logEvent('ws:close', { code: e.code, reason: e.reason });
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    logEvent('ws:recv', { msg: { type: msg.type, role: msg.role, hasSdp: !!msg.sdp, hasCandidate: !!msg.candidate } });

    if (msg.type === 'role') {
      role = msg.role;
      isHost = role === 'offerer';
      if (isHost) searchRow.classList.add('visible');
      return;
    }

    if (msg.type === 'ready') {
      statusEl.textContent = 'Партнёр найден, устанавливаем P2P...';
      createPeerConnection();

      if (role === 'offerer') {
        dataChannel = pc.createDataChannel('sync');
        setupDataChannel();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: 'offer', sdp: offer }));
        logEvent('ws:send', { msg: { type: 'offer' } });
      }
      return;
    }

    if (msg.type === 'offer') {
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', sdp: answer }));
      logEvent('ws:send', { msg: { type: 'answer' } });
      return;
    }

    if (msg.type === 'answer') {
      await pc.setRemoteDescription(msg.sdp);
      return;
    }

    if (msg.type === 'ice') {
      if (msg.candidate) await pc.addIceCandidate(msg.candidate);
      return;
    }
  };
}

function createPeerConnection() {
  pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'ice', candidate: event.candidate }));
      logEvent('ws:send', { msg: { type: 'ice', candidateType: event.candidate.type } });
    } else {
      logEvent('ice:end-of-candidates');
    }
  };

  pc.oniceconnectionstatechange = () => logEvent('pc:iceConnectionState', { state: pc.iceConnectionState });
  pc.onconnectionstatechange = () => logEvent('pc:connectionState', { state: pc.connectionState });
  pc.onsignalingstatechange = () => logEvent('pc:signalingState', { state: pc.signalingState });

  pc.ondatachannel = (event) => {
    dataChannel = event.channel;
    setupDataChannel();
  };
}

function setupDataChannel() {
  logEvent('dc:setup', { label: dataChannel.label });

  dataChannel.onopen = () => {
    logEvent('dc:open', { state: dataChannel.readyState });
    statusEl.textContent = 'P2P установлен, замеряем пинг...';
    if (isHost) playRow.classList.add('visible');
    runClockSync();
    setInterval(runClockSync, RESYNC_INTERVAL_MS);
  };

  dataChannel.onclose = () => logEvent('dc:close', { state: dataChannel.readyState });
  dataChannel.onerror = (e) => logEvent('dc:error', { message: e.message || 'unknown' });

  dataChannel.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch (e) { logEvent('dc:recv:parse-error', { raw: event.data }); return; }

    if (msg.type === 'ping' || msg.type === 'pong') {
      logEvent('dc:recv', { type: msg.type, t0: msg.t0, t1: msg.t1, t2: msg.t2 });
    } else {
      logEvent('dc:recv', { msg });
    }
    handleMessage(msg);
  };
}

function dcSend(msg) {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    logEvent('dc:send:SKIPPED', { reason: 'not open', state: dataChannel ? dataChannel.readyState : 'none', msg });
    return false;
  }
  dataChannel.send(JSON.stringify(msg));
  return true;
}

// --- Поиск ---
async function doSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  logEvent('ui:search', { query });
  searchResultsEl.innerHTML = '<div class="searchHint">Поиск...</div>';
  searchResultsEl.classList.add('visible');

  try {
    const tracks = await ipcRenderer.invoke('search-tracks', query);
    renderResults(tracks);
  } catch (err) {
    logEvent('ui:search:error', { error: err.message });
    searchResultsEl.innerHTML = '<div class="searchHint">Ошибка поиска: ' + err.message + '</div>';
  }
}

function renderResults(tracks) {
  if (!tracks.length) {
    searchResultsEl.innerHTML = '<div class="searchHint">Ничего не найдено</div>';
    return;
  }

  searchResultsEl.innerHTML = '';
  tracks.forEach((t, idx) => {
    const item = document.createElement('div');
    item.className = 'searchItem';

    const img = document.createElement('img');
    if (t.cover) img.src = t.cover;
    item.appendChild(img);

    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = t.title + (t.version ? ` (${t.version})` : '');
    const sub = document.createElement('div');
    sub.className = 'subtitle';
    sub.textContent = `${t.artists}${t.album ? ' • ' + t.album : ''}`;
    info.appendChild(title);
    info.appendChild(sub);
    item.appendChild(info);

    const dur = document.createElement('div');
    dur.className = 'duration';
    dur.textContent = formatTime(t.durationMs / 1000);
    item.appendChild(dur);

    item.addEventListener('click', () => pickTrackFromSearch(tracks, idx));
    searchResultsEl.appendChild(item);
  });
}

async function pickTrackFromSearch(results, index) {
  logEvent('ui:pickTrackFromSearch', { index, total: results.length, track: results[index] });
  playlist = results.slice();
  playlistIndex = index;
  playlistMode = 'search';
  waveSessionId = null;
  updateQueueLabel();

  searchResultsEl.classList.remove('visible');
  await playCurrent('search-pick');
}

// --- Волна ---
async function startWave() {
  try {
    logEvent('ui:startWave');
    statusEl.textContent = '📻 Запускаем Волну...';
    searchResultsEl.classList.remove('visible');

    const { sessionId, tracks } = await ipcRenderer.invoke('radio-start');
    logEvent('wave:started', { sessionId, tracksLen: tracks.length });
    if (!tracks.length) {
      statusEl.textContent = '📻 Волна пустая, попробуй ещё раз';
      return;
    }

    playlist = tracks.slice();
    playlistIndex = 0;
    playlistMode = 'wave';
    waveSessionId = sessionId;
    updateQueueLabel();

    await playCurrent('wave-start');
  } catch (err) {
    logEvent('wave:start:error', { error: err.message });
    statusEl.textContent = '📻 Ошибка Волны: ' + err.message;
  }
}

async function fetchMoreWave() {
  if (isLoadingNext) return false;
  if (playlistMode !== 'wave' || !waveSessionId) return false;
  isLoadingNext = true;
  logEvent('wave:fetchMore:start', { waveSessionId, currentLen: playlist.length });
  try {
    statusEl.textContent = '📻 Загружаем следующую порцию...';
    const more = await ipcRenderer.invoke('radio-next', waveSessionId);
    if (!more.length) {
      logEvent('wave:fetchMore:empty');
      statusEl.textContent = '📻 Волна не вернула треков';
      return false;
    }
    playlist = playlist.concat(more);
    updateQueueLabel();
    logEvent('wave:fetchMore:done', { added: more.length, total: playlist.length });
    return true;
  } catch (err) {
    logEvent('wave:fetchMore:error', { error: err.message });
    statusEl.textContent = '📻 Ошибка: ' + err.message;
    return false;
  } finally {
    isLoadingNext = false;
  }
}

// --- Воспроизведение ---
async function playCurrent(caller = 'unknown') {
  if (isPlayCurrentBusy) {
    logEvent('playCurrent:blocked', { caller });
    return;
  }
  isPlayCurrentBusy = true;
  try {
    const track = playlist[playlistIndex];
    logEvent('playCurrent', { caller, playlistIndex, track: track ? { id: track.id, title: track.title } : null, state: snapshotState() });
    if (!track) return;

    dcSend({ type: 'load', track });
    await loadTrack(track, caller);
    updateQueueLabel();

    if (isHost) {
      setTimeout(() => sendCommand('play', 0, 'autoplay-after-load'), 1500);
    }
  } finally {
    setTimeout(() => { isPlayCurrentBusy = false; }, 500);
  }
}

async function nextTrack(caller = 'unknown') {
  logEvent('nextTrack:enter', { caller, isHost, isAdvancing, state: snapshotState() });
  if (!isHost) return;
  if (playlist.length === 0) return;
  if (isAdvancing) {
    logEvent('nextTrack:blocked', { reason: 'isAdvancing' });
    return;
  }
  isAdvancing = true;
  try {
    if (playlistIndex + 1 < playlist.length) {
      playlistIndex++;
      await playCurrent('next:' + caller);
      return;
    }

    if (playlistMode === 'wave') {
      const ok = await fetchMoreWave();
      if (ok && playlistIndex + 1 < playlist.length) {
        playlistIndex++;
        await playCurrent('next:wave-extend:' + caller);
      }
    } else {
      logEvent('nextTrack:end-of-playlist');
      statusEl.textContent = 'Это последний трек в плейлисте';
    }
  } finally {
    setTimeout(() => { isAdvancing = false; }, 800);
  }
}

async function prevTrack(caller = 'unknown') {
  logEvent('prevTrack:enter', { caller, state: snapshotState() });
  if (!isHost) return;
  if (playlist.length === 0) return;
  if (playlistIndex - 1 < 0) {
    sendCommand('seek', 0, 'prev-restart');
    return;
  }
  playlistIndex--;
  await playCurrent('prev:' + caller);
}

async function loadTrack(track, caller = 'unknown') {
  isReloading = true;
  logEvent('loadTrack:start', { caller, track: { id: track.id, title: track.title, artists: track.artists } });
  try {
    audioReady = false;
    seekBar.disabled = true;
    audio.pause();

    statusEl.textContent = 'Загружаем трек...';
    trackTitleEl.textContent = `Загрузка: ${track.artists} — ${track.title}`;

    const directUrl = await ipcRenderer.invoke('get-audio-url', track.id);
    logEvent('loadTrack:got-url', { trackId: track.id, urlHead: String(directUrl).slice(0, 80) });
    audio.src = directUrl;

    await new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('audio error: ' + (audio.error?.code || 'unknown'))); };
      const cleanup = () => {
        audio.removeEventListener('canplaythrough', onReady);
        audio.removeEventListener('error', onError);
      };
      audio.addEventListener('canplaythrough', onReady, { once: true });
      audio.addEventListener('error', onError, { once: true });
      audio.load();
    });

    audioReady = true;
    logEvent('loadTrack:ready', { duration: audio.duration, currentTime: audio.currentTime });

    trackTitleEl.textContent = `${track.artists} — ${track.title} • ${formatTime(audio.duration)}`;

    seekBar.max = audio.duration;
    seekBar.value = 0;
    seekBar.disabled = false;
    timeCurrentEl.textContent = '0:00';
    timeTotalEl.textContent = formatTime(audio.duration);
    seekRow.classList.add('visible');
    volumeRow.style.display = 'flex';

    document.title = `${track.artists} — ${track.title} | Sync Player`;
    statusEl.textContent = playlistMode === 'wave' ? '📻 Волна играет' : 'Трек готов';
  } catch (err) {
    logEvent('loadTrack:error', { error: err.message });
    statusEl.textContent = 'Ошибка загрузки: ' + err.message;
    trackTitleEl.textContent = 'Не удалось загрузить';
  } finally {
    setTimeout(() => {
      isReloading = false;
      logEvent('loadTrack:isReloading-clear');
    }, 500);
  }
}

// --- Сеть ---
function handleMessage(msg) {
  if (msg.type === 'ping') {
    const t1 = Date.now();
    dcSend({ type: 'pong', t0: msg.t0, t1, t2: Date.now() });
    return;
  }

  if (msg.type === 'pong') {
    const t3 = Date.now();
    const rtt = t3 - msg.t0;
    const offset = ((msg.t1 - msg.t0) + (msg.t2 - t3)) / 2;
    pingSamples.push({ rtt, offset });
    if (pingSamples.length >= PING_SAMPLE_COUNT) finishClockSync();
    else setTimeout(sendPing, 200);
    return;
  }

  if (msg.type === 'command') {
    logEvent('handle:command', { action: msg.action, position: msg.position, scheduledAt: msg.scheduledAt, now: Date.now(), clockOffset });
    scheduleCommand(msg.action, msg.position, msg.scheduledAt);
    return;
  }

  if (msg.type === 'load') {
    logEvent('handle:load', { track: msg.track });
    loadTrack(msg.track, 'remote-load');
    return;
  }

  logEvent('handle:unknown', { msg });
}

function runClockSync() {
  pingSamples.length = 0;
  sendPing();
}

function sendPing() {
  dcSend({ type: 'ping', t0: Date.now() });
}

function finishClockSync() {
  const sorted = [...pingSamples].sort((a, b) => a.rtt - b.rtt);
  const best = sorted.slice(0, Math.ceil(sorted.length / 2));
  clockOffset = best.reduce((sum, s) => sum + s.offset, 0) / best.length;
  const avgRtt = best.reduce((sum, s) => sum + s.rtt, 0) / best.length;
  logEvent('clockSync:done', { clockOffset, avgRtt, samples: pingSamples.length });
  statusEl.textContent = `Синхронизация: RTT ${avgRtt.toFixed(0)}мс`;
}

// --- Команды ---
function sendCommand(action, extraPosition, caller = 'unknown') {
  if (!isHost) {
    logEvent('sendCommand:blocked', { reason: 'not host', caller });
    return;
  }
  if (!audioReady) {
    logEvent('sendCommand:skip', { action, caller, reason: 'audioReady=false' });
    statusEl.textContent = 'Сначала выбери трек';
    return;
  }
  const position = extraPosition !== undefined ? extraPosition : audio.currentTime;
  const scheduledAt = Date.now() + LEAD_TIME_MS;
  const msg = { type: 'command', action, position, scheduledAt };
  logEvent('sendCommand', { caller, action, position, scheduledAt, state: snapshotState() });
  dcSend(msg);
  scheduleCommand(action, position, scheduledAt, true);
}

function scheduleCommand(action, position, hostScheduledAt, isLocalHost = false) {
  // ФИКС: знак clockOffset должен быть МИНУС (offset = peer - local, чтобы получить local — вычитаем)
  const localTargetTime = isLocalHost ? hostScheduledAt : hostScheduledAt - clockOffset;
  const delay = localTargetTime - Date.now();

  logEvent('scheduleCommand', { action, position, delay: Number(delay.toFixed(1)), isLocalHost });

  setTimeout(async () => {
    logEvent('scheduleCommand:fire', { action, position, audioReady, state: snapshotState() });
    if (!audioReady) {
      logEvent('scheduleCommand:skipped', { action, reason: 'audioReady=false' });
      return;
    }

    if (action === 'play') {
      audio.currentTime = position;
      try {
        await audio.play();
        logEvent('scheduleCommand:played', { position });
        isPlaying = true;
        startPositionTimer();
      } catch (e) {
        logEvent('scheduleCommand:play-failed', { error: e.message });
      }
    } else if (action === 'pause') {
      audio.pause();
      isPlaying = false;
      stopPositionTimer();
      logEvent('scheduleCommand:paused');
    } else if (action === 'seek') {
      audio.currentTime = position;
      if (!audio.paused) startPositionTimer();
      logEvent('scheduleCommand:seeked', { position });
    }
  }, Math.max(0, delay));
}

function startPositionTimer() {
  stopPositionTimer();
  positionTimer = setInterval(() => {
    virtualPosition = audio.currentTime;
    if (!isSeeking) {
      seekBar.value = audio.currentTime;
      timeCurrentEl.textContent = formatTime(audio.currentTime);
    }
  }, 100);
}

function stopPositionTimer() {
  if (positionTimer) clearInterval(positionTimer);
  timeCurrentEl.textContent = formatTime(audio.currentTime);
}

// --- Аудио-события ---
audio.addEventListener('play', () => logEvent('audio:play', { currentTime: audio.currentTime, state: snapshotState() }));
audio.addEventListener('pause', () => logEvent('audio:pause', { currentTime: audio.currentTime, state: snapshotState() }));
audio.addEventListener('waiting', () => logEvent('audio:waiting', { currentTime: audio.currentTime }));
audio.addEventListener('stalled', () => logEvent('audio:stalled', { currentTime: audio.currentTime }));
audio.addEventListener('canplay', () => logEvent('audio:canplay', { currentTime: audio.currentTime, duration: audio.duration }));
audio.addEventListener('seeking', () => logEvent('audio:seeking', { currentTime: audio.currentTime }));
audio.addEventListener('seeked', () => logEvent('audio:seeked', { currentTime: audio.currentTime }));
audio.addEventListener('error', () => {
  const e = audio.error;
  logEvent('audio:error', { code: e?.code, message: e?.message });
});

audio.addEventListener('ended', () => {
  logEvent('audio:ended', { currentTime: audio.currentTime, duration: audio.duration, state: snapshotState() });
  if (isReloading) {
    logEvent('audio:ended:ignored', { reason: 'isReloading' });
    return;
  }
  if (isHost) {
    nextTrack('ended');
  } else {
    logEvent('audio:ended:not-host-ignore');
  }
});

// --- Громкость ---
let lastVolume = 1;

function updateVolumeUI() {
  const v = audio.muted ? 0 : audio.volume;
  volumeBar.value = v;
  volumeLabel.textContent = Math.round(v * 100) + '%';
  if (audio.muted || audio.volume === 0) muteBtn.textContent = '🔇';
  else if (audio.volume < 0.34) muteBtn.textContent = '🔈';
  else if (audio.volume < 0.67) muteBtn.textContent = '🔉';
  else muteBtn.textContent = '🔊';
}

volumeBar.addEventListener('input', () => {
  const v = parseFloat(volumeBar.value);
  audio.muted = false;
  audio.volume = v;
  if (v > 0) lastVolume = v;
  updateVolumeUI();
});

muteBtn.addEventListener('click', () => {
  if (audio.muted || audio.volume === 0) {
    audio.muted = false;
    audio.volume = lastVolume > 0 ? lastVolume : 1;
  } else {
    lastVolume = audio.volume;
    audio.muted = true;
  }
  updateVolumeUI();
});

updateVolumeUI();

// --- Очередь ---
function updateQueueLabel() {
  if (playlist.length === 0 || playlistIndex < 0) {
    trackQueueEl.textContent = '';
    queuePanel.classList.remove('visible');
    return;
  }
  const mode = playlistMode === 'wave' ? '📻 ' : '';
  trackQueueEl.textContent = `${mode}${playlistIndex + 1} / ${playlist.length}`;
  queuePanel.classList.add('visible');
  renderQueue();
}

function renderQueue() {
  if (playlist.length === 0) {
    queueList.innerHTML = '<div class="queueEmpty">Пусто</div>';
    return;
  }

  queueList.innerHTML = '';
  playlist.forEach((t, idx) => {
    const item = document.createElement('div');
    item.className = 'queueItem' + (idx === playlistIndex ? ' current' : '');
    item.dataset.index = idx;

    const cover = document.createElement('img');
    cover.className = 'queueCover';
    if (t.cover) cover.src = t.cover;
    item.appendChild(cover);

    const info = document.createElement('div');
    info.className = 'queueInfo';

    const title = document.createElement('div');
    title.className = 'queueTitle';
    title.textContent = t.title + (t.version ? ` (${t.version})` : '');

    const artist = document.createElement('div');
    artist.className = 'queueArtist';
    artist.textContent = t.artists;

    info.appendChild(title);
    info.appendChild(artist);
    item.appendChild(info);

    const idxEl = document.createElement('div');
    idxEl.className = 'queueIndex';
    idxEl.textContent = idx + 1;
    item.appendChild(idxEl);

    item.addEventListener('click', () => jumpToTrack(idx));
    queueList.appendChild(item);
  });

  requestAnimationFrame(() => {
    const current = queueList.querySelector('.queueItem.current');
    if (current) current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

async function jumpToTrack(index) {
  logEvent('ui:jumpToTrack', { index, isHost });
  if (!isHost) {
    statusEl.textContent = 'Менять трек может только хост';
    return;
  }
  if (index < 0 || index >= playlist.length) return;
  if (index === playlistIndex && audioReady) {
    sendCommand('seek', 0, 'jump-restart');
    return;
  }
  playlistIndex = index;
  await playCurrent('jump');
}

// --- UI события ---
searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});

waveBtn.addEventListener('click', startWave);

seekBar.addEventListener('input', () => {
  isSeeking = true;
  timeCurrentEl.textContent = formatTime(parseFloat(seekBar.value));
});

seekBar.addEventListener('change', () => {
  const newPos = parseFloat(seekBar.value);
  logEvent('ui:seek', { newPos });
  isSeeking = false;
  sendCommand('seek', newPos, 'seek-bar');
});

playBtn.addEventListener('click', () => sendCommand('play', undefined, 'play-btn'));
pauseBtn.addEventListener('click', () => sendCommand('pause', undefined, 'pause-btn'));
prevBtn.addEventListener('click', () => prevTrack('button'));
nextBtn.addEventListener('click', () => nextTrack('button'));

window.addEventListener('keydown', (e) => {
  const inInput = e.target.tagName === 'INPUT';
  if (e.code === 'Space' && audioReady && !inInput) {
    e.preventDefault();
    if (audio.paused) audio.play(); else audio.pause();
  } else if (e.code === 'ArrowRight' && !inInput) {
    e.preventDefault();
    nextTrack('hotkey-right');
  } else if (e.code === 'ArrowLeft' && !inInput) {
    e.preventDefault();
    prevTrack('hotkey-left');
  }
});

// --- Настройки ---
settingsBtn.addEventListener('click', async () => {
  try {
    const config = await ipcRenderer.invoke('settings-load');
    if (config) {
      ymTokenInput.value = config.ymToken || '';
      ymUidInput.value = config.ymUid || '';
      signalingUrlInput.value = config.signalingUrl || 'ws://localhost:8080';
      roomNameInput.value = config.roomName || 'test-room-1';
    }
  } catch (err) {
    logEvent('settings:load:error', { error: err.message });
  }
  settingsModal.classList.add('visible');
});

settingsCancelBtn.addEventListener('click', () => {
  settingsModal.classList.remove('visible');
});

settingsSaveBtn.addEventListener('click', async () => {
  const config = {
    ymToken: ymTokenInput.value.trim(),
    ymUid: ymUidInput.value.trim(),
    signalingUrl: signalingUrlInput.value.trim() || 'ws://localhost:8080',
    roomName: roomNameInput.value.trim() || 'test-room-1'
  };

  logEvent('settings:save', { hasToken: !!config.ymToken, ymUid: config.ymUid, signalingUrl: config.signalingUrl, roomName: config.roomName });

  try {
    const result = await ipcRenderer.invoke('settings-save', config);
    if (result.success) {
      logEvent('settings:saved:reloading');
      settingsModal.classList.remove('visible');
      window.location.reload();
    } else {
      alert('Ошибка сохранения: ' + result.error);
    }
  } catch (err) {
    logEvent('settings:save:error', { error: err.message });
    alert('Ошибка сохранения: ' + err.message);
  }
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    settingsModal.classList.remove('visible');
  }
});

if (logBtn) {
  logBtn.addEventListener('click', async () => {
    const p = await ipcRenderer.invoke('log-open');
    logEvent('ui:log-open', { path: p });
  });
}

// --- Init ---
(async () => {
  try {
    const config = await ipcRenderer.invoke('settings-load');
    if (config) {
      if (config.signalingUrl) SIGNALING_URL = config.signalingUrl;
      if (config.roomName) ROOM = config.roomName;
    }
  } catch (err) {
    logEvent('init:settings-load-error', { error: err.message });
  }
  logEvent('init:session-start', { room: ROOM, url: SIGNALING_URL });
  initWebSocket();
})();