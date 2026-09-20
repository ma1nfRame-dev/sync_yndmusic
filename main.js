const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Ленивая инициализация API — чтобы не тормозить старт окна
let apiPromise = null;
function getApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const { WrappedYMApi } = require('yamd2');
      const api = new WrappedYMApi();
      await api.init({
        access_token: process.env.YM_TOKEN,
        uid: Number(process.env.YM_UID)
      });
      console.log('✅ yamd2 авторизован');
      return api;
    })();
  }
  return apiPromise;
}

// Renderer попросит URL — main вернёт свежую ссылку
ipcMain.handle('get-audio-url', async (_event, trackUrl) => {
  try {
    const api = await getApi();
    const info = await api.getDownloadInfo(trackUrl, { codec: 'mp3' });
    console.log('🎵 URL получен для', trackUrl);
    return info.downloadInfoUrl;
  } catch (err) {
    console.error('❌ Ошибка получения URL:', err.message);
    throw err;
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
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