/**
 * SoA-Web client entry.
 *
 * Three paths at page load:
 *   1. URL has ?backend=&t= — visitor arrived via a scripts/selfhost.js deep
 *      link. Stash both in localStorage, strip them from the URL, then boot
 *      server mode against that backend.
 *   2. A backend is saved in localStorage — probe /api/ping, and if it
 *      answers boot server mode against it. Otherwise clear the saved
 *      config and fall through.
 *   3. Nothing configured — boot the in-browser WebContainer sandbox
 *      (app-wc.js). Visitors get a shell with no setup.
 *
 * The dev-time config in web/public/_config.js can pre-select the mode
 * ('server' or 'webcontainer') or pin a backend; the build step
 * (scripts/vercel-build.js) rewrites it from env vars.
 */

import { Bridge, INPUT_KIND } from '/assets/bridge.js?v=17';
import { AudioFX } from '/assets/audiofx.js?v=17';
import { mountSidebar, setSidebarHidden } from '/assets/widgets.js?v=24';
import { t as tr, getLang, setLang, applyStatic, LANGS } from '/assets/i18n.js?v=17';
import { getSettings, onSettings, openSettingsModal } from '/assets/settings.js?v=17';
import { pickFolder } from '/assets/folderPicker.js?v=1';

const CFG = (window.__SOA_WEB__ = window.__SOA_WEB__ || {});
const LS_KEY = 'soa_web_backend';

// On HTTPS pages, http://127.0.0.1 is blocked as mixed content but
// http://localhost is allowed (browsers treat localhost as secure).
function normalizeBackend(backend) {
    if (location.protocol === 'https:') {
        backend = backend.replace(/^http:\/\/127\.0\.0\.1/, 'http://localhost');
    }
    return backend.replace(/\/+$/, '');
}

function loadSaved() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        const j = JSON.parse(raw);
        if (!j || typeof j.backend !== 'string') return null;
        return { backend: normalizeBackend(j.backend), token: j.token || '' };
    } catch (_) { return null; }
}

function saveBackend(backend, token) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify({
            backend: normalizeBackend(String(backend || '')),
            token: String(token || ''),
        }));
    } catch (_) {}
}

function pickBackendFromURL() {
    const q = new URLSearchParams(location.search);
    const backend = q.get('backend');
    const token = q.get('t') || '';
    if (!backend) return null;
    q.delete('backend'); q.delete('t');
    const cleanQuery = q.toString();
    const cleanUrl = location.pathname + (cleanQuery ? '?' + cleanQuery : '') + location.hash;
    history.replaceState(null, '', cleanUrl);
    return { backend: normalizeBackend(backend), token };
}

async function probePing(backend, token, timeoutMs = 2500) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const u = new URL(backend + '/api/ping');
        // The token is deliberately NOT sent on the probe: /api/ping is
        // unauthenticated, so it buys nothing — and a saved pairing now
        // persists across backend outages, so probing forever with ?t=
        // would hand the token to whoever later acquires a recycled
        // hostname. (The token still flows to the chosen backend in
        // bootServerMode.)
        // Probe without credentials. /api/ping is unauthenticated and omitting
        // cookies sidesteps browsers that suppress third-party cookies on
        // cross-site fetches — we only want to know whether the backend is
        // reachable. Credentials get added back once we switch to the chosen
        // backend in bootServerMode.
        const res = await fetch(u.toString(), { signal: ctl.signal, credentials: 'omit', cache: 'no-store' });
        if (!res.ok) return null;
        const body = await res.json().catch(() => null);
        if (!body || !body.ok) return null;
        if (body.tokenRequired && !token) return { needsToken: true };
        return { ok: true, info: body };
    } catch (_) { return null; }
    finally { clearTimeout(timer); }
}

function apiUrl(backend, token, path) {
    const u = new URL(backend + path);
    if (token) u.searchParams.set('t', token);
    return u.toString();
}

function wsUrl(backend, token) {
    const u = new URL(backend);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    if (token) u.searchParams.set('t', token);
    return u.toString();
}

const FETCH_INIT = { credentials: 'include' };

function wireLangSelector() {
    const sel = document.querySelector('#lang');
    if (!sel || sel.dataset.wired === '1') return;
    sel.dataset.wired = '1';
    sel.replaceChildren(...LANGS.map(l => {
        const opt = document.createElement('option');
        opt.value = l.code;
        opt.textContent = l.label;
        if (l.code === getLang()) opt.selected = true;
        return opt;
    }));
    sel.addEventListener('change', () => setLang(sel.value));
}

function wireReleaseLink() {
    const a = document.querySelector('#release-link');
    if (!a) return;
    const url = (window.__SOA_WEB__ || {}).releaseUrl;
    if (url) a.href = url;
}

// Show the build version when hovering the brand name. The version is hidden
// by default (CSS) and revealed on .brand:hover; we just fill in the text.
function wireVersion() {
    const span = document.querySelector('#soa-version');
    if (!span) return;
    const v = (window.__SOA_WEB__ || {}).version || 'dev';
    span.textContent = 'v' + v;
    span.title = 'Build ' + v;
}

const $  = sel => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v != null) n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
};

const TRON_THEME = {
    foreground: '#aacfd1',
    background: '#05080d',
    cursor:     '#aacfd1',
    cursorAccent:'#aacfd1',
    selectionBackground: 'rgba(170,207,209,0.3)',
    black: '#000000', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#6272a4', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#262828', brightRed: '#ff6e6e', brightGreen: '#69ff94',
    brightYellow: '#ffffa5', brightBlue: '#7b93bd', brightMagenta: '#ff92df',
    brightCyan: '#a4ffff', brightWhite: '#ffffff',
};

// ── Tab UI ────────────────────────────────────────────────────────────────
class TabRuntime {
    constructor(id, title) {
        this.id = id;
        this.title = title || tr('tab.default', { id });
        this.container = el('div', { class: 'term', 'data-tab': String(id) });
        const s = getSettings();
        const fontSize = s.termFontSize;
        this.term = new Terminal({
            fontFamily: 'Fira Mono, ui-monospace, Menlo, Consolas, monospace',
            fontSize,
            theme: TRON_THEME,
            cursorBlink: s.cursorBlink,
            scrollback: 5000,
            convertEol: false,
        });
        this.fit = new FitAddon.FitAddon();
        this.term.loadAddon(this.fit);
        try { this.term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (_) {}
        // Don't open xterm yet — see _ensureOpen. Opening against a hidden /
        // zero-sized container makes xterm cache cellWidth=0, and every later
        // fit() then silently becomes a no-op, stranding the grid at 80×24.
        this._opened = false;
        this._onData = null;
        this._onResize = null;
        // Scrollback handed to us in HELLO before this tab's container is
        // visible. Writing it into a hidden xterm means writing at the
        // default 80×24, so any absolute cursor positioning in the stream
        // lands at the wrong column and lines wrap wrong. We hold it here
        // and flush it on the first successful fit — see flushPendingReplay.
        this._pendingReplay = '';
        this._everFit = false;
    }

    _ensureOpen() {
        if (this._opened) return true;
        const rect = this.container.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        this.term.open(this.container);
        this._opened = true;
        if (this._onData) this.term.onData(d => this._onData && this._onData(d));
        if (this._onResize) this.term.onResize(({ cols, rows }) => this._onResize && this._onResize(cols, rows));
        if (this._onTitle) this.term.onTitleChange(t => this._onTitle && this._onTitle(t));
        return true;
    }

    attach(onData, onResize, onTitle) {
        this._onData = onData;
        this._onTitle = onTitle || null;
        // Debounce + dedupe the resize send. xterm's onResize already fires
        // only on real cols/rows changes, but during a window drag we may
        // churn through several intermediate sizes in a single frame. Each
        // pty.resize() on the server causes SIGWINCH and repaints any
        // currently-drawing full-screen UI (claude, vim, less, top) at the
        // new width — output already queued at the OLD width then renders
        // at the NEW cols, leaving the lines shifted. Coalesce to one
        // TERM_RESIZE per ~60ms so only the settled size reaches the PTY.
        let pending = null;
        let lastSent = null;
        this._onResize = (cols, rows) => {
            if (lastSent && lastSent.cols === cols && lastSent.rows === rows) return;
            if (pending) clearTimeout(pending);
            pending = setTimeout(() => {
                lastSent = { cols, rows };
                pending = null;
                onResize(cols, rows);
            }, 60);
        };
        if (this._opened) {
            this.term.onData(d => this._onData && this._onData(d));
            this.term.onResize(({ cols, rows }) => this._onResize && this._onResize(cols, rows));
            if (this._onTitle) this.term.onTitleChange(t => this._onTitle && this._onTitle(t));
        }
    }

    write(data) { this.term.write(data); }

    // Queue replay bytes for later. If the container is already visible
    // and sized, we can flush immediately; otherwise the caller will call
    // flushPendingReplay() once the tab becomes active.
    queueReplay(data) {
        if (!data) return;
        this._pendingReplay += data;
        // With virtualization this buffers a hidden tab's LIVE output (not just
        // bounded scrollback), so cap it. Keep the tail and align to a newline so
        // the replay never starts mid-escape-sequence; a full-screen TUI repaints
        // itself shortly after, so a dropped prefix self-corrects on switch.
        const CAP = 1 << 19; // 512 KB
        if (this._pendingReplay.length > CAP) {
            const tail = this._pendingReplay.slice(-CAP);
            const nl = tail.indexOf('\n');
            this._pendingReplay = nl >= 0 ? tail.slice(nl + 1) : tail;
        }
    }

    flushPendingReplay() {
        if (!this._pendingReplay) return false;
        // Only flush once xterm has actually been fit against a real-sized
        // container — otherwise absolute-column escapes in the scrollback
        // land at the wrong column.
        if (!this._everFit) {
            const rect = this.container.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) return false;
            this.fitNow();
        }
        const data = this._pendingReplay;
        this._pendingReplay = '';
        this.term.write(data);
        return true;
    }

    fitNow() {
        if (!this._ensureOpen()) return { cols: this.term.cols, rows: this.term.rows };
        try {
            this.fit.fit();
            // FitAddon subtracts a phantom ~15px scrollbar (xterm's Viewport
            // falls back to 15 when our CSS hides the scrollbar), which strands
            // a dead vertical strip on the right. Grow the grid into the real
            // width — our viewport is overflow:hidden so no scrollbar takes space.
            this._fillWidth();
            this._everFit = true;
            return { cols: this.term.cols, rows: this.term.rows };
        } catch (_) { return { cols: this.term.cols, rows: this.term.rows }; }
    }

    // Recompute cols from the actual render width with NO scrollbar subtraction.
    // Conservative floor() never overflows into a horizontal scroll; only grows
    // past FitAddon's undercount, never shrinks. No-op if xterm internals or the
    // measurement aren't available (falls back to FitAddon's result).
    _fillWidth() {
        try {
            const core = this.term._core;
            const dims = core && core._renderService && core._renderService.dimensions;
            const cellW = dims && dims.css && dims.css.cell && dims.css.cell.width;
            const elW = this.term.element && this.term.element.clientWidth;
            if (!cellW || cellW < 1 || !elW) return;
            const cols = Math.max(2, Math.floor(elW / cellW));
            if (cols > this.term.cols) this.term.resize(cols, this.term.rows);
        } catch (_) {}
    }

    // Pin the viewport to the bottom of the buffer. Used when activating a
    // tab so the user lands on the newest output regardless of where xterm
    // left the scroll position. xterm's own auto-scroll-on-write only kicks
    // in when the cursor row is already in view, so a tab that was hidden
    // while data streamed in can have the viewport stranded mid-scrollback.
    // We also schedule a second scroll in the next frame because term.write()
    // is async — bytes queued during flushPendingReplay() or fitNow()'s
    // reflow don't land in the buffer until the parser drains on a later
    // microtask, and a scrollToBottom() before that drain snaps back once
    // the new lines appear. term.write accepts a callback, so we use it
    // when available to scroll exactly after the flush settles.
    scrollToBottom() {
        if (!this._opened) return;
        try { this.term.scrollToBottom(); } catch (_) {}
        // xterm uses setTimeout(0) internally to flush the write buffer;
        // two rAFs is enough to let the reflow + any queued writes land.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            try { this.term.scrollToBottom(); } catch (_) {}
        }));
        // Also flush any queued writes explicitly so we can scroll the
        // moment the parser settles rather than waiting two frames.
        try { this.term.write('', () => { try { this.term.scrollToBottom(); } catch (_) {} }); } catch (_) {}
    }

    focus() { if (this._opened) this.term.focus(); }

    applySettings(s) {
        try { this.term.options.fontSize = s.termFontSize; } catch (_) {}
        try { this.term.options.cursorBlink = s.cursorBlink; } catch (_) {}
        if (this._ensureOpen()) { try { this.fitNow(); } catch (_) {} }
    }

    dispose() {
        try { this.term.dispose(); } catch (_) {}
        this.container.remove();
    }
}

