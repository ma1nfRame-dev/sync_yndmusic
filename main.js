const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// --- Логирование в файл ---
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(
    LOG_DIR,
    `sync-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.jsonl`
);
console.log('📝 Лог пишется в:', LOG_FILE);

ipcMain.on('log-write', (_event, entry) => {
    try {
        fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (e) {
        console.error('Не смог записать лог:', e.message);
    }
});

ipcMain.handle('log-open', () => {
    shell.showItemInFolder(LOG_FILE);
    return LOG_FILE;
});

ipcMain.handle('log-path', () => LOG_FILE);

// --- Настройки ---
function getSettingsPath() {
    return path.join(app.getPath('userData'), 'sync-settings.json');
}

function loadSettings() {
    try {
        return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
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

            if (!access_token) access_token = process.env.YM_TOKEN;
            if (!uid) uid = process.env.YM_UID;

            if (!access_token || !uid) {
                throw new Error('Токен Яндекс.Музыки не настроен. Открой ⚙️ Настройки и введи токен и UID, либо авторизуйся через Яндекс.');
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

// --- Нормализация трека ---
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

// --- Поиск (гибридный, с режимом) ---
ipcMain.handle('search-tracks', async (_event, query, mode = 'tracks') => {
    const { api } = await getApi();
    const q = String(query || '').trim();
    if (!q) return [];

    console.log(`🔍 Поиск: "${q}" (режим: ${mode})`);

    const result = await api.search.tracks(q);
    const rawTracks = result?.tracks?.results || [];

    // Режим "Треки" — просто отдаём как есть
    if (mode !== 'artist') {
        const tracks = rawTracks
            .filter(t => t.available !== false)
            .slice(0, 15)
            .map(normalizeTrack);
        console.log(`  → треков по названию: ${tracks.length}`);
        return tracks;
    }

    // Режим "Исполнитель" — тянем треки найденного артиста первыми
    console.log(`  → треков по названию: ${rawTracks.length}, ищем исполнителя...`);

    let artistTracks = [];
    let artistName = null;

    try {
        const artistResult = await api.search.artists(q);
        const firstArtist = artistResult?.artists?.results?.[0] || null;
        if (firstArtist && firstArtist.id) {
            artistName = firstArtist.name;
            const data = await api.artists.getArtistTracks(firstArtist.id, { page: 0, pageSize: 10 });
            artistTracks = data?.tracks || data?.results || [];
            console.log(`  → треков исполнителя "${artistName}": ${artistTracks.length}`);
        } else {
            console.log(`  → исполнитель не найден`);
        }
    } catch (e) {
        console.log(`  ⚠️ Не смог получить треки исполнителя: ${e.message}`);
    }

    // Объединяем: артист первым, потом обычные треки, убираем дубли
    const seen = new Set();
    const merged = [];
    const pushTrack = (t) => {
        if (!t) return;
        const id = String(t.id || t.realId || '');
        if (!id || seen.has(id)) return;
        if (t.available === false) return;
        seen.add(id);
        merged.push(t);
    };

    for (const t of artistTracks) pushTrack(t);
    for (const t of rawTracks) pushTrack(t);

    const tracks = merged.slice(0, 15).map(normalizeTrack);
    console.log(`✅ Итог: ${tracks.length} треков (артист вперёд)`);
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
        roomName: s.roomName || 'test-room-1',
        searchMode: s.searchMode || 'artist' // 'artist' | 'tracks'
    };
});

ipcMain.handle('settings-save', async (_event, config) => {
    const prev = loadSettings();
    const ok = saveSettings({
        ...prev,
        ymToken: String(config.ymToken || ''),
        ymUid: String(config.ymUid || ''),
        signalingUrl: String(config.signalingUrl || 'ws://localhost:8080'),
        roomName: String(config.roomName || 'test-room-1'),
        searchMode: String(config.searchMode || 'artist')
    });
    if (ok) {
        apiPromise = null;
        console.log('✅ Настройки сохранены в', getSettingsPath());
        return { success: true };
    }
    return { success: false, error: 'Не смог записать файл' };
});

// --- OAuth Яндекс ---
const YANDEX_CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d';
const YANDEX_AUTH_URL = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${YANDEX_CLIENT_ID}`;

ipcMain.handle('oauth-login', async () => {
    return new Promise((resolve) => {
        const authWindow = new BrowserWindow({
            width: 800,
            height: 700,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true
            }
        });

        let resolved = false;

        function handleUrl(url) {
            if (resolved) return;
            if (url.includes('#access_token=')) {
                resolved = true;
                const params = new URLSearchParams(url.split('#')[1]);
                const accessToken = params.get('access_token');
                const expiresIn = params.get('expires_in');

                if (accessToken) {
                    console.log('✅ OAuth токен получен');
                    const s = loadSettings();
                    s.ymToken = accessToken;
                    saveSettings(s);
                    apiPromise = null;
                    resolve({ success: true, accessToken, expiresIn });
                } else {
                    resolve({ success: false, error: 'Токен не найден в URL' });
                }
                authWindow.close();
            }
        }

        authWindow.webContents.on('will-navigate', (_e, url) => handleUrl(url));
        authWindow.webContents.on('will-redirect', (_e, url) => handleUrl(url));

        authWindow.on('closed', () => {
            if (!resolved) resolve({ success: false, error: 'Окно авторизации закрыто' });
        });

        authWindow.loadURL(YANDEX_AUTH_URL);
    });
});

// =========================================================
// CUSTOM WINDOW CONTROLS
// =========================================================

ipcMain.on('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.minimize();
});

ipcMain.on('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.close();
});

ipcMain.handle('window-is-maximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return Boolean(win && !win.isDestroyed() && win.isMaximized());
});

ipcMain.handle('window-toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    if (!win || win.isDestroyed()) {
        return false;
    }

    if (win.isMaximized()) {
        win.unmaximize();
    } else {
        win.maximize();
    }

    return win.isMaximized();
});

// =========================================================
// MAIN WINDOW
// =========================================================

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 700,

        minWidth: 760,
        minHeight: 560,

        // Убираем стандартную рамку Windows
        frame: false,

        // Прозрачное native-окно. Фон рисует HTML/CSS.
        transparent: true,

        // Тень окна
        hasShadow: true,

        // Полностью прозрачный native background
        backgroundColor: '#00000000',

        // Убираем стандартное меню
        autoHideMenuBar: true,

        resizable: true,

        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadFile(path.join(__dirname, 'index.html'));

    // Показываем окно только когда renderer готов.
    win.once('ready-to-show', () => {
        win.show();
    });

    // Передаём renderer состояние maximize.
    win.on('maximize', () => {
        if (!win.isDestroyed()) {
            win.webContents.send('window-maximized-changed', true);
        }
    });

    win.on('unmaximize', () => {
        if (!win.isDestroyed()) {
            win.webContents.send('window-maximized-changed', false);
        }
    });

    return win;
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
