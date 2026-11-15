/**
 * contextPanel — the right-hand context canvas.
 *
 * ONE canvas per Claude session, for the life of the page. The daemon returns the
 * session that owns the active tab's cwd; that id is the canvas identity. When it
 * changes the canvas REBINDS — same DOM, new subject — so a long day of switching
 * tabs never leaves a stack of stale canvases behind. Every render replaces its
 * region's children; nothing here appends.
 *
 * Four bands, in the order you need them: what you asked (prompts), where you
 * are (workspace), what you made (artifacts), what is left (next steps).
 *
 * ARTIFACTS updates itself: the daemon reads published claude.ai artifact URLs
 * out of the session's own transcript, and an agent can register one explicitly
 * (`soa-ctx artifact <url>`). When the soa-artifacts library is running the
 * band lists EVERY artifact the session recorded, and ALL opens the library: a
 * searchable index of every artifact on this machine, in the same column.
 * Same for NEXT STEPS — the canvas is a surface the
 * session's agent writes to and reads back, not just a view of chat history.
 *
 * Every edge is draggable. The panel's left border sets its width; the divider
 * above WORKSPACE and above NEXT STEPS sets that band's height, with the prompt
 * thread absorbing the slack. Sizes live in localStorage (per browser, like the
 * sidebar and panel toggles), are clamped so no drag can push a band off-panel,
 * and reset on double-click. The grips are built ONCE in _build() — renders only
 * ever replace band BODIES, so a drag survives every tick and every rebind.
 */

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

function api(base, p) {
    const u = new URL((base || '').replace(/\/+$/, '') + p, location.origin);
    const cfg = window.__SOA_WEB__ || {};
    if (cfg._resolvedToken) u.searchParams.set('t', cfg._resolvedToken);
    if (cfg._resolvedUnlock) u.searchParams.set('u', cfg._resolvedUnlock);
    return u.toString();
}

function ago(ms) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
}

// Drag limits. WIDTH_MIN keeps the mono micro-type readable; BAND_MIN keeps a
// band's header plus one row visible, so a band can be tucked away small but
// never dragged out of existence.
const WIDTH_MIN = 190, WIDTH_MAX = 720;
const BAND_MIN = 42;
const LS_WIDTH = 'soa_ctx_w', LS_BANDS = 'soa_ctx_bands';
// The panel's top-level view (Context canvas | Code editor) and the code view's
// Widen state. Per device, like every other panel preference.
const LS_VIEW = 'soa_ctx_view', LS_CODE_WIDE = 'soa_code_wide';
// Widen gives the code view about this much of the window.
const WIDE_FRAC = 0.6;
const CODE_PANEL_URL = '/assets/codePanel.js?v=code-20261106b';
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const KEY_STEP = 8;

function lsGet(k, fallback) {
    try { const v = localStorage.getItem(k); return v == null ? fallback : v; } catch (_) { return fallback; }
}
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (_) {} }
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// <html data-sides="swapped"> (panel left, sidebar right) and "left" (panel
// beside the sidebar) both put this panel on the LEFT of the terminal.
const panelOnLeft = () => {
    const s = document.documentElement.dataset.sides;
    return s === 'swapped' || s === 'left';
};

// The artifact library is scripts/soa-artifacts, a loopback service reached
// through the daemon's /preview/6085/ proxy (the same door soa-health uses on
// 6084). It indexes every transcript, so it sees what /api/context cannot: every
// artifact a session ever published, opened or registered, not just the newest
// twenty. It is optional — when it is not running the band falls back to the
// daemon's own list without saying anything.
const ARTS_PREFIX = '/preview/6085';
const ARTS_POLL_MS = 20000;
const ARTS_TIMEOUT_MS = 6000;
// Not running is the normal state of an install that never started it, and
// every failed fetch is a red line in the console: after one, the band leaves
// the library alone this long (opening the library still asks at once).
const ARTS_DOWN_MS = 300000;
const LIB_LIMIT = 500;

function sameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (_) { return true; }
}

const DAY_MS = 86400000;
function dayLabel(ms) {
    const d = new Date(ms);
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const t = start.getTime();
    if (ms >= t) return 'Today';
    if (ms >= t - DAY_MS) return 'Yesterday';
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== start.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
}

// Only a claude.ai link is ever an artifact. Both lists come from outside this
// page (a transcript, a loopback service), so anything else — javascript:,
// data:, another host — is dropped before it can become an href or a copy.
function artUrl(u) {
    if (typeof u !== 'string' || u.length > 2048) return null;
    try {
        const x = new URL(u);
        return x.protocol === 'https:' && x.hostname === 'claude.ai' && !x.username && !x.password ? x.href : null;
    } catch (_) { return null; }
}

// The two real id shapes (a v4 UUID, or a 21–22 character base58 id) — the same
// test scripts/soa-artifacts applies.
const REAL_ART_ID = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|[1-9A-HJ-NP-Za-km-z]{21,22})$/;

function artTitle(a) {
    return a.title || a.description || `artifact ${String(a.id || '').slice(0, 8)}`;
}

async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    // The clipboard API needs a secure context and focus; the paired desktop on
    // a LAN http:// origin has neither, so fall back to the old selection copy.
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

const STATUS_CYCLE = { pending: 'in_progress', in_progress: 'completed', completed: 'pending' };
const STATUS_MARK = { pending: '○', in_progress: '◐', completed: '●' };

class ContextCanvas {
    constructor(root, ctx) {
        this.root = root;
        this.backend = ctx.backend || '';
        this.token = ctx.token || '';
        this.unlock = ctx.unlock || '';
        // Opens the panel when it is tucked away (the Code shortcut needs it).
        this.showPanel = ctx.showPanel || (() => {});
        this._view = lsGet(LS_VIEW, 'context') === 'code' ? 'code' : 'context';
        this._codeWide = lsGet(LS_CODE_WIDE, '0') === '1';
        this.getCwd = ctx.getCwd || (() => null);
        this.getTabId = ctx.getTabId || (() => null);
        this.queue = [];
        this.queueGate = null;
        this.sessionId = null;
        this.steps = [];
        this._pinned = true;
        // Called after any size change so the terminal grid can re-fit into the
        // width the panel just gave back (or took).
        this.onResize = ctx.onResize || (() => {});
        this._bands = {};
        this._applyWidth({ fit: false });
        this._build();
        this._applySavedBands();
        this._wireCodeKeys();
        this._timer = setInterval(() => this.tick(), 2500);
        this.tick();
    }

