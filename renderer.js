const { ipcRenderer } = require('electron');

// --- Логгер ---
function logEvent(type, data = {}) {
    const entry = {
        t: Date.now(),
        iso: new Date().toISOString(),
        pid: 'renderer',
        type,
        ...data
    };
    try { console.log(`[${type}]`, data); } catch (e) { }
    try { ipcRenderer.send('log-write', entry); } catch (e) { }
}

let ROOM = 'test-room-1';
let SIGNALING_URL = 'ws://localhost:8080';
let SEARCH_MODE = 'artist'; // 'artist' | 'tracks'

// --- DOM ---
const statusEl = document.getElementById('status');
const trackTitleEl = document.getElementById('trackTitle');
const trackQueueEl = document.getElementById('trackQueue');
const trackArtworkEl = document.getElementById('trackArtwork');
const dynamicBackdropEl = document.getElementById('dynamicBackdrop');
const backdropAEl = document.getElementById('backdropA');
const backdropBEl = document.getElementById('backdropB');
let activeBackdrop = 'A';
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
const lyricsBtn = document.getElementById('lyricsBtn');
const lyricsPanel = document.getElementById('lyricsPanel');
const lyricsCloseBtn = document.getElementById('lyricsCloseBtn');
const lyricsStateEl = document.getElementById('lyricsState');
const lyricsContentEl = document.getElementById('lyricsContent');
const lyricsTrackNameEl = document.getElementById('lyricsTrackName');
const volumeRow = document.getElementById('volumeRow');
const volumeBar = document.getElementById('volumeBar');
const volumeLabel = document.getElementById('volumeLabel');
const muteBtn = document.getElementById('muteBtn');
const waveBtn = document.getElementById('waveBtn');
const likedBtn = document.getElementById('likedBtn');
const queuePanel = document.getElementById('queuePanel');
const queueList = document.getElementById('queueList');

const hostBadge = document.getElementById('hostBadge');
const transferHostBtn = document.getElementById('transferHostBtn');

const modeArtistBtn = document.getElementById('modeArtistBtn');
const modeTracksBtn = document.getElementById('modeTracksBtn');

const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');

// --- Custom window controls ---
const windowMinimizeBtn = document.getElementById('windowMinimizeBtn');
const windowMaximizeBtn = document.getElementById('windowMaximizeBtn');
const windowCloseBtn = document.getElementById('windowCloseBtn');
const titlebarDragArea = document.getElementById('titlebarDragArea');
const ymTokenInput = document.getElementById('ymTokenInput');
const ymUidInput = document.getElementById('ymUidInput');
const signalingUrlInput = document.getElementById('signalingUrlInput');
const roomNameInput = document.getElementById('roomNameInput');
const settingsSaveBtn = document.getElementById('settingsSaveBtn');
const settingsCancelBtn = document.getElementById('settingsCancelBtn');
const logBtn = document.getElementById('logBtn');
const oauthLoginBtn = document.getElementById('oauthLoginBtn');

// --- Аудио ---
const audio = new Audio();
audio.crossOrigin = 'anonymous';
let audioReady = false;
let isSeeking = false;
let isReloading = false;

// --- Состояние ---
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

// --- Плейлист ---
let playlist = [];
let playlistIndex = -1;
let playlistMode = null;
let waveSessionId = null;
let likedLoading = false;
let likedIds = new Set();   // id треков, лайкнутых в аккаунте (для сердечек в поиске/очереди)
let likedIdsPending = new Set(); // id, у которых сейчас в процессе лайк/дизлайк (блокировка повторного клика)
let likedTotal = 0;   // сколько всего лайков у хоста (для подписи "300 из 847")
let isLoadingNext = false;
let isAdvancing = false;
let isPlayCurrentBusy = false;
let currentTrackForLyrics = null;
let lyricsRequestId = 0;
let currentLyricsResult = null;
const remoteLyricsCache = new Map();

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        {
            urls: [
                'turn:turn.evan-brass.net',
                'turn:turn.evan-brass.net?transport=tcp',
                'turns:turn.evan-brass.net:443?transport=tcp'
            ],
            username: 'user',
            credential: 'password'
        }
    ]
};

// --- Утилиты ---
function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function snapshotState() {
    return {
        audioReady,
        isReloading,
        isAdvancing,
        isSeeking,
        isPlaying,
        paused: audio.paused,
        currentTime: Number(audio.currentTime.toFixed(3)),
        duration: Number((audio.duration || 0).toFixed(3)),
        playlistIndex,
        playlistLen: playlist.length,
        playlistMode,
        waveSessionId,
        isHost,
        dataChannelState: dataChannel ? dataChannel.readyState : 'none',
        wsState: ws ? ws.readyState : 'none',
        clockOffset: Number(clockOffset.toFixed(2)),
        searchMode: SEARCH_MODE
    };
}

function updateSearchModeUI() {
    if (SEARCH_MODE === 'artist') {
        modeArtistBtn.classList.add('active');
        modeTracksBtn.classList.remove('active');
    } else {
        modeTracksBtn.classList.add('active');
        modeArtistBtn.classList.remove('active');
    }
}

function setMaximizeButtonState(isMaximized) {
    if (!windowMaximizeBtn) return;

    windowMaximizeBtn.classList.toggle('is-maximized', Boolean(isMaximized));
    windowMaximizeBtn.textContent = '';
    windowMaximizeBtn.title = isMaximized ? 'Восстановить' : 'Развернуть';
    windowMaximizeBtn.setAttribute(
        'aria-label',
        isMaximized ? 'Восстановить размер' : 'Развернуть окно'
    );
}

ipcRenderer.on('window-maximized-changed', (_event, isMaximized) => {
    setMaximizeButtonState(Boolean(isMaximized));
});

async function syncMaximizeButtonState() {
    try {
        const isMaximized = await ipcRenderer.invoke('window-is-maximized');
        setMaximizeButtonState(Boolean(isMaximized));
    } catch (err) {
        logEvent('window:maximize-state:error', { error: err.message });
    }
}

async function toggleMaximizeWindow() {
    try {
        const isMaximized = await ipcRenderer.invoke('window-toggle-maximize');
        setMaximizeButtonState(Boolean(isMaximized));
    } catch (err) {
        logEvent('window:maximize:error', { error: err.message });
    }
}

if (windowMinimizeBtn) {
    windowMinimizeBtn.addEventListener('click', () => {
        ipcRenderer.send('window-minimize');
    });
}

if (windowMaximizeBtn) {
    windowMaximizeBtn.addEventListener('click', toggleMaximizeWindow);
}

if (windowCloseBtn) {
    windowCloseBtn.addEventListener('click', () => {
        ipcRenderer.send('window-close');
    });
}

if (titlebarDragArea) {
    titlebarDragArea.addEventListener('dblclick', (event) => {
        if (event.target.closest('button, input, a, select, textarea')) return;
        toggleMaximizeWindow();
    });
}


syncMaximizeButtonState();

