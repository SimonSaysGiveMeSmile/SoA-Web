/**
 * Artifacts — the phone's sheet over scripts/soa-artifacts.
 *
 * The service is a loopback-only index on the Mac (127.0.0.1:6085) of every
 * claude.ai artifact the agents published, opened, registered or mentioned.
 * Browsers reach it through the daemon's authed /preview/6085/ proxy, exactly
 * like soa-health on /preview/6084/: the host only says how to turn a service
 * path into a URL under that proxy (with its t/u), and a page on another origin
 * (the public companion, paired over the tunnel) calls the same URLs
 * cross-origin — the daemon answers CORS for its allowlisted front ends.
 *
 * Read-only: the sheet lists, searches and opens. Nothing here writes to the
 * index; a pull-to-refresh is a cheap POST /rescan the service rate-limits.
 */

import { sameOrigin } from './health.js';
import { maybeFocus } from './focusPolicy.js';

export const ARTIFACTS_PORT = 6085;
export const ARTIFACTS_PREFIX = '/preview/' + ARTIFACTS_PORT;

const TIMEOUT_MS = 8000;
const LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 260;
const REFRESH_MS = 30000;          // while the sheet is open and visible
const SCANNING_RETRY_MS = 4000;    // the first scan is still filling the index
const SCOPE_KEY = 'soa.artifacts.scope';

export class ArtifactsError extends Error {
    /** kind: down | auth | forbidden | http | bad */
    constructor(kind, message, status) { super(message); this.kind = kind; this.status = status || 0; }
}

export class ArtifactsClient {
    /** @param {function(string):string} urlFor  '/artifacts' → absolute URL under /preview/6085 */
    constructor(urlFor) { this.urlFor = urlFor; }

    async _fetch(path, init = {}) {
        const url = this.urlFor(path);
        if (!url) throw new ArtifactsError('down', 'no backend');
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
        // Cross-origin over an ngrok tunnel: without this header the free tier
        // answers with an HTML warning page (see health.js).
        const headers = Object.assign({}, init.headers || {});
        if (!sameOrigin(url)) headers['ngrok-skip-browser-warning'] = '1';
        let r;
        try {
            r = await fetch(url, { credentials: 'include', cache: 'no-store', ...init, headers, signal: ac.signal });
        } catch (_) {
            throw new ArtifactsError('down', 'unreachable');
        } finally { clearTimeout(timer); }
        // The proxy answers 502 (HTML) when nothing listens on the port.
        if (r.status === 502 || r.status === 503 || r.status === 504) throw new ArtifactsError('down', 'not running', r.status);
        if (r.status === 401) throw new ArtifactsError('auth', 'pairing required', 401);
        const type = r.headers.get('content-type') || '';
        if (r.status === 403 && !/json/i.test(type)) throw new ArtifactsError('forbidden', 'forbidden', 403);
        if (!/json/i.test(type)) throw new ArtifactsError(r.ok ? 'down' : 'http', 'unexpected reply', r.status);
        let j;
        try { j = await r.json(); } catch (_) { throw new ArtifactsError('bad', 'bad reply', r.status); }
        if (!j || typeof j !== 'object') throw new ArtifactsError('bad', 'bad reply', r.status);
        if (r.status === 403) throw new ArtifactsError('forbidden', j.error || 'forbidden', 403);
        if (!r.ok || j.ok === false) throw new ArtifactsError('http', 'error ' + r.status, r.status);
        return j;
    }

    list({ q = '', cwd = '', limit = LIMIT } = {}) {
        const p = new URLSearchParams();
        if (q) p.set('q', q);
        if (cwd) p.set('cwd', cwd);
        p.set('limit', String(limit));
        return this._fetch('/artifacts?' + p.toString());
    }

    // A body is text/plain for the same reason as health.js: the daemon's
    // global express.json() would swallow an application/json one.
    rescan() {
        return this._fetch('/rescan', { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: '{}' });
    }
}

// ── formatting ─────────────────────────────────────────────────────────

const DAY_MS = 86400e3;

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

