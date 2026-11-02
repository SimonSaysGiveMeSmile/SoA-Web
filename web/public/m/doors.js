/**
 * Backup doors: fail over to another public link to the SAME desktop.
 *
 * The desktop keeps several tunnels ("doors") open at once and publishes the
 * current list to an ntfy.sh topic. The list is encrypted so that only a
 * device holding the pairing token can read it, or forge one (AES-GCM is
 * authenticated, so a list that decrypts was written by a token holder):
 *
 *   topic = "soa-" + hex(HMAC-SHA256(key=token, msg="soa-doors-topic-v1"))[0..32]
 *   key   = HKDF-SHA256(ikm=token, salt="soa-doors", info="v1", 32 bytes)
 *   body  = base64url(nonce[12] || AES-256-GCM(JSON {v:1, ts, doors:[{url, provider, primary}]}))
 *
 * Both derivations are one-way: ntfy sees a topic name and ciphertext, never
 * the token. The token itself goes only to a door that has first answered
 * /api/ping as a SoA daemon, and then in an Authorization header, not a URL.
 *
 * Accepted lists: newest `ts` in the feed wins (a replayed old message cannot
 * displace it), a list older than 24 h or dated more than 5 min ahead of this
 * clock is ignored, and only https doors are taken (plain-http loopback only
 * when this page is itself on loopback). The feed read is capped (256 KB, 50
 * messages), so a flooded topic costs little.
 *
 * The same file is served as /m/doors.js (phone) and /assets/doors.js
 * (desktop dashboard). It has no imports.
 */

const NTFY_BASE = 'https://ntfy.sh';
const STORE_KEY = 'soa.doors.v1';
const PREF_KEY = 'soa.doors.pref.v1';
const enc = new TextEncoder();
const LIST_MAX_AGE_MS = 24 * 3600e3;     // the desktop republishes every 10 min
const LIST_MAX_SKEW_MS = 5 * 60e3;       // a list dated further ahead than this is not believed
const DOOR_KEEP_MS = 3 * 864e5;          // a door neither working nor freshly listed for 3 days is gone
const NTFY_MAX_BYTES = 256 * 1024;
const NTFY_MAX_MESSAGES = 50;

export function doorsSupported() {
    try { return !!(globalThis.crypto && crypto.subtle && typeof TextEncoder === 'function'); }
    catch (_) { return false; }
}

// ── Crypto ──────────────────────────────────────────────────────────────────

const _derived = new Map();   // token → Promise<{ topic, key }>
function derive(token) {
    let p = _derived.get(token);
    if (!p) {
        p = (async () => {
            const raw = enc.encode(String(token));
            const hk = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
            const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hk, enc.encode('soa-doors-topic-v1')));
            const topic = 'soa-' + Array.from(mac, b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
            const ikm = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
            const key = await crypto.subtle.deriveKey(
                { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('soa-doors'), info: enc.encode('v1') },
                ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            return { topic, key };
        })();
        p.catch(() => _derived.delete(token));
        _derived.set(token, p);
    }
    return p;
}

export async function doorsTopic(token) { return (await derive(token)).topic; }

function b64urlEncode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
    const s = String(str).trim().replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** Encrypt a door-list object (the desktop's job; here for tests and tools). */
export async function encryptDoorList(token, obj) {
    const { key } = await derive(token);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, enc.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length);
    out.set(nonce, 0); out.set(ct, 12);
    return b64urlEncode(out);
}

/** Decrypt + validate one published message → { ts, doors } or null. */
export async function decryptDoorList(token, message) {
    try {
        const { key } = await derive(token);
        const buf = b64urlDecode(message);
        if (buf.length < 12 + 16) return null;
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12));
        return normaliseList(JSON.parse(new TextDecoder().decode(pt)));
    } catch (_) { return null; }
}