function updateTrackProgressUI(currentTime = audio.currentTime) {
    if (!seekBar) return;

    const duration = Number(audio.duration) || 0;
    const position = Number(currentTime) || 0;
    const percent = duration > 0
        ? Math.max(0, Math.min(100, (position / duration) * 100))
        : 0;

    seekBar.style.setProperty('--progress', `${percent}%`);
    seekBar.value = duration > 0 ? Math.min(position, duration) : 0;

    if (timeCurrentEl) timeCurrentEl.textContent = formatTime(position);
    if (timeTotalEl && duration > 0) timeTotalEl.textContent = formatTime(duration);
}

function updatePlaybackUI(playing) {
    const isActuallyPlaying = Boolean(playing) && audioReady && !audio.paused;
    isPlaying = isActuallyPlaying;
    updateTrackProgressUI(audio.currentTime);

    playBtn.classList.toggle('active', isActuallyPlaying);
    pauseBtn.classList.toggle('active', !isActuallyPlaying && audioReady);
    playBtn.setAttribute('aria-pressed', isActuallyPlaying ? 'true' : 'false');
    pauseBtn.setAttribute('aria-pressed', !isActuallyPlaying && audioReady ? 'true' : 'false');

    playBtn.title = isActuallyPlaying ? 'Играет' : 'Воспроизвести';
    pauseBtn.title = !isActuallyPlaying && audioReady ? 'Пауза' : 'Поставить на паузу';
}

function updateCurrentTrackArtwork(track) {
    const cover = track?.cover || '';

    if (trackArtworkEl) {
        if (!cover) {
            trackArtworkEl.removeAttribute('src');
            trackArtworkEl.classList.remove('has-cover');
        } else {
            trackArtworkEl.onload = () => trackArtworkEl.classList.add('has-cover');
            trackArtworkEl.onerror = () => {
                trackArtworkEl.classList.remove('has-cover');
                trackArtworkEl.removeAttribute('src');
            };
            trackArtworkEl.src = cover;
        }
    }

    updateDynamicBackdrop(cover);
}

function updateDynamicBackdrop(cover) {
    if (!dynamicBackdropEl || !backdropAEl || !backdropBEl) return;

    if (!cover) {
        backdropAEl.classList.remove('active');
        backdropBEl.classList.remove('active');
        backdropAEl.classList.add('fade');
        backdropBEl.classList.add('fade');
        dynamicBackdropEl.classList.remove('has-track');
        return;
    }

    const next = activeBackdrop === 'A' ? backdropBEl : backdropAEl;
    const current = activeBackdrop === 'A' ? backdropAEl : backdropBEl;

    next.onload = () => {
        next.classList.remove('fade');
        next.classList.add('active');
        current.classList.remove('active');
        current.classList.add('fade');
        activeBackdrop = activeBackdrop === 'A' ? 'B' : 'A';
        dynamicBackdropEl.classList.add('has-track');
    };

    next.onerror = () => {
        next.classList.remove('active');
        next.classList.add('fade');
    };

    next.src = cover;
}

// --- UI обновление по роли ---
function updateUIForRole() {
    const hostOnlyControls = [playBtn, pauseBtn, prevBtn, nextBtn];

    hostOnlyControls.forEach((btn) => {
        if (!btn) return;
        btn.classList.toggle('hostOnlyControl', !isHost);
        btn.setAttribute('aria-hidden', isHost ? 'false' : 'true');
    });

    if (isHost) {
        hostBadge.textContent = '👑 Хост';
        hostBadge.style.color = '#1e88e5';
        searchRow.classList.add('visible');
        playRow.classList.add('visible');
        playRow.classList.remove('listener-mode');
        transferHostBtn.style.display = 'inline-block';
        queuePanel.classList.remove('readonly');
        if (audioReady) seekBar.disabled = false;
    } else {
        hostBadge.textContent = '🎧 Слушатель';
        hostBadge.style.color = '#888';
        searchRow.classList.remove('visible');
        playRow.classList.toggle('visible', Boolean(currentTrackForLyrics));
        playRow.classList.add('listener-mode');
        transferHostBtn.style.display = 'none';
        queuePanel.classList.add('readonly');
        seekBar.disabled = true;
    }

    // На стороне слушателя строка управления остаётся только ради кнопки текста.
    setLyricsButtonVisible(Boolean(currentTrackForLyrics));
    logEvent('ui:role-updated', { isHost, role });
}

// --- WebSocket ---
function initWebSocket() {
    logEvent('ws:init', { url: SIGNALING_URL, room: ROOM });
    ws = new WebSocket(SIGNALING_URL);

    ws.onopen = () => {
        logEvent('ws:open', { url: SIGNALING_URL });
        statusEl.textContent = 'Подключено к signaling, ждём партнёра...';
        const joinMsg = { type: 'join', room: ROOM };
        ws.send(JSON.stringify(joinMsg));
        logEvent('ws:send', { msg: joinMsg });
    };

    ws.onerror = (e) => {
        logEvent('ws:error', { message: e.message || 'unknown' });
        statusEl.textContent = 'Ошибка подключения к signaling-серверу';
    };

    ws.onclose = (e) => {
        logEvent('ws:close', { code: e.code, reason: e.reason });
    };

    ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        logEvent('ws:recv', { msg: { type: msg.type, role: msg.role, hasSdp: !!msg.sdp, hasCandidate: !!msg.candidate } });

        if (msg.type === 'role') {
            role = msg.role;
            isHost = role === 'offerer';
            updateUIForRole();
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
                logEvent('ws:send', { msg: { type: 'offer' } });
            }
            return;
        }

        if (msg.type === 'offer') {
            await pc.setRemoteDescription(msg.sdp);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: 'answer', sdp: answer }));
            logEvent('ws:send', { msg: { type: 'answer' } });
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
}

function createPeerConnection() {
    pc = new RTCPeerConnection(rtcConfig);

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({ type: 'ice', candidate: event.candidate }));
            logEvent('ws:send', { msg: { type: 'ice', candidateType: event.candidate.type } });
        } else {
            logEvent('ice:end-of-candidates');
        }
    };

    pc.oniceconnectionstatechange = () => logEvent('pc:iceConnectionState', { state: pc.iceConnectionState });
    pc.onconnectionstatechange = () => logEvent('pc:connectionState', { state: pc.connectionState });
    pc.onsignalingstatechange = () => logEvent('pc:signalingState', { state: pc.signalingState });

    pc.ondatachannel = (event) => {
        dataChannel = event.channel;
        setupDataChannel();
    };
}

