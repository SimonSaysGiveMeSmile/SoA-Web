/**
 * WebContainer client entry.
 *
 * Boots a StackBlitz WebContainer — an in-browser Node sandbox with a real
 * bash-like shell (`jsh`) — and wires per-tab `jsh` processes into xterm.js
 * instances. No backend process required: the "server" that runs commands
 * lives inside the user's browser tab.
 *
 * Constraints worth remembering:
 *   - WebContainers require cross-origin isolation (COEP/COOP headers set in
 *     vercel.json) and secure context (HTTPS or localhost).
 *   - Only one WebContainer instance can exist per page; multiple tabs share
 *     it and each spawn their own `jsh` process.
 *   - The filesystem is ephemeral. Good for scratch work, not for secrets.
 */

import { AudioFX } from '/assets/audiofx.js';
// The WebContainer API ships as ESM on esm.sh. We only depend on the named
// WebContainer class; auth is optional (loaded below only if present + a
// clientId is configured) so the rest of the app still works during dev.
import * as WC from 'https://esm.sh/@webcontainer/api@1.5.1';

const CFG = window.__SOA_WEB__ || {};

const $ = sel => document.querySelector(sel);
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
    foreground: '#aacfd1', background: '#05080d',
    cursor: '#aacfd1', cursorAccent: '#aacfd1',
    selectionBackground: 'rgba(170,207,209,0.3)',
    black: '#000000', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#6272a4', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#262828', brightRed: '#ff6e6e', brightGreen: '#69ff94',
    brightYellow: '#ffffa5', brightBlue: '#7b93bd', brightMagenta: '#ff92df',
    brightCyan: '#a4ffff', brightWhite: '#ffffff',
};

class WCTab {
    constructor(id, title, { container, proc }) {
        this.id = id;
        this.title = title || `tab ${id}`;
        this.container = el('div', { class: 'term', 'data-tab': String(id) });
        container.appendChild(this.container);

        this.term = new Terminal({
            fontFamily: 'Fira Mono, ui-monospace, Menlo, Consolas, monospace',
            fontSize: 13, theme: TRON_THEME, cursorBlink: true,
            scrollback: 5000, convertEol: false,
        });
        this.fit = new FitAddon.FitAddon();
        this.term.loadAddon(this.fit);
        try { this.term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (_) {}
        this.term.open(this.container);

        this.proc = proc;
        this.writer = proc.input.getWriter();
        this.term.onData(d => { try { this.writer.write(d); } catch (_) {} });
        this.term.onResize(({ cols, rows }) => { try { this.proc.resize({ cols, rows }); } catch (_) {} });
        proc.output.pipeTo(new WritableStream({ write: chunk => this.term.write(chunk) })).catch(() => {});
        proc.exit.then(code => {
            this.term.write(`\r\n\x1b[2m[process exited: ${code}]\x1b[0m\r\n`);
        });
    }

    fitNow() { try { this.fit.fit(); } catch (_) {} return { cols: this.term.cols, rows: this.term.rows }; }
    focus()  { this.term.focus(); }
    dispose() {
        try { this.writer.releaseLock(); } catch (_) {}
        try { this.proc.kill(); } catch (_) {}
        try { this.term.dispose(); } catch (_) {}
        this.container.remove();
    }
}

class WCShell {
    constructor(wc, { audio }) {
        this.wc = wc;
        this.audio = audio;
        this.tabs = new Map();
        this.order = [];
        this.activeId = null;
        this.nextId = 1;
        this.tabsEl = $('#tabs');
        this.termsEl = $('#terms');
        this._wireTopbar();
        this._wireWindow();
    }

    _wireTopbar() {
        $('#new-tab').addEventListener('click', () => { this.audio.play('granted'); this.newTab(); });
        const audioBtn = $('#toggle-audio');
        audioBtn.addEventListener('click', () => {
            const on = audioBtn.dataset.state !== 'off';
            this.audio.setEnabled(!on);
            audioBtn.dataset.state = on ? 'off' : 'on';
            audioBtn.textContent = on ? '♪ OFF' : '♪ FX';
        });
        // Hide the sidebar button — no pairing/sysinfo in webcontainer mode.
        const sideBtn = $('#toggle-sidebar');
        if (sideBtn) sideBtn.remove();
        const stage = $('.stage');
        stage.classList.add('no-sidebar');
        const sidebar = $('#sidebar');
        if (sidebar) sidebar.remove();
    }

