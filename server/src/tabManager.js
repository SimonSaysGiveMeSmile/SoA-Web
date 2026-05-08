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

const DEFAULT_SHELL = (() => {
    if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
    return process.env.SOA_WEB_SHELL || process.env.SHELL || '/bin/bash';
})();

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

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
    constructor({ id, title, cwd, env, cols, rows, onData, onExit }) {
        this.id = id;
        this.title = title || 'terminal';
        this.cwd = cwd || os.homedir();
        this.env = { ...process.env, ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
        this.cols = cols || DEFAULT_COLS;
        this.rows = rows || DEFAULT_ROWS;
        this.onData = onData || (() => {});
        this.onExit = onExit || (() => {});
        this.pty = null;
        this.exited = false;
        this.exitCode = null;
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
            queueMicrotask(() => {
                this.onData(`\x1b[31mfailed to spawn shell (${DEFAULT_SHELL}): ${err && err.message || err}\x1b[0m\r\n`);
                this.onExit(-1);
            });
            return this;
        }
        this.pty.onData(data => this.onData(data));
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
}

class TabManager {
    constructor({ onData, onTabsChange, onExit } = {}) {
        this.tabs = new Map();
        this.order = [];
        this.next = 1;
        this.onData = onData || (() => {});
        this.onTabsChange = onTabsChange || (() => {});
        this.onExit = onExit || (() => {});
    }

    list() {
        return this.order.map(id => {
            const t = this.tabs.get(id);
            return { id: t.id, title: t.title, cols: t.cols, rows: t.rows, exited: t.exited };
        });
    }

    get(id) { return this.tabs.get(id) || null; }

    open({ title, cwd, cols, rows } = {}) {
        const id = this.next++;
        const tab = new Tab({
            id,
            title: title || `tab ${id}`,
            cwd, cols, rows,
            onData: data => this.onData(id, data),
            onExit: code => {
                this.onExit(id, code);
                this._forget(id);
                this.onTabsChange(this.list());
            },
        }).spawn();
        this.tabs.set(id, tab);
        this.order.push(id);
        this.onTabsChange(this.list());
        return tab;
    }

    close(id) {
        const tab = this.tabs.get(id);
        if (!tab) return;
        tab.kill();
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

    killAll() {
        for (const tab of this.tabs.values()) tab.kill();
    }

    _forget(id) {
        this.tabs.delete(id);
        this.order = this.order.filter(x => x !== id);
    }
}

module.exports = { TabManager, Tab, DEFAULT_SHELL };
