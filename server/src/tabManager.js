/**
 * TabManager
 *
 * One PTY per tab. Each session owns a TabManager. The manager knows how to
 * spawn, resize, write to, and kill tabs, and it exposes the per-tab output
 * through a sink (a function the WebSocket layer sets up to forward bytes to
 * the browser).
 *
 * node-pty is required at call time so the server module itself can be loaded
 * on machines where native compilation failed — the user will still get a
 * readable error when they try to open a tab.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const DEFAULT_SHELL = (() => {
    if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
    return process.env.SOA_WEB_SHELL || process.env.SHELL || '/bin/bash';
})();

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

// Bounded per-tab replay buffer. A browser reload (or a WS drop) must be able
// to catch up on output that arrived while nothing was listening, so every tab
// keeps the last N bytes of raw PTY output. 256 KiB is enough to cover many
// screens of scrollback without letting a runaway process balloon memory.
const DEFAULT_SCROLLBACK_BYTES = parseInt(
    process.env.SOA_WEB_SCROLLBACK_BYTES || String(256 * 1024), 10,
);

class RingBuffer {
    constructor(cap) {
        this.cap = Math.max(1, cap | 0);
        this.chunks = [];
        this.size = 0;
    }
    push(str) {
        if (typeof str !== 'string' || str.length === 0) return;
        this.chunks.push(str);
        this.size += str.length;
        while (this.size > this.cap && this.chunks.length > 1) {
            this.size -= this.chunks.shift().length;
        }
        if (this.size > this.cap && this.chunks.length === 1) {
            const only = this.chunks[0];
            const trimmed = only.slice(only.length - this.cap);
            this.chunks[0] = trimmed;
            this.size = trimmed.length;
        }
    }
    snapshot() { return this.chunks.join(''); }
    clear() { this.chunks.length = 0; this.size = 0; }
}

// Resolve a process's current working directory by PID.
//
// The shell's cwd drifts as the user `cd`s around — we mirror the macOS
// Terminal.app behavior of labeling each tab with the folder the shell is
// sitting in right now, not the one it was spawned in. Platform options:
//   Linux:  readlink /proc/<pid>/cwd — single syscall, authoritative.
//   macOS:  `lsof -a -p <pid> -d cwd -Fn` — the `n` field holds the cwd.
//           It's ~10ms so we only poll on Enter, not on every keystroke.
//   Other:  return null and fall back to the spawn cwd.
function resolveCwdByPid(pid) {
    if (!pid || pid < 0) return null;
    try {
        if (process.platform === 'linux') {
            return fs.readlinkSync(`/proc/${pid}/cwd`);
        }
        if (process.platform === 'darwin') {
            const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
                encoding: 'utf8',
                timeout: 500,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            for (const line of out.split('\n')) {
                if (line.startsWith('n')) return line.slice(1).trim() || null;
            }
            return null;
        }
    } catch (_) { /* process gone, permission denied, lsof missing */ }
    return null;
}

let _pty = null;
function requirePty() {
    if (_pty) return _pty;
    try { _pty = require('node-pty'); }
    catch (err) {
        const e = new Error('node-pty is unavailable: ' + err.message + '. Install build tools and reinstall dependencies.');
        e.cause = err;
        throw e;
    }
    return _pty;
}

