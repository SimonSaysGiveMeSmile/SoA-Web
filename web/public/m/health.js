/**
 * System health — the client half of scripts/soa-health.
 *
 * Shared by the phone companion (m/app.js, a sheet from the ⋯ menu) and the
 * desktop dashboard (assets/widgets.js imports it from /m/, like dictation.js).
 * The service is a loopback-only process on the Mac (127.0.0.1:6084); browsers
 * reach it through the daemon's authed /preview/6084/ proxy, so each host only
 * says how to turn a service path into a URL under that proxy (with its t/u).
 *
 * Two rules from the service shape every call here:
 *   - A POST needs a 10-minute token from GET /token, sent as x-health-token.
 *   - A POST body is JSON sent as text/plain: the daemon's global express.json()
 *     swallows application/json bodies before /preview can forward them.
 *
 * A page on another origin (the public companion at www.s0a.app, paired with
 * the Mac over its tunnel) calls the same proxied URLs cross-origin: the daemon
 * answers CORS for its allowlisted origins, and soa-health accepts a cross-site
 * request only from those front ends and only through that proxy. An older
 * soa-health refuses it (403); the panel then shows where it can be used.
 *
 * A notification opens the companion at  …/m/#health=<alert id>&pid=&name=&why=
 * (parseHealthLink). The sheet then leads with that alert — what was heavy,
 * whether it still runs — and a Stop that goes through the normal token path.
 *
 * Nothing here can stop a process by itself. Stop and auto-stop both sit
 * behind an inline confirmation, and the service re-checks every protection
 * rule (system processes, SoA and all its tabs/agents, tunnels, terminals, the
 * frontmost app) and the pid's start time before it signals anything.
 */

export const HEALTH_PORT = 6084;
export const HEALTH_PREFIX = '/preview/' + HEALTH_PORT;

const TIMEOUT_MS = 8000;
const TOKEN_MARGIN_MS = 60000;          // refresh a token a minute before it lapses
const AUTO_CONFIRM = 'auto-terminate';  // the service's confirm phrase for auto mode

/**
 * True when `url` is on this page's own origin.
 */
export function sameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (_) { return false; }
}

/**
 * A notification's deep link: '#health=<id>&pid=…&name=…&why=…' → {id, pid, name, why}
 * or null. The id selects the alert on the Mac; the rest is only what the push
 * already said, shown while the Mac is asked (and if it cannot be reached).
 * Display-only: a Stop always uses the pid + start time the service returns.
 */
export function parseHealthLink(hash) {
    try {
        const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
        const id = q.get('health');
        if (!id || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) return null;
        const pid = parseInt(q.get('pid'), 10);
        const clip = (v, n) => (v ? String(v).slice(0, n) : null);
        return { id, pid: pid > 1 ? pid : null, name: clip(q.get('name'), 60), why: clip(q.get('why'), 160) };
    } catch (_) { return null; }
}

/** The '#health=…' fragment for a parsed link (used to hand it to another origin). */
export function healthLinkHash(f) {
    if (!f || !f.id) return '';
    const q = new URLSearchParams();
    q.set('health', f.id);
    if (f.pid) q.set('pid', String(f.pid));
    if (f.name) q.set('name', f.name);
    if (f.why) q.set('why', f.why);
    return '#' + q.toString();
}

export class HealthError extends Error {
    /** kind: down | auth | forbidden | http | bad */
    constructor(kind, message, status) { super(message); this.kind = kind; this.status = status || 0; }
}

export class HealthClient {
    /** @param {function(string):string} urlFor  '/status' → absolute URL under /preview/6084 */
    constructor(urlFor) {
        this.urlFor = urlFor;
        this._tok = null;
        this._tokExp = 0;
    }

    async _fetch(path, init = {}) {
        const url = this.urlFor(path);
        if (!url) throw new HealthError('down', 'no backend');
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
        let r;
        // Cross-origin (the public companion → the Mac's tunnel): ngrok's free
        // tier answers a browser request with an HTML warning page unless this
        // header is present; the daemon's CORS preflight lets it through.
        const headers = Object.assign({}, init.headers || {});
        if (!sameOrigin(url)) headers['ngrok-skip-browser-warning'] = '1';
        try {
            r = await fetch(url, { credentials: 'include', cache: 'no-store', ...init, headers, signal: ac.signal });
        } catch (_) {
            throw new HealthError('down', 'unreachable');
        } finally { clearTimeout(timer); }
        // The proxy answers 502 (HTML) when nothing listens on the port.
        if (r.status === 502 || r.status === 503 || r.status === 504) throw new HealthError('down', 'not running', r.status);
        if (r.status === 401) throw new HealthError('auth', 'pairing required', 401);
        const type = r.headers.get('content-type') || '';
        if (r.status === 403 && !/json/i.test(type)) throw new HealthError('forbidden', 'forbidden', 403);
        if (!/json/i.test(type)) throw new HealthError(r.ok ? 'down' : 'http', 'unexpected reply', r.status);
        let j;
        try { j = await r.json(); } catch (_) { throw new HealthError('bad', 'bad reply', r.status); }
        return { status: r.status, ok: r.ok, json: j };
    }

