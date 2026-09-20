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

// --- Текст трека ---
//
// Важно: текущий backend Yandex Music требует для /tracks/{id}/lyrics
// дополнительные параметры timeStamp + sign (+ durationMs). Старый
// yamd2 вызывает этот endpoint только с format, поэтому API отвечает:
// "timeStamp: Parameter value is not set, sign: Parameter value is not set".
//
// Для lyrics используем отдельный актуальный клиент @dvxch/yandex-music,
// который формирует корректный запрос. Основной yamd2 при этом остаётся
// для поиска, радио и получения аудио.

let lyricsClientPromise = null;

function getYandexToken() {
    const s = loadSettings();
    return String(s.ymToken || process.env.YM_TOKEN || '').trim();
}

async function getLyricsClient() {
    if (!lyricsClientPromise) {
        lyricsClientPromise = (async () => {
            const token = getYandexToken();
            if (!token) {
                throw new Error('Токен Яндекс.Музыки не настроен');
            }

            // @dvxch/yandex-music — ESM-only пакет, поэтому в CommonJS
            // используем динамический import().
            const { Client } = await import('@dvxch/yandex-music');

            console.log('🎤 Инициализация отдельного клиента lyrics API');
            return new Client({
                token,
                language: 'ru',
                retries: 1
            });
        })();
    }

    return lyricsClientPromise;
}

const https = require('https');
const http = require('http');
const zlib = require('zlib');

function fetchTextUrl(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (!url) return reject(new Error('Пустая ссылка на текст'));
        if (redirects > 5) return reject(new Error('Слишком много перенаправлений'));

        let parsed;
        try {
            parsed = new URL(url);
        } catch (e) {
            reject(new Error('Некорректная ссылка на текст'));
            return;
        }

        const client = parsed.protocol === 'http:' ? http : https;
        const req = client.get(parsed, {
            headers: {
                'User-Agent': 'SyncPlayer/1.0',
                'Accept': 'text/plain, text/*, */*'
            },
            timeout: 15000
        }, (res) => {
            const status = Number(res.statusCode || 0);

            if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
                const nextUrl = new URL(res.headers.location, parsed).toString();
                res.resume();
                fetchTextUrl(nextUrl, redirects + 1).then(resolve).catch(reject);
                return;
            }

            if (status < 200 || status >= 300) {
                res.resume();
                reject(new Error(`Сервер текста вернул HTTP ${status}`));
                return;
            }

            let stream = res;
            const encoding = String(res.headers['content-encoding'] || '').toLowerCase();

            if (encoding.includes('gzip')) {
                stream = res.pipe(zlib.createGunzip());
            } else if (encoding.includes('deflate')) {
                stream = res.pipe(zlib.createInflate());
            } else if (encoding.includes('br') && zlib.createBrotliDecompress) {
                stream = res.pipe(zlib.createBrotliDecompress());
            }

            const chunks = [];
            stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            stream.on('error', reject);
        });

        req.on('timeout', () => req.destroy(new Error('Таймаут загрузки текста')));
        req.on('error', reject);
    });
}

function pickLyricsText(value, depth = 0) {
    if (!value || depth > 6) return null;

    if (typeof value === 'string') {
        return value.trim() ? value.trim() : null;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const found = pickLyricsText(item, depth + 1);
            if (found) return found;
        }
        return null;
    }

    if (typeof value !== 'object') return null;

    // В supplement Yandex могут встречаться разные формы lyrics.
    for (const key of [
        'fullLyrics',
        'lyrics',
        'text',
        'content',
        'fullText',
        'plainText'
    ]) {
        if (key in value) {
            const found = pickLyricsText(value[key], depth + 1);
            if (found) return found;
        }
    }

    return null;
}

function extractLyricsFromSupplement(supplement) {
    const roots = [
        supplement?.result?.lyrics,
        supplement?.lyrics,
        supplement?.result?.supplement?.lyrics,
        supplement?.supplement?.lyrics,
        supplement?.result?.track?.lyrics,
        supplement?.track?.lyrics
    ];

    for (const root of roots) {
        const text = pickLyricsText(root);
        if (text) return text;
    }

    return null;
}

async function fetchLyricsViaModernClient(id, format) {
    const client = await getLyricsClient();

    const lyrics = await client.tracksLyrics(id, format);
    if (!lyrics) return null;

    const text = await lyrics.fetchLyrics();
    if (!text || !String(text).trim()) return null;

    return {
        text: String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
        writers: Array.isArray(lyrics.writers) ? lyrics.writers : []
    };
}