function setupDataChannel() {
    logEvent('dc:setup', { label: dataChannel.label });

    dataChannel.onopen = () => {
        logEvent('dc:open', { state: dataChannel.readyState });
        statusEl.textContent = 'P2P установлен, замеряем пинг...';
        updateUIForRole();
        runClockSync();
        setInterval(runClockSync, RESYNC_INTERVAL_MS);

        if (isHost) {
            const track = playlist[playlistIndex] || currentTrackForLyrics;
            if (track?.id) {
                void fetchLyricsForHost(track);
            }
        }
    };

    dataChannel.onclose = () => logEvent('dc:close', { state: dataChannel.readyState });
    dataChannel.onerror = (e) => logEvent('dc:error', { message: e.message || 'unknown' });

    dataChannel.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); }
        catch (e) { logEvent('dc:recv:parse-error', { raw: event.data }); return; }

        if (msg.type === 'ping' || msg.type === 'pong') {
            logEvent('dc:recv', { type: msg.type, t0: msg.t0, t1: msg.t1, t2: msg.t2 });
        } else {
            logEvent('dc:recv', { msg });
        }
        handleMessage(msg);
    };
}

function dcSend(msg) {
    if (!dataChannel || dataChannel.readyState !== 'open') {
        logEvent('dc:send:SKIPPED', { reason: 'not open', state: dataChannel ? dataChannel.readyState : 'none', msg });
        return false;
    }
    dataChannel.send(JSON.stringify(msg));
    return true;
}

// --- Синхронизация плейлиста ---
function broadcastPlaylist() {
    if (!isHost) return;
    dcSend({
        type: 'playlist-update',
        playlist,
        playlistIndex,
        playlistMode,
        waveSessionId
    });
}

// --- Поиск ---
async function doSearch() {
    const query = searchInput.value.trim();
    if (!query) return;

    logEvent('ui:search', { query, mode: SEARCH_MODE });
    searchResultsEl.innerHTML = '<div class="searchHint">Поиск...</div>';
    searchResultsEl.classList.add('visible');

    try {
        const tracks = await ipcRenderer.invoke('search-tracks', query, SEARCH_MODE);
        renderResults(tracks);
    } catch (err) {
        logEvent('ui:search:error', { error: err.message });
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

        item.appendChild(makeLikeButton(t.id));

        item.addEventListener('click', () => pickTrackFromSearch(tracks, idx));
        searchResultsEl.appendChild(item);
    });
}

async function pickTrackFromSearch(results, index) {
    logEvent('ui:pickTrackFromSearch', { index, total: results.length, track: results[index] });
    playlist = results.slice();
    playlistIndex = index;
    playlistMode = 'search';
    waveSessionId = null;
    updateQueueLabel();

    searchResultsEl.classList.remove('visible');
    await playCurrent('search-pick');
}

// --- Волна ---
async function startWave() {
    try {
        logEvent('ui:startWave');
        statusEl.textContent = '📻 Запускаем Волну...';
        searchResultsEl.classList.remove('visible');

        const { sessionId, tracks } = await ipcRenderer.invoke('radio-start');
        logEvent('wave:started', { sessionId, tracksLen: tracks.length });
        if (!tracks.length) {
            statusEl.textContent = '📻 Волна пустая, попробуй ещё раз';
            return;
        }

        playlist = tracks.slice();
        playlistIndex = 0;
        playlistMode = 'wave';
        waveSessionId = sessionId;
        updateQueueLabel();

        await playCurrent('wave-start');
    } catch (err) {
        logEvent('wave:start:error', { error: err.message });
        statusEl.textContent = '📻 Ошибка Волны: ' + err.message;
    }
}

async function fetchMoreWave() {
    if (isLoadingNext) return false;
    if (playlistMode !== 'wave' || !waveSessionId) return false;
    isLoadingNext = true;
    logEvent('wave:fetchMore:start', { waveSessionId, currentLen: playlist.length });
    try {
        statusEl.textContent = '📻 Загружаем следующую порцию...';
        const more = await ipcRenderer.invoke('radio-next', waveSessionId);
        if (!more.length) {
            logEvent('wave:fetchMore:empty');
            statusEl.textContent = '📻 Волна не вернула треков';
            return false;
        }
        playlist = playlist.concat(more);
        updateQueueLabel();
        broadcastPlaylist();
        logEvent('wave:fetchMore:done', { added: more.length, total: playlist.length });
        return true;
    } catch (err) {
        logEvent('wave:fetchMore:error', { error: err.message });
        statusEl.textContent = '📻 Ошибка: ' + err.message;
        return false;
    } finally {
        isLoadingNext = false;
    }
}

// --- Лайк / дизлайк отдельного трека (независимо от хоста и синка) ---
async function fetchLikedIds() {
    try {
        const ids = await ipcRenderer.invoke('get-liked-ids');
        likedIds = new Set((ids || []).map(String));
        logEvent('liked-ids:loaded', { count: likedIds.size });
        refreshLikeButtons();
    } catch (err) {
        logEvent('liked-ids:error', { error: err.message });
    }
}

function refreshLikeButtons() {
    document.querySelectorAll('.trackLikeBtn').forEach((btn) => {
        const id = btn.dataset.trackId;
        setLikeButtonState(btn, likedIds.has(id));
    });
}

function setLikeButtonState(btn, isLiked) {
    btn.textContent = isLiked ? '❤️' : '🤍';
    btn.classList.toggle('liked', isLiked);
    btn.title = isLiked ? 'Убрать из избранного' : 'Добавить в избранное';
    btn.setAttribute('aria-pressed', String(isLiked));
}

