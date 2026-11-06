/**
 * codePanel — view, edit and save files from the right panel.
 *
 * The browser never touches the disk itself. Every read and write goes to
 * scripts/soa-code, a loopback service reached through the daemon's
 * authenticated /preview/6083/ proxy, so the pairing token and password that
 * already guard the terminals guard this too. The service enforces the path
 * policy; this module only has to be honest about what it was told.
 *
 * One CodeMirror editor per open file, hidden when not active: each file keeps
 * its own undo history, selection and scroll, and nothing has to be swapped in
 * and out on a tab click. Unsaved buffers live as long as the page does, so
 * hiding the panel (or switching it back to Context) loses nothing.
 *
 * Saves are optimistic-concurrency writes: every write carries the sha the
 * buffer was loaded from, and the service refuses it if the file moved on
 * underneath. A 4 s stat poll catches the same thing earlier, while you look.
 */

const VER = 'code-20261106b';
const PREFIX = '/preview/6083';
const CM_URL = `/assets/vendor/codemirror-6/cm.js?v=${VER}`;
const STAT_MS = 4000;
const GIT_MS = 15000;
const CWD_MS = 1200;
const LS_HIDDEN = 'soa_code_hidden', LS_SPLIT = 'soa_code_split', LS_COL = 'soa_code_col', LS_EXPLORER = 'soa_code_explorer';
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const START_CMD = 'cd ~/.soa-web && cp deploy/launchd/com.soa-web.code.plist ~/Library/LaunchAgents/\n' +
    'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.soa-web.code.plist';

const el = (tag, props = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
};

// Stroke icons on a 16px grid, drawn in currentColor so every pack tints them.
const ICONS = {
    files: '<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/>',
    search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2 14 14"/>',
    grep: '<path d="M2 3.5h8M2 6.5h5M2 9.5h3.5"/><circle cx="10.5" cy="10" r="2.6"/><path d="m12.4 11.9 2 2"/>',
    jump: '<path d="M2.5 8h10M9 4.5 12.5 8 9 11.5"/>',
    save: '<path d="M3 2.5h8l2.5 2.5v8.5h-10.5z"/><path d="M5.5 2.5V6h4.5V2.5M5 13.5v-4h6v4"/>',
    widen: '<path d="M1.5 8h13M4 5.5 1.5 8 4 10.5M12 5.5 14.5 8 12 10.5"/>',
    narrow: '<path d="M1.5 8h4.5M10 8h4.5M3.5 5.5 6 8l-2.5 2.5M12.5 5.5 10 8l2.5 2.5"/>',
    up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.46-3.54"/><path d="M13 2.5v3h-3"/>',
    add: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M8 7.5v4M6 9.5h4"/>',
    eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    close: '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>',
    chev: '<path d="m6 4 4 4-4 4"/>',
    home: '<path d="M2.5 7.5 8 3l5.5 4.5M4 6.5v6.5h8V6.5"/>',
};
function icon(name) {
    const s = document.createElement('span');
    s.className = 'cp-ic';
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
    return s;
}
function btn(cls, iconName, label, onclick, { text = false, title } = {}) {
    const b = el('button', { class: `cp-btn ${cls || ''}`.trim(), type: 'button', 'aria-label': label, title: title || label, onclick });
    if (iconName) b.appendChild(icon(iconName));
    if (text) b.appendChild(el('span', { class: 'cp-btn-label', text: label }));
    return b;
}

function lsGet(k, fallback) {
    try { const v = localStorage.getItem(k); return v == null ? fallback : v; } catch (_) { return fallback; }
}
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const basename = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || '/';
const dirname = (p) => { const s = String(p || '').replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); };
const join = (dir, name) => (dir === '/' ? '' : String(dir).replace(/\/+$/, '')) + '/' + name;
const lf = (s) => String(s).replace(/\r\n?/g, '\n');
const isMod = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);
function fmtSize(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
}

async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    const ta = el('textarea', { readonly: '', 'aria-hidden': 'true' });
    ta.value = text;
    Object.assign(ta.style, { position: 'fixed', top: '-1000px', opacity: '0' });
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
    return ok;
}

let _cssLoaded = false;
function ensureStyle() {
    if (_cssLoaded || document.querySelector('link[data-soa-code-css]')) { _cssLoaded = true; return; }
    _cssLoaded = true;
    document.head.appendChild(el('link', {
        rel: 'stylesheet', 'data-soa-code-css': '1',
        href: new URL(`./codePanel.css?v=${VER}`, import.meta.url).href,
    }));
}

let _cmP = null;
function loadCM() {
    if (!_cmP) _cmP = import(CM_URL).catch((e) => { _cmP = null; throw e; });
    return _cmP;
}

// ── Line diff (Myers) ───────────────────────────────────────────────────
// Only for Compare: disk vs. buffer. The common prefix and suffix are trimmed
// first, so the O(ND) core only sees the region that actually differs; past
// MAX_D edits it gives up and shows the region as one replace block.
const MAX_D = 1500;
function myers(a, b) {
    const n = a.length, m = b.length, max = n + m;
    if (!max) return [];
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= Math.min(max, MAX_D); d++) {
        trace.push(v.slice(off - d - 1, off + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) { x++; y++; }
            v[off + k] = x;
            if (x >= n && y >= m) {
                const ops = [];
                let cx = n, cy = m;
                for (let dd = d; dd >= 0; dd--) {
                    const t = trace[dd];
                    const at = (kk) => t[kk + dd + 1];
                    const kk = cx - cy;
                    const pk = (kk === -dd || (kk !== dd && at(kk - 1) < at(kk + 1))) ? kk + 1 : kk - 1;
                    const px = at(pk), py = px - pk;
                    while (cx > px && cy > py) { ops.push([' ', a[cx - 1]]); cx--; cy--; }
                    if (dd > 0) {
                        if (cx === px) ops.push(['+', b[cy - 1]]);
                        else ops.push(['-', a[cx - 1]]);
                    }
                    cx = px; cy = py;
                }
                return ops.reverse();
            }
        }
    }
    return null;
}
function diffLines(aText, bText) {
    const a = aText.split('\n'), b = bText.split('\n');
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
    const ops = a.slice(0, pre).map(s => [' ', s]);
    const mid = myers(A, B);
    if (mid) ops.push(...mid);
    else { for (const s of A) ops.push(['-', s]); for (const s of B) ops.push(['+', s]); }
    for (const s of a.slice(a.length - suf)) ops.push([' ', s]);
    return ops;
}
// Unified hunks with three lines of context, the shape `diff -u` prints.
function hunks(ops, ctx = 3) {
    const out = [];
    let ai = 1, bi = 1, i = 0;
    const N = ops.length;
    while (i < N) {
        if (ops[i][0] === ' ') { ai++; bi++; i++; continue; }
        let start = i;
        let back = 0;
        while (back < ctx && start > 0 && ops[start - 1][0] === ' ') { start--; back++; }
        let end = i, quiet = 0;
        while (end < N) {
            if (ops[end][0] === ' ') { quiet++; if (quiet > ctx * 2) break; }
            else quiet = 0;
            end++;
        }
        end = Math.min(N, end - Math.max(0, quiet - ctx));
        const a0 = ai - back, b0 = bi - back;
        let ac = 0, bc = 0;
        const lines = [];
        for (let j = start; j < end; j++) {
            const [t, s] = ops[j];
            if (t !== '+') ac++;
            if (t !== '-') bc++;
            lines.push([t, s]);
        }
        out.push({ head: `@@ -${a0},${ac} +${b0},${bc} @@`, lines });
        for (let j = i; j < end; j++) { const t = ops[j][0]; if (t !== '+') ai++; if (t !== '-') bi++; }
        i = end;
    }
    return out;
}

class ApiError extends Error {
    constructor(status, body, down = false) {
        super((body && body.error) || `HTTP ${status}`);
        this.status = status;
        this.code = (body && body.code) || (down ? 'DOWN' : 'ERROR');
        this.body = body || {};
        this.down = down;
    }
}

