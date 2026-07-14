/**
 * Timemachine
 *
 * Snapshots the IDE's frontend-visible state every 5 minutes into IndexedDB
 * so the user can rewind to any prior point in the session — even after a
 * reload or browser crash. The browser is the only place this lives; the
 * daemon already persists tabs/scrollback/session separately (see
 * server/src/tabPersist.js — that's authoritative for shell respawn). This
 * is a *view* of what the user was looking at, not a process restore.
 *
 * What we capture per snapshot:
 *   - viewMode, activeId, tab order
 *   - per tab: id, title, scrollback rendered from xterm's active buffer
 *   - settings JSON, language, per-tab ctx % and agent status
 *
 * Why IndexedDB, not localStorage:
 *   60 snapshots × ~200 KB of scrollback each = ~12 MB. localStorage caps at
 *   5–10 MB and serializes synchronously on the main thread; IDB handles the
 *   size and stays off the render path.
 *
 * Retention: hardcoded MAX_SNAPSHOTS = 60. Older entries are pruned on each
 * write so quota pressure can't build up over a long-lived session.
 */

const DB_NAME = 'soa-web-tm';
const DB_VERSION = 1;
const STORE = 'snapshots';
const MAX_SNAPSHOTS = 60;
const INTERVAL_MS = 5 * 60 * 1000;
const MAX_LINES_PER_TAB = 4096;
const SCHEMA_VERSION = 1;

let _db = null;
let _timer = null;
let _shellRef = null;

function _open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'ts' });
            }
        };
        req.onsuccess = () => { _db = req.result; resolve(_db); };
        req.onerror = () => reject(req.error);
    });
}

function _tx(mode) {
    return _open().then(db => db.transaction(STORE, mode).objectStore(STORE));
}

function _put(snap) {
    return _tx('readwrite').then(store => new Promise((res, rej) => {
        const r = store.put(snap);
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
    }));
}

function _all() {
    return _tx('readonly').then(store => new Promise((res, rej) => {
        const r = store.getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
    }));
}

function _delete(ts) {
    return _tx('readwrite').then(store => new Promise((res, rej) => {
        const r = store.delete(ts);
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
    }));
}

function _clear() {
    return _tx('readwrite').then(store => new Promise((res, rej) => {
        const r = store.clear();
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
    }));
}

async function _prune() {
    const all = await _all();
    if (all.length <= MAX_SNAPSHOTS) return;
    all.sort((a, b) => a.ts - b.ts);
    const drop = all.length - MAX_SNAPSHOTS;
    for (let i = 0; i < drop; i++) await _delete(all[i].ts);
}

function _dumpScrollback(rt) {
    if (!rt || !rt.term) return '';
    try {
        const buf = rt.term.buffer.active;
        const total = buf.length;
        const start = Math.max(0, total - MAX_LINES_PER_TAB);
        const lines = [];
        for (let y = start; y < total; y++) {
            const line = buf.getLine(y);
            if (!line) continue;
            lines.push(line.translateToString(true));
        }
        while (lines.length && lines[lines.length - 1] === '') lines.pop();
        return lines.join('\n');
    } catch (_) { return ''; }
}

function _readSettings() {
    try { return JSON.parse(localStorage.getItem('soa_web_settings') || '{}'); }
    catch (_) { return {}; }
}

function _readLang() {
    try { return localStorage.getItem('soa_web_lang') || ''; } catch (_) { return ''; }
}

export async function snapshotNow(shell) {
    if (!shell) return null;
    const ts = Date.now();
    const tabs = [];
    for (const id of shell.order) {
        const rt = shell.tabs.get(id);
        if (!rt) continue;
        tabs.push({
            id,
            title: rt.title || `tab #${id}`,
            scrollback: _dumpScrollback(rt),
        });
    }
    const ctxPct = {};
    for (const [id, p] of shell._ctxPct || []) ctxPct[id] = p;
    const agentStatus = {};
    for (const [id, s] of shell._agentStatus || []) agentStatus[id] = s;
    const snap = {
        ts,
        v: SCHEMA_VERSION,
        viewMode: shell.viewMode,
        activeId: shell.activeId,
        order: [...shell.order],
        tabs,
        settings: _readSettings(),
        lang: _readLang(),
        ctxPct,
        agentStatus,
    };
    try {
        await _put(snap);
        await _prune();
        console.log(`[timemachine] saved snapshot at ${new Date(ts).toLocaleTimeString()} (${tabs.length} tabs)`);
    } catch (err) {
        console.warn('[timemachine] save failed', err);
    }
    return snap;
}

export async function listSnapshots() {
    const all = await _all();
    all.sort((a, b) => b.ts - a.ts);
    return all.map(s => ({
        ts: s.ts,
        tabCount: (s.tabs || []).length,
        avgCtx: _avgCtx(s),
        viewMode: s.viewMode,
    }));
}

