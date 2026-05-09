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

import { AudioFX } from '/assets/audiofx.js?v=8';
import { t as tr, getLang, setLang, applyStatic, LANGS } from '/assets/i18n.js?v=8';
import { mountSandboxSidebar } from '/assets/widgets.js?v=8';
import { getSettings, onSettings, openSettingsModal } from '/assets/settings.js?v=8';
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
        this.title = title || tr('tab.default', { id });
        this.container = el('div', { class: 'term', 'data-tab': String(id) });
        container.appendChild(this.container);

        const s = getSettings();
        this.term = new Terminal({
            fontFamily: 'Fira Mono, ui-monospace, Menlo, Consolas, monospace',
            fontSize: s.termFontSize, theme: TRON_THEME, cursorBlink: s.cursorBlink,
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
            this.term.write(`\r\n\x1b[2m${tr('tab.exited_short', { code })}\x1b[0m\r\n`);
        });
    }

    fitNow() { try { this.fit.fit(); } catch (_) {} return { cols: this.term.cols, rows: this.term.rows }; }
    focus()  { this.term.focus(); }
    applySettings(s) {
        try { this.term.options.fontSize = s.termFontSize; } catch (_) {}
        try { this.term.options.cursorBlink = s.cursorBlink; } catch (_) {}
        try { this.fit.fit(); } catch (_) {}
    }
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
        const initialAudio = getSettings().audio;
        audioBtn.dataset.state = initialAudio ? 'on' : 'off';
        audioBtn.textContent = initialAudio ? tr('topbar.audio_on') : tr('topbar.audio_off');
        audioBtn.addEventListener('click', () => {
            const on = audioBtn.dataset.state !== 'off';
            this.audio.setEnabled(!on);
            audioBtn.dataset.state = on ? 'off' : 'on';
            audioBtn.textContent = on ? tr('topbar.audio_off') : tr('topbar.audio_on');
        });

        const settingsBtn = $('#open-settings');
        if (settingsBtn) settingsBtn.addEventListener('click', () => {
            this.audio.play('panels');
            openSettingsModal();
        });
        onSettings(s => this._applySettings(s));

        // Keep the sidebar in WC mode but swap its widgets for sandbox-safe
        // ones (see mountSandboxSidebar). The toggle keeps its real role.
        const stageEl = $('.stage');
        if (window.matchMedia('(max-width: 768px)').matches) {
            stageEl.classList.add('no-sidebar');
        }
        const sideBtn = $('#toggle-sidebar');
        if (sideBtn) {
            sideBtn.addEventListener('click', () => {
                stageEl.classList.toggle('no-sidebar');
                this.audio.play('panels');
                this._fitActive();
            });
        }
        // Tapping the scrim behind the overlay sidebar closes it on mobile.
        stageEl.addEventListener('click', e => {
            if (e.target !== stageEl) return;
            if (!window.matchMedia('(max-width: 768px)').matches) return;
            if (stageEl.classList.contains('no-sidebar')) return;
            stageEl.classList.add('no-sidebar');
            this._fitActive();
        });
    }

    _openInstallDialog() {
        this.audio.play('info');
        if (this._dialog) { this._dialog.remove(); this._dialog = null; }

        const installCmd = `curl -fsSL ${location.origin}/install.sh | sh`;

        const backdrop = el('div', { class: 'soa-modal-backdrop' });
        const card = el('div', { class: 'soa-modal' });
        const close = () => { backdrop.remove(); this._dialog = null; };
        backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
        window.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { close(); window.removeEventListener('keydown', esc); }
        });

        const cmd = el('code', { class: 'soa-modal-cmd', text: installCmd });
        const copyBtn = el('button', {
            class: 'soa-modal-copy', text: 'COPY',
            onclick: async () => {
                try { await navigator.clipboard.writeText(installCmd); copyBtn.textContent = 'COPIED'; }
                catch (_) {
                    const r = document.createRange();
                    r.selectNode(cmd);
                    const s = window.getSelection();
                    s.removeAllRanges(); s.addRange(r);
                    copyBtn.textContent = 'SELECTED — CMD+C';
                }
                setTimeout(() => { copyBtn.textContent = 'COPY'; }, 1500);
            },
        });

        card.append(
            el('div', { class: 'soa-modal-title', text: '↯ RUN A REAL SHELL ON THIS MACHINE' }),
            el('div', { class: 'soa-modal-body', text:
                "Paste this into your terminal. It installs a background service at " +
                "~/.soa-web, binds it to 127.0.0.1:4010, and this page auto-detects it " +
                "on the next reload. macOS + Linux, no sudo." }),
            el('div', { class: 'soa-modal-cmdwrap' }, [cmd, copyBtn]),
            el('div', { class: 'soa-modal-note', text:
                "Uninstall anytime: ~/.soa-web/uninstall.sh" }),
            el('div', { class: 'soa-modal-divider' }),
            el('div', { class: 'soa-modal-body', text:
                "Already have a backend running somewhere else?" }),
            el('button', {
                class: 'soa-modal-link', text: 'Connect a remote backend manually →',
                onclick: () => { close(); this._promptConnect(); },
            }),
            el('button', { class: 'soa-modal-close', text: 'CLOSE', onclick: close }),
        );
        backdrop.appendChild(card);
        document.body.appendChild(backdrop);
        this._dialog = backdrop;
    }

    _promptConnect() {
        const backend = window.prompt(
            'Backend URL (from `npm run selfhost` on your machine):',
            'https://',
        );
        if (!backend) return;
        const token = window.prompt('Session token:') || '';
        try {
            localStorage.setItem('soa_web_backend', JSON.stringify({
                backend: backend.replace(/\/+$/, ''),
                token: token.trim(),
            }));
        } catch (_) {}
        location.reload();
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
            if (mod && e.shiftKey && (e.key === 'S' || e.key === 's')) {
                e.preventDefault();
                openSettingsModal();
            }
        });
    }

    _applySettings(s) {
        for (const tab of this.tabs.values()) tab.applySettings(s);
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
        const n = this.tabs.size;
        const tabsEl = $('#status-tabs');
        const tabsKey = n === 1 ? 'status.tabs_one' : 'status.tabs_other';
        tabsEl.textContent = tr(tabsKey, { n });
        tabsEl.setAttribute('data-i18n', tabsKey);
        tabsEl.setAttribute('data-i18n-vars', JSON.stringify({ n }));
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

function wireWcLangSelector() {
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

function wireWcReleaseLink() {
    const a = document.querySelector('#release-link');
    if (!a) return;
    const url = (window.__SOA_WEB__ || {}).releaseUrl;
    if (url) a.href = url;
}

async function main() {
    wireWcLangSelector();
    wireWcReleaseLink();
    applyStatic();
    setBootStatus(tr('boot.booting_sandbox'));
    try {
        if (!WC || !WC.WebContainer) {
            throw new Error('@webcontainer/api did not load (check COEP/COOP headers and network)');
        }
        if (CFG.wcClientId && WC.auth && typeof WC.auth.init === 'function') {
            try { WC.auth.init({ clientId: CFG.wcClientId, scope: '' }); }
            catch (e) { console.warn('[soa-web:wc] auth.init failed', e); }
        }
        const wc = await WC.WebContainer.boot({ coep: 'credentialless' });
        setBootStatus(tr('boot.opening_shell'));

        const s0 = getSettings();
        const audio = new AudioFX({ enabled: s0.audio, volume: s0.audioVolume, feedbackEnabled: !s0.disableFeedbackAudio });
        const shell = new WCShell(wc, { audio });
        await shell.newTab();

        const sidebarEl = $('#sidebar');
        if (sidebarEl) {
            mountSandboxSidebar(sidebarEl, {
                audio,
                onInstall: () => shell._openInstallDialog(),
                onConnect: () => shell._promptConnect(),
            });
        }

        $('#status-session').textContent = tr('status.sandbox', { host: location.host });
        const conn = $('#status-conn');
        conn.className = 'ok';
        conn.textContent = tr('status.ready');
        conn.setAttribute('data-i18n', 'status.ready');

        setTimeout(() => {
            $('#boot').classList.add('hidden');
            $('#shell').classList.remove('hidden');
            shell._fitActive();
        }, s0.nointro ? 0 : 200);
    } catch (err) {
        console.error('[soa-web:wc] boot failed', err);
        const detail = err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err);
        setBootStatus(tr('boot.failed', { detail }));
    }
}

main();
