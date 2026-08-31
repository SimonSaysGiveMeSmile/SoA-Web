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
 * (`soa-ctx artifact <url>`). Same for NEXT STEPS — the canvas is a surface the
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
const KEY_STEP = 8;

function lsGet(k, fallback) {
    try { const v = localStorage.getItem(k); return v == null ? fallback : v; } catch (_) { return fallback; }
}
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (_) {} }
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const STATUS_CYCLE = { pending: 'in_progress', in_progress: 'completed', completed: 'pending' };
const STATUS_MARK = { pending: '○', in_progress: '◐', completed: '●' };

class ContextCanvas {
    constructor(root, ctx) {
        this.root = root;
        this.backend = ctx.backend || '';
        this.getCwd = ctx.getCwd || (() => null);
        this.sessionId = null;
        this.steps = [];
        this._pinned = true;
        // Called after any size change so the terminal grid can re-fit into the
        // width the panel just gave back (or took).
        this.onResize = ctx.onResize || (() => {});
        this._bands = {};
        this._applySavedWidth();
        this._build();
        this._applySavedBands();
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
        this._artsBand = el('div', { class: 'ctx-band ctx-band-arts' }, [
            this._bandGrip('arts', 'ARTIFACTS'),
            el('div', { class: 'ctx-band-h' }, [el('span', { text: 'ARTIFACTS' })]),
            this._arts,
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

        this.root.replaceChildren(
            this._widthGrip(),
            head,
            this._threadBand,
            this._factsBand,
            this._artsBand,
            this._stepsBand,
        );
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
            const px = clamp(Math.round(w), WIDTH_MIN, Math.min(WIDTH_MAX, Math.round(window.innerWidth * 0.6)));
            document.documentElement.style.setProperty('--soa-ctx-w', px + 'px');
            lsSet(LS_WIDTH, String(px));
        };
        this._drag(grip,
            (e) => ({ x: e.clientX, w: width() }),
            // The panel is on the RIGHT, so dragging left (negative dx) grows it.
            (ev, s) => { setW(s.w + (s.x - ev.clientX)); this.onResize(); },
            () => { document.documentElement.style.removeProperty('--soa-ctx-w'); lsDel(LS_WIDTH); },
        );
        grip.addEventListener('keydown', (e) => {
            const d = e.key === 'ArrowLeft' ? KEY_STEP : e.key === 'ArrowRight' ? -KEY_STEP : 0;
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

    _applySavedWidth() {
        const w = parseInt(lsGet(LS_WIDTH, ''), 10);
        if (Number.isFinite(w) && w >= WIDTH_MIN) {
            document.documentElement.style.setProperty(
                '--soa-ctx-w', clamp(w, WIDTH_MIN, WIDTH_MAX) + 'px');
        }
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
        this._renderArtifacts(d.artifacts || []);
        this._renderSteps();
    }

    _renderThread(prompts) {
        if (!prompts.length) {
            this._thread.replaceChildren(el('p', { class: 'ctx-muted', text: 'no prompts recorded for this workspace yet' }));
            return;
        }
        const last = prompts.length - 1;
        this._thread.replaceChildren(...prompts.map((p, i) => el('article', {
            class: 'ctx-turn' + (i === last ? ' latest' : ''),
        }, [
            el('div', { class: 'ctx-turn-m' }, [
                el('span', { class: 'ctx-turn-n', text: String(i + 1) }),
                el('span', { class: 'ctx-turn-t', text: ago(p.at) }),
            ]),
            el('p', { class: 'ctx-turn-x', text: p.text }),
        ])));
        if (this._pinned) this._thread.scrollTop = this._thread.scrollHeight;
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

    _renderArtifacts(list) {
        if (!list.length) {
            this._arts.replaceChildren(el('p', { class: 'ctx-muted', text: 'nothing published yet' }));
            return;
        }
        // Newest first: the thing you just made is the thing you want to open.
        this._arts.replaceChildren(...[...list].reverse().map(a => el('a', {
            class: 'ctx-art', href: a.url, target: '_blank', rel: 'noopener noreferrer',
            title: a.url,
        }, [
            el('span', { class: 'ctx-art-x', text: a.title || a.id.slice(0, 8) }),
            el('span', { class: 'ctx-art-t', text: a.at ? ago(a.at) : '' }),
        ])));
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
    }
}

// Module-level singleton enforces the one-canvas rule even if a caller mounts twice.
let _canvas = null;

export function mountContextPanel(root, ctx = {}) {
    if (_canvas) return _canvas;
    _canvas = new ContextCanvas(root, ctx);
    return _canvas;
}