function cleanOrigin(url) {
    try {
        const u = new URL(String(url));
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        if (!u.host || u.username || u.password) return null;
        return u.origin;
    } catch (_) { return null; }
}

const isLoopbackHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
function pageOnLoopback() {
    try { return typeof location !== 'undefined' && isLoopbackHost(location.hostname); } catch (_) { return false; }
}

/**
 * A door this page may hand the token to: https, or plain-http loopback only
 * when the page itself is on loopback (a test rig, or the desktop's own
 * dashboard). A listed http://host would put the token on the wire in clear.
 */
export function doorOrigin(url) {
    const o = cleanOrigin(url);
    if (!o) return null;
    const u = new URL(o);
    if (u.protocol === 'https:') return o;
    return isLoopbackHost(u.hostname) && pageOnLoopback() ? o : null;
}

function normaliseList(obj) {
    if (!obj || obj.v !== 1 || !Array.isArray(obj.doors)) return null;
    const now = Date.now();
    const ts = Number(obj.ts) || 0;
    // Undated or stale (a replay of an old message): not the current list.
    if (!ts || ts < now - LIST_MAX_AGE_MS) return null;
    // Dated well ahead of this clock: a forged or broken list, not the current one.
    if (ts > now + LIST_MAX_SKEW_MS) return null;
    const seen = new Set();
    const doors = [];
    for (const d of obj.doors.slice(0, 16)) {
        const url = d && doorOrigin(d.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        doors.push({ url, provider: String(d.provider || '').slice(0, 24), primary: !!d.primary });
    }
    // A clock slightly ahead of ours must not pin this list above every later one.
    return { ts: Math.min(ts, now), doors };
}

// ── ntfy ────────────────────────────────────────────────────────────────────

/**
 * Fetch the newest door list → { ts, doors } or null. Nothing identifying
 * goes with it: no cookies, no referrer, and the URL carries only the topic.
 */
export async function fetchDoorList(token, { timeoutMs = 8000, base = NTFY_BASE } = {}) {
    if (!token || !doorsSupported()) return null;
    const topic = await doorsTopic(token);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(`${base}/${topic}/json?poll=1&since=12h`, {
            cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal,
        });
        if (!res.ok) return null;
        const text = await readCapped(res, NTFY_MAX_BYTES);
        if (text == null) return null;   // a flooded topic: not worth parsing
        const lines = text.split('\n');
        // The newest list by its own timestamp, not by feed order: a replayed
        // old message lands last in the feed but carries its old ts.
        let best = null, tried = 0;
        for (let i = lines.length - 1; i >= 0 && tried < NTFY_MAX_MESSAGES; i--) {
            let ev;
            try { ev = JSON.parse(lines[i]); } catch (_) { continue; }
            if (!ev || ev.event !== 'message' || typeof ev.message !== 'string' || ev.message.length > 8192) continue;
            tried++;
            const list = await decryptDoorList(token, ev.message);
            if (list && (!best || list.ts > best.ts)) best = list;
        }
        return best;
    } catch (_) { return null; }
    finally { clearTimeout(timer); }
}

/** The body as text, or null once it passes `max` bytes (read stops there). */
async function readCapped(res, max) {
    const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
    if (declared > max) return null;
    if (!res.body || typeof res.body.getReader !== 'function') {
        const t = await res.text();
        return t.length > max ? null : t;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > max) { try { await reader.cancel(); } catch (_) {} return null; }
        chunks.push(value);
    }
    const all = new Uint8Array(n);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.byteLength; }
    return new TextDecoder().decode(all);
}

// ── Saved doors (per connection, keyed by its topic: never by the token) ─────

