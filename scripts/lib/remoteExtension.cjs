'use strict';

// One independent display, owned by the viewer that explicitly starts it.
// It never mirrors, resizes or restores a physical display. All OS commands
// stay in the short-lived virtual-display helper; dropping stdin removes it.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');

const messages = {
    busy: 'A display change is still running.',
    owned: 'Another device is using the second display.',
    fit: 'Turn off Fit before starting a second display.',
    video: 'Extend needs H.264 video in this browser.',
    unavailable: 'This Mac could not create a second display.',
    lost: 'The second display disconnected. Choose Extend to reconnect it.',
    capture: 'Second-display video is unavailable. Choose Extend to retry, or Mirror.',
    expired: 'The second display closed while you were away. Choose Extend to start again.',
};

function geometry(q) {
    if (!q || !q.online || !q.id || q.main === q.id || q.mirrorOf) return null;
    const m = q.mode, b = q.bounds;
    if (!m || !b || ![m.width, m.height, m.pixelWidth, m.pixelHeight].every(n => Number.isFinite(n) && n > 0)
        || ![b.x, b.y].every(Number.isFinite)) return null;
    return { width: m.width, height: m.height, scale: m.pixelWidth / m.width, x: b.x, y: b.y, displayId: q.id };
}
function localPoint(screen, x, y) { return { x: Math.round(x - (screen.x || 0)), y: Math.round(y - (screen.y || 0)) }; }
function globalPoint(screen, x, y) {
    const clamp = (v, limit) => Math.max(0, Math.min(limit - 1, Math.round(Number.isFinite(+v) ? +v : 0)));
    return { x: (screen.x || 0) + clamp(x, screen.width), y: (screen.y || 0) + clamp(y, screen.height) };
}

