// deviceHistory.js — history on THIS device.
//
// The daemon replays a tab's rendered history on reconnect, which is the right
// answer while the daemon can be reached. This is the answer for when it
// cannot: a bounded archive of each tab's rendered text, kept in this
// browser's own storage, keyed by the backend it came from. A tablet on a
// train, a laptop whose tunnel rotated, a phone whose token was evicted — they
// can still read what they were looking at, and copy from it.
//
// No tokens, no server round-trips, nothing shared: the same footprint as the
// phone companion's session-history.js, for the full dashboard.

const KEY = 'soa-web:device-history:v1';
const MAX_CHARS = 1200000;     // the whole archive, all backends
const TAB_CHARS = 24000;       // per tab — the last screens, not the whole run
const MAX_TABS = 40;
const MAX_LINES = 400;

/** The last `maxLines` rendered rows of an xterm, soft wraps re-joined. */
export function snapshotTerminal(term, maxLines = MAX_LINES) {
    try {
        const buf = term.buffer.active;
        const end = buf.length;
        const start = Math.max(0, end - maxLines);
        const out = [];
        let carry = '';
        for (let i = start; i < end; i++) {
            const line = buf.getLine(i);
            if (!line) continue;
            const text = line.translateToString(true);
            if (line.isWrapped && out.length) { out[out.length - 1] += text; continue; }
            out.push(text);
        }
        while (out.length && !out[out.length - 1].trim()) out.pop();
        return (carry + out.join('\n')).slice(-TAB_CHARS);
    } catch (_) { return ''; }
}

export class DeviceHistory {
    constructor(storage) {
        this.storage = storage || null;
        this.records = [];
        this.available = !!storage;
        try {
            const saved = JSON.parse(storage.getItem(KEY) || 'null');
            if (saved && saved.version === 1 && Array.isArray(saved.records)) {
                this.records = saved.records.filter(r => r && typeof r.key === 'string' && typeof r.text === 'string').slice(0, MAX_TABS);
            }
        } catch (_) { /* corrupt or unavailable storage must never block boot */ }
    }

    static key(backend, tab) { return JSON.stringify([String(backend || ''), String(tab.id), String(tab.cwd || '')]); }

    /** Record one tab's current text. Skips writes that change nothing. */
    update(backend, tab, text) {
        const t = String(text || '');
        if (!t.trim()) return null;
        const key = DeviceHistory.key(backend, tab);
        let rec = this.records.find(r => r.key === key);
        if (!rec) { rec = { key }; this.records.push(rec); }
        if (rec.text === t && rec.title === tab.title) return rec;
        Object.assign(rec, {
            backend: String(backend || ''), tabId: tab.id,
            title: String(tab.title || `TAB ${tab.id}`).slice(0, 200),
            cwd: String(tab.cwd || '').slice(0, 400),
            text: t.slice(-TAB_CHARS), updated: Date.now(),
        });
        this.records.sort((a, b) => b.updated - a.updated);
        this.records = this.records.slice(0, MAX_TABS);
        this.save();
        return rec;
    }

    list(backend) {
        return backend == null ? this.records.slice() : this.records.filter(r => r.backend === String(backend));
    }

    save() {
        if (!this.storage) return;
        let json = JSON.stringify({ version: 1, records: this.records });
        while (json.length > MAX_CHARS && this.records.length > 1) {
            this.records.pop();
            json = JSON.stringify({ version: 1, records: this.records });
        }
        try { this.storage.setItem(KEY, json); this.available = true; }
        catch (_) { this.available = false; }
    }

    clear() { this.records = []; this.save(); }
}

/** Does this browser hold anything worth offering? Cheap, for a welcome screen. */
export function hasDeviceHistory() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
        return !!(saved && Array.isArray(saved.records) && saved.records.length);
    } catch (_) { return false; }
}

function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60); if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

/** A read-only viewer: one entry per tab, newest first, the text selectable. */
export function openDeviceHistory(store, { onClose = () => {} } = {}) {
    document.getElementById('device-history')?.remove();
    const panel = document.createElement('section');
    panel.id = 'device-history';
    panel.className = 'devhist';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'History on this device');
    const previousFocus = document.activeElement;
    const close = () => { panel.remove(); onClose(); try { previousFocus?.focus?.(); } catch (_) {} };

    const head = document.createElement('header');
    head.className = 'devhist-head';
    const h = document.createElement('h2'); h.textContent = 'History on this device';
    const sub = document.createElement('p'); sub.className = 'devhist-sub';
    const records = store.list();
    sub.textContent = records.length
        ? `${records.length} tab${records.length === 1 ? '' : 's'} saved in this browser — the last screens of each, kept when the link drops. Nothing here leaves this device.`
        : 'Nothing saved yet. Once a terminal has shown output here, its last screens are kept in this browser for when the desktop cannot be reached.';
    const back = document.createElement('button'); back.type = 'button'; back.className = 'devhist-back'; back.textContent = 'Back';
    back.addEventListener('click', close);
    head.append(h, back);
    panel.append(head, sub);

    const list = document.createElement('div'); list.className = 'devhist-list';
    for (const r of records) {
        const item = document.createElement('details'); item.className = 'devhist-item';
        if (records.length === 1) item.open = true;
        const sum = document.createElement('summary');
        const t = document.createElement('span'); t.className = 'devhist-title'; t.textContent = r.title || `TAB ${r.tabId}`;
        const m = document.createElement('span'); m.className = 'devhist-meta';
        m.textContent = [r.cwd, r.backend ? r.backend.replace(/^https?:\/\//, '') : '', r.updated ? ago(r.updated) : ''].filter(Boolean).join(' · ');
        sum.append(t, m);
        const pre = document.createElement('pre'); pre.className = 'devhist-text'; pre.textContent = r.text;
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'devhist-copy'; copy.textContent = 'Copy';
        copy.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(r.text); copy.textContent = 'Copied'; }
            catch (_) { copy.textContent = 'Select and copy'; }
            setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
        });
        item.append(sum, copy, pre);
        list.append(item);
    }
    panel.append(list);

    if (records.length) {
        const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'devhist-clear';
        clear.textContent = 'Forget all saved history on this device';
        clear.addEventListener('click', () => { if (confirm('Delete every saved tab history from this browser?')) { store.clear(); close(); } });
        panel.append(clear);
    }

    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.body.append(panel);
    setTimeout(() => { try { back.focus(); } catch (_) {} }, 30);
    return panel;
}