function makeLikeButton(trackId) {
    const id = String(trackId || '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'trackLikeBtn';
    btn.dataset.trackId = id;
    setLikeButtonState(btn, likedIds.has(id));

    btn.addEventListener('click', (e) => {
        e.stopPropagation(); // не должно триггерить клик по всему пункту (play/jump)
        toggleLike(id, btn);
    });

    return btn;
}

async function toggleLike(trackId, btn) {
    const id = String(trackId || '');
    if (!id || likedIdsPending.has(id)) return;

    const wasLiked = likedIds.has(id);
    likedIdsPending.add(id);
    if (btn) btn.disabled = true;

    // Оптимистично обновляем сразу все кнопки этого трека (он может быть
    // одновременно в поиске и в очереди)
    likedIds[wasLiked ? 'delete' : 'add'](id);
    refreshLikeButtons();

    try {
        logEvent('ui:toggleLike', { trackId: id, wasLiked });
        await ipcRenderer.invoke(wasLiked ? 'unlike-track' : 'like-track', id);
        logEvent('liked:toggled', { trackId: id, liked: !wasLiked });
    } catch (err) {
        logEvent('liked:toggle-error', { trackId: id, error: err.message });
        // откатываем оптимистичное изменение
        likedIds[wasLiked ? 'add' : 'delete'](id);
        refreshLikeButtons();
        statusEl.textContent = '❤️ Ошибка: ' + err.message;
    } finally {
        likedIdsPending.delete(id);
        if (btn) btn.disabled = false;
    }
}

// --- Избранное ---
async function startLiked(force = false) {
    if (!isHost) {
        logEvent('liked:blocked', { reason: 'not host' });
        statusEl.textContent = '❤️ Избранное может включить только хост';
        return;
    }
    if (likedLoading) return;

    likedLoading = true;
    likedBtn.disabled = true;
    const started = Date.now();

    try {
        logEvent('ui:startLiked', { force });
        statusEl.textContent = force ? '❤️ Обновляем избранное...' : '❤️ Загружаем избранное...';
        searchResultsEl.classList.remove('visible');

        const res = await ipcRenderer.invoke('get-liked-tracks', { force });
        const tracks = res?.tracks || [];
        const totalLiked = res?.totalLiked || 0;

        logEvent('liked:loaded', {
            tracksLen: tracks.length,
            totalLiked,
            truncated: !!res?.truncated,
            mainMs: res?.elapsedMs,
            elapsedMs: Date.now() - started
        });

        if (!totalLiked) {
            statusEl.textContent = '❤️ У тебя нет лайкнутых треков';
            return;
        }
        if (!tracks.length) {
            statusEl.textContent = '❤️ Лайки есть, но ни один трек сейчас недоступен';
            return;
        }

        likedTotal = totalLiked;
        playlist = tracks.slice();
        playlistIndex = 0;
        playlistMode = 'liked';
        waveSessionId = null;
        tracks.forEach(t => likedIds.add(String(t.id)));
        updateQueueLabel();

        await playCurrent('liked-start');
    } catch (err) {
        logEvent('liked:error', { error: err.message });
        statusEl.textContent = '❤️ Ошибка: ' + err.message;
    } finally {
        likedLoading = false;
        likedBtn.disabled = false;
    }
}

// Прогресс загрузки избранного из main
ipcRenderer.on('liked-progress', (_e, p) => {
    if (!likedLoading) return;
    statusEl.textContent = `❤️ Загружаем избранное: ${p.loaded}/${p.total}...`;
});

// --- Воспроизведение ---
async function playCurrent(caller = 'unknown') {
    if (isPlayCurrentBusy) {
        logEvent('playCurrent:blocked', { caller });
        return;
    }
    isPlayCurrentBusy = true;
    try {
        const track = playlist[playlistIndex];
        logEvent('playCurrent', { caller, playlistIndex, track: track ? { id: track.id, title: track.title } : null, state: snapshotState() });
        if (!track) return;

        broadcastPlaylist();
        dcSend({ type: 'load', track });
        await loadTrack(track, caller);
        updateQueueLabel();

        if (isHost) {
            // Подтягиваем lyrics на стороне хоста заранее и отправляем их слушателю.
            // Музыка при этом не ждёт окончания запроса lyrics.
            void fetchLyricsForHost(track);
            setTimeout(() => sendCommand('play', 0, 'autoplay-after-load'), 1500);
        }
    } finally {
        setTimeout(() => { isPlayCurrentBusy = false; }, 500);
    }
}

async function nextTrack(caller = 'unknown') {
    logEvent('nextTrack:enter', { caller, isHost, isAdvancing, state: snapshotState() });
    if (!isHost) return;
    if (playlist.length === 0) return;
    if (isAdvancing) {
        logEvent('nextTrack:blocked', { reason: 'isAdvancing' });
        return;
    }
    isAdvancing = true;
    try {
        if (playlistIndex + 1 < playlist.length) {
            playlistIndex++;
            await playCurrent('next:' + caller);
            return;
        }

        if (playlistMode === 'wave') {
            const ok = await fetchMoreWave();
            if (ok && playlistIndex + 1 < playlist.length) {
                playlistIndex++;
                await playCurrent('next:wave-extend:' + caller);
            }
        } else {
            logEvent('nextTrack:end-of-playlist');
            statusEl.textContent = 'Это последний трек в плейлисте';
        }
    } finally {
        setTimeout(() => { isAdvancing = false; }, 800);
    }
}

async function prevTrack(caller = 'unknown') {
    logEvent('prevTrack:enter', { caller, state: snapshotState() });
    if (!isHost) return;
    if (playlist.length === 0) return;
    if (playlistIndex - 1 < 0) {
        sendCommand('seek', 0, 'prev-restart');
        return;
    }
    playlistIndex--;
    await playCurrent('prev:' + caller);
}

function setLyricsButtonVisible(visible) {
    if (!lyricsBtn) return;
    lyricsBtn.hidden = !visible;
    if (!visible) lyricsBtn.classList.remove('active');

    if (!isHost) {
        playRow.classList.toggle('visible', Boolean(visible));
        playRow.classList.toggle('listener-mode', Boolean(visible));
    }
}

function closeLyricsPanel() {
    if (!lyricsPanel) return;
    lyricsPanel.hidden = true;
    lyricsBtn?.classList.remove('active');
    document.body.classList.remove('lyrics-open');
}

function setLyricsState(text, type = '') {
    if (!lyricsStateEl) return;
    lyricsStateEl.textContent = text;
    lyricsStateEl.className = 'lyricsState' + (type ? ` ${type}` : '');
}

let karaokeLines = [];
let karaokeActiveIndex = -1;
let karaokeSynced = false;
let karaokeReady = false;

function resetKaraoke() {
    karaokeLines = [];
    karaokeActiveIndex = -1;
    karaokeSynced = false;
    karaokeReady = false;
    if (lyricsContentEl) lyricsContentEl.innerHTML = '';
}

function parseTimeTag(mm, ss) {
    const minutes = Number(mm);
    const seconds = Number(ss);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
    return minutes * 60 + seconds;
}

function parseLrc(lrcText) {
    const lines = [];
    const input = String(lrcText || '').replace(/\r/g, '').split('\n');

    for (const rawLine of input) {
        if (!rawLine.trim()) continue;

        const tags = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d+)?)\]/g)];
        if (!tags.length) continue;

        const firstTagEnd = tags.at(-1).index + tags.at(-1)[0].length;
        let lineText = rawLine.slice(firstTagEnd).trim();

        const wordRegex = /<(\d{1,3}):(\d{2}(?:\.\d+)?)>/g;
        const wordTags = [...lineText.matchAll(wordRegex)];
        let words = [];

        if (wordTags.length) {
            words = wordTags.map((tag, i) => {
                const start = parseTimeTag(tag[1], tag[2]);
                const from = tag.index + tag[0].length;
                const to = i + 1 < wordTags.length ? wordTags[i + 1].index : lineText.length;
                return {
                    start,
                    text: lineText.slice(from, to).trim()
                };
            }).filter(word => Number.isFinite(word.start) && word.text);

            lineText = words.map(word => word.text).join(' ');
        }

        for (const tag of tags) {
            const start = parseTimeTag(tag[1], tag[2]);
            if (!Number.isFinite(start)) continue;

            lines.push({
                start,
                text: lineText || '♪',
                words: words.map(word => ({ ...word }))
            });
        }
    }

    lines.sort((a, b) => a.start - b.start);
    return lines;
}

function renderPlainLyrics(text) {
    resetKaraoke();

    const lines = String(text || '').split(/\n+/).map(line => line.trim()).filter(Boolean);
    karaokeLines = lines.map((text, index) => ({
        start: index,
        text,
        words: []
    }));

    karaokeSynced = false;
    karaokeReady = lines.length > 0;

    if (!lyricsContentEl) return;

    const fragment = document.createDocumentFragment();
    karaokeLines.forEach((line, index) => {
        const el = document.createElement('div');
        el.className = 'karaokeLine plainLine';
        el.dataset.index = String(index);
        el.textContent = line.text;
        fragment.appendChild(el);
    });

    lyricsContentEl.appendChild(fragment);
}

