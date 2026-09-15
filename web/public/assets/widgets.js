/**
 * Sidebar widgets — small, self-contained, all driven from JSON endpoints.
 *
 * Each widget exports `mount(parent, ctx)`. `ctx` carries shared utilities
 * (audio cue player, log helpers). Each widget owns its own DOM subtree and
 * polls or subscribes for updates as needed.
 *
 * Polling is deliberate: the server is local, the data is cheap. Simpler than
 * a streaming feed, and individual widgets can be paused/resumed by the host
 * without coordinating an extra channel.
 */

import { t as tr } from '/assets/i18n.js?v=28';
import { getSettings, saveSettings, onSettings } from '/assets/settings.js?v=26';
import { perfStart, perfStop, perfSnapshot, perfVerdict } from '/assets/perf.js?v=2';

const $el = (tag, props = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v != null) n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
};

const fmtBytes = b => {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(b >= 100 ? 0 : 1)} ${u[i]}`;
};

const fmtUptime = s => {
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600);  s %= 3600;
    const m = Math.floor(s / 60);
    return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
};

// Route API URLs through the configured backend. The active backend + token
// are stored on window.__SOA_WEB__ by app.js before mountSidebar runs, so
// widgets don't need to thread either through their constructors.
function currentBackend() {
    const c = window.__SOA_WEB__ || {};
    return (c._resolvedBackend || c.backend || '').replace(/\/+$/, '') || location.origin;
}
function currentToken() {
    return (window.__SOA_WEB__ || {})._resolvedToken || '';
}
function api(path) {
    if (path.startsWith('http')) return path;
    const u = new URL(currentBackend() + path);
    const t = currentToken();
    if (t) u.searchParams.set('t', t);
    return u.toString();
}
// Live accent for canvas paints (sparklines, charts, globe). Canvases can't
// use CSS var() directly, so read the token off :root — this is what lets the
// MINIMAL UI language re-tint every hand-painted pixel without code forks.
function accentRGB() {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--soa-accent-rgb').trim();
        if (v) return v;
    } catch (_) {}
    return '170, 207, 209';
}

// Widgets call this to decide which data path to use. mountSandboxSidebar
// sets _sandbox=true before starting widgets; mountSidebar leaves it false.
// Keeping the decision in a flag (rather than inspecting the network on
// every tick) means widgets stay synchronous and don't spam 404s.
function isSandbox() { return !!(window.__SOA_WEB__ && window.__SOA_WEB__._sandbox); }

async function jget(url) {
    const r = await fetch(api(url), { credentials: 'include' });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
}
async function jpost(url, body) {
    const r = await fetch(api(url), {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
}

// Pause every widget's polling while the page is in a background tab. A single
// document-level listener drives all live widgets, so a dozen sidebar widgets
// don't each attach their own. Hidden tabs stop firing fetches entirely — which
// also means far fewer in-flight requests to abort during a network change.
const _liveWidgets = new Set();
let _visBound = false;
let _sidebarHidden = false;

// Widgets run only when actually visible: the tab is foregrounded AND the
// sidebar is open. Collapsing the sidebar (the common full-screen terminal
// state) otherwise leaves ~14 widgets polling /api/* against an invisible pane.
function _widgetsActive() { return !document.hidden && !_sidebarHidden; }
function _applyWidgetActivity() {
    const active = _widgetsActive();
    for (const w of _liveWidgets) {
        try { active ? w._resume() : w._suspend(); } catch (_) {}
    }
}
function _bindWidgetVisibility() {
    if (_visBound) return;
    _visBound = true;
    document.addEventListener('visibilitychange', _applyWidgetActivity);
}

// Called by the shell when the sidebar collapses/expands so widgets pause while
// hidden. Combines with document.hidden via _widgetsActive().
export function setSidebarHidden(hidden) {
    hidden = !!hidden;
    if (hidden === _sidebarHidden) return;
    _sidebarHidden = hidden;
    _applyWidgetActivity();
}

class Widget {
    constructor({ title, titleKey, helpKey, parent, intervalMs }) {
        this.titleKey = titleKey || null;
        this.helpKey = helpKey || null;   // instructional prose, hidden behind the ⓘ button
        this.title = titleKey ? tr(titleKey) : title;
        this.intervalMs = intervalMs || 0;
        // The '// ' prefix is applied via CSS ::before (sidebar.css) so the
        // MINIMAL UI language can drop it without touching this text node.
        this._titleEl = $el('span', { class: 'widget-title', text: this.title });
        this._pulseEl = $el('span', { class: 'widget-pulse' });
        // Header controls (info button + pulse) sit on the right; the title
        // takes the left — justify-content:space-between keeps them apart.
        this._headCtl = $el('span', { class: 'widget-h-ctl' }, [this._pulseEl]);
        const header = $el('header', { class: 'widget-h' }, [this._titleEl, this._headCtl]);
        this.root = $el('section', { class: 'widget' }, [header, $el('div', { class: 'widget-body' })]);
        this.body = this.root.querySelector('.widget-body');
        // ⓘ — a per-widget help toggle. Keeps instructions out of the body
        // (less clutter) until the user asks for them.
        if (this.helpKey) {
            this._infoEl = $el('div', { class: 'widget-info', text: tr(this.helpKey) });
            this._infoEl.hidden = true;
            this._infoBtn = $el('button', {
                class: 'widget-info-btn', title: tr('widget.info'), 'aria-label': tr('widget.info'),
                text: 'ⓘ', onclick: () => this._toggleInfo(),
            });
            this._headCtl.insertBefore(this._infoBtn, this._pulseEl);
            header.after(this._infoEl);
        }
        parent.appendChild(this.root);
        this._timer = null;
        this._destroyed = false;
        this._langOff = null;
        if (this.titleKey) {
            const retitle = () => {
                this.title = tr(this.titleKey);
                this._titleEl.textContent = this.title;
                if (this._infoEl) this._infoEl.textContent = tr(this.helpKey);
                if (typeof this.onLangChange === 'function') this.onLangChange();
            };
            window.addEventListener('soa:lang', retitle);
            this._langOff = () => window.removeEventListener('soa:lang', retitle);
        }
    }

    _toggleInfo() {
        if (!this._infoEl) return;
        this._infoEl.hidden = !this._infoEl.hidden;
        if (this._infoBtn) this._infoBtn.classList.toggle('open', !this._infoEl.hidden);
    }

    start() {
        _liveWidgets.add(this);
        _bindWidgetVisibility();
        this.tick();
        // Don't arm a polling timer while the page is hidden — _resume starts it
        // when the tab is foregrounded again.
        if (this.intervalMs && !this._timer && _widgetsActive()) {
            this._timer = setInterval(() => this.tick(), this.intervalMs);
        }
    }

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    // Visibility hooks (driven by the shared listener). _suspend only pauses the
    // polling cadence; _resume refreshes once and re-arms it. Event-driven /
    // static widgets (intervalMs 0) are no-ops here.
    _suspend() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    _resume() {
        if (this._destroyed || this._timer || !this.intervalMs) return;
        this.tick();
        this._timer = setInterval(() => this.tick(), this.intervalMs);
    }

    destroy() {
        this._destroyed = true;
        _liveWidgets.delete(this);
        this.stop();
        if (this._langOff) { this._langOff(); this._langOff = null; }
        this.root.remove();
    }

    tick() { /* override */ }

    setRows(rows) {
        if (this._destroyed) return;
        this.body.replaceChildren(...rows.map(([k, v, cls]) => {
            const row = $el('div', { class: 'kv' + (cls ? ' ' + cls : '') });
            row.appendChild($el('span', { class: 'k', text: k }));
            row.appendChild($el('span', { class: 'v', text: v == null ? '—' : String(v) }));
            return row;
        }));
    }
}

// ── CLOCK ────────────────────────────────────────────────────────────────
// A zone's own label. The last path segment is the city, which is what anyone
// reading a clock actually wants — 'America/New_York' is NEW YORK.
function _zoneLabel(tz) {
    if (!tz || tz === 'UTC') return 'UTC';
    return tz.split('/').pop().replace(/_/g, ' ').toUpperCase();
}

// en-CA gives ISO order, which subtracts cleanly.
function _ymdIn(now, tz) {
    try { return now.toLocaleDateString('en-CA', { timeZone: tz }); } catch (_) { return null; }
}

// Offered in the city picker. Not a closed list — the field takes any IANA
// name — just the ones worth one tap.
const ZONE_PRESETS = [
    'UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago',
    'America/New_York', 'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin',
    'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
    'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney',
];

// A segmented control, the one Apple idiom this panel borrows outright: the
// options are all visible, the current one is filled rather than ticked, and
// choosing is a single tap with nothing to open. Rendered in the terminal's own
// mono and hairlines so it reads as part of this product, not pasted in.
function _segmented(value, options, onPick) {
    const wrap = $el('div', { class: 'seg', role: 'radiogroup' });
    for (const [val, label] of options) {
        const b = $el('button', {
            class: 'seg-o' + (val === value ? ' on' : ''), type: 'button',
            role: 'radio', 'aria-checked': String(val === value), text: label,
            onclick: () => onPick(val),
        });
        wrap.appendChild(b);
    }
    return wrap;
}

// Hours/minutes/seconds in a zone, as numbers. en-GB 24h is the shortest way
// to a parseable string, and one call covers both the digits and the hands.
function _hmsIn(now, tz) {
    try {
        const s = now.toLocaleTimeString('en-GB', {
            timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        const [h, m, sec] = s.split(':').map(Number);
        return { h, m, s: sec };
    } catch (_) { return null; }
}

class ClockWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.clock', parent, intervalMs: 1000 });

        // ⚙ — the secondary menu. Same affordance the other widgets carry for
        // ⓘ, so the header keeps one grammar.
        this._cfgBtn = $el('button', {
            class: 'widget-info-btn', type: 'button', title: tr('widget.clock.configure'),
            'aria-label': tr('widget.clock.configure'), text: '⚙',
            onclick: () => this._toggleCfg(),
        });
        this._headCtl.insertBefore(this._cfgBtn, this._pulseEl);

        this._cfg = $el('div', { class: 'clock-cfg' });
        this._cfg.hidden = true;
        this.root.querySelector('.widget-h').after(this._cfg);

        // ONE row. Local and every city sit in it as identical cells, so the
        // clock is a glance rather than a list — and the analog face is not a
        // separate mode that takes the space above, it is simply what a cell's
        // value looks like when you choose it.
        this._strip = $el('div', { class: 'clock-strip' });
        this.body.replaceChildren(this._strip);
        this._cells = new Map();
        this._stripKey = '';
        this._renderCfg();
        this._offSettings = onSettings(() => { if (!this._cfg.hidden) this._renderCfg(); });
    }

    destroy() {
        if (this._offSettings) { this._offSettings(); this._offSettings = null; }
        super.destroy();
    }

    _toggleCfg() {
        this._cfg.hidden = !this._cfg.hidden;
        this._cfgBtn.classList.toggle('open', !this._cfg.hidden);
        if (!this._cfg.hidden) this._renderCfg();
    }

    // A dial small enough to sit in a column beside four others. A hairline
    // ring and four quarter ticks — at this size twelve of them are a smudge —
    // and the second hand is the only saturated thing on it.
    _makeDial() {
        const NS = 'http://www.w3.org/2000/svg';
        const mk = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
        const svg = mk('svg', { class: 'clock-dial', viewBox: '0 0 100 100', 'aria-hidden': 'true' });
        svg.appendChild(mk('circle', { class: 'dial-ring', cx: 50, cy: 50, r: 46 }));
        for (let i = 0; i < 4; i++) {
            svg.appendChild(mk('line', {
                class: 'dial-tick major', x1: 50, y1: 6, x2: 50, y2: 16,
                transform: `rotate(${i * 90} 50 50)`,
            }));
        }
        const h = mk('line', { class: 'dial-h', x1: 50, y1: 50, x2: 50, y2: 30 });
        const m = mk('line', { class: 'dial-m', x1: 50, y1: 50, x2: 50, y2: 18 });
        const sec = mk('line', { class: 'dial-s', x1: 50, y1: 58, x2: 50, y2: 14 });
        svg.append(h, m, sec);
        svg.appendChild(mk('circle', { class: 'dial-pin', cx: 50, cy: 50, r: 2.4 }));
        return { svg, h, m, s: sec };
    }

    // Cells are rebuilt only when the city list or the face changes — never on
    // a tick, which just moves hands and swaps text.
    _ensureCells(keys, face) {
        const sig = face + '|' + keys.join(',');
        if (sig === this._stripKey) return;
        this._stripKey = sig;
        this._cells.clear();
        const nodes = [];
        for (const k of keys) {
            const label = $el('span', { class: 'city-k', text: k.label });
            const cell = { root: null, label };
            const kids = [label];
            if (face === 'analog') {
                cell.dial = this._makeDial();
                kids.push(cell.dial.svg);
            } else {
                cell.value = $el('span', { class: 'city-v' });
                kids.push(cell.value);
            }
            cell.delta = $el('span', { class: 'city-d' });
            kids.push(cell.delta);
            cell.root = $el('div', { class: 'city' + (k.tz ? '' : ' city--local') }, kids);
            nodes.push(cell.root);
            this._cells.set(k.key, cell);
        }
        this._strip.replaceChildren(...nodes);
    }

    _renderCfg() {
        const s = getSettings();
        const row = (label, ctl) => $el('div', { class: 'cfg-row' }, [$el('span', { class: 'cfg-k', text: label }), ctl]);

        const zones = s.clockZones.slice();
        const chips = $el('div', { class: 'cfg-chips' });
        for (const z of zones) {
            chips.appendChild($el('button', {
                class: 'chip', type: 'button', title: z, text: _zoneLabel(z) + ' ✕',
                onclick: () => saveSettings({ clockZones: zones.filter(x => x !== z) }),
            }));
        }
        const picker = $el('select', { class: 'cfg-add' });
        picker.appendChild($el('option', { value: '', text: '+ add city' }));
        for (const z of ZONE_PRESETS) {
            if (zones.includes(z)) continue;
            picker.appendChild($el('option', { value: z, text: _zoneLabel(z) }));
        }
        picker.addEventListener('change', () => {
            if (picker.value) saveSettings({ clockZones: [...zones, picker.value] });
        });

        this._cfg.replaceChildren(
            row(tr('widget.clock.face'), _segmented(s.clockFace, [['digital', 'DIGITAL'], ['analog', 'ANALOG']],
                v => saveSettings({ clockFace: v }))),
            row(tr('widget.clock.hours'), _segmented(s.clockHours, [[24, '24H'], [12, '12H']],
                v => saveSettings({ clockHours: v }))),
            row(tr('widget.clock.cities'), $el('div', { class: 'cfg-cities' }, [chips, picker])),
        );
    }

    tick() {
        const now = new Date();
        const s = getSettings();
        const analog = s.clockFace === 'analog';
        const hours12 = s.clockHours === 12;

        const keys = [{ key: '@local', label: 'LOCAL', tz: null }];
        for (const tz of (s.clockZones || [])) keys.push({ key: tz, label: _zoneLabel(tz), tz });
        this._ensureCells(keys, analog ? 'analog' : 'digital');

        const hereYmd = _ymdIn(now, undefined) || now.toISOString().slice(0, 10);
        for (const k of keys) {
            const cell = this._cells.get(k.key);
            if (!cell) continue;
            const hms = k.tz ? _hmsIn(now, k.tz) : { h: now.getHours(), m: now.getMinutes(), s: now.getSeconds() };
            if (!hms) continue;

            if (cell.dial) {
                const sec = hms.s, min = hms.m + sec / 60, hr = (hms.h % 12) + min / 60;
                cell.dial.s.setAttribute('transform', `rotate(${sec * 6} 50 50)`);
                cell.dial.m.setAttribute('transform', `rotate(${min * 6} 50 50)`);
                cell.dial.h.setAttribute('transform', `rotate(${hr * 30} 50 50)`);
            } else if (cell.value) {
                let h = hms.h, suffix = '';
                if (hours12) { suffix = h >= 12 ? 'p' : 'a'; h = h % 12 || 12; }
                cell.value.textContent =
                    `${hours12 ? h : String(h).padStart(2, '0')}:${String(hms.m).padStart(2, '0')}${suffix}`;
            }

            // The day offset only appears when it changes the answer.
            let delta = 0;
            if (k.tz) {
                const thereYmd = _ymdIn(now, k.tz);
                if (thereYmd) delta = Math.round((Date.parse(thereYmd + 'T00:00:00Z') - Date.parse(hereYmd + 'T00:00:00Z')) / 86400000);
            }
            cell.delta.textContent = delta > 0 ? `+${delta}d` : delta < 0 ? `${delta}d` : '';
        }
    }
}

// ── CLAUDE USAGE ─────────────────────────────────────────────────────────
// Live Claude token usage, read from the local transcripts by /api/claude-usage.
// Leads with the 5-hour rolling window (Claude's usage-limit block) + a reset
// countdown, then today's totals, a live burn rate, top model, and a per-minute
// sparkline. Cost is shown small and labelled "≈" — it's an API-equivalent
// estimate, not a bill (a Max/Pro seat is flat-rate).
const _fmtTok = n => {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
    return String(Math.round(n));
};
const _fmtUsd = n => {
    n = n || 0;
    if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
    if (n >= 100) return '$' + n.toFixed(0);
    return '$' + n.toFixed(2);
};
// Per-session "leaning hard on the model" thresholds (est. USD) — mirror the
// soa-usage-alert push watchdog's defaults so the dashboard highlight and the
// phone alert agree. block = the active 5h usage-limit window, today = midnight.
const HOT_COST = { block: 20, today: 60 };
// Estimated weekly usage-limit ceiling (USD-equiv) for the WEEKLY bar's 100%.
// The local transcript engine can't read Claude's real weekly cap, so we
// approximate it from an observed calibration point: ≈82% ⇔ ≈$3002 → 100% ≈
// $3660. Only affects the bar's fill %/label; the tok+cost figures are exact.
// Tune if the ceiling drifts (or the plan changes).
const WEEK_LIMIT_USD = 3660;
const _fmtDur = ms => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
};

class ClaudeUsageWidget extends Widget {
    constructor({ parent }) {
        // 2.5s poll: the server memoizes compute() for 1.2s and tails only
        // appended bytes, so the fast cadence is cheap — the remaining lag is
        // transcript flush timing (a record lands when its message completes).
        super({ titleKey: 'widget.claude', title: 'CLAUDE', parent, intervalMs: 2500 });
        // Persistent DOM — tick() only updates text/width/canvas so the
        // sparkline never flickers on refresh.
        this._reset = $el('span', { class: 'claude-reset', text: '—' });
        this._fill = $el('span', { class: 'bar-fill' });
        this._sub = $el('div', { class: 'claude-sub', text: '—' });
        // Weekly usage-limit window (mirrors the 5H block above it). The weekly
        // is the constraint that resets slowest, so surface it alongside the 5H.
        this._weekPct = $el('span', { class: 'claude-reset', text: '—' });
        this._weekFill = $el('span', { class: 'bar-fill' });
        this._weekSub = $el('div', { class: 'claude-sub', text: '—' });
        this._spark = $el('canvas', { class: 'claude-spark', width: 240, height: 34 });
        this._series = new Array(30).fill(0);
        const kv = (k) => {
            const v = $el('span', { class: 'v' });
            const row = $el('div', { class: 'kv' }, [$el('span', { class: 'k', text: k }), v]);
            return { row, v };
        };
        this._burn = kv('BURN');
        this._today = kv('TODAY');
        this._model = kv('MODEL');
        // Per-session breakdown ("which session is burning the tokens") — fed
        // by the same endpoint; hidden until the server ships session rows.
        this._sessHead = $el('div', { class: 'claude-sess-head', text: 'TOP SESSIONS' });
        this._sessList = $el('div', { class: 'claude-sess-list' });
        this._sessHead.style.display = 'none';
        this._sessList.style.display = 'none';
        this._mountStructure();
        // The widget is the teaser; the full usage dashboard lives in the
        // manager view's USAGE pane. app.js listens for this event.
        this.body.classList.add('claude-clickable');
        this.body.title = 'Open the usage dashboard';
        this.body.addEventListener('click', () =>
            window.dispatchEvent(new CustomEvent('soa:open-usage')));
    }

    // Assemble the persistent DOM. Re-callable: a 404/sandbox tick swaps in a
    // note (detaching these nodes), so _render re-mounts before updating them.
    _mountStructure() {
        this.body.replaceChildren(
            $el('div', { class: 'claude-head' }, [
                $el('span', { class: 'claude-head-l', text: '5H WINDOW' }),
                this._reset,
            ]),
            $el('div', { class: 'bar claude-bar' }, [this._fill]),
            this._sub,
            $el('div', { class: 'claude-head claude-head-week' }, [
                $el('span', { class: 'claude-head-l', text: 'WEEKLY' }),
                this._weekPct,
            ]),
            $el('div', { class: 'bar claude-bar' }, [this._weekFill]),
            this._weekSub,
            this._spark,
            this._burn.row, this._today.row, this._model.row,
            this._sessHead, this._sessList,
        );
    }

    async tick() {
        if (isSandbox()) { this._note(tr('widget.claude.sandbox')); return; }
        let data;
        try {
            ({ data } = await jget('/api/claude-usage'));
        } catch (e) {
            // The endpoint ships in a server build; before the backend restarts
            // it 404s — show a hint rather than a scary ERR.
            if (/\b404\b/.test(e.message)) this._note(tr('widget.claude.restart'));
            return;
        }
        this._render(data);
    }

    _note(text) {
        this.body.replaceChildren($el('div', { class: 'widget-note', text }));
    }

    _render(d) {
        // A prior note tick may have detached the structure — re-mount it.
        if (!this.body.contains(this._reset)) this._mountStructure();
        const b = d.block || {};
        if (b.active) {
            this._reset.textContent = tr('widget.claude.resets', { t: _fmtDur(b.remainingMs) });
            this._reset.classList.toggle('warn', b.remainingMs < 20 * 60000);
            this._fill.style.width = `${Math.min(100, b.pct || 0)}%`;
            this._sub.textContent = `${_fmtTok(b.tokens.total)} ${tr('widget.claude.tok')} · ${b.requests} ${tr('widget.claude.req')} · ≈${_fmtUsd(b.cost)}`;
            this._burn.v.textContent = `${_fmtTok(b.burnRatePerMin)} ${tr('widget.claude.tokmin')}`;
        } else {
            this._reset.textContent = tr('widget.claude.idle');
            this._reset.classList.remove('warn');
            this._fill.style.width = '0%';
            this._sub.textContent = d.hasData ? tr('widget.claude.window_reset') : tr('widget.claude.no_data');
            this._burn.v.textContent = '0 ' + tr('widget.claude.tokmin');
        }
        // Weekly window — the slow-reset ceiling. No server-side pct (the local
        // engine has no cap), so estimate against WEEK_LIMIT_USD; tok+cost exact.
        const wk = d.week || {};
        const wkCost = wk.cost || 0;
        const wkTok = (wk.tokens && wk.tokens.total) || 0;
        const wkPct = Math.min(100, Math.round((wkCost / WEEK_LIMIT_USD) * 100));
        this._weekPct.textContent = `${wkPct}% used`;
        this._weekPct.classList.toggle('warn', wkPct >= 80);
        this._weekFill.style.width = `${wkPct}%`;
        this._weekFill.classList.toggle('hot', wkPct >= 80);
        this._weekSub.textContent = `${_fmtTok(wkTok)} ${tr('widget.claude.tok')} · ≈${_fmtUsd(wkCost)}`;
        const today = d.today || { tokens: { total: 0 }, cost: 0 };
        this._today.v.textContent = `${_fmtTok(today.tokens.total)} · ≈${_fmtUsd(today.cost)}`;
        const top = (d.models || [])[0];
        if (top) {
            const totAll = (d.models || []).reduce((s, m) => s + m.tokens, 0) || 1;
            const share = Math.round((top.tokens / totAll) * 100);
            this._model.v.textContent = `${top.tier} ${share}%`;
        } else {
            this._model.v.textContent = '—';
        }
        this._renderSessions(d);
        this._series = (d.series || []).slice(-30);
        this._paintSpark();
    }

    // Top sessions by estimated cost — in the live 5h window while one is
    // active, else today. Subagent usage is already folded into its parent
    // session server-side, so an agent-heavy session shows its whole bill.
    _renderSessions(d) {
        const scope = d.sessionScope === 'block' ? 'block' : 'today';
        const rows = (d.sessions || [])
            .map(s => ({ s, sc: (scope === 'block' ? s.block : s.today) || {} }))
            .filter(x => x.sc.tok > 0)
            .slice(0, 6);
        if (!rows.length) {
            this._sessHead.style.display = 'none';
            this._sessList.style.display = 'none';
            this._sessList.replaceChildren();
            return;
        }
        this._sessHead.style.display = '';
        this._sessList.style.display = '';
        this._sessHead.textContent = 'TOP SESSIONS · ' + (scope === 'block' ? '5H' : 'TODAY');
        this._sessList.replaceChildren(...rows.map(({ s, sc }) => {
            // "project · first-slug-word" tells same-project sessions apart
            // without eating the row ("soa-web · keen" vs "soa-web · noble").
            const slugBit = s.slug ? s.slug.split('-')[0] : (s.shortId || '').slice(0, 4);
            const label = (s.project || '?') + (slugBit ? ' · ' + slugBit : '');
            const b = s.block || {}, t = s.today || {};
            // Flag a session leaning hard on the model — same per-session
            // thresholds as the soa-usage-alert push watchdog (block $20 / today
            // $60), so the dashboard and the phone alert agree on "too much".
            const hot = (sc.cost || 0) >= (scope === 'block' ? HOT_COST.block : HOT_COST.today);
            const tip = [
                (s.project || '?') + ' — ' + (s.slug || s.shortId || ''),
                `5h window: ${_fmtTok(b.tok)} tok · ≈${_fmtUsd(b.cost)} · ${b.req || 0} req`,
                `today: ${_fmtTok(t.tok)} tok · ≈${_fmtUsd(t.cost)} · ${t.req || 0} req`,
            ];
            if (t.subCost > 0.01) tip.push(`of which subagents today: ≈${_fmtUsd(t.subCost)}`);
            if (hot) tip.push(`⚠ heavy this ${scope === 'block' ? '5h block' : 'day'} — the token-usage alerter has flagged this session`);
            return $el('div', { class: 'claude-sess-row' + (hot ? ' hot' : ''), title: tip.join('\n') }, [
                $el('span', { class: 'claude-sess-name', text: (hot ? '⚠ ' : '') + label }),
                $el('span', { class: 'claude-sess-val', text: `${_fmtTok(sc.tok)} · ≈${_fmtUsd(sc.cost)}` }),
            ]);
        }));
    }

    onLangChange() { /* labels refresh on next tick */ }

    _paintSpark() {
        const c = this._spark, ctx = c.getContext('2d');
        const w = c.width, h = c.height;
        ctx.clearRect(0, 0, w, h);
        const n = this._series.length;
        if (!n) return;
        const max = Math.max(1, ...this._series);
        // Filled area + line, Tron accent.
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const x = (i / (n - 1)) * w;
            const y = h - (this._series[i] / max) * (h - 3) - 1.5;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        const acc = accentRGB();
        ctx.strokeStyle = `rgba(${acc}, 0.9)`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
        ctx.fillStyle = `rgba(${acc}, 0.12)`;
        ctx.fill();
    }
}

// ── SYSINFO ──────────────────────────────────────────────────────────────
class SysInfoWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.system', parent, intervalMs: 5000 });
        this._bootAt = Date.now();
    }
    async tick() {
        if (isSandbox()) { this._renderSandbox(); return; }
        try {
            const { data } = await jget('/api/sys');
            this.setRows([
                ['HOST', data.hostname],
                ['USER', data.userInfo],
                ['OS', `${data.platform} ${data.arch}`],
                ['UPTIME', fmtUptime(data.uptime)],
            ]);
        } catch (e) { this.setRows([['ERR', e.message]]); }
    }
    _renderSandbox() {
        const nav = navigator || {};
        const ua = nav.userAgent || '';
        const browser = /(Firefox|Edg|Chrome|Safari)\/[\d.]+/.exec(ua.replace(/Chrome\S+ Safari/, 'Chrome'));
        const platform = nav.platform || tr('widget.sandbox.unknown');
        const sessS = Math.floor((Date.now() - this._bootAt) / 1000);
        this.setRows([
            ['HOST', location.host || '—'],
            ['ENGINE', 'browser'],
            ['PLATFORM', platform],
            ['AGENT', browser ? browser[0] : '—'],
            ['SESSION', fmtUptime(sessS)],
        ]);
    }
}

// ── CPU ──────────────────────────────────────────────────────────────────
class CpuInfoWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.cpu', parent, intervalMs: 4000 });
    }
    async tick() {
        if (isSandbox()) { this._renderSandbox(); return; }
        try {
            const { data } = await jget('/api/cpu');
            this.setRows([
                ['MODEL', (data.model || '').replace(/\s+\(R\)|\(TM\)/g, '').slice(0, 24)],
                ['CORES', data.cores],
                ['LOAD-1m', data.loadavg[0].toFixed(2)],
                ['LOAD-5m', data.loadavg[1].toFixed(2)],
            ]);
        } catch (e) { this.setRows([['ERR', e.message]]); }
    }
    _renderSandbox() {
        const cores = (navigator && navigator.hardwareConcurrency) || null;
        this.setRows([
            ['CORES', cores == null ? '—' : cores],
            ['MODEL', tr('widget.sandbox.locked')],
            ['LOAD', tr('widget.sandbox.locked')],
        ]);
    }
}

// ── RAM ──────────────────────────────────────────────────────────────────
class RamWatcherWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.memory', parent, intervalMs: 2500 });
        // Two segments: real memory in use, then reclaimable file cache behind it.
        // One bar at 98% told the old story; this one shows why that was wrong.
        this._bar = $el('div', { class: 'bar bar-split' }, [
            $el('span', { class: 'bar-fill' }),
            $el('span', { class: 'bar-cache' }),
        ]);
        this.body.appendChild(this._bar);
    }
    async tick() {
        if (isSandbox()) { this._renderSandbox(); return; }
        try {
            const { data } = await jget('/api/ram');
            const cachePct = data.total > 0 ? (data.cached / data.total) * 100 : 0;
            this._bar.querySelector('.bar-fill').style.width = `${data.usedPct}%`;
            this._bar.querySelector('.bar-cache').style.width = `${cachePct}%`;
            // Pressure is the kernel's own verdict and the only row worth
            // alarming on — a full-looking bar with normal pressure is healthy.
            const pressure = data.pressure || 'unknown';
            const rows = [
                ['USED', fmtBytes(data.used)],
                ['CACHED', fmtBytes(data.cached)],
                ['TOTAL', fmtBytes(data.total)],
                ['LOAD', `${data.usedPct.toFixed(1)}%`, data.usedPct > 90 ? 'warn' : ''],
            ];
            if (data.swapUsed > 0) rows.push(['SWAP', fmtBytes(data.swapUsed), 'warn']);
            if (pressure !== 'unknown') rows.push(['PRESSURE', pressure.toUpperCase(), pressure === 'normal' ? '' : 'warn']);
            this.setRows(rows);
            this.body.appendChild(this._bar);
        } catch (e) { this.setRows([['ERR', e.message]]); }
    }
    _renderSandbox() {
        // performance.memory is Chromium-only but gives a real JS-heap size;
        // navigator.deviceMemory is a coarse GB-bucket, also Chromium/Edge.
        // When neither exists (Safari/Firefox) we just show the device tier.
        const dm = (navigator && navigator.deviceMemory) ? navigator.deviceMemory * 1024 * 1024 * 1024 : null;
        const pm = performance && performance.memory ? performance.memory : null;
        const used = pm ? pm.usedJSHeapSize : null;
        const total = pm ? pm.jsHeapSizeLimit : (dm || null);
        const pct = (used && total) ? (used / total) * 100 : null;
        if (pct != null) this._bar.querySelector('.bar-fill').style.width = `${Math.min(100, pct)}%`;
        else this._bar.querySelector('.bar-fill').style.width = '0%';
        this.setRows([
            ['HEAP', used == null ? '—' : fmtBytes(used)],
            ['LIMIT', total == null ? '—' : fmtBytes(total)],
            ['DEVICE', dm == null ? '—' : fmtBytes(dm)],
            ['LOAD', pct == null ? '—' : `${pct.toFixed(1)}%`, pct > 85 ? 'warn' : ''],
        ]);
        this.body.appendChild(this._bar);
    }
}

// ── NETSTAT ──────────────────────────────────────────────────────────────
// Runtimes a person runs a dev server in. The discriminator is deliberately a
// POSITIVE list rather than a blocklist of noise: what you want from this panel
// is "the thing I am building, so I can look at it", and that set is small and
// stable, while the set of background daemons that happen to hold a socket is
// neither. Everything else is still reachable — it is just behind a count
// instead of in front of it.
const DEV_RUNTIMES = new Set([
    'node', 'bun', 'deno', 'python', 'python3', 'ruby', 'php', 'java', 'dotnet',
    'go', 'rails', 'puma', 'gunicorn', 'uvicorn', 'vite', 'next-server', 'caddy', 'nginx',
]);
// Above this, macOS is handing out ephemeral source ports. A process holding
// one is almost never something you would browse to, whatever runtime it is.
const EPHEMERAL_MIN = 32768;
const isDevPort = (p) => DEV_RUNTIMES.has(String(p.process || '').toLowerCase())
    && Number(p.port) < EPHEMERAL_MIN;

/**
 * Collapse a worker pool into one row.
 *
 * A dev tool that forks twelve workers takes twelve consecutive ports, and
 * listing them individually is twelve rows saying the same thing — on this
 * machine that was :4491 through :4502, all bun, half the list. A run of three
 * or more consecutive ports from one process is one fact: that tool is running.
 * Two adjacent ports are not a pool, they are two servers, so they stay apart.
 */
function groupPorts(ports) {
    const sorted = ports.slice().sort((a, b) => a.port - b.port);
    const out = [];
    for (let i = 0; i < sorted.length;) {
        let j = i;
        // A gap of one is still the same pool: a worker that started when the
        // port it wanted was already taken leaves a hole, and :4491–:4499 plus
        // :4501–:4502 is one tool, not three.
        while (j + 1 < sorted.length
            && sorted[j + 1].process === sorted[i].process
            && sorted[j + 1].port - sorted[j].port <= 2) j++;
        const run = j - i + 1;
        if (run >= 3) out.push({ ...sorted[i], through: sorted[j].port, count: run });
        else for (let k = i; k <= j; k++) out.push(sorted[k]);
        i = j + 1;
    }
    return out;
}

class NetStatWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.network', parent, intervalMs: 8000 });
        // Was its own widget: a flat cloud of every listening socket on the
        // machine, 37 chips deep, with the dev server you actually wanted to
        // open sitting between Spotify and rapportd. Addresses and the things
        // listening on them are one subject, so they are one panel now — and
        // the list is ranked rather than exhaustive.
        this._showAll = false;
        this._conflict = null;
    }

    async tick() {
        if (isSandbox()) { this._renderSandbox(); return; }
        let addrs = [], ports = null;
        try {
            const { data } = await jget('/api/net');
            addrs = (data || []).filter(a => a.family === 'IPv4' || a.family === 4).slice(0, 4);
        } catch (e) { this.setRows([['ERR', e.message]]); return; }
        // Ports are a bonus on top of the addresses: if the scan fails the panel
        // still does the job it did before.
        try { const r = await jget('/api/ports'); ports = r.data; } catch (_) { ports = null; }
        this._render(addrs, ports);
    }

    _render(addrs, data) {
        this.body.replaceChildren();
        // Same row markup setRows() builds, appended rather than replacing, so
        // the addresses and the listeners share one body.
        const kv = (k, v) => $el('div', { class: 'kv' }, [
            $el('span', { class: 'k', text: k }),
            $el('span', { class: 'v', text: v }),
        ]);
        if (!addrs.length) this.body.appendChild(kv('NET', tr('widget.net.empty')));
        for (const a of addrs) this.body.appendChild(kv(a.name.toUpperCase().slice(0, 6), a.address));
        if (!data || !Array.isArray(data.ports)) return;

        this._conflict = data.conflict || null;
        const dev = groupPorts(data.ports.filter(isDevPort));
        const other = data.ports.filter(p => !isDevPort(p));
        const shown = this._showAll ? groupPorts(data.ports) : dev;

        // One header line that says what is here, so the count is information
        // rather than the headline a wall of chips used to make it.
        this.body.appendChild($el('div', { class: 'net-sub' }, [
            $el('span', { class: 'net-sub-k', text: 'LISTENING' }),
            $el('span', { class: 'net-sub-v', text: `${dev.length} dev · ${other.length} other` }),
            // dev.length counts ROWS, not sockets — a collapsed pool is one
            // thing running, which is what the number is there to say.
        ]));

        const list = $el('div', { class: 'port-scan-list' });
        if (!shown.length) {
            list.appendChild($el('div', { class: 'kv', text: 'no dev servers listening' }));
        }
        for (const p of shown) {
            const conflict = data.conflict && p.pid === data.conflict.pid && p.port === data.conflict.port;
            // The port this dashboard is served from is the one entry that is
            // never worth opening, and the most confusing to click by mistake.
            const mine = String(p.port) === String(location.port || '');
            list.appendChild($el('button', {
                class: 'port-scan-row' + (conflict ? ' warn' : '') + (mine ? ' self' : ''),
                type: 'button',
                title: mine ? 'This dashboard' : `Open localhost:${p.port} (${p.process}) in the preview`,
                text: p.through
                    ? `:${p.port}–:${p.through} — ${p.process} · ${p.count} workers`
                    : `:${p.port} — ${p.process}` + (mine ? ' · this dashboard' : ''),
                onclick: async () => {
                    if (mine) return;
                    try {
                        const wp = await import('/assets/previewPanel.js?v=3');
                        wp.openPreviewModal(null, String(p.port));
                    } catch (_) {}
                },
            }));
        }
        this.body.appendChild(list);

        // The rest is one line, not thirty. Expanding is one click and it stays
        // expanded across ticks, so nobody has to fight the 8s refresh.
        if (other.length) {
            this.body.appendChild($el('button', {
                class: 'net-more', type: 'button',
                text: this._showAll
                    ? `hide ${other.length} system listeners`
                    : `show ${other.length} system listeners`,
                onclick: () => { this._showAll = !this._showAll; this._render(addrs, data); },
            }));
        }

        if (data.conflict) {
            this.body.appendChild($el('div', { class: 'port-actions' }, [
                $el('button', {
                    class: 'port-btn port-btn-kill',
                    text: `KILL :${data.conflict.port} (${data.conflict.process})`,
                    onclick: () => this._kill(data.conflict.pid),
                }),
            ]));
        }
    }

    async _kill(pid) {
        try { await jpost('/api/ports/kill', { pid }); this.tick(); }
        catch (e) { this.body.appendChild($el('div', { class: 'port-err', text: e.message })); }
    }

    _renderSandbox() {
        const conn = (navigator && (navigator.connection || navigator.mozConnection || navigator.webkitConnection)) || null;
        const online = typeof navigator.onLine === 'boolean' ? navigator.onLine : null;
        const rows = [
            ['STATE', online == null ? '—' : (online ? 'online' : 'offline'), online === false ? 'warn' : ''],
        ];
        if (conn) {
            if (conn.effectiveType) rows.push(['TYPE', conn.effectiveType.toUpperCase()]);
            if (typeof conn.downlink === 'number') rows.push(['DOWN', `${conn.downlink.toFixed(1)} Mbps`]);
            if (typeof conn.rtt === 'number') rows.push(['RTT', `${conn.rtt} ms`]);
            if (typeof conn.saveData === 'boolean') rows.push(['SAVER', conn.saveData ? 'on' : 'off']);
        } else {
            rows.push(['INFO', tr('widget.sandbox.locked')]);
        }
        this.setRows(rows);
    }
}

class NetChartWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.net_chart', parent, intervalMs: 2000 });
        this._samples = new Array(60).fill(0);
        this._canvas = $el('canvas', { class: 'netchart-canvas', width: 240, height: 60 });
        this._legend = $el('div', { class: 'netchart-legend' });
        this.body.append(this._canvas, this._legend);
        this._lastPingMs = null;
    }
    onLangChange() { this._repaint(this._samples[this._samples.length - 1] || 0); }
    async tick() {
        const started = performance.now();
        let ok = false;
        const probeUrl = isSandbox()
            ? ('/assets/favicon.svg?probe=' + Math.floor(Date.now() / 1000))
            : api('/api/ping');
        try {
            const r = await fetch(probeUrl, { credentials: 'include', cache: 'no-store' });
            ok = r.ok;
        } catch (_) { ok = false; }
        const rtt = performance.now() - started;
        const v = ok ? Math.max(1, 200 - Math.min(200, rtt)) : 0;
        this._samples.push(v);
        if (this._samples.length > 60) this._samples.shift();
        this._repaint(rtt);
    }
    _repaint(rtt) {
        const c = this._canvas;
        const ctx = c.getContext('2d');
        const w = c.width, h = c.height;
        ctx.clearRect(0, 0, w, h);
        const acc = accentRGB();
        ctx.strokeStyle = `rgba(${acc}, 0.9)`;
        ctx.fillStyle = `rgba(${acc}, 0.15)`;
        ctx.lineWidth = 1.5;
        const n = this._samples.length;
        const max = Math.max(1, ...this._samples);
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const x = (i / (n - 1)) * w;
            const y = h - (this._samples[i] / max) * (h - 4) - 2;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fill();
        const rttLabel = rtt ? `${rtt.toFixed(0)} ms` : '—';
        this._legend.textContent = `RTT ${rttLabel}`;
    }
}

class AutoPilotWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.autopilot', parent, intervalMs: 5000 });
    }
    async tick() {
        if (isSandbox()) { this.setRows([['STATUS', 'N/A']]); return; }
        try {
            const data = await jget('/api/autopilot');
            const rows = [];
            const paused = data.paused;
            rows.push(['STATUS', paused ? 'PAUSED' : 'ACTIVE']);
            const active = (data.schedules || []).filter(s => s.enabled);
            rows.push(['SCHEDULES', `${active.length} active`]);
            for (const s of active.slice(0, 3)) {
                const sec = Math.max(0, Math.round((s.intervalMs - (Date.now() - s.lastFired)) / 1000));
                rows.push([`  TAB ${s.tabId}`, `${sec}s`]);
            }
            if (data.orchestrator && data.orchestrator.enabled) {
                rows.push(['ORCHESTRATOR', 'ON']);
            }
            this.setRows(rows);
            this._renderActions(paused);
        } catch (_) {
            this.setRows([['STATUS', 'offline']]);
        }
    }
    _renderActions(paused) {
        let actions = this.el.querySelector('.autopilot-actions');
        if (!actions) {
            actions = $el('div', { class: 'autopilot-actions' });
            this.body.appendChild(actions);
        }
        actions.replaceChildren(
            $el('button', {
                class: 'port-btn',
                text: paused ? 'RESUME' : 'PAUSE',
                onclick: () => this._toggle(paused),
            })
        );
    }
    async _toggle(currentlyPaused) {
        try {
            await jpost(currentlyPaused ? '/api/autopilot/resume' : '/api/autopilot/pause', {});
            this.tick();
        } catch (_) {}
    }
}

// ── MANAGER (automation control panel) ───────────────────────────────────
// One switchboard for everything that can type into a tab on its own: the
// rehydrate auto-resume, boot-resume, the attribution dividers, autopilot,
// plus read-only rows for the manager CLI license and any launchd
// supervisors installed outside the daemon. Backed by /api/automations.
class ManagerPanelWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.manager', helpKey: 'widget.manager.help', parent, intervalMs: 6000 });
    }
    async tick() {
        if (isSandbox()) { this.setRows([['STATUS', 'N/A']]); return; }
        let d;
        try { d = await jget('/api/automations'); } catch (_) { this.setRows([['STATUS', 'offline']]); return; }
        if (!d.ok) { this.setRows([['STATUS', d.error || 'error']]); return; }
        const t = d.toggles || {};
        const toggleBtn = (name, labelKey) => $el('button', {
            class: 'widget-btn' + (t[name] ? '' : ' widget-btn-ghost'),
            text: (t[name] ? '⏻ ' : '○ ') + tr(labelKey) + ' · ' + (t[name] ? 'ON' : 'OFF'),
            onclick: async () => { try { await jpost('/api/automations', { name, enabled: !t[name] }); } catch (_) {} this.tick(); },
        });
        const kv = (k, v) => {
            const r = $el('div', { class: 'kv' });
            r.appendChild($el('span', { class: 'k', text: k }));
            r.appendChild($el('span', { class: 'v', text: v }));
            return r;
        };
        const ap = d.autopilot || {};
        const rows = [
            $el('div', { class: 'widget-note', text: tr('widget.manager.tag') }),
            toggleBtn('autoResume', 'widget.manager.auto_resume'),
            toggleBtn('bootResume', 'widget.manager.boot_resume'),
            toggleBtn('attribution', 'widget.manager.attribution'),
            $el('button', {
                class: 'widget-btn' + (ap.paused ? ' widget-btn-ghost' : ''),
                text: (ap.paused ? '○ ' : '⏻ ') + 'AUTOPILOT · ' + (ap.paused ? 'PAUSED' : 'ACTIVE')
                    + ' · ' + (ap.schedules || 0) + ' SCHED' + (ap.orchestrator ? ' · ORCH' : ''),
                onclick: async () => { try { await jpost(ap.paused ? '/api/autopilot/resume' : '/api/autopilot/pause', {}); } catch (_) {} this.tick(); },
            }),
            kv('MANAGER CLI', d.manager && d.manager.entitled ? 'LICENSED' : 'OFF'),
        ];
        const sup = d.supervisors || [];
        rows.push(kv('SUPERVISORS', sup.length ? String(sup.length) : 'NONE'));
        for (const label of sup.slice(0, 4)) rows.push(kv('  ' + label.replace('com.soa-web.', ''), 'installed'));
        this.body.replaceChildren(...rows);
    }
}

// ── CONSOLE LOG STREAM ──────────────────────────────────────────────────
class ConsoleLogWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.console', parent, intervalMs: 0 });
        this._log = $el('div', { class: 'clog-scroll' });
        this._maxLines = 80;
        this.body.appendChild(this._log);
        this._es = null;
        this._lastSeq = 0;        // high-watermark for de-duping across SSE↔poll
        this._polling = false;
        this._pollTimer = null;
        this._streamWatchdog = null;
    }

    start() {
        super.start();  // registers in _liveWidgets (intervalMs:0 → no poll timer)
        if (isSandbox()) {
            this.body.replaceChildren($el('div', { class: 'widget-note', text: tr('widget.sandbox.backend_needed') }));
            return;
        }
        this._connect();
    }

    // Close the EventSource while the tab is backgrounded to avoid a
    // persistent idle connection (and the 502 spam if the backend is down).
    _suspend() {
        this._clearWatchdog();
        if (this._es) { this._es.close(); this._es = null; }
        this._stopPolling();
    }

    _resume() {
        if (!this._destroyed && !isSandbox() && !this._es && !this._polling) this._connect();
    }

    _connect() {
        if (this._es || this._polling) return;
        this._es = new EventSource(api('/api/logs'));
        // Buffering transports (Cloudflare quick tunnels don't flush
        // event-stream bodies) deliver no events AND never fire onerror — the
        // widget would just hang. The server's `ready` handshake lands on any
        // working stream within a beat; if it doesn't, switch to polling.
        this._streamWatchdog = setTimeout(() => this._fallbackToPolling(), 4000);
        this._es.addEventListener('ready', () => this._clearWatchdog());
        this._es.onmessage = (ev) => {
            this._clearWatchdog();
            try { this._ingest(JSON.parse(ev.data)); } catch (_) {}
        };
        this._es.onerror = () => {
            if (this._es) { this._es.close(); this._es = null; }
            if (this._polling) return;   // already tailing over JSON
            setTimeout(() => { if (!this._destroyed) this._connect(); }, 5000);
        };
    }

    _clearWatchdog() {
        if (this._streamWatchdog) { clearTimeout(this._streamWatchdog); this._streamWatchdog = null; }
    }

    // Tail the server's ring buffer over plain JSON when the SSE handshake
    // never lands (buffering proxy). Deduped by monotonic `seq`.
    _fallbackToPolling() {
        this._streamWatchdog = null;
        if (this._es) { this._es.close(); this._es = null; }
        if (this._polling || this._destroyed) return;
        this._polling = true;
        const pump = async () => {
            if (this._destroyed || !this._polling) { this._stopPolling(); return; }
            try {
                const r = await jget('/api/logs?poll=1');
                for (const entry of (r.data || [])) this._ingest(entry);
            } catch (_) {}
        };
        pump();
        this._pollTimer = setInterval(pump, 4000);
    }

    _stopPolling() {
        this._polling = false;
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    }

    _ingest(entry) {
        if (!entry) return;
        // seq is monotonic; skip anything we've already rendered (handles the
        // SSE ring-replay, poll overlap, and same-ms collisions cleanly).
        if (entry.seq != null) {
            if (entry.seq <= this._lastSeq) return;
            this._lastSeq = entry.seq;
        }
        this._append(entry);
    }

    _append(entry) {
        const time = new Date(entry.ts).toTimeString().slice(0, 8);
        const lvl = entry.level === 'error' ? 'err' : entry.level === 'warn' ? 'wrn' : 'log';
        const line = $el('div', { class: `clog-line clog-${lvl}` }, [
            $el('span', { class: 'clog-ts', text: time }),
            $el('span', { class: 'clog-lvl', text: lvl.toUpperCase() }),
            $el('span', { class: 'clog-msg', text: entry.msg }),
        ]);
        this._log.appendChild(line);
        while (this._log.children.length > this._maxLines) {
            this._log.removeChild(this._log.firstChild);
        }
        this._log.scrollTop = this._log.scrollHeight;
    }

    destroy() {
        this._clearWatchdog();
        if (this._es) { this._es.close(); this._es = null; }
        this._stopPolling();
        super.destroy();
    }
}

// ── INSTALLER ────────────────────────────────────────────────────────────
// One-button install/update for the local backend. Sends the install command
// to the active tab's PTY via SHELL_COMMAND, so the user sees the installer
// run in a real terminal rather than blind-execing in the background.
class InstallerWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.installer', helpKey: 'widget.installer.body', parent, intervalMs: 0 });
        this._cmd = 'curl -fsSL https://www.s0a.app/install.sh | sh';
        this._lastSentAt = 0;
    }
    onLangChange() { this.tick(); }
    _runInActiveTab() {
        const cfg = window.__SOA_WEB__ || {};
        const bridge = cfg._bridge;
        const shell = cfg._shell;
        if (!bridge || !shell || shell.activeId == null) {
            this._setStatus(tr('widget.installer.no_tab'), true);
            return;
        }
        const now = Date.now();
        if (now - this._lastSentAt < 1500) return;
        this._lastSentAt = now;
        bridge.input('shell-command', { id: shell.activeId, line: this._cmd });
        this._setStatus(tr('widget.installer.sent'), false);
    }
    _setStatus(text, isWarn) {
        if (!this._statusEl) return;
        this._statusEl.textContent = text;
        this._statusEl.classList.toggle('widget-note-warn', !!isWarn);
    }
    tick() {
        // Instructions moved to the ⓘ help panel — body stays lean.
        this._statusEl = $el('div', { class: 'widget-note', text: '' });
        this.body.replaceChildren(
            $el('button', {
                class: 'widget-btn',
                text: tr('widget.installer.run'),
                onclick: () => this._runInActiveTab(),
            }),
            this._statusEl,
        );
    }
}

// ── CONTRIBUTE ───────────────────────────────────────────────────────────
// The public repo, surfaced where the likeliest contributors already are —
// people running the app. Star/fork/issue counts come from GitHub's
// unauthenticated API, cached in localStorage for an hour so reload-happy
// sessions never dent the 60-req/hr anonymous quota; the links are static and
// always render, so the widget also works (and matters most) in the s0a.app
// sandbox — no isSandbox() gate.
const CONTRIB_REPO = 'SimonSaysGiveMeSmile/SoA-Web';
const CONTRIB_URL = `https://github.com/${CONTRIB_REPO}`;
const CONTRIB_CACHE_KEY = 'soa-web:contrib-stats';
const CONTRIB_CACHE_MS = 60 * 60 * 1000;

class ContributeWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.contribute', helpKey: 'widget.contribute.help', parent, intervalMs: 0 });
    }

    onLangChange() { this.tick(); }

    tick() {
        this._statsEl = $el('div', { class: 'contrib-stats' });
        this.body.replaceChildren(
            $el('div', { class: 'widget-note', text: tr('widget.contribute.tag') }),
            $el('a', {
                class: 'widget-btn contrib-link', href: CONTRIB_URL,
                target: '_blank', rel: 'noopener noreferrer',
                text: '⧉ ' + CONTRIB_REPO,
            }),
            $el('a', {
                class: 'widget-btn widget-btn-ghost contrib-link', href: `${CONTRIB_URL}/issues/new`,
                target: '_blank', rel: 'noopener noreferrer',
                text: '◉ ' + tr('widget.contribute.issue'),
            }),
            this._statsEl,
        );
        this._fillStats();
    }

    async _fillStats() {
        const stats = await this._stats();
        if (this._destroyed || !stats || !this._statsEl) return;
        this._statsEl.textContent = `★ ${stats.stars}   ⑂ ${stats.forks}   ◉ ${stats.issues}`;
    }

    // Cached repo stats, or null (offline / rate-limited) — links still work.
    async _stats() {
        try {
            const hit = JSON.parse(localStorage.getItem(CONTRIB_CACHE_KEY) || 'null');
            if (hit && Date.now() - hit.at < CONTRIB_CACHE_MS) return hit;
        } catch (_) {}
        try {
            const r = await fetch(`https://api.github.com/repos/${CONTRIB_REPO}`, { headers: { Accept: 'application/vnd.github+json' } });
            if (!r.ok) return null;
            const d = await r.json();
            const stats = { stars: d.stargazers_count, forks: d.forks_count, issues: d.open_issues_count, at: Date.now() };
            try { localStorage.setItem(CONTRIB_CACHE_KEY, JSON.stringify(stats)); } catch (_) {}
            return stats;
        } catch (_) { return null; }
    }
}

