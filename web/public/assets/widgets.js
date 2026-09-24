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

import { t as tr } from '/assets/i18n.js?v=32';
import { getSettings, saveSettings, onSettings } from '/assets/settings.js?v=27';
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
// Live token usage for whichever agent is running here — read from the local
// transcripts by /api/claude-usage and /api/codex-usage.
//
// The two agents can be shown in the same shape (two limit gauges, a per-minute
// sparkline, burn / today / model, and the sessions doing the spending) but
// they know different things about themselves, and the widget does not pretend
// otherwise:
//
//   CLAUDE  leads with the 5-hour rolling usage-limit block and a reset
//           countdown. The weekly ceiling is not in the transcripts, so it is
//           estimated against WEEK_LIMIT_USD below. Cost is an API-equivalent
//           estimate, labelled "≈" — a Max/Pro seat is flat-rate.
//   CODEX   leads with the limit windows the API reports back to the client,
//           so the percentages and the reset countdown are MEASURED, not
//           estimated. There is no published rate for the model it runs, so
//           there are no dollars at all rather than invented ones.
//
// The source pills only appear once there is something to switch to; an install
// with no codex sessions looks exactly as it did before.
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
// Claude's window is five hours, so hours+minutes was always enough. codex
// reports a WEEKLY one, and "resets in 126h 6m" is not a thing anyone reads.
const _fmtDur = ms => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    return h ? `${h}h ${m}m` : `${m}m`;
};

class ClaudeUsageWidget extends Widget {
    constructor({ parent }) {
        // 2.5s poll: the server memoizes compute() for 1.2s and tails only
        // appended bytes, so the fast cadence is cheap — the remaining lag is
        // transcript flush timing (a record lands when its message completes).
        super({ titleKey: 'widget.claude', title: 'TOKEN USAGE', parent, intervalMs: 2500 });
        // Which agent is on screen. Remembered, because a fleet that is mostly
        // one of them should not have to re-pick on every load.
        this._source = 'claude';
        try {
            const saved = localStorage.getItem('soa_usage_source');
            if (saved === 'codex' || saved === 'claude') this._source = saved;
        } catch (_) {}
        this._codexSeen = false;
        this._srcBtns = {};
        this._srcRow = $el('div', { class: 'usage-src' }, ['claude', 'codex'].map(k => {
            const b = $el('button', {
                class: 'usage-src-btn', type: 'button',
                text: tr('widget.usage.src_' + k),
                onclick: (e) => { e.stopPropagation(); this._setSource(k); },
            });
            this._srcBtns[k] = b;
            return b;
        }));
        this._srcRow.style.display = 'none';
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
        // Kept so a source switch can relabel the gauges without rebuilding
        // the subtree the sparkline lives in.
        this._headL = this.body.querySelector('.claude-head .claude-head-l');
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
        this._headL = $el('span', { class: 'claude-head-l', text: '5H WINDOW' });
        this._weekHeadL = $el('span', { class: 'claude-head-l', text: 'WEEKLY' });
        this._weekHead = $el('div', { class: 'claude-head claude-head-week' }, [this._weekHeadL, this._weekPct]);
        this._weekBar = $el('div', { class: 'bar claude-bar' }, [this._weekFill]);
        this.body.replaceChildren(
            this._srcRow,
            $el('div', { class: 'claude-head' }, [this._headL, this._reset]),
            $el('div', { class: 'bar claude-bar' }, [this._fill]),
            this._sub,
            this._weekHead,
            this._weekBar,
            this._weekSub,
            this._spark,
            this._burn.row, this._today.row, this._model.row,
            this._sessHead, this._sessList,
        );
    }

    /** Show or hide the second gauge — codex plans do not all have one. */
    _setSecondGauge(on) {
        for (const n of [this._weekHead, this._weekBar, this._weekSub]) {
            if (n) n.style.display = on ? '' : 'none';
        }
    }

    _setSource(src) {
        if (this._source === src) return;
        this._source = src;
        try { localStorage.setItem('soa_usage_source', src); } catch (_) {}
        this._paintSrc();
        this._series = new Array(30).fill(0);
        this.tick();
    }

    // The pills appear only once there is a second source to switch to, so an
    // install that has never run codex is unchanged.
    _paintSrc() {
        this._srcRow.style.display = this._codexSeen ? '' : 'none';
        for (const [k, b] of Object.entries(this._srcBtns)) b.classList.toggle('on', k === this._source);
        if (!this._codexSeen && this._source === 'codex') this._source = 'claude';
    }