class Tab {
    constructor({ id, title, cwd, env, cols, rows, scrollbackBytes, onData, onExit }) {
        this.id = id;
        this.cwd = cwd || os.homedir();
        // Default the tab label to the cwd's folder name so "Hireal" shows
        // up as "Hireal" instead of "tab 1". A caller-supplied title wins,
        // and so does any later user rename (tracked via userRenamed).
        this.autoTitleBase = path.basename(this.cwd) || 'terminal';
        this.title = title || this.autoTitleBase;
        this.userRenamed = !!title;
        this.env = { ...process.env, ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
        this.cols = cols || DEFAULT_COLS;
        this.rows = rows || DEFAULT_ROWS;
        this.onData = onData || (() => {});
        this.onExit = onExit || (() => {});
        this.pty = null;
        this.exited = false;
        this.exitCode = null;
        this.scrollback = new RingBuffer(scrollbackBytes || DEFAULT_SCROLLBACK_BYTES);
    }

    spawn() {
        const pty = requirePty();
        try {
            this.pty = pty.spawn(DEFAULT_SHELL, [], {
                name: 'xterm-256color',
                cols: this.cols,
                rows: this.rows,
                cwd: this.cwd,
                env: this.env,
            });
        } catch (err) {
            this.exited = true;
            this.exitCode = -1;
            const msg = `\x1b[31mfailed to spawn shell (${DEFAULT_SHELL}): ${err && err.message || err}\x1b[0m\r\n`;
            this.scrollback.push(msg);
            queueMicrotask(() => {
                this.onData(msg);
                this.onExit(-1);
            });
            return this;
        }
        this.pty.onData(data => {
            this.scrollback.push(data);
            this.onData(data);
        });
        this.pty.onExit(({ exitCode }) => {
            this.exited = true;
            this.exitCode = exitCode;
            this.onExit(exitCode);
        });
        return this;
    }

    write(data) {
        if (this.exited || !this.pty) return;
        this.pty.write(data);
    }

    resize(cols, rows) {
        if (this.exited || !this.pty) return;
        this.cols = cols; this.rows = rows;
        try { this.pty.resize(cols, rows); } catch (_) { /* PTY may be closing */ }
    }

    kill() {
        if (!this.pty) return;
        try { this.pty.kill(); } catch (_) { /* ignore */ }
    }

    // Poll the shell's live cwd. Returns true when it changed — the caller
    // uses that to skip the label recompute + snapshot for keystrokes that
    // didn't actually move the shell.
    refreshCwd() {
        if (this.exited || !this.pty) return false;
        const next = resolveCwdByPid(this.pty.pid);
        if (!next || next === this.cwd) return false;
        this.cwd = next;
        this.autoTitleBase = path.basename(next) || 'terminal';
        return true;
    }
}

class TabManager {
    constructor({ onData, onTabsChange, onExit, graveyardCap } = {}) {
        this.tabs = new Map();
        this.order = [];
        this.next = 1;
        this.onData = onData || (() => {});
        this.onTabsChange = onTabsChange || (() => {});
        this.onExit = onExit || (() => {});
        // Graveyard holds a capped FIFO of recently-closed tabs so the client
        // can offer "restore closed tab". We store everything we can replay:
        // cwd, title (pre-auto-suffix), user-rename flag, and the final
        // scrollback snapshot. PTY state (env, jobs, shell history) dies with
        // the process — restore spawns a fresh shell at the saved cwd and
        // seeds the new tab's scrollback with the archived bytes plus a
        // visible divider, so the user can see what WAS there but knows the
        // process itself is new.
        this.graveyard = [];
        this.graveyardCap = Math.max(1, graveyardCap || 10);
    }

    list() {
        return this.order.map(id => {
            const t = this.tabs.get(id);
            return { id: t.id, title: t.title, cols: t.cols, rows: t.rows, exited: t.exited };
        });
    }

    // Compact view of the graveyard for snapshots — just id + title so the
    // client can render a "restore this tab" affordance without carrying the
    // full scrollback around on every redraw.
    graveyardList() {
        return this.graveyard.map(g => ({
            id: g.id, title: g.displayTitle, closedAt: g.closedAt,
        }));
    }

    get(id) { return this.tabs.get(id) || null; }

    scrollback(id) {
        const t = this.tabs.get(id);
        return t ? t.scrollback.snapshot() : '';
    }

    open({ title, cwd, cols, rows, silent, seedScrollback } = {}) {
        const id = this.next++;
        const tab = new Tab({
            id,
            title: title || undefined,
            cwd, cols, rows,
            onData: data => this.onData(id, data),
            onExit: code => {
                this._archive(id);
                this.onExit(id, code);
                this._forget(id);
                // A tab closing can un-collide its neighbors — e.g. the
                // only other "Hireal" left shouldn't keep a -N suffix.
                this._refreshAutoTitles();
                this.onTabsChange(this.list());
            },
        }).spawn();
        // Seed scrollback BEFORE spawn writes anything so the client sees
        // the seed then the fresh prompt in chronological order. node-pty
        // won't emit until its onData listener runs (next tick), so this
        // write lands cleanly at the start of the ring buffer.
        if (seedScrollback) tab.scrollback.push(String(seedScrollback));
        this.tabs.set(id, tab);
        this.order.push(id);
        this._refreshAutoTitles();
        if (!silent) this.onTabsChange(this.list());
        return tab;
    }

    close(id) {
        const tab = this.tabs.get(id);
        if (!tab) return;
        tab.kill();
    }