// ── Sidebar composition: registry + persisted layout ─────────────────────
// Stable ids → constructors, in default order. Users hide/show and reorder
// these via the CUSTOMIZE panel; the chosen layout persists in localStorage.

// ── PERF ─────────────────────────────────────────────────────────────────
// "Which part is making this slow?" — measured, not guessed.
//
// Frame rate alone cannot answer it: script blocking the main thread and the
// GPU failing to paint look identical from outside, and they need opposite
// fixes. BLOCKED is the discriminator — main-thread time past the 50ms mark
// that the page could not have painted in. High blocked time means JavaScript,
// and the breakdown below names which subsystem spent it; low blocked time
// with low fps means paint, and no amount of script tuning will help.
//
// The probes are inert until this widget is on screen, so the tool cannot be
// the thing it is measuring.
const _ms = n => (n >= 100 ? Math.round(n) : n >= 10 ? n.toFixed(0) : n.toFixed(1)) + 'ms';

class PerfWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.perf', parent, intervalMs: 1000 });
        this._fpsHist = [];
        perfStart();
    }

    destroy() { perfStop(); super.destroy(); }
    _suspend() { perfStop(); super._suspend(); }
    _resume() { perfStart(); super._resume(); }

    tick() {
        const s = perfSnapshot();
        const v = perfVerdict(s);
        const fps = Math.round(s.fps);
        this._fpsHist.push(fps);
        if (this._fpsHist.length > 24) this._fpsHist.shift();

        // Frame rate is the headline, and it is judged against the display, not
        // against 60: a 120Hz panel that manages 60 is dropping every other
        // frame and should not read as green.
        const target = (window.__soaHz && window.__soaHz > 70) ? 120 : 60;
        const fpsCls = fps >= target * 0.85 ? 'ok' : fps >= target * 0.5 ? 'warn' : 'err';

        const rows = [
            ['VERDICT', v.text, v.level === 'bad' ? 'err' : v.level === 'warn' ? 'warn' : 'ok'],
            // Labelled RAF, not FPS, because that is what it counts. The old
            // label promised "frames the page delivered" and a browser will
            // happily hand a page 120 callbacks a second while presenting two —
            // which is how this widget came to read "120 / 120 · smooth" next
            // to a screen that was moving once every ten seconds.
            ['RAF', `${fps} / ${target}`, fpsCls],
            ['BLOCKED', _ms(s.blockedMsPerSec) + '/s',
                s.blockedMsPerSec >= 80 ? 'err' : s.blockedMsPerSec >= 30 ? 'warn' : 'ok'],
            ['STREAM', `${s.kbPerSec.toFixed(0)} KB/s · ${Math.round(s.chunksPerSec)}/s`],
        ];
        // The two rows that separate "the page is slow" from "the terminal is
        // stuck", which every other number here is blind to.
        if (s.termFps != null) {
            const stalled = s.kbPerSec > 0.5 && s.termFps < 1;
            rows.push(['TERM', `${s.termFps.toFixed(1)} draws/s`, stalled ? 'err' : null]);
        }
        // Which renderer the visible terminal ended up with. WebGL can fail
        // quietly — blocklisted driver, a machine under GPU pressure, too many
        // live contexts — and the DOM fallback is the documented slow path, so
        // a terminal that feels like treacle for no visible reason is usually
        // answered right here.
        const diag = typeof window.__soaDiag === 'function' ? window.__soaDiag() : null;
        if (diag) {
            const bad = diag.renderer && diag.renderer !== 'webgl';
            rows.push(['RENDERER', diag.renderer, bad ? 'warn' : 'ok']);
            if (!diag.webglAvailable) rows.push(['WEBGL', 'unavailable', 'err']);
        }
        if (s.heapMb) rows.push(['HEAP', Math.round(s.heapMb) + ' MB']);
        // The terminal's own measurement of itself. A GAP much larger than one
        // cell means the grid is not filling its container — the dead strip on
        // the right — and cellW says whether the fit believed a sane cell size.
        const g = window.__soaGrid;
        if (g) {
            rows.push(['GRID', `${g.cols}x${g.rows} · cell ${g.cellW}px`]);
            rows.push(['GAP', g.gap + 'px', g.gap > g.cellW * 2 ? 'err' : null]);
        }
        if (!s.parts.length) {
            rows.push(['—', 'no measurable js cost']);
        } else {
            // Only the spenders, biggest first. A subsystem costing under a
            // tenth of a millisecond a second is not the reason for anything.
            for (const p of s.parts.slice(0, 6)) {
                rows.push([p.name, _ms(p.msPerSec) + '/s', p.msPerSec >= 50 ? 'warn' : null]);
            }
        }
        this.setRows(rows);
    }
}