function renderKaraokeLyrics(lrcText) {
    resetKaraoke();

    karaokeLines = parseLrc(lrcText);
    karaokeSynced = karaokeLines.length > 0;
    karaokeReady = karaokeLines.length > 0;

    if (!lyricsContentEl) return;

    const fragment = document.createDocumentFragment();

    karaokeLines.forEach((line, index) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'karaokeLine';
        el.dataset.index = String(index);
        el.dataset.start = String(line.start);
        el.setAttribute('role', 'option');
        el.setAttribute('aria-label', line.text);

        if (line.words?.length) {
            line.words.forEach((word, wordIndex) => {
                const span = document.createElement('span');
                span.className = 'karaokeWord';
                span.dataset.wordIndex = String(wordIndex);
                span.dataset.start = String(word.start);
                span.textContent = word.text + (wordIndex < line.words.length - 1 ? ' ' : '');
                el.appendChild(span);
            });
        } else {
            el.textContent = line.text;
        }

        el.addEventListener('click', () => {
            if (!isHost || !audioReady) return;
            sendCommand('seek', line.start, 'lyrics-line');
        });

        fragment.appendChild(el);
    });

    lyricsContentEl.appendChild(fragment);
}

function updateKaraokeUI(currentTime = audio.currentTime) {
    if (!karaokeReady || !lyricsContentEl) return;

    if (!karaokeSynced) return;

    let active = -1;
    for (let i = 0; i < karaokeLines.length; i++) {
        if (karaokeLines[i].start <= currentTime + 0.02) active = i;
        else break;
    }

    if (active < 0) {
        if (karaokeActiveIndex !== -1) karaokeActiveIndex = -1;
        return;
    }

    if (active !== karaokeActiveIndex) {
        const previous = karaokeActiveIndex;
        karaokeActiveIndex = active;

        if (previous >= 0) {
            const prevEl = lyricsContentEl.querySelector(`.karaokeLine[data-index="${previous}"]`);
            prevEl?.classList.remove('active');
        }

        const activeEl = lyricsContentEl.querySelector(`.karaokeLine[data-index="${active}"]`);
        activeEl?.classList.add('active');

        const previousEl = active > 0
            ? lyricsContentEl.querySelector(`.karaokeLine[data-index="${active - 1}"]`)
            : null;
        previousEl?.classList.add('past');

        if (active > 1) {
            const oldEl = lyricsContentEl.querySelector(`.karaokeLine[data-index="${active - 2}"]`);
            oldEl?.classList.remove('past');
            oldEl?.classList.add('faded');
        }

        if (activeEl) {
            activeEl.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
        }
    }

    const line = karaokeLines[active];
    const lineEl = lyricsContentEl.querySelector(`.karaokeLine[data-index="${active}"]`);
    if (!lineEl || !line.words?.length) return;

    const words = [...lineEl.querySelectorAll('.karaokeWord')];
    words.forEach((wordEl, index) => {
        const start = line.words[index]?.start ?? line.start;
        const nextStart = line.words[index + 1]?.start ?? Infinity;
        wordEl.classList.toggle('sung', currentTime >= start);
        wordEl.classList.toggle('singing', currentTime >= start && currentTime < nextStart);
    });
}

function resetLyricsForTrack(track) {
    currentTrackForLyrics = track || null;
    currentLyricsResult = null;
    lyricsRequestId++;
    resetKaraoke();

    if (lyricsTrackNameEl) {
        lyricsTrackNameEl.textContent = track
            ? `${track.artists || ''} — ${track.title || ''}`.replace(/^\s*—\s*|\s*—\s*$/g, '')
            : '—';
    }

    closeLyricsPanel();
    setLyricsState('Нажми «Текст», чтобы открыть караоке.', '');
    setLyricsButtonVisible(Boolean(track));
}

function applyLyricsResult(result, { preservePanel = true } = {}) {
    currentLyricsResult = result || null;

    if (!result?.available || !result.text?.trim()) {
        setLyricsState('У этого трека нет доступного текста в Яндекс Музыке.', 'error');
        return false;
    }

    if (result.synced || result.format === 'lrc') {
        renderKaraokeLyrics(result.text);

        if (karaokeReady) {
            setLyricsState('Караоке', 'success');
            updateKaraokeUI(audio.currentTime);
        } else {
            renderPlainLyrics(result.text);
            setLyricsState('Синхронизированный текст недоступен, показан обычный текст.', '');
        }
    } else {
        renderPlainLyrics(result.text);
        setLyricsState('Синхронизация текста недоступна — показан обычный текст.', '');
    }

    return true;
}

async function fetchLyricsForHost(track) {
    if (!isHost || !track?.id) return null;

    const key = String(track.id);
    if (remoteLyricsCache.has(key)) {
        const cached = remoteLyricsCache.get(key);
        dcSend({ type: 'lyrics-update', trackId: key, result: cached });
        return cached;
    }

    try {
        const result = await ipcRenderer.invoke('get-track-lyrics', track.id);
        const normalizedResult = result || { available: false, synced: false };
        remoteLyricsCache.set(key, normalizedResult);

        if (currentTrackForLyrics?.id && String(currentTrackForLyrics.id) === key) {
            currentLyricsResult = normalizedResult;
        }

        dcSend({
            type: 'lyrics-update',
            trackId: key,
            result: normalizedResult
        });

        logEvent('lyrics:broadcast', { trackId: key, available: Boolean(normalizedResult?.available), synced: Boolean(normalizedResult?.synced) });
        return normalizedResult;
    } catch (err) {
        const result = {
            available: false,
            synced: false,
            error: err.message
        };

        remoteLyricsCache.set(key, result);
        dcSend({ type: 'lyrics-update', trackId: key, result });
        logEvent('lyrics:host-fetch:error', { trackId: key, error: err.message });
        return result;
    }
}

function sendLyricsRequestToHost(track) {
    if (!track?.id) return false;

    const sent = dcSend({
        type: 'lyrics-request',
        trackId: String(track.id)
    });

    if (sent) {
        logEvent('lyrics:request-sent', { trackId: String(track.id) });
    }

    return sent;
}

