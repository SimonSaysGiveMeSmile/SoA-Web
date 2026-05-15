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

import { Bridge, INPUT_KIND } from '/assets/bridge.js?v=15';
import { AudioFX } from '/assets/audiofx.js?v=15';
import { mountSidebar } from '/assets/widgets.js?v=14';
import { t as tr, getLang, setLang, applyStatic, LANGS } from '/assets/i18n.js?v=14';
import { getSettings, onSettings, openSettingsModal } from '/assets/settings.js?v=13';

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

function clearSaved() { try { localStorage.removeItem(LS_KEY); } catch (_) {} }

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
        if (token) u.searchParams.set('t', token);
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
        return true;
    }

    attach(onData, onResize) {
        this._onData = onData;
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
        }
    }

    write(data) { this.term.write(data); }

    // Queue replay bytes for later. If the container is already visible
    // and sized, we can flush immediately; otherwise the caller will call
    // flushPendingReplay() once the tab becomes active.
    queueReplay(data) {
        if (!data) return;
        this._pendingReplay += data;
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
            this._everFit = true;
            return { cols: this.term.cols, rows: this.term.rows };
        } catch (_) { return { cols: this.term.cols, rows: this.term.rows }; }
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
        if (this._ensureOpen()) { try { this.fit.fit(); } catch (_) {} }
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
        this.tabsEl = $('#tabs');
        this.termsEl = $('#terms');
        this.sidebarEl = $('#sidebar');
        this._lastStdoutCue = new Map(); // tabId → performance.now() of last stdout cue
        this._prevConnState = null;
        this._agentStatus = new Map(); // tabId → 'working'|'done'|'attention'|'idle'
        this._agentBuf = new Map();    // tabId → detector state (see _pollAgentStatus)
        this._ctxPct = new Map();      // tabId → 0-100 context usage %
        // Poll the second-to-last visible terminal line every second — that's
        // where Claude Code's Ink status bar always lives. More reliable than
        // scanning the PTY stream because Ink re-renders in-place via cursor-up.
        this._ctxPollTimer = setInterval(() => this._pollCtxLines(), 500);
        this._tileElapsedTimer = setInterval(() => this._refreshTileElapsed(), 1000);
        // Server-side graveyard, mirrored on HELLO / SNAPSHOT. Newest entry
        // is at the end; an empty list means there's nothing to restore.
        this.graveyard = [];
        // Session-scoped "don't ask again" flag for the close-confirm modal.
        // Reset on reload — we want the guard back each time the app boots.
        this._skipCloseConfirm = false;

        // View mode: 'tabs' (classic) or 'tiles' (dashboard grid).
        this.viewMode = 'tabs';
        try { this.viewMode = localStorage.getItem('soa_web_view_mode') || 'tabs'; } catch (_) {}
        this._tileOverlayId = null; // id of the tab currently open in tile overlay
        this._tilesGridEl = null;
        this._tileOverlayEl = null;

        const viewBtn = $('#toggle-view');
        if (viewBtn) {
            viewBtn.addEventListener('click', () => this._toggleViewMode());
            this._updateViewBtn();
        }

        $('#new-tab').addEventListener('click', () => {
            this.audio.play('granted');
            this.bridge.input(INPUT_KIND.NEW_TAB, this._sendSize());
        });

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
        sideBtn.addEventListener('click', () => {
            stageEl.classList.toggle('no-sidebar');
            this.audio.play('panels');
            this._fitActive();
        });
        // Tapping the scrim behind the overlay sidebar closes it.
        stageEl.addEventListener('click', e => {
            if (e.target !== stageEl) return;
            if (!window.matchMedia('(max-width: 768px)').matches) return;
            if (stageEl.classList.contains('no-sidebar')) return;
            stageEl.classList.add('no-sidebar');
            this._fitActive();
        });

        window.addEventListener('resize', () => this._fitActive());
        window.addEventListener('orientationchange', () => setTimeout(() => this._fitActive(), 150));
        window.addEventListener('keydown', e => this._hotkey(e));

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
        bridge.addEventListener('snapshot',  e => this._onSnapshot(e.detail));
        bridge.addEventListener('term-data', e => this._onTermData(e.detail));
        bridge.addEventListener('term-exit', e => this._onTermExit(e.detail));
        bridge.addEventListener('status',    e => this._onStatus(e.detail));
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

    _onHello({ tabs, activeId, replay, graveyard }) {
        this._updateGraveyard(graveyard);
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
                    if (rt && r.data) rt.queueReplay(r.data);
                }
            }
            const target = (activeId && tabs.some(t => t.id === activeId)) ? activeId : tabs[0].id;
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
        } else {
            this.bridge.input(INPUT_KIND.NEW_TAB, this._sendSize());
        }
    }

    _onSnapshot({ tabs, activeId, graveyard }) {
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
        const nextActive = (activeId && this.tabs.has(activeId)) ? activeId
            : (this.activeId == null && tabs[0]) ? tabs[0].id : null;
        if (nextActive && nextActive !== this.activeId) this._activate(nextActive);
        const tabsEl = $('#status-tabs');
        const tabsKey = tabs.length === 1 ? 'status.tabs_one' : 'status.tabs_other';
        tabsEl.textContent = tr(tabsKey, { n: tabs.length });
        tabsEl.setAttribute('data-i18n', tabsKey);
        tabsEl.setAttribute('data-i18n-vars', JSON.stringify({ n: tabs.length }));
    }

    _onTermData({ id, data }) {
        const t = this.tabs.get(id);
        if (t) t.write(data);
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
            }
        }
        if (!sameTab) this.bridge.input(INPUT_KIND.SWITCH_TAB, { id });
        this._syncTabsUI();
        if (switching && this.viewMode !== 'tiles') this.audio.play('panels');
    }

    _syncTabsUI(list) {
        const tabs = list || this.order.map(id => ({ id, title: (this.tabs.get(id) || {}).title }));
        const signature = tabs.map(t => `${t.id}:${t.title || ''}`).join('|') + '#' + (this.activeId || 0) + '#' + tabs.map(t => this._agentStatus.get(t.id) || '').join('|');
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
            const dot = this._makePie(this._ctxPct.get(t.id) || 0, t.id);
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
            }, [dot, label, x]);
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

    _makePie(pct, tabId) {
        const color = pct >= 90 ? '#ff5555' : pct >= 75 ? '#ff9944' : pct >= 50 ? '#f1fa8c' : '#aacfd1';
        const span = el('span', {
            class: 'ctx-pie',
            title: pct > 0 ? `Context: ${pct}%\nClick for details` : 'Context: —',
            onclick: (e) => { e.stopPropagation(); this._showCtxModal(tabId, pct); }
        });
        span.style.background = pct <= 0
            ? 'rgba(255,255,255,0.15)'
            : `conic-gradient(${color} ${pct}%, rgba(255,255,255,0.15) 0%)`;
        return span;
    }

    _updateCtxPie(id, pct) {
        const node = this.tabsEl.querySelector(`[data-tab-id="${CSS.escape(String(id))}"] .ctx-pie`);
        if (!node) { this._tabsUISig = null; this._syncTabsUI(); return; }
        node.replaceWith(this._makePie(pct, id));
    }

    _showCtxModal(tabId, pct) {
        // Remove any existing popover
        document.getElementById('ctx-popover')?.remove();

        const pie = this.tabsEl.querySelector(`[data-tab-id="${CSS.escape(String(tabId))}"] .ctx-pie`);
        if (!pie) return;

        const bar = pct > 0
            ? `<div class="ctx-pop-bar"><div class="ctx-pop-fill" style="width:${pct}%;background:${pct>=90?'#ff5555':pct>=75?'#ff9944':pct>=50?'#f1fa8c':'#aacfd1'}"></div></div>`
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
        for (const [id, rt] of this.tabs) {
            if (!rt._opened) continue;
            try {
                const buf = rt.term.buffer.active;
                const viewportEnd = buf.baseY + rt.term.rows - 1;
                const line = buf.getLine(viewportEnd - 1);
                if (!line) continue;
                const text = line.translateToString(true);
                let pct = null, m;
                if ((m = text.match(/(\d{1,3})%\s+context\s+used/i)))             pct = +m[1];
                else if ((m = text.match(/(\d{1,3})%\s+until\s+auto-compact/i)))  pct = 100 - +m[1];
                else if ((m = text.match(/Context\s+low\s*\((\d{1,3})%/i)))       pct = 100 - +m[1];
                else if ((m = text.match(/Context\s+is\s+(\d{1,3})%/i)))          pct = +m[1];
                if (pct !== null) {
                    pct = Math.min(100, Math.max(0, pct));
                    if (pct !== this._ctxPct.get(id)) {
                        this._ctxPct.set(id, pct);
                        this._updateCtxPie(id, pct);
                    }
                }
            } catch (_) {}
        }
        this._pollAgentStatus();
    }

    // Read the last N visible lines from the terminal buffer to detect agent
    // state. This replaces the old stream-based approach which was unreliable
    // because Ink re-renders in place via cursor-up, making the stripped stream
    // buffer diverge from what's actually on screen.
    _pollAgentStatus() {
        const DET = this._detector || (this._detector = {
            working: [
                /esc to interrupt/i,
                /\(esc\s+to\s+cancel\)/i,
                /[✳✻◆●◉⟡]\s*\S/,
                /\b(?:Thinking|Pondering|Crafting|Running|Executing|Processing|Working|Reading|Writing|Editing|Searching|Fetching|Analyzing|Wrangling|Brewing|Planning|Compiling|Installing|Building|Testing|Formatting|Linting|Deploying|Pushing|Pulling|Cloning|Downloading|Uploading|Generating|Updating|Checking|Scanning|Indexing|Resolving|Compacting|Streaming|Connecting|Waiting|Loading|Preparing|Initializing|Starting|Applying|Committing|Merging|Rebasing|Diffing)\b[.…]/i,
                /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,
                /\b(?:Thinking|Pondering|Crafting|Running|Executing|Processing|Working|Reading|Writing|Editing|Searching|Fetching|Analyzing|Wrangling|Brewing|Planning|Compiling|Installing|Building|Testing|Formatting|Linting|Deploying|Pushing|Pulling|Cloning|Downloading|Uploading|Generating|Updating|Checking|Scanning|Indexing|Resolving|Compacting|Streaming|Connecting|Waiting|Loading|Preparing|Initializing|Starting|Applying|Committing|Merging|Rebasing|Diffing)\b.*[…⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/i,
            ],
            doneBox: /╰─+╯/,
            donePrompt: /│\s*>/,
            attention: [
                /Do you want to (?:proceed|continue|make this change|accept)/i,
                /\n?\s*\d+\.\s+(?:Yes|No|Accept|Reject|Allow|Deny)\b/i,
                /\(y\/n\)/i,
                /\[Y\/n\]/i,
                /\(Y\)es\s*\/\s*\(N\)o/i,
                /Press\s+Enter\s+to/i,
                /waiting\s+for\s+(?:your\s+)?input/i,
                /Allow\s+.*\s+tool/i,
                /Allow\?/i,
                /❯\s+(?:Yes|No|Allow|Deny|Accept|Reject)/i,
                /\bPermission\s+(?:required|needed|denied)\b/i,
                /\bAllow\s+once\b/i,
                /\bAllow\s+always\b/i,
                /\bDo you want to\b/i,
                /\bApprove\b.*\?/i,
            ],
            shellPrompt: /(?:^|\n)[^\n]{0,80}?(?:[➜❯▶►»](?:\s|$)|[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+[^\n]*[\$#%]\s*$)/m,
        });

        for (const [id, rt] of this.tabs) {
            if (!rt._opened) continue;
            try {
                const buf = rt.term.buffer.active;
                const totalRows = rt.term.rows;
                const startRow = buf.baseY + Math.max(0, totalRows - 12);
                const endRow = buf.baseY + totalRows;
                let visible = '';
                for (let r = startRow; r < endRow; r++) {
                    const line = buf.getLine(r);
                    if (line) visible += line.translateToString(true) + '\n';
                }
                if (!visible.trim()) continue;

                // Debug: log buffer content for active tab (open DevTools console)
                if (id === this.activeId && window.__SOA_DEBUG_AGENT) {
                    console.log(`[agent-detect] tab=${id} visible=`, JSON.stringify(visible.split('\n').map((l,i) => `${i}: ${l}`)));
                }

                let next;
                let activity = '';
                // Priority: working > attention > done > idle
                // "esc to interrupt" means the agent is actively running — highest priority.
                if (DET.working.some(p => p.test(visible))) {
                    next = 'working';
                    const vm = visible.match(/\b(Thinking|Pondering|Crafting|Running|Executing|Processing|Working|Reading|Writing|Editing|Searching|Fetching|Analyzing|Wrangling|Brewing|Planning|Compiling|Installing|Building|Testing|Formatting|Linting|Deploying|Pushing|Pulling|Cloning|Downloading|Uploading|Generating|Updating|Checking|Scanning|Indexing|Resolving|Compacting|Streaming|Connecting|Waiting|Loading|Preparing|Initializing|Starting|Applying|Committing|Merging|Rebasing|Diffing)\b/i);
                    activity = vm ? vm[1] + '...' : 'Working...';
                } else if (DET.attention.some(p => p.test(visible))) {
                    next = 'attention';
                    activity = 'Needs input';
                    for (const p of DET.attention) {
                        const m = visible.match(p);
                        if (m) { activity = m[0].trim().slice(0, 40); break; }
                    }
                } else if (DET.doneBox.test(visible) && DET.donePrompt.test(visible)) {
                    next = 'done';
                    activity = 'Awaiting next prompt';
                } else if (DET.shellPrompt.test(visible)) {
                    next = 'idle';
                    activity = '';
                } else {
                    next = null;
                }

                // Extract last meaningful line for tile summary
                const lines = visible.split('\n').filter(l => l.trim() && !/^[\s─╰╭│]*$/.test(l));
                const lastLine = lines.length ? lines[lines.length - 1].trim().slice(0, 80) : '';

                // Extract Claude Code status line (e.g. "Thinking… (16s · ↑ 133 tokens)" or "✳ Compacting conversation…")
                const statusLineMatch = visible.match(/[✳✻◆●◉⟡]\s*[^\n]{3,60}/) ||
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

                if (next == null) continue;
                const current = this._agentStatus.get(id) || 'idle';
                if (next === current) {
                    if (s.pending) { clearTimeout(s.pending); s.pending = null; s.pendingStatus = null; }
                    continue;
                }

                // Debounce: attention is urgent, working is quick, done/idle wait
                const delay = next === 'attention' ? 100
                            : next === 'working'   ? 100
                            : 400;

                if (s.pendingStatus === next) continue;
                if (s.pending) clearTimeout(s.pending);
                s.pendingStatus = next;
                s.pending = setTimeout(() => {
                    s.pending = null;
                    s.pendingStatus = null;
                    this._setStatus(id, next);
                }, delay);
            } catch (_) {}
        }
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
        this._tabsUISig = null;
        this._syncTabsUI();
        // Live-update the tile if in tiles mode without a full re-render.
        if (this.viewMode === 'tiles' && this._tilesGridEl) {
            const node = this._tilesGridEl.querySelector(`[data-tile-id="${id}"]`);
            if (node) this._updateTileNode(node, id);
        }
        if (status === 'attention' && prev !== 'attention') {
            const tab = this.tabs.get(id);
            const title = (tab && tab.title) || tr('tab.default', { id });
            this._notifyAttention(title);
        }
    }

    _notifyAttention(tabTitle) {
        // Web Notification if permitted
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(`Tab ${tabTitle} needs your attention.`, { silent: true });
        } else if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission().then(p => {
                if (p === 'granted') new Notification(`Tab ${tabTitle} needs your attention.`, { silent: true });
            });
        }
        // In-app toast as fallback / supplement
        const existing = document.getElementById('soa-agent-toast');
        if (existing) existing.remove();
        const toast = el('div', { id: 'soa-agent-toast', class: 'soa-toast soa-toast--agent', role: 'alert', 'aria-live': 'assertive' }, [
            el('div', { class: 'soa-toast-icon', 'aria-hidden': 'true', text: '!' }),
            el('div', { class: 'soa-toast-body' }, [
                el('p', { class: 'soa-toast-title', text: `Tab ${tabTitle} needs your attention.` }),
            ]),
        ]);
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.setAttribute('data-show', '1'));
        const dismiss = () => { toast.removeAttribute('data-show'); setTimeout(() => toast.remove(), 320); };
        toast.addEventListener('click', dismiss);
        setTimeout(dismiss, 4000);
    }

    _promptRename(id, current) {
        const next = window.prompt(tr('tab.rename_prompt'), current || tr('tab.default', { id }));
        if (next == null) return;
        const title = next.trim().slice(0, 64);
        if (!title || title === current) return;
        // Optimistically update local cache so no-arg _syncTabsUI calls
        // (agent status, tab switch) don't revert to the stale name while
        // waiting for the server's confirmation snapshot.
        const rt = this.tabs.get(id);
        if (rt) { rt.title = title; this._tabsUISig = null; this._syncTabsUI(); }
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
        if (this.viewMode === 'tiles') {
            shell.setAttribute('data-view', 'tiles');
            this._closeTileTerminal();
            this._renderTiles();
            for (const [, rt] of this.tabs) rt.container.classList.remove('active');
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

    _renderTiles() {
        if (this.viewMode !== 'tiles') return;
        if (!this._tilesGridEl) {
            this._tilesGridEl = el('div', { class: 'tiles-grid' });
            this.termsEl.appendChild(this._tilesGridEl);
        }
        this._tilesGridEl.style.display = '';
        this._installTilesDrop();
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
        this._tilesGridEl.replaceChildren(fragment);
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
            el('span', { class: 'tile-title', text: title }),
            el('span', { class: 'tile-status-line', text: statusLine }),
            el('span', { class: 'tile-action-line', text: actionLine ? '⏺ ' + actionLine : '' }),
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
        const elapsedEl = node.querySelector('.tile-elapsed');
        if (elapsedEl && elapsedEl.textContent !== elapsed) elapsedEl.textContent = elapsed;
        const pie = node.querySelector('.tile-pie');
        if (pie) this._paintTilePie(pie, pct);
    }

    _statusLabel(status) {
        if (status === 'working') return 'Working...';
        if (status === 'done') return 'Awaiting next prompt';
        if (status === 'attention') return 'Needs input';
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
        for (const node of this._tilesGridEl.querySelectorAll('.tile')) {
            const id = Number(node.dataset.tileId);
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
            const color = pct >= 90 ? '#ff5555' : pct >= 75 ? '#ff9944' : pct >= 50 ? '#f1fa8c' : '#aacfd1';
            pie.style.background = `conic-gradient(${color} ${pct}%, rgba(255,255,255,0.15) 0%)`;
        }
        pie.title = pct > 0 ? `Context: ${pct}%` : '';
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
        return null;
    }
    const saved = loadSaved();
    if (saved) {
        const probed = await probePing(saved.backend, saved.token, 2500);
        if (probed && probed.ok) return saved;
        clearSaved();
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
}

async function _doBoot() {
    wireLangSelector();
    wireReleaseLink();
    applyStatic();
    const backend = await resolveBackend();
    if (backend) {
        await bootServerMode(backend);
        return;
    }
    // No reachable backend — hand off to the in-browser sandbox.
    await import('/assets/app-wc.js?v=13');
}

async function boot() {
    const html = document.documentElement;
    // Welcome gate: first visit stops here, but we expose __soaBootNow so
    // the "ENTER TERMINAL" button can drop the gate and finish boot
    // without a full reload.
    if (html.dataset.welcome === '1') {
        window.__soaBootNow = () => _doBoot();
        return;
    }
    await _doBoot();
}

boot().catch(err => {
    console.error('[soa-web] boot failed', err);
    const detail = err && err.stack
        ? err.stack.split('\n').slice(0, 3).join(' | ')
        : String(err);
    const node = $('#boot-status');
    if (node) node.textContent = tr('boot.failed', { detail });
});