function _widgetRegistry() {
    return [
        { id: 'clock',     titleKey: 'widget.clock',       make: p => new ClockWidget({ parent: p }) },
        { id: 'claude',    titleKey: 'widget.claude',      make: p => new ClaudeUsageWidget({ parent: p }) },
        { id: 'installer', titleKey: 'widget.installer',   make: p => new InstallerWidget({ parent: p }) },
        { id: 'globe',     titleKey: 'widget.globe',       make: p => new LocationGlobeWidget({ parent: p }) },
        { id: 'mobile',    titleKey: 'widget.mobile_link', make: (p, c) => new MobileQRWidget({ parent: p, audio: c.audio }) },
        { id: 'sysinfo',   titleKey: 'widget.system',      make: p => new SysInfoWidget({ parent: p }) },
        { id: 'device',    titleKey: 'widget.device',      make: p => new DeviceStatusWidget({ parent: p }) },
        { id: 'cpu',       titleKey: 'widget.cpu',         make: p => new CpuInfoWidget({ parent: p }) },
        { id: 'memory',    titleKey: 'widget.memory',      make: p => new RamWatcherWidget({ parent: p }) },
        { id: 'autopilot', titleKey: 'widget.autopilot',   make: p => new AutoPilotWidget({ parent: p }) },
        { id: 'manager',   titleKey: 'widget.manager',     make: p => new ManagerPanelWidget({ parent: p }) },
        { id: 'console',   titleKey: 'widget.console',     make: p => new ConsoleLogWidget({ parent: p }) },
        { id: 'network',   titleKey: 'widget.network',     make: p => new NetStatWidget({ parent: p }) },
        { id: 'netchart',  titleKey: 'widget.net_chart',   make: p => new NetChartWidget({ parent: p }) },
        { id: 'commits',   titleKey: 'widget.commits',     make: p => new GitCommitsWidget({ parent: p }) },
        { id: 'contribute', titleKey: 'widget.contribute', make: p => new ContributeWidget({ parent: p }) },
        { id: 'perf',      titleKey: 'widget.perf',        make: p => new PerfWidget({ parent: p }) },
    ];
}