/** 'Today' · 'Yesterday' · 'Monday' (this week) · 'Mon, Oct 6' · 'Oct 6, 2025' */
export function dayLabel(t, now = Date.now()) {
    const d0 = startOfDay(t), n0 = startOfDay(now);
    const days = Math.round((n0 - d0) / DAY_MS);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    const d = new Date(t);
    if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    if (d.getFullYear() === new Date(now).getFullYear()) return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function relTime(t, now = Date.now()) {
    const s = Math.round((now - t) / 1000);
    if (!(s >= 0)) return '';
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const hrs = Math.round(m / 60);
    if (hrs < 24) return `${hrs} h ago`;
    const days = Math.round(hrs / 24);
    if (days < 30) return `${days} d ago`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Rows grouped by local day, newest first: [{ label, items }]. */
export function groupByDay(list, now = Date.now()) {
    const out = [];
    let cur = null, key = null;
    // Sorted here too: a day must never appear twice, whatever order arrived.
    const at = a => a.lastAt || a.firstAt || 0;
    for (const a of [...list].sort((x, y) => at(y) - at(x))) {
        const t = a.lastAt || a.firstAt || 0;
        const k = t ? startOfDay(t) : 0;
        if (k !== key) { key = k; cur = { label: t ? dayLabel(t, now) : 'Undated', items: [] }; out.push(cur); }
        cur.items.push(a);
    }
    return out;
}

// Only a claude.ai artifact link is ever opened from the list: https, the
// claude.ai host itself (no subdomain, no userinfo, no port) and an artifact
// path. Anything else never reaches the page.
const ARTIFACT_PATH = /^\/(?:code\/artifact|artifact|public\/artifacts)\/[A-Za-z0-9_-]+\/?$/;
export function safeUrl(u) {
    try {
        const x = new URL(String(u || ''));
        if (x.protocol !== 'https:' || x.hostname !== 'claude.ai' || x.port || x.username || x.password) return null;
        return ARTIFACT_PATH.test(x.pathname) ? x.href : null;
    } catch (_) { return null; }
}

// The reply is data from another process: keep only well-formed rows, with
// strings where text goes and finite numbers where time goes. A row whose
// link is not a claude.ai artifact is dropped, not shown dead.
const str = v => (typeof v === 'string' && v ? v : null);
const time = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
export function cleanList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const a of list) {
        if (!a || typeof a !== 'object') continue;
        const url = safeUrl(a.url);
        if (!url) continue;
        out.push({
            id: str(a.id), url, title: str(a.title), project: str(a.project),
            kind: str(a.kind), deleted: a.deleted === true,
            firstAt: time(a.firstAt), lastAt: time(a.lastAt),
        });
    }
    return out;
}

const KIND_LABEL = { opened: 'Opened', registered: 'Saved', mentioned: 'Mentioned' };

const COPY_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>';
const DONE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** Clipboard API first; a LAN http:// origin is not a secure context, so fall
 *  back to the selection copy there. */
