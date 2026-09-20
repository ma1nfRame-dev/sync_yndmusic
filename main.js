const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// --- Простое хранилище настроек (JSON в userData) ---
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'sync-settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveSettings(obj) {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(obj, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('Не смог сохранить настройки:', e);
    return false;
  }
}

// --- API Яндекс.Музыки ---
let apiPromise = null;
function getApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const { YMApi, WrappedYMApi } = require('yamd2');

      const s = loadSettings();
      let access_token = s.ymToken;
      let uid = s.ymUid;

      // Fallback на .env
      if (!access_token) access_token = process.env.YM_TOKEN;
      if (!uid) uid = process.env.YM_UID;

      if (!access_token || !uid) {
        throw new Error('Токен Яндекс.Музыки не настроен. Открой ⚙️ Настройки и введи токен и UID.');
      }

      const cfg = {
        access_token: String(access_token),
        uid: Number(uid)
      };

      console.log('🔐 Инициализация yamd2 с uid =', cfg.uid);
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

// --- Нормализация ---
function normalizeTrack(t) {
  return {
    id: t.id || t.realId,
    title: t.title,
    version: t.version || null,
    artists: (t.artists || []).map(a => a.name).join(', '),
    album: t.albums?.[0]?.title || '',
    durationMs: t.durationMs || 0,
    cover: t.coverUri
      ? 'https://' + t.coverUri.replace('%%', '200x200')
      : null
  };
}

function extractRotorTracks(batch) {
  const sequence = batch?.sequence || [];
  return sequence
    .map(item => item?.track)
    .filter(t => t && (t.id || t.realId))
    .map(normalizeTrack);
}

// --- Поиск ---
ipcMain.handle('search-tracks', async (_event, query) => {
  const { api } = await getApi();
  const result = await api.search.tracks(query);
  const raw = result?.tracks?.results || [];
  const tracks = raw
    .filter(t => t.available !== false)
    .slice(0, 15)
    .map(normalizeTrack);
  console.log(`🔍 "${query}" → найдено ${tracks.length} треков`);
  return tracks;
});

// --- Прямая ссылка ---
ipcMain.handle('get-audio-url', async (_event, trackId) => {
  const { wrapped } = await getApi();
  const trackUrl = `https://music.yandex.ru/track/${trackId}`;
  const info = await wrapped.getDownloadInfo(trackUrl, { codec: 'mp3' });
  console.log('🎵 URL получен для трека', trackId);
  return info.downloadInfoUrl;
});

// --- Волна ---
ipcMain.handle('radio-start', async () => {
  const { api } = await getApi();
  console.log('📻 Создаём rotor-сессию...');
  const session = await api.radio.createRotorSession();
  const sessionId = session?.sessionId || session?.id || session?.radioSessionId;
  if (!sessionId) throw new Error('Не удалось получить sessionId');
  console.log('📻 sessionId:', sessionId);
  const batch = await api.radio.postRotorSessionTracks(sessionId);
  const tracks = extractRotorTracks(batch);
  console.log(`📻 Волна запущена, треков: ${tracks.length}`);
  return { sessionId, tracks };
});

ipcMain.handle('radio-next', async (_event, sessionId) => {
  const { api } = await getApi();
  console.log('📻 Следующая порция для sessionId:', sessionId);
  const batch = await api.radio.postRotorSessionTracks(sessionId);
  const tracks = extractRotorTracks(batch);
  console.log(`📻 Получено ещё ${tracks.length} треков`);
  return tracks;
});

// --- Настройки ---
ipcMain.handle('settings-load', async () => {
  const s = loadSettings();
  return {
    ymToken: s.ymToken || '',
    ymUid: s.ymUid || '',
    signalingUrl: s.signalingUrl || 'ws://localhost:8080',
    roomName: s.roomName || 'test-room-1'
  };
});

ipcMain.handle('settings-save', async (_event, config) => {
  const ok = saveSettings({
    ymToken: String(config.ymToken || ''),
    ymUid: String(config.ymUid || ''),
    signalingUrl: String(config.signalingUrl || 'ws://localhost:8080'),
    roomName: String(config.roomName || 'test-room-1')
  });
  if (ok) {
    apiPromise = null; // пересоздадим API с новым токеном
    console.log('✅ Настройки сохранены в', getSettingsPath());
    return { success: true };
  }
  return { success: false, error: 'Не смог записать файл' };
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
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