const SIDEBAR_LAYOUT_KEY = 'soa-web:sidebar-layout';
const SANDBOX_LAYOUT_KEY = 'soa-web:sidebar-layout-sandbox';   // sandbox keeps its own arrangement
// Merge the saved layout with the registry: keep saved order + on/off, drop
// unknown ids, and append any NEW widgets (on by default) at the end — so a
// new release's widget shows up without wiping the user's arrangement.
function _loadLayout(key, ids) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(key)) || []; } catch (_) {}
    const known = new Set(ids), seen = new Set(), out = [];
    for (const e of Array.isArray(saved) ? saved : []) {
        if (e && known.has(e.id) && !seen.has(e.id)) { out.push({ id: e.id, on: e.on !== false }); seen.add(e.id); }
    }
    for (const id of ids) if (!seen.has(id)) out.push({ id, on: true });
    return out;
}
function _saveLayout(key, layout) { try { localStorage.setItem(key, JSON.stringify(layout)); } catch (_) {} }

// Shared composition for both sidebars: a persistent tools row (CUSTOMIZE
// button) + a host the widgets rebuild into whenever the layout changes.
function _composeSidebar(parent, reg, layoutKey, ctx) {
    const byId = Object.fromEntries(reg.map(w => [w.id, w]));
    const ids = reg.map(w => w.id);
    let layout = _loadLayout(layoutKey, ids);
    let widgets = [];

    const host = $el('div', { class: 'sidebar-widgets' });
    const editBtn = $el('button', {
        class: 'sidebar-edit-btn', text: '⚙ ' + tr('sidebar.customize'),
        onclick: () => _openSidebarManager(reg, layout, next => { layout = next; _saveLayout(layoutKey, layout); build(); }),
    });
    parent.replaceChildren($el('div', { class: 'sidebar-tools' }, [editBtn]), host);

    // One widget must not be able to take out the sidebar.
    //
    // This was a bare map: a widget whose constructor threw ended the whole
    // pass, so every widget BELOW it in the layout silently never mounted. The
    // globe is the realistic trigger — it builds a WebGL scene, and a browser
    // with no GPU context to give (a starved machine, a blocklisted driver)
    // fails right there, taking NETWORK, MANAGER, PERF and everything else down
    // with it. Nothing on screen says so; the sidebar just stops, and it stops
    // exactly when the machine is already in trouble and you most want to look
    // at it. Each widget now fails alone, and says which one did.
    const build = () => {
        widgets.forEach(w => { try { w.destroy(); } catch (_) {} });
        host.replaceChildren();
        widgets = [];
        for (const e of layout.filter(x => x.on)) {
            const def = byId[e.id];
            if (!def) continue;              // a widget that no longer exists
            try { widgets.push(def.make(host, ctx)); }
            catch (err) { console.warn('[soa-web] widget failed to mount:', e.id, err); }
        }
        for (const w of widgets) {
            try { w.start(); } catch (err) { console.warn('[soa-web] widget failed to start:', err); }
        }
    };
    build();

    const relabel = () => { editBtn.textContent = '⚙ ' + tr('sidebar.customize'); };
    window.addEventListener('soa:lang', relabel);
    return {
        destroy: () => { window.removeEventListener('soa:lang', relabel); widgets.forEach(w => w.destroy()); },
        widgets, rebuild: build,
    };
}

