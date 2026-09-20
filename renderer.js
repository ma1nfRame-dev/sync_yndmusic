const { ipcRenderer } = require('electron');

const ROOM = 'test-room-1';
const SIGNALING_URL = 'ws://localhost:8080';

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

const audio = new Audio();
audio.crossOrigin = 'anonymous';
let audioReady = false;
let isSeeking = false;

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

let playlist = [];
let playlistIndex = -1;
let playlistMode = null;
let waveSessionId = null;
let isLoadingNext = false;

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

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
  if (!isHost) {
    statusEl.textContent = 'Менять трек может только хост';
    return;
  }
  if (index < 0 || index >= playlist.length) return;
  if (index === playlistIndex && audioReady) {
    sendCommand('seek', 0);
    return;
  }
  playlistIndex = index;
  await playCurrent();
}

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
  playlist = results.slice();
  playlistIndex = index;
  playlistMode = 'search';
  waveSessionId = null;
  updateQueueLabel();

  searchResultsEl.classList.remove('visible');
  await playCurrent();
}

async function startWave() {
  try {
    statusEl.textContent = '📻 Запускаем Волну...';
    searchResultsEl.classList.remove('visible');

    const { sessionId, tracks } = await ipcRenderer.invoke('radio-start');
    if (!tracks.length) {
      statusEl.textContent = '📻 Волна пустая, попробуй ещё раз';
      return;
    }

    playlist = tracks.slice();
    playlistIndex = 0;
    playlistMode = 'wave';
    waveSessionId = sessionId;
    updateQueueLabel();

    console.log(`📻 Волна запущена, треков: ${playlist.length}`);
    await playCurrent();
  } catch (err) {
    console.error('Wave error:', err);
    statusEl.textContent = '📻 Ошибка Волны: ' + err.message;
  }
}

async function fetchMoreWave() {
  if (isLoadingNext) return false;
  if (playlistMode !== 'wave' || !waveSessionId) return false;
  isLoadingNext = true;
  try {
    statusEl.textContent = '📻 Загружаем следующую порцию...';
    const more = await ipcRenderer.invoke('radio-next', waveSessionId);
    if (!more.length) {
      statusEl.textContent = '📻 Волна не вернула треков';
      return false;
    }
    playlist = playlist.concat(more);
    updateQueueLabel();
    console.log(`📻 Догружено ${more.length}, всего ${playlist.length}`);
    return true;
  } catch (err) {
    console.error('Wave next error:', err);
    statusEl.textContent = '📻 Ошибка: ' + err.message;
    return false;
  } finally {
    isLoadingNext = false;
  }
}

async function playCurrent() {
  const track = playlist[playlistIndex];
  if (!track) return;

  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'load', track }));
  }

  await loadTrack(track);
  updateQueueLabel();

  if (isHost && dataChannel && dataChannel.readyState === 'open') {
    setTimeout(() => sendCommand('play', 0), 400);
  }
}

async function nextTrack() {
  if (!isHost) return;
  if (playlist.length === 0) return;

  if (playlistIndex + 1 < playlist.length) {
    playlistIndex++;
    await playCurrent();
    return;
  }

  if (playlistMode === 'wave') {
    const ok = await fetchMoreWave();
    if (ok && playlistIndex + 1 < playlist.length) {
      playlistIndex++;
      await playCurrent();
    }
  } else {
    statusEl.textContent = 'Это последний трек в плейлисте';
  }
}

async function prevTrack() {
  if (!isHost) return;
  if (playlist.length === 0) return;
  if (playlistIndex - 1 < 0) {
    sendCommand('seek', 0);
    return;
  }
  playlistIndex--;
  await playCurrent();
}

async function loadTrack(track) {
  try {
    audioReady = false;
    seekBar.disabled = true;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();

    statusEl.textContent = 'Загружаем трек...';
    trackTitleEl.textContent = `Загрузка: ${track.artists} — ${track.title}`;

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
    console.error('Ошибка загрузки:', err);
    statusEl.textContent = 'Ошибка загрузки: ' + err.message;
    trackTitleEl.textContent = 'Не удалось загрузить';
  }
}

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

audio.addEventListener('ended', () => {
  if (isHost) {
    console.log('Трек закончился → следующий');
    nextTrack();
  }
});

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
  isSeeking = false;
  sendCommand('seek', newPos);
});

playBtn.addEventListener('click', () => sendCommand('play'));
pauseBtn.addEventListener('click', () => sendCommand('pause'));
prevBtn.addEventListener('click', prevTrack);
nextBtn.addEventListener('click', nextTrack);

window.addEventListener('keydown', (e) => {
  const inInput = e.target.tagName === 'INPUT';
  if (e.code === 'Space' && audioReady && !inInput) {
    e.preventDefault();
    if (audio.paused) audio.play(); else audio.pause();
  } else if (e.code === 'ArrowRight' && !inInput) {
    e.preventDefault();
    nextTrack();
  } else if (e.code === 'ArrowLeft' && !inInput) {
    e.preventDefault();
    prevTrack();
  }
});