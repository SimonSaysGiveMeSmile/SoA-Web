/**
 * contextPanel — the right-hand context canvas.
 *
 * ONE canvas per Claude session, for the life of the page. The daemon returns the
 * session that owns the active tab's cwd; that id is the canvas identity. When it
 * changes the canvas REBINDS — same DOM, new subject — so a long day of switching
 * tabs never leaves a stack of stale canvases behind. Every render replaces its
 * region's children; nothing here appends.
 *
 * Three bands, in the order you need them: what you asked (prompts), where you
 * are (workspace), what is left (next steps).
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
        this._build();
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

        this.root.replaceChildren(
            head,
            el('div', { class: 'ctx-band ctx-band-thread' }, [
                el('div', { class: 'ctx-band-h' }, [el('span', { text: 'PROMPTS' }), this._sub]),
                this._thread,
            ]),
            el('div', { class: 'ctx-band' }, [
                el('div', { class: 'ctx-band-h' }, [el('span', { text: 'WORKSPACE' })]),
                this._facts,
            ]),
            el('div', { class: 'ctx-band' }, [
                el('div', { class: 'ctx-band-h' }, [el('span', { text: 'NEXT STEPS' })]),
                this._stepList,
                this._stepInput,
            ]),
        );
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