class Shell {
    constructor(bridge, { audio } = {}) {
        this.bridge = bridge;
        this.audio = audio || { play: () => {}, setEnabled: () => {} };
        this.tabs = new Map();
        this.order = [];
        this.activeId = null;
        // Per-device active tab is client-local: snapshots fire on the 3s cwd
        // poll, on device connect/disconnect, and on ANY device's switch, all
        // carrying the session-global activeId. Adopting it blindly yanks this
        // device's view and pings SWITCH_TAB back, gluing devices together.
        // A normal SWITCH is already optimistic-local (see _activate), so it
        // needs no server round-trip. The only thing we must follow from the
        // server is a tab THIS device just CREATED/RESTORED, whose id the server
        // assigns. When we send NEW_TAB/RESTORE_TAB we snapshot the set of tab
        // ids that exist right then; _onSnapshot adopts the activeId of the
        // first snapshot that names a tab NOT in that set (i.e. the genuinely
        // new tab), then clears the pending set. Matching the NEW id — not just
        // "any valid activeId" — means a racing cwd-poll/device-count snapshot
        // carrying the old (still-valid) activeId can't burn the intent.
        this._adoptNewTabIds = null;
        this.tabsEl = $('#tabs');
        this.termsEl = $('#terms');
        this.sidebarEl = $('#sidebar');
        this._lastStdoutCue = new Map(); // tabId → performance.now() of last stdout cue
        this._prevConnState = null;
        this._agentStatus = new Map(); // tabId → 'working'|'done'|'attention'|'idle'
        this._agentBuf = new Map();    // tabId → detector state (see _pollAgentStatus)
        this._ctxPct = new Map();      // tabId → 0-100 context usage %
        // Tabs whose PTY emitted output since the last status scan. The 500ms
        // poll re-scans only dirty tabs (idle tabs cost nothing), with a full
        // sweep every ~8s as a backstop so a missed seed can't strand a tab's
        // status/context. Seeded in _onTermData and on HELLO replay below.
        this._pollDirty = new Set();
        this._pollTickN = 0;
        this._pollWasHidden = false;
        // Agent-detection debug overlay (bottom-right box) — off by default.
        // Opt in with ?debugAgent=1 in the URL or localStorage 'soaDebugAgent'='1'.
        window.__SOA_DEBUG_AGENT =
            /[?&]debugAgent=1/.test(location.search) ||
            (() => { try { return localStorage.getItem('soaDebugAgent') === '1'; } catch (_) { return false; } })();
        // Poll the second-to-last visible terminal line every second — that's
        // where Claude Code's Ink status bar always lives. More reliable than
        // scanning the PTY stream because Ink re-renders in-place via cursor-up.
        this._ctxPollTimer = setInterval(() => this._pollCtxLines(), 500);
        this._tileElapsedTimer = setInterval(() => this._refreshTileElapsed(), 1000);
        // Seed every tab's agent status + ctx% from the server supervisor —
        // which classifies ALL tabs server-side from their PTY streams, not just
        // the one on screen — so the fleet shows correct colours/context on load
        // without opening each tab. Re-pulled on a slow cadence so unopened tabs
        // stay live too; paused while the page is hidden. (Requirement: status
        // loaded on startup, not tab-by-tab.)
        this._serverStatusTimer = setInterval(() => { if (!document.hidden) this._pullServerStatus(); }, 4000);
        this._statusSeeded = false;
        // Request OS notification permission on the user's first interaction
        // (some browsers require a gesture). Until granted, in-app toasts only.
        this._armNotifications();
        // Server-side graveyard, mirrored on HELLO / SNAPSHOT. Newest entry
        // is at the end; an empty list means there's nothing to restore.
        this.graveyard = [];
        // Session-scoped "don't ask again" flag for the close-confirm modal.
        // Reset on reload — we want the guard back each time the app boots.
        this._skipCloseConfirm = false;

        // View mode: 'tabs' (classic) or 'tiles' (dashboard grid).
        this.viewMode = 'tabs';
        try { this.viewMode = localStorage.getItem('soa_web_view_mode') || 'tabs'; } catch (_) {}
        // Virtualize background tabs: only the on-screen terminal parses live;
        // hidden tabs buffer raw output and catch up on switch. Cuts ~N live
        // ANSI parsers down to ~1 with many sessions. Escape hatch:
        // localStorage.soa_no_virtualize='1' keeps every tab live-parsed.
        this._noVirtualize = false;
        try { this._noVirtualize = localStorage.getItem('soa_no_virtualize') === '1'; } catch (_) {}
        this._tileOverlayId = null; // id of the tab currently open in tile overlay
        this._tilesGridEl = null;
        this._tileOverlayEl = null;

        const viewBtn = $('#toggle-view');
        if (viewBtn) {
            viewBtn.addEventListener('click', () => this._toggleViewMode());
            this._updateViewBtn();
        }

        const monBtn = $('#toggle-monitor');
        if (monBtn) {
            monBtn.addEventListener('click', () => this._toggleMonitor());
            this._updateMonitorBtn();
        }

        $('#new-tab').addEventListener('click', () => {
            this.audio.play('panels');
            this._openNewTabChooser();
        });

        const bcastBtn = $('#broadcast');
        if (bcastBtn) bcastBtn.addEventListener('click', () => { this.audio.play('panels'); this._openBroadcast(); });

        const tmBtn = $('#timemachine');
        if (tmBtn) {
            tmBtn.addEventListener('click', async () => {
                this.audio.play('panels');
                try {
                    const tm = await import('/assets/timemachine.js?v=1');
                    tm.openTimemachineModal(this);
                } catch (err) {
                    console.warn('[timemachine] open failed', err);
                }
            });
        }


        const audioBtn = $('#toggle-audio');
        const initialAudio = getSettings().audio;
        audioBtn.dataset.state = initialAudio ? 'on' : 'off';
        audioBtn.textContent = initialAudio ? tr('topbar.audio_on') : tr('topbar.audio_off');
        audioBtn.addEventListener('click', () => {
            const on = audioBtn.dataset.state !== 'off';
            this.audio.setEnabled(!on);
            audioBtn.dataset.state = on ? 'off' : 'on';
            audioBtn.textContent = on ? tr('topbar.audio_off') : tr('topbar.audio_on');
            if (!on) this.audio.play('info');
        });

        // Text-to-speech toggle: speak Claude's replies aloud (Web Speech API).
        this._ttsEnabled = false;
        try { this._ttsEnabled = localStorage.getItem('soa_web_tts') === '1'; } catch (_) {}
        const ttsBtn = $('#toggle-tts');
        if (ttsBtn) {
            ttsBtn.dataset.state = this._ttsEnabled ? 'on' : 'off';
            ttsBtn.addEventListener('click', () => {
                this._ttsEnabled = !this._ttsEnabled;
                ttsBtn.dataset.state = this._ttsEnabled ? 'on' : 'off';
                try { localStorage.setItem('soa_web_tts', this._ttsEnabled ? '1' : '0'); } catch (_) {}
                if (this._ttsEnabled) {
                    // First user gesture unlocks speech; greet so it's obvious it works.
                    this._speak('Speech on.');
                } else if (window.speechSynthesis) {
                    window.speechSynthesis.cancel();
                }
                this.audio.play('info');
            });
        }

        const settingsBtn = $('#open-settings');
        if (settingsBtn) settingsBtn.addEventListener('click', () => {
            this.audio.play('panels');
            openSettingsModal();
        });

        onSettings(s => this._applySettings(s));

        const sideBtn = $('#toggle-sidebar');
        const stageEl = $('.stage');
        // On phone-sized viewports the sidebar is an overlay, not a
        // permanent column — start it closed so the terminal owns the
        // full width on first load. Desktop keeps its existing behavior.
        if (window.matchMedia('(max-width: 768px)').matches) {
            stageEl.classList.add('no-sidebar');
        }
        // Pause the sidebar widgets whenever it's collapsed (its normal state on
        // phones, and the common full-screen-terminal state on desktop) so they
        // stop polling /api/* against an invisible pane.
        setSidebarHidden(stageEl.classList.contains('no-sidebar'));
        sideBtn.addEventListener('click', () => {
            stageEl.classList.toggle('no-sidebar');
            setSidebarHidden(stageEl.classList.contains('no-sidebar'));
            this.audio.play('panels');
            this._fitActive();
        });
        // Tapping the scrim behind the overlay sidebar closes it.
        stageEl.addEventListener('click', e => {
            if (e.target !== stageEl) return;
            if (!window.matchMedia('(max-width: 768px)').matches) return;
            if (stageEl.classList.contains('no-sidebar')) return;
            stageEl.classList.add('no-sidebar');
            setSidebarHidden(true);
            this._fitActive();
        });

        window.addEventListener('resize', () => this._fitActive());
        window.addEventListener('orientationchange', () => setTimeout(() => this._fitActive(), 150));
        window.addEventListener('keydown', e => this._hotkey(e));
        // Image paste: Claude Code grabs clipboard images on Ctrl+V (it ignores
        // Cmd+V for images). Browsers map Cmd/Ctrl+V to a TEXT paste, so an
        // image yields no text and nothing happens. Capture the paste before
        // xterm, and when the clipboard holds an image, forward Ctrl+V (\x16)
        // to the PTY so Claude Code reads the image off the system clipboard.
        document.addEventListener('paste', e => this._onPasteImage(e), true);

        // The #shell container boots hidden so xterm measures 0×0 on init.
        // Once the shell unhides (app.js boot flow) or the sidebar toggles,
        // the terms box gets its real size — refit whenever that happens so
        // the terminal grows into every available pixel. Also refit after
        // web fonts load, since Fira Mono metrics differ from the fallback.
        if (typeof ResizeObserver !== 'undefined') {
            this._ro = new ResizeObserver(() => this._fitActive());
            this._ro.observe(this.termsEl);
        }
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => this._fitActive()).catch(() => {});
        }

        bridge.addEventListener('hello',     e => this._onHello(e.detail));
        bridge.addEventListener('replay',    e => this._onReplay(e.detail));
        bridge.addEventListener('snapshot',  e => this._onSnapshot(e.detail));
        bridge.addEventListener('term-data', e => this._onTermData(e.detail));
        bridge.addEventListener('term-exit', e => this._onTermExit(e.detail));
        bridge.addEventListener('status',    e => this._onStatus(e.detail));
        bridge.addEventListener('tts',       e => this._onTTS(e.detail));
        bridge.addEventListener('manager',   e => this._onManager(e.detail));
        bridge.addEventListener('browser-frame', e => this._onBrowserFrame(e.detail));
        bridge.addEventListener('unauthorized', () => { location.reload(); });
    }

    _onStatus({ state }) {
        const s = $('#status-conn');
        s.className = state === 'open' ? 'ok' : state === 'connecting' ? 'warn' : 'err';
        const key = `status.${state}`;
        s.textContent = tr(key);
        s.setAttribute('data-i18n', key);
        if (this._prevConnState && this._prevConnState !== state) {
            if (state === 'closed') this.audio.play('error');
            if (state === 'open')   this.audio.play('granted');
        }
        this._prevConnState = state;
    }

    _onHello({ tabs, activeId, replay, graveyard, connectedDevices }) {
        this._updateGraveyard(graveyard);
        this._updateDeviceCount(connectedDevices);
        if (Array.isArray(tabs) && tabs.length) {
            for (const t of tabs) this._ensureTab(t.id, t.title);
            // Queue each tab's scrollback instead of writing it straight
            // into xterm. Writing before fit means writing at the default
            // 80×24 — any absolute-column ANSI in the stream lands at the
            // wrong column and the reloaded view comes up visibly
            // misaligned. _activate fits the target tab first and then
            // flushes its queue; inactive tabs flush lazily on activation.
            if (Array.isArray(replay)) {
                for (const r of replay) {
                    const rt = this.tabs.get(r.id);
                    if (rt && r.data) {
                        rt.queueReplay(r.data);
                        this._detectAgentFromStream(r.id, r.data);
                        this._pollDirty.add(r.id);
                    }
                }
            }
            // HELLO fires on a genuine page load AND on every transparent WS
            // auto-reconnect (sleep/flaky wifi). On reconnect this.activeId is
            // already set, so KEEP the tab the user is viewing instead of
            // jumping to the session-global activeId (which another device may
            // have moved). Only a fresh load (activeId still null) adopts the
            // server's last-viewed tab.
            const keepLocal = this.activeId != null && tabs.some(t => t.id === this.activeId);
            const target = keepLocal ? this.activeId
                : (activeId && tabs.some(t => t.id === activeId)) ? activeId : tabs[0].id;
            this._activate(target);
            // Tell the PTY what width we actually ended up at. _activate's
            // fitNow goes through the debounced _onResize (60ms) — good for
            // drag bursts but too slow here: the first prompt the server
            // paints after reload would be at its old cols. Send now so
            // the user's next command lines up with the measured grid.
            const rt = this.tabs.get(target);
            if (rt && rt._opened) {
                this.bridge.input(INPUT_KIND.TERM_RESIZE, { id: target, cols: rt.term.cols, rows: rt.term.rows });
            }
            this._syncTabsUI(tabs);
            // Run agent status detection after HELLO so colors are correct
            // on first load — force a detection pass on all stream buffers
            // (the throttle would have skipped most tabs during replay).
            setTimeout(() => {
                if (this._streamBuf) {
                    for (const [tid] of this._streamBuf) {
                        this._detectAgentFromStream(tid, '', true);
                    }
                }
                this._pollAgentStatus();
                // Authoritative seed for every tab (incl. ones never opened).
                this._pullServerStatus();
            }, 300);
        } else {
            // First connect with no existing tabs: this device is creating the
            // session's only tab. No intent needed — the ensuing snapshot has
            // activeId still null locally, so the initial-load branch focuses
            // the sole new tab.
            this.bridge.input(INPUT_KIND.NEW_TAB, this._sendSize());
        }
    }

    // A background tab's scrollback, streamed one frame per tab right after
    // HELLO (the active tab's scrollback rides inline with HELLO). Same handling
    // as a HELLO replay entry — queue-until-fit rather than the live term-data
    // path, so absolute-column escapes in the scrollback don't land at 80×24
    // before the tab is sized. Flush immediately if it's the tab on screen.
    _onReplay({ id, data }) {
        if (id == null || !data) return;
        const rt = this.tabs.get(id);
        if (!rt) return;
        rt.queueReplay(data);
        this._detectAgentFromStream(id, data);
        this._pollDirty.add(id);
        if (id === this.activeId) rt.flushPendingReplay();
    }

    _onSnapshot({ tabs, activeId, graveyard, connectedDevices }) {
        this._updateGraveyard(graveyard);
        if (!Array.isArray(tabs)) return;
        const known = new Set(tabs.map(t => t.id));
        for (const id of Array.from(this.tabs.keys())) if (!known.has(id)) this._removeTab(id);
        for (const t of tabs) this._ensureTab(t.id, t.title);
        // Snapshot is the authoritative order: a MOVE_TAB from this client, or
        // from another device sharing the session, must reorder the local tab
        // bar. _ensureTab only appends new ids, so adopt the snapshot order.
        this.order = tabs.map(t => t.id);
        this._syncTabsUI(tabs);
        // Per-device active tab: do NOT follow the session-global activeId on
        // routine snapshots. Adopt it only when (a) this is effectively initial
        // load — local activeId is still null, so there is nothing to disturb —
        // or (b) this device just sent NEW_TAB/RESTORE_TAB and this snapshot
        // names the genuinely new tab (an id absent from the set we captured
        // when we acted). Matching the NEW id rather than "any valid activeId"
        // means a racing cwd-poll/device-count/foreign-switch snapshot carrying
        // the old-but-still-valid activeId cannot burn the intent.
        const serverActiveValid = !!(activeId && this.tabs.has(activeId));
        if (this.activeId == null) {
            // Fresh page / reload: restore the last-viewed tab.
            this._adoptNewTabIds = null;
            const initial = serverActiveValid ? activeId : (tabs[0] ? tabs[0].id : null);
            if (initial && initial !== this.activeId) this._activate(initial);
        } else if (this._adoptNewTabIds && serverActiveValid && !this._adoptNewTabIds.has(activeId)) {
            // This device created/restored a tab and this is its new id — focus it.
            this._adoptNewTabIds = null;
            if (activeId !== this.activeId) this._activate(activeId);
        } else if (!this.tabs.has(this.activeId)) {
            // The tab we were viewing disappeared from the snapshot (closed,
            // possibly by another device): fall back locally to the first tab.
            const fallback = tabs[0] ? tabs[0].id : null;
            if (fallback) this._activate(fallback); else this.activeId = null;
        }
        // Otherwise keep the user's current local active tab untouched.
        const tabsEl = $('#status-tabs');
        const tabsKey = tabs.length === 1 ? 'status.tabs_one' : 'status.tabs_other';
        tabsEl.textContent = tr(tabsKey, { n: tabs.length });
        tabsEl.setAttribute('data-i18n', tabsKey);
        tabsEl.setAttribute('data-i18n-vars', JSON.stringify({ n: tabs.length }));
        this._updateDeviceCount(connectedDevices);
        // Run the full agent-status scan once, on the first snapshot, so
        // colors are right on initial load. Later snapshots fire on every
        // cwd/title change and carry NO terminal bytes, so a full N-tab regex
        // sweep here finds nothing the 500ms dirty-gated _pollCtxLines loop
        // won't already catch — and it defeats that dirty gate.
        if (!this._didInitialStatusScan) {
            this._didInitialStatusScan = true;
            setTimeout(() => this._pollAgentStatus(), 150);
        }
    }

    _updateDeviceCount(count) {
        const el = $('#status-devices');
        if (!el) return;
        if (count == null || count < 2) {
            el.style.display = 'none';
            return;
        }
        el.style.display = '';
        const key = count === 1 ? 'status.devices_one' : 'status.devices_other';
        el.textContent = tr(key, { n: count });
        el.setAttribute('data-i18n', key);
        el.setAttribute('data-i18n-vars', JSON.stringify({ n: count }));
    }

    // A tab is "live" (parses straight into xterm) only when its terminal is
    // actually on screen — its container carries .active (the active tab in
    // tabs view, or the expanded tile). Everything else buffers and replays on
    // switch. The .active class is the single source of truth across all views.
    _isLiveTab(id) {
        if (this._noVirtualize) return true;
        const rt = this.tabs.get(id);
        return !!(rt && rt.container && rt.container.classList.contains('active'));
    }

    _onTermData({ id, data }) {
        const t = this.tabs.get(id);
        if (t) {
            // Virtualization: only the on-screen terminal parses live into xterm;
            // hidden tabs buffer the raw bytes and catch up via flushPendingReplay
            // on switch — so many sessions run ~1 live ANSI parser, not N. Status
            // and ctx% still update from the raw stream (below), so background tab
            // colours/preview stay live without parsing the full grid.
            if (this._isLiveTab(id)) t.write(data);
            else t.queueReplay(data);
        }
        // Extract OSC 0/2 title sequences from the raw stream. xterm.js's
        // onTitleChange can miss titles when data arrives in chunks that split
        // the escape sequence, so always parse here as the primary source.
        // Only pay the OSC-title scan when an OSC sequence is actually present
        // (or we're mid-sequence from a prior chunk) — skips a regex + string
        // concat on the vast majority of output chunks across all tabs.
        if (t && (data.indexOf('\x1b]') !== -1 || (this._oscBuf && this._oscBuf.get(id)))) {
            if (!this._oscBuf) this._oscBuf = new Map();
            let buf = (this._oscBuf.get(id) || '') + data;
            const m = buf.match(/\x1b\](?:0|2);([^\x07\x1b]*?)(?:\x07|\x1b\\)/);
            if (m && m[1]) {
                this.bridge.input(INPUT_KIND.SET_TITLE, { id, title: m[1] });
                buf = buf.slice(buf.indexOf(m[0]) + m[0].length);
            }
            // Keep trailing partial OSC (starts with \x1b] but no terminator yet)
            const partial = buf.match(/\x1b\](?:0|2);[^\x07\x1b]*$/);
            this._oscBuf.set(id, partial ? partial[0] : '');
        }
        this._detectAgentFromStream(id, data);
        this._pollDirty.add(id);   // new output → re-scan status/context next tick
        // Throttle stdout cue per-tab so heavy output from one shell doesn't
        // gun-machine the speakers, but two tabs streaming in parallel can
        // still overlap into the Web Audio mixer like crossfire. The tab id
        // is passed through to the engine so its own per-source throttle
        // stays scoped too — a single scalar there would clip the second
        // tab's voice even after our 180ms gate let it through.
        const now = performance.now();
        const last = this._lastStdoutCue.get(id) || 0;
        if (now - last > 180) {
            this._lastStdoutCue.set(id, now);
            this.audio.play('stdout', 'tab' + id);
        }
    }

    _onTermExit({ id, code }) {
        const t = this.tabs.get(id);
        if (t) t.write(`\r\n\x1b[2m${tr('tab.exited', { code })}\x1b[0m\r\n`);
        this.audio.play(code === 0 ? 'info' : 'alarm');
    }

    _ensureTab(id, title) {
        const existing = this.tabs.get(id);
        if (existing) {
            // Server owns titles — it follows cwd changes and applies the
            // -N disambiguation suffix. Adopt whatever the snapshot says so
            // a later _syncTabsUI() call with no list argument doesn't fall
            // back to a stale cached title.
            if (title && existing.title !== title) existing.title = title;
            return existing;
        }
        const rt = new TabRuntime(id, title);
        this.termsEl.appendChild(rt.container);
        rt.attach(
            data => this.bridge.input(INPUT_KIND.TERM_KEYS, { id, text: data }),
            (cols, rows) => this.bridge.input(INPUT_KIND.TERM_RESIZE, { id, cols, rows }),
            t => this.bridge.input(INPUT_KIND.SET_TITLE, { id, title: t }),
        );
        this.tabs.set(id, rt);
        this.order.push(id);
        return rt;
    }

    _removeTab(id) {
        const t = this.tabs.get(id);
        if (!t) return;
        t.dispose();
        this.tabs.delete(id);
        this.order = this.order.filter(x => x !== id);
        // Drop per-tab detector state so a reused id starts fresh and any
        // pending status transition timer doesn't fire against a dead tab.
        const det = this._agentBuf.get(id);
        if (det && det.pending) clearTimeout(det.pending);
        this._agentBuf.delete(id);
        this._agentStatus.delete(id);
        this._lastStdoutCue.delete(id);
        this._ctxPct.delete(id);
        if (this.activeId === id) {
            const next = this.order[0];
            if (next) this._activate(next); else this.activeId = null;
        }
    }

    _activate(id) {
        const switching = this.activeId !== id && this.activeId != null;
        const sameTab = this.activeId === id;
        this.activeId = id;
        if (this.viewMode === 'tiles') {
            this._openTileTerminal(id);
        } else {
            for (const [tid, rt] of this.tabs) {
                rt.container.classList.toggle('active', tid === id);
            }
            const rt = this.tabs.get(id);
            if (rt) {
                rt.fitNow();
                rt.flushPendingReplay();
                rt.scrollToBottom();
                rt.focus();
                // flushPendingReplay paints the grid without going through
                // _onTermData, so seed the dirty flag to re-scan ctx%/status on
                // the next tick instead of waiting for the ~8s full sweep.
                this._pollDirty.add(id);
            }
        }
        if (!sameTab) this.bridge.input(INPUT_KIND.SWITCH_TAB, { id });
        this._syncTabsUI();
        if (switching && this.viewMode !== 'tiles') this.audio.play('panels');
    }

    _syncTabsUI(list) {
        const tabs = list || this.order.map(id => ({ id, title: (this.tabs.get(id) || {}).title }));
        // agentStatus is intentionally NOT folded into this signature: status
        // changes are applied as a targeted data-agent attribute swap in
        // _setStatus, so including it here would rebuild all N tab buttons on
        // every working↔done flip. Only structural changes (set/title/active)
        // bust the row cache.
        const signature = tabs.map(t => `${t.id}:${t.title || ''}`).join('|') + '#' + (this.activeId || 0);
        if (signature === this._tabsUISig) return;
        this._tabsUISig = signature;
        // replaceChildren destroys the old tab buttons, which resets the
        // tab row's scrollLeft to 0. Snapshot + restore so that a status
        // color change or a title update doesn't slam the row back to the
        // first tab while the user is looking at the end of a long list.
        const savedScrollLeft = this.tabsEl.scrollLeft;
        this.tabsEl.replaceChildren(...tabs.map(t => {
            const label = el('span', {
                class: 'tab-label',
                title: tr('tab.rename_hint') || 'Double-click to rename',
                text: t.title || tr('tab.default', { id: t.id }),
                ondblclick: (e) => { e.stopPropagation(); this._promptRename(t.id, t.title); },
            });
            // Dim second line: a live peek at this tab's last output line so
            // tabs with default / near-identical titles are still tellable
            // apart. Updated in place by _updateTabPreview (no row rebuild).
            const sub = el('span', { class: 'tab-sub', text: this._tabPreview(t.id) });
            const main = el('span', { class: 'tab-main' }, [label, sub]);
            const dot = this._makeCtxBar(this._ctxPct.get(t.id) || 0, t.id);
            const x = el('span', { class: 'x', text: '×', onclick: (e) => {
                e.stopPropagation();
                this._requestCloseTab(t.id);
            }});
            const root = el('button', {
                class: 'tab' + (t.id === this.activeId ? ' active' : ''),
                'data-agent': this._agentStatus.get(t.id) || '',
                'data-tab-id': String(t.id),
                draggable: 'true',
                onclick: () => this._activate(t.id),
                oncontextmenu: (e) => { e.preventDefault(); this._promptRename(t.id, t.title); },
            }, [dot, main, x]);
            this._attachTabDrag(root, t.id);
            this._attachTabLongPress(root, t.id);
            return root;
        }));
        this.tabsEl.scrollLeft = savedScrollLeft;
        // Only pull the active tab into view when the active *id* actually
        // changed — scrolling on every status/title re-render is what was
        // snapping the row left. We compare against the last id we scrolled
        // for, not this.activeId, because activeId can stay the same across
        // many _syncTabsUI calls.
        if (this.activeId != null && this._lastScrolledActiveId !== this.activeId) {
            this._lastScrolledActiveId = this.activeId;
            const activeNode = this.tabsEl.querySelector(`[data-tab-id="${CSS.escape(String(this.activeId))}"]`);
            if (activeNode && typeof activeNode.scrollIntoView === 'function') {
                try { activeNode.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'auto' }); } catch (_) {}
            }
        }
        this._installTabsDrop();
        if (this.viewMode === 'tiles') this._renderTiles();
    }

    // Context consumption at a glance: green (healthy) → yellow → red (near full).
    _ctxColor(pct) {
        return pct >= 80 ? '#ff5555' : pct >= 50 ? '#f1c40f' : '#2ecc71';
    }

    // Context as a vertical fuel-gauge: a thin full-height bar that fills from
    // the bottom by consumption %, colored green→yellow→red. Narrower than the
    // old circular pie (reclaims tab-row width) and uses the full tab height, so
    // the reading is legible at a glance instead of a 10px dot.
    _makeCtxBar(pct, tabId) {
        const color = this._ctxColor(pct);
        const span = el('span', {
            class: 'ctx-bar',
            title: pct > 0 ? `Context: ${pct}%\nClick for details` : 'Context: —',
            onclick: (e) => { e.stopPropagation(); this._showCtxModal(tabId, pct); }
        });
        // Fill the bottom pct% with the health color; hard stop so it reads as a
        // bar level rather than a fade. Empty → just the faint track.
        span.style.background = pct <= 0
            ? 'rgba(255,255,255,0.15)'
            : `linear-gradient(to top, ${color} ${pct}%, rgba(255,255,255,0.15) ${pct}%)`;
        return span;
    }

    _updateCtxBar(id, pct) {
        const node = this.tabsEl.querySelector(`[data-tab-id="${CSS.escape(String(id))}"] .ctx-bar`);
        if (!node) { this._tabsUISig = null; this._syncTabsUI(); return; }
        node.replaceWith(this._makeCtxBar(pct, id));
    }

    // One-line peek at what a tab last emitted, shown as the tab's dim subtitle.
    // Prefers the live "Thinking…/Running…" status line while the agent works
    // (that IS the latest output then); otherwise the last meaningful output
    // line; otherwise the detector's activity label. Capped for the strip.
    _tabPreview(id) {
        const s = this._agentBuf && this._agentBuf.get(id);
        if (this._agentStatus.get(id) === 'working' && s && s.statusLine) {
            return s.statusLine.slice(0, 64);
        }
        const line = this._lastMeaningfulLine(id);
        if (line) return line.slice(0, 64);
        if (s && s.activity) return s.activity.slice(0, 64);
        return '';
    }

    // Last non-blank, non-chrome line of a tab's output. Reads the real xterm
    // buffer when the tab has been opened (gold source); falls back to the
    // always-fed raw stream window so tabs never visited in this view still
    // get a preview. Skips box frames, the empty input prompt, and CC footers.
    _lastMeaningfulLine(id) {
        const skip = (t) =>
            !t ||
            /^[\s│┃─━╭╮╰╯┄┈·•>]+$/.test(t) ||          // box frame / bare prompt marks
            /^\?\s+for\s+shortcuts/i.test(t) ||         // Claude Code footer hint
            /^│\s*>/.test(t);                            // Claude Code input prompt row
        const rt = this.tabs.get(id);
        // Only the tab you're actually looking at pays the ~60-row buffer scan;
        // back-tabs derive their preview from the cheap raw-stream window below.
        // With many sessions this keeps the 500ms poll off the heavy path.
        if (rt && rt._opened && id === this.activeId) {
            try {
                const buf = rt.term.buffer.active;
                const end = buf.baseY + rt.term.rows;
                for (let row = end - 1; row >= 0 && row > end - 60; row--) {
                    const ln = buf.getLine(row);
                    if (!ln) continue;
                    const t = ln.translateToString(true).replace(/\s+$/, '').trim();
                    if (!skip(t)) return t;
                }
            } catch (_) {}
        }
        const sb = this._streamBuf && this._streamBuf.get(id);
        if (sb && sb.recent) {
            // Raw PTY bytes — strip ALL escape families before reading text, or
            // window-title (OSC), keypad, and parameterized CSI sequences leak
            // into the preview as garbage. xterm's buffer path above is already
            // parsed; this fallback must parse here. OSC accepts BOTH the BEL
            // and ST (ESC \) terminators — the same dual form the title reader
            // elsewhere in this file handles.
            const clean = sb.recent
                .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')   // OSC … BEL | ST (titles)
                .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, '')        // DCS / PM / APC / SOS … ST
                .replace(/\x1b\[[0-9;?>=!]*[ -/]*[@-~]/g, '')    // CSI: params + intermediates + final
                .replace(/\x1b[()*+#][0-9A-Za-z]/g, '')          // charset designation
                .replace(/\x1b[=>78cMno|}~]/g, '')               // misc 2-char ESC (keypad, save/restore)
                .replace(/\r/g, '\n')
                .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // stray control bytes (keep \t \n)
            const lines = clean.split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                const t = lines[i].replace(/\s+$/, '').trim();
                if (!skip(t)) return t;
            }
        }
        return '';
    }

    // Refresh just the subtitle text for one tab, in place — no row rebuild.
    _updateTabPreview(id) {
        const node = this.tabsEl.querySelector(`[data-tab-id="${CSS.escape(String(id))}"] .tab-sub`);
        if (!node) return;
        const text = this._tabPreview(id);
        if (node.textContent !== text) node.textContent = text;
    }

    _showCtxModal(tabId, pct) {
        // Remove any existing popover
        document.getElementById('ctx-popover')?.remove();

        const pie = this.tabsEl.querySelector(`[data-tab-id="${CSS.escape(String(tabId))}"] .ctx-bar`);
        if (!pie) return;

        const bar = pct > 0
            ? `<div class="ctx-pop-bar"><div class="ctx-pop-fill" style="width:${pct}%;background:${this._ctxColor(pct)}"></div></div>`
            : '';
        const note = pct > 0
            ? `<p class="ctx-pop-note">Token counts &amp; cost are not exposed in terminal output. Run <code>/cost</code> inside Claude Code for a session summary.</p>`
            : `<p class="ctx-pop-note">No data yet. Claude Code prints context % in its status bar once a session starts.</p>`;

        const pop = document.createElement('div');
        pop.id = 'ctx-popover';
        pop.className = 'ctx-popover';
        pop.innerHTML = `<div class="ctx-pop-head"><span>${pct > 0 ? `Context: ${pct}%` : 'Context: —'}</span><button class="ctx-pop-close">×</button></div>${bar}${note}`;
        document.body.appendChild(pop);

        // Position below the pie chip
        const r = pie.getBoundingClientRect();
        pop.style.left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8) + 'px';
        pop.style.top  = (r.bottom + 6) + 'px';

        const dismiss = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', dismiss, true); } };
        pop.querySelector('.ctx-pop-close').onclick = () => { pop.remove(); document.removeEventListener('pointerdown', dismiss, true); };
        setTimeout(() => document.addEventListener('pointerdown', dismiss, true), 0);
    }

    _pollCtxLines() {
        // Don't burn the main thread scanning 16 terminals while the page is in
        // a background tab — resume with a full sweep once it's foregrounded.
        if (document.hidden) { this._pollWasHidden = true; return; }
        // Fast path: only re-scan tabs that emitted output since the last tick.
        // Full sweep every ~8s (and on return from hidden) guarantees eventual
        // consistency even if a dirty-seed site is ever missed.
        const full = this._pollWasHidden || (++this._pollTickN % 16 === 0);
        this._pollWasHidden = false;
        for (const [id, rt] of this.tabs) {
            if (!full && !this._pollDirty.has(id)) continue;
            this._pollDirty.delete(id);
            if (rt._opened) {
                try {
                    const pct = this._extractCtxPct(rt);
                    if (pct !== null && pct !== this._ctxPct.get(id)) {
                        this._ctxPct.set(id, pct);
                        this._updateCtxBar(id, pct);
                        if (this.viewMode === 'tiles') {
                            const tnode = this._tilesGridEl && this._tilesGridEl.querySelector(`[data-tile-id="${id}"] .tile-pie`);
                            if (tnode) this._paintTilePie(tnode, pct);
                        }
                        this.bridge.input(INPUT_KIND.CTX_REPORT, { id, pct });
                    }
                } catch (_) {}
                this._pollAgentStatusForTab(id);
            } else {
                // Tiles mode / unopened xterm: re-run detection on the buffer.
                this._detectAgentFromStream(id, '', true);
            }
            // Keep the tab strip's subtitle in step with fresh output.
            this._updateTabPreview(id);
        }
    }

    // Pull Claude Code's context reading out of the live screen. Claude prints
    // it in the status footer, but the exact wording and row vary by version
    // and terminal height — so scan the whole visible screen (bottom-up, footer
    // first) and try several phrasings. "used" forms are consumption directly;
    // "left / remaining / until auto-compact" forms are the inverse. Returns a
    // 0–100 integer or null when nothing on screen reports context.
    _extractCtxPct(rt) {
        const buf = rt.term.buffer.active;
        const end = buf.baseY + rt.term.rows;            // exclusive bottom
        const top = Math.max(0, end - rt.term.rows);     // whole visible screen
        for (let row = end - 1; row >= top; row--) {
            const line = buf.getLine(row);
            if (!line) continue;
            const t = line.translateToString(true);
            if (!t || t.indexOf('%') === -1) continue;
            let m;
            // consumption (used) — tolerate missing spaces in custom statuslines
            if ((m = t.match(/(\d{1,3})\s*%\s*context\s*used/i)))                        return this._clampPct(+m[1]);
            if ((m = t.match(/context\s*used\s*[:\-]?\s*(\d{1,3})\s*%/i)))                return this._clampPct(+m[1]);
            if ((m = t.match(/context\s+is\s+(\d{1,3})\s*%/i)))                          return this._clampPct(+m[1]);
            // remaining (left / until auto-compact) → invert
            if ((m = t.match(/(\d{1,3})\s*%\s+(?:left\s+)?until\s+auto-?compact/i)))     return this._clampPct(100 - +m[1]);
            if ((m = t.match(/(?:left|remaining)\s+until\s+auto-?compact\s*[:\-]?\s*(\d{1,3})\s*%/i))) return this._clampPct(100 - +m[1]);
            if ((m = t.match(/context\s+left\s*[:\-]?\s*(\d{1,3})\s*%/i)))               return this._clampPct(100 - +m[1]);
            if ((m = t.match(/(\d{1,3})\s*%\s+context\s+(?:left|remaining)/i)))          return this._clampPct(100 - +m[1]);
            if ((m = t.match(/context\s+low\s*\(\s*(\d{1,3})\s*%/i)))                    return this._clampPct(100 - +m[1]);
            // custom statusline gauge: a block-bar followed by NN% is the context
            // meter (e.g. "(1Mcontext) … ███████░░░71%"). Trust it when the line
            // mentions context; the filled bar represents consumption.
            if (/context/i.test(t) && (m = t.match(/[█▓▒░]\s*(\d{1,3})\s*%/)))  return this._clampPct(+m[1]);
            if ((m = t.match(/[█▓▒░]{3,}\s*(\d{1,3})\s*%/)))                    return this._clampPct(+m[1]);
            // generic "context … NN%" — assume consumption, lowest priority
            if ((m = t.match(/context[^%\d]{0,24}?(\d{1,3})\s*%/i)))                     return this._clampPct(+m[1]);
        }
        return null;
    }

    _clampPct(n) { return Math.min(100, Math.max(0, Math.round(n))); }

    // Stream-based agent detection. Runs on every TERM_DATA chunk — checks the
    // raw bytes for Claude Code TUI signals. This is the primary detector;
    // the buffer-based poll is a fallback for initial load / missed chunks.
    //
    // We keep a small sliding window of recent data per tab (last ~2KB) so we
    // can detect multi-chunk patterns (e.g. the boxed prompt arrives across
    // two frames). The window is reset when a state transition is confirmed.
    _detectAgentFromStream(id, data, forceNow) {
        if (!this._streamBuf) this._streamBuf = new Map();
        let sb = this._streamBuf.get(id);
        if (!sb) { sb = { recent: '', lastDetect: 0 }; this._streamBuf.set(id, sb); }

        sb.recent += data;
        if (sb.recent.length > 2048) sb.recent = sb.recent.slice(-1500);

        // Throttle: at most one detection per 200ms for the tab you're looking
        // at; back-tabs run far less often (~700ms) since their status only
        // feeds the strip colour, and the periodic full-sweep poll backstops
        // them. With ~18 sessions this is the bulk of the saved regex work.
        const now = performance.now();
        const minGap = (id === this.activeId) ? 200 : 700;
        if (!forceNow && now - sb.lastDetect < minGap) return;
        sb.lastDetect = now;

        // Strip ANSI escape sequences for pattern matching
        const clean = sb.recent.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
                               .replace(/\x1b\][^\x07]*\x07/g, '')
                               .replace(/\x1b[()][AB012]/g, '')
                               .replace(/\x1b\x5b[0-9;]*[mGHJKfsu]/g, '');

        let next = null;
        let activity = '';

        // Working signals — these appear in the stream while Claude is active
        const workingSignals = [
            /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
            /esc to interrupt/i,
            /\(esc\s+to\s+cancel\)/i,
            /✳/,
        ];
        const workingVerbs = /\b(Thinking|Pondering|Crafting|Running|Executing|Processing|Working|Reading|Writing|Editing|Searching|Fetching|Analyzing|Planning|Compiling|Installing|Building|Testing|Formatting|Linting|Deploying|Pushing|Pulling|Generating|Updating|Checking|Scanning|Resolving|Compacting|Streaming|Connecting|Waiting|Loading|Preparing|Initializing|Starting|Applying|Committing|Merging|Rebasing|Diffing)\b[.…]/i;

        // Check last 500 chars for working signals (recent activity)
        const tail = clean.slice(-500);

        // Error signals win over everything — an API/connection failure (model
        // switch, internet drop, provider outage) must be unmistakably RED, per
        // the status-color rule (red = stuck/broken, not merely awaiting input).
        // Auto-clears once real output resumes and the error scrolls out.
        const errorPatterns = [
            /API Error\b/i,
            /Unable to connect to API/i,
            /\bECONNREFUSED\b/,
            /\bConnection\s*Refused\b/i,
            /\bConnection error\b/i,
            /\bfetch failed\b/i,
            /\boverloaded_error\b/i,
        ];
        if (errorPatterns.some(p => p.test(tail))) {
            next = 'error';
            activity = 'API error';
        }

        if (!next && workingSignals.some(p => p.test(tail))) {
            next = 'working';
            const vm = tail.match(workingVerbs);
            activity = vm ? vm[1] + '...' : 'Working...';
        } else if (!next && workingVerbs.test(tail)) {
            next = 'working';
            const vm = tail.match(workingVerbs);
            activity = vm ? vm[1] + '...' : 'Working...';
        }

        // Attention signals — permission prompts, interactive questions
        if (!next) {
            // Attention = the agent genuinely needs a decision: an explicit
            // choice/permission prompt. Deliberately NARROW — idle input-box
            // placeholders ("Try …", "Type something", "Chat about this") and
            // prose that merely mentions approve/confirm are NOT attention; they
            // fall through to done/idle. (Old over-broad /\bApprove\b/, the
            // placeholder strings, and /press .* to confirm/ caused false reds.)
            const attentionPatterns = [
                /❯\s*(?:Yes|No|Allow once|Allow always|Deny|Accept|Reject)\b/i,
                /❯\s*\d+\.\s*(?:Yes|No|Allow|Deny|Accept|Reject)/i,
                /─{10,}[\s\S]{0,200}☐/,
                /☐\s+\S+[\s\S]{0,300}❯\s+\d+\./,
                /Do you want to (?:proceed|continue|make this change|accept|create|run|overwrite|delete)/i,
                /\(y\/n\)/i,
                /\[Y\/n\]/i,
                /\(Y\)es\s*\/\s*\(N\)o/i,
                /Allow\s+(?:Read|Write|Edit|Bash|Execute|NotebookEdit|WebFetch|WebSearch|Agent|LSP|Monitor)\b/i,
                /\bPermission\s+(?:required|needed)\b/i,
            ];
            if (attentionPatterns.some(p => p.test(tail))) {
                next = 'attention';
                activity = 'Needs input';
            }
        }

        // Done signals — the boxed input prompt or bypass-mode idle
        if (!next) {
            const donePatterns = [
                /╭─+╮/,
                /│\s*>\s*│/,
                /╰─+╯/,
                /│\s*>\s*$/m,
                /BYPASS PERMISSIONS\s+ON/i,
            ];
            if (donePatterns.some(p => p.test(tail))) {
                next = 'done';
                activity = 'Awaiting next prompt';
            }
        }

        // Shell prompt detection — transition to idle when we see a prompt
        if (!next) {
            const shellPrompt = /(?:^|\n)[^\n]{0,80}?(?:[➜❯▶►»](?:\s|$)|[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+[^\n]*[\$#%]\s*$)/m;
            const lastLines = tail.slice(-200);
            if (shellPrompt.test(lastLines)) {
                const current = this._agentStatus.get(id);
                if (current && current !== 'idle') {
                    next = 'idle';
                    activity = '';
                }
            }
        }

        if (!next) return;

        // Debug logging
        if (id === this.activeId && window.__SOA_DEBUG_AGENT) {
            console.log(`[stream-detect] tab=${id} next=${next} activity="${activity}" tail=`, JSON.stringify(tail.slice(-200)));
        }

        // Apply the detected status
        const current = this._agentStatus.get(id) || 'idle';
        if (next === current) return;

        // Update activity info
        let s = this._agentBuf.get(id);
        if (!s) {
            s = { buf: '', status: 'idle', pending: null, pendingStatus: null, lastChange: 0, activity: '', lastLine: '', statusLine: '', actionLine: '' };
            this._agentBuf.set(id, s);
        }
        if (activity) s.activity = activity;

        // Working and attention are urgent — apply with minimal delay
        // Done needs a short debounce to avoid flicker from partial renders
        const delay = (next === 'working' || next === 'attention' || next === 'error') ? 50 : 300;

        if (s.pendingStatus === next) return;
        if (s.pending) clearTimeout(s.pending);
        s.pendingStatus = next;
        s.pending = setTimeout(() => {
            s.pending = null;
            s.pendingStatus = null;
            this._setStatus(id, next);
            // Reset stream buffer on confirmed transition to avoid re-detecting
            // stale patterns
            sb.recent = '';
        }, delay);
    }

    // Read the last N visible lines from the terminal buffer to detect agent
    // state. This is a fallback/confirmation for the stream-based detector —
    // it catches states on initial load and corrects drift.
    _pollAgentStatus() {
        for (const [id, rt] of this.tabs) {
            if (rt._opened) {
                this._pollAgentStatusForTab(id);
            } else {
                // For tabs without an open xterm (tiles mode), re-run stream
                // detection on the accumulated buffer as a fallback.
                this._detectAgentFromStream(id, '', true);
            }
        }
    }

    // Pull the server supervisor's view — status + ctx% for EVERY tab, derived
    // from each PTY stream server-side — and apply it locally. This is what
    // makes all tiles/tabs show correct status on startup instead of only the
    // tabs you've opened. One authed in-memory GET; cheap to repeat.
    async _pullServerStatus() {
        let j;
        try {
            const r = await fetch('/api/manager', { credentials: 'same-origin', cache: 'no-store' });
            if (!r.ok) return;
            j = await r.json();
        } catch (_) { return; }
        if (!j || !Array.isArray(j.sessions)) return;
        for (const sess of j.sessions) {
            const id = sess.id;
            const rt = this.tabs.get(id);
            if (!rt) continue;
            // The tab you're actively viewing is owned by live (sub-second)
            // client-side detection — don't let the 4s pull fight it.
            if (id === this.activeId && rt._opened && this.viewMode !== 'tiles') continue;
            if (sess.status) this._setStatus(id, sess.status);
            if (sess.ctxPct != null && sess.ctxPct !== this._ctxPct.get(id)) {
                this._ctxPct.set(id, sess.ctxPct);
                this._updateCtxBar(id, sess.ctxPct);
                if (this.viewMode === 'tiles' && this._tilesGridEl) {
                    const tnode = this._tilesGridEl.querySelector(`[data-tile-id="${id}"] .tile-pie`);
                    if (tnode) this._paintTilePie(tnode, sess.ctxPct);
                }
            }
        }
        this._statusSeeded = true;
    }

    // Ask for OS notification permission on the first user gesture (Safari and
    // others reject requestPermission() without one). Non-intrusive: hooks the
    // next pointerdown anywhere, once.
    _armNotifications() {
        if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
        const ask = () => {
            document.removeEventListener('pointerdown', ask);
            try { Notification.requestPermission().catch(() => {}); } catch (_) {}
        };
        document.addEventListener('pointerdown', ask, { once: true });
    }

    _getDetector() {
        return this._detector || (this._detector = {
            working: [
                /esc to interrupt/i,
                /\(esc\s+to\s+cancel\)/i,
                /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,
                /✳\s*\S/,
                /\b(?:Thinking|Pondering|Crafting|Running|Executing|Processing|Working|Reading|Writing|Editing|Searching|Fetching|Analyzing|Wrangling|Brewing|Planning|Compiling|Installing|Building|Testing|Formatting|Linting|Deploying|Pushing|Pulling|Cloning|Downloading|Uploading|Generating|Updating|Checking|Scanning|Indexing|Resolving|Compacting|Streaming|Connecting|Waiting|Loading|Preparing|Initializing|Starting|Applying|Committing|Merging|Rebasing|Diffing)\b[.…]/i,
                /\b(?:Thinking|Pondering|Crafting|Running|Executing|Processing|Working|Reading|Writing|Editing|Searching|Fetching|Analyzing|Wrangling|Brewing|Planning|Compiling|Installing|Building|Testing|Formatting|Linting|Deploying|Pushing|Pulling|Cloning|Downloading|Uploading|Generating|Updating|Checking|Scanning|Indexing|Resolving|Compacting|Streaming|Connecting|Waiting|Loading|Preparing|Initializing|Starting|Applying|Committing|Merging|Rebasing|Diffing)\b.*[…⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/i,
            ],
            error: [
                /API Error\b/i,
                /Unable to connect to API/i,
                /\bECONNREFUSED\b/,
                /\bConnection\s*Refused\b/i,
                /\bConnection error\b/i,
                /\bfetch failed\b/i,
                /\boverloaded_error\b/i,
            ],
            done: [
                /╭─+╮[\s\S]*│\s*>/,
                /╰─+╯/,
                /│\s*>\s*│/,
                /│\s*>\s*$/m,
                /BYPASS PERMISSIONS\s+ON/i,
            ],
            // See the stream detector above: attention is narrow — only genuine
            // choice/permission prompts. Idle placeholders and prose that just
            // mentions approve/confirm must NOT trigger a red status.
            attention: [
                /❯\s+(?:Yes|No|Allow once|Allow always|Deny|Accept|Reject)\b/i,
                /❯\s*\d+\.\s*(?:Yes|No|Allow|Deny|Accept|Reject)/i,
                /─{10,}[\s\S]{0,200}☐/,
                /☐\s+\S+[\s\S]{0,300}❯\s+\d+\./,
                /Do you want to (?:proceed|continue|make this change|accept|create|run|overwrite|delete)/i,
                /\(y\/n\)/i,
                /\[Y\/n\]/i,
                /\(Y\)es\s*\/\s*\(N\)o/i,
                /Allow\s+(?:Read|Write|Edit|Bash|Execute|NotebookEdit|WebFetch|WebSearch|Agent|LSP|Monitor)\b/i,
                /\bPermission\s+(?:required|needed)\b/i,
            ],
            shellPrompt: /(?:^|\n)[^\n]{0,80}?(?:[➜❯▶►»](?:\s|$)|[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+[^\n]*[\$#%]\s*$)/m,
        });
    }

    _pollAgentStatusForTab(id) {
        const DET = this._getDetector();
        const rt = this.tabs.get(id);
        if (!rt || !rt._opened) return;
        // If the stream detector recently fired for this tab, skip the buffer
        // poll to avoid conflicting state transitions.
        if (this._streamBuf) {
            const sb = this._streamBuf.get(id);
            if (sb && performance.now() - sb.lastDetect < 600) return;
        }
        try {
            const buf = rt.term.buffer.active;
            const totalRows = rt.term.rows;
            const startRow = buf.baseY + Math.max(0, totalRows - 20);
            const endRow = buf.baseY + totalRows;
            let visible = '';
            for (let r = startRow; r < endRow; r++) {
                const line = buf.getLine(r);
                if (line) visible += line.translateToString(true) + '\n';
            }
            if (!visible.trim()) return;

            // Debug: log buffer content for active tab (open DevTools console)
            if (id === this.activeId && window.__SOA_DEBUG_AGENT) {
                console.log(`[agent-detect] tab=${id} visible=`, JSON.stringify(visible.split('\n').map((l,i) => `${i}: ${l}`)));
            }

            // Bottom lines for attention/done detection — AskUser UI can be
            // 15+ lines tall, so use a wider window for attention checks.
            const visibleLines = visible.split('\n');
            const bottomLines = visibleLines.slice(-7).join('\n');
            const bottomWide = visibleLines.slice(-20).join('\n');

            let next;
            let activity = '';
            // Priority: error > working > attention > done > idle. An API/
            // connection failure must surface as RED even while idle (the error
            // sits on screen with no new output to drive the stream detector).
            if (DET.error.some(p => p.test(bottomWide))) {
                next = 'error';
                activity = 'API error';
            } else if (DET.working.some(p => p.test(visible))) {
                next = 'working';
                const vm = visible.match(/\b(Thinking|Pondering|Crafting|Running|Executing|Processing|Working|Reading|Writing|Editing|Searching|Fetching|Analyzing|Wrangling|Brewing|Planning|Compiling|Installing|Building|Testing|Formatting|Linting|Deploying|Pushing|Pulling|Cloning|Downloading|Uploading|Generating|Updating|Checking|Scanning|Indexing|Resolving|Compacting|Streaming|Connecting|Waiting|Loading|Preparing|Initializing|Starting|Applying|Committing|Merging|Rebasing|Diffing)\b/i);
                activity = vm ? vm[1] + '...' : 'Working...';
            } else if (DET.attention.some(p => p.test(bottomWide))) {
                next = 'attention';
                activity = 'Needs input';
                for (const p of DET.attention) {
                    const m = bottomWide.match(p);
                    if (m) { activity = m[0].trim().slice(0, 40); break; }
                }
            } else if (DET.done.some(p => p.test(bottomLines))) {
                next = 'done';
                activity = 'Awaiting next prompt';
            } else if (DET.shellPrompt.test(bottomLines)) {
                next = 'idle';
                activity = '';
            } else {
                next = null;
            }

            // Extract last meaningful line for tile summary
            const lines = visible.split('\n').filter(l => l.trim() && !/^[\s─╰╭│]*$/.test(l));
            const lastLine = lines.length ? lines[lines.length - 1].trim().slice(0, 80) : '';

            // Extract Claude Code status line (e.g. "Thinking… (16s · ↑ 133 tokens)" or "✳ Compacting conversation…")
            const statusLineMatch = visible.match(/✳\s*[^\n]{3,60}/) ||
                visible.match(/\b(?:Thinking|Pondering|Crafting|Running|Executing|Processing|Working|Reading|Writing|Editing|Searching|Fetching|Analyzing|Wrangling|Brewing|Planning|Compiling|Installing|Building|Testing|Formatting|Linting|Deploying|Pushing|Pulling|Cloning|Downloading|Uploading|Generating|Updating|Checking|Scanning|Indexing|Resolving|Compacting|Streaming|Connecting|Waiting|Loading|Preparing|Initializing|Starting|Applying|Committing|Merging|Rebasing|Diffing)\b[.…]*(?:\s*\([^)]*\))?[^\n]*/i);
            const statusLine = statusLineMatch ? statusLineMatch[0].trim().slice(0, 80) : '';

            // Extract current action line (starts with ⏺)
            const actionMatch = visible.match(/⏺\s+(.+)/);
            const actionLine = actionMatch ? actionMatch[1].trim().slice(0, 80) : '';

            let s = this._agentBuf.get(id);
            if (!s) {
                s = { buf: '', status: 'idle', pending: null, pendingStatus: null, lastChange: 0, activity: '', lastLine: '', statusLine: '', actionLine: '' };
                this._agentBuf.set(id, s);
            }
            s.lastLine = lastLine;
            if (statusLine) s.statusLine = statusLine;
            if (actionLine) s.actionLine = actionLine;
            // Clear stale action/status when idle or done
            if (next === 'idle' || next === 'done') { s.statusLine = ''; s.actionLine = ''; }
            // Update activity: use detected label, or fall back to last line as context
            if (activity) {
                s.activity = activity;
            } else if (next === 'idle' && lastLine) {
                s.activity = lastLine.slice(0, 50);
            }

            // Debug: log detected state and matching pattern
            if (id === this.activeId && window.__SOA_DEBUG_AGENT) {
                const current = this._agentStatus.get(id) || '(none)';
                console.log(`[agent-detect] tab=${id} current=${current} next=${next} activity="${activity}"`);
                if (next === 'working') {
                    const matched = DET.working.find(p => p.test(visible));
                    console.log(`[agent-detect]   matched working: ${matched}`);
                }
            }

            if (next == null) return;
            const current = this._agentStatus.get(id) || 'idle';
            // On first detection (no prior status set), apply immediately
            if (!this._agentStatus.has(id)) {
                this._setStatus(id, next);
                return;
            }
            if (next === current) {
                if (s.pending) { clearTimeout(s.pending); s.pending = null; s.pendingStatus = null; }
                return;
            }

            // Debounce: attention is urgent, working is quick, done/idle wait
            const delay = next === 'error'     ? 100
                        : next === 'attention' ? 100
                        : next === 'working'   ? 100
                        : 400;

            if (s.pendingStatus === next) return;
            if (s.pending) clearTimeout(s.pending);
            s.pendingStatus = next;
            s.pending = setTimeout(() => {
                s.pending = null;
                s.pendingStatus = null;
                this._setStatus(id, next);
            }, delay);
        } catch (_) {}
    }

    // Browser-style tab drag and drop.
    //
    // Each .tab is a drag source. The tabs row is the single drop target;
    // during dragover we locate the tab under the pointer and decide whether
    // to insert before or after it based on the midpoint of its bounding box,
    // drawing a thin indicator on that edge. On drop we optimistically reorder
    // this.order + the DOM, then send MOVE_TAB — the server's SNAPSHOT is
    // authoritative and will correct us if the move is rejected.
    _attachTabDrag(node, id) {
        node.addEventListener('dragstart', (e) => {
            this._dragId = id;
            node.classList.add('dragging');
            try {
                // Firefox requires dataTransfer to be populated for drag to start.
                e.dataTransfer.setData('text/plain', String(id));
                e.dataTransfer.effectAllowed = 'move';
            } catch (_) {}
        });
        node.addEventListener('dragend', () => {
            node.classList.remove('dragging');
            this._clearDropIndicator();
            this._dragId = null;
        });
    }

    // Touch parity for the desktop dblclick/rightclick/drag combo. Long-press
    // (550ms) on a tab opens a bottom sheet with the same actions phones
    // otherwise can't reach: rename, reorder, close. The touch listener only
    // arms on coarse-pointer devices so it doesn't interfere with mouse
    // right-click → rename on desktop. Movement beyond a small threshold
    // cancels the timer so the user can still scroll the tab row by dragging.
    _attachTabLongPress(node, id) {
        if (!window.matchMedia('(pointer: coarse)').matches) return;
        let timer = null;
        let startX = 0, startY = 0;
        const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
        node.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) { cancel(); return; }
            const t = e.touches[0];
            startX = t.clientX; startY = t.clientY;
            cancel();
            timer = setTimeout(() => {
                timer = null;
                try { if (navigator.vibrate) navigator.vibrate(12); } catch (_) {}
                this._openTabMenu(id);
            }, 550);
        }, { passive: true });
        node.addEventListener('touchmove', (e) => {
            if (!timer) return;
            const t = e.touches[0];
            if (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) cancel();
        }, { passive: true });
        node.addEventListener('touchend', cancel, { passive: true });
        node.addEventListener('touchcancel', cancel, { passive: true });
    }

    // Bottom-sheet action menu for a tab. Built once, reused; re-binds to the
    // current tab id each open. Sits above the terminal with a scrim — tap
    // outside or the Cancel row to dismiss.
    _openTabMenu(id) {
        const idx = this.order.indexOf(id);
        if (idx === -1) return;
        const tab = this.tabs.get(id);
        if (!tab) return;
        const canMoveLeft  = idx > 0;
        const canMoveRight = idx < this.order.length - 1;

        const close = () => { sheet.remove(); };
        const act = (fn) => () => { close(); fn(); };

        const row = (label, onClick, opts = {}) => el('button', {
            class: 'soa-tabmenu-row' + (opts.danger ? ' danger' : '') + (opts.disabled ? ' disabled' : ''),
            disabled: opts.disabled ? 'disabled' : null,
            onclick: opts.disabled ? null : onClick,
            text: label,
        });

        const title = tab.title || tr('tab.default', { id });
        const header = el('div', { class: 'soa-tabmenu-title', text: title });
        const children = [
            row(tr('tab.rename_prompt') || 'Rename', act(() => this._promptRename(id, tab.title))),
            row('← ' + (tr('tab.move_left')  || 'Move left'),  act(() => this._moveRelative(id, -1)), { disabled: !canMoveLeft }),
            row('→ ' + (tr('tab.move_right') || 'Move right'), act(() => this._moveRelative(id, +1)), { disabled: !canMoveRight }),
            row('× ' + (tr('tab.close') || 'Close'),
                act(() => this._requestCloseTab(id)),
                { danger: true }),
        ];
        // Offer restore when the session has anything archived. Menu only
        // surfaces the top-of-stack; toast + Cmd/Ctrl+Shift+Z cover the rest.
        if (this.graveyard && this.graveyard.length) {
            const top = this.graveyard[this.graveyard.length - 1];
            children.push(row(
                tr('tab.restore_specific', { title: top.title }) || '⟲ Restore',
                act(() => this._restoreClosedTab(top.id)),
            ));
        }
        children.push(row(tr('common.cancel') || 'Cancel', close));
        const rows = el('div', { class: 'soa-tabmenu-rows' }, children);

        const sheet = el('div', { class: 'soa-tabmenu', onclick: (e) => { if (e.target === sheet) close(); } },
            [el('div', { class: 'soa-tabmenu-panel' }, [header, rows])]);
        document.body.appendChild(sheet);
        this.audio.play('panels');
    }

    // Move a tab one slot in `direction` (−1 left, +1 right). Reuses the
    // same MOVE_TAB protocol the drag-drop path uses so the server stays
    // authoritative on ordering.
    _moveRelative(id, direction) {
        const idx = this.order.indexOf(id);
        if (idx === -1) return;
        const targetIdx = idx + direction;
        if (targetIdx < 0 || targetIdx >= this.order.length) return;
        // beforeId is the neighbor the tab should sit in front of, or -1
        // when moving to the end.
        let beforeId;
        if (direction < 0) {
            beforeId = this.order[targetIdx]; // sit before the left neighbor
        } else {
            beforeId = targetIdx + 1 < this.order.length ? this.order[targetIdx + 1] : -1;
        }
        this._applyMove(id, { beforeId });
    }

    // Single close funnel. All three close paths (× button, tab-menu, hotkey)
    // go through here so the confirm modal and restore toast behave the same
    // everywhere. The modal can be skipped for the rest of the session via
    // the "don't ask again" checkbox.
    _requestCloseTab(id) {
        const tab = this.tabs.get(id);
        if (!tab) return;
        const fire = () => {
            this.audio.play('denied');
            // Remember what we just asked to close so we can show a toast
            // once the server confirms by dropping the tab from the snapshot.
            this._pendingClose = { id, title: tab.title || tr('tab.default', { id }) };
            this.bridge.input(INPUT_KIND.CLOSE_TAB, { id });
        };
        if (this._skipCloseConfirm) { fire(); return; }
        this._confirmClose(tab, fire);
    }

    // Tiny non-blocking confirm dialog. Escape / backdrop click = cancel,
    // Enter = confirm, checkbox = "don't ask again this session".
    _confirmClose(tab, onOk) {
        const title = tab.title || tr('tab.default', { id: tab.id });
        const backdrop = el('div', { class: 'soa-confirm', role: 'dialog', 'aria-modal': 'true' });
        const cb = el('input', { type: 'checkbox', id: 'soa-confirm-remember' });
        const cbWrap = el('label', { class: 'soa-confirm-remember', for: 'soa-confirm-remember' },
            [cb, el('span', { text: tr('tab.confirm_close.remember') || "Don't ask again this session" })]);
        const ok = el('button', { class: 'soa-confirm-btn danger', type: 'button',
            text: tr('tab.confirm_close.ok') || 'Close tab' });
        const cancel = el('button', { class: 'soa-confirm-btn', type: 'button',
            text: tr('tab.confirm_close.cancel') || 'Keep tab' });
        const panel = el('div', { class: 'soa-confirm-panel' }, [
            el('h3', { class: 'soa-confirm-title', text: tr('tab.confirm_close.title') || 'Close this tab?' }),
            el('p', { class: 'soa-confirm-body',
                text: tr('tab.confirm_close.body', { title }) || `Close "${title}"?` }),
            cbWrap,
            el('div', { class: 'soa-confirm-actions' }, [cancel, ok]),
        ]);
        backdrop.appendChild(panel);
        const close = () => {
            document.removeEventListener('keydown', onKey, true);
            backdrop.remove();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); accept(); }
        };
        const accept = () => {
            if (cb.checked) this._skipCloseConfirm = true;
            close();
            onOk();
        };
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        cancel.addEventListener('click', close);
        ok.addEventListener('click', accept);
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(backdrop);
        this.audio.play('panels');
        // Focus the cancel action by default so a stray Enter doesn't close
        // the tab. The user has to move to OK (Tab) or hit Enter twice — this
        // matches browser tab-close conventions.
        requestAnimationFrame(() => cancel.focus());
    }

    // Mirror the server graveyard locally. Called from HELLO and SNAPSHOT.
    // When a new entry appears, surface the restore toast — that's the only
    // moment we can tie it to an actual user-initiated close (versus, say,
    // a reload where the graveyard is pre-populated from a prior session).
    _updateGraveyard(list) {
        if (!Array.isArray(list)) return;
        const prev = this.graveyard || [];
        this.graveyard = list.slice();
        this._tabsUISig = null;
        // Find the first id that's new relative to prev (newest is at end).
        const prevIds = new Set(prev.map(g => g.id));
        const added = this.graveyard.find(g => !prevIds.has(g.id));
        if (added && this._pendingClose && added.id === this._pendingClose.id) {
            this._showRestoreToast(added);
            this._pendingClose = null;
        }
    }

    // Non-blocking toast with an UNDO action. Auto-dismisses after 6s.
    // Only one toast lives at a time — a newer close replaces the older one
    // (the older tab is still recoverable via menu or Cmd/Ctrl+Shift+Z).
    _showRestoreToast(entry) {
        const existing = document.getElementById('soa-restore-toast');
        if (existing) existing.remove();
        const undo = el('button', { class: 'soa-toast-action', type: 'button',
            text: tr('tab.undo') || 'UNDO' });
        const msg = tr('tab.closed_toast', { title: entry.title }) || `Closed "${entry.title}"`;
        const toast = el('div', {
            id: 'soa-restore-toast',
            class: 'soa-toast soa-toast--restore',
            role: 'status', 'aria-live': 'polite',
        }, [
            el('div', { class: 'soa-toast-body' }, [el('p', { class: 'soa-toast-title', text: msg })]),
            undo,
        ]);
        const dismiss = () => {
            clearTimeout(timer);
            toast.removeAttribute('data-show');
            setTimeout(() => toast.remove(), 320);
        };
        undo.addEventListener('click', () => { dismiss(); this._restoreClosedTab(entry.id); });
        const timer = setTimeout(dismiss, 6000);
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.setAttribute('data-show', '1'));
    }

    // Ask the server to restore a graveyard entry. No id = most-recent.
    // The server responds by spawning a fresh tab, SNAPSHOT drives the UI
    // update, and the PTY delivers the seeded scrollback via TERM_DATA.
    _restoreClosedTab(id) {
        if (!this.graveyard || !this.graveyard.length) return;
        const target = id != null
            ? this.graveyard.find(g => g.id === id)
            : this.graveyard[this.graveyard.length - 1];
        if (!target) return;
        const size = this._sendSize();
        // This device restored the tab from the graveyard — follow the new id.
        this._adoptNewTabIds = new Set(this.tabs.keys());
        this.bridge.input(INPUT_KIND.RESTORE_TAB, { id: target.id, ...size });
        this.audio.play('granted');
    }

    _installTabsDrop() {
        if (this._tabsDropInstalled) return;
        this._tabsDropInstalled = true;
        const row = this.tabsEl;
        row.addEventListener('dragover', (e) => {
            if (this._dragId == null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const target = this._dropTarget(e.clientX);
            this._paintDropIndicator(target);
        });
        row.addEventListener('dragleave', (e) => {
            // Only clear when the pointer truly leaves the row, not when it
            // crosses between child tabs (those fire dragleave too).
            if (e.target === row) this._clearDropIndicator();
        });
        row.addEventListener('drop', (e) => {
            if (this._dragId == null) return;
            e.preventDefault();
            const target = this._dropTarget(e.clientX);
            this._clearDropIndicator();
            const dragId = this._dragId;
            this._dragId = null;
            this._applyMove(dragId, target);
        });
    }

    // Given a pointer X, return { beforeId } where beforeId is the id of the
    // tab the dragged tab should be inserted before, or -1 to append.
    _dropTarget(clientX) {
        const nodes = Array.from(this.tabsEl.querySelectorAll('.tab'));
        for (const n of nodes) {
            const r = n.getBoundingClientRect();
            if (clientX < r.left + r.width / 2) {
                return { beforeId: Number(n.dataset.tabId), node: n, side: 'left' };
            }
        }
        const last = nodes[nodes.length - 1];
        return { beforeId: -1, node: last || null, side: 'right' };
    }

    _paintDropIndicator({ node, side }) {
        this._clearDropIndicator();
        if (!node) return;
        node.classList.add(side === 'left' ? 'drop-before' : 'drop-after');
        this._dropIndicatorNode = node;
    }

    _clearDropIndicator() {
        const n = this._dropIndicatorNode;
        if (n) { n.classList.remove('drop-before', 'drop-after'); }
        this._dropIndicatorNode = null;
    }

    _applyMove(dragId, { beforeId }) {
        // No-op when dropping onto self or onto the slot immediately after self.
        const curIdx = this.order.indexOf(dragId);
        if (curIdx === -1) return;
        let targetIdx;
        if (beforeId === -1) targetIdx = this.order.length;
        else targetIdx = this.order.indexOf(beforeId);
        if (targetIdx === -1) return;
        if (targetIdx === curIdx || targetIdx === curIdx + 1) return;

        const next = this.order.filter(x => x !== dragId);
        const insertAt = beforeId === -1 ? next.length : next.indexOf(beforeId);
        next.splice(insertAt === -1 ? next.length : insertAt, 0, dragId);
        this.order = next;
        this._tabsUISig = null;
        this._syncTabsUI();
        this.audio.play('panels');
        this.bridge.input(INPUT_KIND.MOVE_TAB, { id: dragId, before: beforeId });
    }

    _setStatus(id, status) {
        const prev = this._agentStatus.get(id);
        if (prev === status) return;
        this._agentStatus.set(id, status);
        // Track when this status started for elapsed time display
        const s = this._agentBuf.get(id);
        if (s) s.lastChange = Date.now();
        // Status drives only a CSS color/pulse via the tab button's
        // data-agent attribute (and, in tiles mode, the tile node updated
        // below). Swap that one attribute instead of nulling the whole
        // tab-row cache and replaceChildren-rebuilding all N buttons + pies
        // on every working↔done flip — the dominant DOM churn with many live
        // tabs. Fall back to a full sync only if the node isn't rendered yet.
        const tabNode = this.tabsEl.querySelector(`[data-tab-id="${CSS.escape(String(id))}"]`);
        if (tabNode) tabNode.setAttribute('data-agent', status);
        else { this._tabsUISig = null; this._syncTabsUI(); }
        // A status flip usually means new activity/status-line text — repaint the
        // subtitle now rather than waiting for the next poll tick.
        this._updateTabPreview(id);
        // Live-update the tile if in tiles mode without a full re-render.
        if (this.viewMode === 'tiles' && this._tilesGridEl) {
            const node = this._tilesGridEl.querySelector(`[data-tile-id="${id}"]`);
            if (node) this._updateTileNode(node, id);
        }
        // Notify on a *meaningful* status change (needs-input / finished / error).
        // Never on the very first classification of a tab (prev === undefined):
        // that's just the startup seed from the server supervisor and would fire
        // a notification storm on load. Debounced so a brief working→done→working
        // flicker stays quiet. Fires an OS-level notification (see _notifyStatus)
        // when you're not already looking at that tab.
        if (!this._statusTimers) this._statusTimers = new Map();
        clearTimeout(this._statusTimers.get(id));
        this._statusTimers.delete(id);
        const meaningful = (status === 'attention' || status === 'done' || status === 'error');
        if (meaningful && prev !== undefined && prev !== status) {
            this._statusTimers.set(id, setTimeout(() => {
                this._statusTimers.delete(id);
                if (this._agentStatus.get(id) === status) this._notifyStatus(id, status);
            }, status === 'attention' ? 2000 : 1200));
        }
        // Visual debug overlay — shows detected status on screen
        this._updateDebugOverlay(id, status, prev);
    }

    _updateDebugOverlay(id, status, prev) {
        if (!window.__SOA_DEBUG_AGENT) return;
        let overlay = document.getElementById('soa-agent-debug');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'soa-agent-debug';
            overlay.style.cssText = 'position:fixed;bottom:4px;right:4px;z-index:99999;font:10px/1.3 monospace;background:rgba(0,0,0,0.85);color:#aacfd1;padding:6px 8px;border-radius:4px;max-width:300px;pointer-events:none;';
            document.body.appendChild(overlay);
        }
        const entries = [];
        for (const [tid, st] of this._agentStatus) {
            const color = st === 'working' ? '#50fa7b' : st === 'done' ? '#ffb86c' : (st === 'attention' || st === 'error') ? '#ff5555' : '#6272a4';
            entries.push(`<span style="color:${color}">tab${tid}:${st}</span>`);
        }
        overlay.innerHTML = entries.join(' | ') + `<br><span style="color:#888">last: tab${id} ${prev}→${status}</span>`;
    }

    // Route a meaningful status change to an OS notification (when you're not
    // already looking at the tab) plus an in-app toast for the urgent ones.
    _notifyStatus(id, status) {
        const tab = this.tabs.get(id);
        const title = (tab && tab.title) || tr('tab.default', { id });
        const label = status === 'attention' ? 'needs your input'
                    : status === 'error'     ? 'hit an error'
                    :                          'finished — awaiting next prompt';
        const msg = `${title} ${label}`;
        // Skip the OS notification only when the window is focused AND this exact
        // tab is the one on screen — anything else (backgrounded window, another
        // tab open, tiles grid) means the user could miss it, so notify.
        const focused = (typeof document.hasFocus === 'function') ? document.hasFocus() : !document.hidden;
        const lookingRightAtIt = focused && this.activeId === id && this.viewMode !== 'tiles';
        if (!lookingRightAtIt) this._osNotify(msg, id);
        if (status === 'attention' || status === 'error') this._showStatusToast(msg);
    }

    // Fire an OS-level (browser) notification. tag+renotify so repeated alerts
    // for the same tab replace rather than stack; click focuses + opens the tab.
    _osNotify(body, id) {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        try {
            const n = new Notification('Son of Anton', {
                body, tag: 'soa-tab-' + id, renotify: true, silent: false,
            });
            n.onclick = () => { try { window.focus(); } catch (_) {} this._activate(id); n.close(); };
        } catch (_) {}
    }

    _showStatusToast(text) {
        const existing = document.getElementById('soa-agent-toast');
        if (existing) existing.remove();
        const toast = el('div', { id: 'soa-agent-toast', class: 'soa-toast soa-toast--agent', role: 'alert', 'aria-live': 'assertive' }, [
            el('div', { class: 'soa-toast-icon', 'aria-hidden': 'true', text: '!' }),
            el('div', { class: 'soa-toast-body' }, [
                el('p', { class: 'soa-toast-title', text }),
            ]),
        ]);
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.setAttribute('data-show', '1'));
        const dismiss = () => { toast.removeAttribute('data-show'); setTimeout(() => toast.remove(), 320); };
        toast.addEventListener('click', dismiss);
        setTimeout(dismiss, 4000);
    }

    _promptRename(id, current) {
        const next = window.prompt(
            (tr('tab.rename_prompt') || 'Rename tab') + '\n' +
            (tr('tab.rename_clear_hint') || '(Clear to revert to auto-naming)'),
            current || tr('tab.default', { id })
        );
        if (next == null) return;
        const title = next.trim().slice(0, 64);
        if (title === current) return;
        // Empty string clears the user-rename flag on the server, reverting
        // to auto-naming (cwd folder name). Non-empty pins the title.
        const rt = this.tabs.get(id);
        if (rt) { rt.title = title || current; this._tabsUISig = null; this._syncTabsUI(); }
        this.bridge.input(INPUT_KIND.RENAME_TAB, { id, title });
    }

    _fitActive() {
        const rt = this.tabs.get(this.activeId);
        if (!rt) return;
        // xterm's renderer finalizes cell metrics over a couple of frames —
        // especially the first time the container becomes visible. One fit
        // catches the initial 80×24, the next frame catches the real size
        // after layout settles. fitNow() triggers xterm's onResize, which
        // the TabRuntime.attach debouncer forwards to the server — we
        // intentionally do NOT send TERM_RESIZE here: a drag-grown window
        // would otherwise fire 3 redundant resizes per frame and shift any
        // in-flight output.
        rt.fitNow();
        requestAnimationFrame(() => { rt.fitNow(); requestAnimationFrame(() => rt.fitNow()); });
    }

    _sendSize() {
        const rt = this.tabs.get(this.activeId);
        if (!rt) return { cols: 120, rows: 32 };
        const sz = rt.fitNow();
        return { cols: sz.cols, rows: sz.rows };
    }

    async _onPasteImage(e) {
        // Only when a terminal is focused — otherwise leave inputs/modals alone.
        const focused = document.activeElement;
        const inTerm = focused && focused.closest && focused.closest('.xterm');
        if (!inTerm) return;
        const items = (e.clipboardData && e.clipboardData.items) || [];
        let imgItem = null;
        for (const it of items) { if (it.type && it.type.indexOf('image/') === 0) { imgItem = it; break; } }
        if (!imgItem) return;   // plain text paste → let xterm handle it normally
        e.preventDefault();
        e.stopPropagation();
        const id = this.activeId;
        if (id == null) return;
        const blob = imgItem.getAsFile && imgItem.getAsFile();
        if (!blob) { this._pasteFallbackCtrlV(id); return; }
        // Upload the image to a temp file on the machine running the shell, then
        // type its path into the prompt — like dragging a file into Claude Code.
        try {
            const p = await this._uploadPastedImage(blob);
            if (p) {
                // Deliver the path as a *bracketed paste* (ESC[200~ … ESC[201~),
                // not typed keystrokes — that's how a drag-drop reaches Claude
                // Code, which is what makes it attach the image (vs. plain text).
                this.bridge.input(INPUT_KIND.TERM_KEYS, { id, text: '\x1b[200~' + p + '\x1b[201~' });
                this.audio.play('granted');
                return;
            }
        } catch (err) {
            console.warn('[paste-image] upload failed, falling back to Ctrl+V', err);
        }
        this._pasteFallbackCtrlV(id);
    }

    _pasteFallbackCtrlV(id) {
        // Couldn't upload (endpoint missing / offline) — forward Ctrl+V so a
        // same-machine Claude Code can still read the system clipboard.
        this.bridge.input(INPUT_KIND.TERM_KEYS, { id, text: '\x16' });
    }

    async _uploadPastedImage(blob) {
        const cfg = window.__SOA_WEB__ || {};
        const base = String(cfg._resolvedBackend || cfg.backend || '').replace(/\/+$/, '');
        const tok = cfg._resolvedToken || cfg.token || '';
        const url = base + '/api/paste-image' + (tok ? '?t=' + encodeURIComponent(tok) : '');
        const res = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': blob.type || 'image/png' },
            body: blob,
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data || !data.ok || !data.path) throw new Error('bad response');
        return data.path;
    }

    // Quote a path for the prompt only if it has characters that would split it.
    _shellQuote(p) {
        if (/^[\w@%+=:,./-]+$/.test(p)) return p;
        return "'" + String(p).replace(/'/g, "'\\''") + "'";
    }

    // A `tts` frame arrived (Claude finished a turn; the Stop hook sent its text).
    _onTTS(d) {
        if (!this._ttsEnabled) return;
        const text = d && d.text;
        if (!text) return;
        // Speak only the tab you're looking at by default, so multiple Claude
        // sessions don't talk over each other. tab === null = server couldn't tag.
        const tab = d.tab;
        if (tab != null && this.activeId != null && tab !== this.activeId) return;
        this._speak(text);
    }

    _speak(text) {
        try {
            const synth = window.speechSynthesis;
            if (!synth) return;
            if (!this._ttsVoice) this._ttsVoice = this._pickVoice();
            synth.cancel(); // interrupt any in-progress utterance
            const u = new SpeechSynthesisUtterance(String(text).slice(0, 4000));
            u.rate = 1.05; u.pitch = 1.0;
            if (this._ttsVoice) u.voice = this._ttsVoice;
            synth.speak(u);
        } catch (_) {}
    }

    _pickVoice() {
        try {
            const voices = window.speechSynthesis.getVoices() || [];
            if (!voices.length) return null;
            return voices.find(v => /Samantha|Karen|Daniel|Google US English/i.test(v.name) && /^en/i.test(v.lang))
                || voices.find(v => /en[-_]US/i.test(v.lang))
                || voices.find(v => /^en/i.test(v.lang))
                || null;
        } catch (_) { return null; }
    }

    _hotkey(e) {
        // Escape in tiles overlay → back to grid
        if (e.key === 'Escape' && this.viewMode === 'tiles' && this._tileOverlayId != null) {
            e.preventDefault();
            this._closeTileTerminal();
            return;
        }
        const focused = document.activeElement;
        const inInput = focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.tagName === 'SELECT' || focused.isContentEditable);
        const inTerm  = focused && focused.closest('.xterm');
        if (!inInput && !inTerm && this.order.length > 1) {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                const idx = this.order.indexOf(this.activeId);
                const next = e.key === 'ArrowLeft'
                    ? this.order[(idx - 1 + this.order.length) % this.order.length]
                    : this.order[(idx + 1) % this.order.length];
                this._activate(next);
                return;
            }
            const digit = e.key >= '1' && e.key <= '9' ? +e.key - 1
                        : e.key === '0' ? 9 : -1;
            if (digit !== -1 && digit < this.order.length && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                this._activate(this.order[digit]);
                return;
            }
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
            e.preventDefault();
            this.audio.play('granted');
            // This device opened the new tab — focus its new id when it lands.
            this._adoptNewTabIds = new Set(this.tabs.keys());
            this.bridge.input(INPUT_KIND.NEW_TAB, this._sendSize());
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'w') {
            e.preventDefault();
            if (this.activeId != null) this._requestCloseTab(this.activeId);
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            this._restoreClosedTab();
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
            e.preventDefault();
            $('#toggle-sidebar').click();
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            openSettingsModal();
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'g') {
            e.preventDefault();
            this._toggleViewMode();
        }
    }

    _applySettings(s) {
        for (const rt of this.tabs.values()) rt.applySettings(s);
        this._fitActive();
        if (this.audio) {
            if (typeof this.audio.setEnabled === 'function') this.audio.setEnabled(!!s.audio);
            if (typeof this.audio.setVolume === 'function')  this.audio.setVolume(s.audioVolume);
            if (typeof this.audio.setFeedbackEnabled === 'function') this.audio.setFeedbackEnabled(!s.disableFeedbackAudio);
        }
        const audioBtn = $('#toggle-audio');
        if (audioBtn) {
            audioBtn.dataset.state = s.audio ? 'on' : 'off';
            audioBtn.textContent = s.audio ? tr('topbar.audio_on') : tr('topbar.audio_off');
        }
    }

    // ── Tiles view ──────────────────────────────────────────────────────

    _toggleViewMode() {
        this.viewMode = this.viewMode === 'tiles' ? 'tabs' : 'tiles';
        try { localStorage.setItem('soa_web_view_mode', this.viewMode); } catch (_) {}
        this._applyViewMode();
        this._updateViewBtn();
        this.audio.play('panels');
    }

    _updateViewBtn() {
        const btn = $('#toggle-view');
        if (!btn) return;
        if (this.viewMode === 'tiles') {
            btn.setAttribute('data-icon', '☰');
            btn.title = 'Switch to tabs view';
        } else {
            btn.setAttribute('data-icon', '⊞');
            btn.title = 'Switch to tiles view';
        }
    }

    _applyViewMode() {
        const shell = $('#shell');
        // Leaving the monitor → stop its stream + poll before switching away.
        if (this.viewMode !== 'monitor') this._teardownMonitor();
        if (this.viewMode === 'tiles') {
            shell.setAttribute('data-view', 'tiles');
            this._closeTileTerminal();
            this._renderTiles();
            for (const [, rt] of this.tabs) rt.container.classList.remove('active');
        } else if (this.viewMode === 'monitor') {
            shell.setAttribute('data-view', 'monitor');
            this._removeTilesGrid();
            this._removeTileOverlay();
            for (const [, rt] of this.tabs) rt.container.classList.remove('active');
            this._enterMonitor();
        } else {
            shell.removeAttribute('data-view');
            this._removeTilesGrid();
            this._removeTileOverlay();
            const rt = this.tabs.get(this.activeId);
            if (rt) {
                rt.container.classList.add('active');
                rt.fitNow();
                rt.scrollToBottom();
                rt.focus();
            }
        }
    }

    // ── MONITOR view ────────────────────────────────────────────────────────
    // One screen showing every agent's OWN live browser (per-tab isolated
    // instances) plus every open localhost port. Browser frames arrive over the
    // WS stamped with their tab id and get routed to the matching cell.
    _toggleMonitor() {
        this.viewMode = this.viewMode === 'monitor' ? 'tabs' : 'monitor';
        try { localStorage.setItem('soa_web_view_mode', this.viewMode); } catch (_) {}
        this._applyViewMode();
        this._updateViewBtn();
        this._updateMonitorBtn();
        this.audio.play('panels');
    }

    _updateMonitorBtn() {
        const btn = $('#toggle-monitor');
        if (btn) btn.classList.toggle('active', this.viewMode === 'monitor');
    }

    _enterMonitor() {
        if (!this._monitorEl) {
            this._monitorGridEl = el('div', { class: 'monitor-grid', 'data-empty': 'Loading…' });
            this._monitorPortsEl = el('div', { class: 'monitor-ports' });
            this._monitorEl = el('div', { class: 'monitor-view' }, [
                el('div', { class: 'monitor-head', text: '◉ AGENT BROWSERS' }),
                this._monitorGridEl,
                el('div', { class: 'monitor-head', text: '⊞ LOCALHOST PORTS' }),
                this._monitorPortsEl,
            ]);
            this.termsEl.appendChild(this._monitorEl);
        }
        this._monitorEl.style.display = '';
        if (!this._monitorFrames) this._monitorFrames = new Map();
        // Watch every agent browser instance; the server streams each one's
        // frames stamped with its tab id (routed by _onBrowserFrame).
        try { this.bridge.input(INPUT_KIND.BROWSER_SUBSCRIBE, { id: '*' }); } catch (_) {}
        this._monitorSubscribed = true;
        this._renderMonitor();
        if (this._monitorTimer) clearInterval(this._monitorTimer);
        // Re-list instances/ports periodically so new browsers + ports appear.
        this._monitorTimer = setInterval(() => { if (!document.hidden) this._renderMonitor(); }, 4000);
    }

    _teardownMonitor() {
        if (this._monitorTimer) { clearInterval(this._monitorTimer); this._monitorTimer = null; }
        if (this._monitorSubscribed) {
            try { this.bridge.input(INPUT_KIND.BROWSER_UNSUBSCRIBE, { id: '*' }); } catch (_) {}
            this._monitorSubscribed = false;
        }
        if (this._monitorEl) this._monitorEl.style.display = 'none';
    }

    _onBrowserFrame(d) {
        if (!d || d.tabId == null) return;
        const key = String(d.tabId);
        // Cache the latest frame for every instance, unconditionally. CDP emits
        // the initial screencast frame the instant the cast starts — often the
        // ONLY frame for an idle page — and it can land BEFORE the 4s instance
        // poll has built this tab's grid cell. Without this cache that first
        // frame was dropped and the cell stayed blank forever (the bug).
        if (d.data) {
            if (!this._monitorFrames) this._monitorFrames = new Map();
            this._monitorFrames.set(key, d.data);
        }
        if (this.viewMode !== 'monitor' || !this._monitorGridEl) return;
        // Build the cell on demand so the first frame paints immediately rather
        // than waiting up to 4s for the next _renderMonitor poll to create it.
        const cell = this._ensureMonitorCell(key);
        const img = cell && cell.querySelector('.mon-frame');
        if (img && d.data) img.src = 'data:image/jpeg;base64,' + d.data;
    }

    // Create (or fetch) the grid cell for an agent-browser instance, painting
    // any cached frame so a cell is never blank while we already hold a frame.
    _ensureMonitorCell(key) {
        if (!this._monitorGridEl) return null;
        let cell = this._monitorGridEl.querySelector(`[data-mon-tab="${CSS.escape(key)}"]`);
        if (!cell) {
            cell = el('div', { class: 'mon-cell', 'data-mon-tab': key }, [
                el('div', { class: 'mon-bar' }, [
                    el('span', { class: 'mon-title', text: 'tab ' + key }),
                    el('span', { class: 'mon-url' }),
                ]),
                el('img', { class: 'mon-frame', alt: '' }),
            ]);
            this._monitorGridEl.appendChild(cell);
            this._monitorGridEl.dataset.empty = '';
        }
        const cached = this._monitorFrames && this._monitorFrames.get(key);
        const img = cell.querySelector('.mon-frame');
        if (cached && img && !img.getAttribute('src')) img.src = 'data:image/jpeg;base64,' + cached;
        return cell;
    }

    async _fetchBrowserInstances() {
        try {
            const backend = (window.__SOA_WEB__ || {})._resolvedBackend || '';
            const token = (window.__SOA_WEB__ || {})._resolvedToken || '';
            const url = new URL(backend + '/api/agent-browser');
            if (token) url.searchParams.set('t', token);
            const res = await fetch(url.toString(), {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'list' }),
            });
            if (!res.ok) return [];
            const j = await res.json();
            return (j && j.instances) || [];
        } catch (_) { return []; }
    }

    async _renderMonitor() {
        if (this.viewMode !== 'monitor' || !this._monitorGridEl) return;
        const instances = await this._fetchBrowserInstances();
        if (this.viewMode !== 'monitor' || !this._monitorGridEl) return; // re-check post-await
        const seen = new Set();
        for (const inst of instances) {
            const key = String(inst.tabId);
            seen.add(key);
            const cell = this._ensureMonitorCell(key);
            const tab = this.tabs.get(Number(inst.tabId));
            cell.querySelector('.mon-title').textContent = (tab && tab.title) || ('tab ' + inst.tabId);
            cell.querySelector('.mon-url').textContent = inst.url || '';
        }
        for (const node of [...this._monitorGridEl.querySelectorAll('.mon-cell')]) {
            if (!seen.has(node.dataset.monTab)) {
                if (this._monitorFrames) this._monitorFrames.delete(node.dataset.monTab);
                node.remove();
            }
        }
        this._monitorGridEl.dataset.empty = instances.length ? ''
            : 'No agent browsers yet — when an agent runs `soa-browser open …` its session appears here.';
        this._renderMonitorPorts();
    }

    async _renderMonitorPorts() {
        if (!this._monitorPortsEl) return;
        let ports = [];
        try {
            const backend = (window.__SOA_WEB__ || {})._resolvedBackend || '';
            const token = (window.__SOA_WEB__ || {})._resolvedToken || '';
            const url = new URL(backend + '/api/ports');
            if (token) url.searchParams.set('t', token);
            const res = await fetch(url.toString(), { credentials: 'include' });
            if (res.ok) { const { data } = await res.json(); ports = (data && data.ports) || []; }
        } catch (_) { return; }
        if (this.viewMode !== 'monitor' || !this._monitorPortsEl) return;
        this._monitorPortsEl.replaceChildren(...ports.map(p => el('button', {
            class: 'mon-port', type: 'button',
            title: `Open localhost:${p.port} (${p.process}) in the preview`,
            text: `:${p.port} — ${p.process}`,
            onclick: async () => {
                try { const wp = await import('/assets/previewPanel.js?v=2'); wp.openPreviewModal(this, String(p.port)); }
                catch (err) { console.warn('[monitor] preview open failed', err); }
            },
        })));
        if (!ports.length) this._monitorPortsEl.dataset.empty = 'No open localhost ports.';
        else this._monitorPortsEl.dataset.empty = '';
    }

    _renderTiles() {
        if (this.viewMode !== 'tiles') return;
        if (!this._tilesGridEl) {
            this._tilesGridEl = el('div', { class: 'tiles-grid' });
            this.termsEl.appendChild(this._tilesGridEl);
        }
        this._tilesGridEl.style.display = '';
        this._installTilesDrop();
        this._updateDashboardPortInfo();
        const existing = new Map();
        for (const node of this._tilesGridEl.querySelectorAll('.tile')) {
            existing.set(Number(node.dataset.tileId), node);
        }
        const fragment = document.createDocumentFragment();
        for (const id of this.order) {
            let node = existing.get(id);
            if (node) {
                existing.delete(id);
                this._updateTileNode(node, id);
            } else {
                node = this._createTileNode(id);
            }
            fragment.appendChild(node);
        }
        for (const old of existing.values()) old.remove();
        // replaceChildren wipes the pinned header cards too — carry them
        // across the re-render (FLEET bar above, port info below) instead of
        // waiting for the next async refresh to repaint them.
        const pinnedPorts = this._tilesGridEl.querySelector('.dashboard-port-info');
        this._tilesGridEl.replaceChildren(fragment);
        if (pinnedPorts) this._tilesGridEl.insertBefore(pinnedPorts, this._tilesGridEl.firstChild);
        this._renderFleetBar();
    }

    // New-tab chooser: every "+" asks what to open — a Terminal (shell tab), a
    // Localhost port, or a Webpage URL. The two web options open in the preview
    // panel (not a persistent tab).
    _openNewTabChooser() {
        const backdrop = el('div', { class: 'soa-modal-backdrop' });
        const card = el('div', { class: 'soa-modal soa-newtab' });
        const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
        const opt = (kind, icon, title, sub) => el('button', {
            class: 'newtab-opt', type: 'button',
            onclick: () => { close(); this._newTabPick(kind); },
        }, [
            el('span', { class: 'nt-ico', text: icon }),
            el('span', { class: 'nt-txt' }, [el('b', { text: title }), el('i', { text: sub })]),
        ]);
        card.append(
            el('div', { class: 'newtab-title', text: 'OPEN NEW…' }),
            opt('terminal', '❯_', 'Terminal', 'A shell in a new tab'),
            opt('localhost', '◉', 'Localhost', 'Preview a local port (e.g. 5555)'),
            opt('webpage', '⊕', 'Webpage', 'Open any URL'),
        );
        backdrop.appendChild(card);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(backdrop);
    }

    // Broadcast a command/keystroke to EVERY terminal at once. Built for fleet
    // recovery — switching model across all agents, or nudging them all to
    // retry/resume after an internet drop or provider outage. Pure client-side:
    // it types into each tab's PTY via TERM_KEYS, the same path a keypress takes,
    // so it needs no server support and can't desync tab state.
    _openBroadcast() {
        const ids = this.order.slice();
        const n = ids.length;
        const backdrop = el('div', { class: 'soa-modal-backdrop' });
        const card = el('div', { class: 'soa-modal soa-bcast' });
        const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };

        // Which tabs receive the broadcast. Restore the LAST selection (persisted)
        // so a 7-of-10 pick isn't reset to "all" each time — intersect with the
        // tabs that still exist. Fall back to ALL when there's no usable saved set
        // (first run, or every saved tab is gone). The chips + checkboxes below
        // let you re-narrow it.
        let _savedSel = null;
        try { _savedSel = JSON.parse(localStorage.getItem('soa_bcast_selection') || 'null'); } catch (_) {}
        const _savedSet = Array.isArray(_savedSel) ? new Set(_savedSel.filter(id => this.tabs.has(id))) : null;
        const selected = (_savedSet && _savedSet.size) ? _savedSet : new Set(ids);
        const persistSel = () => { try { localStorage.setItem('soa_bcast_selection', JSON.stringify([...selected])); } catch (_) {} };

        // ---- target selector: one checkbox row per tab --------------------
        const STATUS_LABELS = { working: 'Working', attention: 'Needs input', done: 'Done', idle: 'Idle' };
        const rows = ids.map((id) => {
            const rt = this.tabs.get(id);
            const title = (rt && rt.title) || tr('tab.default', { id });
            const status = this._agentStatus.get(id) || 'idle';
            const pct = this._ctxPct.get(id) || 0;
            const chk = el('input', { type: 'checkbox', class: 'bcast-row-chk' });
            chk.checked = selected.has(id);
            const row = el('label', { class: 'bcast-row', 'data-agent': status }, [
                chk,
                el('span', { class: 'bcast-row-dot' }),
                el('span', { class: 'bcast-row-title', text: title }),
                el('span', { class: 'bcast-row-ctx', text: pct ? pct + '%' : '' }),
            ]);
            chk.addEventListener('change', () => {
                if (chk.checked) selected.add(id); else selected.delete(id);
                refresh(); persistSel();
            });
            return { row, chk, id, status };
        });
        const listEl = el('div', { class: 'bcast-list' }, rows.map(r => r.row));

        // Quick-select chips: All / None, plus one per agent status present, so
        // "send to everyone that needs input" is a single tap.
        const setSel = (predicate) => {
            selected.clear();
            for (const r of rows) {
                r.chk.checked = predicate(r);
                if (r.chk.checked) selected.add(r.id);
            }
            refresh(); persistSel();
        };
        const present = [...new Set(rows.map(r => r.status))].filter(s => STATUS_LABELS[s]);
        const quickEl = el('div', { class: 'bcast-quick-row' }, [
            el('button', { class: 'bcast-quick', type: 'button', text: `All ${n}`, onclick: () => setSel(() => true) }),
            el('button', { class: 'bcast-quick', type: 'button', text: 'None', onclick: () => setSel(() => false) }),
            ...present.map(s => el('button', {
                class: 'bcast-quick', type: 'button', 'data-agent': s,
                text: STATUS_LABELS[s], onclick: () => setSel(r => r.status === s),
            })),
        ]);
        const countEl = el('span', { class: 'bcast-count' });

        const input = el('input', { class: 'bcast-input', type: 'text', spellcheck: 'false',
            placeholder: 'Command to send to the selected terminals…' });
        const enterChk = el('input', { type: 'checkbox', id: 'bcast-enter', checked: 'checked' });
        const enterLbl = el('label', { class: 'bcast-chk', for: 'bcast-enter' }, [enterChk, ' auto-press Enter to submit']);

        // Briefly highlight the selector when the user tries to send with nothing
        // selected — cheaper than a disabled-button explanation.
        const flashEmpty = () => { quickEl.classList.remove('bcast-flash'); void quickEl.offsetWidth; quickEl.classList.add('bcast-flash'); };

        // Recovery presets. A preset with `key` blasts a bare control key to the
        // selected tabs immediately; otherwise it just fills the input to review
        // first. `claude --continue` resumes the most recent conversation in each
        // tab's cwd in-place — the fix for "tabs reopened after a restart but
        // Claude is a dead shell". (Bare `claude` would start fresh and lose context.)
        const presets = [
            { label: 'Resume ⟲ (claude -c)', text: 'claude --continue' },
            { label: 'claude --resume (pick)', text: 'claude --resume' },
            { label: '/model opus', text: '/model opus' },
            { label: 'Enter ⏎ (retry)', key: '\r' },
            { label: 'Esc', key: '\x1b' },
            { label: 'Ctrl-C', key: '\x03' },
        ];
        const chips = el('div', { class: 'bcast-presets' }, presets.map(p => el('button', {
            class: 'bcast-chip', type: 'button', text: p.label,
            onclick: () => {
                if (p.key != null) {
                    if (!selected.size) { flashEmpty(); return; }
                    persistSel();
                    this._broadcastRaw(p.key, [...selected]); this.audio.play('granted'); close();
                } else { input.value = p.text; input.focus(); }
            },
        })));

        const sendBtn = el('button', { class: 'bcast-send', type: 'button', text: `SEND TO ALL ${n}` });
        const cancelBtn = el('button', { class: 'bcast-cancel', type: 'button', text: 'Cancel' });
        const doSend = () => {
            if (!selected.size) { flashEmpty(); return; }
            const text = input.value;
            if (!text.trim() && !enterChk.checked) { input.focus(); return; }
            const targets = [...selected];
            persistSel();
            // Auto-submit: after the command text lands, send a DISCRETE Enter
            // (CR) so every selected agent actually RUNS the command — the user
            // shouldn't have to press Enter in each tab. Claude Code's TUI can
            // treat a CR glued to the text (or arriving too fast) as a pasted
            // newline that inserts instead of submits, so the CR goes as its own
            // keystroke a beat later. Under a many-tab fan-out the slowest PTY
            // needs more headroom than the single-tab case, so 160ms (was 90ms,
            // which left commands typed-but-unsubmitted on big broadcasts).
            if (text) this._broadcastRaw(text, targets);
            if (enterChk.checked) {
                setTimeout(() => this._broadcastRaw('\r', targets), text ? 160 : 0);
            }
            this.audio.play('granted');
            close();
        };
        sendBtn.addEventListener('click', doSend);
        cancelBtn.addEventListener('click', close);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSend(); } });

        // Keep the count read-out and the send-button label in sync with the
        // current selection.
        const refresh = () => {
            const k = selected.size;
            countEl.textContent = `${k} of ${n} selected`;
            sendBtn.textContent = k === n ? `SEND TO ALL ${n}` : `SEND TO ${k}`;
            sendBtn.classList.toggle('is-empty', k === 0);
        };
        refresh();

        card.append(
            el('div', { class: 'bcast-title', text: 'BROADCAST' }),
            el('div', { class: 'bcast-sub', text: 'Types into the selected terminals at once — resume Claude after a restart (claude -c), switch model, or recover from a disruption. Pick targets below; defaults to all.' }),
            quickEl,
            countEl,
            listEl,
            chips,
            input,
            enterLbl,
            el('div', { class: 'bcast-actions' }, [cancelBtn, sendBtn]),
        );
        backdrop.appendChild(card);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(backdrop);
        input.focus();
    }

    // Type raw bytes into a set of tabs' PTYs. `ids` defaults to every tab
    // (legacy broadcast-to-all). Returns the number of live tabs reached.
    _broadcastRaw(text, ids) {
        if (!text) return 0;
        const targets = (ids && ids.length) ? ids : this.order;
        let n = 0;
        for (const id of targets) {
            if (!this.tabs.has(id)) continue;
            this.bridge.input(INPUT_KIND.TERM_KEYS, { id, text });
            n++;
        }
        return n;
    }

    async _newTabPick(kind) {
        if (kind === 'terminal') {
            const cwd = await pickFolder();
            if (!cwd) return;
            this.audio.play('granted');
            // This device opened the new tab — focus its new id when it lands.
            this._adoptNewTabIds = new Set(this.tabs.keys());
            this.bridge.input(INPUT_KIND.NEW_TAB, { ...this._sendSize(), cwd });
            return;
        }
        let target = '';
        if (kind === 'localhost') {
            const raw = window.prompt('Local port (e.g. 5555):');
            if (raw == null) return;
            target = String(raw).trim().replace(/[^\d]/g, '');
            if (!/^\d{1,5}$/.test(target)) return;
        } else {
            const raw = window.prompt('Web address (URL or localhost:port):');
            if (raw == null) return;
            target = String(raw).trim();
            if (!target) return;
        }
        try {
            const wp = await import('/assets/previewPanel.js?v=2');
            wp.openPreviewModal(this, target);
        } catch (err) { console.warn('[preview] open failed', err); }
    }

    // Read the last `n` non-blank lines from a tab's terminal buffer, so the
    // tile can show a live peek of what each project is doing right now. This
    // is the raw PTY tail — complementary to the agent-detected status lines.
    _tileTailText(id, n = 4) {
        const rt = this.tabs.get(id);
        if (!rt || !rt._opened) return '';
        try {
            const buf = rt.term.buffer.active;
            const end = buf.baseY + rt.term.rows; // exclusive bottom of viewport
            const out = [];
            for (let row = end - 1; row >= 0 && out.length < n; row--) {
                const line = buf.getLine(row);
                if (!line) continue;
                const text = line.translateToString(true).replace(/\s+$/, '');
                if (!text) continue;
                out.unshift(text);
            }
            return out.join('\n');
        } catch (_) { return ''; }
    }

    // Tile header: optional per-project icon + title. The icon is hidden until
    // it actually loads — a 404 (project has no icon) removes the <img>, so
    // icon-less tiles look exactly as before with no broken-image glyph.
    _tileHead(id, title) {
        const icon = el('img', {
            class: 'tile-icon', alt: '', loading: 'lazy', decoding: 'async',
            src: `/api/tabs/${id}/icon`,
            onload: () => { if (icon.naturalWidth) icon.classList.add('show'); },
            onerror: () => icon.remove(),
        });
        return el('div', { class: 'tile-head' }, [
            icon,
            el('span', { class: 'tile-title', text: title }),
        ]);
    }

    _createTileNode(id) {
        const rt = this.tabs.get(id);
        const title = (rt && rt.title) || tr('tab.default', { id });
        const status = this._agentStatus.get(id) || 'idle';
        const pct = this._ctxPct.get(id) || 0;
        const s = this._agentBuf.get(id);
        const activity = (s && s.activity) || this._statusLabel(status);
        const statusLine = (s && s.statusLine) || '';
        const actionLine = (s && s.actionLine) || '';
        const elapsed = (s && s.lastChange) ? this._formatElapsed(s.lastChange) : '';
        const tail = this._tileTailText(id);

        const closeBtn = el('button', { class: 'tile-close', text: '×', onclick: (e) => {
            e.stopPropagation();
            this._requestCloseTab(id);
        }});
        const pie = el('span', { class: 'tile-pie' });
        this._paintTilePie(pie, pct);

        const node = el('div', {
            class: 'tile',
            'data-tile-id': String(id),
            'data-agent': status,
            draggable: 'true',
            onclick: () => {
                if (this._tileDragDidMove) { this._tileDragDidMove = false; return; }
                this._openTileTerminal(id);
            },
        }, [
            closeBtn,
            pie,
            this._tileHead(id, title),
            el('span', { class: 'tile-status-line', text: statusLine }),
            el('span', { class: 'tile-action-line', text: actionLine ? '⏺ ' + actionLine : '' }),
            el('pre', { class: 'tile-preview', text: tail }),
            el('span', { class: 'tile-activity', text: activity }),
            el('span', { class: 'tile-elapsed', text: elapsed }),
        ]);

        node.addEventListener('dragstart', (e) => {
            this._tileDragId = id;
            this._tileDragDidMove = false;
            node.classList.add('dragging');
            e.dataTransfer.setData('text/plain', String(id));
            e.dataTransfer.effectAllowed = 'move';
        });
        node.addEventListener('dragend', () => {
            node.classList.remove('dragging');
            this._tileDragId = null;
            this._clearTileDropTarget();
        });

        return node;
    }

    _updateTileNode(node, id) {
        const rt = this.tabs.get(id);
        const title = (rt && rt.title) || tr('tab.default', { id });
        const status = this._agentStatus.get(id) || 'idle';
        const pct = this._ctxPct.get(id) || 0;
        const s = this._agentBuf.get(id);
        const activity = (s && s.activity) || this._statusLabel(status);
        const statusLine = (s && s.statusLine) || '';
        const actionLine = (s && s.actionLine) || '';
        const elapsed = (s && s.lastChange) ? this._formatElapsed(s.lastChange) : '';

        node.setAttribute('data-agent', status);
        const titleEl = node.querySelector('.tile-title');
        if (titleEl && titleEl.textContent !== title) titleEl.textContent = title;
        const statusEl = node.querySelector('.tile-status-line');
        if (statusEl && statusEl.textContent !== statusLine) statusEl.textContent = statusLine;
        const actionEl = node.querySelector('.tile-action-line');
        const actionText = actionLine ? '⏺ ' + actionLine : '';
        if (actionEl && actionEl.textContent !== actionText) actionEl.textContent = actionText;
        const actEl = node.querySelector('.tile-activity');
        if (actEl && actEl.textContent !== activity) actEl.textContent = activity;
        const previewEl = node.querySelector('.tile-preview');
        if (previewEl) { const tail = this._tileTailText(id); if (previewEl.textContent !== tail) previewEl.textContent = tail; }
        const elapsedEl = node.querySelector('.tile-elapsed');
        if (elapsedEl && elapsedEl.textContent !== elapsed) elapsedEl.textContent = elapsed;
        const pie = node.querySelector('.tile-pie');
        if (pie) this._paintTilePie(pie, pct);
    }

    _statusLabel(status) {
        if (status === 'working') return 'Working...';
        if (status === 'done') return 'Awaiting next prompt';
        if (status === 'attention') return 'Needs input';
        if (status === 'error') return 'API error';
        return 'Shell ready';
    }

    _formatElapsed(since) {
        const ms = Date.now() - since;
        if (ms < 5000) return 'just now';
        const s = Math.floor(ms / 1000);
        if (s < 60) return s + 's';
        const m = Math.floor(s / 60);
        if (m < 60) return m + 'm';
        const h = Math.floor(m / 60);
        return h + 'h ' + (m % 60) + 'm';
    }

    _refreshTileElapsed() {
        if (this.viewMode !== 'tiles' || !this._tilesGridEl) return;
        // Skip the per-second 17-tile buffer scan while backgrounded (phone
        // screen off / app in another tab) — it resumes on foreground.
        if (document.hidden) return;
        for (const node of this._tilesGridEl.querySelectorAll('.tile')) {
            const id = Number(node.dataset.tileId);
            // Live terminal tail — refreshed for every tile, even idle shells.
            const previewEl = node.querySelector('.tile-preview');
            if (previewEl) { const tail = this._tileTailText(id); if (previewEl.textContent !== tail) previewEl.textContent = tail; }
            const s = this._agentBuf.get(id);
            if (!s) continue;
            if (s.lastChange) {
                const elapsedEl = node.querySelector('.tile-elapsed');
                if (elapsedEl) elapsedEl.textContent = this._formatElapsed(s.lastChange);
            }
            const statusEl = node.querySelector('.tile-status-line');
            if (statusEl && statusEl.textContent !== (s.statusLine || '')) statusEl.textContent = s.statusLine || '';
            const actionEl = node.querySelector('.tile-action-line');
            const actionText = s.actionLine ? '⏺ ' + s.actionLine : '';
            if (actionEl && actionEl.textContent !== actionText) actionEl.textContent = actionText;
        }
    }

    _paintTilePie(pie, pct) {
        if (pct <= 0) {
            pie.style.background = 'rgba(255,255,255,0.15)';
        } else {
            const color = this._ctxColor(pct);
            pie.style.background = `conic-gradient(${color} ${pct}%, rgba(255,255,255,0.15) 0%)`;
        }
        pie.title = pct > 0 ? `Context: ${pct}%` : '';
    }

    // Overarching supervisor summary — same data as the mobile FLEET bar.
    // The daemon streams `manager` frames whenever supervisor state changes;
    // this pins them as a card at the top of the tiles dashboard. Display
    // only: it never sends anything, so it can't disturb the daemon or the
    // sessions it reports on.
    _onManager(d) {
        this._manager = d;
        if (this.viewMode === 'tiles') this._renderFleetBar();
    }

    _renderFleetBar() {
        if (!this._tilesGridEl) return;
        const d = this._manager;
        if (!d || !d.counts || !d.counts.total) {
            if (this._fleetBarEl) { this._fleetBarEl.remove(); this._fleetBarEl = null; }
            return;
        }
        if (!this._fleetBarEl || !this._fleetBarEl.isConnected) {
            this._fleetBarEl = el('div', { class: 'dashboard-fleet-bar' });
        }
        // Always pinned above the port info card.
        if (this._tilesGridEl.firstChild !== this._fleetBarEl) {
            this._tilesGridEl.insertBefore(this._fleetBarEl, this._tilesGridEl.firstChild);
        }
        const c = d.counts;
        const row = el('div', { class: 'fleet-row' });
        row.appendChild(el('span', { class: 'fleet-title', text: `FLEET · ${c.total}` }));
        const chip = (label, n, cls) => {
            if (n > 0) row.appendChild(el('span', { class: `fleet-chip ${cls}`, text: `${n} ${label}` }));
        };
        chip('working',    c.working,     'fleet-working');
        chip('need input', c.attention,   'fleet-attention');
        chip('stuck',      c.stuck,       'fleet-stuck');
        chip('idle',       c.idle,        'fleet-idle');
        chip('high ctx',   c.highContext, 'fleet-ctx');
        chip('limited',    c.limited,     'fleet-limited');
        const attention = (d.sessions || []).filter(s => s.attention).map(s => s.title);
        const stuck     = (d.sessions || []).filter(s => s.stuck).map(s => s.title);
        const callout = [];
        if (attention.length) callout.push(`⚠ awaiting you: ${attention.slice(0, 3).join(', ')}${attention.length > 3 ? '…' : ''}`);
        if (stuck.length) callout.push(`◷ stuck: ${stuck.slice(0, 3).join(', ')}`);
        const kids = [row];
        if (callout.length) kids.push(el('div', { class: 'fleet-callout', text: callout.join('  ·  ') }));
        this._fleetBarEl.replaceChildren(...kids);
    }

    async _updateDashboardPortInfo() {
        if (!this._tilesGridEl) return;

        // _renderTiles fires on every snapshot, and each call used to start
        // its own fetch; concurrent slow responses then stacked duplicate
        // "Active Ports" cards (each removed the old card BEFORE its fetch
        // and inserted AFTER). One in-flight fetch at a time, refreshed at
        // most every 10s — the existing card stays up in the meantime.
        if (this._portInfoBusy) return;
        if (this._portInfoAt && Date.now() - this._portInfoAt < 10_000) return;
        this._portInfoBusy = true;

        try {
            const backend = (window.__SOA_WEB__ || {})._resolvedBackend || '';
            const token = (window.__SOA_WEB__ || {})._resolvedToken || '';
            const url = new URL(backend + '/api/ports');
            if (token) url.searchParams.set('t', token);

            const res = await fetch(url.toString(), { credentials: 'include' });
            if (!res.ok) return;

            const { data } = await res.json();
            this._portInfoAt = Date.now();
            if (!this._tilesGridEl) return;
            const count = data.ports.length;

            const portInfo = el('div', { class: 'dashboard-port-info' });
            const header = el('div', { class: 'dashboard-port-header' });
            const countLabel = count === 1 ? '1 Active Port' : `${count} Active Ports`;
            const countEl = el('span', { class: 'dashboard-port-count', text: countLabel });
            header.appendChild(countEl);

            if (data.conflict) {
                const conflictEl = el('span', {
                    class: 'dashboard-port-conflict',
                    text: `⚠ Port ${data.conflict.port} conflict`
                });
                header.appendChild(conflictEl);
            }

            portInfo.appendChild(header);

            if (count > 0) {
                const list = el('div', { class: 'dashboard-port-list' });
                // Every port is clickable → opens it in the preview (proxied
                // through /preview/<port>/ so it's viewable here and on paired
                // phones). It's always safe — the proxy only ever reaches your
                // own localhost; non-web ports just render whatever they serve.
                data.ports.forEach(p => {
                    const item = el('button', {
                        class: 'dashboard-port-item',
                        type: 'button',
                        title: `Open localhost:${p.port} (${p.process}) in the preview`,
                        text: `:${p.port} — ${p.process}`,
                        onclick: async () => {
                            try {
                                const wp = await import('/assets/previewPanel.js?v=2');
                                wp.openPreviewModal(this, String(p.port));
                            } catch (err) { console.warn('[ports] preview open failed', err); }
                        },
                    });
                    list.appendChild(item);
                });
                portInfo.appendChild(list);
            }

            // Swap in atomically: clear every existing copy (including any
            // duplicates an older build left behind) only now that the
            // replacement is ready, then pin below the FLEET bar if present.
            this._tilesGridEl.querySelectorAll('.dashboard-port-info').forEach(n => n.remove());
            const anchor = (this._fleetBarEl && this._fleetBarEl.isConnected)
                ? this._fleetBarEl.nextSibling
                : this._tilesGridEl.firstChild;
            this._tilesGridEl.insertBefore(portInfo, anchor);
        } catch (e) {
            // Silently fail - port info is optional
        } finally {
            this._portInfoBusy = false;
        }
    }

    _removeTilesGrid() {
        if (this._tilesGridEl) { this._tilesGridEl.remove(); this._tilesGridEl = null; this._tilesDropInstalled = false; }
    }

    _installTilesDrop() {
        if (this._tilesDropInstalled || !this._tilesGridEl) return;
        this._tilesDropInstalled = true;
        const grid = this._tilesGridEl;
        grid.addEventListener('dragover', (e) => {
            if (this._tileDragId == null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const beforeId = this._tileDropTarget(e);
            this._paintTileDropTarget(beforeId);
        });
        grid.addEventListener('dragleave', (e) => {
            if (e.target === grid) this._clearTileDropTarget();
        });
        grid.addEventListener('drop', (e) => {
            if (this._tileDragId == null) return;
            e.preventDefault();
            this._tileDragDidMove = true;
            const beforeId = this._tileDropTarget(e);
            this._clearTileDropTarget();
            const dragId = this._tileDragId;
            this._tileDragId = null;
            this._applyMove(dragId, { beforeId });
        });
    }

    _tileDropTarget(e) {
        const tiles = Array.from(this._tilesGridEl.querySelectorAll('.tile'));
        for (let i = 0; i < tiles.length; i++) {
            const r = tiles[i].getBoundingClientRect();
            if (e.clientY >= r.top && e.clientY <= r.bottom &&
                e.clientX >= r.left && e.clientX <= r.right) {
                const midX = r.left + r.width / 2;
                if (e.clientX < midX) {
                    return Number(tiles[i].dataset.tileId);
                } else {
                    return i + 1 < tiles.length ? Number(tiles[i + 1].dataset.tileId) : -1;
                }
            }
        }
        return -1;
    }

    _paintTileDropTarget(beforeId) {
        this._clearTileDropTarget();
        if (beforeId === -1) return;
        const node = this._tilesGridEl.querySelector(`[data-tile-id="${beforeId}"]`);
        if (node) { node.classList.add('drop-target'); this._tileDropNode = node; }
    }

    _clearTileDropTarget() {
        if (this._tileDropNode) { this._tileDropNode.classList.remove('drop-target'); this._tileDropNode = null; }
    }

    _openTileTerminal(id) {
        if (this.viewMode !== 'tiles') return;
        const rt = this.tabs.get(id);
        if (!rt) return;

        this._tileOverlayId = id;
        this.activeId = id;
        if (this._tilesGridEl) this._tilesGridEl.style.display = 'none';

        if (!this._tileOverlayEl) {
            this._tileOverlayEl = el('div', { class: 'tile-terminal-overlay' });
            this.termsEl.appendChild(this._tileOverlayEl);
        }

        const body = el('div', { class: 'tile-terminal-body' });
        body.appendChild(rt.container);
        rt.container.classList.add('active');
        rt.container.style.display = 'block';

        this._tileOverlayEl.replaceChildren(body);
        this._tileOverlayEl.style.display = '';

        // Show topbar BACK button
        const backBtn = document.getElementById('tile-back');
        if (backBtn) {
            backBtn.style.display = '';
            backBtn.onclick = () => this._closeTileTerminal();
        }

        requestAnimationFrame(() => {
            rt.fitNow();
            rt.flushPendingReplay();
            rt.scrollToBottom();
            rt.focus();
            this._pollDirty.add(id);   // re-scan ctx%/status after the flush paint
        });

        this.bridge.input(INPUT_KIND.SWITCH_TAB, { id });
        this.audio.play('panels');
    }

    _closeTileTerminal() {
        if (!this._tileOverlayEl) return;
        const id = this._tileOverlayId;
        this._tileOverlayId = null;

        // Hide topbar BACK button
        const backBtn = document.getElementById('tile-back');
        if (backBtn) backBtn.style.display = 'none';

        // Move the terminal container back to #terms
        if (id != null) {
            const rt = this.tabs.get(id);
            if (rt) {
                rt.container.classList.remove('active');
                rt.container.style.display = '';
                this.termsEl.appendChild(rt.container);
            }
        }

        this._tileOverlayEl.replaceChildren();
        this._tileOverlayEl.style.display = 'none';
        if (this._tilesGridEl) this._tilesGridEl.style.display = '';
        this._renderTiles();
    }

    _removeTileOverlay() {
        if (this._tileOverlayId != null) {
            const rt = this.tabs.get(this._tileOverlayId);
            if (rt) {
                rt.container.classList.remove('active');
                rt.container.style.display = '';
                this.termsEl.appendChild(rt.container);
            }
        }
        this._tileOverlayId = null;
        if (this._tileOverlayEl) { this._tileOverlayEl.remove(); this._tileOverlayEl = null; }
    }
}