    async get(path) {
        const { ok, status, json } = await this._fetch(path);
        if (!ok) throw new HealthError('http', (json && json.error) || 'error ' + status, status);
        return json;
    }

    async _token(fresh) {
        if (!fresh && this._tok && Date.now() < this._tokExp) return this._tok;
        const j = await this.get('/token');
        if (!j || !j.token) throw new HealthError('bad', 'no token');
        this._tok = j.token;
        this._tokExp = Date.now() + Math.max(30000, (j.ttl || 600000) - TOKEN_MARGIN_MS);
        return this._tok;
    }

    /** POST a JSON body. Resolves {ok, status, json}; 4xx replies are data, not throws. */
    async post(path, body) {
        const send = async (fresh) => this._fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-health-token': await this._token(fresh) },
            body: JSON.stringify(body || {}),
        });
        try { return await send(false); }
        catch (e) {
            // A token the service no longer knows (it restarted, or it lapsed): one retry.
            if (e.kind === 'forbidden') { this._tok = null; return send(true); }
            throw e;
        }
    }

    status() { return this.get('/status'); }
    /** One notification's alert. Resolves null when it has expired (links last an hour). */
    async link(id) {
        const { ok, status, json } = await this._fetch('/link?c=' + encodeURIComponent(id));
        if (status === 404) return null;
        if (!ok) throw new HealthError('http', (json && json.error) || 'error ' + status, status);
        return json;
    }
    history(minutes = 60) { return this.get('/history?minutes=' + minutes); }
    setEnabled(on) { return this.post('/settings', { enabled: !!on }); }
    setAuto(on) { return this.post('/settings', on ? { mode: 'auto', confirm: AUTO_CONFIRM } : { mode: 'notify' }); }
    terminate(p) { return this.post('/terminate', { pid: p.pid, startTime: p.startTime, comm: p.comm || undefined }); }
}

// ── formatting ─────────────────────────────────────────────────────────

const STATE_LABEL = { nominal: 'Normal', fair: 'Warm', serious: 'Hot', critical: 'Critical', unknown: 'Unknown' };
export const thermalLabel = s => STATE_LABEL[s] || STATE_LABEL.unknown;

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const fmtC = v => (num(v) == null ? '—' : `${Math.round(v)}°C`);
const fmtPct = v => (num(v) == null ? '—' : `${Math.round(v)}%`);