async function openLyricsForCurrentTrack() {
    const track = currentTrackForLyrics;
    if (!track?.id || !lyricsBtn || !lyricsPanel) return;

    const requestId = ++lyricsRequestId;
    lyricsBtn.classList.add('active');
    lyricsPanel.hidden = false;
    document.body.classList.add('lyrics-open');

    if (lyricsTrackNameEl) {
        lyricsTrackNameEl.textContent = `${track.artists || ''} — ${track.title || ''}`.replace(/^\s*—\s*|\s*—\s*$/g, '');
    }

    if (lyricsContentEl) lyricsContentEl.innerHTML = '';

    const cached = remoteLyricsCache.get(String(track.id));

    // Хост берёт текст из своего main-процесса.
    // Слушатель сначала использует то, что ему прислал хост.
    if (cached) {
        applyLyricsResult(cached);
        return;
    }

    if (!isHost) {
        setLyricsState('Запрашиваем караоке у хоста…');
        sendLyricsRequestToHost(track);
        return;
    }

    setLyricsState('Загружаем караоке…');

    try {
        const result = await fetchLyricsForHost(track);

        if (requestId !== lyricsRequestId || currentTrackForLyrics?.id !== track.id) return;

        applyLyricsResult(result);
    } catch (err) {
        logEvent('lyrics:load:error', { trackId: track.id, error: err.message });
        if (requestId !== lyricsRequestId || currentTrackForLyrics?.id !== track.id) return;
        setLyricsState('Не удалось получить текст: ' + err.message, 'error');
    }
}

if (lyricsBtn) {
    lyricsBtn.addEventListener('click', openLyricsForCurrentTrack);
}

if (lyricsCloseBtn) {
    lyricsCloseBtn.addEventListener('click', closeLyricsPanel);
}

if (lyricsPanel) {
    lyricsPanel.addEventListener('click', (event) => {
        if (event.target === lyricsPanel) closeLyricsPanel();
    });
}

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && lyricsPanel && !lyricsPanel.hidden) {
        event.preventDefault();
        closeLyricsPanel();
    }
});

async function loadTrack(track, caller = 'unknown') {
    isReloading = true;
    logEvent('loadTrack:start', { caller, track: { id: track.id, title: track.title, artists: track.artists } });
    try {
        audioReady = false;
        seekBar.disabled = true;
        audio.pause();
        updatePlaybackUI(false);
        updateCurrentTrackArtwork(track);
        resetLyricsForTrack(track);
        if (seekBar) {
            seekBar.style.setProperty('--progress', '0%');
            seekBar.value = 0;
        }

        statusEl.textContent = 'Загружаем трек...';
        trackTitleEl.textContent = `Загрузка: ${track.artists} — ${track.title}`;

        const directUrl = await ipcRenderer.invoke('get-audio-url', track.id);
        logEvent('loadTrack:got-url', { trackId: track.id, urlHead: String(directUrl).slice(0, 80) });
        audio.src = directUrl;

        await new Promise((resolve, reject) => {
            const onReady = () => { cleanup(); resolve(); };
            const onError = () => { cleanup(); reject(new Error('audio error: ' + (audio.error?.code || 'unknown'))); };
            const cleanup = () => {
                audio.removeEventListener('canplaythrough', onReady);
                audio.removeEventListener('error', onError);
            };
            audio.addEventListener('canplaythrough', onReady, { once: true });
            audio.addEventListener('error', onError, { once: true });
            audio.load();
        });

        audioReady = true;
        logEvent('loadTrack:ready', { duration: audio.duration, currentTime: audio.currentTime });

        trackTitleEl.textContent = `${track.artists} — ${track.title} • ${formatTime(audio.duration)}`;

        seekBar.max = audio.duration;
        seekBar.disabled = !isHost;
        updateTrackProgressUI(0);
        seekRow.classList.add('visible');
        volumeRow.style.display = 'flex';

        document.title = `${track.artists} — ${track.title} | Sync Player`;
        statusEl.textContent = playlistMode === 'wave'
            ? '📻 Волна играет'
            : (playlistMode === 'liked' ? '❤️ Избранное играет' : 'Трек готов');
    } catch (err) {
        logEvent('loadTrack:error', { error: err.message });
        statusEl.textContent = 'Ошибка загрузки: ' + err.message;
        trackTitleEl.textContent = 'Не удалось загрузить';
        setLyricsButtonVisible(false);
        closeLyricsPanel();
    } finally {
        setTimeout(() => {
            isReloading = false;
            logEvent('loadTrack:isReloading-clear');
        }, 500);
    }
}

// --- Сеть ---
function handleMessage(msg) {
    if (msg.type === 'ping') {
        const t1 = Date.now();
        dcSend({ type: 'pong', t0: msg.t0, t1, t2: Date.now() });
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
        logEvent('handle:command', { action: msg.action, position: msg.position, scheduledAt: msg.scheduledAt, now: Date.now(), clockOffset });
        scheduleCommand(msg.action, msg.position, msg.scheduledAt);
        return;
    }

    if (msg.type === 'load') {
        logEvent('handle:load', { track: msg.track });
        loadTrack(msg.track, 'remote-load');
        return;
    }

    if (msg.type === 'playlist-update') {
        logEvent('handle:playlist-update', { len: msg.playlist?.length, idx: msg.playlistIndex, mode: msg.playlistMode });
        playlist = msg.playlist || [];
        playlistIndex = msg.playlistIndex ?? -1;
        playlistMode = msg.playlistMode || null;
        waveSessionId = msg.waveSessionId || null;
        updateQueueLabel();
        return;
    }

    if (msg.type === 'lyrics-update') {
        const trackId = String(msg.trackId || '');
        if (!trackId) return;

        const result = msg.result || { available: false, synced: false };
        remoteLyricsCache.set(trackId, result);

        logEvent('handle:lyrics-update', {
            trackId,
            available: Boolean(result.available),
            synced: Boolean(result.synced)
        });

        if (currentTrackForLyrics?.id && String(currentTrackForLyrics.id) === trackId) {
            currentLyricsResult = result;
            if (!lyricsPanel.hidden) {
                applyLyricsResult(result);
            } else if (result.available) {
                setLyricsState(result.synced ? 'Караоке готово.' : 'Текст готов.');
            }
        }
        return;
    }

    if (msg.type === 'lyrics-request') {
        if (!isHost) return;

        const trackId = String(msg.trackId || '');
        if (!trackId) return;

        const track = currentTrackForLyrics?.id && String(currentTrackForLyrics.id) === trackId
            ? currentTrackForLyrics
            : playlist.find(t => String(t?.id) === trackId);

        if (!track) {
            dcSend({
                type: 'lyrics-update',
                trackId,
                result: { available: false, synced: false }
            });
            return;
        }

        void fetchLyricsForHost(track);
        return;
    }

    if (msg.type === 'host-changed') {
        logEvent('handle:host-changed', { newHostRole: msg.newHostRole, myRole: role });
        isHost = (msg.newHostRole === role);

        if (msg.playlist) {
            playlist = msg.playlist;
            playlistIndex = msg.playlistIndex ?? -1;
            playlistMode = msg.playlistMode || null;
            waveSessionId = msg.waveSessionId || null;
            updateQueueLabel();
        }

        if (msg.lyricsTrackId && msg.lyricsResult) {
            remoteLyricsCache.set(String(msg.lyricsTrackId), msg.lyricsResult);
            if (currentTrackForLyrics?.id && String(currentTrackForLyrics.id) === String(msg.lyricsTrackId)) {
                currentLyricsResult = msg.lyricsResult;
            }
        }

        updateUIForRole();
        statusEl.textContent = isHost ? '👑 Ты теперь хост' : '🎧 Ты слушатель';
        return;
    }

    logEvent('handle:unknown', { msg });
}