    _wireWindow() {
        window.addEventListener('resize', () => this._fitActive());
        window.addEventListener('orientationchange', () => setTimeout(() => this._fitActive(), 150));
        window.addEventListener('keydown', e => {
            const mod = e.ctrlKey || e.metaKey;
            if (mod && e.shiftKey && e.key === 'T') { e.preventDefault(); this.newTab(); }
            if (mod && e.shiftKey && e.key === 'W') {
                e.preventDefault();
                if (this.activeId != null) this.closeTab(this.activeId);
            }
        });
    }

    async newTab() {
        const id = this.nextId++;
        const cols = 120, rows = 32;
        const proc = await this.wc.spawn('jsh', [], { terminal: { cols, rows } });
        const tab = new WCTab(id, `jsh ${id}`, { container: this.termsEl, proc });
        this.tabs.set(id, tab);
        this.order.push(id);
        this._renderTabs();
        this._activate(id);
    }

    closeTab(id) {
        const tab = this.tabs.get(id);
        if (!tab) return;
        tab.dispose();
        this.tabs.delete(id);
        this.order = this.order.filter(x => x !== id);
        if (this.activeId === id) {
            const next = this.order[this.order.length - 1];
            if (next) this._activate(next); else this.activeId = null;
        }
        this._renderTabs();
        if (!this.tabs.size) this.newTab();
    }

    _activate(id) {
        if (this.activeId === id) return;
        this.activeId = id;
        for (const [tid, tab] of this.tabs) {
            tab.container.classList.toggle('active', tid === id);
        }
        const tab = this.tabs.get(id);
        if (tab) { tab.focus(); requestAnimationFrame(() => tab.fitNow()); }
        this._renderTabs();
    }

    _renderTabs() {
        this.tabsEl.replaceChildren(...this.order.map(id => {
            const tab = this.tabs.get(id);
            return el('div', {
                class: 'tab' + (id === this.activeId ? ' active' : ''),
                onclick: (e) => {
                    if (e.target.classList.contains('x')) return;
                    this._activate(id);
                },
            }, [
                el('span', { class: 'dot' }),
                el('span', { text: tab.title }),
                el('span', {
                    class: 'x', text: '×',
                    onclick: (e) => { e.stopPropagation(); this.closeTab(id); },
                }),
            ]);
        }));
        $('#status-tabs').textContent = `${this.tabs.size} tab${this.tabs.size === 1 ? '' : 's'}`;
    }

    _fitActive() {
        const tab = this.tabs.get(this.activeId);
        if (!tab) return;
        tab.fitNow();
    }
}

function setBootStatus(msg) {
    const node = document.querySelector('#boot-status');
    if (node) node.textContent = msg;
}

async function main() {
    setBootStatus('booting sandbox…');
    try {
        if (!WC || !WC.WebContainer) {
            throw new Error('@webcontainer/api did not load (check COEP/COOP headers and network)');
        }
        if (CFG.wcClientId && WC.auth && typeof WC.auth.init === 'function') {
            try { WC.auth.init({ clientId: CFG.wcClientId, scope: '' }); }
            catch (e) { console.warn('[soa-web:wc] auth.init failed', e); }
        }
        const wc = await WC.WebContainer.boot({ coep: 'credentialless' });
        setBootStatus('opening shell…');

        const audio = new AudioFX({ enabled: true });
        const shell = new WCShell(wc, { audio });
        await shell.newTab();

        $('#status-session').textContent = 'sandbox · ' + location.host;
        $('#status-conn').className = 'ok';
        $('#status-conn').textContent = 'ready';

        setTimeout(() => {
            $('#boot').classList.add('hidden');
            $('#shell').classList.remove('hidden');
            shell._fitActive();
        }, 200);
    } catch (err) {
        console.error('[soa-web:wc] boot failed', err);
        const detail = err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err);
        setBootStatus(`boot failed: ${detail}`);
    }
}

main();