    async tick() {
        if (isSandbox()) { this._note(tr('widget.claude.sandbox')); return; }
        // Ask codex once a minute while CLAUDE is on screen: it is what decides
        // whether the switch exists at all, and a 2.5s poll of a source nobody
        // is looking at would be work for nothing. The minute applies to the
        // FAILING case too — on a daemon old enough not to have the endpoint
        // this would otherwise 404 every 2.5s forever, which is the shape of
        // background noise that makes a real error impossible to spot.
        const now = Date.now();
        if (this._source === 'codex' || (now - (this._codexAt || 0)) > 60000) {
            this._codexAt = now;
            try {
                const { data } = await jget('/api/codex-usage');
                this._codex = data;
                this._codexSeen = !!(data && data.available);
            } catch (_) { /* older backend, or no codex on this machine */ }
        }
        this._paintSrc();
        if (this._source === 'codex') { this._renderCodex(this._codex); return; }
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

    // A note replaces the gauges, but never the source pills: "no codex
    // sessions yet" with no way back to CLAUDE is a dead end.
    _note(text) {
        this.body.replaceChildren(this._srcRow, $el('div', { class: 'widget-note', text }));
        this._paintSrc();
    }

    _render(d) {
        // A prior note tick may have detached the structure — re-mount it.
        if (!this.body.contains(this._reset)) this._mountStructure();
        this._headL.textContent = '5H WINDOW';
        this._weekHeadL.textContent = 'WEEKLY';
        this._setSecondGauge(true);
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

    // ── CODEX ───────────────────────────────────────────────────────────
    //
    // The shape is the CLAUDE view's, but almost nothing here is inferred. The
    // gauges are the limit windows the API reports back to codex — used
    // percent, window length and reset time — so they are the real ceiling
    // rather than a calibration guess, and a plan with only one window simply
    // shows one gauge. TODAY is exact too: the transcripts carry a running
    // per-thread total, so a day is one subtraction rather than a sum over
    // records nobody read. What is missing is money, deliberately: there is no
    // published rate for the model this runs, and a made-up one in a column
    // labelled "≈" would be worse than an empty column.
    _renderCodex(d) {
        if (!this.body.contains(this._reset)) this._mountStructure();
        this._paintSrc();
        if (!d || !d.available) { this._note(tr('widget.usage.codex_none')); return; }
        const lim = d.limits || {};
        const gauge = (headL, pctEl, fillEl, subEl, l, sub) => {
            headL.textContent = l ? l.label : 'LIMIT';
            pctEl.textContent = l && l.remainingMs
                ? tr('widget.claude.resets', { t: _fmtDur(l.remainingMs) })
                : (l ? `${Math.round(l.usedPercent)}%` : '—');
            pctEl.classList.toggle('warn', !!l && l.usedPercent >= 80);
            fillEl.style.width = `${l ? Math.min(100, l.usedPercent) : 0}%`;
            fillEl.classList.toggle('hot', !!l && l.usedPercent >= 80);
            subEl.textContent = sub;
        };
        const plan = (d.planType || '').replace(/_/g, ' ');
        gauge(this._headL, this._reset, this._fill, this._sub, lim.primary,
            lim.primary
                ? `${Math.round(lim.primary.usedPercent)}% used · ${plan || tr('widget.usage.codex_limit')}`
                : tr('widget.usage.codex_limit'));
        this._setSecondGauge(!!lim.secondary);
        if (lim.secondary) {
            gauge(this._weekHeadL, this._weekPct, this._weekFill, this._weekSub, lim.secondary,
                `${Math.round(lim.secondary.usedPercent)}% used`);
        }
        this._burn.v.textContent = `${_fmtTok(d.burnRatePerMin)} ${tr('widget.claude.tokmin')}`;
        // Tokens in, tokens out — both exact, both from the cumulative
        // counters. Not a request count: see requestsSeen in codexUsage.js for
        // why there isn't an honest one to put here.
        const today = (d.today && d.today.tokens) || { total: 0, output: 0 };
        this._today.v.textContent = `${_fmtTok(today.total)} · ${_fmtTok(today.output)} out`;
        const top = (d.models || [])[0];
        this._model.v.textContent = top ? top.name : '—';
        this._renderCodexSessions(d);
        this._series = (d.series || []).slice(-30);
        this._paintSpark();
    }

    _renderCodexSessions(d) {
        // A day with nothing on it still has sessions worth naming, so the
        // column follows whichever scope actually has numbers in it — and once
        // it is TODAY, a row with nothing today is not a top session.
        const all = (d.sessions || []).filter(s => s.today.tok > 0 || s.total.tok > 0);
        const anyToday = all.some(s => s.today.tok > 0);
        const rows = (anyToday ? all.filter(s => s.today.tok > 0) : all).slice(0, 6);
        if (!rows.length) {
            this._sessHead.style.display = 'none';
            this._sessList.style.display = 'none';
            this._sessList.replaceChildren();
            return;
        }
        this._sessHead.style.display = '';
        this._sessList.style.display = '';
        this._sessHead.textContent = 'TOP SESSIONS · ' + (anyToday ? 'TODAY' : tr('widget.usage.total'));
        this._sessList.replaceChildren(...rows.map(s => {
            const label = (s.project || '?') + ' · ' + (s.shortId || '?');
            const tok = anyToday ? s.today.tok : s.total.tok;
            const tip = [
                (s.project || '?') + ' — ' + (s.model || '?'),
                `today: ${_fmtTok(s.today.tok)} tok · ${_fmtTok(s.today.out)} out · ${_fmtTok(s.today.cached)} cached`,
                `thread total: ${_fmtTok(s.total.tok)} tok · ${_fmtTok(s.total.out)} out`,
            ];
            if (s.ctxPct != null) tip.push(`context: ${_fmtTok(s.ctxTokens)} (${s.ctxPct}% of the window)`);
            if (d.partialHistory) tip.push(tr('widget.usage.codex_partial'));
            return $el('div', { class: 'claude-sess-row' + (s.ctxPct >= 85 ? ' hot' : ''), title: tip.join('\n') }, [
                $el('span', { class: 'claude-sess-name', text: label }),
                $el('span', {
                    class: 'claude-sess-val',
                    text: _fmtTok(tok) + (s.ctxPct != null ? ` · ${s.ctxPct}% ${tr('widget.usage.ctx')}` : ''),
                }),
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

// ── DEVICE STATUS ────────────────────────────────────────────────────────
class DeviceStatusWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.device', parent, intervalMs: 10_000 });
    }
    async tick() {
        if (isSandbox()) { this._renderSandbox(); return; }
        try {
            const { data } = await jget('/api/device');
            const rows = [
                ['ONLINE', data.online ? 'yes' : 'no', data.online ? '' : 'warn'],
            ];
            if (data.battery != null) {
                const pct = `${data.battery}%`;
                rows.push(['BATTERY', data.charging ? `${pct} ↑` : pct, data.battery < 20 ? 'warn' : '']);
            }
            if (data.batteryHealth != null) rows.push(['BAT HEALTH', `${data.batteryHealth}%`, data.batteryHealth < 80 ? 'warn' : '']);
            if (data.batteryCycles != null) rows.push(['CYCLES', data.batteryCycles]);
            if (data.cpuTemp != null) rows.push(['CPU TEMP', `${data.cpuTemp}°C`, data.cpuTemp > 90 ? 'warn' : '']);
            this.setRows(rows);
        } catch (e) { this.setRows([['ERR', e.message]]); }
    }
    _renderSandbox() {
        const conn = navigator && (navigator.connection || navigator.mozConnection || navigator.webkitConnection);
        const rows = [
            ['ONLINE', navigator.onLine ? 'yes' : 'no', navigator.onLine ? '' : 'warn'],
        ];
        if (conn && conn.effectiveType) rows.push(['TYPE', conn.effectiveType.toUpperCase()]);
        const bat = navigator.getBattery ? null : undefined;
        if (bat === null) {
            navigator.getBattery().then(b => {
                this.setRows([
                    ...rows,
                    ['BATTERY', `${Math.round(b.level * 100)}%${b.charging ? ' ↑' : ''}`, b.level < 0.2 ? 'warn' : ''],
                ]);
            }).catch(() => this.setRows(rows));
            return;
        }
        this.setRows(rows);
    }
}

// ── GIT COMMITS ──────────────────────────────────────────────────────────
class GitCommitsWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.commits', parent, intervalMs: 30_000 });
    }
    async tick() {
        if (isSandbox()) { this.setRows([['GIT', tr('widget.sandbox.backend_needed')]]); return; }
        try {
            const { data } = await jget('/api/git?limit=6');
            if (!data.ok) { this.setRows([['GIT', data.error || tr('widget.git.unavailable')]]); return; }
            const rows = data.commits.map(c => [c.hash, c.subject.slice(0, 36)]);
            if (!rows.length) rows.push(['GIT', tr('widget.git.empty')]);
            this.setRows(rows);
        } catch (e) { this.setRows([['ERR', e.message]]); }
    }
}

// ── MOBILE QR ────────────────────────────────────────────────────────────
class MobileQRWidget extends Widget {
    constructor({ parent, audio }) {
        // Poll every 6s so when the server brings up the Cloudflare tunnel
        // automatically (SOA_WEB_AUTOPAIR), the QR fills in without any click.
        super({ titleKey: 'widget.mobile_link', parent, intervalMs: 6000 });
        this.audio = audio;
        this._lastState = 'idle';
        this._lastSnap = null;
        this._render('idle', null);
    }

    onLangChange() { this._render(this._lastState, this._lastSnap); }

    _render(state, snap) {
        this._lastState = state;
        this._lastSnap = snap;
        const lanList = (snap && snap.lan) || [];
        const pubUrl  = snap && snap.publicUrl;
        // QR + URLs only appear while pairing is online. When off (idle/error/
        // starting), render the empty placeholder so the user knows the
        // tunnel isn't live.
        const target  = state === 'online' ? (pubUrl || lanList[0] || null) : null;

        function pairUrl(backendUrl) {
            const token = (snap && snap.pairToken) || currentToken();
            const u = new URL('/m/', backendUrl);
            u.searchParams.set('backend', backendUrl);
            if (token) u.searchParams.set('t', token);
            return u.toString();
        }

        // "Simulate device" — opens the REAL mobile client (/m/) in a phone-sized
        // popup window: a genuine browser context (WS, fetch, service worker, the
        // lot) pointed at the same backend a phone would use, so the desktop↔mobile
        // bridge can be tested live without a real phone or an Xcode simulator.
        // Always available (the local bridge works even with the tunnel off); it
        // only connects when the user clicks, so it never interferes on its own.
        const simUrl = () => {
            const backend = currentBackend();
            const token = (snap && snap.pairToken) || currentToken();
            const u = new URL('/m/', backend);
            u.searchParams.set('backend', backend);
            if (token) u.searchParams.set('t', token);
            return u.toString();
        };
        const SIM_TAB = 'mobile-sim';
        const SIM_VW = 1024, SIM_VH = 768; // the managed browser's CDP viewport
        const callBrowser = (body) => fetch(api('/api/agent-browser'), {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(r => r.json());

        const openSim = () => {
            const url = simUrl();
            // Self-contained, always-visible modal. Clicking SIM ALWAYS shows
            // this — it doesn't depend on the shell, the active view, the WS
            // bridge, popups, or framing rules (the reasons earlier versions did
            // "nothing"). It renders the AGENT's managed browser (a separate,
            // independent Chromium the agent drives via soa-browser) by polling
            // its screenshots over the SAME /api the dashboard already uses, and
            // forwards taps as clicks — so it never touches the shared PTYs and
            // it's the exact instance the agent controls.
            document.getElementById('soa-mobile-sim-modal')?.remove();
            let alive = true;
            const shot = $el('img', { class: 'msim-shot', alt: 'mobile device' });
            const statusEl = $el('span', { class: 'msim-status', text: 'launching…' });
            const closeBtn = $el('button', { class: 'msim-x', text: '×', title: 'Close' });
            const frame = $el('div', { class: 'msim-frame' }, [
                $el('div', { class: 'msim-bar' }, [
                    $el('span', { class: 'msim-title', text: '📱 MOBILE · agent-controlled' }),
                    statusEl, closeBtn,
                ]),
                shot,
            ]);
            const backdrop = $el('div', { class: 'msim-backdrop', id: 'soa-mobile-sim-modal' }, [frame]);
            const onEsc = (e) => { if (e.key === 'Escape') close(); };
            function close() { alive = false; backdrop.remove(); document.removeEventListener('keydown', onEsc); }
            closeBtn.onclick = close;
            backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
            document.addEventListener('keydown', onEsc);
            document.body.appendChild(backdrop);

            // Tap → click in the managed browser, scaled from the rendered frame.
            shot.addEventListener('click', (e) => {
                const r = shot.getBoundingClientRect();
                if (!r.width || !r.height) return;
                const x = Math.round((e.clientX - r.left) / r.width * SIM_VW);
                const y = Math.round((e.clientY - r.top) / r.height * SIM_VH);
                callBrowser({ action: 'click', tab: SIM_TAB, x, y }).catch(() => {});
            });

            const poll = async () => {
                if (!alive) return;
                try {
                    const j = await callBrowser({ action: 'screenshot', tab: SIM_TAB });
                    if (alive && j && j.data) { shot.src = 'data:image/jpeg;base64,' + j.data; statusEl.textContent = 'live · tap to interact'; }
                } catch (_) {}
                if (alive) setTimeout(poll, 1200);
            };
            callBrowser({ action: 'navigate', tab: SIM_TAB, url })
                .then(() => { statusEl.textContent = 'connecting…'; poll(); })
                .catch((e) => { statusEl.textContent = 'launch failed — ' + (e && e.message || e); });
        };
        const simBtn = $el('button', {
            class: 'mqr-toggle mqr-sim',
            text: '📱 SIM',
            title: 'Open the mobile client in a phone-sized window to test the bridge live',
            onclick: openSim,
        });

        const actions = state === 'online'
            ? [
                simBtn,
                $el('button', {
                    class: 'mqr-toggle mqr-restart',
                    text: tr('mqr.restart'),
                    onclick: () => this._restart(),
                }),
                $el('button', {
                    class: 'mqr-toggle mqr-off',
                    text: tr('mqr.off'),
                    onclick: () => this._stop(),
                }),
            ]
            : [
                simBtn,
                $el('button', {
                    class: 'mqr-toggle mqr-start',
                    text: state === 'starting' ? '…' : tr('mqr.start'),
                    onclick: () => this._start(),
                    disabled: state === 'starting' ? true : null,
                }),
            ];

        // First-time setup on a fresh machine: the server auto-downloads
        // cloudflared during START and narrates progress via /api/pair/status
        // — surface it so a ~20 MB one-time fetch doesn't look like a hang.
        const prog = state === 'starting' && snap && snap.progress;
        const progText = prog
            ? `${tr('mqr.provisioning')} ${prog.pct}% (${prog.receivedMB}/${prog.totalMB} MB)`
            : null;

        this.body.replaceChildren(
            $el('div', { class: `mqr-status mqr-${state}` }, [
                $el('span', { class: 'mqr-dot' }),
                $el('span', { text: tr(`mqr.state.${state}`) }),
            ]),
            progText ? $el('div', { class: 'mqr-note', text: progText }) : '',
            $el('div', { class: 'mqr-qr' }, target
                ? [$el('img', { class: 'mqr-img', src: api(`/api/pair/qr?text=${encodeURIComponent(pairUrl(target))}`), alt: 'pairing QR' })]
                : [$el('div', { class: 'mqr-empty', text: state === 'starting' ? tr('mqr.empty_starting') : tr('mqr.empty') })]),
            $el('div', { class: 'mqr-urls' },
                state === 'online'
                    ? lanList.slice(0, 1).concat(pubUrl ? [pubUrl] : []).map((u, i) =>
                        $el('div', { class: 'mqr-url' }, [
                            $el('span', { class: 'mqr-tag', text: i === 0 && lanList.length ? 'LAN' : 'PUB' }),
                            $el('span', { class: 'mqr-u',   text: u }),
                            $el('button', {
                                class: 'mqr-copy', text: tr('mqr.copy'),
                                onclick: (e) => {
                                    const btn = e.currentTarget;
                                    const url = pairUrl(u);
                                    const done = () => { btn.textContent = '✓'; setTimeout(() => { btn.textContent = tr('mqr.copy'); }, 1400); };
                                    if (navigator.clipboard && navigator.clipboard.writeText) {
                                        navigator.clipboard.writeText(url).then(done, () => { btn.textContent = tr('mqr.copy'); });
                                    } else {
                                        const ta = document.createElement('textarea');
                                        ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
                                        document.body.appendChild(ta); ta.select();
                                        try { document.execCommand('copy'); done(); } catch (_) {}
                                        document.body.removeChild(ta);
                                    }
                                },
                            }),
                        ]),
                    )
                    : [],
            ),
            $el('div', { class: 'mqr-actions' }, actions),
            snap && snap.error ? $el('div', { class: 'mqr-err', text: snap.error }) : '',
        );
    }

    async tick() {
        if (isSandbox()) { this._renderBackendNeeded(); return; }
        try {
            const { data } = await jget('/api/pair/status');
            this._render(data.state, data);
        } catch (e) { /* ignore polling failures */ }
    }

    _renderBackendNeeded() {
        this.body.replaceChildren(
            $el('div', { class: 'widget-note', text: tr('mqr.sandbox_hint') }),
        );
    }

    async _start() {
        this._render('starting', null);
        if (this.audio) this.audio.play('scan');
        try {
            const { data } = await jpost('/api/pair/start', {});
            this._render(data.state, data);
            if (data.state === 'online' && this.audio) this.audio.play('granted');
            if (data.state === 'error' && this.audio) this.audio.play('denied');
        } catch (e) {
            this._render('error', { error: e.message });
        }
    }

    async _stop() {
        try {
            const { data } = await jpost('/api/pair/stop', {});
            this._render(data.state, data);
            if (this.audio) this.audio.play('panels');
        } catch (e) { /* ignore */ }
    }

    async _restart() {
        // Stop, then start. Render the transient 'starting' state so the
        // button doesn't flash a misleading 'OFF' between calls.
        this._render('starting', this._lastSnap);
        if (this.audio) this.audio.play('scan');
        try { await jpost('/api/pair/stop', {}); } catch (_) {}
        try {
            const { data } = await jpost('/api/pair/start', {});
            this._render(data.state, data);
            if (data.state === 'online' && this.audio) this.audio.play('granted');
            if (data.state === 'error' && this.audio) this.audio.play('denied');
        } catch (e) {
            this._render('error', { error: e.message });
        }
    }
}

// ── WORLD VIEW (globe) ───────────────────────────────────────────────────
// Ports desktop/src/classes/locationGlobe.class.js to the browser. The
// encom-globe bundle is ~1MB and needs THREE + a ~1MB grid.json tile mesh,
// so we load all three lazily the first time this widget mounts and share
// them across any future mounts. Polls /api/geo for the server's public
// lat/lon and drops a single pin there.
let _globeAssetsPromise = null;
function _loadScript(src) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-src="${src}"]`);
        if (existing) { existing.addEventListener('load', resolve); existing.addEventListener('error', reject); return; }
        const s = document.createElement('script');
        s.src = src; s.async = false;
        s.dataset.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('failed to load ' + src));
        document.head.appendChild(s);
    });
}
async function _loadGlobeAssets() {
    if (_globeAssetsPromise) return _globeAssetsPromise;
    _globeAssetsPromise = (async () => {
        // three.js first (encom expects window.THREE). Pinned to r77 — the
        // last version whose API surface encom-globe targets (the fork predates
        // three's ES-modules transition and expects the globals namespace).
        // Hosted locally under /assets/vendor/ so COEP: credentialless doesn't
        // need a CORP header from a CDN — one less failure mode in production.
        if (!window.THREE) {
            await _loadScript('/assets/vendor/three.min.js?v=12');
        }
        if (!window.ENCOM || !window.ENCOM.Globe) {
            await _loadScript('/assets/vendor/encom-globe.js?v=12');
        }
        const gridResp = await fetch('/assets/vendor/grid.json?v=12', { credentials: 'same-origin' });
        if (!gridResp.ok) throw new Error('grid.json ' + gridResp.status);
        const grid = await gridResp.json();
        return { grid };
    })();
    return _globeAssetsPromise;
}

class LocationGlobeWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.globe', parent, intervalMs: 30_000 });
        this._canvasHost = $el('div', { class: 'globe-canvas' });
        this._meta = $el('div', { class: 'globe-meta', text: '—' });
        this.body.append(this._canvasHost, this._meta);
        this._pin = null;
        this._userPin = null;
        this._lastLoc = null;
        this._lastUserLoc = null;
        this._offscreen = false;  // set by IntersectionObserver in _boot
        this._geoFails = 0;       // consecutive /api/geo failures (backoff)
        this._geoNextAt = 0;      // epoch ms before which tick() skips the fetch
        this._peerPins = new Map(); // "lat,lon" -> globe pin for each connected client
        this._peerCount = null;   // total connected clients (null until first poll)
        this._onUserLocation = e => this.setUserLocation(e.detail.lat, e.detail.lon, e.detail.name || 'You');
        window.addEventListener('soa:user-location', this._onUserLocation);
        this._bootPromise = this._boot();
    }

    onLangChange() { this._refreshMeta(this._lastGeo || null); }

    async _boot() {
        try {
            const { grid } = await _loadGlobeAssets();
            if (this._destroyed) return;
            // Encom measures the host by offsetWidth/Height synchronously, so
            // it must be in the DOM and painted before we instantiate.
            await new Promise(r => requestAnimationFrame(r));
            // destroy() can land during the await above (tab-switch / WS
            // reconnect re-mounts the sidebar); bail before wiring up the globe,
            // resize listener and IntersectionObserver onto a dead widget.
            if (this._destroyed) return;
            const w = this._canvasHost.offsetWidth || 240;
            const h = this._canvasHost.offsetHeight || 200;
            const tron = `rgb(${accentRGB()})`;
            this.globe = new window.ENCOM.Globe(w, h, {
                font: 'Fira Mono, ui-monospace, Menlo, monospace',
                data: [],
                tiles: grid.tiles,
                baseColor: tron,
                markerColor: tron,
                pinColor: tron,
                satelliteColor: tron,
                scale: 1.1,
                viewAngle: 0.630,
                dayLength: 1000 * 45,
                introLinesDuration: 2000,
                introLinesColor: tron,
                maxPins: 32,
                maxMarkers: 32,
            });
            this._canvasHost.appendChild(this.globe.domElement);
            // Clear color follows the active UI language's surface token.
            const clearBg = (getComputedStyle(document.documentElement).getPropertyValue('--soa-bg') || '#05080d').trim() || '#05080d';
            this.globe.init(clearBg, () => { this._tickAnim(); });
            this._onResize = () => {
                if (!this.globe || !this.globe.camera || !this.globe.renderer) return;
                const c = this._canvasHost;
                this.globe.camera.aspect = c.offsetWidth / c.offsetHeight;
                this.globe.camera.updateProjectionMatrix();
                this.globe.renderer.setSize(c.offsetWidth, c.offsetHeight);
            };
            window.addEventListener('resize', this._onResize);
            // Decorative satellites so the globe isn't empty before /api/geo
            // answers. Mirrors the 6-satellite constellation from the desktop
            // app, but deterministic — no RNG so every reload looks identical.
            const sats = [];
            for (let i = 0; i < 2; i++) {
                for (let j = 0; j < 3; j++) {
                    sats.push({ lat: 50 * i - 15, lon: 120 * j - 120, altitude: 1.5 });
                }
            }
            this.globe.addConstellation(sats);
            // Pause the render loop when the globe scrolls out of the sidebar
            // viewport (the heaviest continuous cost shouldn't run unseen).
            try {
                this._io = new IntersectionObserver((entries) => {
                    const e = entries[entries.length - 1];
                    this._offscreen = !(e && e.isIntersecting);
                    if (!this._offscreen) this._kickAnim();
                }, { threshold: 0.01 });
                this._io.observe(this._canvasHost);
            } catch (_) { this._offscreen = false; }
        } catch (e) {
            this._canvasHost.replaceChildren($el('div', { class: 'globe-err', text: tr('widget.globe.unavailable') + ': ' + e.message }));
        }
    }

    // Decoration runs at decoration's frame rate. A slowly turning globe is
    // indistinguishable at 24fps and at 60, and the terminal shares both the
    // main thread and the GPU with it.
    static ANIM_MS = 42;          // ~24fps
    // And it stops entirely while the terminal is being scrolled or typed in.
    // Nothing decorative is worth a dropped frame in the thing you are reading.
    static YIELD_MS = 300;
    // And it SETTLES. Measured on this install: the daemon at 2% of a core
    // pushing 10 KB/s, and the dashboard's renderer at 26% and 736 MB — the page
    // was spending a quarter of a core with almost nothing arriving. A three.js
    // scene at 24fps is the largest standing cost in it, and it was running
    // forever, by design: it yields to a gesture and then spins the entire time
    // you are simply reading. Decoration is worth frames while you are here and
    // nothing at all once you are not, so after this long with no interaction
    // the loop STOPS — not a cheaper frame, no frame, and no rAF callback
    // either. Any interaction brings it back.
    static SETTLE_MS = 20_000;
    // Escape hatch, matching the renderer's: localStorage.setItem('soa.globe',
    // 'off') and reload, for anyone who would rather have the core back.
    static disabled() {
        try { return localStorage.getItem('soa.globe') === 'off'; } catch (_) { return false; }
    }

    _tickAnim() {
        this._rafId = null;
        if (this._destroyed) return;
        // The globe is pure decoration — don't spin a WebGL loop while the page
        // is backgrounded or the canvas is scrolled out of view. _kickAnim
        // restarts it when it becomes visible again.
        if (document.hidden || this._offscreen) return;
        // A spinning globe is the clearest thing on the page to give up when the
        // page is not getting frames. app.js's LoadGuard publishes that as a
        // one-word global rather than wiring an event bus through a decoration.
        if (window.__soaLoad === 'high') { this._rafId = requestAnimationFrame(() => this._tickAnim()); return; }
        const now = performance.now();
        const idleFor = now - (window.__soaLastInteract || 0);
        // Settled: stop the loop entirely and wait to be woken. _armWake costs
        // one passive listener, against a WebGL draw every 42ms forever.
        if (idleFor > LocationGlobeWidget.SETTLE_MS) { this._armWake(); return; }
        const busy = idleFor < LocationGlobeWidget.YIELD_MS;
        if (!busy && now - (this._lastFrame || 0) >= LocationGlobeWidget.ANIM_MS) {
            this._lastFrame = now;
            try { this.globe.tick(); } catch (_) {}
        }
        this._rafId = requestAnimationFrame(() => this._tickAnim());
    }

    // One-shot listeners that restart the animation on the next sign of life.
    // Registered only while settled, removed the moment they fire, so the page
    // is not carrying input handlers for a decoration it is not drawing.
    _armWake() {
        if (this._wake || this._destroyed) return;
        const wake = () => {
            this._disarmWake();
            this._kickAnim();
        };
        this._wake = wake;
        for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel']) {
            window.addEventListener(ev, wake, { passive: true, capture: true, once: true });
        }
    }

    _disarmWake() {
        if (!this._wake) return;
        for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel']) {
            window.removeEventListener(ev, this._wake, { capture: true });
        }
        this._wake = null;
    }

    _kickAnim() {
        if (this._destroyed || this._rafId || !this.globe) return;
        if (document.hidden || this._offscreen) return;
        if (LocationGlobeWidget.disabled()) return;
        this._disarmWake();
        this._tickAnim();
    }

    _suspend() {
        super._suspend();
        this._disarmWake();
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    }

    _resume() {
        super._resume();
        this._kickAnim();
    }

    async tick() {
        if (isSandbox()) { this._renderSandbox(); return; }
        // Multiuser peer pins refresh every tick (~30s), independent of the geo
        // throttle below — clients connect/disconnect far more often than the
        // server's own egress location changes.
        this._refreshPeers();
        // /api/geo reports the server's public IP/location — effectively static.
        // Once we have a fix, recheck only every ~10 min; on failure (e.g. the
        // upstream 502s) back off exponentially instead of retrying every cycle.
        const now = Date.now();
        if (this._geoNextAt && now < this._geoNextAt) return;
        try {
            const { data } = await jget('/api/geo');
            this._lastGeo = data;
            this._placePin(data);
            this._refreshMeta(data);
            this._geoFails = 0;
            this._geoNextAt = now + 10 * 60_000;
        } catch (e) {
            this._geoFails++;
            // Keep the last good location on screen; only show "unavailable" if
            // we never managed to get one.
            if (!this._lastGeo) this._meta.textContent = tr('widget.globe.unavailable');
            this._geoNextAt = now + Math.min(10 * 60_000, 30_000 * 2 ** this._geoFails);
        }
    }

    _renderSandbox() {
        // Browser geolocation is user-gated. Don't prompt silently — render
        // a "show my location" button once, and on click request a single
        // position, then pin it. The globe keeps spinning meanwhile so the
        // widget looks alive even if the user never grants permission.
        if (this._geoAttempted) return;
        if (!navigator.geolocation) { this._meta.textContent = tr('widget.globe.geo_unsupported'); return; }
        if (this._lastGeo) { this._refreshMeta(this._lastGeo); return; }
        this._meta.replaceChildren(
            $el('span', { class: 'globe-meta-note', text: tr('widget.globe.geo_hint') + ' ' }),
            $el('button', {
                class: 'globe-meta-btn', text: tr('widget.globe.geo_btn'),
                onclick: () => this._requestBrowserGeo(),
            }),
        );
    }

    _requestBrowserGeo() {
        if (this._geoAttempted) return;
        this._geoAttempted = true;
        this._meta.textContent = tr('widget.globe.geo_pending');
        navigator.geolocation.getCurrentPosition(pos => {
            const geo = {
                ip: null, city: null, region: null, country: null, org: null,
                lat: pos.coords.latitude, lon: pos.coords.longitude,
            };
            this._lastGeo = geo;
            this._placePin(geo);
            this._refreshMeta(geo);
        }, err => {
            this._meta.textContent = tr('widget.globe.geo_denied');
        }, { timeout: 10_000, maximumAge: 10 * 60_000 });
    }

    _placePin(geo) {
        if (!this.globe || !geo || geo.lat == null || geo.lon == null) return;
        const key = `${geo.lat.toFixed(3)},${geo.lon.toFixed(3)}`;
        if (this._lastLoc === key) return;
        try {
            if (this._pin && typeof this._pin.remove === 'function') this._pin.remove();
            this._pin = this.globe.addPin(geo.lat, geo.lon, geo.city || '', 1.2);
            this._lastLoc = key;
        } catch (_) { /* globe not fully ready yet */ }
    }

    setUserLocation(lat, lon, name) {
        if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return;
        const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
        if (this._lastUserLoc === key) return;
        this._lastUserLoc = key;
        // Update meta text below the globe with user location
        const coord = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
        const label = name ? `${name}  ·  ${coord}` : coord;
        if (!this.globe) {
            // Globe still booting — place the pin once boot resolves
            this._bootPromise.then(() => this._placeUserPin(lat, lon, name)).catch(() => {});
            return;
        }
        this._placeUserPin(lat, lon, name);
    }

    _placeUserPin(lat, lon, name) {
        if (!this.globe) return;
        try {
            if (this._userPin && typeof this._userPin.remove === 'function') this._userPin.remove();
            // Slightly larger pin than server location so it's visually distinct
            this._userPin = this.globe.addPin(lat, lon, `▲ ${name || 'You'}`, 1.8);
        } catch (_) {}
    }

    // Pin every connected client on the globe (multiuser). /api/geo/peers returns
    // one city-level entry per distinct public IP (LAN/localhost clients arrive
    // as a single "self" cluster at the server location, which the server pin
    // already marks, so we skip drawing it here). Pins are diffed by rounded
    // coord so unchanged peers aren't churned each poll.
    async _refreshPeers() {
        if (!this.globe || this._destroyed) return;
        let data;
        try { ({ data } = await jget('/api/geo/peers')); }
        catch (_) { return; }
        const peers = (data && data.peers) || [];
        const want = new Map();
        for (const p of peers) {
            if (p.self || p.lat == null || p.lon == null) continue;
            want.set(`${p.lat.toFixed(2)},${p.lon.toFixed(2)}`, p);
        }
        for (const [k, pin] of this._peerPins) {
            if (want.has(k)) continue;
            try { if (pin && pin.remove) pin.remove(); } catch (_) {}
            this._peerPins.delete(k);
        }
        for (const [k, p] of want) {
            if (this._peerPins.has(k)) continue;
            try {
                const label = (p.city || p.country || 'peer') + (p.count > 1 ? ` ×${p.count}` : '');
                this._peerPins.set(k, this.globe.addPin(p.lat, p.lon, label, 1.0));
            } catch (_) { /* globe not ready yet — retried next poll */ }
        }
        this._peerCount = (data && typeof data.total === 'number')
            ? data.total
            : peers.reduce((n, p) => n + (p.count || 1), 0);
        this._refreshMeta(this._lastGeo || null);
    }

    _refreshMeta(geo) {
        let base = '—';
        if (geo) {
            const place = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || '—';
            const coord = (geo.lat != null && geo.lon != null)
                ? `${geo.lat.toFixed(2)}, ${geo.lon.toFixed(2)}`
                : '—';
            base = `${place}  ·  ${coord}`;
        }
        const online = (this._peerCount != null)
            ? `  ·  ${this._peerCount} ${tr('widget.globe.online')}`
            : '';
        this._meta.textContent = base + online;
    }

    destroy() {
        if (this._rafId) cancelAnimationFrame(this._rafId);
        // A settled globe is holding wake listeners rather than a rAF loop, so
        // cancelling the frame alone would leave them on window forever.
        this._disarmWake();
        if (this._io) { try { this._io.disconnect(); } catch (_) {} this._io = null; }
        if (this._onResize) window.removeEventListener('resize', this._onResize);
        if (this._onUserLocation) window.removeEventListener('soa:user-location', this._onUserLocation);
        for (const pin of this._peerPins.values()) { try { if (pin && pin.remove) pin.remove(); } catch (_) {} }
        this._peerPins.clear();
        try { if (this.globe && this.globe.domElement) this.globe.domElement.remove(); } catch (_) {}
        super.destroy();
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

// ── VOICE CONTROL ───────────────────────────────────────────────────────
// Hands-free terminal control. The widget is presentational: VoiceControl
// (assets/voice-control.js) owns recognition + wake word, VoiceCommands owns
// what an intent DOES, VoiceAudio owns device routing, VoiceVision owns the
// camera. This file wires the four together and draws the panel.
class VoiceControlWidget extends Widget {
    // intervalMs is 0 (event-driven), but the audio sub-panel owns a poll of
    // its own — route the shared visibility hooks to it so a collapsed sidebar
    // or a backgrounded tab stops the system_profiler spawns like every other
    // polling widget.
    _suspend() { if (this.audioPanel) this.audioPanel.pause(); }
    _resume() { if (this.audioPanel && this._audioSec && this._audioSec.open) this.audioPanel.resume(); }

    constructor({ parent, ctx }) {
        super({ titleKey: 'widget.voice', helpKey: 'widget.voice.body', parent, intervalMs: 0 });
        this.ctx = ctx || {};
        this.voice = null;
        this.cmd = null;
        this.audioPanel = null;
        this.vision = null;
        this._init();
    }

    _init() {
        if (typeof VoiceControl === 'undefined') {
            this.body.innerHTML = '<div class="voice-hint voice-hint--warn">voice-control.js did not load.</div>';
            return;
        }
        this.voice = new VoiceControl();

        if (!this.voice.supported) {
            this.body.innerHTML =
                '<div class="voice-hint voice-hint--warn">This browser has no speech recognition. ' +
                'Try a browser with speech recognition, or use keyboard dictation in the terminal.</div>';
            return;
        }

        if (typeof VoiceCommands !== 'undefined') {
            this.cmd = new VoiceCommands({ voice: this.voice, api });
            this.cmd.onLog = (line) => this._log(line);
        }

        // Route anything the local parser can't place through the daemon's
        // headless model, with the open tabs as context so "the iPlan repo"
        // resolves to a real tab id.
        this.voice.interpretRemote = async (transcript) => {
            const tabs = this.cmd ? await this.cmd.tabs() : [];
            // The control registry rides along so the model picks a real
            // actionId instead of inventing one — the client owns that list,
            // so shipping it beats keeping a second copy on the server.
            const controls = typeof voiceActionMenu === 'function' ? voiceActionMenu() : [];
            const r = await fetch(api('/api/voice/interpret'), {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ transcript, tabs, controls }),
            });
            if (!r.ok) return null;
            return r.json();
        };

        this._render();
        this._wire();
        this._syncFromServer();
    }

    // Wake word + model toggle live on the daemon too, so the phone and the
    // desktop agree and a restart keeps them.
    async _syncFromServer() {
        try {
            const j = await jget('/api/voice/config');
            if (!j || !j.config) return;
            const c = j.config;
            if (c.wakeWord) this.voice.set('wakeWord', c.wakeWord);
            if (c.wakeMode) this.voice.set('wakeMode', c.wakeMode);
            if (typeof c.interpret === 'boolean') this.voice.set('useModel', c.interpret);
            this._reflectSettings();
        } catch (_) { /* daemon predates the endpoint — local settings stand */ }
    }

    async _pushConfig(patch) {
        try {
            await fetch(api('/api/voice/config'), {
                method: 'POST', credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(patch),
            });
        } catch (_) {}
    }

    _render() {
        const s = this.voice.settings;
        this.body.innerHTML = '';

        this._indicator = $el('div', { class: 'voice-indicator voice-indicator--off' });
        this._statusText = $el('span', { class: 'voice-status-text', text: 'Off' });
        const status = $el('div', { class: 'voice-status', role: 'status', 'aria-live': 'polite' }, [this._indicator, this._statusText]);

        this._startBtn = $el('button', { class: 'voice-btn voice-btn--start', type: 'button', text: '🎤 Listen' });
        this._stopBtn = $el('button', { class: 'voice-btn voice-btn--stop', type: 'button', text: '⏹ Stop' });
        this._stopBtn.style.display = 'none';
        const controls = $el('div', { class: 'voice-controls' }, [this._startBtn, this._stopBtn]);

        this._transcript = $el('div', { class: 'voice-transcript' }, [
            $el('small', { text: 'Say "' + s.wakeWord + '", then a command.' }),
        ]);

        // ── settings ──
        this._wakeInput = $el('input', { type: 'text', class: 'voice-input', value: s.wakeWord, spellcheck: 'false' });
        this._modeSel = $el('select', { class: 'voice-select' }, [
            $el('option', { value: 'wake', text: 'Wake word' }),
            $el('option', { value: 'always', text: 'Always on' }),
        ]);
        this._modeSel.value = s.wakeMode;
        this._verbSel = $el('select', { class: 'voice-select' }, [
            $el('option', { value: 'brief', text: 'Brief' }),
            $el('option', { value: 'detailed', text: 'Detailed' }),
        ]);
        this._verbSel.value = this.voice.verbosity;
        this._rateInput = $el('input', { type: 'range', class: 'voice-range', min: '0.6', max: '2', step: '0.1', value: String(s.rate) });
        this._rateVal = $el('span', { class: 'voice-rate-value', text: Number(s.rate).toFixed(1) + '×' });
        this._modelChk = $el('input', { type: 'checkbox', class: 'voice-check' });
        this._modelChk.checked = !!s.useModel;

        const settings = $el('details', { class: 'voice-settings' }, [
            $el('summary', { text: 'Voice settings' }),
            $el('div', { class: 'voice-settings-body' }, [
                row('Wake phrase', this._wakeInput),
                row('Mode', this._modeSel),
                row('Read back', this._verbSel),
                row('Speed', $el('div', { class: 'voice-row' }, [this._rateInput, this._rateVal])),
                row('Understand free speech', this._modelChk),
                $el('div', { class: 'voice-hint' },
                    'Free speech that matches no built-in phrase is sent to Claude (Haiku) through your Claude Code login, with your open tab names and project names, to be turned into a command. Turn it off to stay on the built-in phrase list and send nothing.'),
            ]),
        ]);

        // ── audio devices ──
        this._audioBody = $el('div', { class: 'voice-audio-body' });
        const audioSec = $el('details', { class: 'voice-settings' }, [
            $el('summary', { text: 'Headset & audio' }),
            this._audioBody,
        ]);
        audioSec.addEventListener('toggle', () => {
            if (typeof VoiceAudio === 'undefined') return;
            if (!audioSec.open) { if (this.audioPanel) this.audioPanel.pause(); return; }
            if (this.audioPanel) { this.audioPanel.resume(); return; }
            // No mic prompt here: opening a disclosure is not a reason to ask
            // for the microphone. Listen asks when the user actually starts.
            this.audioPanel = new VoiceAudio({ api, onStatus: (m) => this._log(m) });
            this.audioPanel.mount(this._audioBody);
        });
        this._audioSec = audioSec;

        // ── what can I say ──
        // Voice is undiscoverable without this: nothing on screen tells you
        // the phrases exist. Rendered from the same registry that executes
        // them, so the list can never advertise a command that doesn't work.
        this._phrasesBody = $el('div', { class: 'voice-phrases-body' });
        const phrasesSec = $el('details', { class: 'voice-settings' }, [
            $el('summary', { text: 'What can I say' }),
            this._phrasesBody,
        ]);
        phrasesSec.addEventListener('toggle', () => {
            if (phrasesSec.open && !this._phrasesReady) this._renderPhrases();
        });

        // ── vision ──
        this._visionBody = $el('div', { class: 'voice-vision-body' });
        const visionSec = $el('details', { class: 'voice-settings' }, [
            $el('summary', { text: 'Camera & glasses' }),
            this._visionBody,
        ]);
        visionSec.addEventListener('toggle', () => {
            if (visionSec.open && !this._visionReady) this._renderVision();
        });

        this.body.appendChild(status);
        this.body.appendChild(controls);
        this.body.appendChild(this._transcript);
        this.body.appendChild(settings);
        this.body.appendChild(phrasesSec);
        this.body.appendChild(audioSec);
        this.body.appendChild(visionSec);

        function row(label, control) {
            return $el('label', { class: 'voice-setting' }, [$el('span', { text: label }), control]);
        }
    }

    _wire() {
        this._startBtn.addEventListener('click', () => {
            if (this.voice.start()) {
                this._log(this.voice.settings.wakeMode === 'wake'
                    ? 'Say “' + this.voice.settings.wakeWord + ', next tab” or open “What can I say”.'
                    : 'Listening for commands. Open “What can I say” for examples.');
            }
        });
        this._stopBtn.addEventListener('click', () => {
            this.voice.stop();
            this._stopBtn.style.display = 'none';
            this._startBtn.style.display = '';
        });

        this._wakeInput.addEventListener('change', () => {
            const w = this._wakeInput.value.trim().toLowerCase() || 'hey anton';
            this._wakeInput.value = w;
            this.voice.setWakeWord(w);
            this._pushConfig({ wakeWord: w });
            this._log('Wake phrase: "' + w + '"');
        });
        this._modeSel.addEventListener('change', () => {
            this.voice.set('wakeMode', this._modeSel.value);
            this._pushConfig({ wakeMode: this._modeSel.value });
        });
        this._verbSel.addEventListener('change', () => this.voice.setVerbosity(this._verbSel.value));
        this._rateInput.addEventListener('input', () => {
            const r = Number(this._rateInput.value);
            this.voice.setRate(r);
            this._rateVal.textContent = r.toFixed(1) + '×';
        });
        this._modelChk.addEventListener('change', () => {
            this.voice.set('useModel', this._modelChk.checked);
            this._pushConfig({ interpret: this._modelChk.checked });
        });

        this.voice.onStatusChange = (st) => this._paintStatus(st);
        this.voice.onTranscript = (text, m) => {
            if (m.final) this._log('“' + text + '”');
            else this._log('… ' + text, true);
        };
        this.voice.onCommand = (intent, params, meta) => {
            this._log('▸ ' + intent + (meta && meta.source === 'model' ? ' (model)' : ''));
            if (this.cmd) this.cmd.handle(intent, params, meta);
            else this.voice.speak('Terminal control is not loaded.');
        };
        this.voice.onError = (err) => this._log('⚠ ' + (err.message || err.error), false, true);
    }

    _reflectSettings() {
        if (!this._wakeInput) return;
        const s = this.voice.settings;
        this._wakeInput.value = s.wakeWord;
        this._modeSel.value = s.wakeMode;
        this._modelChk.checked = !!s.useModel;
    }

    _paintStatus(st) {
        if (!this._indicator) return;
        // Voice can switch itself off (mic denied, or eight failures in a
        // row). The buttons are toggled in the click handlers, so mirror the
        // real state here or "Tap Listen to retry" points at a hidden button.
        if (this._startBtn && this._stopBtn) {
            this._startBtn.style.display = st.enabled ? 'none' : '';
            this._stopBtn.style.display = st.enabled ? '' : 'none';
        }
        let cls = 'off', text = 'Off';
        if (st.speaking) { cls = 'speaking'; text = 'Speaking'; }
        else if (st.thinking) { cls = 'thinking'; text = 'Thinking…'; }
        else if (st.enabled && st.awake) { cls = 'awake'; text = 'Listening — go ahead'; }
        else if (st.enabled && st.listening) { cls = 'listening'; text = 'Waiting for "' + st.wakeWord + '"'; }
        else if (st.enabled) { cls = 'ready'; text = 'Starting…'; }
        this._indicator.className = 'voice-indicator voice-indicator--' + cls;
        this._statusText.textContent = text;
        if (this.ctx.onVoiceStatus) this.ctx.onVoiceStatus(st, text);
    }

    _log(line, interim, warn) {
        if (!this._transcript) return;
        const small = $el('small', { text: line });
        if (warn) small.style.color = 'var(--soa-red, #ff6b6b)';
        if (interim) small.style.opacity = '0.55';
        this._transcript.innerHTML = '';
        this._transcript.appendChild(small);
    }

    // ── "what can I say" panel ────────────────────────────────────────────
    _renderPhrases() {
        this._phrasesReady = true;
        const el = this._phrasesBody;
        el.innerHTML = '';

        // Terminal commands are hand-written because they take arguments the
        // registry's fixed phrases can't express.
        const terminal = [
            ['Read output', 'read the output · what is happening · any errors'],
            ['Work', 'run npm test · type <text> · press enter · continue · stop'],
            ['Agent', 'change model to opus · how is my usage · how are the agents'],
            ['Navigate', 'go to the <name> project · go to tab 3 · next tab'],
            ['Free speech', 'help me finish the migration · take a look at the failing tests'],
            ['Voice', 'be brief · be detailed · go to sleep'],
        ];
        el.appendChild($el('div', { class: 'voice-sec-title', text: 'Terminal' }));
        for (const [name, phrases] of terminal) {
            el.appendChild($el('div', { class: 'voice-phrase' }, [
                $el('b', { text: name }), $el('span', { text: phrases }),
            ]));
        }

        if (typeof voiceActionGroups !== 'function') return;
        for (const [group, actions] of voiceActionGroups()) {
            el.appendChild($el('div', { class: 'voice-sec-title', text: group }));
            for (const a of actions) {
                // Clicking a row runs it — the list doubles as a button panel,
                // which is what you want when the room is too loud to talk.
                const row = $el('div', { class: 'voice-phrase voice-phrase--run' }, [
                    $el('b', { text: a.label }),
                    $el('span', { text: a.phrases.slice(0, 3).join(' · ') }),
                ]);
                row.addEventListener('click', () => {
                    if (this.cmd) this.cmd.handle('app_action', { actionId: a.id }, { source: 'click' });
                });
                el.appendChild(row);
            }
        }
    }

    // ── vision panel ──────────────────────────────────────────────────────
    async _renderVision() {
        this._visionReady = true;
        const el = this._visionBody;
        if (typeof VoiceVision === 'undefined') {
            el.innerHTML = '<div class="voice-hint voice-hint--warn">voice-vision.js did not load.</div>';
            return;
        }
        this.vision = new VoiceVision({ api });

        let status = {};
        try { status = await this.vision.watchStatus(); } catch (_) {}
        const cams = await this.vision.cameras().catch(() => []);

        el.innerHTML = '';

        // 1. Live camera / UVC glasses.
        const camSel = $el('select', { class: 'voice-select' },
            (cams.length ? cams : [{ deviceId: '', label: 'No camera detected' }]).map(c =>
                $el('option', { value: c.deviceId, text: (c.glasses ? '👓 ' : '') + c.label })));
        const shoot = $el('button', { class: 'voice-mini', type: 'button', text: '📷 Capture → agent' });
        shoot.addEventListener('click', async () => {
            this.vision.deviceId = camSel.value || null;
            this._log('Capturing…');
            try {
                const shot = (await this.vision.capture({})) || (await this.vision.captureViaFilePicker());
                if (!shot) return this._log('No image captured.', false, true);
                const tabId = this.cmd ? this.cmd.activeId : null;
                const j = await this.vision.sendToTab(shot.blob, tabId, 'Look at this image.');
                this._log('Sent ' + (j.name || 'image') + ' to the agent.');
            } catch (e) { this._log('Capture failed: ' + e.message, false, true); }
        });
        el.appendChild($el('div', { class: 'voice-sec-title', text: 'Camera' }));
        el.appendChild(camSel);
        el.appendChild($el('div', { class: 'voice-row' }, [shoot]));

        // 2. Watch folder — the Meta Ray-Ban route.
        el.appendChild($el('div', { class: 'voice-sec-title', text: 'Glasses photo sync' }));
        const dirInput = $el('input', {
            type: 'text', class: 'voice-input', spellcheck: 'false',
            placeholder: '~/Pictures/Meta View',
            value: status.watching || '',
        });
        const enable = $el('input', { type: 'checkbox', class: 'voice-check' });
        enable.checked = !!status.enabled;
        const apply = async () => {
            const r = await this.vision.setWatch({
                enabled: enable.checked,
                watchDir: dirInput.value.trim(),
                targetTab: null,
                prompt: 'Look at this image and tell me what you see.',
            }).catch(e => ({ ok: false, error: e.message }));
            if (r && r.watch && r.watch.ok === false) this._log('Watch failed: ' + r.watch.error, false, true);
            else this._log(enable.checked ? 'Watching ' + dirInput.value : 'Watch off.');
        };
        enable.addEventListener('change', apply);
        dirInput.addEventListener('change', apply);
        el.appendChild($el('label', { class: 'voice-setting' }, [$el('span', { text: 'Auto-ingest new photos' }), enable]));
        el.appendChild(dirInput);
        for (const s of (status.suggestions || [])) {
            const b = $el('button', { class: 'voice-mini', type: 'button', text: s.replace(/^.*\//, '') });
            b.title = s;
            b.addEventListener('click', () => { dirInput.value = s; apply(); });
            el.appendChild(b);
        }
        el.appendChild($el('div', { class: 'voice-hint' },
            'Meta Ray-Bans have no camera API. Point this at the folder their photos sync into ' +
            '(Meta AI app → iCloud Photos → a synced folder) and every new picture is handed to the ' +
            'agent by path. Glasses that expose a plain USB camera appear in the Camera list above.'));
    }

    destroy() {
        if (this.voice) this.voice.stop();
        if (this.audioPanel) this.audioPanel.destroy();
        super.destroy();
    }
}

// One voice session for the page, independent of sidebar layout/rebuilds.
// Opening the panel only reveals controls; Listen requests the microphone.
let _voiceToolbar = null;
export function mountVoiceToolbar(ctx = {}) {
    const button = document.getElementById('toggle-voice');
    if (!button) return null;
    if (_voiceToolbar) return _voiceToolbar;

    let widget = null;
    const panel = $el('section', {
        id: 'voice-panel', class: 'voice-panel', role: 'dialog',
        'aria-label': 'Voice controls', tabindex: '-1',
    });
    panel.hidden = true;
    const closeBtn = $el('button', {
        type: 'button', class: 'voice-panel-close', text: '×',
        'aria-label': 'Close voice controls', title: 'Close voice controls (Escape)',
    });
    panel.appendChild(closeBtn);
    const host = $el('div', { class: 'voice-panel-body' });
    panel.appendChild(host);
    panel.appendChild($el('p', { class: 'voice-hint voice-panel-hint',
        text: 'Closing this panel keeps the mic on. Choose Stop to end listening.' }));
    (document.getElementById('shell') || document.body).appendChild(panel);

    const activity = () => {
        if (!widget) return;
        if (panel.hidden || document.hidden) widget._suspend();
        else widget._resume();
    };
    const close = (restoreFocus = false) => {
        panel.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        activity();
        if (restoreFocus) button.focus();
    };
    const open = () => {
        if (!widget && !isSandbox()) {
            widget = new VoiceControlWidget({ parent: host, ctx: { ...ctx,
                onVoiceStatus: (st, status) => {
                    button.dataset.state = st.enabled ? 'on' : 'off';
                    const label = 'Voice controls — ' + (st.enabled ? status : 'microphone off');
                    button.title = label;
                    button.setAttribute('aria-label', label);
                    button.querySelector('.voice-toggle-label').textContent = st.enabled ? 'VOICE ON' : 'VOICE';
                },
            } });
        } else if (isSandbox()) {
            host.textContent = 'Connect to your terminal server to use voice controls.';
        }
        panel.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        activity();
        const primary = widget?.voice?.isEnabled ? widget._stopBtn : widget?._startBtn;
        (primary || closeBtn).focus();
    };
    const toggle = () => panel.hidden ? open() : close(true);
    const outside = e => {
        if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) close();
    };
    const keydown = e => {
        if (!panel.hidden && e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close(true);
        }
    };
    const focusout = e => {
        if (e.relatedTarget && !panel.contains(e.relatedTarget) && !button.contains(e.relatedTarget)) close();
    };
    button.addEventListener('click', toggle);
    closeBtn.addEventListener('click', () => close(true));
    panel.addEventListener('focusout', focusout);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('visibilitychange', activity);
    _voiceToolbar = { open, close, destroy() {
        close();
        widget?.destroy();
        panel.remove();
        button.removeEventListener('click', toggle);
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('keydown', keydown, true);
        document.removeEventListener('visibilitychange', activity);
        _voiceToolbar = null;
    } };
    return _voiceToolbar;
}

class VoiceLauncherWidget extends Widget {
    constructor({ parent, ctx }) {
        super({ titleKey: 'widget.voice', parent, intervalMs: 0 });
        this.body.appendChild($el('button', { type: 'button', class: 'voice-btn',
            text: 'Open voice controls', onclick: () => ctx.voiceToolbar?.open() }));
        this.body.appendChild($el('div', { class: 'voice-hint',
            text: 'Also available from the microphone button at the top right.' }));
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
        { id: 'voice',     titleKey: 'widget.voice',       make: (p, c) => new VoiceLauncherWidget({ parent: p, ctx: c }) },
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
    const voiceToolbar = mountVoiceToolbar(ctx);
    const sidebar = _composeSidebar(parent, _widgetRegistry(), SIDEBAR_LAYOUT_KEY, { ...ctx, voiceToolbar });
    return { ...sidebar, destroy() { sidebar.destroy(); voiceToolbar?.destroy(); } };
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
    const voiceToolbar = mountVoiceToolbar(ctx);
    const sidebar = _composeSidebar(parent, _sandboxRegistry(), SANDBOX_LAYOUT_KEY, ctx);
    return { ...sidebar, destroy() { sidebar.destroy(); voiceToolbar?.destroy(); } };
}