function runClockSync() {
    pingSamples.length = 0;
    sendPing();
}

function sendPing() {
    dcSend({ type: 'ping', t0: Date.now() });
}

function finishClockSync() {
    const sorted = [...pingSamples].sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(0, Math.ceil(sorted.length / 2));
    clockOffset = best.reduce((sum, s) => sum + s.offset, 0) / best.length;
    const avgRtt = best.reduce((sum, s) => sum + s.rtt, 0) / best.length;
    logEvent('clockSync:done', { clockOffset, avgRtt, samples: pingSamples.length });
    statusEl.textContent = `Синхронизация: RTT ${avgRtt.toFixed(0)}мс`;
}

// --- Команды ---
function sendCommand(action, extraPosition, caller = 'unknown') {
    if (!isHost) {
        logEvent('sendCommand:blocked', { reason: 'not host', caller });
        return;
    }
    if (!audioReady) {
        logEvent('sendCommand:skip', { action, caller, reason: 'audioReady=false' });
        statusEl.textContent = 'Сначала выбери трек';
        return;
    }
    const position = extraPosition !== undefined ? extraPosition : audio.currentTime;
    const scheduledAt = Date.now() + LEAD_TIME_MS;
    const msg = { type: 'command', action, position, scheduledAt };
    logEvent('sendCommand', { caller, action, position, scheduledAt, state: snapshotState() });
    dcSend(msg);
    scheduleCommand(action, position, scheduledAt, true);
}

function scheduleCommand(action, position, hostScheduledAt, isLocalHost = false) {
    const localTargetTime = isLocalHost ? hostScheduledAt : hostScheduledAt - clockOffset;
    const delay = localTargetTime - Date.now();

    logEvent('scheduleCommand', { action, position, delay: Number(delay.toFixed(1)), isLocalHost });

    setTimeout(async () => {
        logEvent('scheduleCommand:fire', { action, position, audioReady, state: snapshotState() });
        if (!audioReady) {
            logEvent('scheduleCommand:skipped', { action, reason: 'audioReady=false' });
            return;
        }

        if (action === 'play') {
            audio.currentTime = position;
            try {
                await audio.play();
                logEvent('scheduleCommand:played', { position });
                updatePlaybackUI(true);
                startPositionTimer();
            } catch (e) {
                logEvent('scheduleCommand:play-failed', { error: e.message });
            }
        } else if (action === 'pause') {
            audio.pause();
            updatePlaybackUI(false);
            stopPositionTimer();
            logEvent('scheduleCommand:paused');
        } else if (action === 'seek') {
            audio.currentTime = position;
            if (!audio.paused) startPositionTimer();
            logEvent('scheduleCommand:seeked', { position });
        }
    }, Math.max(0, delay));
}

function startPositionTimer() {
    stopPositionTimer();
    positionTimer = setInterval(() => {
        virtualPosition = audio.currentTime;
        if (!isSeeking) {
            updateTrackProgressUI(audio.currentTime);
        }
        updateKaraokeUI(audio.currentTime);
    }, 100);
}

function stopPositionTimer() {
    if (positionTimer) clearInterval(positionTimer);
    positionTimer = null;
    updateTrackProgressUI(audio.currentTime);
    updateKaraokeUI(audio.currentTime);
}

// --- Аудио-события ---
audio.addEventListener('play', () => {
    updatePlaybackUI(true);
    startPositionTimer();
    logEvent('audio:play', { currentTime: audio.currentTime, state: snapshotState() });
});
audio.addEventListener('timeupdate', () => {
    if (!isSeeking) updateTrackProgressUI(audio.currentTime);
    updateKaraokeUI(audio.currentTime);
});
audio.addEventListener('pause', () => {
    updatePlaybackUI(false);
    stopPositionTimer();
    logEvent('audio:pause', { currentTime: audio.currentTime, state: snapshotState() });
});
audio.addEventListener('waiting', () => logEvent('audio:waiting', { currentTime: audio.currentTime }));
audio.addEventListener('stalled', () => logEvent('audio:stalled', { currentTime: audio.currentTime }));
audio.addEventListener('canplay', () => logEvent('audio:canplay', { currentTime: audio.currentTime, duration: audio.duration }));
audio.addEventListener('seeking', () => logEvent('audio:seeking', { currentTime: audio.currentTime }));
audio.addEventListener('seeked', () => logEvent('audio:seeked', { currentTime: audio.currentTime }));
audio.addEventListener('error', () => {
    const e = audio.error;
    logEvent('audio:error', { code: e?.code, message: e?.message });
});

audio.addEventListener('ended', () => {
    logEvent('audio:ended', { currentTime: audio.currentTime, duration: audio.duration, state: snapshotState() });
    if (isReloading) {
        logEvent('audio:ended:ignored', { reason: 'isReloading' });
        return;
    }
    if (isHost) {
        nextTrack('ended');
    } else {
        logEvent('audio:ended:not-host-ignore');
    }
});

// --- Громкость ---
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

// --- Очередь ---
function updateQueueLabel() {
    if (playlist.length === 0 || playlistIndex < 0) {
        trackQueueEl.textContent = '';
        queuePanel.classList.remove('visible');
        return;
    }
    let mode = '';
    if (playlistMode === 'wave') mode = '📻 ';
    else if (playlistMode === 'liked') mode = '❤️ ';
    // если лайков больше, чем влезло в очередь — показываем сколько всего
    const extra = (playlistMode === 'liked' && likedTotal > playlist.length)
        ? ` из ${likedTotal}`
        : '';
    trackQueueEl.textContent = `${mode}${playlistIndex + 1} / ${playlist.length}${extra}`;
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
        cover.loading = 'lazy';      // не тянем 300 обложек разом
        cover.decoding = 'async';
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

        item.appendChild(makeLikeButton(t.id));

        item.addEventListener('click', () => jumpToTrack(idx));
        queueList.appendChild(item);
    });

    requestAnimationFrame(() => {
        const current = queueList.querySelector('.queueItem.current');
        if (current) current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
}

async function jumpToTrack(index) {
    logEvent('ui:jumpToTrack', { index, isHost });
    if (!isHost) {
        statusEl.textContent = 'Менять трек может только хост';
        return;
    }
    if (index < 0 || index >= playlist.length) return;
    if (index === playlistIndex && audioReady) {
        sendCommand('seek', 0, 'jump-restart');
        return;
    }
    playlistIndex = index;
    await playCurrent('jump');
}

// --- Передача хоста ---
function transferHost() {
    if (!isHost) {
        logEvent('transferHost:blocked', { reason: 'not host' });
        return;
    }
    if (!dataChannel || dataChannel.readyState !== 'open') {
        statusEl.textContent = 'Партнёр не подключён';
        return;
    }

    const newHostRole = role === 'offerer' ? 'answerer' : 'offerer';
    logEvent('transferHost:send', { newHostRole, playlistLen: playlist.length, idx: playlistIndex });

    dcSend({
        type: 'host-changed',
        newHostRole,
        playlist,
        playlistIndex,
        playlistMode,
        waveSessionId,
        lyricsTrackId: currentTrackForLyrics?.id ? String(currentTrackForLyrics.id) : null,
        lyricsResult: currentLyricsResult || null
    });

    isHost = false;
    updateUIForRole();
    statusEl.textContent = '👑 Ты передал права хоста партнёру';
}

// --- UI события ---
searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
});