class CodePanel {
    constructor(root, opts) {
        this.root = root;
        // Values or functions: the phone can reconnect through another door or
        // be issued a new unlock, so these are read again on every request.
        this._opt = { backend: opts.backend, token: opts.token, unlock: opts.unlock };
        this.getCwd = opts.getCwd || (() => null);
        this.onRequestWide = opts.onRequestWide || null;
        this.isWide = opts.isWide || (() => false);
        this.layout = opts.layout === 'phone' ? 'phone' : 'side';
        this._bufs = new Map();     // abs path -> buffer
        this._order = [];           // tab order
        this._active = null;
        this._dirs = new Map();     // abs dir -> { entries, truncated, error, loading }
        this._open = new Set();     // expanded dirs
        this._git = { repo: false, branch: null, files: {} };
        this._gitDirs = new Set();
        this._root = null;
        this._lastCwd = null;
        this._roots = null;
        this._hidden = lsGet(LS_HIDDEN, '0') === '1';
        this._filter = '';
        this._shown = false;
        this._down = null;
        this._at = { stat: 0, git: 0, cwd: 0 };
        ensureStyle();
        this._build();
        this._onUnload = (e) => {
            if (!this.isDirty()) return;
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', this._onUnload);
    }

    // ── DOM ─────────────────────────────────────────────────────────────
    _build() {
        const r = this.root;
        r.classList.add('cp');
        r.dataset.layout = this.layout;
        r.dataset.explorer = this.layout === 'phone' ? 'off' : lsGet(LS_EXPLORER, 'on');

        // Toolbar.
        this._saveBtn = btn('cp-save', 'save', 'Save', () => this.save(), { text: true, title: `Save (${IS_MAC ? '⌘' : 'Ctrl+'}S)` });
        const items = this.layout === 'phone'
            ? [
                btn('cp-files', 'files', 'Files', () => this._toggleDrawer(), { text: true }),
                btn('', 'jump', 'Quick open', () => this._openPalette('files'), { text: true }),
                btn('', 'search', 'Find', () => this._findInFile(), { text: true }),
                btn('', 'grep', 'Search', () => this._openPalette('grep'), { text: true, title: 'Find in files' }),
                el('span', { class: 'cp-spacer' }),
                this._saveBtn,
            ]
            : [
                this._filesBtn = btn('cp-files', 'files', 'Explorer', () => this._toggleExplorer(), { title: 'Show or hide the explorer' }),
                btn('', 'jump', 'Quick open', () => this._openPalette('files'), { text: true, title: `Quick open (${IS_MAC ? '⌘' : 'Ctrl+'}P)` }),
                btn('', 'grep', 'Search', () => this._openPalette('grep'), { text: true, title: `Find in files (${IS_MAC ? '⌘⇧' : 'Ctrl+Shift+'}F)` }),
                el('span', { class: 'cp-spacer' }),
                this._saveBtn,
                this._wideBtn = btn('cp-wide', 'widen', 'Widen', () => this._toggleWide(), { title: 'Widen the panel' }),
            ];
        this._bar = el('div', { class: 'cp-bar', role: 'toolbar', 'aria-label': 'Code' }, items);
        if (!this.onRequestWide && this._wideBtn) this._wideBtn.hidden = true;

        // Explorer.
        this._upBtn = btn('cp-up', 'up', 'Up one folder', () => this._goUp());
        this._homeBtn = btn('cp-home', 'home', "Back to this tab's folder", () => this._followCwd(true));
        this._rootLabel = el('span', { class: 'cp-root', text: '' });
        this._branch = el('span', { class: 'cp-branch', text: '' });
        this._hiddenBtn = btn('cp-hidden', 'eye', 'Show hidden files', () => this._toggleHidden());
        this._hiddenBtn.setAttribute('aria-pressed', String(this._hidden));
        const exHead = el('div', { class: 'cp-ex-head' }, [
            this._upBtn, this._rootLabel, this._branch, el('span', { class: 'cp-spacer' }),
            this._homeBtn,
            btn('', 'add', 'New file', () => this._newFileForm()),
            btn('', 'refresh', 'Refresh', () => this.refresh()),
            this._hiddenBtn,
        ]);
        this._filterIn = el('input', {
            class: 'cp-filter', type: 'search', placeholder: 'Filter loaded files', 'aria-label': 'Filter files',
            spellcheck: 'false', autocomplete: 'off',
            oninput: (e) => { this._filter = e.target.value.trim().toLowerCase(); this._renderTree(); },
            onkeydown: (e) => {
                if (e.key === 'Escape' && e.target.value) { e.preventDefault(); e.stopPropagation(); e.target.value = ''; this._filter = ''; this._renderTree(); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); this._tree.querySelector('.cp-row')?.focus(); }
            },
        });
        this._notice = el('div', { class: 'cp-notice', hidden: '' });
        this._newForm = el('form', { class: 'cp-newfile', hidden: '' });
        this._tree = el('div', { class: 'cp-tree', role: 'tree', 'aria-label': 'Files' });
        this._tree.addEventListener('keydown', (e) => this._treeKey(e));
        this._explorer = el('div', { class: 'cp-explorer' }, [exHead, this._filterIn, this._notice, this._newForm, this._tree]);
        this._split = el('div', { class: 'cp-split', role: 'separator', tabindex: '0', 'aria-label': 'Resize explorer', title: 'Drag to resize · double-click to reset' });
        this._wireSplit();

        // Editor column.
        this._tabs = el('div', { class: 'cp-tabs', role: 'tablist', 'aria-label': 'Open editors' });
        this._banner = el('div', { class: 'cp-banner', role: 'alert', hidden: '' });
        this._eds = el('div', { class: 'cp-eds' });
        this._diff = el('div', { class: 'cp-diff', hidden: '' });
        this._empty = el('div', { class: 'cp-empty' }, [
            el('p', { class: 'cp-empty-t', text: 'No file open' }),
            el('p', { class: 'cp-empty-s', text: this.layout === 'phone'
                ? 'Tap Files to pick one, or Quick open to find it by name.'
                : `Pick a file in the explorer, or press ${IS_MAC ? '⌘P' : 'Ctrl+P'} to open one by name.` }),
        ]);
        this._st = {
            path: el('span', { class: 'cp-st-path' }),
            pos: el('span', { class: 'cp-st-pos' }),
            lang: el('span', { class: 'cp-st-lang' }),
            eol: el('span', { class: 'cp-st-eol' }),
            state: el('span', { class: 'cp-st-state', 'aria-live': 'polite' }),
        };
        this._status = el('div', { class: 'cp-status' }, Object.values(this._st));
        this._toastEl = el('div', { class: 'cp-toast', role: 'status', 'aria-live': 'polite', hidden: '' });
        this._main = el('div', { class: 'cp-main' }, [this._tabs, this._banner, this._eds, this._diff, this._empty, this._status, this._toastEl]);

        this._scrim = el('div', { class: 'cp-scrim', hidden: '', onclick: () => this._toggleDrawer(false) });
        this._body = el('div', { class: 'cp-body' }, [this._explorer, this._split, this._main, this._scrim]);
        this._overlay = el('div', { class: 'cp-overlay', hidden: '' });
        this._downEl = el('div', { class: 'cp-down', hidden: '' });

        r.replaceChildren(this._bar, this._body, this._overlay, this._downEl);
        r.addEventListener('keydown', (e) => {
            this._key(e);
            // The dashboard's window hotkeys treat bare arrows and digits as
            // "switch terminal tab" whenever focus is not in a text field, so
            // walking the tree or the tab strip moved the terminal underneath.
            // Chorded shortcuts still reach the shell.
            if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
        });
        // The palettes are claimed before CodeMirror sees the key: its search
        // keymap would otherwise take Mod-Shift-F as Mod-F on some layouts.
        r.addEventListener('keydown', (e) => {
            const k = (e.key || '').toLowerCase();
            if (!isMod(e) || e.altKey || (k !== 'p' && k !== 'f') || (k === 'f' && !e.shiftKey) || (k === 'p' && e.shiftKey)) return;
            e.preventDefault();
            e.stopPropagation();
            this._openPalette(k === 'p' ? 'files' : 'grep');
        }, true);

        // Explorer beside the editor once there is room for both; stacked above it otherwise.
        this._ro = new ResizeObserver(() => this._layoutCols());
        this._ro.observe(r);
        this._applySplit();
        this._renderTabs();
        this._renderStatus();
        this.syncWide();
    }