function fmtAgo(ms) {
    if (!(ms >= 0)) return '';
    const s = Math.round(ms / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function fmtSecs(s) {
    s = Math.round(s);
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    return `${m} min`;
}

function procName(p) { return (p && (p.app || p.name)) || 'process'; }

// A one-line reason for a candidate: the service's own sentence when it has
// one, otherwise built from the numbers.
function reasonText(c) {
    const r = (c.reasons || [])[0];
    if (!r) return `CPU ${fmtPct(c.cpu)} · ${Math.round(c.rssMB || 0)} MB`;
    if (r.detail) return r.detail;
    if (r.kind === 'cpu') return `CPU ${fmtPct(r.value)} of a core`;
    if (r.kind === 'memory') return `${fmtPct(r.value)} of memory`;
    if (r.kind === 'leak') return `memory grew ${Math.round(r.value)} MB`;
    if (r.kind === 'thermal') return 'Mac is running hot';
    return '';
}

function trendText(tr) {
    if (!tr || num(tr.deltaPerMin) == null) return { arrow: '', text: 'trend pending', dir: 'unknown' };
    const d = tr.deltaPerMin;
    const dir = tr.direction || 'steady';
    const arrow = dir === 'rising' ? '▲' : dir === 'falling' ? '▼' : '▬';
    const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
    return { arrow, text: `${sign}${Math.abs(d).toFixed(1)}°C/min`, dir };
}

// ── DOM ────────────────────────────────────────────────────────────────

const SVGNS = 'http://www.w3.org/2000/svg';

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

/**
 * The 1-hour temperature line. Falls back to total CPU % when the Mac exposes
 * no temperature at all, and says which one it is drawing.
 */
function sparkline(samples) {
    const pts = (samples || []).filter(s => s && num(s.t) != null);
    let key = 'tempC';
    if (!pts.some(s => num(s.tempC) != null)) key = 'cpu';
    const vals = pts.map(s => ({ t: s.t, v: num(s[key]) })).filter(p => p.v != null);
    const wrap = h('div', { class: 'hl-spark' });
    const label = key === 'tempC' ? 'Temperature, last hour' : 'CPU, last hour';
    if (vals.length < 2) {
        wrap.append(h('span', { class: 'hl-spark-empty', text: 'Collecting the first samples…' }));
        return wrap;
    }
    let lo = Math.min(...vals.map(p => p.v)), hi = Math.max(...vals.map(p => p.v));
    const minSpan = key === 'tempC' ? 4 : 10;            // a flat line stays flat, not noise blown up
    if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
    const t1 = vals[vals.length - 1].t, t0 = Math.min(vals[0].t, t1 - 3600e3 + 60e3);
    const W = 100, H = 30, pad = 2;
    const x = t => ((t - t0) / Math.max(1, t1 - t0)) * W;
    const y = v => pad + (1 - (v - lo) / (hi - lo)) * (H - pad * 2);
    const line = vals.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(2)} ${y(p.v).toFixed(2)}`).join(' ');
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'hl-spark-svg');
    svg.setAttribute('role', 'img');
    const first = vals[0].v, last = vals[vals.length - 1].v;
    const unit = key === 'tempC' ? '°C' : '%';
    svg.setAttribute('aria-label', `${label}: from ${Math.round(first)}${unit} to ${Math.round(last)}${unit}`);
    const area = document.createElementNS(SVGNS, 'path');
    area.setAttribute('d', `${line} L${x(vals[vals.length - 1].t).toFixed(2)} ${H} L${x(vals[0].t).toFixed(2)} ${H} Z`);
    area.setAttribute('class', 'hl-spark-area');
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', line);
    path.setAttribute('class', 'hl-spark-line');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(area, path);
    const rlo = Math.min(...vals.map(p => p.v)), rhi = Math.max(...vals.map(p => p.v));
    wrap.append(svg, h('div', { class: 'hl-spark-cap' }, [
        h('span', { text: key === 'tempC' ? '1 h temperature' : '1 h CPU' }),
        h('span', { class: 'hl-num', text: `${Math.round(rlo)}–${Math.round(rhi)}${unit}` }),
    ]));
    return wrap;
}

function meter(label, pct, detail, warn) {
    const v = num(pct);
    const fill = h('span', { class: 'hl-meter-fill' });
    fill.style.width = `${v == null ? 0 : Math.max(0, Math.min(100, v))}%`;
    return h('div', { class: 'hl-meter' + (warn ? ' warn' : '') }, [
        h('div', { class: 'hl-meter-row' }, [
            h('span', { class: 'hl-meter-k', text: label }),
            h('span', { class: 'hl-meter-v hl-num', text: v == null ? '—' : `${Math.round(v)}%` }),
        ]),
        h('div', { class: 'hl-meter-bar' }, [fill]),
        detail ? h('div', { class: 'hl-meter-d', text: detail }) : null,
    ]);
}

/**
 * One health panel: status, the hour's temperature, the heavy processes with
 * an inline Stop confirmation, and the Monitor / Auto-stop switches. The host
 * decides when to refresh (desktop: the widget timer; phone: while the sheet
 * is open) and supplies the switch class (the desktop packs paint
 * .minimal-switch natively).
 */
export class HealthPanel {
    /**
     * away:     { href } when this page cannot reach the service at all (not paired,
     *           or another origin known not to work): the panel never calls it and
     *           shows where it can be used. href may be null.
     * focus:    a parsed notification link (parseHealthLink) to lead with.
     * fallback: { href } offered if the service refuses this origin (an older
     *           soa-health) — the panel then switches to the away note, with the
     *           focused alert's details.
     */
    constructor({ client, root, switchClass = '', variant = 'desk', away = null, focus = null, fallback = null }) {
        this.client = client;
        this.away = away;
        this.focus = focus && focus.id ? focus : null;
        this.fallback = fallback;
        this.alert = null;          // /link reply for focus, or { expired: true }
        this._alertErr = null;
        this.root = root;
        this.switchClass = switchClass;
        this.variant = variant;
        this.st = null;          // last /status
        this.hist = null;        // last /history samples
        this._histFor = null;    // sample.t the history was fetched for
        this.err = null;         // HealthError while unreachable
        this.msg = null;         // { text, tone } result of the last action
        this.confirmKey = null;  // pid:startTime awaiting Stop confirmation
        this.confirmAuto = false;
        this.busy = false;
        this._seq = 0;
        this._destroyed = false;
        root.classList.add('hl', 'hl-' + variant);
        this.render();
    }

    destroy() { this._destroyed = true; this.root.replaceChildren(); }

    async refresh() {
        if (this._destroyed || this.away) return;
        const seq = ++this._seq;
        try {
            const st = await this.client.status();
            if (this._destroyed || seq !== this._seq) return;
            this.st = st; this.err = null;
            if (this.focus) {
                try {
                    const a = await this.client.link(this.focus.id);
                    if (!this._destroyed && seq === this._seq) { this.alert = a || { expired: true }; this._alertErr = null; }
                } catch (e) { this._alertErr = e; }
            }
            const t = st.sample && st.sample.t;
            if (t && t !== this._histFor) {
                try {
                    const hj = await this.client.history(60);
                    if (!this._destroyed && seq === this._seq) { this.hist = hj.samples || []; this._histFor = t; }
                } catch (_) { /* the sparkline just waits for the next round */ }
            }
        } catch (e) {
            if (this._destroyed || seq !== this._seq) return;
            this.err = e instanceof HealthError ? e : new HealthError('down', String(e && e.message));
            // This origin is refused (an soa-health that predates cross-origin
            // use, or a request that did not come through the tunnel): say where
            // it works instead of retrying a door that will stay shut.
            if (this.err.kind === 'forbidden' && this.fallback && !this.st) {
                this.away = { href: this.fallback.href || null, refused: true };
                this.onAway && this.onAway();
            }
        }
        if (!this.busy) this.render();
    }

    _say(text, tone = '') { this.msg = { text, tone, at: Date.now() }; }

    async _act(fn) {
        if (this.busy) return;
        this.busy = true; this.render();
        try { await fn(); }
        catch (e) {
            this._say(e && e.kind === 'down' ? 'The health monitor stopped answering.' : 'That did not go through. Try again.', 'bad');
        }
        this.busy = false;
        this._seq++;            // drop a poll that started before the change
        await this.refresh();
        this.render();
    }

    _toggleMonitor() {
        const on = !(this.st && this.st.enabled);
        return this._act(async () => {
            const r = await this.client.setEnabled(on);
            if (!r.ok) this._say((r.json && r.json.error) || 'Could not change monitoring.', 'bad');
            else { this.st.enabled = on; this._say(on ? 'Monitoring is on.' : 'Monitoring is off. Nothing will be checked or stopped.'); }
        });
    }

    _setAuto(on) {
        this.confirmAuto = false;
        return this._act(async () => {
            const r = await this.client.setAuto(on);
            if (!r.ok) this._say((r.json && r.json.error) || 'Could not change auto-stop.', 'bad');
            else this._say(on ? 'Auto-stop is on.' : 'Auto-stop is off. You will get a notification instead.', on ? 'warn' : '');
        });
    }

    _stop(p) {
        this.confirmKey = null;
        if (this.alert && this.alert.pid === p.pid && this.alert.startTime === p.startTime) this.alert.stopped = true;
        return this._act(async () => {
            const r = await this.client.terminate(p);
            const j = r.json || {};
            const name = procName(p);
            if (r.ok && j.result === 'dry-run') this._say(`Dry run: ${name} (pid ${p.pid}) would have been stopped.`);
            else if (r.ok) this._say(`Stopped ${name} (pid ${p.pid}). Reopen it if you still need it.`, 'ok');
            else this._say(`Did not stop ${name}: ${j.reason || j.error || 'refused'}.`, 'bad');
        });
    }

    // ── render ──

    render() {
        if (this._destroyed) return;
        const focusKey = this.root.contains(document.activeElement) ? document.activeElement.dataset.k : null;
        this.root.setAttribute('aria-busy', String(this.busy));
        this.root.replaceChildren(...this._view().filter(Boolean));
        if (focusKey) {
            const el = this.root.querySelector(`[data-k="${CSS.escape(focusKey)}"]`);
            if (el) el.focus({ preventScroll: true });
        }
    }

    _view() {
        if (this.away) return this._awayView();
        const st = this.st;
        if (this.err && !st) return [this.focus ? this._alertPreview() : null, ...this._downView()];
        if (!st) return [this.focus ? this._alertPreview() : null, h('div', { class: 'hl-note', text: 'Checking the Mac…' })];
        const out = [];
        if (this.err) out.push(this._banner(this._errText(this.err), 'bad'));
        if (this.focus) out.push(this._alertView(st));
        out.push(this._headView(st));
        out.push(sparkline(this.hist));
        out.push(this._metersView(st));
        out.push(this._procsView(st));
        if (this.msg && Date.now() - this.msg.at < 60000) {
            out.push(h('div', { class: 'hl-msg' + (this.msg.tone ? ' ' + this.msg.tone : ''), role: 'status', 'aria-live': 'polite', text: this.msg.text }));
        }
        out.push(this._controlsView(st));
        out.push(this._footView(st));
        return out;
    }

    _errText(e) {
        if (e.kind === 'auth') return 'Pair this device again to reach the health monitor.';
        if (e.kind === 'forbidden') return 'The health monitor refused this page. Open the dashboard from the Mac’s own address.';
        return 'Health monitor isn’t running.';
    }

    // What the notification said, before (or without) the Mac's answer.
    _alertPreview() {
        const f = this.focus;
        return h('div', { class: 'hl-alert', role: 'group', 'aria-label': 'Alert from your notification' }, [
            h('div', { class: 'hl-alert-k', text: 'From your notification' }),
            h('div', { class: 'hl-proc-name' }, [
                h('span', { class: 'hl-proc-n', text: f.name || 'A heavy process' }),
                f.pid ? h('span', { class: 'hl-proc-pid hl-num', text: `pid ${f.pid}` }) : null,
            ]),
            f.why ? h('div', { class: 'hl-proc-why', text: f.why }) : null,
        ]);
    }

    // The alert the notification was about, as the Mac reports it now, with a
    // Stop that uses the pid + start time from the service (never from the link).
    _alertView(st) {
        const f = this.focus, a = this.alert;
        if (!a) return this._alertPreview();
        if (a.expired) {
            return h('div', { class: 'hl-alert done' }, [
                h('div', { class: 'hl-alert-k', text: 'From your notification' }),
                h('div', { class: 'hl-alert-t', text: `${f.name || 'That alert'}${f.pid ? ' (pid ' + f.pid + ')' : ''}: this alert has expired.` }),
                h('div', { class: 'hl-proc-why', text: 'Alerts last an hour. Anything still heavy is listed below.' }),
            ]);
        }
        const key = `${a.pid}:${a.startTime}`;
        const c = { pid: a.pid, startTime: a.startTime, comm: a.comm, name: a.name, app: a.name, reasons: a.reasons };
        const why = (a.current && a.current.reasons && a.current.reasons.length ? a.current.reasons : a.reasons || []).map(r => r.detail).filter(Boolean).join('; ');
        const gone = !a.running || a.stopped;
        const confirming = this.confirmKey === key;
        const card = h('div', { class: 'hl-alert' + (gone ? ' done' : '') + (confirming ? ' confirming' : ''), role: 'group', 'aria-label': `Alert: ${a.name}` }, [
            h('div', { class: 'hl-alert-k', text: 'From your notification' }),
            h('div', { class: 'hl-proc' }, [
                h('div', { class: 'hl-proc-main' }, [
                    h('div', { class: 'hl-proc-name' }, [
                        h('span', { class: 'hl-proc-n', text: a.name || 'process', title: a.args || a.comm || '' }),
                        h('span', { class: 'hl-proc-pid hl-num', text: `pid ${a.pid}` }),
                    ]),
                    h('div', { class: 'hl-proc-why', text: why || 'Was using a lot.' }),
                    h('div', { class: 'hl-alert-s', text: gone ? 'No longer running.' : a.stillHeavy ? 'Still heavy right now.' : 'Still running, no longer over the limits.' }),
                ]),
                gone || confirming ? null : h('button', {
                    type: 'button', class: 'hl-btn hl-btn-stop', 'data-k': 'alert-stop', disabled: this.busy || null,
                    'aria-label': `Stop ${a.name}, pid ${a.pid}`, text: 'Stop',
                    onclick: () => { this.confirmKey = key; this.confirmAuto = false; this.render(); this.root.querySelector('[data-k="alert-yes"]')?.focus(); },
                }),
            ]),
        ]);
        if (confirming && !gone) {
            card.append(h('div', { class: 'hl-confirm', role: 'group', 'aria-label': `Confirm stopping ${a.name}` }, [
                h('p', { text: `Stop ${a.name} (pid ${a.pid})? It is asked to quit first and forced after 10 seconds if it does not. Unsaved work in it is lost.` }),
                h('div', { class: 'hl-actions' }, [
                    h('button', { type: 'button', class: 'hl-btn hl-btn-danger', 'data-k': 'alert-yes', disabled: this.busy || null,
                        text: 'Stop it', onclick: () => this._stop(c) }),
                    h('button', { type: 'button', class: 'hl-btn', 'data-k': 'alert-no', text: 'Cancel',
                        onclick: () => { this.confirmKey = null; this.render(); } }),
                ]),
            ]));
        }
        return card;
    }

    _awayView() {
        const href = this.away && this.away.href;
        return [
            this.focus ? this._alertPreview() : null,
            h('div', { class: 'hl-away', role: 'note' }, [
                h('div', { class: 'hl-away-t', text: href
                    ? (this.focus ? 'Open on your Mac’s link to stop it.' : 'Open on your Mac’s link to manage system health.')
                    : 'Pair with your Mac to see its system health.' }),
                h('div', { class: 'hl-away-d', text: this.away && this.away.refused
                    ? 'The Mac’s health monitor did not accept this page. Its own link opens the same sheet on this alert.'
                    : 'Its monitor only answers pages opened from the Mac itself.' }),
                href ? h('a', { class: 'hl-btn hl-away-link', href, target: '_blank', rel: 'noopener noreferrer', 'data-k': 'away',
                    text: 'Open on the Mac’s link' }) : null,
            ]),
        ];
    }

    _banner(text, tone) { return h('div', { class: 'hl-banner ' + (tone || ''), role: 'status', text }); }

    _downView() {
        const e = this.err;
        const down = e.kind === 'down' || e.kind === 'http' || e.kind === 'bad';
        return [
            h('div', { class: 'hl-down' }, [
                h('div', { class: 'hl-down-t', text: this._errText(e) }),
                down ? h('div', { class: 'hl-down-d' }, [
                    'Start it on the Mac with ', h('code', { text: 'soa-health serve' }), ', then retry.',
                ]) : null,
                h('button', { type: 'button', class: 'hl-btn', 'data-k': 'retry', text: 'Retry', onclick: () => { this.err = null; this.render(); this.refresh(); } }),
            ]),
        ];
    }

    _headView(st) {
        const th = (st.sample && st.sample.thermal) || {};
        const state = th.state || 'unknown';
        const temp = num(th.cpuC) != null ? th.cpuC : num(th.maxC) != null ? th.maxC : num(th.batteryC);
        const tr = trendText(st.trend);
        const hot = state === 'serious' || state === 'critical';
        return h('div', { class: 'hl-head', 'data-state': state }, [
            h('div', { class: 'hl-temp' }, [
                h('span', { class: 'hl-temp-v hl-num', text: temp == null ? '—' : String(Math.round(temp)) }),
                h('span', { class: 'hl-temp-u', text: temp == null ? '' : '°C' }),
            ]),
            h('div', { class: 'hl-head-r' }, [
                h('span', { class: 'hl-state', 'data-state': state, text: thermalLabel(state) }),
                h('span', { class: 'hl-trend', 'data-dir': tr.dir }, [
                    tr.arrow ? h('span', { class: 'hl-trend-a', 'aria-hidden': 'true', text: tr.arrow }) : null,
                    h('span', { class: 'hl-num', text: tr.text }),
                ]),
            ]),
            hot ? h('div', { class: 'hl-hot', role: 'alert', text: state === 'critical'
                ? 'The Mac is critically hot and slowing itself down.'
                : 'The Mac is running hot and may slow down.' }) : null,
        ]);
    }

    _metersView(st) {
        const s = st.sample || {};
        const cpu = s.cpu || {}, mem = s.memory || {}, th = s.thermal || {};
        const load = Array.isArray(cpu.load) && num(cpu.load[0]) != null ? `load ${cpu.load[0].toFixed(1)} · ${cpu.cores || '?'} cores` : '';
        const press = mem.pressure && mem.pressure !== 'normal' ? `pressure ${mem.pressure}` : mem.pressure ? 'pressure normal' : '';
        const swap = num(mem.swapUsedMB) ? ` · swap ${(mem.swapUsedMB / 1024).toFixed(1)} GB` : '';
        const extra = [];
        if (num(th.maxC) != null && num(th.cpuC) != null && th.maxC - th.cpuC >= 1) extra.push(`hottest sensor ${fmtC(th.maxC)}`);
        if (num(th.batteryC) != null) extra.push(`battery ${fmtC(th.batteryC)}`);
        return h('div', { class: 'hl-meters' }, [
            meter('CPU', cpu.totalPct, load, num(cpu.totalPct) >= 90),
            meter('Memory', mem.usedPct, press + swap, mem.pressure && mem.pressure !== 'normal'),
            extra.length ? h('div', { class: 'hl-extra', text: extra.join(' · ') }) : null,
        ]);
    }

    _procsView(st) {
        const cands = (st.candidates || []).slice(0, 3);
        const watching = (st.watch || []).length;
        const wrap = h('div', { class: 'hl-procs' }, [
            h('div', { class: 'hl-sec' }, [
                h('span', { text: 'Heavy processes' }),
                h('span', { class: 'hl-count hl-num', text: String((st.candidates || []).length) }),
            ]),
        ]);
        if (!cands.length) {
            wrap.append(h('div', { class: 'hl-empty', text: watching
                ? `None right now. Watching ${watching} that ${watching === 1 ? 'is' : 'are'} briefly high.`
                : 'None. Nothing of yours is running away.' }));
            return wrap;
        }
        for (const c of cands) {
            const key = `${c.pid}:${c.startTime}`;
            const confirming = this.confirmKey === key && !(this.alert && `${this.alert.pid}:${this.alert.startTime}` === key);
            const focused = !!(this.alert && this.alert.pid === c.pid && this.alert.startTime === c.startTime);
            const row = h('div', { class: 'hl-proc' + (confirming ? ' confirming' : '') + (focused ? ' focus' : '') }, [
                h('div', { class: 'hl-proc-main' }, [
                    h('div', { class: 'hl-proc-name' }, [
                        h('span', { class: 'hl-proc-n', text: procName(c), title: c.args || c.comm || '' }),
                        h('span', { class: 'hl-proc-pid hl-num', text: `pid ${c.pid}` }),
                    ]),
                    h('div', { class: 'hl-proc-why', text: reasonText(c) }),
                ]),
                confirming ? null : h('button', {
                    type: 'button', class: 'hl-btn hl-btn-stop', 'data-k': 'stop:' + key, disabled: this.busy || null,
                    'aria-label': `Stop ${procName(c)}, pid ${c.pid}`, text: 'Stop',
                    onclick: () => { this.confirmKey = key; this.confirmAuto = false; this.render(); this.root.querySelector(`[data-k="yes:${CSS.escape(key)}"]`)?.focus(); },
                }),
            ]);
            if (confirming) {
                row.append(h('div', { class: 'hl-confirm', role: 'group', 'aria-label': `Confirm stopping ${procName(c)}` }, [
                    h('p', { text: `Stop ${procName(c)} (pid ${c.pid})? It is asked to quit first and forced after 10 seconds if it does not. Unsaved work in it is lost.` }),
                    h('div', { class: 'hl-actions' }, [
                        h('button', { type: 'button', class: 'hl-btn hl-btn-danger', 'data-k': 'yes:' + key, disabled: this.busy || null,
                            text: 'Stop it', onclick: () => this._stop(c) }),
                        h('button', { type: 'button', class: 'hl-btn', 'data-k': 'no:' + key, text: 'Cancel',
                            onclick: () => { this.confirmKey = null; this.render(); } }),
                    ]),
                ]));
            }
            wrap.append(row);
        }
        return wrap;
    }

    _switch(key, on, label, onclick, extraClass = '') {
        return h('button', {
            type: 'button', class: `hl-switch ${this.switchClass} ${extraClass}`.trim(), role: 'switch',
            'aria-checked': String(!!on), 'aria-label': label, 'data-k': key,
            disabled: this.busy || null, onclick,
        });
    }

    _controlsView(st) {
        const th = st.thresholds || {};
        const rate = st.rate || {};
        const auto = st.mode === 'auto';
        const iv = st.intervalSec || 60;
        const ctl = h('div', { class: 'hl-ctl' }, [
            h('div', { class: 'hl-row' }, [
                h('div', { class: 'hl-row-l' }, [
                    h('div', { class: 'hl-row-t', text: 'Monitor' }),
                    h('div', { class: 'hl-row-d', text: st.enabled ? `Checks every ${fmtSecs(iv)}` : 'Off. Nothing is checked.' }),
                ]),
                this._switch('monitor', st.enabled, 'Monitor system health', () => this._toggleMonitor()),
            ]),
            h('div', { class: 'hl-row' + (auto ? ' hl-row-auto' : '') }, [
                h('div', { class: 'hl-row-l' }, [
                    h('div', { class: 'hl-row-t' }, ['Auto-stop', st.dryRun ? h('span', { class: 'hl-tag', text: 'dry run' }) : null]),
                    h('div', { class: 'hl-row-d', text: auto
                        ? 'On. Runaway processes are stopped without asking.'
                        : 'Off. You get a notification with a Stop link.' }),
                ]),
                this._switch('auto', auto, 'Stop runaway processes automatically', () => {
                    if (auto) this._setAuto(false);
                    else { this.confirmAuto = !this.confirmAuto; this.confirmKey = null; this.render(); if (this.confirmAuto) this.root.querySelector('[data-k="auto-yes"]')?.focus(); }
                }, 'hl-switch-danger'),
            ]),
        ]);
        if (this.confirmAuto && !auto) {
            const cpu = th.cpuPct || 85, n = th.sustainSamples || 3, mem = th.rssPctOfRam || 25;
            const leakGB = ((th.leakMB || 1024) / 1024).toFixed(1).replace(/\.0$/, '');
            const leakMin = th.leakWindowMin || 10;
            ctl.append(h('div', { class: 'hl-confirm hl-confirm-auto', role: 'group', 'aria-label': 'Confirm automatic stopping' }, [
                h('p', { class: 'hl-confirm-t', text: 'Stop processes automatically?' }),
                h('p', { text: `SoA will stop one of your own processes without asking when it uses over ${cpu}% of a CPU core for ${n} checks in a row, holds over ${mem}% of memory, or grows by ${leakGB} GB in ${leakMin} minutes; when the Mac itself is running hot, the heaviest one is stopped right away. It is asked to quit first and forced after 10 seconds. At most ${rate.max || 3} every ${rate.windowMin || 10} minutes, and you are told each time.` }),
                h('p', { text: 'Never stopped: macOS system processes, SoA itself and every terminal tab and agent running in it, tunnels and remote links, Terminal and other terminal apps, and the app in front. Unsaved work in a stopped app is lost.' }),
                h('div', { class: 'hl-actions' }, [
                    h('button', { type: 'button', class: 'hl-btn hl-btn-danger', 'data-k': 'auto-yes', disabled: this.busy || null,
                        text: 'Turn on auto-stop', onclick: () => this._setAuto(true) }),
                    h('button', { type: 'button', class: 'hl-btn', 'data-k': 'auto-no', text: 'Keep notifications',
                        onclick: () => { this.confirmAuto = false; this.render(); } }),
                ]),
            ]));
        }
        return ctl;
    }

    _footView(st) {
        const bits = [];
        const s = st.sample;
        if (!st.enabled) bits.push('Monitoring off');
        else if (s && num(st.now) != null) bits.push(`Checked ${fmtAgo(st.now - s.t)}`);
        const la = st.lastAction;
        if (la && la.action === 'terminate' && (la.result === 'terminated' || la.result === 'killed')) {
            bits.push(`last stopped ${la.name || 'a process'}${num(st.now) != null ? ' ' + fmtAgo(st.now - la.t) : ''}`);
        }
        return bits.length ? h('div', { class: 'hl-foot', text: bits.join(' · ') }) : null;
    }
}

// ── phone sheet ────────────────────────────────────────────────────────

let _sheet = null;

/**
 * The phone's health sheet (⋯ → Health). Polls only while open.
 * @param {{urlFor: function(string):string}} o  service path → proxied URL
 */
export function openHealthSheet({ urlFor, away = null, focus = null, fallback = null }) {
    if (!_sheet) {
        const overlay = h('div', { id: 'health-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'health-title' });
        const body = h('div', { class: 'health-body' });
        const close = h('button', { type: 'button', class: 'settings-close', id: 'health-close', 'aria-label': 'Close', text: '×' });
        overlay.append(h('div', { class: 'health-sheet' }, [
            h('div', { class: 'settings-handle' }, [h('span')]),
            h('div', { class: 'health-header' }, [h('div', { class: 'health-title', id: 'health-title', text: 'System health' }), close]),
            body,
        ]));
        document.body.appendChild(overlay);
        const s = { overlay, body, panel: null, timer: null, client: null };
        const hide = () => {
            overlay.classList.remove('visible');
            clearInterval(s.timer); s.timer = null;
            document.removeEventListener('visibilitychange', s.onVis);
        };
        s.hide = hide;
        s.onVis = () => {
            if (document.hidden) { clearInterval(s.timer); s.timer = null; }
            else if (overlay.classList.contains('visible') && !s.timer && !s.panel.away) { s.panel.refresh(); s.timer = setInterval(() => s.panel.refresh(), 10000); }
        };
        close.addEventListener('click', hide);
        overlay.addEventListener('click', e => { if (e.target === overlay) hide(); });
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
        _sheet = s;
    }
    const s = _sheet;
    s.client = new HealthClient(urlFor);   // the backend may have changed since last open
    if (s.panel) s.panel.destroy();
    s.panel = new HealthPanel({ client: s.client, root: s.body, variant: 'phone', away, focus, fallback });
    s.panel.onAway = () => { clearInterval(s.timer); s.timer = null; };
    s.overlay.classList.add('visible');
    clearInterval(s.timer); s.timer = null;
    if (!away) {
        s.panel.refresh();
        s.timer = setInterval(() => s.panel.refresh(), 10000);
    }
    document.addEventListener('visibilitychange', s.onVis);
    setTimeout(() => s.overlay.querySelector('#health-close')?.focus({ preventScroll: true }), 60);
    return s;
}

export function closeHealthSheet() { if (_sheet) _sheet.hide(); }
