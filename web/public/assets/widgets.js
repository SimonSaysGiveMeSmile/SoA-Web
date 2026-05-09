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

import { t as tr } from '/assets/i18n.js?v=4';

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

class Widget {
    constructor({ title, titleKey, parent, intervalMs }) {
        this.titleKey = titleKey || null;
        this.title = titleKey ? tr(titleKey) : title;
        this.intervalMs = intervalMs || 0;
        this._titleEl = $el('span', { class: 'widget-title', text: `// ${this.title}` });
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
                this._titleEl.textContent = `// ${this.title}`;
                if (typeof this.onLangChange === 'function') this.onLangChange();
            };
            window.addEventListener('soa:lang', retitle);
            this._langOff = () => window.removeEventListener('soa:lang', retitle);
        }
    }

    start() {
        this.tick();
        if (this.intervalMs && !this._timer) {
            this._timer = setInterval(() => this.tick(), this.intervalMs);
        }
    }

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    destroy() {
        this._destroyed = true;
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
        const time = now.toTimeString().slice(0, 8);
        const date = now.toISOString().slice(0, 10);
        const utc = now.toUTCString().slice(17, 25);
        this.setRows([
            ['LOCAL', time],
            ['DATE', date],
            ['UTC', utc],
        ]);
    }
}

// ── SYSINFO ──────────────────────────────────────────────────────────────
class SysInfoWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.system', parent, intervalMs: 5000 });
    }
    async tick() {
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
}

// ── CPU ──────────────────────────────────────────────────────────────────
class CpuInfoWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.cpu', parent, intervalMs: 4000 });
    }
    async tick() {
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
}

// ── RAM ──────────────────────────────────────────────────────────────────
class RamWatcherWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.memory', parent, intervalMs: 2500 });
        this._bar = $el('div', { class: 'bar' }, [$el('span', { class: 'bar-fill' })]);
        this.body.appendChild(this._bar);
    }
    async tick() {
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
}

// ── NETSTAT ──────────────────────────────────────────────────────────────
class NetStatWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.network', parent, intervalMs: 8000 });
    }
    async tick() {
        try {
            const { data } = await jget('/api/net');
            const ipv4 = data.filter(a => a.family === 'IPv4' || a.family === 4).slice(0, 4);
            if (!ipv4.length) { this.setRows([['NET', tr('widget.net.empty')]]); return; }
            this.setRows(ipv4.map(a => [a.name.toUpperCase().slice(0, 6), a.address]));
        } catch (e) { this.setRows([['ERR', e.message]]); }
    }
}

// ── GIT COMMITS ──────────────────────────────────────────────────────────
class GitCommitsWidget extends Widget {
    constructor({ parent }) {
        super({ titleKey: 'widget.commits', parent, intervalMs: 30_000 });
    }
    async tick() {
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
        const target  = pubUrl || lanList[0] || null;

        this.body.replaceChildren(
            $el('div', { class: `mqr-status mqr-${state}` }, [
                $el('span', { class: 'mqr-dot' }),
                $el('span', { text: tr(`mqr.state.${state}`) }),
            ]),
            $el('div', { class: 'mqr-qr' }, target
                ? [$el('img', { class: 'mqr-img', src: api(`/api/pair/qr?text=${encodeURIComponent(target)}`), alt: 'pairing QR' })]
                : [$el('div', { class: 'mqr-empty', text: tr('mqr.empty') })]),
            $el('div', { class: 'mqr-urls' },
                lanList.slice(0, 1).concat(pubUrl ? [pubUrl] : []).map((u, i) =>
                    $el('div', { class: 'mqr-url' }, [
                        $el('span', { class: 'mqr-tag', text: i === 0 && lanList.length ? 'LAN' : 'PUB' }),
                        $el('span', { class: 'mqr-u',   text: u }),
                        $el('button', {
                            class: 'mqr-copy', text: tr('mqr.copy'),
                            onclick: () => navigator.clipboard && navigator.clipboard.writeText(u),
                        }),
                    ]),
                ),
            ),
            $el('div', { class: 'mqr-actions' }, [
                $el('button', {
                    class: 'mqr-toggle',
                    text: state === 'online' ? tr('mqr.stop') : (state === 'starting' ? '…' : tr('mqr.pair')),
                    onclick: () => state === 'online' ? this._stop() : this._start(),
                }),
            ]),
            snap && snap.error ? $el('div', { class: 'mqr-err', text: snap.error }) : '',
        );
    }

    async tick() {
        try {
            const { data } = await jget('/api/pair/status');
            this._render(data.state, data);
        } catch (e) { /* ignore polling failures */ }
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
}

export function mountSidebar(parent, ctx = {}) {
    const widgets = [
        new ClockWidget({ parent }),
        new MobileQRWidget({ parent, audio: ctx.audio }),
        new SysInfoWidget({ parent }),
        new CpuInfoWidget({ parent }),
        new RamWatcherWidget({ parent }),
        new NetStatWidget({ parent }),
        new GitCommitsWidget({ parent }),
    ];
    widgets.forEach(w => w.start());
    return {
        destroy: () => widgets.forEach(w => w.destroy()),
        widgets,
    };
}