// ── Boot ──────────────────────────────────────────────────────────────────
async function resolveBackend() {
    const fromURL = pickBackendFromURL();
    if (fromURL) {
        const probed = await probePing(fromURL.backend, fromURL.token, 3500);
        if (probed && probed.ok) {
            saveBackend(fromURL.backend, fromURL.token);
            return fromURL;
        }
        // Pairing via deep link failed — say so, but keep going: a saved or
        // local backend may still be reachable (previously this dead-ended).
        console.warn('[soa-web] ?backend= pairing failed (unreachable):', fromURL.backend);
        const bs = $('#boot-status');
        if (bs) bs.textContent = tr('boot.negotiating') + ' (pairing link unreachable — trying known backends)';
    }
    const saved = loadSaved();
    if (saved) {
        const probed = await probePing(saved.backend, saved.token, 2500);
        if (probed && probed.ok) return saved;
        // Do NOT clear the pairing on one failed ping — a daemon restart or a
        // transient outage used to permanently un-pair the browser here and
        // funnel boot into the sandbox fallback. Keep it; it is re-probed on
        // every load and the user can overwrite it via ?backend= any time.
        console.warn('[soa-web] saved backend unreachable, keeping pairing:', saved.backend);
    }
    if (CFG.backend) {
        const cfgBackend = String(CFG.backend).replace(/\/+$/, '');
        const probed = await probePing(cfgBackend, '', 2000);
        if (probed && probed.ok) return { backend: cfgBackend, token: '' };
    }
    if (CFG.mode !== 'webcontainer') {
        const same = location.origin.replace(/\/+$/, '');
        const probed = await probePing(same, '', 1500);
        if (probed && probed.ok) return { backend: same, token: '' };
    }
    // Last-chance probe for a locally-installed backend (scripts/install.sh
    // drops a launchd/systemd service that binds 127.0.0.1:4010). Runs in
    // both server and webcontainer modes so a visitor who runs the install
    // gets auto-upgraded to real-shell mode on their next reload — no deep
    // link, no pasting. Skipped on http pages when talking to https (mixed
    // content) and vice-versa; and on localhost itself it's a no-op (the
    // same-origin probe above already covered it).
    if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') {
        // Browsers allow https → http://localhost since Chrome 94 / Safari 18
        // (treated as a "potentially trustworthy" origin). If a browser still
        // blocks it the fetch just fails and we fall through to sandbox.
        // Use localhost (not 127.0.0.1) when on HTTPS — browsers treat localhost
        // as a secure origin but block http://IP as mixed content.
        const local = location.protocol === 'https:' ? 'http://localhost:4010' : 'http://127.0.0.1:4010';
        const probed = await probePing(local, '', 1000);
        if (probed && probed.ok) return { backend: local, token: '' };
    }
    return null;
}