function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function writeStore(all) {
    try {
        const ids = Object.keys(all);
        if (ids.length > 8) {
            ids.sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
            for (const id of ids.slice(8)) delete all[id];
        }
        localStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch (_) { /* private mode: this run still has them in memory */ }
}

export class DoorBook {
    constructor(topic) { this.topic = topic; }
    get entry() { return readStore()[this.topic] || { doors: [], listTs: 0, fetchedAt: 0, at: 0 }; }
    _update(fn) {
        const all = readStore();
        const e = all[this.topic] || { doors: [], listTs: 0, fetchedAt: 0, at: 0 };
        fn(e);
        e.at = Date.now();
        e.doors = e.doors.filter(d => this._live(e, d)).slice(0, 16);
        all[this.topic] = e;
        writeStore(all);
        return e;
    }
    // Kept while it worked recently or sits in a recent list. A quick-tunnel
    // hostname that has been dead for days may be re-issued to someone else.
    _live(e, d) {
        const cutoff = Date.now() - DOOR_KEEP_MS;
        return (d.good || 0) > cutoff || (d.listed && (e.listTs || 0) > cutoff);
    }
    _door(e, url) {
        let d = e.doors.find(x => x.url === url);
        if (!d) { d = { url, provider: '', primary: false, listed: false, good: 0, bad: 0 }; e.doors.push(d); }
        return d;
    }
    merge(list) {
        return this._update(e => {
            if (list.ts && list.ts < (e.listTs || 0)) return;   // never step back to an older list
            const now = new Set(list.doors.map(d => d.url));
            for (const d of e.doors) d.listed = now.has(d.url);
            for (const d of list.doors) Object.assign(this._door(e, d.url), { provider: d.provider, primary: d.primary, listed: true });
            e.listTs = list.ts || e.listTs;
            e.fetchedAt = Date.now();
        });
    }
    has(url) { const u = cleanOrigin(url); return !!u && this.entry.doors.some(d => d.url === u); }
    markGood(url) { const u = doorOrigin(url); if (u) this._update(e => { this._door(e, u).good = Date.now(); }); }
    markBad(url) { const u = cleanOrigin(url); if (u && this.has(u)) this._update(e => { this._door(e, u).bad = Date.now(); }); }
    /** Most recently good first, then the published primary, then the rest. */
    candidates(exclude) {
        const ex = new Set((exclude || []).map(cleanOrigin).filter(Boolean));
        const e = this.entry;
        return e.doors
            .filter(d => !ex.has(d.url) && this._live(e, d) && doorOrigin(d.url))
            .sort((a, b) => (b.good || 0) - (a.good || 0)
                || (b.listed ? 1 : 0) - (a.listed ? 1 : 0)
                || (b.primary ? 1 : 0) - (a.primary ? 1 : 0)
                || (a.bad || 0) - (b.bad || 0))
            .map(d => d.url);
    }
}

// ── Probing ─────────────────────────────────────────────────────────────────

async function timedFetch(url, init, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await fetch(url, { ...init, signal: ctl.signal }); }
    finally { clearTimeout(timer); }
}

/** Does `origin` answer as a SoA daemon? Nothing of ours goes with it: no token, no unlock, no cookies. */
export async function pingDoor(origin, { timeoutMs = 4000 } = {}) {
    try {
        const res = await timedFetch(origin + '/api/ping', { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }, timeoutMs);
        if (!res.ok) return false;
        const body = await res.json().catch(() => null);
        return !!(body && body.ok && body.name === 'soa-web');
    } catch (_) { return false; }
}

/**
 * The same check a connection makes: the pairing token and unlock are
 * accepted (a password-protected desktop answers 401 without a good unlock).
 * Both ride in headers (Authorization: Bearer, x-soa-unlock; the daemon reads
 * either), so neither is in a URL that a tunnel provider's access log keeps.
 */
export async function authDoor(origin, { token, unlock = '', timeoutMs = 5000 } = {}) {
    try {
        const u = new URL(origin + '/api/me');
        const headers = {};
        if (token) headers.authorization = 'Bearer ' + token;
        if (unlock) headers['x-soa-unlock'] = unlock;
        const res = await timedFetch(u.toString(), { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers }, timeoutMs);
        if (!res.ok) return false;
        const body = await res.json().catch(() => null);
        return !!(body && body.ok && !body.passwordRequired);
    } catch (_) { return false; }
}

