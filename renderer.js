const ROOM = 'test-room-1';
const SIGNALING_URL = 'ws://localhost:8080';

const statusEl = document.getElementById('status');
const positionEl = document.getElementById('position');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');

const ws = new WebSocket(SIGNALING_URL);

let pc = null;
let dataChannel = null;
let role = null;
let isHost = false;

let clockOffset = 0;
const pingSamples = [];
const PING_SAMPLE_COUNT = 8;
const LEAD_TIME_MS = 300;
const RESYNC_INTERVAL_MS = 30000;

// Виртуальное состояние плеера
let virtualPosition = 0; // секунды
let isPlaying = false;
let positionTimer = null;

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

ws.onopen = () => {
  statusEl.textContent = 'Подключено к signaling-серверу, ждём партнёра...';
  ws.send(JSON.stringify({ type: 'join', room: ROOM }));
};

ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'role') {
    role = msg.role;
    isHost = role === 'offerer';
    if (isHost) {
      playBtn.style.display = 'inline-block';
      pauseBtn.style.display = 'inline-block';
    }
    return;
  }

  if (msg.type === 'ready') {
    statusEl.textContent = 'Партнёр найден, устанавливаем соединение...';
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
    runClockSync();
    setInterval(runClockSync, RESYNC_INTERVAL_MS);
  };

  dataChannel.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };
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

    if (pingSamples.length >= PING_SAMPLE_COUNT) {
      finishClockSync();
    } else {
      setTimeout(sendPing, 200);
    }
    return;
  }

  if (msg.type === 'command') {
    scheduleCommand(msg.action, msg.position, msg.scheduledAt);
    return;
  }
}

function runClockSync() {
  pingSamples.length = 0;
  sendPing();
}

function sendPing() {
  const t0 = Date.now();
  dataChannel.send(JSON.stringify({ type: 'ping', t0 }));
}

function finishClockSync() {
  const sorted = [...pingSamples].sort((a, b) => a.rtt - b.rtt);
  const best = sorted.slice(0, Math.ceil(sorted.length / 2));
  clockOffset = best.reduce((sum, s) => sum + s.offset, 0) / best.length;
  const avgRtt = best.reduce((sum, s) => sum + s.rtt, 0) / best.length;

  statusEl.textContent = `Готово (хост: ${isHost}). RTT: ${avgRtt.toFixed(1)}мс, offset: ${clockOffset.toFixed(1)}мс`;
  console.log('Clock sync:', { clockOffset, avgRtt, isHost });
}

// ---- Команды Play/Pause ----

function sendCommand(action) {
  const scheduledAt = Date.now() + LEAD_TIME_MS;
  dataChannel.send(JSON.stringify({ type: 'command', action, position: virtualPosition, scheduledAt }));
  scheduleCommand(action, virtualPosition, scheduledAt, true);
}

function scheduleCommand(action, position, hostScheduledAt, isLocalHost = false) {
  // Переводим момент "по часам хоста" в наши локальные часы
  const localTargetTime = isLocalHost ? hostScheduledAt : hostScheduledAt + clockOffset;
  const delay = localTargetTime - Date.now();

  console.log(`Команда "${action}" запланирована через ${delay.toFixed(1)}мс`);

  setTimeout(() => {
    const actualTime = Date.now();
    console.log(`Команда "${action}" выполнена в ${actualTime}, позиция: ${position}с`);
    virtualPosition = position;

    if (action === 'play') {
      isPlaying = true;
      startPositionTimer();
    } else if (action === 'pause') {
      isPlaying = false;
      stopPositionTimer();
    }
  }, Math.max(0, delay));
}

function startPositionTimer() {
  stopPositionTimer();
  const startedAt = Date.now();
  const startedFrom = virtualPosition;
  positionTimer = setInterval(() => {
    virtualPosition = startedFrom + (Date.now() - startedAt) / 1000;
    positionEl.textContent = `Позиция: ${virtualPosition.toFixed(2)}с (${isPlaying ? 'играет' : 'пауза'})`;
  }, 100);
}

function stopPositionTimer() {
  if (positionTimer) clearInterval(positionTimer);
  positionEl.textContent = `Позиция: ${virtualPosition.toFixed(2)}с (пауза)`;
}

playBtn.addEventListener('click', () => sendCommand('play'));
pauseBtn.addEventListener('click', () => sendCommand('pause'));