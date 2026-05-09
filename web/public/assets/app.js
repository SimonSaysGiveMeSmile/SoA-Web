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

import { Bridge, INPUT_KIND } from '/assets/bridge.js?v=9';
import { AudioFX } from '/assets/audiofx.js?v=9';
import { mountSidebar } from '/assets/widgets.js?v=9';
import { t as tr, getLang, setLang, applyStatic, LANGS } from '/assets/i18n.js?v=9';
import { getSettings, onSettings, openSettingsModal } from '/assets/settings.js?v=9';

const CFG = (window.__SOA_WEB__ = window.__SOA_WEB__ || {});
const LS_KEY = 'soa_web_backend';

function loadSaved() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        const j = JSON.parse(raw);
        if (!j || typeof j.backend !== 'string') return null;
        return { backend: j.backend.replace(/\/+$/, ''), token: j.token || '' };
    } catch (_) { return null; }
}

function saveBackend(backend, token) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify({
            backend: String(backend || '').replace(/\/+$/, ''),
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
    return { backend: backend.replace(/\/+$/, ''), token };
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
        this.term = new Terminal({
            fontFamily: 'Fira Mono, ui-monospace, Menlo, Consolas, monospace',
            fontSize: s.termFontSize,
            theme: TRON_THEME,
            cursorBlink: s.cursorBlink,
            scrollback: 5000,
            convertEol: false,
        });
        this.fit = new FitAddon.FitAddon();
        this.term.loadAddon(this.fit);
        try { this.term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (_) {}
        this.term.open(this.container);
        this._onData = null;
        this._onResize = null;
    }

    attach(onData, onResize) {
        this._onData = onData;
        this._onResize = onResize;
        this.term.onData(d => this._onData && this._onData(d));
        this.term.onResize(({ cols, rows }) => this._onResize && this._onResize(cols, rows));
    }

    write(data) { this.term.write(data); }

    fitNow() {
        try {
            this.fit.fit();
            return { cols: this.term.cols, rows: this.term.rows };
        } catch (_) { return { cols: this.term.cols, rows: this.term.rows }; }
    }

    focus() { this.term.focus(); }

    applySettings(s) {
        try { this.term.options.fontSize = s.termFontSize; } catch (_) {}
        try { this.term.options.cursorBlink = s.cursorBlink; } catch (_) {}
        try { this.fit.fit(); } catch (_) {}
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
            // Replay server-side scrollback into each xterm BEFORE any live
            // output arrives. A browser reload should land the user exactly
            // where they left off — same tabs, same history, same active
            // tab — with no flash of emptiness and no lost context.
            if (Array.isArray(replay)) {
                for (const r of replay) {
                    const rt = this.tabs.get(r.id);
                    if (rt && r.data) rt.write(r.data);
                }
            }
            const target = (activeId && tabs.some(t => t.id === activeId)) ? activeId : tabs[0].id;
            this._activate(target);
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
    }

    _onTermExit({ id, code }) {
        const t = this.tabs.get(id);
        if (t) t.write(`\r\n\x1b[2m${tr('tab.exited', { code })}\x1b[0m\r\n`);
        this.audio.play(code === 0 ? 'info' : 'alarm');
    }

    _ensureTab(id, title) {
        if (this.tabs.has(id)) return this.tabs.get(id);
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
            const sz = rt.fitNow();
            this.bridge.input(INPUT_KIND.TERM_RESIZE, { id, cols: sz.cols, rows: sz.rows });
            rt.focus();
        }
        if (!sameTab) this.bridge.input(INPUT_KIND.SWITCH_TAB, { id });
        this._syncTabsUI();
        if (switching) this.audio.play('panels');
    }

    _syncTabsUI(list) {
        const tabs = list || this.order.map(id => ({ id, title: (this.tabs.get(id) || {}).title }));
        const signature = tabs.map(t => `${t.id}:${t.title || ''}`).join('|') + '#' + (this.activeId || 0);
        if (signature === this._tabsUISig) return;
        this._tabsUISig = signature;
        this.tabsEl.replaceChildren(...tabs.map(t => {
            const label = el('span', {
                class: 'tab-label',
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
                onclick: () => this._activate(t.id),
            }, [dot, label, x]);
            return root;
        }));
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
        const sz = rt.fitNow();
        this.bridge.input(INPUT_KIND.TERM_RESIZE, { id: this.activeId, cols: sz.cols, rows: sz.rows });
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
        const local = 'http://127.0.0.1:4010';
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
    await import('/assets/app-wc.js?v=9');
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
