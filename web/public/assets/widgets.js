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

import { t as tr } from '/assets/i18n.js?v=21';
import { getSettings } from '/assets/settings.js?v=24';

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
    constructor({ title, titleKey, parent, intervalMs }) {
        this.titleKey = titleKey || null;
        this.title = titleKey ? tr(titleKey) : title;
        this.intervalMs = intervalMs || 0;
        // The '// ' prefix is applied via CSS ::before (sidebar.css) so the
        // MINIMAL UI language can drop it without touching this text node.
        this._titleEl = $el('span', { class: 'widget-title', text: this.title });
        this.root = $el('section', { class: 'widget' }, [
            $el('header', { class: 'widget-h' }, [
                this._titleEl,
                $el('span', { class: 'widget-pulse' }),
            ]),
            $el('div', { class: 'widget-body' }),
        ]);
        this.body = this.root.querySelector('.widget-body');
        parent.appendChild(this.root);
        this._timer = null;
        this._destroyed = false;
        this._langOff = null;
        if (this.titleKey) {
            const retitle = () => {
                this.title = tr(this.titleKey);
                this._titleEl.textContent = this.title;
                if (typeof this.onLangChange === 'function') this.onLangChange();
            };
            window.addEventListener('soa:lang', retitle);
            this._langOff = () => window.removeEventListener('soa:lang', retitle);
        }
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
class ClockWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.clock', parent, intervalMs: 1000 });
    }
    tick() {
        const now = new Date();
        const hours12 = getSettings().clockHours === 12;
        const time = hours12
            ? now.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' })
            : now.toTimeString().slice(0, 8);
        const date = now.toISOString().slice(0, 10);
        const utc = now.toUTCString().slice(17, 25);
        this.setRows([
            ['LOCAL', time],
            ['DATE', date],
            ['UTC', utc],
        ]);
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
            const tip = [
                (s.project || '?') + ' — ' + (s.slug || s.shortId || ''),
                `5h window: ${_fmtTok(b.tok)} tok · ≈${_fmtUsd(b.cost)} · ${b.req || 0} req`,
                `today: ${_fmtTok(t.tok)} tok · ≈${_fmtUsd(t.cost)} · ${t.req || 0} req`,
            ];
            if (t.subCost > 0.01) tip.push(`of which subagents today: ≈${_fmtUsd(t.subCost)}`);
            return $el('div', { class: 'claude-sess-row', title: tip.join('\n') }, [
                $el('span', { class: 'claude-sess-name', text: label }),
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
        this._bar = $el('div', { class: 'bar' }, [$el('span', { class: 'bar-fill' })]);
        this.body.appendChild(this._bar);
    }
    async tick() {
        if (isSandbox()) { this._renderSandbox(); return; }
        try {
            const { data } = await jget('/api/ram');
            this._bar.querySelector('.bar-fill').style.width = `${data.usedPct}%`;
            this.setRows([
                ['USED', fmtBytes(data.used)],
                ['FREE', fmtBytes(data.free)],
                ['TOTAL', fmtBytes(data.total)],
                ['LOAD', `${data.usedPct.toFixed(1)}%`, data.usedPct > 85 ? 'warn' : ''],
            ]);
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
class NetStatWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.network', parent, intervalMs: 8000 });
    }
    async tick() {
        if (isSandbox()) { this._renderSandbox(); return; }
        try {
            const { data } = await jget('/api/net');
            const ipv4 = data.filter(a => a.family === 'IPv4' || a.family === 4).slice(0, 4);
            if (!ipv4.length) { this.setRows([['NET', tr('widget.net.empty')]]); return; }
            this.setRows(ipv4.map(a => [a.name.toUpperCase().slice(0, 6), a.address]));
        } catch (e) { this.setRows([['ERR', e.message]]); }
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
            const backend = backendBase();
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

    _tickAnim() {
        this._rafId = null;
        if (this._destroyed) return;
        // The globe is pure decoration — don't spin a 60fps WebGL loop while the
        // page is backgrounded or the canvas is scrolled out of view. _kickAnim
        // restarts it when it becomes visible again.
        if (document.hidden || this._offscreen) return;
        try { this.globe.tick(); } catch (_) {}
        this._rafId = requestAnimationFrame(() => this._tickAnim());
    }

    _kickAnim() {
        if (this._destroyed || this._rafId || !this.globe) return;
        if (document.hidden || this._offscreen) return;
        this._tickAnim();
    }

    _suspend() {
        super._suspend();
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
        if (this._io) { try { this._io.disconnect(); } catch (_) {} this._io = null; }
        if (this._onResize) window.removeEventListener('resize', this._onResize);
        if (this._onUserLocation) window.removeEventListener('soa:user-location', this._onUserLocation);
        for (const pin of this._peerPins.values()) { try { if (pin && pin.remove) pin.remove(); } catch (_) {} }
        this._peerPins.clear();
        try { if (this.globe && this.globe.domElement) this.globe.domElement.remove(); } catch (_) {}
        super.destroy();
    }
}

// ── NETWORK TRAFFIC CHART ───────────────────────────────────────────────
// Lean port of desktop/src/classes/conninfo.class.js. /api/net only ships
// interface names and addresses, not counters — so we sample the browser's
// `navigator.connection` where available, and otherwise fall back to a
// round-trip-time probe of /api/ping as a crude "we have network" pulse.
// When the sampled host supports systeminformation, a future /api/netstat
// endpoint can replace the probe with real tx/rx rates.
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

// ── PORT SCANNER ────────────────────────────────────────────────────────
class PortScanWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.ports', title: 'PORTS', parent, intervalMs: 5000 });
        this._conflict = null;
        this._summary = null;
    }
    async tick() {
        if (isSandbox()) { this.setRows([['SCAN', 'N/A (sandbox)']]); return; }
        try {
            const { data } = await jget('/api/ports');
            this._conflict = data.conflict;

            // Add summary banner at the top for at-a-glance view
            const summary = $el('div', { class: 'port-summary' });
            const count = data.ports.length;
            const countLabel = count === 1 ? '1 active port' : `${count} active ports`;
            const countEl = $el('div', {
                class: 'port-summary-count',
                text: countLabel
            });
            summary.appendChild(countEl);

            if (data.conflict) {
                const conflictEl = $el('div', {
                    class: 'port-summary-conflict',
                    text: `⚠ Port ${data.conflict.port} conflict`
                });
                summary.appendChild(conflictEl);
            }

            this.body.replaceChildren();
            this.body.appendChild(summary);

            // Clickable list of EVERY port → opens it in the preview (proxied via
            // /preview/<port>/, localhost-only so it's safe). Non-web ports just
            // render whatever they serve.
            const portList = $el('div', { class: 'port-scan-list' });
            if (!data.ports.length) {
                portList.appendChild($el('div', { class: 'kv', text: 'no listeners' }));
            } else {
                for (const p of data.ports) {
                    const isConflict = data.conflict && p.pid === data.conflict.pid && p.port === data.conflict.port;
                    portList.appendChild($el('button', {
                        class: 'port-scan-row' + (isConflict ? ' warn' : ''),
                        type: 'button',
                        title: `Open localhost:${p.port} (${p.process}) in the preview`,
                        text: `:${p.port} — ${p.process}`,
                        onclick: async () => {
                            try { const wp = await import('/assets/previewPanel.js?v=3'); wp.openPreviewModal(null, String(p.port)); }
                            catch (_) {}
                        },
                    }));
                }
            }
            this.body.appendChild(portList);

            if (data.conflict) {
                const actions = $el('div', { class: 'port-actions' });
                const killBtn = $el('button', {
                    class: 'port-btn port-btn-kill',
                    text: `KILL :${data.conflict.port} (${data.conflict.process})`,
                    onclick: () => this._kill(data.conflict.pid),
                });
                actions.appendChild(killBtn);
                this.body.appendChild(actions);
            }
        } catch (e) { this.setRows([['ERR', e.message]]); }
    }
    async _kill(pid) {
        try {
            await jpost('/api/ports/kill', { pid });
            this.tick();
        } catch (e) {
            this.body.appendChild($el('div', { class: 'port-err', text: e.message }));
        }
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

// ── CONSOLE LOG STREAM ──────────────────────────────────────────────────
class ConsoleLogWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.console', parent, intervalMs: 0 });
        this._log = $el('div', { class: 'clog-scroll' });
        this._maxLines = 80;
        this.body.appendChild(this._log);
        this._es = null;
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
        if (this._es) { this._es.close(); this._es = null; }
    }

    _resume() {
        if (!this._destroyed && !this._es && !isSandbox()) this._connect();
    }

    _connect() {
        if (this._es) return;
        this._es = new EventSource(api('/api/logs'));
        this._es.onmessage = (ev) => {
            try {
                const entry = JSON.parse(ev.data);
                this._append(entry);
            } catch (_) {}
        };
        this._es.onerror = () => {
            this._es.close();
            this._es = null;
            setTimeout(() => { if (!this._destroyed) this._connect(); }, 5000);
        };
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
        if (this._es) { this._es.close(); this._es = null; }
        super.destroy();
    }
}

// ── INSTALLER ────────────────────────────────────────────────────────────
// One-button install/update for the local backend. Sends the install command
// to the active tab's PTY via SHELL_COMMAND, so the user sees the installer
// run in a real terminal rather than blind-execing in the background.
class InstallerWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.installer', parent, intervalMs: 0 });
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
        this._statusEl = $el('div', { class: 'widget-note', text: '' });
        this.body.replaceChildren(
            $el('div', { class: 'widget-note', text: tr('widget.installer.body') }),
            $el('button', {
                class: 'widget-btn',
                text: tr('widget.installer.run'),
                onclick: () => this._runInActiveTab(),
            }),
            this._statusEl,
        );
    }
}

