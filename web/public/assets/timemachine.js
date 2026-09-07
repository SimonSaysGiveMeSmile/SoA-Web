/**
 * Timemachine
 *
 * Snapshots the IDE's state every 5 minutes into IndexedDB so the user can
 * rewind to any prior point — even after a reload, a browser crash, or a daemon
 * restart that took the terminals with it.
 *
 * Restore is TWO phases, and phase 1 is the one that was missing:
 *
 *   1. REBUILD. The snapshot records each tab's cwd, so restore hands the list to
 *      the daemon (POST /api/fleet/restore → server/src/fleetRestore.js), which
 *      reopens every tab that is no longer live and resumes its Claude
 *      conversation (distinct transcripts for tabs that share a cwd). This is the
 *      same code path the soa-restore-fleet CLI uses.
 *   2. REPLAY. Tabs that were ALREADY open get their saved scrollback replayed,
 *      so the on-screen history comes back too.
 *
 * A tab the daemon just reopened is deliberately NOT replayed: `claude --resume`
 * is already printing the real conversation into it, and interleaving a saved
 * transcript with live output would garble both. Rebuilt tabs get the real
 * context; surviving tabs get their view back.
 *
 * Snapshots taken before v2 have no cwd (id-only), so they can only replay —
 * listSnapshots() marks them so the UI can say so instead of silently doing
 * nothing, which is what "the time machine doesn't work" meant.
 *
 * What we capture per snapshot:
 *   - viewMode, activeId, tab order
 *   - per tab: id, title, cwd, scrollback rendered from xterm's active buffer
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
// v2 adds per-tab cwd — the field that makes REBUILD possible. v1 snapshots stay
// readable and restore in replay-only mode.
const SCHEMA_VERSION = 2;
// A snapshot is worthless if writing it wedges the tab, so IDB work is bounded.
const IDB_TIMEOUT_MS = 4000;
// How long to wait for the daemon's reopened tabs to arrive over the WS snapshot.
const REBUILD_SETTLE_MS = 6000;

let _db = null;
let _timer = null;
let _shellRef = null;
// Sticky: IndexedDB is unavailable in some private/hardened modes, and it fails
// on the FIRST call. Remember that instead of retrying (and re-warning) forever.
let _storageError = null;

function _open() {
    if (_db) return Promise.resolve(_db);
    if (_storageError) return Promise.reject(_storageError);
    return new Promise((resolve, reject) => {
        let req;
        // `indexedDB` itself can throw on access (blocked site data), not just fail.
        try { req = indexedDB.open(DB_NAME, DB_VERSION); }
        catch (err) { _storageError = err; reject(err); return; }
        // A blocked upgrade (another tab holding an old version) never fires
        // success OR error — without this timeout the modal spins forever.
        const timer = setTimeout(() => {
            _storageError = new Error('IndexedDB did not respond (another tab may be blocking an upgrade)');
            reject(_storageError);
        }, IDB_TIMEOUT_MS);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'ts' });
            }
        };
        req.onsuccess = () => { clearTimeout(timer); _db = req.result; resolve(_db); };
        req.onerror = () => { clearTimeout(timer); _storageError = req.error || new Error('IndexedDB open failed'); reject(_storageError); };
        req.onblocked = () => { /* the timeout above is the escape hatch */ };
    });
}

export function storageError() { return _storageError ? (_storageError.message || String(_storageError)) : null; }

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

// Quota is the one write failure worth fighting: drop the oldest half and retry
// once, so a full store degrades to a shorter history instead of no history.
async function _putTolerant(snap) {
    try { await _put(snap); return true; }
    catch (err) {
        const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(err.name || err.message || ''));
        if (!quota) throw err;
        const all = await _all();
        all.sort((a, b) => a.ts - b.ts);
        for (let i = 0; i < Math.ceil(all.length / 2); i++) await _delete(all[i].ts);
        console.warn('[timemachine] storage full — pruned oldest half and retrying');
        await _put(snap);
        return true;
    }
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
            // The field that makes a rebuild possible. Without it a snapshot can
            // only ever repaint tabs that still exist.
            cwd: (shell._tabCwd && shell._tabCwd.get(id)) || null,
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
    // Never snapshot an empty fleet over a good history: a snapshot taken during
    // boot (or right after a daemon restart, before tabs rehydrate) would
    // otherwise become the newest entry and look like "everything was closed".
    if (!tabs.length) return null;
    try {
        await _putTolerant(snap);
        await _prune();
        console.log(`[timemachine] saved snapshot at ${new Date(ts).toLocaleTimeString()} (${tabs.length} tabs, ${tabs.filter(t => t.cwd).length} with cwd)`);
    } catch (err) {
        console.warn('[timemachine] save failed', err);
        return null;
    }
    return snap;
}