/**
 * The first working origin of `origins`, in order. Pings run together (they
 * carry nothing); the token is then offered only to doors that answered as a
 * daemon, best candidate first.
 */
export async function firstWorkingDoor(origins, { token, unlock = '', book = null, eligible = null } = {}) {
    const list = origins.filter(o => o && (!eligible || eligible(o)));
    const alive = await Promise.all(list.map(o => pingDoor(o)));
    for (let i = 0; i < list.length; i++) {
        if (!alive[i]) { if (book) book.markBad(list[i]); continue; }
        if (await authDoor(list[i], { token, unlock })) return list[i];
        if (book) book.markBad(list[i]);
    }
    return null;
}

/** A door the token may go to from this page (see doorOrigin). */
export function eligibleFromHere(origin) { return !!doorOrigin(origin); }

// ── Preferred door (phone): which door to start on after a reload ───────────
// Keyed by the connection's primary origin, so a reload (or a saved-connection
// tap) after a failover starts on the door that worked instead of spending
// another ~10 s on the dead primary. The primary stays in the rotation.

function readPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (_) { return {}; } }
function writePrefs(all) { try { localStorage.setItem(PREF_KEY, JSON.stringify(all)); } catch (_) {} }

/** The door to start on for `primary`, or null. Synchronous: used at boot. */
export function preferredDoor(primary) {
    const p = cleanOrigin(primary);
    const e = p && readPrefs()[p];
    if (!e || !(Date.now() - (e.at || 0) < LIST_MAX_AGE_MS)) return null;
    const d = doorOrigin(e.door);
    return d && d !== p ? d : null;
}
export function setPreferredDoor(primary, door, topic = '') {
    const p = cleanOrigin(primary);
    if (!p) return;
    const all = readPrefs();
    const d = door && doorOrigin(door);
    if (d && d !== p) all[p] = { door: d, topic, at: Date.now() };
    else if (!all[p]) return;
    else delete all[p];
    const ids = Object.keys(all);
    if (ids.length > 8) { ids.sort((a, b) => (all[b].at || 0) - (all[a].at || 0)); for (const id of ids.slice(8)) delete all[id]; }
    writePrefs(all);
}

/** One-shot search (boot): saved doors, then a fresh list. */
export async function findWorkingDoor({ token, unlock = '', exclude = [] } = {}) {
    if (!token || !doorsSupported()) return null;
    const book = new DoorBook(await doorsTopic(token));
    const tried = new Set(exclude.map(cleanOrigin).filter(Boolean));
    const opts = { token, unlock, book, eligible: eligibleFromHere };
    let saved = book.candidates([...tried]);
    let hit = await firstWorkingDoor(saved, opts);
    if (hit) { book.markGood(hit); return hit; }
    saved.forEach(o => tried.add(o));
    const list = await fetchDoorList(token);
    if (!list) return null;
    book.merge(list);
    hit = await firstWorkingDoor(book.candidates([...tried]), opts);
    if (hit) book.markGood(hit);
    return hit;
}

// ── Failover controller ─────────────────────────────────────────────────────

const RETRY_STEPS = [8000, 15000, 30000, 60000, 120000];
const FAILED_SWITCH_MS = 120000;   // a door we moved to that never connected sits out this long