    _build() {
        this._sub = el('span', { class: 'ctx-sub', text: 'no session' });
        this._turns = el('span', { class: 'ctx-turns', text: '' });
        const head = el('header', { class: 'ctx-head' }, [
            el('span', { class: 'ctx-brand', text: 'CONTEXT' }),
            this._turns,
        ]);

        this._thread = el('div', { class: 'ctx-thread' });
        // Pin to newest unless the reader has deliberately scrolled back.
        this._thread.addEventListener('scroll', () => {
            const d = this._thread.scrollHeight - this._thread.scrollTop - this._thread.clientHeight;
            this._pinned = d < 40;
        });

        this._facts = el('div', { class: 'ctx-facts' });
        this._arts = el('div', { class: 'ctx-arts' });
        this._stepList = el('div', { class: 'ctx-steps' });
        this._stepInput = el('input', {
            class: 'ctx-step-add', type: 'text', placeholder: 'add a next step',
            onkeydown: (e) => {
                if (e.key !== 'Enter') return;
                const text = e.target.value.trim();
                if (!text) return;
                e.target.value = '';
                this.steps = this.steps.concat([{ text, status: 'pending' }]);
                this._renderSteps();
                this._saveSteps();
            },
        });

        this._factsBand = el('div', { class: 'ctx-band ctx-band-facts' }, [
            this._bandGrip('facts', 'WORKSPACE'),
            el('div', { class: 'ctx-band-h' }, [el('span', { text: 'WORKSPACE' })]),
            this._facts,
        ]);
        this._artsCount = el('span', { class: 'ctx-sub ctx-arts-n', text: '' });
        this._artsAll = el('button', {
            class: 'ctx-arts-all', type: 'button', text: 'ALL ›',
            title: 'All artifacts', 'aria-label': 'All artifacts: open the artifact library',
            onclick: () => this.openLibrary(),
        });
        this._artsBand = el('div', { class: 'ctx-band ctx-band-arts' }, [
            this._bandGrip('arts', 'ARTIFACTS'),
            el('div', { class: 'ctx-band-h' }, [
                el('span', { text: 'ARTIFACTS' }),
                el('span', { class: 'ctx-arts-hr' }, [this._artsCount, this._artsAll]),
            ]),
            this._arts,
        ]);
        this._ctxArts = [];       // the daemon's list, from /api/context
        this._svcArts = null;     // the library's list for this session; null = unreachable
        this._artsKey = null;     // which session/cwd _svcArts belongs to
        this._artsAt = 0;
        this._artsSig = '';
        // QUEUE — what you have lined up for THIS agent's next turn.
        //
        // The terminal takes your typing immediately, which is the problem: mid
        // turn it goes into Claude Code's own buffer, where a permission dialog
        // can eat the Enter as an answer and a reload loses it. Written here it
        // is held by the daemon and delivered when the agent is actually back at
        // its input box.
        this._queueList = el('div', { class: 'ctx-queue' });
        this._effortSelect = el('select', { class: 'ctx-queue-effort', 'aria-label': 'Effort for the next task' },
            [['auto', 'Auto effort'], ['medium', 'Medium'], ['high', 'High'], ['max', 'Max'], ['inherit', 'Session default']]
                .map(([value, text]) => el('option', { value, text })));
        Object.assign(this._effortSelect.style, { color: 'inherit', background: 'var(--panel-bg, #24272c)', border: '1px solid var(--border, #555)', borderRadius: '6px', padding: '4px 8px', maxWidth: '100%' });
        this._effortSelect.disabled = true;
        this._queueInput = el('textarea', {
            class: 'ctx-queue-add', rows: '1', placeholder: 'queue a message for the next turn',
            onkeydown: (e) => {
                // Enter sends, Shift+Enter makes a new line — the same contract
                // as every composer, and these messages are often multi-line.
                if (e.key !== 'Enter' || e.shiftKey) return;
                e.preventDefault();
                const text = e.target.value.trim();
                if (!text) return;
                e.target.value = '';
                e.target.style.height = '';
                this._queueAdd(text);
            },
            oninput: (e) => {
                // Grow with the message rather than hiding it behind a scrollbar.
                e.target.style.height = '';
                e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px';
            },
        });
        this._queueBand = el('div', { class: 'ctx-band ctx-band-queue' }, [
            this._bandGrip('queue', 'QUEUE'),
            el('div', { class: 'ctx-band-h' }, [
                el('span', { text: 'QUEUE' }),
                this._queueWhy = el('span', { class: 'ctx-sub' }),
            ]),
            this._queueList,
            this._effortSelect,
            this._queueInput,
            el('button', { class: 'ctx-link', text: 'Full conversation', onclick: () => this._openConversation() }),
        ]);

        this._stepsBand = el('div', { class: 'ctx-band ctx-band-steps' }, [
            this._bandGrip('steps', 'NEXT STEPS'),
            el('div', { class: 'ctx-band-h' }, [el('span', { text: 'NEXT STEPS' })]),
            this._stepList,
            this._stepInput,
        ]);
        this._threadBand = el('div', { class: 'ctx-band ctx-band-thread' }, [
            el('div', { class: 'ctx-band-h' }, [el('span', { text: 'PROMPTS' }), this._sub]),
            this._thread,
        ]);

        // The panel's top-level switch: the session canvas, or the code editor.
        // A segmented pair above the canvas header, so the canvas keeps its
        // own layout untouched underneath Context.
        this._viewBtns = {};
        const viewBtn = (key, label, hint) => {
            const b = el('button', {
                class: 'ctx-view-btn', type: 'button', role: 'tab', text: label,
                'aria-selected': 'false', title: hint,
                onclick: () => this.setView(key, { focus: key === 'code' }),
            });
            this._viewBtns[key] = b;
            return b;
        };
        const views = el('div', { class: 'ctx-views', role: 'tablist', 'aria-label': 'Side panel view' }, [
            viewBtn('context', 'Context', 'Session context'),
            viewBtn('code', 'Code', `View and edit files (${IS_MAC ? '⌘⇧E' : 'Ctrl+Shift+E'})`),
        ]);
        views.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            // Bare arrows also switch terminal tabs at the window level.
            e.stopPropagation();
            const next = this._view === 'code' ? 'context' : 'code';
            this.setView(next);
            this._viewBtns[next].focus();
        });
        this._codeRoot = el('div', { class: 'ctx-mode ctx-mode-code', hidden: '' });
        ensureViewStyle();

        // The bands live in a wrapper so the LIBRARY can take the column
        // without touching the band machinery — same flex column, same scroll.
        this._canvasWrap = el('div', { class: 'ctx-mode ctx-mode-canvas' }, [
            this._threadBand,
            this._queueBand,
            this._factsBand,
            this._artsBand,
            this._stepsBand,
        ]);
        // LIBRARY is a drill-in of the canvas: it is reached from the ARTIFACTS
        // band and its Back returns there.
        this._libRoot = this._buildLibrary();
        this._libOpen = false;

        this.root.replaceChildren(
            this._widthGrip(),
            views,
            head,
            this._canvasWrap,
            this._libRoot,
            this._codeRoot,
        );
        this.setView(this._view, { save: false });
    }

    // ── Context | Code ──────────────────────────────────────────────────────
    // Code hides the canvas header and every band by class (CSS), so nothing
    // the canvas does while parked can leak through.
    setView(key, { save = true, focus = false } = {}) {
        if (key !== 'code') key = 'context';
        const prev = this._view;
        this._view = key;
        const code = key === 'code';
        for (const [k, b] of Object.entries(this._viewBtns)) {
            b.classList.toggle('active', k === key);
            b.setAttribute('aria-selected', String(k === key));
            b.tabIndex = k === key ? 0 : -1;
        }
        this.root.classList.toggle('ctx-code', code);
        this._codeRoot.hidden = !code;
        if (save) lsSet(LS_VIEW, key);
        if (code) {
            this._mountCode().then((p) => {
                if (!p || this._view !== 'code') return;
                p.show();
                if (focus) setTimeout(() => p.focus(), 0);
            });
        } else {
            if (this._code) this._code.hide();
            if (prev === 'code') this.tick();
        }
        if (prev !== key) this._applyWidth();
    }

    openCode() {
        this.showPanel();
        this.setView('code', { focus: true });
    }

    _mountCode() {
        if (this._codeP) return this._codeP;
        this._codeP = import(CODE_PANEL_URL).then((m) => {
            this._code = m.mountCodePanel(this._codeRoot, {
                backend: this.backend,
                token: this.token,
                unlock: this.unlock,
                getCwd: () => this.getCwd(),
                layout: 'side',
                isWide: () => this._codeWide,
                onRequestWide: (on) => this.setCodeWide(on),
            });
            return this._code;
        }).catch((err) => {
            console.warn('[code] panel failed to load', err);
            this._codeP = null;
            this._codeRoot.replaceChildren(el('p', { class: 'ctx-muted', text: 'The code view failed to load. Reload the page to try again.' }));
            return null;
        });
        return this._codeP;
    }

    // Mod-Shift-E from anywhere, the terminal included. Capture phase on
    // window, so xterm never sees it as input.
    _wireCodeKeys() {
        window.addEventListener('keydown', (e) => {
            const mod = IS_MAC ? e.metaKey : e.ctrlKey;
            if (!mod || !e.shiftKey || e.altKey) return;
            if ((e.key || '').toLowerCase() !== 'e' && e.code !== 'KeyE') return;
            e.preventDefault();
            e.stopPropagation();
            this.openCode();
        }, true);
        // A widened panel tracks the window, so 60% stays 60%.
        let raf = 0;
        const rewiden = () => {
            if (this._view !== 'code' || !this._codeWide || raf) return;
            raf = requestAnimationFrame(() => { raf = 0; this._applyWidth({ fit: false }); });
        };
        window.addEventListener('resize', rewiden);
        // Beside the sidebar the room Widen measures changes with the layout
        // and with the sidebar, so it follows both.
        if (typeof MutationObserver === 'function') {
            new MutationObserver(rewiden).observe(document.documentElement, { attributes: true, attributeFilter: ['data-sides'] });
            const stage = this.root.closest('.stage');
            if (stage) new MutationObserver(rewiden).observe(stage, { attributes: true, attributeFilter: ['class'] });
        }
    }

    setCodeWide(on) {
        this._codeWide = !!on;
        lsSet(LS_CODE_WIDE, this._codeWide ? '1' : '0');
        this._applyWidth();
        if (this._code) this._code.syncWide();
    }

    // ── Drag machinery ──────────────────────────────────────────────────────
    // One pointer-capture drag for both axes: capture means the pointer keeps
    // reporting to the grip even when it leaves the 7px hit strip, so a fast
    // drag can't "slip off" the handle mid-gesture.
    _drag(grip, onStart, onMove, onReset) {
        grip.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const start = onStart(e);
            // Capture keeps a fast drag glued to the handle; it can throw when the
            // pointer isn't active (synthetic events, exotic input), and the window
            // listeners below are what actually make the drag work either way.
            try { grip.setPointerCapture(e.pointerId); } catch (_) {}
            grip.classList.add('dragging');
            document.body.classList.add('ctx-resizing');
            const move = (ev) => onMove(ev, start);
            const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                window.removeEventListener('pointercancel', up);
                window.removeEventListener('blur', up);
                grip.classList.remove('dragging');
                document.body.classList.remove('ctx-resizing');
                this.onResize();
            };
            // On window, not the grip: a drag that outruns the 7px strip (or ends
            // outside the viewport, or loses focus) must still land its pointerup,
            // otherwise the panel stays stuck in resize mode.
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
            window.addEventListener('pointercancel', up);
            window.addEventListener('blur', up);
        });
        // A handle you can't undo is a trap: double-click restores the default.
        grip.addEventListener('dblclick', (e) => { e.preventDefault(); onReset(); this.onResize(); });
    }

    _widthGrip() {
        const grip = el('div', {
            class: 'ctx-grip ctx-grip-w', role: 'separator', tabindex: '0',
            'aria-orientation': 'vertical', 'aria-label': 'Resize context canvas width',
            title: 'Drag to resize · double-click to reset',
        });
        const width = () => this.root.getBoundingClientRect().width;
        const setW = (w) => {
            const px = clamp(Math.round(w), WIDTH_MIN, this._maxW());
            document.documentElement.style.setProperty('--soa-ctx-w', px + 'px');
            lsSet(LS_WIDTH, String(px));
            // A hand-set width replaces Widen; the button follows.
            if (this._codeWide && this._view === 'code') this._dropWide();
        };
        this._drag(grip,
            (e) => ({ x: e.clientX, w: width() }),
            // On the RIGHT (standard) dragging left grows the panel; in the
            // swapped and both-left layouts it sits on the LEFT, so dragging
            // right, toward the terminal, grows it.
            (ev, s) => { setW(s.w + (panelOnLeft() ? ev.clientX - s.x : s.x - ev.clientX)); this.onResize(); },
            () => { this._dropWide(); document.documentElement.style.removeProperty('--soa-ctx-w'); lsDel(LS_WIDTH); },
        );
        grip.addEventListener('keydown', (e) => {
            // The arrow pointing the way the drag widens it widens the panel.
            const grow = panelOnLeft() ? 'ArrowRight' : 'ArrowLeft';
            const shrink = panelOnLeft() ? 'ArrowLeft' : 'ArrowRight';
            const d = e.key === grow ? KEY_STEP : e.key === shrink ? -KEY_STEP : 0;
            if (!d) return;
            e.preventDefault();
            setW(width() + d);
            this.onResize();
        });
        return grip;
    }

    _bandGrip(key, label) {
        const grip = el('div', {
            class: 'ctx-grip ctx-grip-h', role: 'separator', tabindex: '0',
            'aria-orientation': 'horizontal', 'aria-label': `Resize ${label} band`,
            title: 'Drag to resize · double-click to reset',
        });
        const band = () => grip.parentElement;
        const setH = (h) => {
            const b = band();
            if (!b) return;
            // Never let a band grow past what the panel can give the thread.
            const room = this.root.clientHeight - 120;
            const px = clamp(Math.round(h), BAND_MIN, Math.max(BAND_MIN, room));
            b.style.flex = `0 0 ${px}px`;
            this._bands[key] = px;
            lsSet(LS_BANDS, JSON.stringify(this._bands));
        };
        this._drag(grip,
            (e) => ({ y: e.clientY, h: band().getBoundingClientRect().height }),
            // The grip sits on the band's TOP edge: dragging up grows it.
            (ev, s) => setH(s.h + (s.y - ev.clientY)),
            () => {
                const b = band();
                if (b) b.style.flex = '';
                delete this._bands[key];
                lsSet(LS_BANDS, JSON.stringify(this._bands));
            },
        );
        grip.addEventListener('keydown', (e) => {
            const d = e.key === 'ArrowUp' ? KEY_STEP : e.key === 'ArrowDown' ? -KEY_STEP : 0;
            if (!d) return;
            e.preventDefault();
            setH(band().getBoundingClientRect().height + d);
        });
        return grip;
    }

    // The canvas tops out at WIDTH_MAX; the code view may take up to WIDE_FRAC
    // of the window, by drag or by Widen.
    _maxW() {
        // Measured from the panel's own position: beside the sidebar (both
        // left) it shares the window with the sidebar column, so the fraction
        // is of what is left past it. A slide-over sidebar (phone widths) or a
        // hidden one takes no room.
        let room = window.innerWidth;
        if (document.documentElement.dataset.sides === 'left' && window.innerWidth > 768) {
            const stage = this.root.closest('.stage');
            const side = stage && !stage.classList.contains('no-sidebar') ? stage.querySelector('.sidebar') : null;
            if (side) room -= side.getBoundingClientRect().width;
        }
        const frac = Math.round(room * WIDE_FRAC);
        return this._view === 'code' ? Math.max(WIDTH_MIN, frac) : Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, frac));
    }

    // One place decides the panel width: Widen (code view only, never saved as
    // the hand-set width) or the saved drag width clamped to the current view.
    _applyWidth({ fit = true } = {}) {
        const rs = document.documentElement.style;
        if (this._view === 'code' && this._codeWide) {
            rs.setProperty('--soa-ctx-w', this._maxW() + 'px');
        } else {
            const w = parseInt(lsGet(LS_WIDTH, ''), 10);
            if (Number.isFinite(w) && w >= WIDTH_MIN) rs.setProperty('--soa-ctx-w', clamp(w, WIDTH_MIN, this._maxW()) + 'px');
            else rs.removeProperty('--soa-ctx-w');
        }
        if (fit) this.onResize();
    }

    _dropWide() {
        if (!this._codeWide) return;
        this._codeWide = false;
        lsSet(LS_CODE_WIDE, '0');
        if (this._code) this._code.syncWide();
    }

    _applySavedBands() {
        let saved = {};
        try { saved = JSON.parse(lsGet(LS_BANDS, '{}')) || {}; } catch (_) { saved = {}; }
        const targets = { facts: this._factsBand, arts: this._artsBand, steps: this._stepsBand };
        for (const [k, band] of Object.entries(targets)) {
            const px = parseInt(saved[k], 10);
            if (!Number.isFinite(px) || px < BAND_MIN) continue;
            band.style.flex = `0 0 ${px}px`;
            this._bands[k] = px;
        }
    }

    async tick() {
        if (this.root.closest('.stage')?.classList.contains('no-context')) return;
        if (document.hidden) return;
        // The poll feeds the canvas bands; parked behind Code it would paint
        // into hidden nodes every 2.5s for nothing. Switching back repaints.
        if (this._view === 'code') return;
        if (this._libOpen) {
            // A tab switch moves "This project" with it; otherwise a light poll.
            const cwd = this.getCwd();
            if (cwd !== this._libCwd) { this._libSyncChips(); this._libFetch(); }
            else if (Date.now() - this._libAt >= ARTS_POLL_MS) this._libFetch({ quiet: true });
            return;
        }
        // Task delivery is shared by both CLIs; it must not depend on the
        // Claude context endpoint being available for this workspace.
        this._queueFetch();
        const cwd = this.getCwd();
        if (!cwd) { this._empty('open a tab to see its context'); return; }
        try {
            const r = await fetch(api(this.backend, `/api/context?cwd=${encodeURIComponent(cwd)}`), {
                credentials: 'include', cache: 'no-store',
            });
            if (!r.ok) throw new Error(`${r.status}`);
            const { data } = await r.json();
            this.render(data);
        } catch (e) {
            this._empty(`context unavailable (${e.message})`);
        }
    }

    // The rebind: a different session takes over the SAME canvas.
    render(d) {
        if (d.sessionId !== this.sessionId) {
            this.sessionId = d.sessionId;
            this.steps = [];
            this._pinned = true;
        }
        if (!Array.isArray(this.steps) || !this.steps.length) this.steps = (d.nextSteps || []).map(s => ({ ...s }));

        this._sub.textContent = d.sessionId ? d.sessionId.slice(0, 8) : 'no session';
        this._turns.textContent = d.prompts.length ? `${d.prompts.length} turns · ${ago(d.lastActivity)}` : '';
        this._renderThread(d.prompts || []);
        this._renderFacts(d.workspace || {}, d);
        this._ctxArts = d.artifacts || [];
        this._artsMaybeFetch(d.sessionId, (d.workspace && d.workspace.cwd) || this.getCwd());
        this._renderArtifacts();
        this._renderSteps();
    }

    // A turn is keyed by when it was sent, not by its position: the thread grows
    // from the bottom, so an index would move every prompt's identity down one
    // on the next poll and an expanded turn would collapse itself.
    _turnKey(p, i) { return String(p.at || '') + ':' + i + ':' + (p.text || '').length; }

    _renderThread(prompts) {
        if (!prompts.length) {
            this._thread.replaceChildren(el('p', { class: 'ctx-muted', text: 'no prompts recorded for this workspace yet' }));
            return;
        }
        if (!this._open) this._open = new Set();
        const last = prompts.length - 1;
        this._thread.replaceChildren(...prompts.map((p, i) => {
            const key = this._turnKey(p, i);
            const more = el('button', {
                class: 'ctx-turn-more', type: 'button', hidden: '',
                title: 'Show the whole prompt', 'aria-label': 'Show the whole prompt',
            });
            const node = el('article', {
                class: 'ctx-turn' + (i === last ? ' latest' : '') + (this._open.has(key) ? ' open' : ''),
            }, [
                el('div', { class: 'ctx-turn-m' }, [
                    el('span', { class: 'ctx-turn-n', text: String(i + 1) }),
                    el('span', { class: 'ctx-turn-t', text: ago(p.at) }),
                    more,
                ]),
                el('p', { class: 'ctx-turn-x', text: p.text }),
            ]);
            node.dataset.key = key;
            more.addEventListener('click', () => {
                const open = node.classList.toggle('open');
                if (open) this._open.add(key); else this._open.delete(key);
                const label = open ? 'Collapse this prompt' : 'Show the whole prompt';
                more.title = label;
                more.setAttribute('aria-label', label);
                if (!open) this._markClipped();
            });
            return node;
        }));
        // Which turns are actually CUT can only be known once they are laid out,
        // and asking costs a forced layout — so ask once per render, after the
        // subtree is in place, and only for turns that are not already open.
        this._markClipped();
        if (this._pinned) this._thread.scrollTop = this._thread.scrollHeight;
    }

    // Show the toggle only where there is something behind the fade. A prompt
    // that fits gets no affordance at all, which is why the column still reads
    // as a thread and not as a list of controls.
    _markClipped() {
        for (const node of this._thread.querySelectorAll('.ctx-turn')) {
            const x = node.querySelector('.ctx-turn-x');
            const more = node.querySelector('.ctx-turn-more');
            if (!x || !more) continue;
            const cut = !node.classList.contains('open') && x.scrollHeight > x.clientHeight + 2;
            node.classList.toggle('clipped', cut);
            more.hidden = !(cut || node.classList.contains('open'));
        }
    }

    _renderFacts(w, d) {
        const rows = [
            ['dir', w.name || '—'],
            ['branch', w.branch || 'detached'],
            ['session', d.sessionId ? d.sessionId.slice(0, 8) : '—'],
            ['path', w.cwd || '—'],
        ];
        this._facts.replaceChildren(...rows.map(([k, v]) => el('div', { class: 'ctx-fact' }, [
            el('span', { class: 'ctx-fact-k', text: k }),
            el('span', { class: 'ctx-fact-v', title: v, text: v }),
        ])));
    }

    // ── ARTIFACTS ─────────────────────────────────────────────────────────
    _artsUrl(path) { return api(this.backend, ARTS_PREFIX + path); }

    // One GET against the library. Anything that is not its JSON — the proxy's
    // 502 page when nothing listens, a pairing 401, a timeout — is a throw, and
    // every caller treats a throw as "the library is not here".
    async _artsGet(path) {
        const url = this._artsUrl(path);
        const headers = {};
        // Cross-origin (a paired desktop on another origin → the Mac's tunnel):
        // ngrok's free tier answers a browser request with an HTML warning page
        // unless this header is present; the daemon's CORS preflight allows it.
        if (!sameOrigin(url)) headers['ngrok-skip-browser-warning'] = '1';
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), ARTS_TIMEOUT_MS);
        try {
            const r = await fetch(url, { credentials: 'include', cache: 'no-store', headers, signal: ac.signal });
            if (!/json/i.test(r.headers.get('content-type') || '')) throw new Error(r.ok ? 'unexpected reply' : String(r.status));
            const j = await r.json();
            if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || String(r.status));
            return j;
        } finally { clearTimeout(timer); }
    }

    // The band follows the session: a new session (or tab) fetches at once,
    // otherwise every ARTS_POLL_MS. tick() already stands down while the panel
    // is closed or the page is hidden.
    _artsMaybeFetch(sessionId, cwd) {
        const key = sessionId ? 's:' + sessionId : (cwd ? 'c:' + cwd : null);
        const tab = this.getTabId();
        const changed = key !== this._artsKey || tab !== this._artsTab;
        if (!changed && (this._artsBusy || Date.now() - this._artsAt < ARTS_POLL_MS)) return;
        if (key !== this._artsKey) { this._svcArts = null; this._artsSig = ''; }
        this._artsKey = key;
        this._artsTab = tab;
        this._artsAt = Date.now();
        if (!key) return;
        if (Date.now() < (this._artsDownUntil || 0)) { this._svcArts = null; return; }
        const q = sessionId ? `session=${encodeURIComponent(sessionId)}` : `cwd=${encodeURIComponent(cwd)}`;
        this._artsBusy = true;
        this._artsGet(`/artifacts?${q}&limit=${LIB_LIMIT}`).then(j => {
            if (this._artsKey !== key) return;   // the user moved on mid-flight
            this._artsDownUntil = 0;
            this._svcArts = Array.isArray(j.artifacts) ? j.artifacts : [];
            this._renderArtifacts();
        }).catch(() => {
            this._artsDownUntil = Date.now() + ARTS_DOWN_MS;
            if (this._artsKey !== key) return;
            this._svcArts = null;               // silent: the daemon's list stands
            this._renderArtifacts();
        }).finally(() => { this._artsBusy = false; });
    }

    // The library's list merged with the daemon's, one row per id, newest
    // first: the thing you just made is the thing you want to open.
    _artsMerged() {
        const byId = new Map();
        for (const a of this._svcArts || []) {
            if (!a || !a.id || a.deleted || !artUrl(a.url)) continue;
            byId.set(a.id, { id: a.id, url: artUrl(a.url), title: a.title, description: a.description, kind: a.kind || 'published', at: a.lastAt || 0 });
        }
        for (const a of this._ctxArts || []) {
            if (!a || !a.id || !artUrl(a.url)) continue;
            // With the library up, its parser is the stricter one: the daemon's
            // scan also catches ids a truncated tool output cut short
            // (…/artifact/4f3a9b1), which the library rightly ignores.
            if (this._svcArts && !REAL_ART_ID.test(a.id)) continue;
            const id = a.id.includes('-') ? a.id.toLowerCase() : a.id;   // the library lowercases UUIDs
            const have = byId.get(id);
            // A deleted one the library knows about stays gone.
            if ((this._svcArts || []).some(s => s && s.id === id && s.deleted)) continue;
            if (have) {
                if (!have.title && a.title) have.title = a.title;
                if (a.at && a.at > have.at) have.at = a.at;
            } else {
                byId.set(id, { id, url: artUrl(a.url), title: a.title, kind: 'published', at: a.at || 0 });
            }
        }
        return [...byId.values()].sort((x, y) => (y.at || 0) - (x.at || 0));
    }

    _copyBtn(url, cls) {
        const label = 'Copy link';
        const b = el('button', { class: cls, type: 'button', text: 'COPY', title: url, 'aria-label': label });
        b.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const ok = await copyText(url);
            b.textContent = ok ? 'COPIED' : 'FAILED';
            b.setAttribute('aria-label', ok ? 'Link copied' : 'Copy failed');
            clearTimeout(b._t);
            b._t = setTimeout(() => { b.textContent = 'COPY'; b.setAttribute('aria-label', label); }, 1400);
        });
        return b;
    }

    _renderArtifacts() {
        const list = this._artsMerged();
        this._artsCount.textContent = list.length ? String(list.length) : '';
        // The poll runs every 2.5 s; repainting identical rows would steal focus
        // from a keyboard user sitting on a Copy button and reset "COPIED".
        const sig = list.map(a => `${a.id}|${a.at}|${a.title || ''}|${a.kind}`).join('\n');
        if (sig === this._artsSig && this._arts.childElementCount) return;
        this._artsSig = sig;
        if (!list.length) {
            this._arts.replaceChildren(el('p', { class: 'ctx-muted', text: 'nothing published yet' }));
            return;
        }
        this._arts.replaceChildren(...list.map(a => el('div', { class: 'ctx-art' }, [
            el('a', {
                class: 'ctx-art-a', href: a.url, target: '_blank', rel: 'noopener noreferrer',
                title: a.url, 'aria-label': `Open ${artTitle(a)} in a new tab`,
            }, [
                el('span', { class: 'ctx-art-x', text: artTitle(a) }),
                a.kind && a.kind !== 'published' ? el('span', { class: 'ctx-art-k', text: a.kind }) : null,
            ]),
            el('span', { class: 'ctx-art-t', text: a.at ? ago(a.at) : '' }),
            this._copyBtn(a.url, 'ctx-art-copy'),
        ])));
    }

    // ── LIBRARY ───────────────────────────────────────────────────────────
    // Every artifact on this machine, searchable, in the same column. The
    // server does the matching (q=) so a search covers the whole index, not
    // just what happens to be loaded.
    _buildLibrary() {
        this._libScope = 'project';
        this._libDeleted = false;
        this._libAt = 0;
        this._libSeq = 0;
        this._libSig = '';
        this._libBack = el('button', {
            class: 'np-tool np-back', type: 'button', text: '‹ CANVAS',
            'aria-label': 'Back to the canvas', onclick: () => this.closeLibrary(),
        });
        this._libN = el('span', { class: 'ctx-sub', text: '' });
        this._libQ = el('input', {
            class: 'np-search ctx-lib-q', type: 'search', placeholder: 'search title, project, link',
            'aria-label': 'Search artifacts', autocomplete: 'off', spellcheck: 'false',
        });
        this._libQ.addEventListener('input', () => {
            clearTimeout(this._libDebounce);
            this._libDebounce = setTimeout(() => this._libFetch(), 250);
        });
        const chip = (key, text) => {
            const b = el('button', { class: 'ctx-lib-chip', type: 'button', text, 'aria-pressed': 'false' });
            b.addEventListener('click', () => {
                if (key === 'deleted') this._libDeleted = !this._libDeleted;
                else this._libScope = key;
                this._libSyncChips();
                this._libFetch();
            });
            return b;
        };
        this._libChips = {
            project: chip('project', 'This project'),
            all: chip('all', 'All sessions'),
            deleted: chip('deleted', 'Show deleted'),
        };
        this._libStatus = el('p', { class: 'ctx-lib-status', role: 'status', 'aria-live': 'polite' });
        this._libList = el('div', { class: 'np-list ctx-lib-list', role: 'list', 'aria-label': 'Artifacts' });
        const root = el('div', {
            class: 'ctx-mode ctx-mode-lib', hidden: '', role: 'region', 'aria-label': 'Artifact library',
        }, [
            el('div', { class: 'np-bar ctx-lib-bar' }, [
                this._libBack,
                el('span', { class: 'ctx-lib-h', text: 'ARTIFACTS' }),
                this._libN,
            ]),
            el('div', { class: 'ctx-lib-tools' }, [
                this._libQ,
                el('div', { class: 'ctx-lib-chips', role: 'group', 'aria-label': 'Which artifacts' }, [
                    this._libChips.project, this._libChips.all, this._libChips.deleted,
                ]),
            ]),
            this._libStatus,
            this._libList,
        ]);
        // Include the view switch: returning from Code leaves focus there.
        this.root.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !this._libOpen || this._view === 'code') return;
            e.preventDefault();
            e.stopPropagation();
            this.closeLibrary();
        });
        return root;
    }

    _libSyncChips() {
        const hasCwd = !!this.getCwd();
        if (!hasCwd && this._libScope === 'project') this._libScope = 'all';
        this._libChips.project.disabled = !hasCwd;
        this._libChips.project.setAttribute('aria-pressed', String(this._libScope === 'project'));
        this._libChips.all.setAttribute('aria-pressed', String(this._libScope === 'all'));
        this._libChips.deleted.setAttribute('aria-pressed', String(this._libDeleted));
    }

    openLibrary() {
        this._libOpen = true;
        this._canvasWrap.hidden = true;
        this._libRoot.hidden = false;
        this._libSyncChips();
        this._libSig = '';
        this._libFetch();
        this._libQ.focus();
    }

    closeLibrary() {
        if (!this._libOpen) return;
        this._libOpen = false;
        this._libRoot.hidden = true;
        this._canvasWrap.hidden = false;
        clearTimeout(this._libDebounce);
        this._artsAll.focus();
        this.tick();
    }

    async _libFetch({ quiet = false } = {}) {
        const seq = ++this._libSeq;
        this._libAt = Date.now();
        const params = new URLSearchParams({ limit: String(LIB_LIMIT) });
        const q = this._libQ.value.trim();
        if (q) params.set('q', q);
        const cwd = this.getCwd();
        this._libCwd = cwd;
        if (this._libScope === 'project' && cwd) params.set('cwd', cwd);
        if (!quiet && !this._libList.childElementCount) this._libStatus.textContent = 'Loading…';
        try {
            const j = await this._artsGet(`/artifacts?${params}`);
            if (seq !== this._libSeq) return;      // a newer query won
            if (this._artsDownUntil) { this._artsDownUntil = 0; this._artsAt = 0; }
            this._renderLibrary(j, q);
        } catch (_) {
            if (seq !== this._libSeq) return;
            this._libSig = '';
            this._libN.textContent = '';
            this._libStatus.textContent = '';
            this._libList.replaceChildren(el('p', { class: 'ctx-muted ctx-lib-empty', text:
                'The artifact library is not running on this computer, so only this session’s artifacts are listed on the canvas. Start it with: soa-artifacts serve' }));
        }
    }

    _renderLibrary(j, q) {
        const all = (Array.isArray(j.artifacts) ? j.artifacts : [])
            .filter(a => a && a.id && artUrl(a.url))
            .map(a => ({ ...a, url: artUrl(a.url) }));
        const list = (this._libDeleted ? all : all.filter(a => !a.deleted))
            .slice().sort((x, y) => (y.lastAt || 0) - (x.lastAt || 0));
        const hidden = all.length - list.length;
        this._libN.textContent = list.length ? String(list.length) : '';
        let status = '';
        if (j.scanning) status = 'Still reading transcripts — more may appear.';
        else if (hidden) status = `${hidden} deleted hidden.`;
        // Same-data repaint guard as the band: the 20 s poll must not drop focus.
        // Scope and query lead it so an empty list still paints its message.
        const sig = `${this._libScope}|${q}|${j.scanning ? 'S' : ''}\n` + list.map(a => `${a.id}|${a.lastAt}|${a.title || ''}|${a.deleted ? 1 : 0}|${(a.tabs || []).map(t => t.title).join(',')}`).join('\n');
        this._libStatus.textContent = status;
        if (sig === this._libSig) return;
        this._libSig = sig;
        if (!list.length) {
            const where = this._libScope === 'project' ? 'this project' : 'any session';
            const text = q ? `No artifacts match “${q}” in ${where}.`
                : j.scanning ? 'Still reading transcripts — the first scan can take a minute.'
                : `No artifacts recorded for ${where} yet.`;
            this._libList.replaceChildren(el('p', { class: 'ctx-muted ctx-lib-empty', text }));
            return;
        }
        const out = [];
        let day = null;
        for (const a of list) {
            const label = dayLabel(a.lastAt || 0);
            if (label !== day) {
                day = label;
                out.push(el('h3', { class: 'ctx-lib-day', text: label }));
            }
            out.push(this._libRow(a));
        }
        this._libList.replaceChildren(...out);
    }

    _libRow(a) {
        const title = artTitle(a);
        const tab = (a.tabs || [])[0];
        const meta = [
            a.project || null,
            tab ? `tab ${tab.title || '#' + tab.id}` : null,
            a.lastAt ? `${ago(a.lastAt)} ago` : null,
        ].filter(Boolean);
        return el('div', { class: 'ctx-lib-row' + (a.deleted ? ' deleted' : ''), role: 'listitem' }, [
            el('a', {
                class: 'ctx-lib-a', href: a.url, target: '_blank', rel: 'noopener noreferrer',
                title: a.url, 'aria-label': `Open ${title} in a new tab`,
            }, [
                el('span', { class: 'ctx-lib-t' }, [
                    el('span', { class: 'ctx-lib-x', text: title }),
                    a.deleted ? el('span', { class: 'ctx-art-k', text: 'deleted' })
                        : a.kind && a.kind !== 'published' ? el('span', { class: 'ctx-art-k', text: a.kind }) : null,
                ]),
                el('span', { class: 'ctx-lib-m', text: meta.join(' · ') }),
            ]),
            this._copyBtn(a.url, 'ctx-art-copy ctx-lib-copy'),
        ]);
    }

    // ── Queue ───────────────────────────────────────────────────────────
    // The daemon owns the queue: it is the thing that knows when the agent is
    // ready, and the thing still running when this browser tab is closed. The
    // panel is a view of it.
    async _queueFetch() {
        const id = this.getTabId();
        if (id == null) { this.queue = []; this.queueGate = null; this._renderQueue(); return; }
        try {
            const r = await fetch(api(this.backend, `/api/queue?tab=${encodeURIComponent(id)}`), {
                credentials: 'include', cache: 'no-store',
            });
            if (!r.ok) throw new Error(String(r.status));
            const d = await r.json();
            if (this._effortSelect) this._effortSelect.disabled = !d.taskEffort;
            this.queue = Array.isArray(d.queue) ? d.queue : [];
            this.queueGate = d.gate || null;
        } catch (_) { /* leave the last view up rather than blanking it */ }
        this._renderQueue();
    }

    async _queueAdd(text) {
        const id = this.getTabId();
        if (id == null) return;
        // Show it at once. The round-trip is fast, but the feedback should not
        // wait on it, and the next poll reconciles either way.
        this.queue = this.queue.concat([{ id: 'pending-' + Date.now(), text, pending: true }]);
        this._renderQueue();
        try {
            const response = await fetch(api(this.backend, '/api/queue'), {
                method: 'POST', credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id, text, effort: this._effortSelect?.value || 'auto' }),
            });
            const result = await response.json();
            if (!response.ok || !result.ok) throw new Error(result.error || 'Could not queue task');
        } catch (error) {
            this._queueInput.value = text;
            this._queueWhy.textContent = error.message;
        }
        this._queueFetch();
    }

    async _queueRemove(qid) {
        this.queue = this.queue.filter(e => e.id !== qid);
        this._renderQueue();
        try {
            await fetch(api(this.backend, `/api/queue/${encodeURIComponent(qid)}`), {
                method: 'DELETE', credentials: 'include',
            });
        } catch (_) {}
        this._queueFetch();
    }

    // Why the queue is not moving is the only thing worth saying in the header.
    // A queue that just sits there with no explanation reads as broken; "waiting
    // on your answer" reads as the truth, and says where to look.
    _gateNote() {
        if (!this.queue.length) return '';
        const stalled = this.queue.find(e => e.why);
        const why = (this.queueGate && !this.queueGate.ok && this.queueGate.why)
            || (stalled && stalled.why);
        return {
            busy: 'sending after this turn',
            attention: 'waiting — the agent needs your answer',
            limited: 'waiting — rate limited',
            cooldown: 'sending…',
            gone: 'tab is gone',
        }[why] || why || 'sending after this turn';
    }

    _renderQueue() {
        if (this._queueWhy) this._queueWhy.textContent = this._gateNote();
        if (!this._queueList) return;
        if (!this.queue.length) {
            this._queueList.replaceChildren(el('p', { class: 'ctx-muted', text: 'nothing queued' }));
            return;
        }
        this._queueList.replaceChildren(...this.queue.map((e, i) => el('div', {
            class: 'ctx-qmsg' + (e.pending ? ' pending' : '') + (i === 0 ? ' next' : ''),
        }, [
            // Position is the useful ordinal: this is a line, and the only
            // question anyone has is what goes in next.
            el('span', { class: 'ctx-qmsg-n', text: String(i + 1) }),
            el('span', { class: 'ctx-qmsg-x', text: e.text, title: e.effort ? `${e.effort.mode === 'auto' ? 'Auto · ' : ''}${e.effort.level || 'Session default'}` : '' }),
            el('button', {
                class: 'ctx-qmsg-del', title: 'remove',
                'aria-label': 'Remove this queued message',
                text: '\u00d7', onclick: () => this._queueRemove(e.id),
            }),
        ])));
    }

    async _openConversation() {
        const id = this.getTabId();
        if (id == null) return;
        document.getElementById('soa-conversation')?.remove();
        const dialog = el('dialog', { id: 'soa-conversation', 'aria-label': 'Full conversation' });
        Object.assign(dialog.style, { width: 'min(900px, 92vw)', maxHeight: '90vh', padding: '20px', borderRadius: '14px', border: '1px solid var(--soa-line, #555)', color: 'var(--soa-fg, #eee)', background: 'var(--soa-bg-panel, #202226)' });
        const list = el('div', { class: 'devhist-list' });
        const status = el('p', { class: 'devhist-sub', role: 'status', text: 'Loading…' });
        const close = el('button', { class: 'devhist-back', text: 'Close', onclick: () => dialog.close() });
        const older = el('button', { class: 'devhist-copy', text: 'Earlier messages' });
        let cursor = null, thread = null, selectedThread = null;
        const load = async (reset = false) => {
            older.disabled = true;
            try {
                const url = api(this.backend, `/api/agent-history?tab=${id}${!reset && cursor != null ? '&before=' + cursor : ''}${selectedThread ? '&session=' + encodeURIComponent(selectedThread) : ''}`);
                const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
                const data = await response.json();
                if (!response.ok || !data.ok) throw new Error(data.error || 'Conversation unavailable');
                if (data.chooseConversation) {
                    status.textContent = 'Choose a saved conversation'; older.hidden = true;
                    const select = el('select', { 'aria-label': 'Saved conversation' }, [el('option', { value: '', text: 'Select conversation…' }),
                        ...data.conversations.map(c => el('option', { value: c.id, text: `${new Date(c.updatedAt).toLocaleString()} · ${c.id.slice(0, 13)}` }))]);
                    select.addEventListener('change', () => { if (select.value) { selectedThread = select.value; load(true); } });
                    list.replaceChildren(select); return;
                }
                if (thread && thread !== data.sessionId) throw new Error('This tab switched conversations. Close and reopen history.');
                thread = data.sessionId;
                const fragment = document.createDocumentFragment();
                for (const message of data.messages) {
                    fragment.append(el('article', { class: 'devhist-item' }, [
                        el('p', { class: 'devhist-title', text: message.role === 'user' ? 'You' : data.agent === 'codex' ? 'Codex' : 'Claude' }),
                        el('pre', { class: 'devhist-text', text: message.text }),
                    ]));
                }
                if (reset) list.replaceChildren(fragment); else list.prepend(fragment);
                cursor = data.nextBefore; older.hidden = !data.hasMore;
                status.textContent = data.hasMore ? '' : 'Beginning of conversation';
            } catch (error) { status.textContent = error.message; }
            finally { older.disabled = false; }
        };
        older.addEventListener('click', () => load());
        const refresh = el('button', { class: 'devhist-copy', text: 'Refresh', onclick: () => load(true) });
        dialog.append(el('header', { class: 'devhist-head' }, [el('h2', { text: 'Conversation' }), close]), status, older, refresh, list);
        dialog.addEventListener('close', () => dialog.remove(), { once: true });
        document.body.append(dialog); dialog.showModal();
        await load(true);
    }

    _renderSteps() {
        if (!this.steps.length) {
            this._stepList.replaceChildren(el('p', { class: 'ctx-muted', text: 'nothing queued' }));
            return;
        }
        this._stepList.replaceChildren(...this.steps.map((s, i) => el('div', {
            class: `ctx-step ${s.status}`,
        }, [
            el('button', {
                class: 'ctx-step-mark', title: s.status, text: STATUS_MARK[s.status] || '○',
                onclick: () => {
                    this.steps[i] = { ...s, status: STATUS_CYCLE[s.status] || 'pending' };
                    this._renderSteps();
                    this._saveSteps();
                },
            }),
            el('span', { class: 'ctx-step-x', text: s.text }),
            el('button', {
                class: 'ctx-step-del', title: 'remove', text: '×',
                onclick: () => {
                    this.steps = this.steps.filter((_, j) => j !== i);
                    this._renderSteps();
                    this._saveSteps();
                },
            }),
        ])));
    }

    async _saveSteps() {
        if (!this.sessionId) return;
        try {
            await fetch(api(this.backend, '/api/context/steps'), {
                method: 'POST', credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId: this.sessionId, steps: this.steps }),
            });
        } catch (_) { /* the list stays on screen; next save retries */ }
    }

    _empty(msg) {
        this._sub.textContent = '—';
        this._turns.textContent = '';
        this._thread.replaceChildren(el('p', { class: 'ctx-muted', text: msg }));
        // Say something in every band, or a canvas with no session reads as a
        // rendering bug rather than an empty state.
        this._arts.replaceChildren(el('p', { class: 'ctx-muted', text: '—' }));
        this._artsCount.textContent = '';
        this._artsSig = '';
    }
}