    _layoutCols() {
        const w = this.root.clientWidth;
        const cols = this.layout === 'side' && w >= 620;
        if ((this.root.dataset.cols === '1') !== cols) {
            this.root.dataset.cols = cols ? '1' : '0';
            this._applySplit();
        }
    }

    _applySplit() {
        const cols = this.root.dataset.cols === '1';
        if (this.layout === 'phone') { this._explorer.style.flexBasis = ''; return; }
        const key = cols ? LS_COL : LS_SPLIT;
        const px = parseInt(lsGet(key, ''), 10);
        this._explorer.style.flexBasis = Number.isFinite(px) && px > 0 ? `${px}px` : '';
    }

    _wireSplit() {
        const g = this._split;
        const cols = () => this.root.dataset.cols === '1';
        const set = (px) => {
            const box = this._body.getBoundingClientRect();
            const max = (cols() ? box.width : box.height) - 140;
            const v = clamp(Math.round(px), 90, Math.max(90, max));
            this._explorer.style.flexBasis = `${v}px`;
            lsSet(cols() ? LS_COL : LS_SPLIT, String(v));
        };
        g.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const c = cols();
            const start = { p: c ? e.clientX : e.clientY, s: c ? this._explorer.getBoundingClientRect().width : this._explorer.getBoundingClientRect().height };
            try { g.setPointerCapture(e.pointerId); } catch (_) {}
            g.classList.add('dragging');
            document.body.classList.add('ctx-resizing');
            const move = (ev) => set(start.s + ((c ? ev.clientX : ev.clientY) - start.p));
            const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                window.removeEventListener('pointercancel', up);
                g.classList.remove('dragging');
                document.body.classList.remove('ctx-resizing');
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
            window.addEventListener('pointercancel', up);
        });
        g.addEventListener('dblclick', () => { this._explorer.style.flexBasis = ''; try { localStorage.removeItem(cols() ? LS_COL : LS_SPLIT); } catch (_) {} });
        g.addEventListener('keydown', (e) => {
            const c = cols();
            const grow = c ? 'ArrowRight' : 'ArrowDown', shrink = c ? 'ArrowLeft' : 'ArrowUp';
            if (e.key !== grow && e.key !== shrink) return;
            e.preventDefault();
            const r = this._explorer.getBoundingClientRect();
            set((c ? r.width : r.height) + (e.key === grow ? 16 : -16));
        });
    }

    // ── Public API ──────────────────────────────────────────────────────
    async show() {
        this._shown = true;
        this.root.hidden = false;
        this.syncWide();
        if (!this._timer) this._timer = setInterval(() => this._tick(), 1000);
        if (!this._booted) {
            this._booted = true;
            try { await loadCM(); } catch (e) {
                this._booted = false;
                this._toast('The editor failed to load. Reload the page to try again.', 'err');
                console.warn('[code] editor bundle failed', e);
            }
            await this._health();
            if (!this._down) this._followCwd(true);
        } else if (this._down) {
            this._health();
        } else {
            // The tab may have moved on while the panel was hidden.
            this._followCwd(false);
            this._statActive();
        }
    }

    hide() {
        this._shown = false;
        this.root.hidden = true;
        this._closeOverlay();
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    focus() {
        const b = this._activeBuf();
        if (b && !this._diffOpen) b.ed.focus();
        else (this._tree.querySelector('.cp-row.active') || this._tree.querySelector('.cp-row') || this._filterIn).focus();
    }

    isDirty() {
        for (const b of this._bufs.values()) if (b.dirty) return true;
        return false;
    }

    setRoot(dir) {
        if (!dir) return;
        this._root = String(dir).replace(/(.)\/+$/, '$1');
        // A host that calls setRoot for the tab's cwd has done the follow.
        if (this.getCwd() === dir) this._lastCwd = dir;
        this._rootReal = null;
        this._selDir = null;
        this._git = { repo: false, branch: null, files: {} };
        this._gitDirs = new Set();
        this._dirs.clear();
        this._open = new Set([this._root]);
        this._filter = '';
        this._filterIn.value = '';
        this._newForm.hidden = true;
        this._hideNotice();
        this._renderHead();
        this._renderStatus();
        this._loadDir(this._root);
        this._loadGit();
    }

    syncWide() {
        if (!this._wideBtn) return;
        const on = !!this.isWide();
        this._wideBtn.setAttribute('aria-pressed', String(on));
        this._wideBtn.replaceChildren(icon(on ? 'narrow' : 'widen'));
        const label = on ? 'Narrow' : 'Widen';
        this._wideBtn.setAttribute('aria-label', label);
        this._wideBtn.title = on ? 'Back to the normal width' : 'Widen the panel';
    }

    destroy() {
        this.hide();
        window.removeEventListener('beforeunload', this._onUnload);
        try { this._ro.disconnect(); } catch (_) {}
        for (const b of this._bufs.values()) { try { b.ed.destroy(); } catch (_) {} }
        this._bufs.clear();
        this.root.replaceChildren();
        this.root.classList.remove('cp');
    }

    // ── Service calls ───────────────────────────────────────────────────
    // The same URL shape contextPanel's api() builds: backend origin + the
    // proxy prefix, with the pairing token and unlock as query params so a
    // cross-origin dashboard (s0a.app talking to a tunnel) is authorised too.
    _get(k) {
        const v = this._opt[k];
        try { return (typeof v === 'function' ? v() : v) || ''; } catch (_) { return ''; }
    }

    _url(p, params) {
        const base = this._get('backend').replace(/\/+$/, '');
        const u = new URL(base + PREFIX + p, location.origin);
        if (params) for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
        const cfg = window.__SOA_WEB__ || {};
        const t = cfg._resolvedToken || this._get('token');
        const un = cfg._resolvedUnlock || this._get('unlock');
        if (t) u.searchParams.set('t', t);
        if (un) u.searchParams.set('u', un);
        return u.toString();
    }

    async _api(p, { method = 'GET', params, body } = {}) {
        const headers = { 'x-soa-code': '1', 'ngrok-skip-browser-warning': 'true' };
        const init = { method, credentials: 'include', cache: 'no-store', headers };
        if (body !== undefined) {
            // Writes are POST, not PUT: the daemon's CORS preflight only allows
            // GET/POST, and a cross-origin dashboard has to get through it.
            // text/plain on purpose: the daemon's global express.json() would
            // otherwise consume (and 16 KB-cap) an application/json body before
            // the proxy can stream it on. The service parses the JSON itself.
            headers['content-type'] = 'text/plain;charset=utf-8';
            init.body = JSON.stringify(body);
        }
        let r;
        try { r = await fetch(this._url(p, params), init); } catch (e) {
            const err = new ApiError(0, { error: String(e && e.message || e), code: 'NETWORK' }, true);
            this._setDown('down');
            throw err;
        }
        let data = null;
        const ct = r.headers.get('content-type') || '';
        if (/json/i.test(ct)) { try { data = await r.json(); } catch (_) {} }
        // The proxy answers 502 (with an HTML page) when nothing listens on the
        // port; any non-JSON answer means we are not talking to soa-code.
        if (!data || r.status === 502 || r.status === 503 || r.status === 504) {
            this._setDown('down');
            throw new ApiError(r.status, data, true);
        }
        if ((r.status === 401 || r.status === 403) && !data.code) {
            this._setDown('auth');
            throw new ApiError(r.status, data, true);
        }
        if (!r.ok || data.ok === false) throw new ApiError(r.status, data);
        if (this._down) this._setDown(null);
        return data;
    }

    async _health() {
        try {
            const h = await this._api('/api/health');
            this._roots = Array.isArray(h.roots) ? h.roots : null;
            this._setDown(null);
            return true;
        } catch (_) { return false; }
    }

    _setDown(kind) {
        if (kind === this._down) return;
        this._down = kind;
        const d = this._downEl;
        if (!kind) { d.hidden = true; d.replaceChildren(); this._body.hidden = false; return; }
        this._body.hidden = true;
        this._closeOverlay();
        const retry = el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Retry', onclick: async () => {
            retry.disabled = true;
            retry.textContent = 'Checking…';
            const ok = await this._health();
            retry.disabled = false;
            retry.textContent = 'Retry';
            if (ok) { if (this._root) this.refresh(); else this._followCwd(true); }
        } });
        if (kind === 'auth') {
            d.replaceChildren(
                el('p', { class: 'cp-down-t', text: 'This device is not allowed to reach the code service.' }),
                el('p', { class: 'cp-down-s', text: 'Pair it again from the desktop, or unlock it with the pairing password, then retry.' }),
                el('div', { class: 'cp-down-a' }, [retry]),
            );
        } else {
            const copy = el('button', { class: 'cp-btn', type: 'button', text: 'Copy', onclick: async () => {
                copy.textContent = (await copyText(START_CMD)) ? 'Copied' : 'Copy failed';
                setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
            } });
            d.replaceChildren(
                el('p', { class: 'cp-down-t', text: 'The code service is not running on this Mac.' }),
                el('p', { class: 'cp-down-s', text: 'Start it once in a terminal on the Mac; launchd keeps it running after that.' }),
                el('pre', { class: 'cp-down-cmd', tabindex: '0' }, [el('code', { text: START_CMD })]),
                el('div', { class: 'cp-down-a' }, [retry, copy]),
            );
        }
        d.hidden = false;
    }

    // ── Poll loop ───────────────────────────────────────────────────────
    _visible() {
        return this._shown && !document.hidden && this.root.isConnected && this.root.getClientRects().length > 0;
    }

    _tick() {
        if (!this._visible() || this._down) return;
        const now = Date.now();
        if (now - this._at.cwd >= CWD_MS) { this._at.cwd = now; this._followCwd(false); }
        if (now - this._at.stat >= STAT_MS) { this._at.stat = now; this._statActive(); }
        if (now - this._at.git >= GIT_MS) { this._at.git = now; this._loadGit(); }
    }

    // The explorer follows the terminal tab, unless that would pull the rug
    // from under unsaved work — then it asks.
    _followCwd(force) {
        const cwd = this.getCwd();
        if (!cwd) {
            if (!this._root) {
                this._renderHead();
                this._tree.replaceChildren(el('p', { class: 'cp-muted', text: 'Open a terminal tab to browse its folder.' }));
            }
            return;
        }
        if (!force && cwd === this._lastCwd) return;
        this._lastCwd = cwd;
        if (force || !this._root || !this.isDirty()) { this.setRoot(cwd); return; }
        if (cwd === this._root) { this._hideNotice(); return; }
        this._notice.replaceChildren(
            el('span', { class: 'cp-notice-t', text: `This tab is in ${basename(cwd)}. You have unsaved changes here.` }),
            el('span', { class: 'cp-notice-a' }, [
                el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Switch project', onclick: () => this.setRoot(cwd) }),
                el('button', { class: 'cp-btn', type: 'button', text: 'Stay', onclick: () => this._hideNotice() }),
            ]),
        );
        this._notice.title = cwd;
        this._notice.hidden = false;
    }
    _hideNotice() { this._notice.hidden = true; this._notice.replaceChildren(); }

    _goUp() {
        if (!this._root || this._root === '/') return;
        this.setRoot(dirname(this._root));
    }

    _atAllowedRoot() {
        if (!this._root) return true;
        if (this._root === '/') return true;
        return !!(this._roots && this._roots.some(r => String(r).replace(/\/+$/, '') === this._root));
    }

    _renderHead() {
        const root = this._root;
        this._rootLabel.textContent = root ? basename(root) : 'No folder';
        this._rootLabel.title = root || '';
        this._upBtn.disabled = !root || this._atAllowedRoot();
        const cwd = this.getCwd();
        this._homeBtn.hidden = !cwd || !root || cwd === root || cwd === this._rootReal;
        this._branch.textContent = this._git.repo && this._git.branch ? this._git.branch : '';
        this._branch.hidden = !this._branch.textContent;
        this._branch.title = this._branch.textContent ? `Branch ${this._branch.textContent}` : '';
    }

    // ── Explorer ────────────────────────────────────────────────────────
    async _loadDir(dir, { quiet = false } = {}) {
        const prev = this._dirs.get(dir);
        if (!quiet) this._dirs.set(dir, { ...(prev || {}), loading: true });
        if (!quiet) this._renderTree();
        try {
            const res = await this._api('/api/tree', { params: { path: dir, hidden: this._hidden ? 1 : null } });
            if (dir === this._root && res.path && res.path !== dir) this._rootReal = res.path;
            this._dirs.set(dir, { entries: res.entries || [], truncated: !!res.truncated, loading: false });
        } catch (e) {
            if (e.down) return;
            this._dirs.set(dir, { entries: [], loading: false, error: this._errText(e) });
        }
        this._renderTree();
        if (dir === this._root) this._renderHead();
    }

    _errText(e) {
        const c = e.code;
        if (c === 'NOT_FOUND') return 'Not found.';
        if (c === 'OUTSIDE_ROOT') return 'Outside the folders the code service may open.';
        if (c === 'DENIED' || c === 'READ_ONLY' || e.status === 403) return e.message ? `Not allowed: ${e.message}.` : 'Not allowed.';
        return e.message || 'Something went wrong.';
    }

    async _loadGit() {
        if (!this._root) return;
        try {
            const g = await this._api('/api/git', { params: { root: this._root } });
            this._git = { repo: !!g.repo, branch: g.branch || null, files: g.files || {} };
        } catch (e) {
            if (e.down) return;
            this._git = { repo: false, branch: null, files: {} };
        }
        const dirs = new Set();
        for (const rel of Object.keys(this._git.files)) {
            const parts = rel.split('/');
            for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
        }
        this._gitDirs = dirs;
        this._renderHead();
        this._renderTree();
    }

    _rel(abs) {
        const roots = [this._root, this._rootReal].filter(Boolean);
        for (const r of roots) {
            if (abs === r) return '';
            const pre = r === '/' ? '/' : r + '/';
            if (abs.startsWith(pre)) return abs.slice(pre.length);
        }
        return null;
    }

    _toggleHidden() {
        this._hidden = !this._hidden;
        lsSet(LS_HIDDEN, this._hidden ? '1' : '0');
        this._hiddenBtn.setAttribute('aria-pressed', String(this._hidden));
        this._hiddenBtn.title = this._hidden ? 'Hide hidden files' : 'Show hidden files';
        this.refresh();
    }

    refresh() {
        if (!this._root) { this._followCwd(true); return; }
        const dirs = [...this._open].filter(d => this._dirs.has(d) || d === this._root);
        for (const d of dirs) this._loadDir(d, { quiet: true });
        this._loadGit();
    }

    _toggleDir(dir, open) {
        const want = open == null ? !this._open.has(dir) : open;
        if (want) {
            this._open.add(dir);
            if (!this._dirs.has(dir)) { this._loadDir(dir); return; }
        } else this._open.delete(dir);
        this._renderTree();
    }

    // Filtering walks only what has been loaded: it narrows what you can see,
    // it never fans out a crawl of the disk (quick open does that).
    _matches(dir, memo) {
        if (memo.has(dir)) return memo.get(dir);
        memo.set(dir, false);
        const node = this._dirs.get(dir);
        let hit = false;
        if (node && node.entries) {
            for (const e of node.entries) {
                const p = join(dir, e.name);
                if (e.name.toLowerCase().includes(this._filter)) { hit = true; break; }
                if (e.type === 'dir' && this._matches(p, memo)) { hit = true; break; }
            }
        }
        memo.set(dir, hit);
        return hit;
    }

    _renderTree() {
        const tree = this._tree;
        if (!this._root) return;
        const focused = tree.contains(document.activeElement) ? document.activeElement.dataset.path : null;
        const rows = [];
        const filter = this._filter;
        const memo = new Map();
        const activePath = this._active;
        const walk = (dir, depth) => {
            const node = this._dirs.get(dir);
            if (!node) return;
            if (node.loading && !node.entries) { rows.push(el('div', { class: 'cp-tree-msg', style: `--d:${depth}`, text: 'Loading…' })); return; }
            if (node.error) { rows.push(el('div', { class: 'cp-tree-msg cp-tree-err', style: `--d:${depth}`, text: node.error })); return; }
            const ents = node.entries || [];
            if (!ents.length && depth === 0) rows.push(el('div', { class: 'cp-tree-msg', style: `--d:${depth}`, text: 'Empty folder.' }));
            for (const e of ents) {
                const p = join(dir, e.name);
                const isDir = e.type === 'dir';
                const selfHit = !filter || e.name.toLowerCase().includes(filter);
                const subHit = filter && isDir && this._matches(p, memo);
                if (filter && !selfHit && !subHit) continue;
                const rel = this._rel(p);
                const g = rel != null ? this._git.files[rel] : null;
                const open = isDir && (this._open.has(p) || (filter && subHit));
                const row = el('button', {
                    class: `cp-row${e.ignored ? ' cp-ignored' : ''}${p === activePath ? ' active' : ''}${g ? ` g-${g === '?' ? 'u' : g.toLowerCase()}` : ''}${isDir && rel != null && this._gitDirs.has(rel) ? ' g-dir' : ''}`,
                    type: 'button', role: 'treeitem', tabindex: '-1',
                    'aria-level': String(depth + 1),
                    'aria-expanded': isDir ? String(!!open) : null,
                    'aria-selected': p === activePath ? 'true' : null,
                    'data-path': p, 'data-type': e.type,
                    style: `--d:${depth}`,
                    title: e.type === 'file' && Number.isFinite(e.size) ? `${rel || p} · ${fmtSize(e.size)}` : (rel || p),
                });
                row.appendChild(isDir ? Object.assign(icon('chev'), { className: `cp-ic cp-caret${open ? ' open' : ''}` }) : el('span', { class: 'cp-caret-pad' }));
                row.appendChild(el('span', { class: 'cp-name', text: e.name + (e.type === 'link' ? ' ↗' : '') }));
                if (g) row.appendChild(el('span', { class: 'cp-git', text: g, 'aria-label': GIT_WORDS[g] || g }));
                row.addEventListener('click', () => {
                    if (isDir) { this._selDir = p; this._toggleDir(p); }
                    else { this._selDir = dir; this.openFile(p); }
                });
                row.addEventListener('auxclick', (ev) => { if (ev.button === 1 && !isDir) { ev.preventDefault(); this.openFile(p); } });
                rows.push(row);
                if (open) walk(p, depth + 1);
            }
            if (node.truncated) rows.push(el('div', { class: 'cp-tree-msg', style: `--d:${depth}`, text: 'Too many files to list them all here. Use quick open.' }));
        };
        walk(this._root, 0);
        if (filter && !rows.length) rows.push(el('div', { class: 'cp-tree-msg', text: 'No loaded file matches. Quick open searches the whole folder.' }));
        tree.replaceChildren(...rows);
        const first = tree.querySelector('.cp-row.active') || tree.querySelector('.cp-row');
        if (first) first.tabIndex = 0;
        if (focused) {
            const again = [...tree.querySelectorAll('.cp-row')].find(r => r.dataset.path === focused);
            if (again) { again.tabIndex = 0; again.focus(); }
        }
    }

    _treeKey(e) {
        const row = e.target.closest('.cp-row');
        if (!row) return;
        const rows = [...this._tree.querySelectorAll('.cp-row')];
        const i = rows.indexOf(row);
        const go = (j) => { const r = rows[clamp(j, 0, rows.length - 1)]; if (r) { rows.forEach(x => { x.tabIndex = -1; }); r.tabIndex = 0; r.focus(); } };
        const isDir = row.dataset.type === 'dir';
        const p = row.dataset.path;
        if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (i === 0) this._filterIn.focus(); else go(i - 1); }
        else if (e.key === 'Home') { e.preventDefault(); go(0); }
        else if (e.key === 'End') { e.preventDefault(); go(rows.length - 1); }
        else if (e.key === 'ArrowRight' && isDir) {
            e.preventDefault();
            if (row.getAttribute('aria-expanded') !== 'true') this._toggleDir(p, true); else go(i + 1);
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (isDir && row.getAttribute('aria-expanded') === 'true') { this._toggleDir(p, false); return; }
            const parent = dirname(p);
            const pr = rows.find(r => r.dataset.path === parent);
            if (pr) go(rows.indexOf(pr));
        }
    }

    _newFileForm() {
        const f = this._newForm;
        if (!this._root) return;
        const base = this._selDir && this._rel(this._selDir) != null ? this._selDir : this._root;
        const rel = this._rel(base);
        const input = el('input', { class: 'cp-filter', type: 'text', placeholder: 'name.ext or folder/name.ext', 'aria-label': 'New file name', spellcheck: 'false', autocomplete: 'off' });
        const where = el('span', { class: 'cp-newfile-in', text: `In ${rel ? rel + '/' : basename(base) + '/'}` });
        const cancel = () => { f.hidden = true; f.replaceChildren(); };
        f.onsubmit = async (e) => {
            e.preventDefault();
            const name = input.value.trim().replace(/^\/+/, '');
            if (!name || name.split('/').some(s => s === '..' || s === '.')) { input.focus(); return; }
            const path = join(base, name);
            try {
                await this._api('/api/file', { method: 'POST', body: { path, content: '', baseSha: null, create: true } });
                cancel();
                this._open.add(base);
                await this._loadDir(dirname(path) === base ? base : dirname(path), { quiet: true });
                if (dirname(path) !== base) this._loadDir(base, { quiet: true });
                this._loadGit();
                this.openFile(path);
            } catch (err) {
                if (err.down) return;
                const msg = err.code === 'EXISTS' ? `${name} already exists.`
                    : err.code === 'NOT_FOUND' && name.includes('/') ? `Could not create ${name}: the folder ${dirname(name)} does not exist.`
                        : `Could not create ${name}: ${this._errText(err)}`;
                this._toast(msg, 'err');
            }
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } });
        f.replaceChildren(where, input,
            el('span', { class: 'cp-newfile-a' }, [
                el('button', { class: 'cp-btn cp-btn-primary', type: 'submit', text: 'Create' }),
                el('button', { class: 'cp-btn', type: 'button', text: 'Cancel', onclick: cancel }),
            ]));
        f.hidden = false;
        input.focus();
    }

    _toggleExplorer() {
        const on = this.root.dataset.explorer === 'off';
        this.root.dataset.explorer = on ? 'on' : 'off';
        lsSet(LS_EXPLORER, on ? 'on' : 'off');
        if (this._filesBtn) this._filesBtn.setAttribute('aria-pressed', String(on));
    }

    _toggleDrawer(force) {
        const open = force == null ? this.root.dataset.explorer === 'off' : !!force;
        this.root.dataset.explorer = open ? 'on' : 'off';
        this._scrim.hidden = !open;
        if (open) setTimeout(() => (this._tree.querySelector('.cp-row.active') || this._tree.querySelector('.cp-row') || this._filterIn).focus(), 0);
    }

    _toggleWide() {
        if (!this.onRequestWide) return;
        this.onRequestWide(!this.isWide());
        this.syncWide();
    }

    // ── Buffers ─────────────────────────────────────────────────────────
    _activeBuf() { return this._active ? this._bufs.get(this._active) : null; }

    async openFile(path, line, col) {
        if (!path) return;
        if (this.layout === 'phone') this._toggleDrawer(false);
        const have = this._bufs.get(path);
        if (have) {
            this._activate(path);
            if (line) have.ed.gotoLine(line, col || 1);
            return;
        }
        let cm;
        try { cm = await loadCM(); } catch (_) { this._toast('The editor failed to load.', 'err'); return; }
        let f;
        try { f = await this._api('/api/file', { params: { path } }); } catch (e) {
            if (e.down) return;
            const name = basename(path);
            if (e.code === 'TOO_LARGE') this._toast(`${name} is ${fmtSize(e.body.size)}, too large to edit here (2 MB limit).`, 'err');
            else if (e.code === 'BINARY') this._toast(`${name} is a binary file, so it can't be shown as text.`, 'err');
            else this._toast(`Could not open ${name}: ${this._errText(e)}`, 'err');
            return;
        }
        if (this._bufs.has(path)) { this._activate(path); return; }
        const host = el('div', { class: 'cp-ed', hidden: '' });
        this._eds.appendChild(host);
        const b = {
            path, name: basename(path), host,
            sha: f.sha, mtimeMs: f.mtimeMs, size: f.size, eol: f.eol === 'crlf' ? 'crlf' : 'lf',
            readonly: !!f.readonly, saved: lf(f.content || ''), dirty: false,
            conflict: null, deleted: false, closeAsk: false, saving: false,
            cursor: { line: 1, col: 1 }, lang: '',
        };
        b.ed = cm.createEditor({
            parent: host, doc: b.saved, filename: b.name, readOnly: b.readonly, tabSize: 4,
            onChange: () => this._changed(b),
            onSave: () => this.save(b),
            onCursor: (info) => { b.cursor = info; b.lang = info.language || b.lang; if (this._active === b.path) this._renderStatus(); },
        });
        b.lang = b.ed.language || b.lang;
        this._bufs.set(path, b);
        const at = this._order.indexOf(this._active);
        this._order.splice(at < 0 ? this._order.length : at + 1, 0, path);
        this._activate(path);
        if (line) b.ed.gotoLine(line, col || 1);
        else b.ed.focus();
    }

    _changed(b) {
        clearTimeout(b._dt);
        // Comparing the whole document is O(n); batching it behind a short
        // timer keeps typing in a 2 MB file from doing it per keystroke.
        b._dt = setTimeout(() => {
            const dirty = b.ed.getDoc() !== b.saved;
            if (dirty === b.dirty) return;
            b.dirty = dirty;
            this._renderTabs();
            if (this._active === b.path) this._renderStatus();
        }, 120);
    }

    _activate(path) {
        const b = this._bufs.get(path);
        if (!b) return;
        this._active = path;
        this._diffOpen = false;
        this._diff.hidden = true;
        this._diff.replaceChildren();
        this._eds.hidden = false;
        for (const x of this._bufs.values()) x.host.hidden = x !== b;
        this._empty.hidden = true;
        try { b.ed.view.requestMeasure(); } catch (_) {}
        this._renderTabs();
        this._renderStatus();
        this._renderBanner();
        this._markTreeActive();
        this._statActive();
    }

    _markTreeActive() {
        for (const r of this._tree.querySelectorAll('.cp-row')) {
            const on = r.dataset.path === this._active;
            r.classList.toggle('active', on);
            if (on) r.setAttribute('aria-selected', 'true'); else r.removeAttribute('aria-selected');
        }
    }

    close(path, { force = false } = {}) {
        const b = this._bufs.get(path || this._active);
        if (!b) return;
        if (b.dirty && !force) {
            if (this._active !== b.path) this._activate(b.path);
            b.closeAsk = true;
            this._renderBanner();
            return;
        }
        clearTimeout(b._dt);
        try { b.ed.destroy(); } catch (_) {}
        b.host.remove();
        this._bufs.delete(b.path);
        const i = this._order.indexOf(b.path);
        this._order.splice(i, 1);
        if (this._active === b.path) {
            this._active = null;
            const next = this._order[Math.min(i, this._order.length - 1)];
            if (next) this._activate(next);
            else {
                this._diff.hidden = true;
                this._empty.hidden = false;
                this._renderTabs();
                this._renderStatus();
                this._renderBanner();
                this._markTreeActive();
            }
        } else this._renderTabs();
    }

    _cycle(dir) {
        if (this._order.length < 2) return;
        const i = this._order.indexOf(this._active);
        const next = this._order[(i + dir + this._order.length) % this._order.length];
        this._activate(next);
        this._bufs.get(next)?.ed.focus();
    }

    _renderTabs() {
        const tabs = this._order.map((p) => {
            const b = this._bufs.get(p);
            const on = p === this._active;
            const rel = this._rel(p);
            const t = el('div', {
                class: `cp-tab${on ? ' active' : ''}${b.dirty ? ' dirty' : ''}`,
                role: 'tab', tabindex: on ? '0' : '-1', 'aria-selected': String(on),
                title: (rel != null ? rel : p) + (b.dirty ? ' · unsaved' : ''),
                'data-path': p,
            }, [
                el('span', { class: 'cp-tab-name', text: b.name }),
                el('span', { class: 'cp-tab-dot', 'aria-label': b.dirty ? 'unsaved' : null }),
            ]);
            const x = el('button', { class: 'cp-tab-x', type: 'button', 'aria-label': `Close ${b.name}`, title: 'Close', tabindex: '-1' }, [icon('close')]);
            x.addEventListener('click', (e) => { e.stopPropagation(); this.close(p); });
            t.appendChild(x);
            t.addEventListener('click', () => this._activate(p));
            t.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); this.close(p); } });
            t.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
            t.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._activate(p); this._bufs.get(p)?.ed.focus(); }
                else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault();
                    const all = [...this._tabs.querySelectorAll('.cp-tab')];
                    const j = all.indexOf(t) + (e.key === 'ArrowRight' ? 1 : -1);
                    all[(j + all.length) % all.length]?.focus();
                } else if (e.key === 'Delete') { e.preventDefault(); this.close(p); }
            });
            return t;
        });
        this._tabs.replaceChildren(...tabs);
        this._tabs.hidden = !tabs.length;
        // Scroll only the strip: scrollIntoView would also move every scrolling
        // ancestor (the rail, or the phone page under its keyboard).
        const act = this._tabs.querySelector('.cp-tab.active');
        if (act) {
            const s = this._tabs, l = act.offsetLeft, r = l + act.offsetWidth;
            if (l < s.scrollLeft) s.scrollLeft = l;
            else if (r > s.scrollLeft + s.clientWidth) s.scrollLeft = r - s.clientWidth;
        }
    }

    _renderStatus() {
        const b = this._activeBuf();
        const s = this._st;
        this._saveBtn.disabled = !b || b.readonly || b.saving;
        if (!b) {
            for (const n of Object.values(s)) n.textContent = '';
            s.path.textContent = this._root ? basename(this._root) : '';
            this._status.dataset.state = '';
            return;
        }
        const rel = this._rel(b.path);
        s.path.textContent = rel != null ? rel : b.path;
        s.path.title = b.path;
        s.pos.textContent = `Ln ${b.cursor.line || 1}, Col ${b.cursor.col || 1}`;
        s.lang.textContent = b.lang || 'Plain text';
        s.eol.textContent = b.eol === 'crlf' ? 'CRLF' : 'LF';
        const state = b.readonly ? 'Read-only' : b.saving ? 'Saving…' : b.conflict ? 'Conflict' : b.dirty ? 'Unsaved' : 'Saved';
        s.state.textContent = state;
        this._status.dataset.state = state.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '');
    }

    _renderBanner() {
        const b = this._activeBuf();
        const ban = this._banner;
        const btnx = (text, fn, primary) => el('button', { class: `cp-btn${primary ? ' cp-btn-primary' : ''}`, type: 'button', text, onclick: fn });
        if (!b || (!b.closeAsk && !b.conflict && !b.deleted)) { ban.hidden = true; ban.replaceChildren(); ban.dataset.kind = ''; return; }
        let msg, acts;
        if (b.closeAsk) {
            ban.dataset.kind = 'ask';
            msg = `${b.name} has unsaved changes.`;
            acts = [
                btnx('Save and close', async () => { if (await this.save(b)) this.close(b.path, { force: true }); }, true),
                btnx('Discard', () => { b.closeAsk = false; this.close(b.path, { force: true }); }),
                btnx('Cancel', () => { b.closeAsk = false; this._renderBanner(); b.ed.focus(); }),
            ];
        } else if (b.conflict) {
            ban.dataset.kind = 'conflict';
            const gone = b.conflict.exists === false;
            msg = gone ? 'Deleted on disk since you opened it.' : 'Changed on disk since you opened it.';
            acts = [
                btnx(gone ? 'Save again' : 'Overwrite', () => this._overwrite(b), true),
                gone ? null : btnx('Reload from disk', () => this._reload(b)),
                gone ? null : btnx(this._diffOpen ? 'Back to editor' : 'Compare', () => (this._diffOpen ? this._closeDiff() : this._compare(b))),
            ];
        } else {
            ban.dataset.kind = 'deleted';
            msg = 'Deleted on disk. Save to write it again.';
            acts = [btnx('Close', () => { b.deleted = false; this.close(b.path, { force: !b.dirty }); })];
        }
        ban.replaceChildren(el('span', { class: 'cp-banner-t', text: msg }), el('span', { class: 'cp-banner-a' }, acts));
        ban.hidden = false;
    }

    async save(target) {
        const b = target && target.path ? target : this._activeBuf();
        if (!b) return false;
        if (b.readonly) { this._toast(`${b.name} is read-only.`); return false; }
        if (b.saving) return false;
        if (b.conflict) { this._renderBanner(); this._toast('Resolve the conflict first: overwrite, reload or compare.'); return false; }
        return this._write(b, b.sha);
    }

    async _write(b, baseSha) {
        clearTimeout(b._dt);
        const snapshot = b.ed.getDoc();
        const content = b.eol === 'crlf' ? snapshot.replace(/\n/g, '\r\n') : snapshot;
        b.saving = true;
        this._renderStatus();
        try {
            const r = await this._api('/api/file', { method: 'POST', body: { path: b.path, content, baseSha: baseSha ?? null } });
            b.sha = r.sha; b.mtimeMs = r.mtimeMs; b.size = r.size;
            b.saved = snapshot;
            b.dirty = b.ed.getDoc() !== snapshot;
            b.conflict = null; b.deleted = false;
            this._closeDiff();
            this._at.git = 0;
            return true;
        } catch (e) {
            if (e.code === 'CONFLICT') {
                b.conflict = { sha: e.body.sha ?? null, mtimeMs: e.body.mtimeMs ?? null, exists: e.body.exists !== false };
                this._toast(`${b.name} changed on disk. Nothing was written.`, 'warn');
            } else if (!e.down) {
                this._toast(`Could not save ${b.name}: ${this._errText(e)}`, 'err');
            }
            return false;
        } finally {
            b.saving = false;
            this._renderTabs();
            if (this._active === b.path) { this._renderStatus(); this._renderBanner(); }
        }
    }

    _overwrite(b) {
        const base = b.conflict ? (b.conflict.exists === false ? null : b.conflict.sha) : b.sha;
        b.conflict = null;
        return this._write(b, base);
    }

    async _reload(b, { quiet = false } = {}) {
        let f;
        try { f = await this._api('/api/file', { params: { path: b.path } }); } catch (e) {
            if (!e.down && !quiet) this._toast(`Could not reload ${b.name}: ${this._errText(e)}`, 'err');
            return false;
        }
        const line = b.cursor.line || 1, col = b.cursor.col || 1;
        const scroll = b.ed.view.scrollDOM.scrollTop;
        b.saved = lf(f.content || '');
        b.ed.setDoc(b.saved);
        b.sha = f.sha; b.mtimeMs = f.mtimeMs; b.size = f.size; b.eol = f.eol === 'crlf' ? 'crlf' : 'lf';
        if (!!f.readonly !== b.readonly) { b.readonly = !!f.readonly; b.ed.setReadOnly(b.readonly); }
        b.dirty = false; b.conflict = null; b.deleted = false;
        try {
            const d = b.ed.view.state.doc;
            const ln = d.line(Math.min(line, d.lines));
            b.ed.view.dispatch({ selection: { anchor: Math.min(ln.from + col - 1, ln.to) } });
            b.ed.view.scrollDOM.scrollTop = scroll;
        } catch (_) {}
        this._closeDiff();
        this._renderTabs();
        if (this._active === b.path) { this._renderStatus(); this._renderBanner(); }
        return true;
    }

    // Poll the open file for changes made outside the panel: an agent in the
    // terminal next door editing the very file you are looking at is the
    // normal case here, not the edge case.
    async _statActive() {
        const b = this._activeBuf();
        if (!b || b.saving || b._statBusy || !this._visible()) return;
        b._statBusy = true;
        try {
            const s = await this._api('/api/stat', { params: { path: b.path } });
            if (b.saving || !this._bufs.has(b.path)) return;
            if (!s.exists) {
                if (!b.deleted) { b.deleted = true; if (this._active === b.path) this._renderBanner(); }
                return;
            }
            if (b.deleted) { b.deleted = false; if (this._active === b.path) this._renderBanner(); }
            const moved = s.sha ? s.sha !== b.sha : (s.mtimeMs && s.mtimeMs !== b.mtimeMs);
            if (!moved) return;
            if (b.conflict && b.conflict.sha === s.sha) return;
            clearTimeout(b._dt);
            const dirty = b.ed.getDoc() !== b.saved;
            if (!dirty) {
                if (await this._reload(b, { quiet: true })) this._toast(`Reloaded ${b.name}: it changed on disk.`);
            } else {
                b.dirty = true;
                b.conflict = { sha: s.sha || null, mtimeMs: s.mtimeMs, exists: true };
                if (this._active === b.path) { this._renderStatus(); this._renderBanner(); }
            }
        } catch (_) { /* a missed poll is retried on the next tick */ } finally {
            b._statBusy = false;
        }
    }

    async _compare(b) {
        let f;
        try { f = await this._api('/api/file', { params: { path: b.path } }); } catch (e) {
            if (!e.down) this._toast(`Could not read the disk copy: ${this._errText(e)}`, 'err');
            return;
        }
        const disk = lf(f.content || ''), mine = b.ed.getDoc();
        const hs = hunks(diffLines(disk, mine));
        const body = el('div', { class: 'cp-diff-body', tabindex: '0', 'aria-label': 'Differences, disk then yours' });
        if (!hs.length) body.appendChild(el('p', { class: 'cp-muted', text: 'No differences in the text. Overwriting is safe.' }));
        let shown = 0;
        for (const h of hs) {
            body.appendChild(el('div', { class: 'cp-d-head', text: h.head }));
            for (const [t, s] of h.lines) {
                if (++shown > 6000) break;
                body.appendChild(el('div', { class: `cp-d-line ${t === '+' ? 'cp-d-add' : t === '-' ? 'cp-d-del' : 'cp-d-ctx'}` }, [
                    el('span', { class: 'cp-d-sign', 'aria-hidden': 'true', text: t }),
                    el('span', { class: 'cp-d-text', text: s || ' ' }),
                ]));
            }
            if (shown > 6000) { body.appendChild(el('p', { class: 'cp-muted', text: 'Diff truncated.' })); break; }
        }
        this._diff.replaceChildren(
            el('div', { class: 'cp-diff-legend' }, [
                el('span', { class: 'cp-d-del', text: '− on disk' }),
                el('span', { class: 'cp-d-add', text: '+ yours' }),
                el('span', { class: 'cp-spacer' }),
                el('button', { class: 'cp-btn', type: 'button', text: 'Back to editor', onclick: () => this._closeDiff() }),
            ]),
            body,
        );
        this._diffOpen = true;
        this._eds.hidden = true;
        this._diff.hidden = false;
        this._renderBanner();
        body.focus();
    }

    _closeDiff() {
        if (!this._diffOpen) return;
        this._diffOpen = false;
        this._diff.hidden = true;
        this._diff.replaceChildren();
        this._eds.hidden = false;
        const b = this._activeBuf();
        if (b) { try { b.ed.view.requestMeasure(); } catch (_) {} }
        this._renderBanner();
    }

    // In-file find is CodeMirror's own search panel. It has no exported
    // opener, so the toolbar presses its key for it.
    _findInFile() {
        const b = this._activeBuf();
        if (!b) { this._toast('Open a file first.'); return; }
        if (this._diffOpen) this._closeDiff();
        b.ed.focus();
        const ev = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: IS_MAC, ctrlKey: !IS_MAC, bubbles: true, cancelable: true });
        b.ed.view.contentDOM.dispatchEvent(ev);
        setTimeout(() => {
            const field = b.host.querySelector('.cm-search input[name="search"], .cm-search input');
            if (field) field.focus();
        }, 0);
    }

    // ── Palette: quick open + find in files ─────────────────────────────
    _openPalette(mode) {
        if (this._down) return;
        if (!this._root) { this._toast('Open a terminal tab first.'); return; }
        this._returnFocus = document.activeElement;
        const ov = this._overlay;
        const isGrep = mode === 'grep';
        const input = el('input', {
            class: 'cp-pal-in', type: 'search', spellcheck: 'false', autocomplete: 'off',
            placeholder: isGrep ? `Search text in ${basename(this._root)}` : `Go to a file in ${basename(this._root)}`,
            'aria-label': isGrep ? 'Find in files' : 'Quick open', role: 'combobox', 'aria-expanded': 'true',
            'aria-controls': 'cp-pal-list', 'aria-autocomplete': 'list',
        });
        const list = el('div', { class: 'cp-pal-list', id: 'cp-pal-list', role: 'listbox' });
        const note = el('div', { class: 'cp-pal-note', 'aria-live': 'polite' });
        const box = el('div', { class: `cp-pal${isGrep ? ' cp-pal-grep' : ''}`, role: 'dialog', 'aria-label': isGrep ? 'Find in files' : 'Quick open' }, [input, note, list]);
        ov.replaceChildren(box);
        ov.hidden = false;
        ov.onclick = (e) => { if (e.target === ov) this._closeOverlay(); };
        let sel = 0, req = 0, timer = null, shownQ = null;
        const items = () => [...list.querySelectorAll('.cp-pal-item')];
        const mark = () => {
            const all = items();
            all.forEach((n, i) => { n.classList.toggle('sel', i === sel); n.setAttribute('aria-selected', String(i === sel)); });
            const cur = all[sel];
            if (cur) { input.setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); }
        };
        const pick = (n) => {
            if (!n) return;
            const p = join(this._root, n.dataset.rel);
            this._closeOverlay({ restore: false });
            this.openFile(p, n.dataset.line ? +n.dataset.line : undefined, n.dataset.col ? +n.dataset.col : undefined);
        };
        const run = async () => {
            const q = input.value.trim();
            const id = ++req;
            if (isGrep && q.length < 2) { list.replaceChildren(); shownQ = q; note.textContent = 'Type at least two characters.'; return; }
            note.textContent = 'Searching…';
            try {
                const res = isGrep
                    ? await this._api('/api/grep', { params: { root: this._root, q, limit: 200 } })
                    : await this._api('/api/find', { params: { root: this._root, q, limit: 50 } });
                if (id !== req) return;
                const rows = [];
                let n = 0;
                if (isGrep) {
                    let cur = null;
                    for (const m of res.matches || []) {
                        if (m.file !== cur) { cur = m.file; rows.push(el('div', { class: 'cp-pal-file', role: 'presentation', text: m.file })); }
                        const text = String(m.text || '');
                        const c0 = Math.max(0, (m.col || 1) - 1);
                        const item = el('div', {
                            class: 'cp-pal-item cp-pal-hit', role: 'option', id: `cp-pal-o${n++}`,
                            'data-rel': m.file, 'data-line': m.line, 'data-col': m.col || 1,
                        }, [
                            el('span', { class: 'cp-pal-ln', text: String(m.line) }),
                            el('span', { class: 'cp-pal-tx' }, [text.slice(0, c0), el('mark', { text: text.slice(c0, c0 + q.length) }), text.slice(c0 + q.length)]),
                        ]);
                        rows.push(item);
                    }
                    const files = new Set((res.matches || []).map(m => m.file)).size;
                    note.textContent = n ? `${n} match${n === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}${res.truncated ? ', more not shown' : ''}` : 'No matches.';
                } else {
                    for (const rel of res.files || []) {
                        const i = rel.lastIndexOf('/');
                        rows.push(el('div', { class: 'cp-pal-item', role: 'option', id: `cp-pal-o${n++}`, 'data-rel': rel }, [
                            el('span', { class: 'cp-pal-base', text: rel.slice(i + 1) }),
                            el('span', { class: 'cp-pal-dir', text: i > 0 ? rel.slice(0, i) : '' }),
                        ]));
                    }
                    note.textContent = n ? (res.truncated ? 'Showing the best matches.' : '') : (q ? 'No file matches.' : 'Type to search.');
                }
                list.replaceChildren(...rows);
                shownQ = q;
                sel = 0;
                mark();
            } catch (e) {
                if (id !== req || e.down) return;
                note.textContent = this._errText(e);
            }
        };
        list.addEventListener('click', (e) => pick(e.target.closest('.cp-pal-item')));
        list.addEventListener('mousemove', (e) => {
            const n = e.target.closest('.cp-pal-item');
            if (!n) return;
            const i = items().indexOf(n);
            if (i !== sel) { sel = i; mark(); }
        });
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, isGrep ? 260 : 90); });
        input.addEventListener('keydown', (e) => {
            const all = items();
            if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(all.length - 1, sel + 1); mark(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
            else if (e.key === 'Enter') {
                e.preventDefault();
                clearTimeout(timer);
                // Enter typed faster than the debounce: search first, then take the top hit.
                if (shownQ === input.value.trim()) pick(all[sel]);
                else run().then(() => pick(items()[0]));
            }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this._closeOverlay(); }
        });
        // Seed find-in-files with the editor's current selection, the way
        // every IDE does.
        if (isGrep) {
            const b = this._activeBuf();
            try {
                const s = b && b.ed.view.state.selection.main;
                const txt = s && !s.empty ? b.ed.view.state.sliceDoc(s.from, s.to) : '';
                if (txt && !txt.includes('\n') && txt.length <= 120) input.value = txt;
            } catch (_) {}
        }
        input.focus();
        input.select();
        if (!isGrep || input.value) run();
        else note.textContent = 'Type at least two characters.';
    }

    _closeOverlay({ restore = true } = {}) {
        if (this._overlay.hidden) return;
        this._overlay.hidden = true;
        this._overlay.replaceChildren();
        const f = this._returnFocus;
        this._returnFocus = null;
        if (restore && f && f.isConnected) f.focus();
    }

    // ── Keys ────────────────────────────────────────────────────────────
    // Only while focus is inside the panel: Ctrl-P and friends belong to the
    // shell when the terminal has focus.
    _key(e) {
        if (e.defaultPrevented) return;
        const k = (e.key || '').toLowerCase();
        const mod = isMod(e);
        if (mod && !e.shiftKey && !e.altKey && k === 's') { e.preventDefault(); this.save(); return; }
        // Mod-W is reserved by most browsers outside an installed app; Alt-W is
        // the spelling that always reaches the page.
        if ((mod && !e.shiftKey && !e.altKey && k === 'w') || (e.altKey && !mod && !e.ctrlKey && (k === 'w' || e.code === 'KeyW'))) {
            if (this._active) { e.preventDefault(); this.close(); }
            return;
        }
        if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Tab') { e.preventDefault(); this._cycle(e.shiftKey ? -1 : 1); return; }
        // Ctrl-Tab never reaches a page in a browser tab (the browser keeps it),
        // so Alt-[ / Alt-] cycle too. By key position, since Option-[ types “ on a Mac.
        if (e.altKey && !mod && !e.ctrlKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
            e.preventDefault();
            this._cycle(e.code === 'BracketLeft' ? -1 : 1);
            return;
        }
        if (e.key === 'Escape') {
            if (!this._overlay.hidden) { e.preventDefault(); this._closeOverlay(); return; }
            if (this._diffOpen) { e.preventDefault(); this._closeDiff(); this._activeBuf()?.ed.focus(); return; }
            if (this.layout === 'phone' && this.root.dataset.explorer === 'on') { e.preventDefault(); this._toggleDrawer(false); }
        }
    }

    _toast(msg, kind = '') {
        const t = this._toastEl;
        t.textContent = msg;
        t.dataset.kind = kind;
        t.hidden = false;
        clearTimeout(this._toastT);
        this._toastT = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 6000 : 3200);
    }
}

const GIT_WORDS = { M: 'modified', A: 'added', D: 'deleted', '?': 'untracked', R: 'renamed' };

export function mountCodePanel(root, opts = {}) {
    const p = new CodePanel(root, opts);
    return {
        show: () => p.show(),
        hide: () => p.hide(),
        setRoot: (dir) => p.setRoot(dir),
        openFile: (path, line, col) => p.openFile(path, line, col),
        isDirty: () => p.isDirty(),
        focus: () => p.focus(),
        syncWide: () => p.syncWide(),
        destroy: () => p.destroy(),
    };
}