export async function listSnapshots() {
    const all = await _all();
    all.sort((a, b) => b.ts - a.ts);
    return all.map(s => ({
        ts: s.ts,
        tabCount: (s.tabs || []).length,
        // A snapshot can rebuild only the tabs whose cwd it recorded.
        cwdCount: (s.tabs || []).filter(t => t && t.cwd).length,
        v: s.v || 1,
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

function _api(shell, p) {
    const base = (shell && shell.backend ? String(shell.backend) : '').replace(/\/+$/, '');
    try { return new URL(base + p, location.origin).toString(); }
    catch (_) { return p; }
}

/** cwd -> count, over the tabs currently live in the shell. */
function _liveByCwd(shell) {
    const m = new Map();
    for (const id of shell.order || []) {
        const cwd = shell._tabCwd && shell._tabCwd.get(id);
        if (cwd) m.set(cwd, (m.get(cwd) || 0) + 1);
    }
    return m;
}

/**
 * Phase 1 — REBUILD. Ask the daemon to reopen every snapshot tab that is no
 * longer live and resume its Claude conversation. Returns the ids the daemon
 * opened (so phase 2 knows not to replay into them) plus a human summary.
 *
 * Failure here is never fatal: if the endpoint is missing (older daemon) or the
 * call fails, we fall through to a replay-only restore and say so.
 */
async function _rebuild(snap, shell) {
    const want = (snap.tabs || []).filter(t => t && t.cwd);
    if (!want.length) {
        return { openedIds: new Set(), note: (snap.v || 1) < 2
            ? 'snapshot predates cwd recording — replay only'
            : 'no cwds in snapshot — replay only' };
    }
    // Only send what is actually missing. The daemon does this multiset check
    // too (it is the authority on what is live) — doing it here as well keeps
    // the "nothing to rebuild" case from making a pointless round trip.
    const live = _liveByCwd(shell);
    const missing = [];
    for (const t of want) {
        const have = live.get(t.cwd) || 0;
        if (have > 0) { live.set(t.cwd, have - 1); continue; }
        missing.push({ cwd: t.cwd, title: t.title || null, userRenamed: !!t.title });
    }
    if (!missing.length) return { openedIds: new Set(), note: 'every tab still open — nothing to rebuild' };

    let r;
    try {
        r = await fetch(_api(shell, '/api/fleet/restore'), {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tabs: missing, resume: true }),
        });
    } catch (err) {
        return { openedIds: new Set(), note: `rebuild unavailable (${err.message}) — replay only` };
    }
    if (!r.ok) {
        return { openedIds: new Set(), note: `rebuild refused (${r.status}) — replay only` };
    }
    let out = {};
    try { out = await r.json(); } catch (_) {}
    const opened = Array.isArray(out.opened) ? out.opened : [];
    // The tabs arrive over the WS as a SNAPSHOT frame; wait for the shell to
    // actually hold them before replaying, so phase 2 matches against reality.
    if (opened.length) await _settle(shell, (shell.tabs ? shell.tabs.size : 0) + opened.length);
    return {
        openedIds: new Set(opened.map(o => o.id)),
        note: `rebuilt ${opened.length} tab(s) from ${out.from || 'disk'}`
            + (opened.filter(o => o.sessionId).length ? `, resuming ${opened.filter(o => o.sessionId).length}` : ''),
    };
}

// Wait (briefly) for the shell to reach an expected tab count. Resolves early
// the moment it does, and gives up quietly — a restore must never hang.
function _settle(shell, expected) {
    const deadline = Date.now() + REBUILD_SETTLE_MS;
    return new Promise(resolve => {
        const poll = () => {
            if (!shell.tabs || shell.tabs.size >= expected || Date.now() > deadline) return resolve();
            setTimeout(poll, 150);
        };
        poll();
    });
}

/**
 * Restore a snapshot. Two phases, in this order:
 *
 *   1. REBUILD closed terminals through the daemon (real cwd, real
 *      `claude --resume`) — see _rebuild above;
 *   2. REPLAY saved scrollback into tabs that were already open, matched by cwd
 *      (a multiset, so three tabs on one cwd each get their own history) and
 *      falling back to tab id for v1 snapshots that have no cwd.
 *
 * Rebuilt tabs are never replayed into: `claude --resume` is already writing the
 * real conversation there, and two writers would garble each other.
 *
 * Returns a report — {ok, rebuilt, replayed, total, note} — so the UI can say
 * what happened instead of leaving the user guessing.
 */
export async function restoreSnapshot(ts, shell) {
    const snap = await getSnapshot(ts);
    if (!snap || !shell) return { ok: false, note: 'snapshot not found' };
    const stamp = new Date(snap.ts).toLocaleString();
    const divider = `\r\n\x1b[36m─── time machine: restored from ${stamp} ───\x1b[0m\r\n`;
    // Saved scrollback can carry terminal-STATE sequences (mouse tracking,
    // alt-screen, bracketed paste). Replaying them into xterm re-arms the mode,
    // and then mouse moves stream coordinate reports into the shell as input —
    // the 2026-07-13 "random typing" flood. Bracket the replay with a reset so
    // the terminal ends in a sane mode. (Mirrors SANE_TERM_RESET server-side.)
    const SANE = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1049l\x1b[?2004l\x1b[?25h\x1b>';

    const { openedIds, note } = await _rebuild(snap, shell);

    // Build cwd -> [live tab ids] for matching, skipping tabs the daemon just
    // opened (they are mid `claude --resume`).
    const byCwd = new Map();
    for (const id of shell.order || []) {
        if (openedIds.has(id)) continue;
        const cwd = (shell._tabCwd && shell._tabCwd.get(id)) || null;
        if (!cwd) continue;
        if (!byCwd.has(cwd)) byCwd.set(cwd, []);
        byCwd.get(cwd).push(id);
    }

    let replayed = 0;
    for (const sav of snap.tabs || []) {
        // cwd first (survives a daemon restart, which renumbers every tab id),
        // then the saved id as a fallback for pre-v2 snapshots.
        let id = null;
        if (sav.cwd && byCwd.has(sav.cwd) && byCwd.get(sav.cwd).length) id = byCwd.get(sav.cwd).shift();
        else if (!sav.cwd && shell.tabs.has(sav.id) && !openedIds.has(sav.id)) id = sav.id;
        if (id == null) continue;
        const rt = shell.tabs.get(id);
        if (!rt) continue;
        const replay = (sav.scrollback || '').replace(/\n/g, '\r\n');
        rt.write(SANE + divider);
        if (replay) rt.write(replay + '\r\n');
        rt.write(SANE);
        replayed++;
    }

    // Land on the tab that was active, matched by cwd so it survives renumbering.
    const savedActive = (snap.tabs || []).find(t => t && t.id === snap.activeId);
    let activate = null;
    if (savedActive && savedActive.cwd) {
        for (const id of shell.order || []) {
            if ((shell._tabCwd && shell._tabCwd.get(id)) === savedActive.cwd) { activate = id; break; }
        }
    }
    if (activate == null && snap.activeId != null && shell.tabs.has(snap.activeId)) activate = snap.activeId;
    if (activate != null) { try { shell._activate(activate); } catch (_) {} }

    const report = {
        ok: true, rebuilt: openedIds.size, replayed,
        total: (snap.tabs || []).length, note, stamp,
    };
    console.log(`[timemachine] restore from ${stamp}: rebuilt ${report.rebuilt}, replayed ${report.replayed}/${report.total} — ${note}`);
    return report;
}

export function startTimemachine(shell) {
    if (_timer) clearInterval(_timer);
    _shellRef = shell;
    _timer = setInterval(() => snapshotNow(shell), INTERVAL_MS);
    // First snapshot ~30s after boot so we always have a baseline even if
    // the user closes the tab inside the first 5 minutes.
    setTimeout(() => snapshotNow(shell), 30 * 1000);
    // beforeunload is the wrong hook for an ASYNC write — the page can be torn
    // down before IDB commits, which is why "it never saved my last view" was a
    // real complaint. visibilitychange→hidden is the one the platform guarantees
    // to deliver on tab close, backgrounding and mobile app switch.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'hidden') return;
        try { snapshotNow(shell); } catch (_) {}
    });
    window.addEventListener('pagehide', () => { try { snapshotNow(shell); } catch (_) {} });
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
            <p class="soa-tm-sub">Auto-saves every 5 minutes to this browser (up to ${MAX_SNAPSHOTS}). Restoring <strong>reopens closed terminals</strong> at their saved directory and resumes each one's Claude conversation, then replays saved scrollback into the tabs that were still open.</p>
            <p class="soa-tm-status" role="status"></p>
            <div class="soa-tm-list" data-empty="Loading…"></div>
            <footer class="soa-tm-foot">
                <small>Rebuilt tabs get the real conversation back via <code>claude --resume</code>; surviving tabs get their on-screen history replayed. Restore only ever opens tabs — it never closes one.</small>
            </footer>
        </div>
    `;
    document.body.appendChild(scrim);

    const close = () => scrim.remove();
    scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
    scrim.querySelector('.soa-tm-close').addEventListener('click', close);

    const listEl = scrim.querySelector('.soa-tm-list');
    const statusEl = scrim.querySelector('.soa-tm-status');
    const say = (msg, kind = '') => { statusEl.textContent = msg || ''; statusEl.dataset.kind = kind; };
    const render = async () => {
        listEl.dataset.empty = 'Loading…';
        listEl.innerHTML = '';
        let rows;
        try { rows = await listSnapshots(); }
        catch (err) {
            listEl.dataset.empty = `Storage unavailable: ${storageError() || err.message}`;
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
            // Say up front what this row can actually do: a v1 snapshot has no
            // cwds, so it can only repaint tabs that still exist.
            const kind = r.cwdCount ? `${r.cwdCount} restorable` : 'view only';
            row.innerHTML = `
                <div class="soa-tm-when">
                    <strong>${_fmt(r.ts)}</strong>
                    <span class="soa-tm-meta">${_ago(r.ts)} · ${r.tabCount} tab${r.tabCount === 1 ? '' : 's'} · ${kind} · ${r.viewMode || 'tabs'}${ctx}</span>
                </div>
                <div class="soa-tm-row-actions">
                    <button class="soa-tm-restore" type="button">Restore</button>
                    <button class="soa-tm-del" type="button" aria-label="Delete">🗑</button>
                </div>
            `;
            const restoreBtn = row.querySelector('.soa-tm-restore');
            restoreBtn.addEventListener('click', async () => {
                // No confirm dialog: restore is additive — it opens tabs and
                // replays text, and never closes or overwrites anything. A modal
                // dialog here also freezes the page for automation and phones.
                restoreBtn.disabled = true;
                restoreBtn.textContent = 'Restoring…';
                say(`Restoring ${_fmt(r.ts)} — reopening terminals…`);
                try {
                    const out = await restoreSnapshot(r.ts, shell);
                    if (!out || !out.ok) { say(`Restore failed: ${(out && out.note) || 'unknown error'}`, 'bad'); }
                    else {
                        say(`Restored ${_fmt(r.ts)} · rebuilt ${out.rebuilt} · replayed ${out.replayed}/${out.total} · ${out.note}`, 'good');
                        setTimeout(close, 2200);
                    }
                } catch (err) {
                    say(`Restore failed: ${err.message}`, 'bad');
                } finally {
                    restoreBtn.disabled = false;
                    restoreBtn.textContent = 'Restore';
                }
                render();
            });
            row.querySelector('.soa-tm-del').addEventListener('click', async () => {
                try { await deleteSnapshot(r.ts); } catch (err) { say(`Delete failed: ${err.message}`, 'bad'); }
                render();
            });
            listEl.appendChild(row);
        }
    };

    scrim.querySelector('.soa-tm-snap').addEventListener('click', async () => {
        const snap = await snapshotNow(shell);
        say(snap ? `Snapshot saved · ${snap.tabs.length} tab(s)` : `Snapshot not saved${storageError() ? ` (${storageError()})` : ' (no tabs open)'}`,
            snap ? 'good' : 'bad');
        render();
    });
    // Two-step instead of confirm(): the second click inside 4s does it. Same
    // protection, no blocking dialog.
    const clearBtn = scrim.querySelector('.soa-tm-clear');
    let armed = null;
    clearBtn.addEventListener('click', async () => {
        if (!armed) {
            armed = setTimeout(() => { armed = null; clearBtn.textContent = 'Clear all'; say(''); }, 4000);
            clearBtn.textContent = 'Click again to delete all';
            say('This deletes every snapshot in this browser and cannot be undone.', 'bad');
            return;
        }
        clearTimeout(armed); armed = null; clearBtn.textContent = 'Clear all';
        try { await clearAll(); say('All snapshots deleted.'); }
        catch (err) { say(`Clear failed: ${err.message}`, 'bad'); }
        render();
    });

    render();
}