/**
 * Watches one connection. The app reports connected()/disconnected(); this
 * keeps the door list fresh while connected and, once the link has been down
 * for `downAfterMs`, searches for a working door and hands it to onSwitch.
 * It never acts while connected, so a working backend is never switched away
 * from.
 *
 * A door only counts as good once the connection through it is up: one that
 * answers HTTP but whose socket never opens (a tunnel without WebSockets) is
 * marked bad at the next round and sits out for a while, and the backoff
 * keeps growing until something actually connects.
 *
 *   token       the pairing token (topic + key are derived from it)
 *   current()   → http(s) origin in use now
 *   primary     the connection's own origin (phone: remembers the door to start on)
 *   persistKey  sessionStorage key: carry backoff + the pending switch across a reload (desktop)
 *   getUnlock() → the pairing-password unlock for this desktop, or ''
 *   onSwitch(origin) → truthy once the app has moved to `origin`
 *   onStatus({ phase, ... }) phases: 'trying' | 'waiting' | 'switching' | 'switched' | 'ok'
 */
export class DoorFailover {
    constructor({ token, current, primary = '', persistKey = '', getUnlock, onSwitch, onStatus, downAfterMs = 10000, refreshMs = 300000 }) {
        this.token = token;
        this.current = current;
        this.primary = cleanOrigin(primary) || '';
        this.persistKey = persistKey;
        this.getUnlock = getUnlock || (() => '');
        this.onSwitch = onSwitch;
        this.onStatus = onStatus || (() => {});
        this.downAfterMs = downAfterMs;
        this.refreshMs = refreshMs;
        this.enabled = !!token && doorsSupported();
        this._down = false;
        this._timer = null;
        this._refreshTimer = null;
        this._kick = null;
        this._step = 0;
        this._running = false;
        this._switchedTo = null;
        this._nextAt = 0;           // when the next round is due (survives a desktop reload)
        this._switchAt = 0;         // when we last moved to a door
        this._failed = new Map();   // origin → time it may be tried again
        this._load();
        this.book = null;
        this._ready = this.enabled ? doorsTopic(token).then(t => {
            this.book = new DoorBook(t);
            // A remembered start door belongs to the token that proved it.
            if (this.primary) {
                const e = readPrefs()[this.primary];
                if (e && e.topic && e.topic !== t) setPreferredDoor(this.primary, null);
            }
        }).catch(() => { this.enabled = false; }) : Promise.resolve();
    }

    _cur() { try { return cleanOrigin(this.current()); } catch (_) { return null; } }

    _load() {
        if (!this.persistKey) return;
        try {
            const s = JSON.parse(sessionStorage.getItem(this.persistKey) || 'null');
            if (!s || !(Date.now() - (s.at || 0) < 10 * 60e3)) return;
            this._step = Math.min(Number(s.step) || 0, RETRY_STEPS.length);
            this._switchedTo = cleanOrigin(s.switchedTo) || null;
            this._nextAt = Number(s.nextAt) || 0;
            this._switchAt = Number(s.switchAt) || 0;
            for (const [u, until] of (s.failed || [])) if (until > Date.now()) this._failed.set(u, until);
        } catch (_) {}
    }
    _save() {
        if (!this.persistKey) return;
        try {
            if (!this._down && !this._switchedTo) { sessionStorage.removeItem(this.persistKey); return; }
            sessionStorage.setItem(this.persistKey, JSON.stringify({
                step: this._step, switchedTo: this._switchedTo, nextAt: this._nextAt, switchAt: this._switchAt,
                failed: [...this._failed], at: Date.now() }));
        } catch (_) {}
    }

    /** The app moved here by itself (a cold boot that already picked a door). */
    noteSwitched(origin) { this._switchedTo = cleanOrigin(origin) || null; }

