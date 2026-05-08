/**
 * System info feeds for sidebar widgets.
 *
 * All handlers return JSON; the browser widgets poll the ones they care about.
 * Nothing here is auth-sensitive by itself, but we still gate every endpoint
 * behind the same session check the rest of the API uses so an unauthenticated
 * visitor can't harvest hostnames or network layout.
 */

const os = require('os');
const { execFile } = require('child_process');
const path = require('path');

function sys() {
    return {
        hostname: os.hostname(),
        platform: os.platform(),
        arch:     os.arch(),
        release:  os.release(),
        uptime:   Math.floor(os.uptime()),
        loadavg:  os.loadavg(),
        userInfo: (() => { try { return os.userInfo().username; } catch (_) { return 'unknown'; } })(),
        homedir:  os.homedir(),
    };
}

function cpuInfo() {
    const cpus = os.cpus() || [];
    return {
        model:  cpus[0] && cpus[0].model || 'unknown',
        speed:  cpus[0] && cpus[0].speed || 0,
        cores:  cpus.length,
        loadavg: os.loadavg(),
    };
}

function ramInfo() {
    const total = os.totalmem();
    const free  = os.freemem();
    const used  = total - free;
    return {
        total, free, used,
        usedPct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    };
}

function netInfo() {
    const out = [];
    const ifaces = os.networkInterfaces() || {};
    for (const [name, addrs] of Object.entries(ifaces)) {
        for (const a of (addrs || [])) {
            if (a.internal) continue;
            out.push({
                name,
                family:    a.family,
                address:   a.address,
                netmask:   a.netmask,
                mac:       a.mac,
            });
        }
    }
    return out;
}

function gitCommits(cwd, limit = 8) {
    return new Promise(resolve => {
        const safeCwd = cwd && path.isAbsolute(cwd) ? cwd : process.cwd();
        execFile('git', ['-C', safeCwd, 'log', '-n', String(Math.max(1, Math.min(50, limit | 0))), '--format=%h%x09%an%x09%ar%x09%s'], { timeout: 4000 }, (err, stdout) => {
            if (err || !stdout) return resolve({ ok: false, error: err && err.message || 'no git history', commits: [] });
            const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
                const [hash, author, ago, subject] = line.split('\t');
                return { hash, author, ago, subject };
            });
            resolve({ ok: true, cwd: safeCwd, commits });
        });
    });
}

function mount(app, requireAuthed) {
    app.get('/api/sys', requireAuthed, (req, res) => res.json({ ok: true, data: sys() }));
    app.get('/api/cpu', requireAuthed, (req, res) => res.json({ ok: true, data: cpuInfo() }));
    app.get('/api/ram', requireAuthed, (req, res) => res.json({ ok: true, data: ramInfo() }));
    app.get('/api/net', requireAuthed, (req, res) => res.json({ ok: true, data: netInfo() }));
    app.get('/api/git', requireAuthed, async (req, res) => {
        const cwd = req.query && req.query.cwd ? String(req.query.cwd) : process.cwd();
        const data = await gitCommits(cwd, req.query && req.query.limit);
        res.json({ ok: true, data });
    });
}

module.exports = { mount, sys, cpuInfo, ramInfo, netInfo, gitCommits };