export function mountSidebar(parent, ctx = {}) {
    const widgets = [
        new ClockWidget({ parent }),
        new ClaudeUsageWidget({ parent }),
        new InstallerWidget({ parent }),
        new LocationGlobeWidget({ parent }),
        new MobileQRWidget({ parent, audio: ctx.audio }),
        new SysInfoWidget({ parent }),
        new DeviceStatusWidget({ parent }),
        new CpuInfoWidget({ parent }),
        new RamWatcherWidget({ parent }),
        new PortScanWidget({ parent }),
        new AutoPilotWidget({ parent }),
        new ConsoleLogWidget({ parent }),
        new NetStatWidget({ parent }),
        new NetChartWidget({ parent }),
        new GitCommitsWidget({ parent }),
    ];
    widgets.forEach(w => w.start());
    return {
        destroy: () => widgets.forEach(w => w.destroy()),
        widgets,
    };
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
        super({ titleKey: 'widget.local', parent, intervalMs: 0 });
        this.onInstall = onInstall;
        this.onConnect = onConnect;
    }
    onLangChange() { this.tick(); }
    tick() {
        this.body.replaceChildren(
            $el('div', { class: 'widget-note', text: tr('widget.local.body') }),
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

export function mountSandboxSidebar(parent, ctx = {}) {
    // Flag the page as sandbox so every widget's tick() takes its
    // browser-only path and never pokes /api/*. Flipping this to false
    // after an install would re-animate the sidebar against localhost,
    // but today we simply reload into server mode instead (see app.js).
    (window.__SOA_WEB__ = window.__SOA_WEB__ || {})._sandbox = true;
    // Same widget roster as server mode so the sidebar looks consistent
    // before and after the user installs a local backend. Each widget
    // detects isSandbox() and renders either browser-native data or a
    // helpful "install the backend to see X" empty state.
    const widgets = [
        new ClockWidget({ parent }),
        new LocalSetupWidget({
            parent,
            onInstall: ctx.onInstall,
            onConnect: ctx.onConnect,
        }),
        new LocationGlobeWidget({ parent }),
        new MobileQRWidget({ parent, audio: ctx.audio }),
        new SysInfoWidget({ parent }),
        new DeviceStatusWidget({ parent }),
        new CpuInfoWidget({ parent }),
        new RamWatcherWidget({ parent }),
        new NetStatWidget({ parent }),
        new NetChartWidget({ parent }),
        new SandboxInfoWidget({ parent }),
    ];
    widgets.forEach(w => w.start());
    return {
        destroy: () => widgets.forEach(w => w.destroy()),
        widgets,
    };
}
