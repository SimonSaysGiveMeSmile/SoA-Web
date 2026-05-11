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

import { Bridge, INPUT_KIND } from '/assets/bridge.js?v=14';
import { AudioFX } from '/assets/audiofx.js?v=14';
import { mountSidebar } from '/assets/widgets.js?v=13';
import { t as tr, getLang, setLang, applyStatic, LANGS } from '/assets/i18n.js?v=13';
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

// Narrow + touch viewport heuristic. Mirrors the welcome-gate check in
// index.html so both layers agree on who counts as "mobile."
function isMobileViewport() {
    try {
        const q = window.matchMedia && window.matchMedia('(max-width: 820px) and (pointer: coarse)');
        return !!(q && q.matches);
    } catch (_) { return false; }
}

// iOS/Android-style notification banner. Used when a mobile visitor tries to
// spawn a terminal: xterm can render on the small screen but a real shell is
// not wired for touch, so we refuse the action and surface why in a single
// concise toast.
let _toastTimer = null;
function showMobileUnsupportedToast() {
    const existing = document.getElementById('soa-mobile-toast');
    if (existing) existing.remove();
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }

    const title = tr('mobile.not_supported_title') || 'Use a Mac or Windows';
    const body  = tr('mobile.not_supported_body')
        || 'Terminals are not supported on phones. Open this site on a Mac or Windows PC.';

    const toast = el('div', {
        id: 'soa-mobile-toast',
        class: 'soa-toast',
        role: 'alert',
        'aria-live': 'assertive',
    }, [
        el('div', { class: 'soa-toast-icon', 'aria-hidden': 'true', text: '!' }),
        el('div', { class: 'soa-toast-body' }, [
            el('p', { class: 'soa-toast-title', text: title }),
            el('p', { class: 'soa-toast-text',  text: body  }),
        ]),
    ]);
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.setAttribute('data-show', '1'));

    const dismiss = () => {
        toast.removeAttribute('data-show');
        setTimeout(() => toast.remove(), 320);
    };
    toast.addEventListener('click', dismiss);
    _toastTimer = setTimeout(dismiss, 3800);
}

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
        // Phones: shrink the font so more cols fit and lines don't wrap
        // after 30-something characters. User can override via settings.
        const fontSize = isMobileViewport() ? Math.min(s.termFontSize, 11) : s.termFontSize;
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
        this._lastStdoutCue = 0;
        this._prevConnState = null;
        this._agentStatus = new Map(); // tabId → 'working'|'attention'|'stuck'|'none'
        this._agentBuf = new Map();    // tabId → detector state { buf, thinking, attention, timers, timestamps }

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

    _onHello({ tabs, activeId, replay }) {
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

    _onSnapshot({ tabs, activeId }) {
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
        // Throttle stdout cue to avoid a machine-gun of clicks on heavy output.
        const now = performance.now();
        if (now - this._lastStdoutCue > 180) {
            this._lastStdoutCue = now;
            this.audio.play('stdout');
        }
        this._updateAgentStatus(id, data);
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
        if (this.activeId === id) {
            const next = this.order[0];
            if (next) this._activate(next); else this.activeId = null;
        }
    }

    _activate(id) {
        const switching = this.activeId !== id && this.activeId != null;
        const sameTab = this.activeId === id;
        this.activeId = id;
        for (const [tid, rt] of this.tabs) {
            rt.container.classList.toggle('active', tid === id);
        }
        const rt = this.tabs.get(id);
        if (rt) {
            // fitNow() → xterm onResize → debounced TERM_RESIZE. No direct
            // send here; two in-flight resizes within a frame is exactly
            // the race that misaligns streaming output.
            rt.fitNow();
            // Flush scrollback we queued during HELLO. If this is the
            // first time the tab is visible, xterm just got fit to the
            // real container size, so absolute-column escapes in the
            // replay now address the right columns.
            rt.flushPendingReplay();
            rt.focus();
        }
        if (!sameTab) this.bridge.input(INPUT_KIND.SWITCH_TAB, { id });
        this._syncTabsUI();
        if (switching) this.audio.play('panels');
    }

    _syncTabsUI(list) {
        const tabs = list || this.order.map(id => ({ id, title: (this.tabs.get(id) || {}).title }));
        const signature = tabs.map(t => `${t.id}:${t.title || ''}`).join('|') + '#' + (this.activeId || 0) + '#' + tabs.map(t => this._agentStatus.get(t.id) || '').join('|');
        if (signature === this._tabsUISig) return;
        this._tabsUISig = signature;
        this.tabsEl.replaceChildren(...tabs.map(t => {
            const label = el('span', {
                class: 'tab-label',
                title: tr('tab.rename_hint') || 'Double-click to rename',
                text: t.title || tr('tab.default', { id: t.id }),
                ondblclick: (e) => { e.stopPropagation(); this._promptRename(t.id, t.title); },
            });
            const dot = el('span', { class: 'dot' });
            const x = el('span', { class: 'x', text: '×', onclick: (e) => {
                e.stopPropagation();
                this.audio.play('denied');
                this.bridge.input(INPUT_KIND.CLOSE_TAB, { id: t.id });
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
            return root;
        }));
        this._installTabsDrop();
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

    _updateAgentStatus(id, data) {
        // Per-tab detector state — mirrors desktop ThinkingDetector.
        const DET = this._detector || (this._detector = {
            ansi: /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\(.|.)/g,
            toolStart: [/⏺/, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, /(?:Read|Edit|Write|Bash|Glob|Grep|Task|WebFetch|WebSearch|TodoRead|TodoWrite)\s/, /(?:Read|Edit|Write|Bash|Glob|Grep|Task|WebFetch|WebSearch|TodoRead|TodoWrite)\(/],
            toolEnd: [/\$\s*$/m, /❯\s*$/m, /\w+@\w+.*[\$#]\s*$/m, /%\s*$/m],
            statusMsg: [/Thinking\.\.\./i, /Processing\.\.\./i, /Running\.\.\./i, /Executing\.\.\./i],
            streaming: [/^│\s/m, /^│$/m],
            attention: [/Allow\s+\w+/, /\(Y\)es\s*\/\s*\(N\)o/, /\[Y\/n\]/i, /\(y\/n\)/i, /Do you want to (proceed|continue)/i, /approve/i, /continue\?\s*$/m, /Press Enter to/i, /waiting for.*input/i],
        });
        const s = this._agentBuf.get(id) || { buf: '', thinking: false, attention: false, lastOutput: 0, lastNonEmpty: 0, lastEndTime: 0, debounce: null, stuckTimer: null, silenceTimer: null };
        const clean = data.replace(DET.ansi, '');
        s.buf = (s.buf + clean).slice(-4096);
        s.lastOutput = Date.now();
        if (clean.trim().length > 0) s.lastNonEmpty = Date.now();
        this._agentBuf.set(id, s);

        // Attention detection
        if (!s.attention && DET.attention.some(p => p.test(clean))) {
            s.attention = true;
            this._setStatus(id, 'attention');
            return;
        }

        // Thinking start — any tool use / spinner / status message
        const startDetected = DET.toolStart.some(p => p.test(clean)) ||
                              DET.statusMsg.some(p => p.test(clean)) ||
                              DET.streaming.some(p => p.test(clean));
        // Thinking end — shell prompt returned in buffer tail
        const recent = s.buf.slice(-1024);
        const endDetected = DET.toolEnd.some(p => p.test(recent));

        if (startDetected && !s.thinking) {
            clearTimeout(s.debounce);
            s.debounce = setTimeout(() => {
                s.thinking = true;
                s.attention = false;
                this._setStatus(id, 'working');
                // Stuck detector: if no non-empty output for 30s while thinking → stuck
                clearTimeout(s.stuckTimer);
                s.stuckTimer = setTimeout(() => {
                    if (s.thinking && (Date.now() - s.lastNonEmpty) > 30000) this._setStatus(id, 'stuck');
                }, 30000);
            }, 100);
        } else if (s.thinking && endDetected) {
            clearTimeout(s.debounce);
            s.debounce = setTimeout(() => {
                s.thinking = false;
                s.attention = false;
                s.lastEndTime = Date.now();
                clearTimeout(s.stuckTimer);
                this._setStatus(id, 'none');
            }, 200);
        } else if (s.thinking) {
            // Reset stuck timer on any new output
            clearTimeout(s.stuckTimer);
            s.stuckTimer = setTimeout(() => {
                if (s.thinking && (Date.now() - s.lastNonEmpty) > 30000) this._setStatus(id, 'stuck');
            }, 30000);
        } else if (!s.thinking && !s.attention && !this._agentStatus.has(id)) {
            // Fresh shell with no agent activity
            if (DET.toolEnd.some(p => p.test(recent))) this._setStatus(id, 'none');
        }
    }

    _setStatus(id, status) {
        const prev = this._agentStatus.get(id);
        if (prev === status) return;
        this._agentStatus.set(id, status);
        this._tabsUISig = null;
        this._syncTabsUI();
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
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
            e.preventDefault();
            this.audio.play('granted');
            this.bridge.input(INPUT_KIND.NEW_TAB, this._sendSize());
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'w') {
            e.preventDefault();
            if (this.activeId != null) {
                this.audio.play('denied');
                this.bridge.input(INPUT_KIND.CLOSE_TAB, { id: this.activeId });
            }
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
            e.preventDefault();
            $('#toggle-sidebar').click();
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            openSettingsModal();
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
    // Welcome gate: mobile always stops here (can't use the terminal).
    // Desktop first-visit also stops here, but we expose __soaBootNow so
    // the "ENTER TERMINAL" button can drop the gate and finish boot
    // without a full reload.
    if (html.dataset.welcomeMobile === '1') return;
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
