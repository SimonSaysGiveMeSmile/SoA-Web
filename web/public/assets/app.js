/**
 * SoA-Web client entry.
 *
 * Boot flow:
 *   1. Probe /api/me. If unauthed and mode=shared, show login.
 *   2. Otherwise open /ws.
 *   3. On HELLO, restore known tabs (or open one if empty).
 *
 * xterm.js is loaded from a CDN and attached to a per-tab DOM container. Each
 * tab keeps its own xterm.Terminal + FitAddon instance so switching is
 * instantaneous and output history survives.
 */

import { Bridge, INPUT_KIND } from '/assets/bridge.js';
import { AudioFX } from '/assets/audiofx.js';
import { mountSidebar } from '/assets/widgets.js';

// Resolve the backend origin. `window.__SOA_WEB__.backend` is set by
// web/public/_config.js — empty means "same origin as this page" (self-hosted
// default), non-empty means a cross-origin backend (e.g. a Cloudflare Tunnel
// URL when the static SPA is served by Vercel).
const CFG = (window.__SOA_WEB__ = window.__SOA_WEB__ || {});
const BACKEND_ORIGIN = (CFG.backend || '').replace(/\/+$/, '') || location.origin;
const BACKEND_IS_CROSS = BACKEND_ORIGIN !== location.origin;

const WS_URL = (() => {
    const u = new URL(BACKEND_ORIGIN);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    return u.toString();
})();

function apiUrl(path) { return BACKEND_ORIGIN + path; }

// Cross-site cookies over HTTPS only — browsers reject SameSite=None without
// Secure, and the backend must also send SameSite=None;Secure on its cookie.
const FETCH_INIT = { credentials: 'include' };

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

// ── Auth probe ────────────────────────────────────────────────────────────
async function probeAuth() {
    try {
        const r = await fetch(apiUrl('/api/me'), FETCH_INIT);
        if (!r.ok) return { authed: false, auth: 'shared' };
        return await r.json();
    } catch (_) { return { authed: false, auth: 'shared' }; }
}

async function login(password) {
    const r = await fetch(apiUrl('/api/login'), {
        ...FETCH_INIT,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
    });
    return r.ok;
}

async function logout() {
    try { await fetch(apiUrl('/api/logout'), { ...FETCH_INIT, method: 'POST' }); } catch (_) {}
    location.reload();
}

// ── Tab UI ────────────────────────────────────────────────────────────────
class TabRuntime {
    constructor(id, title) {
        this.id = id;
        this.title = title || `tab ${id}`;
        this.container = el('div', { class: 'term', 'data-tab': String(id) });
        this.term = new Terminal({
            fontFamily: 'Fira Mono, ui-monospace, Menlo, Consolas, monospace',
            fontSize: 13,
            theme: TRON_THEME,
            cursorBlink: true,
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
        $('#logout').addEventListener('click', () => { this.audio.play('denied'); logout(); });

        const audioBtn = $('#toggle-audio');
        audioBtn.addEventListener('click', () => {
            const on = audioBtn.dataset.state !== 'off';
            this.audio.setEnabled(!on);
            audioBtn.dataset.state = on ? 'off' : 'on';
            audioBtn.textContent = on ? '♪ OFF' : '♪ FX';
            if (!on) this.audio.play('info');
        });

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
        s.textContent = state;
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
        $('#status-tabs').textContent = `${tabs.length} tab${tabs.length === 1 ? '' : 's'}`;
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
        if (t) t.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
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
            const label = el('span', { text: t.title || `tab ${t.id}` });
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
    }
}

// ── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
    const cfg = window.__SOA_WEB__ || { auth: 'shared' };
    $('#boot-status').textContent = 'probing session…';
    const me = await probeAuth();

    if (!me.authed && cfg.auth === 'shared') {
        $('#boot').classList.add('hidden');
        $('#login').classList.remove('hidden');
        $('#login-form').addEventListener('submit', async ev => {
            ev.preventDefault();
            $('#login-err').classList.add('hidden');
            const ok = await login($('#login-password').value);
            if (!ok) { $('#login-err').classList.remove('hidden'); return; }
            location.reload();
        });
        return;
    }

    if (!me.authed) await login('');

    $('#boot-status').textContent = 'opening channel…';
    const audio = new AudioFX({ enabled: true });
    const bridge = new Bridge({ url: WS_URL });
    const shell = new Shell(bridge, { audio });
    bridge.connect();
    $('#status-session').textContent = BACKEND_IS_CROSS
        ? `${cfg.auth} · ${new URL(BACKEND_ORIGIN).host}`
        : `${cfg.auth} · ${location.host}`;

    const sidebar = mountSidebar($('#sidebar'), { audio });

    setTimeout(() => {
        $('#boot').classList.add('hidden');
        $('#shell').classList.remove('hidden');
        shell._fitActive();
        audio.play('theme');
    }, 250);
}

boot().catch(err => {
    console.error(err);
    $('#boot-status').textContent = 'boot failed: ' + (err && err.message || err);
});