ipcMain.handle('get-track-lyrics', async (_event, trackId) => {
    const id = String(trackId || '').trim();
    if (!id) return { available: false, synced: false };

    // 1) LRC — основной путь для караоке.
    try {
        const result = await fetchLyricsViaModernClient(id, 'LRC');

        if (result?.text) {
            console.log('🎤 LRC получен для трека', id);
            return {
                available: true,
                synced: true,
                format: 'lrc',
                text: result.text,
                writers: result.writers
            };
        }

        console.log(`  ℹ️ Для ${id} LRC не найден`);
    } catch (e) {
        console.log(`  ⚠️ LRC через современный клиент не сработал для ${id}: ${e.message}`);
    }

    // 2) TEXT — обычный текст как fallback.
    try {
        const result = await fetchLyricsViaModernClient(id, 'TEXT');

        if (result?.text) {
            console.log('🎤 TEXT получен для трека', id);
            return {
                available: true,
                synced: false,
                format: 'text',
                text: result.text,
                writers: result.writers
            };
        }

        console.log(`  ℹ️ Для ${id} TEXT не найден`);
    } catch (e) {
        console.log(`  ⚠️ TEXT через современный клиент не сработал для ${id}: ${e.message}`);
    }

    // 3) Последний fallback — supplement старого клиента.
    try {
        const { api } = await getApi();
        const supplement = await api.tracks.getTrackSupplement(id);
        const text = extractLyricsFromSupplement(supplement);

        if (text) {
            console.log('🎤 Текст получен из supplement для трека', id);
            return {
                available: true,
                synced: false,
                format: 'text',
                text
            };
        }
    } catch (e) {
        console.log(`  ⚠️ Supplement текста не сработал для ${id}: ${e.message}`);
    }

    return { available: false, synced: false };
});