class RemoteExtension {
    constructor({ binary, build, workDir, specFor, blocked, beforeChange, changed, log = () => {}, graceMs = 30000, debounceMs = 1500, checkMs = 3000 }) {
        Object.assign(this, { binary, build, specFor, blocked, beforeChange, changed, log, graceMs, debounceMs });
        this.marker = path.join(workDir, 'extended-display.json');
        // DRY fit and DRY extend must not overwrite each other's fake state.
        this.env = { ...process.env, SOA_VDISPLAY_DRY_STATE: path.join(workDir, 'extended-display-dry.json') };
        this.state = 'off'; this.owner = null; this.dev = ''; this.child = null; this.screen = null;
        this.position = 'right'; this.text = 'default'; this.generation = 0; this.version = 0;
        this.command = null; this.operation = null; this.pending = null; this.error = '';
        this.watch = setInterval(() => this.check().catch(e => this.log('extend check:', e.message)), checkMs);
        this.watch.unref();
    }
    get held() { return !!this.child || !!this.operation || this.state === 'on'; }
    source(ws) { return ws && ws.extended && this.owner === ws && this.state === 'on' ? { ...this.screen, revision: this.version } : null; }
    info(ws) {
        return { state: this.state, mine: !!ws && this.owner === ws, selected: !!(ws && ws.extended),
            owner: !this.held ? 'none' : this.owner === ws && ws ? 'you' : this.owner ? 'other' : 'away',
            position: this.position, text: this.text, screen: this.source(ws), graceMs: this.graceMs,
            message: ws && ws.extended ? this.error : '' };
    }
    notify() { this.changed(); }
    refuse(ws, reason) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'extend', ...this.info(ws), ok: false, reason, message: messages[reason] || reason }));
    }
    remember() {
        fs.writeFileSync(this.marker, JSON.stringify({ pid: this.child?.pid, id: this.screen?.displayId || 0, binary: this.binary }) + '\n', { mode: 0o600 });
    }
    async request(ws, m) {
        if (!['start', 'resume', 'resize', 'stop'].includes(m.action)) return;
        if (!/^[\w-]{6,64}$/.test(m.dev || '')) return this.refuse(ws, 'Invalid device identity.');
        const mine = this.dev === m.dev;
        if (m.action === 'stop') {
            if (this.held && !mine) return this.refuse(ws, 'owned');
            if (!this.held) { ws.extended = false; this.error = ''; this.beforeChange(ws); this.notify(); return; }
            this.generation++; this.state = 'stopping'; this.pending = null;
            clearTimeout(this.resizeTimer); clearTimeout(this.leaveTimer);
            this.beforeChange(this.owner); this.notify();
            // Abort a slow create/resize now; do not wait for its command timeout.
            if (this.operation && this.child) this.child.kill('SIGTERM');
            await this.operation;
            await this.remove();
            if (this.owner) this.owner.extended = false;
            ws.extended = false; this.owner = null; this.dev = ''; this.screen = null; this.state = 'off'; this.error = '';
            this.notify(); return;
        }
        if (this.held && !mine) return this.refuse(ws, 'owned');
        if (m.action === 'resume' && !this.held) {
            ws.extended = false; this.beforeChange(ws); this.refuse(ws, 'expired'); this.notify(); return;
        }
        if (ws.mode !== 'h264') return this.refuse(ws, 'video');
        const reason = this.blocked();
        if (reason) return this.refuse(ws, reason);
        if (this.state === 'stopping') return this.refuse(ws, 'busy');
        if (m.action === 'resize' && (!mine || !this.held)) return;
        const a = m.area;
        if (!a || ![a.w, a.h].every(n => Number.isFinite(n) && n >= 50 && n <= 10000)) return this.refuse(ws, 'Invalid screen size.');
        const request = { area: { w: Math.round(a.w), h: Math.round(a.h) }, text: ['smaller', 'larger'].includes(m.text) ? m.text : 'default', position: m.position === 'left' ? 'left' : 'right' };
        if (this.owner !== ws) {
            const old = this.owner;
            if (old) { old.extended = false; this.beforeChange(old); }
            this.owner = ws; this.dev = m.dev; ws.extended = true;
            this.beforeChange(ws); clearTimeout(this.leaveTimer);
        }
        if (m.action === 'resume') { this.notify(); return; }
        if (this.operation) { this.pending = request; return; }
        if (m.action === 'resize') {
            this.pending = request; clearTimeout(this.resizeTimer);
            this.resizeTimer = setTimeout(() => { const r = this.pending; this.pending = null; if (r && this.owner && this.state === 'on') this.run(r); }, this.debounceMs);
            return;
        }
        await this.run(request);
    }
    differs(r) {
        if (!this.area || this.position !== r.position || this.text !== r.text) return true;
        const a = this.area, b = r.area;
        if ((Math.abs(a.w - b.w) <= 2 && Math.abs(a.h - b.h) <= 64) || (Math.abs(a.h - b.h) <= 2 && Math.abs(a.w - b.w) <= 64)) return false;
        return Math.abs((b.w / b.h) / (a.w / a.h) - 1) > .08;
    }
    async run(r) {
        if (this.operation || (this.state === 'on' && !this.differs(r))) return;
        const generation = ++this.generation, creating = !this.child;
        this.state = creating ? 'starting' : 'resizing'; this.error = '';
        this.beforeChange(this.owner); this.notify();
        this.operation = (async () => {
            if (creating) this.startHelper();
            const alive = () => generation === this.generation && !!this.child;
            let spec = this.specFor(r.area, r.text);
            let q = await this.cmd(`${creating ? 'create' : 'resize'} ${spec.pxW} ${spec.pxH} ${spec.hidpi ? 1 : 0}${creating ? ' SoA Second Display' : ''}`);
            if (!alive()) return;
            if (!q?.ok && q?.id && spec.hidpi) {
                spec = { ...spec, hidpi: false, pxW: spec.w, pxH: spec.h };
                q = await this.cmd(`resize ${spec.pxW} ${spec.pxH} 0`);
            }
            if (!alive()) return;
            if (!q?.ok || !q.id) throw new Error(q?.error || 'No display created');
            const placed = await this.cmd(`extend ${r.position}`);
            if (!alive()) return;
            if (!placed?.ok) throw new Error(placed?.error || 'Display arrangement failed');
            const query = await this.query(q.id);
            if (!alive()) return;
            const s = geometry(query);
            if (!s) throw new Error('The second display is not independent');
            this.screen = s; this.version++; this.position = r.position; this.text = r.text; this.area = r.area;
            this.state = 'on'; this.remember(); this.log('extend:', `${s.width}x${s.height}`, `at ${s.x},${s.y}`, `display ${s.displayId}`);
        })().catch(async e => {
            if (generation !== this.generation) return;
            this.log('extend failed:', e.message); await this.remove();
            this.state = 'error'; this.screen = null; this.error = messages.unavailable;
        }).finally(() => {
            this.operation = null; this.notify();
            const next = this.pending; this.pending = null;
            if (next && this.owner && this.state === 'on') this.run(next);
        });
        await this.operation;
    }
    startHelper() {
        if (!this.build()) throw new Error('Virtual display helper unavailable');
        const c = spawn(this.binary, [], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = c; this.remember();
        let buffer = '';
        c.stdout.setEncoding('utf8');
        c.stdout.on('data', data => {
            buffer += data;
            for (let i; (i = buffer.indexOf('\n')) >= 0;) {
                const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
                if (this.child !== c || !this.command) continue;
                let j; try { j = JSON.parse(line); } catch (_) { j = null; }
                this.command.finish(j);
            }
        });
        c.stderr.on('data', d => this.log(String(d).trim().slice(0, 300)));
        c.stdin.on('error', () => {}); c.on('error', e => this.log('extend helper:', e.message));
        c.on('close', () => {
            if (this.child !== c) return;
            this.child = null; this.command?.finish(null);
            if (!this.operation && this.state !== 'stopping') this.fail('lost');
        });
    }
    cmd(line) {
        return new Promise(resolve => {
            if (!this.child || this.command) return resolve(null);
            const c = this.child;
            const timer = setTimeout(() => { c.kill('SIGTERM'); this.command?.finish(null); }, 25000);
            this.command = { finish: j => { clearTimeout(timer); this.command = null; resolve(j); } };
            c.stdin.write(line + '\n', err => { if (err) this.command?.finish(null); });
        });
    }
    query(id) {
        return new Promise(resolve => execFile(this.binary, ['--query', String(id)], { env: this.env, timeout: 4000 }, (err, out) => {
            try { resolve(err ? null : JSON.parse(out)); } catch (_) { resolve(null); }
        }));
    }
    async remove() {
        const c = this.child; this.child = null; this.command?.finish(null);
        if (c && c.exitCode === null && c.signalCode === null) {
            await new Promise(resolve => {
                const kill = setTimeout(() => c.kill('SIGKILL'), 2500);
                c.once('close', () => { clearTimeout(kill); resolve(); });
                c.stdin.end();
            });
        }
        try { fs.unlinkSync(this.marker); } catch (_) {}
    }
    async fail(reason) {
        if (this.state === 'stopping') return;
        this.generation++; this.pending = null; clearTimeout(this.resizeTimer);
        this.state = 'stopping'; this.beforeChange(this.owner); this.notify();
        if (this.operation && this.child) this.child.kill('SIGTERM');
        await this.operation; await this.remove();
        this.state = 'error'; this.screen = null; this.error = messages[reason] || messages.lost;
        this.notify();
    }
    left(ws) {
        if (this.owner !== ws) return;
        this.owner = null; this.pending = null; clearTimeout(this.resizeTimer);
        clearTimeout(this.leaveTimer);
        this.leaveTimer = setTimeout(async () => {
            if (this.owner) return;
            this.generation++; this.state = 'stopping'; this.notify();
            if (this.operation && this.child) this.child.kill('SIGTERM');
            await this.operation; await this.remove();
            this.state = 'off'; this.dev = ''; this.screen = null; this.error = ''; this.notify();
        }, this.graceMs);
        this.notify();
    }
    async check() {
        if (this.state !== 'on' || this.operation || this.checking) return;
        this.checking = true;
        const version = this.version;
        try {
            const q = await this.query(this.screen.displayId);
            if (this.state !== 'on' || this.operation || this.version !== version) return;
            // A transient query failure isn't evidence the display disappeared.
            if (!q) return;
            const s = geometry(q);
            if (!s) { await this.fail('lost'); return; }
            if (JSON.stringify(s) !== JSON.stringify(this.screen)) {
                this.beforeChange(this.owner); this.screen = s; this.version++; this.notify();
            }
        } finally { this.checking = false; }
    }
    recover(waitGone) {
        // Only terminate the exact helper named by our private marker, never
        // unmirror a display or reuse a stale numeric display ID.
        try {
            const st = JSON.parse(fs.readFileSync(this.marker, 'utf8'));
            if (st.pid > 1 && st.binary === this.binary) {
                const command = execFileSync('ps', ['-o', 'comm=', '-p', String(st.pid)], { timeout: 2000 }).toString().trim();
                if (command === this.binary) { process.kill(st.pid, 'SIGTERM'); if (!waitGone(st.pid, 5000)) throw new Error('Previous display helper still running'); }
            }
        } catch (e) { if (e.message === 'Previous display helper still running') throw e; }
        try { fs.unlinkSync(this.marker); } catch (_) {}
    }
    shutdown(waitGone) {
        clearInterval(this.watch); clearTimeout(this.resizeTimer); clearTimeout(this.leaveTimer);
        const c = this.child;
        if (c?.pid) { c.kill('SIGTERM'); if (!waitGone(c.pid, 5000)) { c.kill('SIGKILL'); waitGone(c.pid, 1000); } }
        try { fs.unlinkSync(this.marker); } catch (_) {}
    }
}

module.exports = { RemoteExtension, geometry, localPoint, globalPoint };