    // Pop the most-recently-closed tab (or a specific id) from the graveyard,
    // spawn a fresh shell at its saved cwd, seed the scrollback with the old
    // output plus a divider so the user sees the continuity without being
    // misled about the process. Returns the new tab or null.
    restore({ id, cols, rows } = {}) {
        let entry;
        if (id != null) {
            const idx = this.graveyard.findIndex(g => g.id === id);
            if (idx === -1) return null;
            entry = this.graveyard.splice(idx, 1)[0];
        } else {
            entry = this.graveyard.pop();
        }
        if (!entry) return null;
        const divider = `\r\n\x1b[2m── ${entry.displayTitle} · restored from closed tab (fresh shell) ──\x1b[0m\r\n`;
        const seed = (entry.scrollback || '') + divider;
        const tab = this.open({
            title: entry.userRenamed ? entry.displayTitle : undefined,
            cwd: entry.cwd,
            cols, rows,
            silent: false,
            seedScrollback: seed,
        });
        return tab;
    }

    // Snapshot a tab's restorable state into the graveyard. Called from the
    // PTY exit path — by then the ring buffer is final and the cwd is the
    // shell's last known one. Trims the graveyard to its cap.
    _archive(id) {
        const tab = this.tabs.get(id);
        if (!tab) return;
        this.graveyard.push({
            id: tab.id,
            displayTitle: tab.title,
            userRenamed: tab.userRenamed,
            cwd: tab.cwd,
            closedAt: Date.now(),
            scrollback: tab.scrollback.snapshot(),
        });
        while (this.graveyard.length > this.graveyardCap) this.graveyard.shift();
    }

    // title === '' or null clears the user-rename flag and reverts to the
    // auto name (cwd basename + -N suffix on collision). Passing a real
    // string pins it — subsequent cd's won't touch it.
    rename(id, title) {
        const tab = this.tabs.get(id);
        if (!tab) return false;
        const trimmed = (title || '').trim();
        let next;
        if (trimmed) {
            tab.userRenamed = true;
            next = trimmed;
        } else {
            tab.userRenamed = false;
            // Fall back to the auto name; _refreshAutoTitles will assign
            // the final string with any needed -N suffix.
            next = tab.autoTitleBase || path.basename(tab.cwd) || `tab ${id}`;
        }
        if (tab.title !== next) tab.title = next;
        this._refreshAutoTitles();
        this.onTabsChange(this.list());
        return true;
    }

    move(id, beforeId) {
        if (!this.tabs.has(id)) return;
        this.order = this.order.filter(x => x !== id);
        if (beforeId == null || beforeId === -1) {
            this.order.push(id);
        } else {
            const idx = this.order.indexOf(beforeId);
            if (idx === -1) this.order.push(id);
            else this.order.splice(idx, 0, id);
        }
        this.onTabsChange(this.list());
    }

    // Called after each Enter keypress: re-resolves the shell's cwd and,
    // if it changed, recomputes the auto title for this tab and any other
    // tab that might collide with it. Returns true when a snapshot should
    // be emitted.
    pokeCwd(id) {
        const tab = this.tabs.get(id);
        if (!tab) return false;
        if (!tab.refreshCwd()) return false;
        const changed = this._refreshAutoTitles();
        // Always emit when the cwd changed for an auto-named tab — the
        // title itself may be the same (same basename) but a sibling tab
        // may have newly collided or un-collided.
        if (changed || !tab.userRenamed) this.onTabsChange(this.list());
        return true;
    }

    killAll() {
        for (const tab of this.tabs.values()) tab.kill();
    }

    _forget(id) {
        this.tabs.delete(id);
        this.order = this.order.filter(x => x !== id);
    }

    // Assign titles for every auto-named tab. Two auto tabs sharing a
    // basename both get a -N suffix starting at -1, numbered by tab id so
    // the oldest keeps -1 and newcomers stack on the end. Tabs the user
    // renamed are skipped — their labels are sacred. Returns true when
    // any title changed, so callers can skip a no-op snapshot emit.
    _refreshAutoTitles() {
        const buckets = new Map();
        for (const id of this.order) {
            const tab = this.tabs.get(id);
            if (!tab || tab.userRenamed) continue;
            const base = tab.autoTitleBase || path.basename(tab.cwd) || `tab ${id}`;
            let list = buckets.get(base);
            if (!list) { list = []; buckets.set(base, list); }
            list.push(tab);
        }
        let changed = false;
        for (const [base, list] of buckets) {
            if (list.length === 1) {
                const only = list[0];
                if (only.title !== base) { only.title = base; changed = true; }
                continue;
            }
            // Stable order: sort by id so older tabs keep their suffix
            // across renames or cwd changes.
            list.sort((a, b) => a.id - b.id);
            list.forEach((tab, i) => {
                const label = `${base}-${i + 1}`;
                if (tab.title !== label) { tab.title = label; changed = true; }
            });
        }
        return changed;
    }
}

module.exports = { TabManager, Tab, RingBuffer, DEFAULT_SHELL, resolveCwdByPid };