export function mountSidebar(parent, ctx = {}) {
    return _composeSidebar(parent, _widgetRegistry(), SIDEBAR_LAYOUT_KEY, ctx);
}

// CUSTOMIZE panel — reorder (↑/↓) + show/hide each widget, applied live so the
// sidebar behind the modal updates as you go. apply(newLayout) persists +
// rebuilds; we keep editing the same working array we hand back.
function _openSidebarManager(reg, layout, apply) {
    const byId = Object.fromEntries(reg.map(w => [w.id, w]));
    let work = layout.map(e => ({ ...e }));

    const backdrop = $el('div', { class: 'soa-modal-backdrop sidebar-mgr-drop' });
    const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

    const listEl = $el('div', { class: 'smgr-list' });
    const commit = () => { apply(work.map(e => ({ ...e }))); render(); };
    const move = (i, d) => { const j = i + d; if (j < 0 || j >= work.length) return; [work[i], work[j]] = [work[j], work[i]]; commit(); };
    // Drag-to-reorder (desktop). Touch devices fall back to the ↑/↓ buttons,
    // which stay for precision + accessibility.
    let dragId = null;
    const clearDropHints = () => listEl.querySelectorAll('.smgr-row').forEach(r => r.classList.remove('drop-above', 'drop-below'));
    const render = () => {
        listEl.replaceChildren(...work.map((e, i) => {
            const w = byId[e.id]; if (!w) return null;
            const row = $el('div', { class: 'smgr-row' + (e.on ? '' : ' off'), draggable: 'true' }, [
                $el('span', { class: 'smgr-grip', title: tr('sidebar.drag'), text: '⠿' }),
                $el('span', { class: 'smgr-name', text: tr(w.titleKey) }),
                $el('span', { class: 'smgr-btns' }, [
                    $el('button', { class: 'smgr-mv', text: '↑', title: tr('sidebar.up'), disabled: i === 0 ? '' : null, onclick: () => move(i, -1) }),
                    $el('button', { class: 'smgr-mv', text: '↓', title: tr('sidebar.down'), disabled: i === work.length - 1 ? '' : null, onclick: () => move(i, 1) }),
                    $el('button', { class: 'smgr-eye' + (e.on ? ' on' : ''), text: e.on ? tr('sidebar.shown') : tr('sidebar.hidden'), onclick: () => { e.on = !e.on; commit(); } }),
                ]),
            ]);
            row.addEventListener('dragstart', ev => { dragId = e.id; row.classList.add('dragging'); try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', e.id); } catch (_) {} });
            row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); clearDropHints(); });
            row.addEventListener('dragover', ev => {
                if (dragId == null || dragId === e.id) return;
                ev.preventDefault();
                const r = row.getBoundingClientRect();
                const below = (ev.clientY - r.top) > r.height / 2;
                clearDropHints();
                row.classList.add(below ? 'drop-below' : 'drop-above');
            });
            row.addEventListener('drop', ev => {
                ev.preventDefault();
                if (dragId == null || dragId === e.id) return;
                const r = row.getBoundingClientRect();
                const below = (ev.clientY - r.top) > r.height / 2;
                const from = work.findIndex(x => x.id === dragId);
                if (from < 0) return;
                const [moved] = work.splice(from, 1);
                let to = work.findIndex(x => x.id === e.id);
                if (to < 0) to = work.length;
                if (below) to += 1;
                work.splice(to, 0, moved);
                commit();
            });
            return row;
        }).filter(Boolean));
    };
    render();

    const panel = $el('div', { class: 'soa-modal sidebar-mgr' }, [
        $el('div', { class: 'soa-modal-title', text: tr('sidebar.customize_title') }),
        $el('div', { class: 'smgr-hint', text: tr('sidebar.customize_hint') }),
        listEl,
        $el('div', { class: 'smgr-foot' }, [
            $el('button', { class: 'widget-btn widget-btn-ghost', text: tr('sidebar.reset'), onclick: () => { work = reg.map(w => ({ id: w.id, on: true })); commit(); } }),
            $el('button', { class: 'widget-btn', text: tr('sidebar.done'), onclick: close }),
        ]),
    ]);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
}

