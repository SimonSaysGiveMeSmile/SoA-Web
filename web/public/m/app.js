/**
 * SoA-Web Mobile Companion
 *
 * Lightweight mobile terminal client. Uses ANSI-to-HTML rendering instead of
 * xterm.js for better performance on phones. Connects to the same WebSocket
 * as the desktop client and receives TERM_DATA frames.
 */

import { MSG, INPUT_KIND, frame, parse } from '/assets/protocol.js?v=14';

/* ── ANSI → HTML renderer ─────────────────────────────────────────────── */

const PALETTE = [
    '#000000', '#ff5555', '#50fa7b', '#f1fa8c', '#6272a4',
    '#ff79c6', '#8be9fd', '#f8f8f2',
    '#666666', '#ff6e6e', '#69ff94', '#ffffa5', '#7b93bd',
    '#ff92df', '#a4ffff', '#ffffff'
];

function palette256(idx) {
    if (idx < 16) return PALETTE[idx];
    if (idx >= 232) { const v = 8 + (idx - 232) * 10; return `rgb(${v},${v},${v})`; }
    const n = idx - 16;
    return `rgb(${Math.floor(n/36)*51},${Math.floor((n/6)%6)*51},${(n%6)*51})`;
}

function escHtml(s) {
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function newAnsiState() {
    return { bold:false, dim:false, italic:false, underline:false, reverse:false, fg:null, bg:null };
}

function spanFor(st) {
    const cls = [], sty = [];
    if (st.bold) cls.push('ansi-bold');
    if (st.dim) cls.push('ansi-dim');
    if (st.italic) cls.push('ansi-italic');
    if (st.underline) cls.push('ansi-under');
    if (st.reverse) cls.push('ansi-rev');
    if (st.fg) sty.push(`color:${st.fg}`);
    if (st.bg) sty.push(`background:${st.bg}`);
    if (!cls.length && !sty.length) return null;
    return `<span${cls.length ? ` class="${cls.join(' ')}"` : ''}${sty.length ? ` style="${sty.join(';')}"` : ''}>`;
}

function applySgr(st, params) {
    if (!params.length) params = [0];
    let i = 0;
    while (i < params.length) {
        const p = params[i];
        if (p === 0) { st.bold=st.dim=st.italic=st.underline=st.reverse=false; st.fg=null; st.bg=null; }
        else if (p===1) st.bold=true;
        else if (p===2) st.dim=true;
        else if (p===3) st.italic=true;
        else if (p===4) st.underline=true;
        else if (p===7) st.reverse=true;
        else if (p===22) { st.bold=false; st.dim=false; }
        else if (p===23) st.italic=false;
        else if (p===24) st.underline=false;
        else if (p===27) st.reverse=false;
        else if (p===39) st.fg=null;
        else if (p===49) st.bg=null;
        else if (p>=30 && p<=37) st.fg=PALETTE[p-30];
        else if (p>=40 && p<=47) st.bg=PALETTE[p-40];
        else if (p>=90 && p<=97) st.fg=PALETTE[p-90+8];
        else if (p>=100 && p<=107) st.bg=PALETTE[p-100+8];
        else if (p===38 || p===48) {
            const tgt = p===38 ? 'fg' : 'bg';
            const mode = params[i+1];
            if (mode===5) { st[tgt]=palette256(params[i+2]); i+=2; }
            else if (mode===2) { st[tgt]=`rgb(${params[i+2]||0},${params[i+3]||0},${params[i+4]||0})`; i+=4; }
        }
        i++;
    }
}

function ansiToHtml(input, state) {
    let out = '', buf = '', openTag = false;
    const flush = () => { if (buf) { out += escHtml(buf); buf = ''; } };
    const close = () => { if (openTag) { out += '</span>'; openTag = false; } };
    const open = () => { const s = spanFor(state); if (s) { out += s; openTag = true; } };

    let i = 0;
    while (i < input.length) {
        const c = input[i];
        if (c === '\r') { i++; continue; }
        if (c === '\n') { flush(); close(); out += '\n'; open(); i++; continue; }
        if (c !== '\x1b') { buf += c; i++; continue; }
        flush(); close();
        const next = input[i+1];
        if (next === '[') {
            let j = i+2, params = '';
            while (j < input.length && /[0-9;?]/.test(input[j])) params += input[j++];
            const final = input[j]; j++;
            i = j;
            if (final === 'm') {
                applySgr(state, params.split(';').filter(Boolean).map(Number));
                open();
            }
        } else if (next === ']') {
            let j = i+2;
            while (j < input.length) {
                if (input[j] === '\x07') { j++; break; }
                if (input[j] === '\x1b' && input[j+1] === '\\') { j+=2; break; }
                j++;
            }
            i = j;
        } else { i += 2; }
    }
    flush(); close();
    return { html: out, state };
}

/* ── WebSocket Bridge ─────────────────────────────────────────────────── */

class MobileBridge extends EventTarget {
    constructor(url) {
        super();
        this.url = url;
        this.ws = null;
        this.backoff = 500;
        this.closed = false;
        this._ping = null;
    }
    connect() { this.closed = false; this._open(); }
    close() { this.closed = true; this._clearPing(); if (this.ws) try { this.ws.close(1000); } catch(_){} }
    send(type, data) {
        if (!this.ws || this.ws.readyState !== 1) return false;
        try { this.ws.send(frame(type, data)); return true; } catch(_) { return false; }
    }
    input(kind, extra={}) { return this.send(MSG.INPUT, { kind, ...extra }); }

    _open() {
        this._clearPing();
        this._emit('status', 'connecting');
        const ws = new WebSocket(this.url);
        this.ws = ws;
        ws.onopen = () => {
            this.backoff = 500;
            this._emit('status', 'connected');
            this._ping = setInterval(() => this.send(MSG.PING, { ts: Date.now() }), 20000);
        };
        ws.onmessage = ev => {
            const msg = parse(ev.data);
            if (msg) this._emit(msg.t, msg.d || {});
        };
        ws.onclose = ev => {
            this._clearPing(); this.ws = null;
            this._emit('status', 'disconnected');
            if (this.closed) return;
            setTimeout(() => this._open(), this.backoff);
            this.backoff = Math.min(this.backoff * 2, 15000);
        };
        ws.onerror = () => {};
    }
    _clearPing() { if (this._ping) { clearInterval(this._ping); this._ping = null; } }
    _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
}

/* ── Virtual Keyboard ─────────────────────────────────────────────────── */

const MOD_KEYS = [
    { label: 'esc',  combo: 'esc' },
    { label: 'tab',  combo: 'tab' },
    { label: 'ctrl', sticky: true },
    { label: '⌫',    text: '\x7f' },
    { label: '◀',    combo: 'left' },
    { label: '▼',    combo: 'down' },
    { label: '▲',    combo: 'up' },
    { label: '▶',    combo: 'right' },
    { label: '↵',    combo: 'enter' },
];

class VirtualKeyboard {
    constructor(root, onInput) {
        this.root = root;
        this.onInput = onInput;
        this.ctrl = false;
        this._lastVal = '';
        this._render();
    }
    _render() {
        this.input = document.createElement('input');
        this.input.type = 'text';
        this.input.className = 'kbd-input';
        this.input.placeholder = 'Type here…';
        this.input.autocomplete = 'off';
        this.input.autocapitalize = 'none';
        this.input.setAttribute('enterkeyhint', 'send');
        this.root.appendChild(this.input);

        this.input.addEventListener('input', () => this._onInput());
        this.input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._flush();
                this.onInput('term-keys', { text: '\r' });
            }
        });

        const strip = document.createElement('div');
        strip.className = 'kbd-mods';
        for (const m of MOD_KEYS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'k';
            btn.textContent = m.label;
            btn.addEventListener('pointerdown', e => {
                e.preventDefault();
                this._handleMod(m, btn);
            });
            strip.appendChild(btn);
        }
        this.root.appendChild(strip);
    }
    _onInput() {
        const cur = this.input.value;
        const prev = this._lastVal;
        if (cur === prev) return;
        if (cur.length > prev.length) {
            const added = cur.slice(prev.length);
            let text = added;
            if (this.ctrl && text.length === 1) {
                const code = text.toLowerCase().charCodeAt(0) - 96;
                if (code > 0 && code < 27) text = String.fromCharCode(code);
                this._releaseCtrl();
            }
            this.onInput('term-keys', { text });
        } else {
            this.onInput('term-keys', { text: '\x7f' });
        }
        this._lastVal = cur;
    }
    _flush() {
        const text = this.input.value;
        if (text) this.onInput('term-keys', { text });
        this.input.value = '';
        this._lastVal = '';
    }
    _handleMod(m, btn) {
        if (m.sticky) {
            this.ctrl = !this.ctrl;
            btn.classList.toggle('active', this.ctrl);
            this.input.focus();
            return;
        }
        if (m.text) {
            this.onInput('term-keys', { text: m.text });
        } else if (m.combo) {
            if (this.ctrl) {
                this.onInput('hotkey', { combo: 'ctrl+' + m.combo });
                this._releaseCtrl();
            } else {
                const rawMap = { enter: '\r', tab: '\t' };
                if (rawMap[m.combo]) {
                    this.onInput('term-keys', { text: rawMap[m.combo] });
                } else {
                    this.onInput('hotkey', { combo: m.combo });
                }
            }
        }
        this.input.focus();
    }
    _releaseCtrl() {
        this.ctrl = false;
        const btn = this.root.querySelector('.k.active');
        if (btn) btn.classList.remove('active');
    }
    focus() { this.input.focus(); }
}

