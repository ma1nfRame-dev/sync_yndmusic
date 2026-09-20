const ROOM = 'test-room-1';
const SIGNALING_URL = 'ws://localhost:8080';

const statusEl = document.getElementById('status');
const ws = new WebSocket(SIGNALING_URL);

let pc = null;
let dataChannel = null;
let role = null;

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
    console.log('Моя роль:', role);
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

  pc.onconnectionstatechange = () => {
    console.log('Состояние соединения:', pc.connectionState);
  };
}

function setupDataChannel() {
  dataChannel.onopen = () => {
    statusEl.textContent = 'P2P-соединение установлено!';
    dataChannel.send('Привет от ' + role);
  };

  dataChannel.onmessage = (event) => {
    console.log('Получено сообщение:', event.data);
    statusEl.textContent = 'Получено сообщение: "' + event.data + '"';
  };
}