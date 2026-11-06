// scripts/soa-code: the loopback file service behind the code panel. Each run
// spawns the script on a free port with its roots, HOME and state dir inside a
// temp directory, so nothing outside that directory is ever read or written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'soa-code');
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

function hasGit() {
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch (_) { return false; }
}

async function startService(env) {
    const port = await freePort();
    const child = spawn(process.execPath, [SCRIPT], {
        env: { ...process.env, ...env, SOA_CODE_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('soa-code did not start: ' + out)), 5000);
        child.stdout.on('data', d => { out += d; if (out.includes('soa-code on')) { clearTimeout(t); resolve(); } });
        child.stderr.on('data', d => { out += d; });
        child.on('exit', code => { clearTimeout(t); reject(new Error(`exited ${code}: ${out}`)); });
    });
    child.removeAllListeners('exit');
    child.logs = () => out;
    child.stdout.on('data', d => { out += d; });
    return { port, child };
}

function request(port, method, p, { body, headers = {}, host } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const req = http.request({
            host: '127.0.0.1', port, method, path: p,
            headers: {
                host: host || `127.0.0.1:${port}`,
                'x-soa-code': '1',
                ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
                ...headers,
            },
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null; try { json = JSON.parse(text); } catch (_) {}
                resolve({ status: res.statusCode, headers: res.headers, json });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function setup(extraEnv = {}) {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soa-code-')));
    const root = path.join(tmp, 'root');
    const home = path.join(root, 'home');
    const state = path.join(home, '.soa-web-local');
    const outside = path.join(tmp, 'outside');
    for (const d of [root, home, state, outside, path.join(home, '.ssh'), path.join(home, 'Library', 'Prefs'),
        path.join(root, 'proj', 'src'), path.join(root, 'proj', 'node_modules', 'dep'), path.join(root, 'proj', '.git')]) {
        fs.mkdirSync(d, { recursive: true });
    }
    fs.writeFileSync(path.join(home, '.ssh', 'id_test'), 'secret\n');
    fs.writeFileSync(path.join(state, 'tabs.json'), '{}\n');
    fs.writeFileSync(path.join(home, 'Library', 'Prefs', 'a.txt'), 'pref\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
    fs.writeFileSync(path.join(root, 'proj', 'README.md'), '# Demo\nhello world\n');
    fs.writeFileSync(path.join(root, 'proj', 'src', 'main.js'), 'const greeting = "Hello";\nconsole.log(greeting);\n');
    fs.writeFileSync(path.join(root, 'proj', 'src', 'util.js'), 'export const x = 1;\r\n');
    fs.writeFileSync(path.join(root, 'proj', '.env'), 'A=1\n');
    fs.writeFileSync(path.join(root, 'proj', 'node_modules', 'dep', 'index.js'), 'hello from dep\n');
    fs.writeFileSync(path.join(root, 'proj', '.git', 'config'), '[core]\n');
    fs.symlinkSync(outside, path.join(root, 'proj', 'escape'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'proj', 'escape.txt'));
    fs.symlinkSync(path.join(outside, 'nope.txt'), path.join(root, 'proj', 'dangling.txt'));
    const env = { SOA_CODE_ROOTS: root, HOME: home, SOA_WEB_STATE_DIR: state, SOA_CODE_RG: 'off', ...extraEnv };
    return { tmp, root, home, state, outside, proj: path.join(root, 'proj'), env };
}

let svc, fx;
test.before(async () => {
    fx = setup();
    svc = await startService(fx.env);
});
test.after(() => {
    if (svc) svc.child.kill('SIGTERM');
    if (fx) fs.rmSync(fx.tmp, { recursive: true, force: true });
});

const enc = encodeURIComponent;

test('health reports the version and the realpath roots', async () => {
    const r = await request(svc.port, 'GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.roots, [fx.root]);
    assert.ok(r.json.version);
    assert.equal(Object.keys(r.headers).some(h => h.startsWith('access-control-')), false);
});

test('a foreign Host header is refused (DNS rebinding)', async () => {
    const r = await request(svc.port, 'GET', '/api/health', { host: `evil.example:${svc.port}` });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'BAD_HOST');
    const ok = await request(svc.port, 'GET', '/api/health', { host: `localhost:${svc.port}` });
    assert.equal(ok.status, 200);
    const wrongPort = await request(svc.port, 'GET', '/api/health', { host: '127.0.0.1:1' });
    assert.equal(wrongPort.status, 403);
});

test('requests without x-soa-code are refused and never get CORS headers', async () => {
    const r = await request(svc.port, 'GET', '/api/health', { headers: { 'x-soa-code': '' } });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'NO_HEADER');
    const pre = await request(svc.port, 'OPTIONS', '/api/file', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' } });
    assert.notEqual(pre.status, 200);
    assert.equal(Object.keys(pre.headers).some(h => h.startsWith('access-control-')), false);
});

test('tree lists dirs first, omits .git, hides dotfiles unless asked, flags ignored dirs and links', async () => {
    const r = await request(svc.port, 'GET', `/api/tree?path=${enc(fx.proj)}`);
    assert.equal(r.status, 200);
    const names = r.json.entries.map(e => e.name);
    assert.equal(names.includes('.git'), false);
    assert.equal(names.includes('.env'), false);
    assert.deepEqual(names.slice(0, 3), ['escape', 'node_modules', 'src']);
    assert.equal(r.json.entries.find(e => e.name === 'node_modules').ignored, true);
    assert.equal(r.json.entries.find(e => e.name === 'src').ignored, false);
    const link = r.json.entries.find(e => e.name === 'escape.txt');
    assert.equal(link.type, 'link');
    const readme = r.json.entries.find(e => e.name === 'README.md');
    assert.equal(readme.type, 'file');
    assert.ok(readme.size > 0 && readme.mtimeMs > 0);
    const hidden = await request(svc.port, 'GET', `/api/tree?path=${enc(fx.proj)}&hidden=1`);
    const hn = hidden.json.entries.map(e => e.name);
    assert.ok(hn.includes('.env'));
    assert.equal(hn.includes('.git'), false);
});

test('tree refuses a file, a missing dir and a path outside the roots', async () => {
    assert.equal((await request(svc.port, 'GET', `/api/tree?path=${enc(path.join(fx.proj, 'README.md'))}`)).json.code, 'NOT_DIR');
    assert.equal((await request(svc.port, 'GET', `/api/tree?path=${enc(path.join(fx.proj, 'nope'))}`)).status, 404);
    const out = await request(svc.port, 'GET', `/api/tree?path=${enc(fx.outside)}`);
    assert.equal(out.status, 403);
    assert.equal(out.json.code, 'OUTSIDE_ROOT');
    const rel = await request(svc.port, 'GET', '/api/tree?path=proj');
    assert.equal(rel.status, 400);
});

test('file returns content, sha, eol and readonly', async () => {
    const p = path.join(fx.proj, 'src', 'main.js');
    const r = await request(svc.port, 'GET', `/api/file?path=${enc(p)}`);
    assert.equal(r.status, 200);
    const text = fs.readFileSync(p, 'utf8');
    assert.equal(r.json.content, text);
    assert.equal(r.json.sha, sha1(text));
    assert.equal(r.json.eol, 'lf');
    assert.equal(r.json.readonly, false);
    assert.equal(r.json.size, Buffer.byteLength(text));
    const crlf = await request(svc.port, 'GET', `/api/file?path=${enc(path.join(fx.proj, 'src', 'util.js'))}`);
    assert.equal(crlf.json.eol, 'crlf');
    const git = await request(svc.port, 'GET', `/api/file?path=${enc(path.join(fx.proj, '.git', 'config'))}`);
    assert.equal(git.json.readonly, true);
    const lib = await request(svc.port, 'GET', `/api/file?path=${enc(path.join(fx.home, 'Library', 'Prefs', 'a.txt'))}`);
    assert.equal(lib.json.readonly, true);
});

test('"../" traversal cannot leave the roots', async () => {
    const p = path.join(fx.proj, '..', '..', 'outside', 'secret.txt');
    const raw = `${fx.proj}/../../outside/secret.txt`;
    for (const q of [p, raw]) {
        const r = await request(svc.port, 'GET', `/api/file?path=${enc(q)}`);
        assert.equal(r.status, 403);
        assert.equal(r.json.code, 'OUTSIDE_ROOT');
    }
    const w = await request(svc.port, 'PUT', '/api/file', { body: { path: raw.replace('secret.txt', 'new.txt'), content: 'x', baseSha: null } });
    assert.equal(w.status, 403);
    assert.equal(fs.existsSync(path.join(fx.outside, 'new.txt')), false);
});

test('symlinks cannot escape the roots for reads or writes', async () => {
    const r = await request(svc.port, 'GET', `/api/file?path=${enc(path.join(fx.proj, 'escape.txt'))}`);
    assert.equal(r.status, 403);
    const d = await request(svc.port, 'GET', `/api/tree?path=${enc(path.join(fx.proj, 'escape'))}`);
    assert.equal(d.status, 403);
    const w1 = await request(svc.port, 'PUT', '/api/file', { body: { path: path.join(fx.proj, 'escape', 'planted.txt'), content: 'x', baseSha: null } });
    assert.equal(w1.status, 403);
    const w2 = await request(svc.port, 'PUT', '/api/file', { body: { path: path.join(fx.proj, 'escape.txt'), content: 'x', baseSha: sha1('outside\n') } });
    assert.equal(w2.status, 403);
    const w3 = await request(svc.port, 'PUT', '/api/file', { body: { path: path.join(fx.proj, 'dangling.txt'), content: 'x', baseSha: null } });
    assert.equal(w3.status, 403);
    assert.equal(fs.readFileSync(path.join(fx.outside, 'secret.txt'), 'utf8'), 'outside\n');
    assert.equal(fs.existsSync(path.join(fx.outside, 'planted.txt')), false);
    assert.equal(fs.existsSync(path.join(fx.outside, 'nope.txt')), false);
});

test('credentials and the state dir are never read', async () => {
    for (const p of [path.join(fx.home, '.ssh', 'id_test'), path.join(fx.state, 'tabs.json')]) {
        const r = await request(svc.port, 'GET', `/api/file?path=${enc(p)}`);
        assert.equal(r.status, 403);
        assert.equal(r.json.code, 'DENIED');
    }
    assert.equal((await request(svc.port, 'GET', `/api/tree?path=${enc(path.join(fx.home, '.ssh'))}`)).status, 403);
});

test('writes are refused in the denylist (.ssh, Library, state dir, .git)', async () => {
    for (const p of [
        path.join(fx.home, '.ssh', 'authorized_keys'),
        path.join(fx.home, 'Library', 'Prefs', 'b.txt'),
        path.join(fx.state, 'evil.json'),
        path.join(fx.proj, '.git', 'hooks-pre-commit'),
    ]) {
        const r = await request(svc.port, 'PUT', '/api/file', { body: { path: p, content: 'x', baseSha: null, create: true } });
        assert.equal(r.status, 403, p);
        assert.equal(fs.existsSync(p), false, p);
    }
    const cfg = path.join(fx.proj, '.git', 'config');
    const r = await request(svc.port, 'PUT', '/api/file', { body: { path: cfg, content: 'x', baseSha: sha1('[core]\n') } });
    assert.equal(r.status, 403);
    assert.equal(fs.readFileSync(cfg, 'utf8'), '[core]\n');
});

test('binary and large files are refused', async () => {
    const bin = path.join(fx.proj, 'img.bin');
    fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const b = await request(svc.port, 'GET', `/api/file?path=${enc(bin)}`);
    assert.equal(b.json.ok, false);
    assert.equal(b.json.code, 'BINARY');
    assert.equal(b.json.size, 5);
    const bad = path.join(fx.proj, 'latin1.txt');
    fs.writeFileSync(bad, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    assert.equal((await request(svc.port, 'GET', `/api/file?path=${enc(bad)}`)).json.code, 'BINARY');
    const big = path.join(fx.proj, 'big.txt');
    fs.writeFileSync(big, 'a'.repeat(2 * 1024 * 1024 + 1));
    const l = await request(svc.port, 'GET', `/api/file?path=${enc(big)}`);
    assert.equal(l.json.ok, false);
    assert.equal(l.json.code, 'TOO_LARGE');
    assert.equal(l.json.size, 2 * 1024 * 1024 + 1);
    const st = await request(svc.port, 'GET', `/api/stat?path=${enc(big)}`);
    assert.equal(st.json.exists, true);
    assert.equal(st.json.sha, undefined);
    for (const p of [bin, bad, big]) fs.unlinkSync(p);
});

test('save writes atomically, keeps the file mode and logs one line', async () => {
    const p = path.join(fx.proj, 'run.sh');
    fs.writeFileSync(p, '#!/bin/sh\necho one\n');
    fs.chmodSync(p, 0o751);
    const before = await request(svc.port, 'GET', `/api/file?path=${enc(p)}`);
    const content = '#!/bin/sh\necho two\n';
    const r = await request(svc.port, 'PUT', '/api/file', { body: { path: p, content, baseSha: before.json.sha } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.sha, sha1(content));
    assert.equal(r.json.size, Buffer.byteLength(content));
    assert.equal(fs.readFileSync(p, 'utf8'), content);
    assert.equal(fs.statSync(p).mode & 0o777, 0o751);
    assert.equal(fs.readdirSync(fx.proj).some(n => n.includes('.soa-code-')), false);
    await new Promise(r2 => setTimeout(r2, 50));
    assert.match(svc.child.logs(), new RegExp(`write ${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${Buffer.byteLength(content)} bytes`));
    // The new sha is the base for the next save.
    const again = await request(svc.port, 'PUT', '/api/file', { body: { path: p, content: content + 'echo three\n', baseSha: r.json.sha } });
    assert.equal(again.status, 200);
});

test('POST is the same write, with a text/plain JSON body (what the panel sends through the proxy)', async () => {
    const p = path.join(fx.proj, 'posted.txt');
    const r = await request(svc.port, 'POST', '/api/file', {
        body: { path: p, content: 'via post\n', baseSha: null },
        headers: { 'content-type': 'text/plain;charset=utf-8' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.sha, sha1('via post\n'));
    assert.equal(fs.readFileSync(p, 'utf8'), 'via post\n');
    const stale = await request(svc.port, 'POST', '/api/file', { body: { path: p, content: 'x', baseSha: sha1('nope') } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'CONFLICT');
});

test('a stale baseSha is a conflict and leaves the disk untouched', async () => {
    const p = path.join(fx.proj, 'notes.txt');
    fs.writeFileSync(p, 'v1\n');
    const opened = await request(svc.port, 'GET', `/api/file?path=${enc(p)}`);
    fs.writeFileSync(p, 'v2 from elsewhere\n');
    const r = await request(svc.port, 'PUT', '/api/file', { body: { path: p, content: 'mine\n', baseSha: opened.json.sha } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'CONFLICT');
    assert.equal(r.json.sha, sha1('v2 from elsewhere\n'));
    assert.ok(r.json.mtimeMs > 0);
    assert.equal(fs.readFileSync(p, 'utf8'), 'v2 from elsewhere\n');
    // Overwrite = resend against the sha the conflict reported.
    const o = await request(svc.port, 'PUT', '/api/file', { body: { path: p, content: 'mine\n', baseSha: r.json.sha } });
    assert.equal(o.status, 200);
    assert.equal(fs.readFileSync(p, 'utf8'), 'mine\n');
    // Deleted on disk since it was opened: a conflict too, not a silent resurrect.
    fs.unlinkSync(p);
    const gone = await request(svc.port, 'PUT', '/api/file', { body: { path: p, content: 'mine\n', baseSha: o.json.sha } });
    assert.equal(gone.status, 409);
    assert.equal(gone.json.code, 'CONFLICT');
    assert.equal(fs.existsSync(p), false);
});

test('create makes a new file and refuses an existing one', async () => {
    const p = path.join(fx.proj, 'src', 'new.ts');
    const r = await request(svc.port, 'PUT', '/api/file', { body: { path: p, content: 'export {};\n', baseSha: null, create: true } });
    assert.equal(r.status, 200);
    assert.equal(fs.readFileSync(p, 'utf8'), 'export {};\n');
    const again = await request(svc.port, 'PUT', '/api/file', { body: { path: p, content: 'x', baseSha: null, create: true } });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'EXISTS');
    const noParent = await request(svc.port, 'PUT', '/api/file', { body: { path: path.join(fx.proj, 'missing', 'a.txt'), content: 'x', baseSha: null, create: true } });
    assert.equal(noParent.status, 404);
});

test('malformed and oversized bodies are refused', async () => {
    const bad = await request(svc.port, 'PUT', '/api/file', { body: '{nope' });
    assert.equal(bad.status, 400);
    const noContent = await request(svc.port, 'PUT', '/api/file', { body: { path: path.join(fx.proj, 'x.txt') } });
    assert.equal(noContent.status, 400);
    const huge = await request(svc.port, 'PUT', '/api/file', { body: { path: path.join(fx.proj, 'huge.txt'), content: 'a'.repeat(4 * 1024 * 1024 + 10), baseSha: null } })
        .catch(e => ({ status: 413, error: e }));
    assert.equal(huge.status, 413);
    assert.equal(fs.existsSync(path.join(fx.proj, 'huge.txt')), false);
    const wrongMethod = await request(svc.port, 'DELETE', '/api/file', { body: {} });
    assert.equal(wrongMethod.status, 405);
});

test('stat reports existence, mtime and sha for polling', async () => {
    const p = path.join(fx.proj, 'README.md');
    const r = await request(svc.port, 'GET', `/api/stat?path=${enc(p)}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.exists, true);
    assert.equal(r.json.type, 'file');
    assert.equal(r.json.sha, sha1(fs.readFileSync(p)));
    const dir = await request(svc.port, 'GET', `/api/stat?path=${enc(fx.proj)}`);
    assert.equal(dir.json.type, 'dir');
    const gone = await request(svc.port, 'GET', `/api/stat?path=${enc(path.join(fx.proj, 'nope', 'x'))}`);
    assert.deepEqual(gone.json, { ok: true, exists: false });
    assert.equal((await request(svc.port, 'GET', `/api/stat?path=${enc(path.join(fx.outside, 'secret.txt'))}`)).status, 403);
});

test('find matches file names fuzzily and skips ignored dirs and .git', async () => {
    const r = await request(svc.port, 'GET', `/api/find?root=${enc(fx.proj)}&q=mainjs`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.files[0], 'src/main.js');
    const all = await request(svc.port, 'GET', `/api/find?root=${enc(fx.proj)}&q=&limit=500`);
    assert.ok(all.json.files.includes('README.md'));
    assert.equal(all.json.files.some(f => f.startsWith('node_modules/') || f.startsWith('.git/')), false);
    const util = await request(svc.port, 'GET', `/api/find?root=${enc(fx.proj)}&q=util`);
    assert.equal(util.json.files[0], 'src/util.js');
    const none = await request(svc.port, 'GET', `/api/find?root=${enc(fx.proj)}&q=zzzqqq`);
    assert.deepEqual(none.json.files, []);
    assert.equal((await request(svc.port, 'GET', `/api/find?root=${enc(fx.outside)}&q=a`)).status, 403);
});

test('grep finds literal text case-insensitively with line and column', async () => {
    const r = await request(svc.port, 'GET', `/api/grep?root=${enc(fx.proj)}&q=HELLO`);
    assert.equal(r.json.ok, true);
    const files = r.json.matches.map(m => m.file);
    assert.ok(files.includes('README.md'));
    assert.ok(files.includes('src/main.js'));
    assert.equal(files.some(f => f.startsWith('node_modules/')), false);
    const m = r.json.matches.find(x => x.file === 'src/main.js');
    assert.equal(m.line, 1);
    assert.equal(m.col, 19);
    assert.equal(m.text, 'const greeting = "Hello";');
    const lim = await request(svc.port, 'GET', `/api/grep?root=${enc(fx.proj)}&q=e&limit=2`);
    assert.equal(lim.json.matches.length, 2);
    assert.equal(lim.json.truncated, true);
    assert.equal((await request(svc.port, 'GET', `/api/grep?root=${enc(fx.proj)}&q=`)).status, 400);
});

test('git reports branch and status letters relative to the root', { skip: !hasGit() && 'git not installed' }, async () => {
    const repo = path.join(fx.root, 'repo');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, HOME: fx.home, GIT_CONFIG_NOSYSTEM: '1' } });
    g('init', '-q', '-b', 'trunk');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'gone.txt'), 'g\n');
    fs.writeFileSync(path.join(repo, 'sub', 'b.txt'), 'b\n');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    fs.unlinkSync(path.join(repo, 'gone.txt'));
    fs.writeFileSync(path.join(repo, 'staged.txt'), 's\n');
    g('add', 'staged.txt');
    fs.writeFileSync(path.join(repo, 'sub', 'new.txt'), 'n\n');
    const r = await request(svc.port, 'GET', `/api/git?root=${enc(repo)}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.repo, true);
    assert.equal(r.json.branch, 'trunk');
    assert.equal(r.json.files['a.txt'], 'M');
    assert.equal(r.json.files['gone.txt'], 'D');
    assert.equal(r.json.files['staged.txt'], 'A');
    assert.equal(r.json.files['sub/new.txt'], '?');
    const sub = await request(svc.port, 'GET', `/api/git?root=${enc(path.join(repo, 'sub'))}`);
    assert.deepEqual(sub.json.files, { 'new.txt': '?' });
    const plain = await request(svc.port, 'GET', `/api/git?root=${enc(path.join(fx.home, "Library"))}`);
    assert.equal(plain.json.repo, false);
});

test('unknown routes 404 and non-api paths are not served', async () => {
    assert.equal((await request(svc.port, 'GET', '/api/nope')).status, 404);
    assert.equal((await request(svc.port, 'GET', '/')).status, 404);
});

// ── adversarial review: each test below pinned a real hole before its fix ──

function findRgBinary() {
    if (process.env.SOA_CODE_TEST_RG) return process.env.SOA_CODE_TEST_RG;
    for (const dir of (process.env.PATH || '').split(':')) {
        const p = path.join(dir || '.', 'rg');
        try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch (_) {}
    }
    return null;
}

test('grep (node walk) never follows a file symlink out of the roots', async () => {
    const r = await request(svc.port, 'GET', `/api/grep?root=${enc(fx.proj)}&q=outside`);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.matches.filter(m => m.file === 'escape.txt'), []);
    const home = await request(svc.port, 'GET', `/api/grep?root=${enc(fx.home)}&q=secret`);
    assert.deepEqual(home.json.matches, []);
});

test('grep (rg) honours the read denylist and never follows links out', { skip: !findRgBinary() && 'rg not installed' }, async () => {
    const own = await startService({ ...fx.env, SOA_CODE_RG: findRgBinary() });
    try {
        const home = await request(own.port, 'GET', `/api/grep?root=${enc(fx.home)}&q=secret`);
        assert.equal(home.json.engine, 'rg');
        assert.deepEqual(home.json.matches, []);
        const state = await request(own.port, 'GET', `/api/grep?root=${enc(fx.root)}&q=${enc('{}')}`);
        assert.equal(state.json.matches.some(m => m.file.includes('.soa-web-local/')), false);
        const link = await request(own.port, 'GET', `/api/grep?root=${enc(fx.proj)}&q=outside`);
        assert.deepEqual(link.json.matches.filter(m => m.file === 'escape.txt'), []);
        // A query that looks like a flag is still a literal.
        const flag = await request(own.port, 'GET', `/api/grep?root=${enc(fx.proj)}&q=${enc('--files')}`);
        assert.equal(flag.json.ok, true);
        assert.deepEqual(flag.json.matches, []);
    } finally { own.child.kill('SIGTERM'); }
});

test('missing paths outside the roots read as refused, not as "not found"', async () => {
    for (const p of [path.join(fx.outside, 'nope.txt'), path.join(fx.outside, 'nodir', 'x.txt')]) {
        const f = await request(svc.port, 'GET', `/api/file?path=${enc(p)}`);
        assert.equal(f.status, 403, p);
        assert.equal(f.json.code, 'OUTSIDE_ROOT');
        const s = await request(svc.port, 'GET', `/api/stat?path=${enc(p)}`);
        assert.equal(s.status, 403, p);
    }
    const ssh = await request(svc.port, 'GET', `/api/file?path=${enc(path.join(fx.home, '.ssh', 'id_missing'))}`);
    assert.equal(ssh.json.code, 'DENIED');
    const inside = await request(svc.port, 'GET', `/api/file?path=${enc(path.join(fx.proj, 'nope.txt'))}`);
    assert.equal(inside.status, 404);
    assert.deepEqual((await request(svc.port, 'GET', `/api/stat?path=${enc(path.join(fx.proj, 'nope', 'x'))}`)).json, { ok: true, exists: false });
});

test('a save never replaces a file its owner made read-only', { skip: process.getuid && process.getuid() === 0 && 'root ignores modes' }, async () => {
    const p = path.join(fx.proj, 'locked.txt');
    fs.writeFileSync(p, 'locked\n');
    fs.chmodSync(p, 0o444);
    const r = await request(svc.port, 'PUT', '/api/file', { body: { path: p, content: 'pwned\n', baseSha: sha1('locked\n') } });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'READ_ONLY');
    assert.equal(fs.readFileSync(p, 'utf8'), 'locked\n');
    fs.chmodSync(p, 0o644);
    fs.unlinkSync(p);
});

test('a foreign Origin is refused (DNS rebinding through the daemon proxy)', async () => {
    fs.writeFileSync(path.join(fx.state, 'tunnel.json'), JSON.stringify({ provider: 'ngrok', url: 'https://abc123.ngrok-free.app' }));
    const p = path.join(fx.proj, 'origin.txt');
    for (const origin of ['http://evil.example:4010', 'https://abc123.ngrok-free.app.evil.example', 'null']) {
        const w = await request(svc.port, 'POST', '/api/file', { body: { path: p, content: 'x', baseSha: null }, headers: { origin } });
        assert.equal(w.status, 403, origin);
        assert.equal(w.json.code, 'BAD_ORIGIN');
        const g = await request(svc.port, 'GET', `/api/file?path=${enc(path.join(fx.proj, 'README.md'))}`, { headers: { origin } });
        assert.equal(g.status, 403, origin);
    }
    assert.equal(fs.existsSync(p), false);
    for (const origin of ['https://www.s0a.app', 'http://127.0.0.1:4010', 'http://localhost:4010', 'http://192.168.1.20:4010',
        'http://[::1]:4010', `http://${os.hostname()}:4010`, 'capacitor://localhost', 'https://abc123.ngrok-free.app']) {
        const g = await request(svc.port, 'GET', '/api/health', { headers: { origin } });
        assert.equal(g.status, 200, origin);
    }
    const w = await request(svc.port, 'POST', '/api/file', { body: { path: p, content: 'ok\n', baseSha: null }, headers: { origin: 'https://abc123.ngrok-free.app' } });
    assert.equal(w.status, 200);
    fs.unlinkSync(p);
});

test('git status never runs a repo-configured fsmonitor command', { skip: !hasGit() && 'git not installed' }, async () => {
    const repo = path.join(fx.root, 'fsmon');
    fs.mkdirSync(repo, { recursive: true });
    const marker = path.join(fx.tmp, 'fsmonitor-ran');
    const hook = path.join(fx.tmp, 'fsmon.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    fs.chmodSync(hook, 0o755);
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, HOME: fx.home, GIT_CONFIG_NOSYSTEM: '1' } });
    g('init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    g('config', 'core.fsmonitor', hook);
    const r = await request(svc.port, 'GET', `/api/git?root=${enc(repo)}`);
    assert.equal(r.json.repo, true);
    assert.equal(r.json.files['a.txt'], '?');
    assert.equal(fs.existsSync(marker), false);
});

test('git status never runs a repo-configured clean or process filter', { skip: !hasGit() && 'git not installed' }, async () => {
    const repo = path.join(fx.root, 'filtered');
    fs.mkdirSync(repo, { recursive: true });
    const marker = path.join(fx.tmp, 'filter-ran');
    const hook = path.join(fx.tmp, 'filter.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    fs.chmodSync(hook, 0o755);
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, HOME: fx.home, GIT_CONFIG_NOSYSTEM: '1' } });
    g('init', '-q');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=evil\n*.md filter=other.dotted\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'b.md'), 'b\n');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
    // Configured after the commit, so only a status can be what runs it.
    g('config', 'filter.evil.clean', hook);
    g('config', 'filter.evil.required', 'true');
    g('config', 'filter.other.dotted.process', hook);
    // Same size, new mtime: status must hash the content, which is where a
    // clean/process filter would run.
    const past = new Date(Date.now() - 3600e3);
    fs.utimesSync(path.join(repo, 'a.txt'), past, past);
    fs.utimesSync(path.join(repo, 'b.md'), past, past);
    const r = await request(svc.port, 'GET', `/api/git?root=${enc(repo)}`);
    assert.equal(r.json.repo, true);
    assert.equal(fs.existsSync(marker), false);
    fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n');
    const r2 = await request(svc.port, 'GET', `/api/git?root=${enc(repo)}`);
    assert.equal(r2.json.files['new.txt'], '?');
    assert.equal(fs.existsSync(marker), false);
});

test('git status never descends into a submodule (its own config could name a filter)', { skip: !hasGit() && 'git not installed' }, async () => {
    const env = { ...process.env, HOME: fx.home, GIT_CONFIG_NOSYSTEM: '1' };
    const src = path.join(fx.tmp, 'subsrc');
    const repo = path.join(fx.root, 'super');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    const marker = path.join(fx.tmp, 'sub-filter-ran');
    const hook = path.join(fx.tmp, 'sub-filter.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    fs.chmodSync(hook, 0o755);
    const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.email=test@example.com', '-c', 'user.name=test', ...a], { stdio: 'ignore', env });
    g(src, 'init', '-q');
    fs.writeFileSync(path.join(src, '.gitattributes'), '*.txt filter=evil\n');
    fs.writeFileSync(path.join(src, 'x.txt'), 'x\n');
    g(src, 'add', '.');
    g(src, 'commit', '-q', '-m', 'init');
    g(repo, 'init', '-q');
    g(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, 'sm');
    g(repo, 'commit', '-q', '-m', 'sub');
    g(path.join(repo, 'sm'), 'config', 'filter.evil.clean', hook);
    const past = new Date(Date.now() - 3600e3);
    fs.utimesSync(path.join(repo, 'sm', 'x.txt'), past, past);
    const r = await request(svc.port, 'GET', `/api/git?root=${enc(repo)}`);
    assert.equal(r.json.repo, true);
    assert.equal(fs.existsSync(marker), false);
});

test('a request that never finishes its body is cut off', async () => {
    const own = await startService({ ...fx.env, SOA_CODE_REQUEST_TIMEOUT_MS: '400' });
    try {
        const closed = await new Promise((resolve, reject) => {
            const t0 = Date.now();
            const sock = net.connect(own.port, '127.0.0.1', () => {
                sock.write(`PUT /api/file HTTP/1.1\r\nhost: 127.0.0.1:${own.port}\r\nx-soa-code: 1\r\ncontent-length: 1000\r\n\r\n{"path":`);
            });
            let out = '';
            sock.on('data', d => { out += d; });
            sock.on('close', () => resolve({ ms: Date.now() - t0, out }));
            sock.on('error', () => {});
            setTimeout(() => { sock.destroy(); reject(new Error('still open after 5 s')); }, 5000);
        });
        assert.ok(closed.ms < 5000);
    } finally { own.child.kill('SIGTERM'); }
});