/* ── App ──────────────────────────────────────────────────────────────── */

class App {
    constructor() {
        this.termEl = document.getElementById('term');
        this.tabsEl = document.getElementById('tabs');
        this.statusDot = document.querySelector('.status-dot');
        this.statusText = document.querySelector('.status-text');
        this.reconnectOverlay = document.getElementById('reconnect-overlay');
        this.reconnectSub = document.getElementById('reconnect-sub');
        this.reconnectRetry = document.getElementById('reconnect-retry');

        this._ansiState = newAnsiState();
        this._activeId = 0;
        this._tabs = [];
        this._tabStates = new Map();
        this._userScrolledUp = false;

        const { backend, token } = this._readSession();
        if (!backend) {
            this.termEl.textContent = 'No session. Re-scan the QR code from the desktop.';
            return;
        }

        const wsProto = backend.startsWith('https') ? 'wss' : 'ws';
        const wsHost = backend.replace(/^https?:\/\//, '');
        let wsUrl = `${wsProto}://${wsHost}/ws`;
        if (token) wsUrl += `?t=${encodeURIComponent(token)}`;

        this.bridge = new MobileBridge(wsUrl);
        this.kbd = new VirtualKeyboard(document.getElementById('kbd'), (kind, payload) => {
            this.bridge.input(kind, { id: this._activeId, ...payload });
        });

        this._wireSocket();
        this._wireUi();
        this.bridge.connect();
    }

    _readSession() {
        const params = new URLSearchParams(location.search);
        let backend = params.get('backend');
        let token = params.get('t') || '';
        if (backend) {
            try { localStorage.setItem('soa_mobile', JSON.stringify({ backend, token })); } catch(_){}
            history.replaceState(null, '', location.pathname);
            return { backend, token };
        }
        try {
            const saved = JSON.parse(localStorage.getItem('soa_mobile') || 'null');
            if (saved && saved.backend) return saved;
        } catch(_){}
        return { backend: null, token: null };
    }
    _wireSocket() {
        this.bridge.addEventListener('status', ev => {
            const state = ev.detail;
            this.statusDot.setAttribute('data-state', state);
            this.statusText.textContent = state === 'connected' ? 'paired' : state + '…';
            if (state === 'disconnected') this._showReconnect();
            else if (state === 'connected') this._hideReconnect();
        });

        this.bridge.addEventListener(MSG.HELLO, ev => {
            const d = ev.detail;
            if (d.tabs) this._renderTabs(d.tabs, d.activeId);
            this._activeId = d.activeId || 0;
            if (d.replay && d.replay.length) {
                for (const r of d.replay) {
                    this._getTabState(r.id).pending += r.data;
                }
                this._flushActive();
            }
        });

        this.bridge.addEventListener(MSG.SNAPSHOT, ev => {
            const d = ev.detail;
            if (d.tabs) this._renderTabs(d.tabs, d.activeId);
            if (d.activeId != null) this._activeId = d.activeId;
        });

        this.bridge.addEventListener(MSG.TERM_DATA, ev => {
            const d = ev.detail;
            const id = d.id != null ? d.id : this._activeId;
            this._getTabState(id).pending += (d.data || '');
            if (id === this._activeId && !this._flushRaf) {
                this._flushRaf = requestAnimationFrame(() => this._flushActive());
            }
        });

        this.bridge.addEventListener(MSG.TERM_EXIT, ev => {
            const id = ev.detail.id;
            const ts = this._getTabState(id);
            ts.pending += `\r\n\x1b[90m[process exited]\x1b[0m\r\n`;
            if (id === this._activeId) this._flushActive();
        });
    }

    _wireUi() {
        this.termEl.addEventListener('scroll', () => {
            const el = this.termEl;
            this._userScrolledUp = (el.scrollHeight - el.scrollTop - el.clientHeight) > 10;
        }, { passive: true });

        this.reconnectRetry.addEventListener('click', () => {
            this.bridge.close();
            this.bridge.connect();
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && this.bridge.ws === null && !this.bridge.closed) {
                this.bridge.close();
                this.bridge.connect();
            }
        });
    }