    async connected() {
        if (!this.enabled) return;
        this._down = false;
        this._step = 0;
        this._nextAt = 0;
        this._failed.clear();
        clearTimeout(this._timer); this._timer = null;
        await this._ready;
        if (!this.book || this._down) return;
        const cur = this._cur();
        if (cur) this.book.markGood(cur);
        if (this.primary && cur) {
            if (cur === this.primary) setPreferredDoor(this.primary, null);
            else if (this.book.has(cur)) setPreferredDoor(this.primary, cur, this.book.topic);
        }
        const switched = this._switchedTo && this._switchedTo === cur;
        this._switchedTo = null;
        this._save();
        this.onStatus(switched ? { phase: 'switched', url: cur } : { phase: 'ok' });
        // Once right after every (re)connect, then every refreshMs.
        clearTimeout(this._kick);
        this._kick = setTimeout(() => { if (!this._down) this.refresh(); }, 1500);
        if (!this._refreshTimer) this._refreshTimer = setInterval(() => { if (!this._down) this.refresh(); }, this.refreshMs);
    }

    disconnected() {
        if (!this.enabled || this._down) return;
        this._down = true;
        this._downSince = Date.now();
        clearTimeout(this._kick);
        clearTimeout(this._timer);
        // After a reload that a switch caused (desktop), keep to the backoff
        // the last round chose instead of starting over at downAfterMs.
        const due = Math.min(Math.max(this.downAfterMs, (this._nextAt || 0) - Date.now()), RETRY_STEPS[RETRY_STEPS.length - 1]);
        this._timer = setTimeout(() => this._round(), due);
    }

    stop() {
        this.enabled = false;
        clearTimeout(this._timer); clearTimeout(this._kick); clearInterval(this._refreshTimer);
    }

    async refresh() {
        await this._ready;
        if (!this.book) return null;
        const list = await fetchDoorList(this.token);
        if (list) this.book.merge(list);
        return list;
    }

    async _round() {
        this._timer = null;
        if (!this._down || this._running || !this.enabled) return;
        this._running = true;
        try {
            await this._ready;
            if (!this.book) return;
            // We moved to a door last round and are still down: it answered
            // HTTP but did not carry the connection. Not good; let it sit out.
            if (this._switchedTo) {
                this.book.markBad(this._switchedTo);
                this._failed.set(this._switchedTo, Date.now() + FAILED_SWITCH_MS);
                this._switchedTo = null;
            }
            for (const [u, until] of this._failed) if (until <= Date.now()) this._failed.delete(u);
            // A desktop that publishes no backup links (no soa-doors running,
            // or an older install) has nothing to report: stay silent rather
            // than show a failover that cannot exist.
            const knewDoors = () => {
                const e = this.book.entry, here = this._cur();
                return (e.listTs || 0) > 0 || e.doors.some(d => d.url !== here);
            };
            if (knewDoors()) this.onStatus({ phase: 'trying' });
            const unlock = this.getUnlock() || '';
            const opts = { token: this.token, unlock, book: this.book, eligible: eligibleFromHere };
            const cur = this._cur();
            const tried = new Set([...(cur ? [cur] : []), ...this._failed.keys()]);
            const saved = this.book.candidates([...tried]);
            let hit = await firstWorkingDoor(saved, opts);
            let listOk = null;
            if (!hit && this._down) {
                saved.forEach(o => tried.add(o));
                const list = await fetchDoorList(this.token);
                listOk = !!list;
                if (list) {
                    this.book.merge(list);
                    hit = await firstWorkingDoor(this.book.candidates([...tried]), opts);
                }
            }
            // The link may have come back on its own while we looked.
            if (!this._down) return;
            const wait = RETRY_STEPS[Math.min(this._step, RETRY_STEPS.length - 1)];
            this._step++;
            this._nextAt = Date.now() + wait;
            if (hit) {
                // Marked good only once connected() confirms it.
                this._switchedTo = hit;
                this._switchAt = Date.now();
                this._save();
                this.onStatus({ phase: 'switching', url: hit });
                let moved = false;
                try { moved = await this.onSwitch(hit); } catch (_) {}
                if (!moved && this._switchedTo === hit) this._switchedTo = null;
            }
            this._save();
            if (!this._down) return;
            if (!hit) this.onStatus(knewDoors() ? { phase: 'waiting', nextInMs: wait, listOk, saved: saved.length } : { phase: 'ok' });
            this._timer = setTimeout(() => this._round(), wait);
        } finally { this._running = false; }
    }
}

