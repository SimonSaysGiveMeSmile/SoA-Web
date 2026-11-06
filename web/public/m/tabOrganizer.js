// Tab organizer: search, sort and archive for the tab strip.
//
// Shared by the full dashboard (/assets/app.js) and the phone companion
// (/m/app.js) so both read one record in this browser. Everything here is
// per-device view state — nothing is sent to the daemon, and an archived tab
// keeps running: archive only takes it off the strip until you bring it back.
//
// Record (localStorage `soa-web:tab-org:v1`):
//   { v: 1, sort: 'manual' | 'activity' | 'recent',
//     backends: { <backendKey>: {
//       archived: { <tabId>: { cwd, title, at, seen } },
//       used:     { <tabId>: ms } } } }
//
// Tab ids are not stable across a daemon restart (restored tabs can come back
// under new ids), so an archived entry also remembers the tab's cwd + title
// and `reconcile` moves it onto the matching live tab when the old id is gone.

export const SORT_MODES = ['manual', 'activity', 'recent'];
export const SORT_LABELS = { manual: 'Manual', activity: 'Activity', recent: 'Last used' };
export const SORT_HINTS = {
    manual: 'Your own order — drag tabs to rearrange',
    activity: 'Most recent terminal output first',
    recent: 'The tab you used most recently first',
};

const KEY = 'soa-web:tab-org:v1';
// An archived entry whose tab has not been seen for this long is forgotten.
const FORGET_MS = 30 * 24 * 3600 * 1000;
const MAX_USED = 200;

function blank() { return { v: 1, sort: 'manual', backends: {} }; }

export function loadRecord(storage) {
    try {
        const raw = storage && storage.getItem(KEY);
        if (!raw) return blank();
        const rec = JSON.parse(raw);
        if (!rec || rec.v !== 1 || typeof rec !== 'object') return blank();
        if (!SORT_MODES.includes(rec.sort)) rec.sort = 'manual';
        if (!rec.backends || typeof rec.backends !== 'object') rec.backends = {};
        return rec;
    } catch (_) { return blank(); }
}

export function saveRecord(storage, rec) {
    try { storage && storage.setItem(KEY, JSON.stringify(rec)); } catch (_) {}
}

function bucket(rec, backend) {
    const k = String(backend || 'local');
    let b = rec.backends[k];
    if (!b || typeof b !== 'object') b = rec.backends[k] = {};
    if (!b.archived || typeof b.archived !== 'object') b.archived = {};
    if (!b.used || typeof b.used !== 'object') b.used = {};
    return b;
}

/**
 * Re-key archived entries onto the live tab list and drop stale ones.
 * `tabs` is [{ id, title, cwd }]. Returns true when the record changed.
 * A tab whose id is gone is re-keyed only when exactly one unclaimed live tab
 * has the same cwd AND title — never on cwd alone, because several tabs on one
 * repo are normal and a closed archived tab must not hide its sibling.
 */
export function reconcile(rec, backend, tabs, now = Date.now()) {
    const b = bucket(rec, backend);
    const live = new Map(tabs.map(t => [String(t.id), t]));
    let changed = false;
    const claimed = new Set(Object.keys(b.archived).filter(id => live.has(id)));
    for (const id of claimed) {
        const e = b.archived[id], t = live.get(id);
        if (now - (e.seen || 0) > 60000 || (t.cwd && e.cwd !== t.cwd) || (t.title && e.title !== t.title)) {
            b.archived[id] = { ...e, cwd: t.cwd || e.cwd || '', title: t.title || e.title || '', seen: now };
            changed = true;
        }
    }
    for (const id of Object.keys(b.archived)) {
        if (live.has(id)) continue;
        const e = b.archived[id];
        const free = tabs.filter(t => !claimed.has(String(t.id)) && !b.archived[String(t.id)]);
        const same = e.cwd ? free.filter(t => t.cwd === e.cwd && (t.title || '') === (e.title || '')) : [];
        const match = same.length === 1 ? same[0] : null;
        if (match) {
            const nid = String(match.id);
            b.archived[nid] = { ...e, title: match.title || e.title || '', seen: now };
            if (b.used[id] && !b.used[nid]) b.used[nid] = b.used[id];
            claimed.add(nid);
            delete b.archived[id];
            changed = true;
        } else if (now - (e.seen || e.at || 0) > FORGET_MS) {
            delete b.archived[id];
            changed = true;
        }
    }
    return changed;
}

export function isArchived(rec, backend, id) {
    return !!bucket(rec, backend).archived[String(id)];
}

export function archivedIds(rec, backend) {
    return new Set(Object.keys(bucket(rec, backend).archived));
}

export function setArchived(rec, backend, tab, on, now = Date.now()) {
    const b = bucket(rec, backend);
    const id = String(tab.id);
    if (on) b.archived[id] = { cwd: tab.cwd || '', title: tab.title || '', at: now, seen: now };
    else delete b.archived[id];
}

export function archivedAt(rec, backend, id) {
    const e = bucket(rec, backend).archived[String(id)];
    return e ? e.at || 0 : 0;
}

export function markUsed(rec, backend, id, now = Date.now()) {
    const b = bucket(rec, backend);
    b.used[String(id)] = now;
    const keys = Object.keys(b.used);
    if (keys.length > MAX_USED) {
        keys.sort((a, c) => b.used[a] - b.used[c]);
        for (const k of keys.slice(0, keys.length - MAX_USED)) delete b.used[k];
    }
}

export function lastUsed(rec, backend, id) {
    return bucket(rec, backend).used[String(id)] || 0;
}

/**
 * Order `ids` (already in manual order) for display.
 * `activityOf(id)` → ms of the last terminal output (0 = none seen yet).
 * Ties keep the manual order, so a tab with no signal stays where you put it.
 */
export function sortIds(ids, mode, { activityOf = () => 0, usedOf = () => 0 } = {}) {
    if (mode !== 'activity' && mode !== 'recent') return ids.slice();
    const key = mode === 'activity' ? activityOf : usedOf;
    return ids
        .map((id, i) => ({ id, i, k: Number(key(id)) || 0 }))
        .sort((a, b) => (b.k - a.k) || (a.i - b.i))
        .map(x => x.id);
}

/** Case-insensitive match on every whitespace-separated word, against title, cwd and #id. */
export function matches(query, { id, title, cwd, extra } = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    const hay = [`#${id}`, title || '', cwd || '', extra || ''].join(' ').toLowerCase();
    return q.split(/\s+/).every(w => hay.includes(w));
}

/** "just now" · "4m ago" · "3h ago" · "2d ago" — or '' for 0. */
export function ago(ms, now = Date.now()) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}