async function bootServerMode({ backend, token }) {
    const crossOrigin = backend !== location.origin.replace(/\/+$/, '');
    CFG._resolvedBackend = backend;
    CFG._resolvedToken = token || '';
    $('#boot-status').textContent = tr('boot.negotiating');
    try { await fetch(apiUrl(backend, token, '/api/me'), FETCH_INIT); } catch (_) {}

    $('#boot-status').textContent = tr('boot.opening');
    const s0 = getSettings();
    const audio = new AudioFX({ enabled: s0.audio, volume: s0.audioVolume, feedbackEnabled: !s0.disableFeedbackAudio });
    const bridge = new Bridge({ url: wsUrl(backend, token) });
    const shell = new Shell(bridge, { audio, backend, token });
    CFG._bridge = bridge;
    CFG._shell = shell;
    bridge.connect();
    $('#status-session').textContent = crossOrigin ? new URL(backend).host : location.host;

    mountSidebar($('#sidebar'), { audio, backend, token });

    setTimeout(() => {
        $('#boot').classList.add('hidden');
        $('#shell').classList.remove('hidden');
        shell._fitActive();
        if (shell.viewMode === 'tiles') shell._applyViewMode();
        audio.play('theme');
    }, s0.nointro ? 0 : 250);

    import('/assets/timemachine.js?v=1')
        .then(tm => tm.startTimemachine(shell))
        .catch(err => console.warn('[timemachine] boot failed', err));
}

