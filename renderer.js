const { ipcRenderer } = require('electron');

const ROOM = 'test-room-1';
const SIGNALING_URL = 'ws://localhost:8080';

const statusEl = document.getElementById('status');
const trackInfoEl = document.getElementById('trackInfo');
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

const audio = new Audio();
audio.crossOrigin = 'anonymous';
let audioReady = false;
let isSeeking = false;
let currentTrack = null; // { id, title, artists, ... }

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

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// --- Утилиты ---
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// --- Signaling ---
ws = new WebSocket(SIGNALING_URL);

ws.onopen = () => {
  statusEl.textContent = 'Подключено к signaling, ждём партнёра...';
  ws.send(JSON.stringify({ type: 'join', room: ROOM }));
};

ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);

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
    }
    return;
  }

  if (msg.type === 'offer') {
    await pc.setRemoteDescription(msg.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'answer', sdp: answer }));
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

function createPeerConnection() {
  pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'ice', candidate: event.candidate }));
    }
  };

  pc.ondatachannel = (event) => {
    dataChannel = event.channel;
    setupDataChannel();
  };
}

function setupDataChannel() {
  dataChannel.onopen = () => {
    statusEl.textContent = 'P2P установлен, замеряем пинг...';
    playRow.classList.add('visible');
    runClockSync();
    setInterval(runClockSync, RESYNC_INTERVAL_MS);
  };

  dataChannel.onmessage = (event) => {
    handleMessage(JSON.parse(event.data));
  };
}

// --- Поиск треков ---
async function doSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  searchResultsEl.innerHTML = '<div class="searchHint">Поиск...</div>';
  searchResultsEl.classList.add('visible');

  try {
    const tracks = await ipcRenderer.invoke('search-tracks', query);
    renderResults(tracks);
  } catch (err) {
    console.error('Search error:', err);
    searchResultsEl.innerHTML = '<div class="searchHint">Ошибка поиска: ' + err.message + '</div>';
  }
}

function renderResults(tracks) {
  if (!tracks.length) {
    searchResultsEl.innerHTML = '<div class="searchHint">Ничего не найдено</div>';
    return;
  }

  searchResultsEl.innerHTML = '';
  tracks.forEach(t => {
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

    item.addEventListener('click', () => pickTrack(t));
    searchResultsEl.appendChild(item);
  });
}

function pickTrack(track) {
  // 1. Отправляем команду "load" партнёру
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'load', track }));
  }
  // 2. Грузим локально
  loadTrack(track);
  // 3. Скрываем список
  searchResultsEl.classList.remove('visible');
}

// --- Загрузка трека ---
async function loadTrack(track) {
  try {
    audioReady = false;
    seekBar.disabled = true;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();

    currentTrack = track;
    statusEl.textContent = 'Загружаем трек...';
    trackInfoEl.textContent = `Загрузка: ${track.artists} — ${track.title}`;

    const directUrl = await ipcRenderer.invoke('get-audio-url', track.id);
    audio.src = directUrl;

    await new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('audio error')); };
      const cleanup = () => {
        audio.removeEventListener('canplaythrough', onReady);
        audio.removeEventListener('error', onError);
      };
      audio.addEventListener('canplaythrough', onReady, { once: true });
      audio.addEventListener('error', onError, { once: true });
      audio.load();
    });

    audioReady = true;
    trackInfoEl.textContent = `${track.artists} — ${track.title} • ${formatTime(audio.duration)}`;

    seekBar.max = audio.duration;
    seekBar.value = 0;
    seekBar.disabled = false;
    timeCurrentEl.textContent = '0:00';
    timeTotalEl.textContent = formatTime(audio.duration);
    seekRow.classList.add('visible');

    statusEl.textContent = 'Трек готов. Хост может нажать Play.';
    document.title = `${track.artists} — ${track.title} | Sync Player`;
  } catch (err) {
    console.error('Ошибка загрузки:', err);
    statusEl.textContent = 'Ошибка загрузки: ' + err.message;
    trackInfoEl.textContent = 'Не удалось загрузить';
  }
}

// --- Сообщения по сети ---
function handleMessage(msg) {
  if (msg.type === 'ping') {
    const t1 = Date.now();
    dataChannel.send(JSON.stringify({ type: 'pong', t0: msg.t0, t1, t2: Date.now() }));
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
    scheduleCommand(msg.action, msg.position, msg.scheduledAt);
    return;
  }

  if (msg.type === 'load') {
    console.log('Получена команда load:', msg.track);
    loadTrack(msg.track);
    return;
  }
}

function runClockSync() {
  pingSamples.length = 0;
  sendPing();
}

function sendPing() {
  dataChannel.send(JSON.stringify({ type: 'ping', t0: Date.now() }));
}

function finishClockSync() {
  const sorted = [...pingSamples].sort((a, b) => a.rtt - b.rtt);
  const best = sorted.slice(0, Math.ceil(sorted.length / 2));
  clockOffset = best.reduce((sum, s) => sum + s.offset, 0) / best.length;
  const avgRtt = best.reduce((sum, s) => sum + s.rtt, 0) / best.length;
  console.log('Clock sync:', { clockOffset, avgRtt, isHost });
  statusEl.textContent = `Синхронизация: RTT ${avgRtt.toFixed(0)}мс`;
}

// --- Команды play/pause/seek ---
function sendCommand(action, extraPosition) {
  if (!audioReady) {
    statusEl.textContent = 'Сначала выбери трек';
    return;
  }
  const position = extraPosition !== undefined ? extraPosition : audio.currentTime;
  const scheduledAt = Date.now() + LEAD_TIME_MS;
  dataChannel.send(JSON.stringify({ type: 'command', action, position, scheduledAt }));
  scheduleCommand(action, position, scheduledAt, true);
}

function scheduleCommand(action, position, hostScheduledAt, isLocalHost = false) {
  const localTargetTime = isLocalHost ? hostScheduledAt : hostScheduledAt + clockOffset;
  const delay = localTargetTime - Date.now();
  console.log(`Команда "${action}" → через ${delay.toFixed(0)}мс, позиция ${position.toFixed(2)}с`);

  setTimeout(async () => {
    if (!audioReady) return;

    if (action === 'play') {
      audio.currentTime = position;
      try {
        await audio.play();
        isPlaying = true;
        startPositionTimer();
      } catch (e) {
        console.error('play() упал:', e);
      }
    } else if (action === 'pause') {
      audio.pause();
      isPlaying = false;
      stopPositionTimer();
    } else if (action === 'seek') {
      audio.currentTime = position;
      if (!audio.paused) startPositionTimer();
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

// --- UI ---
searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});

seekBar.addEventListener('input', () => {
  isSeeking = true;
  timeCurrentEl.textContent = formatTime(parseFloat(seekBar.value));
});

seekBar.addEventListener('change', () => {
  const newPos = parseFloat(seekBar.value);
  isSeeking = false;
  sendCommand('seek', newPos);
});

playBtn.addEventListener('click', () => sendCommand('play'));
pauseBtn.addEventListener('click', () => sendCommand('pause'));

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && audioReady && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    if (audio.paused) audio.play(); else audio.pause();
  }
});