    _getTabState(id) {
        if (!this._tabStates.has(id)) {
            this._tabStates.set(id, { ansi: newAnsiState(), pending: '' });
        }
        return this._tabStates.get(id);
    }

    _flushActive() {
        this._flushRaf = null;
        const ts = this._getTabState(this._activeId);
        if (!ts.pending) return;
        let data = ts.pending;
        ts.pending = '';

        data = data.replace(/\r\n/g, '\n');
        const parts = data.split('\r');
        for (let i = 0; i < parts.length; i++) {
            if (i > 0) this._eraseCurrentLine();
            const seg = parts[i];
            if (!seg) continue;
            const { html, state } = ansiToHtml(seg, ts.ansi);
            ts.ansi = state;
            this.termEl.insertAdjacentHTML('beforeend', html);
        }

        while (this.termEl.childNodes.length > 4000) {
            this.termEl.removeChild(this.termEl.firstChild);
        }

        if (!this._userScrolledUp) {
            this.termEl.scrollTop = this.termEl.scrollHeight;
        }
    }

    _eraseCurrentLine() {
        const el = this.termEl;
        while (el.childNodes.length) {
            const last = el.childNodes[el.childNodes.length - 1];
            if (last.nodeType === Node.TEXT_NODE) {
                const nl = last.textContent.lastIndexOf('\n');
                if (nl !== -1) { last.textContent = last.textContent.substring(0, nl + 1); return; }
            }
            el.removeChild(last);
        }
    }

    _renderTabs(tabs, activeId) {
        this.tabsEl.innerHTML = '';
        this._tabs = tabs;
        for (const t of tabs) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tab' + (t.id === activeId ? ' active' : '');
            if (t.status) btn.setAttribute('data-status', t.status);
            btn.textContent = t.title || t.name || `TAB ${t.id}`;
            btn.addEventListener('click', () => {
                this._switchTab(t.id);
            });
            this.tabsEl.appendChild(btn);
        }
    }

    _switchTab(id) {
        if (id === this._activeId) return;
        this._activeId = id;
        this.bridge.input(INPUT_KIND.SWITCH_TAB, { id });
        this.termEl.innerHTML = '';
        const ts = this._getTabState(id);
        ts.ansi = newAnsiState();
        this._flushActive();
        this.tabsEl.querySelectorAll('.tab').forEach((el, i) => {
            el.classList.toggle('active', this._tabs[i] && this._tabs[i].id === id);
        });
    }

    _showReconnect() {
        this.reconnectOverlay.hidden = false;
        this.reconnectRetry.hidden = false;
    }
    _hideReconnect() {
        this.reconnectOverlay.hidden = true;
    }
}