export async function copyText(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';
    document.body.appendChild(ta);
    let ok = false;
    try { ta.select(); ta.setSelectionRange(0, text.length); ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
    return ok;
}

// ── DOM ────────────────────────────────────────────────────────────────

function h(tag, props = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
}

function readScope() { try { return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'tab'; } catch (_) { return 'tab'; } }
function saveScope(v) { try { localStorage.setItem(SCOPE_KEY, v); } catch (_) {} }

/**
 * The list body: scope switch, search, then the day-grouped rows or a state.
 * tab:  { cwd, title } of the tab the sheet was opened from, or null.
 * away: { href } when this page cannot reach the Mac at all; href may be null.
 */
export class ArtifactsPanel {
    constructor({ client, root, tab = null, away = null, fallback = null }) {
        this.client = client;
        this.root = root;
        this.tab = tab && tab.cwd ? tab : null;
        this.away = away;
        this.fallback = fallback;
        this.scope = this.tab ? readScope() : 'all';
        this.q = '';
        this.data = null;       // last /artifacts reply
        this.err = null;        // ArtifactsError while unreachable
        this.loading = false;
        this._seq = 0;
        this._debounce = null;
        this._retry = null;
        this._destroyed = false;
        this._paused = false;
        root.classList.add('af', 'af-phone');
        this._build();
        this.render();
    }

    destroy() {
        this.pause();
        this._destroyed = true;
        this.root.replaceChildren();
        this.root.classList.remove('af', 'af-phone');
    }

    pause() {
        this._paused = true;
        this._seq++;
        this.loading = false;
        clearTimeout(this._debounce);
        clearTimeout(this._retry);
    }

    resume() {
        this._paused = false;
        return this.refresh();
    }

    _build() {
        const seg = (v, label) => h('button', {
            type: 'button', class: 'af-seg-btn', role: 'radio', 'data-scope': v,
            'aria-checked': String(this.scope === v), disabled: v === 'tab' && !this.tab ? true : null,
            text: label, onclick: () => this._setScope(v),
        });
        this.segEl = h('div', { class: 'af-seg', role: 'radiogroup', 'aria-label': 'Which artifacts' },
            [seg('tab', 'This tab'), seg('all', 'All')]);
        this.searchEl = h('input', {
            type: 'search', class: 'af-search', placeholder: 'Search titles and projects',
            'aria-label': 'Search artifacts', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
            enterkeyhint: 'search',
        });
        this.searchEl.addEventListener('input', () => {
            clearTimeout(this._debounce);
            this._debounce = setTimeout(() => {
                const q = this.searchEl.value.trim();
                if (q !== this.q) { this.q = q; this.refresh(); }
            }, SEARCH_DEBOUNCE_MS);
        });
        // Enter: search now, then put the keyboard away to show the results.
        this.searchEl.addEventListener('keydown', e => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            clearTimeout(this._debounce);
            this.q = this.searchEl.value.trim();
            this.refresh();
            this.searchEl.blur();
        });
        this.scopeNote = h('div', { class: 'af-scope-note' });
        this.listEl = h('div', { class: 'af-list', 'aria-live': 'polite' });
        const controls = h('div', { class: 'af-controls' }, [this.segEl, this.searchEl]);
        this.root.append(controls, this.scopeNote, this.listEl);
        if (this.away) controls.hidden = true;
    }

    /** Hand the search field the caret only where policy allows (never on touch). */
    focusSearch() { if (!this.away) maybeFocus(this.searchEl, { preventScroll: true }); }

    _setScope(v) {
        if (v === this.scope || (v === 'tab' && !this.tab)) return;
        this.scope = v;
        saveScope(v);
        for (const b of this.segEl.querySelectorAll('.af-seg-btn')) b.setAttribute('aria-checked', String(b.dataset.scope === v));
        this.data = null;
        this.refresh();
    }

    async refresh() {
        if (this._destroyed || this._paused || this.away) return;
        clearTimeout(this._retry);
        const seq = ++this._seq;
        this.loading = true;
        if (!this.data) this.render();
        try {
            const j = await this.client.list({ q: this.q, cwd: this.scope === 'tab' && this.tab ? this.tab.cwd : '' });
            if (seq !== this._seq || this._destroyed) return;
            this.data = j; this.err = null;
            // The first scan of a large transcript store takes a while; keep
            // filling in while the sheet is open.
            if (j && j.scanning) this._retry = setTimeout(() => this.refresh(), SCANNING_RETRY_MS);
        } catch (e) {
            if (seq !== this._seq || this._destroyed) return;
            this.err = e instanceof ArtifactsError ? e : new ArtifactsError('down', String(e && e.message || e));
        } finally {
            if (seq === this._seq) this.loading = false;
        }
        this.render();
    }

    async rescan() {
        try { await this.client.rescan(); } catch (_) {}
        this.refresh();
    }

    render() {
        if (this._destroyed) return;
        const tabName = this.tab ? (this.tab.title || this.tab.cwd.split('/').filter(Boolean).pop() || 'this tab') : '';
        this.scopeNote.textContent = this.scope === 'tab' && this.tab ? `From ${tabName}’s project` : '';
        this.scopeNote.hidden = !this.scopeNote.textContent || !!this.away || !!this.err;
        this.listEl.replaceChildren(...this._body());
    }

    _body() {
        if (this.away) return [this._awayView()];
        if (this.err) return [this._errView(this.err)];
        if (!this.data) return [h('div', { class: 'af-note', role: 'status', text: 'Loading artifacts…' })];
        const list = cleanList(this.data.artifacts);
        const out = [];
        if (this.data.scanning) out.push(h('div', { class: 'af-note af-scanning', role: 'status', text: 'Still reading transcripts — more may appear.' }));
        if (!list.length) {
            out.push(this._emptyView());
            return out;
        }
        const now = Date.now();
        for (const g of groupByDay(list, now)) {
            out.push(h('section', { class: 'af-day' }, [
                h('h3', { class: 'af-day-h', text: g.label }),
                h('ul', { class: 'af-rows' }, g.items.map(a => this._row(a, now))),
            ]));
        }
        const total = typeof this.data.total === 'number' ? this.data.total : list.length;
        if (total > list.length) out.push(h('div', { class: 'af-note', text: `Showing the newest ${list.length} of ${total}. Search to find older ones.` }));
        return out;
    }

    _row(a, now) {
        const href = safeUrl(a.url);
        const title = a.title || 'Untitled artifact';
        const when = a.lastAt || a.firstAt;
        const meta = [a.project || null, when ? relTime(when, now) : null].filter(Boolean).join(' · ');
        const tag = a.deleted ? 'Deleted' : KIND_LABEL[a.kind] || null;
        const inner = [
            h('span', { class: 'af-row-t' + (a.title ? '' : ' untitled'), text: title }),
            h('span', { class: 'af-row-m' }, [
                tag ? h('span', { class: 'af-tag' + (a.deleted ? ' gone' : ''), text: tag }) : null,
                h('span', { class: 'af-row-meta', text: meta }),
            ]),
        ];
        const label = `${title}${meta ? ', ' + meta : ''}${a.deleted ? ', deleted' : ''}`;
        const row = href
            ? h('a', { class: 'af-row', href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': label + ', opens in a new tab' }, inner)
            : h('div', { class: 'af-row disabled', 'aria-label': label }, inner);
        return h('li', { class: 'af-item' }, [row, href ? this._copyBtn(href, title) : null]);
    }

    _copyBtn(href, title) {
        const label = `Copy link to ${title}`;
        const b = h('button', { type: 'button', class: 'af-copy', 'aria-label': label, title: 'Copy link' });
        b.innerHTML = COPY_ICON;
        let t = null;
        b.addEventListener('click', async e => {
            e.preventDefault(); e.stopPropagation();
            const ok = await copyText(href);
            clearTimeout(t);
            b.classList.toggle('done', ok);
            b.classList.toggle('fail', !ok);
            b.innerHTML = ok ? DONE_ICON : COPY_ICON;
            b.setAttribute('aria-label', ok ? 'Link copied' : 'Copy failed');
            t = setTimeout(() => {
                b.classList.remove('done', 'fail');
                b.innerHTML = COPY_ICON;
                b.setAttribute('aria-label', label);
            }, 1600);
        });
        return b;
    }

    _emptyView() {
        if (this.q) return h('div', { class: 'af-empty' }, [
            h('div', { class: 'af-empty-t', text: `No artifacts match “${this.q}”.` }),
            this.scope === 'tab' && this.tab
                ? h('button', { type: 'button', class: 'af-btn', text: 'Search all projects', onclick: () => this._setScope('all') })
                : null,
        ]);
        if (this.scope === 'tab' && this.tab) return h('div', { class: 'af-empty' }, [
            h('div', { class: 'af-empty-t', text: 'No artifacts from this tab’s project yet.' }),
            h('button', { type: 'button', class: 'af-btn', text: 'Show all', onclick: () => this._setScope('all') }),
        ]);
        return h('div', { class: 'af-empty' }, [
            h('div', { class: 'af-empty-t', text: 'No artifacts yet.' }),
            h('div', { class: 'af-empty-d', text: 'Pages your agents publish on claude.ai show up here.' }),
        ]);
    }

    _errView(e) {
        const retry = h('button', { type: 'button', class: 'af-btn', text: 'Retry',
            onclick: () => { this.err = null; this.data = null; this.render(); this.refresh(); } });
        if (e.kind === 'auth') return h('div', { class: 'af-down' }, [
            h('div', { class: 'af-down-t', text: 'This phone needs to pair with your Mac again.' }), retry,
        ]);
        if (e.kind === 'forbidden') return h('div', { class: 'af-down' }, [
            h('div', { class: 'af-down-t', text: 'Your Mac’s artifact library did not accept this page.' }),
            h('div', { class: 'af-down-d', text: 'Its own link opens the same list.' }),
            this.fallback && this.fallback.href
                ? h('a', { class: 'af-btn', href: this.fallback.href, target: '_blank', rel: 'noopener noreferrer', text: 'Open on the Mac’s link' })
                : retry,
        ]);
        // It answered, but not with a list: running, so "start it" would mislead.
        // The reply's own text stays out of the page (it is another process's).
        if (e.kind === 'http' || e.kind === 'bad') return h('div', { class: 'af-down' }, [
            h('div', { class: 'af-down-t', text: 'Your Mac’s artifact library answered with an error.' }),
            h('div', { class: 'af-down-d', text: e.status >= 400 ? `It replied ${e.status}. Try again in a moment.` : 'Try again in a moment.' }),
            retry,
        ]);
        return h('div', { class: 'af-down' }, [
            h('div', { class: 'af-down-t', text: 'Your Mac’s artifact library isn’t running.' }),
            h('div', { class: 'af-down-d' }, ['Start it on the Mac with ', h('code', { text: 'soa-artifacts serve' }), ', then retry.']),
            retry,
        ]);
    }

    _awayView() {
        const href = this.away && this.away.href;
        return h('div', { class: 'af-down', role: 'note' }, [
            h('div', { class: 'af-down-t', text: 'Pair with your Mac to see its artifacts.' }),
            h('div', { class: 'af-down-d', text: 'The library lives on the Mac and is read through its link.' }),
            href ? h('a', { class: 'af-btn', href, target: '_blank', rel: 'noopener noreferrer', text: 'Open on the Mac’s link' }) : null,
        ]);
    }
}

// ── the phone sheet ────────────────────────────────────────────────────

let _sheet = null;

export function openArtifactsSheet({ urlFor, tab = null, away = null, fallback = null }) {
    if (!_sheet) {
        const overlay = h('div', { id: 'artifacts-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'artifacts-title' });
        const body = h('div', { class: 'artifacts-body' });
        const close = h('button', { type: 'button', class: 'settings-close', id: 'artifacts-close', 'aria-label': 'Close', text: '×' });
        const reload = h('button', { type: 'button', class: 'artifacts-rescan', 'aria-label': 'Check for new artifacts', title: 'Check for new artifacts' });
        reload.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>';
        overlay.append(h('div', { class: 'artifacts-sheet' }, [
            h('div', { class: 'settings-handle' }, [h('span')]),
            h('div', { class: 'artifacts-header' }, [
                h('div', { class: 'artifacts-title', id: 'artifacts-title', text: 'Artifacts' }),
                h('div', { class: 'artifacts-header-r' }, [reload, close]),
            ]),
            body,
        ]));
        document.body.appendChild(overlay);
        const s = { overlay, body, reload, panel: null, timer: null, focusTimer: null, returnFocus: null };
        const stop = () => { clearInterval(s.timer); s.timer = null; };
        const start = () => { stop(); if (!document.hidden && s.panel && !s.panel.away) s.timer = setInterval(() => s.panel.refresh(), REFRESH_MS); };
        s.hide = () => {
            overlay.classList.remove('visible');
            stop();
            clearTimeout(s.focusTimer);
            s.panel?.pause();
            document.removeEventListener('visibilitychange', s.onVis);
            if (document.activeElement && overlay.contains(document.activeElement)) {
                document.activeElement.blur();
                if (s.returnFocus?.isConnected) s.returnFocus.focus({ preventScroll: true });
            }
        };
        s.start = start;
        s.onVis = () => {
            if (document.hidden) { stop(); s.panel?.pause(); }
            else if (overlay.classList.contains('visible') && !s.timer) { s.panel.resume(); start(); }
        };
        close.addEventListener('click', s.hide);
        reload.addEventListener('click', () => { if (s.panel) s.panel.rescan(); });
        overlay.addEventListener('click', e => { if (e.target === overlay) s.hide(); });
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') s.hide(); });
        _sheet = s;
    }
    const s = _sheet;
    if (s.panel) s.panel.destroy();
    clearTimeout(s.focusTimer);
    s.returnFocus = document.activeElement;
    // A new client each open: the paired backend may have changed.
    s.panel = new ArtifactsPanel({ client: new ArtifactsClient(urlFor), root: s.body, tab, away, fallback });
    s.reload.hidden = !!away;
    s.overlay.classList.add('visible');
    if (document.hidden) s.panel.pause();
    else s.panel.refresh();
    s.start();
    document.addEventListener('visibilitychange', s.onVis);
    // The close button, never the search field: on a phone that would raise
    // the keyboard over the list (m/focusPolicy.js decides for a keyboard).
    s.focusTimer = setTimeout(() => {
        if (!s.overlay.classList.contains('visible') || document.hidden) return;
        s.overlay.querySelector('#artifacts-close')?.focus({ preventScroll: true });
        s.panel.focusSearch();
    }, 60);
    return s;
}

export function closeArtifactsSheet() { if (_sheet) _sheet.hide(); }