// The Context | Code switch. Injected here, so the switch ships with this
// module and needs no stylesheet cache-bust of its own.
function ensureViewStyle() {
    if (document.getElementById('ctx-view-style')) return;
    const style = document.createElement('style');
    style.id = 'ctx-view-style';
    style.textContent = `
.ctx-views {
    display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
    padding: 6px 10px; border-bottom: 1px solid var(--soa-line-soft);
}
.ctx-view-btn {
    appearance: none; flex: 1 1 0; min-width: 0; height: 22px; padding: 0 10px;
    background: transparent; color: var(--soa-accent-dim);
    border: 1px solid var(--soa-line); border-radius: 0;
    font-family: var(--font-display); font-size: 10.5px; letter-spacing: 0.12em;
    cursor: pointer; transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease;
}
.ctx-view-btn:first-child { border-radius: var(--desk-control-radius, 4px) 0 0 var(--desk-control-radius, 4px); }
.ctx-view-btn:last-child { border-radius: 0 var(--desk-control-radius, 4px) var(--desk-control-radius, 4px) 0; margin-left: -1px; }
.ctx-view-btn:hover { color: var(--soa-accent); }
.ctx-view-btn.active {
    color: var(--soa-accent); border-color: var(--soa-accent-dim);
    background: rgba(var(--soa-accent-rgb), 0.12); position: relative; z-index: 1;
}
.ctx-view-btn:focus-visible { outline: 2px solid var(--soa-accent); outline-offset: 1px; position: relative; z-index: 2; }
.context-panel.ctx-code > :not(.ctx-grip-w, .ctx-views, .ctx-mode-code) { display: none !important; }
.ctx-mode-code { overflow: hidden; }
:root[data-ui="neumorphism"] .ctx-views { border-color: transparent; }
:root[data-ui="neumorphism"] .ctx-view-btn { border: 0; margin: 0; border-radius: 50px; }
:root[data-ui="neumorphism"] .ctx-view-btn.active { background: var(--soa-bg); box-shadow: var(--desk-inset-sm); }
@media (pointer: coarse) { .ctx-view-btn { height: 34px; } }
@media (prefers-reduced-motion: reduce) { .ctx-view-btn { transition: none; } }
@media (forced-colors: active) {
    .ctx-view-btn { border-color: ButtonText; }
    .ctx-view-btn.active { outline: 2px solid Highlight; outline-offset: -3px; }
}
`;
    document.head.appendChild(style);
}

// Module-level singleton enforces the one-canvas rule even if a caller mounts twice.
let _canvas = null;

export function mountContextPanel(root, ctx = {}) {
    if (_canvas) return _canvas;
    _canvas = new ContextCanvas(root, ctx);
    return _canvas;
}