// ── SANDBOX (WC mode) ────────────────────────────────────────────────────
// Static info about the in-browser sandbox. No polling — the values don't
// change during a session. Shown in place of SYSTEM/CPU/etc. when the app
// is running without a backend.
class SandboxInfoWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.sandbox', parent, intervalMs: 0 });
    }
    onLangChange() { this.tick(); }
    tick() {
        this.setRows([
            ['ENGINE', 'WebContainer'],
            ['SHELL', 'jsh'],
            ['FS', tr('widget.sandbox.fs')],
            ['HOST', location.host || '—'],
        ]);
    }
}

// ── LOCAL SETUP (WC mode) ───────────────────────────────────────────────
// Card that explains how to get a real shell and exposes the install
// command + a "connect remote" affordance. ctx.onInstall / ctx.onConnect
// are wired by the WC shell to its modal flows.
class LocalSetupWidget extends Widget {
    constructor({ parent, onInstall, onConnect }) {
        super({ titleKey: 'widget.local', helpKey: 'widget.local.body', parent, intervalMs: 0 });
        this.onInstall = onInstall;
        this.onConnect = onConnect;
    }
    onLangChange() { this.tick(); }
    tick() {
        // Explanation moved to the ⓘ help panel.
        this.body.replaceChildren(
            $el('button', {
                class: 'widget-btn',
                text: tr('widget.local.install'),
                onclick: () => this.onInstall && this.onInstall(),
            }),
            $el('button', {
                class: 'widget-btn widget-btn-ghost',
                text: tr('widget.local.connect'),
                onclick: () => this.onConnect && this.onConnect(),
            }),
        );
    }
}