// ── Desktop dashboard glue ──────────────────────────────────────────────────

const SWITCHED_KEY = 'soa.doors.switched';
const DESKTOP_STATE_KEY = 'soa.doors.fo';

function desktopToast(text) {
    const el = document.createElement('div');
    el.className = 'doors-toast';
    el.setAttribute('role', 'status');
    el.textContent = text;
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;'
        + 'padding:8px 14px;border-radius:8px;font:13px/1.3 system-ui,sans-serif;'
        + 'background:rgba(20,24,28,.92);color:#e8f0e8;box-shadow:0 4px 18px rgba(0,0,0,.35);pointer-events:none';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
}

function recoveryLine(text) {
    const pulse = document.getElementById('recovery-pulse');
    if (!pulse) return;
    let el = document.getElementById('recovery-doors');
    if (!el) {
        el = document.createElement('p');
        el.id = 'recovery-doors';
        el.className = 'recovery-pulse recovery-doors';
        el.setAttribute('aria-live', 'polite');
        pulse.insertAdjacentElement('afterend', el);
    }
    el.textContent = text || '';
    el.hidden = !text;
}

/**
 * Wire failover into the dashboard's Bridge. `switchTo(origin)` saves the
 * new backend and reloads, the same path a picked pairing takes. Backoff and
 * the pending switch survive that reload (sessionStorage), so a door that
 * answers HTTP but never connects cannot drive a reload loop.
 */
export function attachDesktopFailover({ bridge, backend, token, getUnlock, switchTo }) {
    if (!token || !doorsSupported()) return null;
    let switched = '';
    try { switched = sessionStorage.getItem(SWITCHED_KEY) || ''; sessionStorage.removeItem(SWITCHED_KEY); } catch (_) {}
    let open = false;
    let lastRecv = Date.now();
    const fo = new DoorFailover({
        token,
        current: () => backend,
        persistKey: DESKTOP_STATE_KEY,
        getUnlock,
        onSwitch: async (origin) => {
            if (open) return false;
            recoveryLine('Reconnecting through a backup link…');
            switchTo(origin);
            return true;
        },
        onStatus: (s) => {
            if (s.phase === 'trying') recoveryLine('Trying backup links…');
            else if (s.phase === 'waiting') recoveryLine(s.listOk === false
                ? `No backup link answered and the link list is unreachable — still trying saved links (next in ${Math.round(s.nextInMs / 1000)}s).`
                : `No backup link answered yet — still trying backup links (next in ${Math.round(s.nextInMs / 1000)}s).`);
            else if (s.phase === 'switched') { recoveryLine(''); desktopToast('Reconnected through a backup link'); }
            else if (s.phase === 'ok') recoveryLine('');
        },
    });
    if (switched && cleanOrigin(switched) === cleanOrigin(backend)) fo.noteSwitched(backend);
    bridge.addEventListener('status', (e) => {
        const st = e.detail && e.detail.state;
        if (st === 'open') {
            open = true;
            lastRecv = Date.now();
            try { bridge.ws && bridge.ws.addEventListener('message', () => { lastRecv = Date.now(); }); } catch (_) {}
            fo.connected();
        } else if (st === 'closed') {
            open = false;
            fo.disconnected();
        }
    });
    // A socket that died without closing (a tunnel that stopped forwarding)
    // stays "open" forever. The bridge pings every 20s and the daemon answers,
    // so 45s of silence plus a failed /api/ping means it is gone: close it and
    // let the normal reconnect (and failover) run.
    setInterval(async () => {
        if (!open || Date.now() - lastRecv < 45000) return;
        if (await pingDoor(backend)) { lastRecv = Date.now(); return; }
        try { bridge.ws && bridge.ws.close(); } catch (_) {}
    }, 10000);
    return fo;
}
