const { ipcRenderer } = require('electron');

const ROOM = 'test-room-1';
const SIGNALING_URL = 'ws://localhost:8080';

const statusEl = document.getElementById('status');
const trackInfoEl = document.getElementById('trackInfo');
const seekRow = document.getElementById('seekRow');
const seekBar = document.getElementById('seekBar');
const timeCurrentEl = document.getElementById('timeCurrent');
const timeTotalEl = document.getElementById('timeTotal');
const loadRow = document.getElementById('loadRow');
const playRow = document.getElementById('playRow');
const trackUrlInput = document.getElementById('trackUrlInput');
const loadBtn = document.getElementById('loadBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');

const audio = new Audio();
audio.crossOrigin = 'anonymous';
let audioReady = false;
let isSeeking = false; // пользователь тащит ползунок

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

// --- Вспомогательные ---
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
    if (isHost) loadRow.classList.add('visible');
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

// --- Загрузка трека ---
async function loadTrack(trackUrl) {
  try {
    audioReady = false;
    seekBar.disabled = true;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();

    statusEl.textContent = 'Загружаем трек...';
    trackInfoEl.textContent = 'Загрузка: ' + trackUrl;

    const directUrl = await ipcRenderer.invoke('get-audio-url', trackUrl);
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
    const trackId = trackUrl.split('/').pop();
    trackInfoEl.textContent = `Трек #${trackId} • ${formatTime(audio.duration)}`;

    // Настраиваем прогресс-бар
    seekBar.max = audio.duration;
    seekBar.value = 0;
    seekBar.disabled = false;
    timeCurrentEl.textContent = '0:00';
    timeTotalEl.textContent = formatTime(audio.duration);
    seekRow.classList.add('visible');

    statusEl.textContent = 'Трек готов. Хост может нажать Play.';
  } catch (err) {
    console.error('Ошибка загрузки:', err);
    statusEl.textContent = 'Ошибка загрузки: ' + err.message;
    trackInfoEl.textContent = 'Не удалось загрузить';
  }
}

// --- Сообщения ---
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
    console.log('Получена команда load:', msg.trackUrl);
    loadTrack(msg.trackUrl);
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

// --- Команды ---
function sendCommand(action, extraPosition) {
  if (!audioReady) {
    statusEl.textContent = 'Сначала загрузи трек';
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
      // если играло — играет с новой точки; если пауза — остаётся на паузе
      if (!audio.paused) startPositionTimer();
    }
  }, Math.max(0, delay));
}

function startPositionTimer() {
  stopPositionTimer();
  positionTimer = setInterval(() => {
    virtualPosition = audio.currentTime;

    // Обновляем ползунок, только если пользователь его не тащит
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

// --- Прогресс-бар / seek ---
// Пока тащим — показываем время под курсором, но НЕ отправляем команду
seekBar.addEventListener('input', () => {
  isSeeking = true;
  timeCurrentEl.textContent = formatTime(parseFloat(seekBar.value));
});

// Отпустили ползунок — отправляем seek и возвращаем управление
seekBar.addEventListener('change', () => {
  const newPos = parseFloat(seekBar.value);
  isSeeking = false;
  sendCommand('seek', newPos);
});

// --- Кнопки ---
loadBtn.addEventListener('click', () => {
  const url = trackUrlInput.value.trim();
  if (!url) return;
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'load', trackUrl: url }));
  }
  loadTrack(url);
});

playBtn.addEventListener('click', () => sendCommand('play'));
pauseBtn.addEventListener('click', () => sendCommand('pause'));

// Пробел — локальный play/pause
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && audioReady) {
    e.preventDefault();
    if (audio.paused) audio.play(); else audio.pause();
  }
});