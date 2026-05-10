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

import { t as tr } from '/assets/i18n.js?v=12';
import { getSettings } from '/assets/settings.js?v=12';

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
        this._lastLoc = null;
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
            const w = this._canvasHost.offsetWidth || 240;
            const h = this._canvasHost.offsetHeight || 200;
            const tron = 'rgb(170,207,209)';
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
            this.globe.init('#05080d', () => { this._tickAnim(); });
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
        } catch (e) {
            this._canvasHost.replaceChildren($el('div', { class: 'globe-err', text: tr('widget.globe.unavailable') + ': ' + e.message }));
        }
    }

    _tickAnim() {
        if (this._destroyed) return;
        try { this.globe.tick(); } catch (_) {}
        this._rafId = requestAnimationFrame(() => this._tickAnim());
    }

    async tick() {
        if (isSandbox()) { this._renderSandbox(); return; }
        try {
            const { data } = await jget('/api/geo');
            this._lastGeo = data;
            this._placePin(data);
            this._refreshMeta(data);
        } catch (e) {
            this._meta.textContent = tr('widget.globe.unavailable');
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

    _refreshMeta(geo) {
        if (!geo) { this._meta.textContent = '—'; return; }
        const place = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || '—';
        const coord = (geo.lat != null && geo.lon != null)
            ? `${geo.lat.toFixed(2)}, ${geo.lon.toFixed(2)}`
            : '—';
        this._meta.textContent = `${place}  ·  ${coord}`;
    }

    destroy() {
        if (this._rafId) cancelAnimationFrame(this._rafId);
        if (this._onResize) window.removeEventListener('resize', this._onResize);
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
        ctx.strokeStyle = 'rgba(170,207,209,0.9)';
        ctx.fillStyle = 'rgba(170,207,209,0.15)';
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

export function mountSidebar(parent, ctx = {}) {
    const widgets = [
        new ClockWidget({ parent }),
        new LocationGlobeWidget({ parent }),
        new MobileQRWidget({ parent, audio: ctx.audio }),
        new SysInfoWidget({ parent }),
        new DeviceStatusWidget({ parent }),
        new CpuInfoWidget({ parent }),
        new RamWatcherWidget({ parent }),
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