function _avgCtx(snap) {
    const vals = Object.values(snap.ctxPct || {}).filter(v => typeof v === 'number');
    if (!vals.length) return null;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

export async function getSnapshot(ts) {
    return _tx('readonly').then(store => new Promise((res, rej) => {
        const r = store.get(ts);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => rej(r.error);
    }));
}

export async function deleteSnapshot(ts) { return _delete(ts); }
export async function clearAll() { return _clear(); }

/**
 * Restore a snapshot into the live UI. We don't respawn shells (the daemon
 * owns PTY identity); instead we replay each saved tab's rendered scrollback
 * into the matching live tab, prefixed by a divider, so the user lands on
 * the same view they had at snapshot time. Tabs that no longer exist are
 * skipped — a future enhancement could open new shells at the saved cwd,
 * but that requires the daemon to expose cwd-per-tab in the snapshot, which
 * tabPersist already does on its own cadence.
 */
export async function restoreSnapshot(ts, shell) {
    const snap = await getSnapshot(ts);
    if (!snap || !shell) return false;
    const stamp = new Date(snap.ts).toLocaleString();
    const divider = `\r\n\x1b[36m─── time machine: restored from ${stamp} ───\x1b[0m\r\n`;
    // Saved scrollback can carry terminal-STATE sequences (mouse tracking,
    // alt-screen, bracketed paste). Replaying them into xterm re-arms the mode,
    // and then mouse moves stream coordinate reports into the shell as input —
    // the 2026-07-13 "random typing" flood. Bracket the replay with a reset so
    // the terminal ends in a sane mode. (Mirrors SANE_TERM_RESET server-side.)
    const SANE = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1049l\x1b[?2004l\x1b[?25h\x1b>';
    let restored = 0;
    for (const sav of snap.tabs || []) {
        const rt = shell.tabs.get(sav.id);
        if (!rt) continue;
        const replay = (sav.scrollback || '').replace(/\n/g, '\r\n');
        rt.write(SANE + divider);
        if (replay) rt.write(replay + '\r\n');
        rt.write(SANE);
        restored++;
    }
    if (snap.activeId != null && shell.tabs.get(snap.activeId)) {
        try { shell._activate(snap.activeId); } catch (_) {}
    }
    console.log(`[timemachine] restored ${restored}/${(snap.tabs || []).length} tabs from ${stamp}`);
    return true;
}

export function startTimemachine(shell) {
    if (_timer) clearInterval(_timer);
    _shellRef = shell;
    _timer = setInterval(() => snapshotNow(shell), INTERVAL_MS);
    // First snapshot ~30s after boot so we always have a baseline even if
    // the user closes the tab inside the first 5 minutes.
    setTimeout(() => snapshotNow(shell), 30 * 1000);
    window.addEventListener('beforeunload', () => {
        try { snapshotNow(shell); } catch (_) {}
    });
}

export function stopTimemachine() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    _shellRef = null;
}

function _fmt(ts) {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
}

function _ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

export async function openTimemachineModal(shell) {
    let scrim = document.getElementById('soa-timemachine-modal');
    if (scrim) scrim.remove();
    scrim = document.createElement('div');
    scrim.id = 'soa-timemachine-modal';
    scrim.className = 'soa-modal-backdrop soa-tm-backdrop';
    scrim.innerHTML = `
        <div class="soa-modal soa-tm-modal" role="dialog" aria-label="Time machine">
            <header class="soa-tm-head">
                <h2>⟲ TIME MACHINE</h2>
                <div class="soa-tm-actions">
                    <button class="soa-tm-snap" type="button">Snapshot now</button>
                    <button class="soa-tm-clear" type="button">Clear all</button>
                    <button class="soa-tm-close" type="button" aria-label="Close">✕</button>
                </div>
            </header>
            <p class="soa-tm-sub">Auto-saves every 5 minutes to your browser. Up to ${MAX_SNAPSHOTS} kept.</p>
            <div class="soa-tm-list" data-empty="Loading…"></div>
            <footer class="soa-tm-foot">
                <small>Restoring replays scrollback into matching tabs. The daemon's own session restore handles PTY respawn.</small>
            </footer>
        </div>
    `;
    document.body.appendChild(scrim);

    const close = () => scrim.remove();
    scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
    scrim.querySelector('.soa-tm-close').addEventListener('click', close);

    const listEl = scrim.querySelector('.soa-tm-list');
    const render = async () => {
        listEl.dataset.empty = 'Loading…';
        listEl.innerHTML = '';
        let rows;
        try { rows = await listSnapshots(); }
        catch (err) {
            listEl.dataset.empty = 'Storage unavailable.';
            console.warn('[timemachine] list failed', err);
            return;
        }
        if (!rows.length) {
            listEl.dataset.empty = 'No snapshots yet — one will be taken automatically within 30 seconds.';
            return;
        }
        listEl.dataset.empty = '';
        for (const r of rows) {
            const row = document.createElement('div');
            row.className = 'soa-tm-row';
            const ctx = r.avgCtx == null ? '' : ` · ctx ~${r.avgCtx}%`;
            row.innerHTML = `
                <div class="soa-tm-when">
                    <strong>${_fmt(r.ts)}</strong>
                    <span class="soa-tm-meta">${_ago(r.ts)} · ${r.tabCount} tab${r.tabCount === 1 ? '' : 's'} · ${r.viewMode || 'tabs'}${ctx}</span>
                </div>
                <div class="soa-tm-row-actions">
                    <button class="soa-tm-restore" type="button">Restore</button>
                    <button class="soa-tm-del" type="button" aria-label="Delete">🗑</button>
                </div>
            `;
            row.querySelector('.soa-tm-restore').addEventListener('click', async () => {
                if (!confirm(`Restore IDE view from ${_fmt(r.ts)}? This replays scrollback into matching tabs.`)) return;
                await restoreSnapshot(r.ts, shell);
                close();
            });
            row.querySelector('.soa-tm-del').addEventListener('click', async () => {
                await deleteSnapshot(r.ts);
                render();
            });
            listEl.appendChild(row);
        }
    };

    scrim.querySelector('.soa-tm-snap').addEventListener('click', async () => {
        await snapshotNow(shell);
        render();
    });
    scrim.querySelector('.soa-tm-clear').addEventListener('click', async () => {
        if (!confirm('Delete all timemachine snapshots? This cannot be undone.')) return;
        await clearAll();
        render();
    });

    render();
}