// --- Нормализация трека ---
function normalizeTrack(t) {
    // у POST /tracks обложка иногда лежит только на уровне альбома
    const coverUri = t.coverUri || t.albums?.[0]?.coverUri || null;
    return {
        id: t.id || t.realId,
        title: t.title,
        version: t.version || null,
        artists: (t.artists || []).map(a => a.name).join(', '),
        album: t.albums?.[0]?.title || '',
        durationMs: t.durationMs || 0,
        cover: coverUri
            ? 'https://' + coverUri.replace('%%', '200x200')
            : null,
        lyricsAvailable: typeof t.lyricsAvailable === 'boolean'
            ? t.lyricsAvailable
            : (typeof t.lyricsInfo?.hasAvailableTextLyrics === 'boolean' || typeof t.lyricsInfo?.hasAvailableSyncLyrics === 'boolean')
                ? Boolean(t.lyricsInfo?.hasAvailableTextLyrics || t.lyricsInfo?.hasAvailableSyncLyrics)
                : null,
        textLyricsAvailable: typeof t.lyricsInfo?.hasAvailableTextLyrics === 'boolean'
            ? t.lyricsInfo.hasAvailableTextLyrics
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

// --- Избранное (лайкнутые треки) ---
const LIKED_BATCH_SIZE = 100;   // сколько треков тянем метаданными за один запрос
const LIKED_MAX_TRACKS = 300;   // потолок очереди: ~125 КБ JSON, чтобы playlist-update пролез в DataChannel

let likedCache = null;          // кэш полного списка (тянется по кнопке "Избранное")
let likedIdsCache = null;       // кэш id-шников для отметок "лайкнуто" в поиске/очереди (Set<string>)

// Фолбэк, если POST /tracks не примет батч — тянем поштучно
async function fetchTracksOneByOne(api, ids) {
    const settled = await Promise.allSettled(ids.map(id => api.tracks.getSingleTrack(id)));
    return settled.filter(r => r.status === 'fulfilled').map(r => r.value);
}

// uid из настроек может быть плейсхолдером ("1" и т.п.) и не совпадать
// с реальным владельцем токена — тогда любой /users/{uid}/... эндпоинт падает с
// "ownerOtherwiseUserBindingError: owner must have music sid".
// Поэтому везде, где нужен uid, берём настоящий из аккаунта, привязанного к токену.
async function resolveRealUid(api) {
    try {
        const status = await api.account.getAccountStatus();
        const uid = status?.account?.uid || null;
        if (uid) console.log('❤️ uid из аккаунта:', uid);
        return uid;
    } catch (e) {
        console.log(`❤️ Не смог получить account status (${e.message}), используем uid из настроек`);
        return null;
    }
}

function wrapBindingError(e) {
    if (String(e.message || '').includes('ownerOtherwiseUserBindingError')) {
        return new Error('UID не совпадает с владельцем токена. Проверь ⚙️ Настройки — там не должно быть "1" или другой заглушки.');
    }
    return e;
}

ipcMain.handle('get-liked-tracks', async (event, opts = {}) => {
    const force = !!opts.force;

    if (likedCache && !force) {
        console.log(`❤️ Отдаём из кэша: ${likedCache.tracks.length} треков`);
        return likedCache;
    }

    const started = Date.now();
    console.log('❤️ Загружаем избранное...');

    const { api } = await getApi();
    const realUid = await resolveRealUid(api);

    // GET /users/{uid}/likes/tracks — отдаёт ВЕСЬ список разом, но только {id, albumId, timestamp}
    let lib;
    try {
        lib = await api.user.getLikedTracks(realUid);
    } catch (e) {
        throw wrapBindingError(e);
    }
    const metas = lib?.library?.tracks || [];
    const totalLiked = metas.length;

    // Заодно обновляем кэш id-шников — он уже у нас в руках
    likedIdsCache = new Set(metas.map(m => String(m.id)).filter(Boolean));

    if (!totalLiked) {
        console.log('❤️ Лайкнутых треков нет');
        likedCache = { tracks: [], totalLiked: 0, truncated: false, elapsedMs: Date.now() - started };
        return likedCache;
    }

    // Берём самые свежие лайки — Яндекс отдаёт их первыми
    const ids = metas.slice(0, LIKED_MAX_TRACKS).map(m => String(m.id)).filter(Boolean);
    const truncated = totalLiked > ids.length;
    console.log(`❤️ Лайков всего: ${totalLiked}, берём: ${ids.length}${truncated ? ' (обрезано)' : ''}`);

    const tracks = [];

    for (let i = 0; i < ids.length; i += LIKED_BATCH_SIZE) {
        const batch = ids.slice(i, i + LIKED_BATCH_SIZE);
        let raw = [];

        try {
            raw = await api.tracks.getTracks(batch);
        } catch (e) {
            console.log(`❤️ Ошибка: батч ${i}–${i + batch.length} не загрузился (${e.message}), пробуем поштучно`);
            try {
                raw = await fetchTracksOneByOne(api, batch);
            } catch (e2) {
                console.log(`❤️ Ошибка: и поштучно не вышло (${e2.message}), пропускаем батч`);
                raw = [];
            }
        }

        for (const t of (raw || [])) {
            if (!t || t.available === false) continue;
            if (!(t.id || t.realId)) continue;
            tracks.push(normalizeTrack(t));
        }

        const loaded = Math.min(i + batch.length, ids.length);
        if (!event.sender.isDestroyed()) {
            event.sender.send('liked-progress', { loaded, total: ids.length });
        }
    }

    const elapsedMs = Date.now() - started;
    console.log(`❤️ Загружено ${tracks.length} треков за ${elapsedMs}мс`);

    likedCache = { tracks, totalLiked, truncated, elapsedMs };
    return likedCache;
});


// --- Лайк / дизлайк трека ---

// Лёгкий список id избранного — для отметок в поиске/очереди.
// force игнорируется намеренно: список маленький (одни id), тянуть его лишний
// раз недорого, а свежесть тут важнее кэша.
ipcMain.handle('get-liked-ids', async () => {
    try {
        const { api } = await getApi();
        const realUid = await resolveRealUid(api);
        const lib = await api.user.getLikedTracks(realUid);
        const metas = lib?.library?.tracks || [];
        likedIdsCache = new Set(metas.map(m => String(m.id)).filter(Boolean));
        return Array.from(likedIdsCache);
    } catch (e) {
        throw wrapBindingError(e);
    }
});

ipcMain.handle('like-track', async (_event, trackId) => {
    const id = String(trackId || '').trim();
    if (!id) throw new Error('Пустой ID трека');

    const { api } = await getApi();
    const realUid = await resolveRealUid(api);

    try {
        await api.user.likeTracks([id], realUid);
    } catch (e) {
        throw wrapBindingError(e);
    }

    if (likedIdsCache) likedIdsCache.add(id);
    likedCache = null; // полный список избранного теперь неактуален
    console.log('❤️ Лайкнут трек', id);
    return { success: true };
});

ipcMain.handle('unlike-track', async (_event, trackId) => {
    const id = String(trackId || '').trim();
    if (!id) throw new Error('Пустой ID трека');

    const { api } = await getApi();
    const realUid = await resolveRealUid(api);

    try {
        await api.user.unlikeTracks([id], realUid);
    } catch (e) {
        throw wrapBindingError(e);
    }

    if (likedIdsCache) likedIdsCache.delete(id);
    likedCache = null; // полный список избранного теперь неактуален
    console.log('💔 Убран лайк с трека', id);
    return { success: true };
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
        likedCache = null;    // токен/uid могли смениться — кэш избранного невалиден
        likedIdsCache = null;
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
                    likedCache = null;
                    likedIdsCache = null;
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