async function _doBoot() {
    wireLangSelector();
    wireReleaseLink();
    wireVersion();
    applyStatic();
    const backend = await resolveBackend();
    if (backend) {
        await bootServerMode(backend);
        return;
    }
    // No reachable backend — hand off to the in-browser sandbox. The import
    // is guarded: if ANY module in the sandbox graph fails to fetch, Chrome
    // rejects with "Failed to fetch dynamically imported module: app-wc.js"
    // naming only the top-level file. Without the guard that error killed
    // boot dead with no retry and no way to pair a backend.
    try {
        await import('/assets/app-wc.js?v=14');
    } catch (err) {
        console.error('[soa-web] sandbox module graph failed to load', err);
        // Name the actual failing resource(s) — the error string won't.
        try {
            const bad = performance.getEntriesByType('resource')
                .filter(e => (e.initiatorType === 'script' || e.initiatorType === 'other')
                    && e.transferSize === 0 && e.decodedBodySize === 0
                    && /\/assets\/|esm\.sh|webcontainer/.test(e.name));
            if (bad.length) console.error('[soa-web] suspect resources:', bad.map(e => e.name));
        } catch (_) {}
        renderSandboxFailure(err);
    }
}

// Sandbox failed to load (CDN/network/deploy hiccup). Give the user real
// options instead of a dead boot screen: retry, or pair a backend directly
// (the manual-connect prompt normally lives inside app-wc.js — unreachable
// when the import itself is what failed).
function renderSandboxFailure(err) {
    const node = $('#boot-status');
    if (!node) return;
    const detail = err && err.message ? err.message : String(err);
    node.textContent = tr('boot.failed', { detail });
    const actions = document.createElement('div');
    actions.style.cssText = 'margin-top:12px;display:flex;gap:10px;justify-content:center;';
    const mkBtn = (label, fn) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'padding:6px 14px;background:transparent;border:1px solid currentColor;color:inherit;cursor:pointer;font:inherit;';
        b.addEventListener('click', fn);
        return b;
    };
    actions.appendChild(mkBtn('RETRY', () => location.reload()));
    actions.appendChild(mkBtn('CONNECT BACKEND…', () => {
        const backend = window.prompt('Backend URL (e.g. http://localhost:4010, or from `npm run selfhost`):', 'http://localhost:4010');
        if (!backend) return;
        const token = window.prompt('Session token (leave empty if none):') || '';
        saveBackend(backend, token.trim());
        location.reload();
    }));
    node.insertAdjacentElement('afterend', actions);
}

function bootFailed(err) {
    console.error('[soa-web] boot failed', err);
    const detail = err && err.stack
        ? err.stack.split('\n').slice(0, 3).join(' | ')
        : String(err);
    const node = $('#boot-status');
    if (node) node.textContent = tr('boot.failed', { detail });
}

async function boot() {
    const html = document.documentElement;
    // Welcome gate: first visit stops here, but we expose __soaBootNow so
    // the "ENTER TERMINAL" button can drop the gate and finish boot
    // without a full reload. The .catch matters: this path used to swallow
    // boot errors entirely (first visits never saw boot.failed).
    if (html.dataset.welcome === '1') {
        window.__soaBootNow = () => _doBoot().catch(bootFailed);
        return;
    }
    await _doBoot();
}

boot().catch(bootFailed);