// Sandbox roster (no backend): LOCAL SETUP + SANDBOX in place of the
// install-only widgets. Each widget detects isSandbox() and renders either
// browser-native data or a "install the backend to see X" empty state.
function _sandboxRegistry() {
    return [
        { id: 'clock',    titleKey: 'widget.clock',       make: p => new ClockWidget({ parent: p }) },
        { id: 'local',    titleKey: 'widget.local',       make: (p, c) => new LocalSetupWidget({ parent: p, onInstall: c.onInstall, onConnect: c.onConnect }) },
        { id: 'globe',    titleKey: 'widget.globe',       make: p => new LocationGlobeWidget({ parent: p }) },
        { id: 'mobile',   titleKey: 'widget.mobile_link', make: (p, c) => new MobileQRWidget({ parent: p, audio: c.audio }) },
        { id: 'sysinfo',  titleKey: 'widget.system',      make: p => new SysInfoWidget({ parent: p }) },
        { id: 'device',   titleKey: 'widget.device',      make: p => new DeviceStatusWidget({ parent: p }) },
        { id: 'cpu',      titleKey: 'widget.cpu',         make: p => new CpuInfoWidget({ parent: p }) },
        { id: 'memory',   titleKey: 'widget.memory',      make: p => new RamWatcherWidget({ parent: p }) },
        { id: 'network',  titleKey: 'widget.network',     make: p => new NetStatWidget({ parent: p }) },
        { id: 'netchart', titleKey: 'widget.net_chart',   make: p => new NetChartWidget({ parent: p }) },
        { id: 'sandbox',  titleKey: 'widget.sandbox',     make: p => new SandboxInfoWidget({ parent: p }) },
        { id: 'contribute', titleKey: 'widget.contribute', make: p => new ContributeWidget({ parent: p }) },
    ];
}

export function mountSandboxSidebar(parent, ctx = {}) {
    // Flag the page as sandbox so every widget's tick() takes its browser-only
    // path and never pokes /api/*. Same customize/reorder/hide + ⓘ machinery as
    // server mode, under its own layout key.
    (window.__SOA_WEB__ = window.__SOA_WEB__ || {})._sandbox = true;
    return _composeSidebar(parent, _sandboxRegistry(), SANDBOX_LAYOUT_KEY, ctx);
}
