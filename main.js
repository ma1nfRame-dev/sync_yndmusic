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

function getYandexToken() {
    const s = loadSettings();
    return String(s.ymToken || process.env.YM_TOKEN || '').trim();
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

// --- Прямой HTTPS-запрос к Yandex Music API (для feedback) ---
const https = require('https');
const http = require('http');
const zlib = require('zlib');

const YM_API_HOST = 'api.music.yandex.net';

function ymApiPost(pathname, body) {
    return new Promise((resolve, reject) => {
        const token = getYandexToken();
        if (!token) return reject(new Error('Токен не настроен'));

        const data = JSON.stringify(body);
        const req = https.request({
            hostname: YM_API_HOST,
            path: pathname,
            method: 'POST',
            headers: {
                'Authorization': `OAuth ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'User-Agent': 'Yandex-Music-API'
            },
            timeout: 10000
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                try { parsed = JSON.parse(text); } catch (e) { }
                resolve({ status: res.statusCode, body: parsed || text });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.write(data);
        req.end();
    });
}

// --- Текст трека ---
let lyricsClientPromise = null;

async function getLyricsClient() {
    if (!lyricsClientPromise) {
        lyricsClientPromise = (async () => {
            const token = getYandexToken();
            if (!token) {
                throw new Error('Токен Яндекс.Музыки не настроен');
            }

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

    if (mode !== 'artist') {
        const tracks = rawTracks
            .filter(t => t.available !== false)
            .slice(0, 15)
            .map(normalizeTrack);
        console.log(`  → треков по названию: ${tracks.length}`);
        return tracks;
    }

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

    // Диагностика: покажем какие методы вообще есть в api.radio
    try {
        const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(api.radio)).filter(n => n !== 'constructor');
        const own = Object.getOwnPropertyNames(api.radio);
        console.log('📻 api.radio proto methods:', proto.join(', '));
        console.log('📻 api.radio own props:', own.join(', '));
    } catch (e) {
        console.log('📻 Не смог получить методы api.radio:', e.message);
    }

    const batch = await api.radio.postRotorSessionTracks(sessionId);
    const tracks = extractRotorTracks(batch);
    console.log(`📻 Волна запущена, треков: ${tracks.length}`);
    return { sessionId, tracks };
});

// --- Волна: следующая порция с фильтрацией ---
ipcMain.handle('radio-next', async (_event, sessionId, excludeIds = []) => {
    const { api } = await getApi();
    const exclude = new Set((excludeIds || []).map(String));
    console.log(`📻 Запрос порции: sessionId=${sessionId}, исключаем ${exclude.size} уже виденных`);

    const collected = [];
    const collectedIds = new Set();
    const TARGET = 5;
    const MAX_ATTEMPTS = 5;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const batch = await api.radio.postRotorSessionTracks(sessionId);
        const tracks = extractRotorTracks(batch);

        let fresh = 0;
        for (const t of tracks) {
            const id = String(t.id);
            if (!id) continue;
            if (exclude.has(id)) continue;
            if (collectedIds.has(id)) continue;
            collectedIds.add(id);
            collected.push(t);
            fresh++;
        }

        console.log(`📻 Попытка ${attempt}: получено ${tracks.length}, новых ${fresh}, всего набрано ${collected.length}`);

        if (collected.length >= TARGET) break;
    }

    console.log(`📻 Итог: ${collected.length} треков (после фильтрации)`);
    return collected;
});

// --- Волна: feedback (HTTP + fallback на yamd2) ---
const FEEDBACK_TYPE_MAP = {
    'start': 'trackStarted',
    'end': 'trackFinished',
    'skip': 'skip',
    'like': 'like',
    'dislike': 'dislike'
};

ipcMain.handle('radio-feedback', async (_event, sessionId, type, trackId) => {
    const sid = String(sessionId || '');
    const tid = String(trackId || '');
    if (!sid || !type || !tid) return { success: false, reason: 'bad-args' };

    const rotorType = FEEDBACK_TYPE_MAP[type] || type;

    // Вариант 1: POST /rotor/session/{sid}/feedback с body
    try {
        const res = await ymApiPost(
            `/rotor/session/${encodeURIComponent(sid)}/feedback`,
            { type: rotorType, trackId: tid }
        );
        if (res.status >= 200 && res.status < 300) {
            console.log(`📻 Feedback OK (http-session): ${rotorType}/${tid}`);
            return { success: true, via: 'http-session', status: res.status };
        }
        console.log(`📻 Feedback http-session вернул ${res.status}:`, JSON.stringify(res.body).slice(0, 200));
    } catch (e) {
        console.log(`📻 Feedback http-session error: ${e.message}`);
    }

    // Вариант 2: с query-параметрами
    try {
        const qs = new URLSearchParams({ type: rotorType, track_id: tid }).toString();
        const res = await ymApiPost(
            `/rotor/session/${encodeURIComponent(sid)}/feedback?${qs}`,
            {}
        );
        if (res.status >= 200 && res.status < 300) {
            console.log(`📻 Feedback OK (http-session-qs): ${rotorType}/${tid}`);
            return { success: true, via: 'http-session-qs', status: res.status };
        }
        console.log(`📻 Feedback http-session-qs вернул ${res.status}:`, JSON.stringify(res.body).slice(0, 200));
    } catch (e) {
        console.log(`📻 Feedback http-session-qs error: ${e.message}`);
    }

    // Вариант 3: yamd2 fallback — вдруг там всё-таки есть метод
    try {
        const { api } = await getApi();
        const methods = ['rotorSessionFeedback', 'postRotorSessionFeedback', 'rotorFeedback', 'feedback', 'sendFeedback'];
        for (const method of methods) {
            if (typeof api.radio?.[method] === 'function') {
                try {
                    await api.radio[method](sid, rotorType, tid);
                    console.log(`📻 Feedback OK (yamd2.${method}): ${rotorType}/${tid}`);
                    return { success: true, via: `yamd2.${method}` };
                } catch (e) {
                    console.log(`📻 Feedback (yamd2.${method}) упал: ${e.message}`);
                }
            }
        }
    } catch (e) {
        console.log(`📻 Feedback yamd2 fallback error: ${e.message}`);
    }

    console.log(`📻 Feedback не отправлен ни одним способом: ${rotorType}/${tid}`);
    return { success: false, reason: 'all-methods-failed' };
});

// --- Избранное ---
const LIKED_BATCH_SIZE = 100;
const LIKED_MAX_TRACKS = 300;

let likedCache = null;
let likedIdsCache = null;

async function fetchTracksOneByOne(api, ids) {
    const settled = await Promise.allSettled(ids.map(id => api.tracks.getSingleTrack(id)));
    return settled.filter(r => r.status === 'fulfilled').map(r => r.value);
}

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

    let lib;
    try {
        lib = await api.user.getLikedTracks(realUid);
    } catch (e) {
        throw wrapBindingError(e);
    }
    const metas = lib?.library?.tracks || [];
    const totalLiked = metas.length;

    likedIdsCache = new Set(metas.map(m => String(m.id)).filter(Boolean));

    if (!totalLiked) {
        console.log('❤️ Лайкнутых треков нет');
        likedCache = { tracks: [], totalLiked: 0, truncated: false, elapsedMs: Date.now() - started };
        return likedCache;
    }

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

// --- Лайк / дизлайк ---
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
    likedCache = null;
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
    likedCache = null;
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
        searchMode: s.searchMode || 'artist'
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
        likedCache = null;
        likedIdsCache = null;
        console.log('✅ Настройки сохранены в', getSettingsPath());
        return { success: true };
    }
    return { success: false, error: 'Не смог записать файл' };
});

// --- OAuth ---
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

// --- Custom window controls ---
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

// --- Main window ---
function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 700,
        minWidth: 760,
        minHeight: 560,
        frame: false,
        transparent: true,
        hasShadow: true,
        backgroundColor: '#00000000',
        autoHideMenuBar: true,
        resizable: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadFile(path.join(__dirname, 'index.html'));

    win.once('ready-to-show', () => {
        win.show();
    });

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