waveBtn.addEventListener('click', startWave);
// Shift+клик — форс-обновление кэша избранного
likedBtn.addEventListener('click', (e) => startLiked(e.shiftKey));
transferHostBtn.addEventListener('click', transferHost);

modeArtistBtn.addEventListener('click', () => {
    SEARCH_MODE = 'artist';
    updateSearchModeUI();
    logEvent('ui:searchMode-changed', { mode: SEARCH_MODE });
    // Меняем настройку без перезагрузки (для сохранения при следующем Save)
    ipcRenderer.invoke('settings-load').then(cfg => {
        if (cfg) {
            ipcRenderer.invoke('settings-save', { ...cfg, searchMode: SEARCH_MODE });
        }
    });
});

modeTracksBtn.addEventListener('click', () => {
    SEARCH_MODE = 'tracks';
    updateSearchModeUI();
    logEvent('ui:searchMode-changed', { mode: SEARCH_MODE });
    ipcRenderer.invoke('settings-load').then(cfg => {
        if (cfg) {
            ipcRenderer.invoke('settings-save', { ...cfg, searchMode: SEARCH_MODE });
        }
    });
});

seekBar.addEventListener('input', () => {
    if (!isHost) return;
    isSeeking = true;
    updateTrackProgressUI(parseFloat(seekBar.value));
});

seekBar.addEventListener('change', () => {
    if (!isHost) return;
    const newPos = parseFloat(seekBar.value);
    logEvent('ui:seek', { newPos });
    isSeeking = false;
    updateTrackProgressUI(newPos);
    sendCommand('seek', newPos, 'seek-bar');
});

playBtn.addEventListener('click', () => sendCommand('play', undefined, 'play-btn'));
pauseBtn.addEventListener('click', () => sendCommand('pause', undefined, 'pause-btn'));
prevBtn.addEventListener('click', () => prevTrack('button'));
nextBtn.addEventListener('click', () => nextTrack('button'));

window.addEventListener('keydown', (e) => {
    const inInput = e.target.tagName === 'INPUT';
    if (e.code === 'Space' && audioReady && !inInput && isHost) {
        e.preventDefault();
        if (audio.paused) sendCommand('play', undefined, 'space-hotkey');
        else sendCommand('pause', undefined, 'space-hotkey');
    } else if (e.code === 'ArrowRight' && !inInput && isHost) {
        e.preventDefault();
        nextTrack('hotkey-right');
    } else if (e.code === 'ArrowLeft' && !inInput && isHost) {
        e.preventDefault();
        prevTrack('hotkey-left');
    }
});

// --- Настройки ---
settingsBtn.addEventListener('click', async () => {
    try {
        const config = await ipcRenderer.invoke('settings-load');
        if (config) {
            ymTokenInput.value = config.ymToken || '';
            ymUidInput.value = config.ymUid || '';
            signalingUrlInput.value = config.signalingUrl || 'ws://localhost:8080';
            roomNameInput.value = config.roomName || 'test-room-1';
        }
    } catch (err) {
        logEvent('settings:load:error', { error: err.message });
    }
    settingsModal.classList.add('visible');
});

settingsCancelBtn.addEventListener('click', () => {
    settingsModal.classList.remove('visible');
});

settingsSaveBtn.addEventListener('click', async () => {
    const config = {
        ymToken: ymTokenInput.value.trim(),
        ymUid: ymUidInput.value.trim(),
        signalingUrl: signalingUrlInput.value.trim() || 'ws://localhost:8080',
        roomName: roomNameInput.value.trim() || 'test-room-1',
        searchMode: SEARCH_MODE
    };

    logEvent('settings:save', { hasToken: !!config.ymToken, ymUid: config.ymUid, signalingUrl: config.signalingUrl, roomName: config.roomName, searchMode: config.searchMode });

    try {
        const result = await ipcRenderer.invoke('settings-save', config);
        if (result.success) {
            logEvent('settings:saved:reloading');
            settingsModal.classList.remove('visible');
            window.location.reload();
        } else {
            alert('Ошибка сохранения: ' + result.error);
        }
    } catch (err) {
        logEvent('settings:save:error', { error: err.message });
        alert('Ошибка сохранения: ' + err.message);
    }
});

settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
        settingsModal.classList.remove('visible');
    }
});

if (logBtn) {
    logBtn.addEventListener('click', async () => {
        const p = await ipcRenderer.invoke('log-open');
        logEvent('ui:log-open', { path: p });
    });
}

if (oauthLoginBtn) {
    oauthLoginBtn.addEventListener('click', async () => {
        try {
            logEvent('ui:oauth-login:start');
            statusEl.textContent = 'Открываем окно авторизации Яндекса...';

            const result = await ipcRenderer.invoke('oauth-login');

            if (result.success) {
                logEvent('ui:oauth-login:success', { hasToken: true, expiresIn: result.expiresIn });
                ymTokenInput.value = result.accessToken;
                statusEl.textContent = 'Авторизация успешна! Токен сохранён.';
                await ipcRenderer.invoke('settings-save', {
                    ymToken: ymTokenInput.value,
                    ymUid: ymUidInput.value,
                    signalingUrl: signalingUrlInput.value,
                    roomName: roomNameInput.value,
                    searchMode: SEARCH_MODE
                });
                settingsModal.classList.remove('visible');
                window.location.reload();
            } else {
                logEvent('ui:oauth-login:failed', { error: result.error });
                statusEl.textContent = 'Ошибка авторизации: ' + result.error;
                alert('Не удалось войти через Яндекс: ' + result.error);
            }
        } catch (err) {
            logEvent('ui:oauth-login:error', { error: err.message });
            alert('Ошибка: ' + err.message);
        }
    });
}

// --- Init ---
(async () => {
    try {
        const config = await ipcRenderer.invoke('settings-load');
        if (config) {
            if (config.signalingUrl) SIGNALING_URL = config.signalingUrl;
            if (config.roomName) ROOM = config.roomName;
            if (config.searchMode) SEARCH_MODE = config.searchMode;
        }
    } catch (err) {
        logEvent('init:settings-load-error', { error: err.message });
    }
    logEvent('init:session-start', { room: ROOM, url: SIGNALING_URL, searchMode: SEARCH_MODE });
    updateSearchModeUI();
    updatePlaybackUI(false);
    updateUIForRole();
    try {
        const isMaximized = await ipcRenderer.invoke('window-is-maximized');
        setMaximizeButtonState(Boolean(isMaximized));
    } catch (err) {
        logEvent('window:state:error', { error: err.message });
    }
    initWebSocket();
    void fetchLikedIds(); // фоном, не блокируя запуск
})();