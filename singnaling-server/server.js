const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ port: 8080 });
const rooms = new Map();

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);

    if (msg.type === 'join') {
      currentRoom = msg.room;
      if (!rooms.has(currentRoom)) rooms.set(currentRoom, new Set());
      const peers = rooms.get(currentRoom);

      const role = peers.size === 0 ? 'offerer' : 'answerer';
      peers.add(ws);
      ws.send(JSON.stringify({ type: 'role', role }));
      console.log(`Клиент присоединился к "${currentRoom}" как ${role}`);

      if (peers.size === 2) {
        for (const client of peers) {
          client.send(JSON.stringify({ type: 'ready' }));
        }
      }
      return;
    }

    if (currentRoom && rooms.has(currentRoom)) {
      for (const client of rooms.get(currentRoom)) {
        if (client !== ws && client.readyState === client.OPEN) {
          client.send(raw.toString());
        }
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(ws);
    }
  });
});

console.log('Signaling-сервер запущен на порту 8080');