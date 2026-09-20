const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

let apiPromise = null;
function getApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const { YMApi, WrappedYMApi } = require('yamd2');
      const cfg = {
        access_token: process.env.YM_TOKEN,
        uid: Number(process.env.YM_UID)
      };
      const api = new YMApi();
      const wrapped = new WrappedYMApi();
      await api.init(cfg);
      await wrapped.init(cfg);
      console.log('✅ yamd2 авторизован');
      return { api, wrapped };
    })();
  }
  return apiPromise;
}

// --- Поиск треков ---
ipcMain.handle('search-tracks', async (_event, query) => {
  const { api } = await getApi();
  const result = await api.search.tracks(query);

  const raw = result?.tracks?.results || [];
  const tracks = raw
    .filter(t => t.available !== false)
    .slice(0, 15) // ограничим список
    .map(t => ({
      id: t.id,
      title: t.title,
      version: t.version || null,
      artists: (t.artists || []).map(a => a.name).join(', '),
      album: t.albums?.[0]?.title || '',
      durationMs: t.durationMs || 0,
      cover: t.coverUri
        ? 'https://' + t.coverUri.replace('%%', '200x200')
        : null
    }));

  console.log(`🔍 "${query}" → найдено ${tracks.length} треков`);
  return tracks;
});

// --- Получение прямой ссылки на аудио ---
ipcMain.handle('get-audio-url', async (_event, trackId) => {
  const { wrapped } = await getApi();
  const trackUrl = `https://music.yandex.ru/track/${trackId}`;
  const info = await wrapped.getDownloadInfo(trackUrl, { codec: 'mp3' });
  console.log('🎵 URL получен для трека', trackId);
  return info.downloadInfoUrl;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});