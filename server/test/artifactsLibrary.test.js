'use strict';
// scripts/soa-artifacts (the artifact library) and the canvas's artifact URL
// regex. Everything runs against temp files and a server on an ephemeral port
// with HOME and the state dir pointed at a temp tree; nothing real is read.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'soa-artifacts');
const A = require(SCRIPT);
const { artifactsFrom, ARTIFACT_RE } = require('../src/contextCanvas');

const U1 = 'https://claude.ai/code/artifact/11111111-1111-4111-8111-111111111111';
const U2 = 'https://claude.ai/artifact/AbCdEfGhJkLmNpQrStUvWx';
const PLACEHOLDERS = [
    'https://claude.ai/artifact/{id}',
    'https://claude.ai/code/artifact/<uuid>',
    'https://claude.ai/code/artifact/12345678-aaaa-bbbb-cccc-123456789012',
    'https://claude.ai/artifact/AbCdEfGh',                       // cut short
    'https://claude.ai.example.com/artifact/AbCdEfGhJkLmNpQrStUvWx',
    'http://claude.ai/artifact/AbCdEfGhJkLmNpQrStUvWx',
    'https://evil.claude.ai/artifact/AbCdEfGhJkLmNpQrStUvWx',
    'https://claude.ai/artifact/AbCdEfGhJkLmNpQrStUvWxyz',       // too long
];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'soa-artifacts-test-'));
const L = (o) => JSON.stringify(o) + '\n';
const at = (m) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
const use = (id, input, m, name = 'Artifact') => L({ type: 'assistant', cwd: '/w/a', timestamp: at(m), message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, text, m, extra = {}) => L(Object.assign({ type: 'user', cwd: '/w/a', timestamp: at(m), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }, extra));

async function index(files) {
    const idx = A.emptyIndex();
    for (const [file, sessionId] of files) await A.scanFile(idx, { file, sessionId, agent: 'claude' }, fs.statSync(file));
    return idx;
}
const pub = (idx) => Object.fromEntries(A.publicOf(idx, []).map((a) => [a.id, a]));

// ── URL shapes ──
test('urlsIn: the three real forms, ids lower-cased when UUIDs', () => {
    const got = A.urlsIn(`${U1.toUpperCase().replace('HTTPS://CLAUDE.AI/CODE/ARTIFACT', 'https://claude.ai/code/artifact')} ${U2}. https://claude.ai/public/artifacts/22222222-2222-4222-9222-222222222222`);
    assert.deepStrictEqual(got.map((u) => u.id), ['11111111-1111-4111-8111-111111111111', 'AbCdEfGhJkLmNpQrStUvWx', '22222222-2222-4222-9222-222222222222']);
});
test('urlsIn: placeholders, lookalike hosts and truncated ids are rejected', () => {
    for (const p of PLACEHOLDERS) assert.deepStrictEqual(A.urlsIn(p), [], p);
});
test('contextCanvas ARTIFACT_RE: same shapes as the library', () => {
    const hits = (s) => { ARTIFACT_RE.lastIndex = 0; const out = []; let m; while ((m = ARTIFACT_RE.exec(s))) out.push(m[1] || m[2]); return out; };
    assert.deepStrictEqual(hits(`${U1} ${U2}`), ['11111111-1111-4111-8111-111111111111', 'AbCdEfGhJkLmNpQrStUvWx']);
    for (const p of PLACEHOLDERS) assert.deepStrictEqual(hits(p), [], p);
});
test('contextCanvas artifactsFrom: short-form URLs from a transcript', () => {
    const d = tmp();
    const f = path.join(d, 't.jsonl');
    fs.writeFileSync(f, use('x', { file_path: '/w/a/p.html', title: 'Short' }, 1).replace('"input"', `"note":"${U2}","input"`) + L({ type: 'user', message: { content: 'placeholder https://claude.ai/artifact/{id}' } }));
    const got = artifactsFrom(f);
    assert.deepStrictEqual(got.map((a) => [a.id, a.title]), [['AbCdEfGhJkLmNpQrStUvWx', 'Short']]);
});

// ── extraction ──
test('a first publish (no URL in the call) keeps its title and description', async () => {
    const d = tmp();
    const f = path.join(d, 's.jsonl');
    fs.writeFileSync(f, use('t1', { file_path: '/w/a/p.html', title: 'Input Title', description: 'What it is' }, 1)
        + res('t1', `Published /w/a/p.html at ${U1} (Version 1)`, 2, { toolUseResult: { url: U1, path: '/w/a/p.html', title: 'Result Title' } }));
    const a = pub(await index([[f, 's']]))['11111111-1111-4111-8111-111111111111'];
    assert.strictEqual(a.kind, 'published');
    assert.strictEqual(a.title, 'Input Title');
    assert.strictEqual(a.description, 'What it is');
    assert.strictEqual(a.project, 'a');
    assert.ok(!('filePath' in a), 'file paths never leave the service');
});
test('title precedence: frame-link over the call input over a registration', async () => {
    const d = tmp();
    const f = path.join(d, 's.jsonl');
    fs.writeFileSync(f, use('t1', { file_path: '/w/a/p.html', title: 'Input' }, 1) + res('t1', `Published /w/a/p.html at ${U1}`, 2)
        + L({ type: 'frame-link', path: '/w/a/p.html', frameUrl: U1, title: 'Frame', timestamp: at(3) }));
    const idx = await index([[f, 's']]);
    A.applyEvent(idx, { id: '11111111-1111-4111-8111-111111111111', url: U1, action: 'register', kind: 'registered', title: 'Registered', sessionId: 's', at: Date.parse(at(9)) });
    assert.strictEqual(pub(idx)['11111111-1111-4111-8111-111111111111'].title, 'Frame');
});
test('delete: a successful one marks it deleted, a declined one does not, a republish revives it', async () => {
    const d = tmp();
    const f = path.join(d, 's.jsonl');
    const U3 = 'https://claude.ai/code/artifact/33333333-3333-4333-8333-333333333333';
    fs.writeFileSync(f,
        use('p1', { file_path: '/w/a/1.html' }, 1) + res('p1', `Published /w/a/1.html at ${U1}`, 2)
        + use('d1', { action: 'delete', url: U1 }, 3) + res('d1', 'Deleted the artifact.', 4)
        + use('p3', { file_path: '/w/a/3.html' }, 1) + res('p3', `Published /w/a/3.html at ${U3}`, 2)
        + use('d3', { action: 'delete', url: U3 }, 3) + res('d3', 'The user declined the deletion.', 4)
        + use('d4', { action: 'delete', url: U3 }, 5) + L({ type: 'user', timestamp: at(6), message: { content: [{ type: 'tool_result', tool_use_id: 'd4', is_error: true, content: 'nope' }] } })
        + use('x1', { action: 'delete', url: U3, collection: 'c', doc_id: 'd' }, 7, 'ArtifactData') + res('x1', 'Database delete committed', 8));
    let p = pub(await index([[f, 's']]));
    assert.strictEqual(p['11111111-1111-4111-8111-111111111111'].deleted, true);
    assert.strictEqual(p['33333333-3333-4333-8333-333333333333'].deleted, false);
    assert.strictEqual(p['33333333-3333-4333-8333-333333333333'].kind, 'published');
    fs.appendFileSync(f, use('p2', { url: U1, file_path: '/w/a/1.html' }, 10) + res('p2', `Published /w/a/1.html at ${U1}`, 11));
    p = pub(await index([[f, 's']]));
    assert.strictEqual(p['11111111-1111-4111-8111-111111111111'].deleted, false);
});
test('ArtifactData / ArtifactComments calls count as opened', async () => {
    const d = tmp();
    const f = path.join(d, 's.jsonl');
    fs.writeFileSync(f, use('r1', { action: 'read_db', url: U2, collection: 'c' }, 1, 'ArtifactData'));
    assert.strictEqual(pub(await index([[f, 's']]))['AbCdEfGhJkLmNpQrStUvWx'].kind, 'opened');
});
test('a mention in another session does not move the artifact', async () => {
    const d = tmp();
    const fa = path.join(d, 'a.jsonl'), fb = path.join(d, 'b.jsonl');
    fs.writeFileSync(fa, use('p1', { file_path: '/w/a/1.html' }, 1) + res('p1', `Published /w/a/1.html at ${U1}`, 2));
    fs.writeFileSync(fb, L({ type: 'user', cwd: '/w/b', timestamp: at(50), message: { content: 'see ' + U1 } }));
    const a = pub(await index([[fa, 'A'], [fb, 'B']]))['11111111-1111-4111-8111-111111111111'];
    assert.strictEqual(a.project, 'a');
    assert.strictEqual(a.lastAt, Date.parse(at(2)));
    assert.deepStrictEqual(A.query([a], { cwd: '/w/b' }).total, 0);
    assert.deepStrictEqual(A.query([a], { cwd: '/w' }).total, 1);
});
test('an invalid JSON line still yields its mentions', async () => {
    const d = tmp();
    const f = path.join(d, 's.jsonl');
    fs.writeFileSync(f, `{"type":"user","broken ${U2}\n`);
    let p = pub(await index([[f, 's']]));
    assert.strictEqual(p['AbCdEfGhJkLmNpQrStUvWx'].kind, 'mentioned');
});

test('Codex rollouts retain thread identity and project across incremental reads', async () => {
    const d = tmp(), f = path.join(d, 'rollout.jsonl');
    const id = 'caf04f7d-83d2-42b1-91e8-4ab8ad5762c9';
    const url = `https://claude.ai/code/artifact/${id}`;
    fs.writeFileSync(f, L({ type: 'session_meta', payload: { id: 'codex-thread', cwd: '/w/codex' } })
        + L({ type: 'response_item', timestamp: at(1), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: url }] } }));
    const idx = A.emptyIndex(), item = { file: f, sessionId: 'filename-fallback', agent: 'codex' };
    await A.scanFile(idx, item, fs.statSync(f));
    const first = pub(idx)[id];
    assert.strictEqual(first.cwd, '/w/codex');
    assert.strictEqual(first.sessions[0].sessionId, 'codex-thread');
    assert.strictEqual(first.sessions[0].agent, 'codex');
    fs.appendFileSync(f, L({ type: 'response_item', timestamp: at(2), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: url }] } }));
    await A.scanFile(idx, item, fs.statSync(f));
    assert.strictEqual(pub(idx)[id].sessions.length, 1);
    assert.strictEqual(pub(idx)[id].lastAt, Date.parse(at(2)));
    assert.strictEqual(A.query(Object.values(pub(idx)), { session: 'codex-thread' }).total, 1);
});

// ── incremental reads ──
test('readFrom: only complete lines are consumed; the next read starts at the boundary', async () => {
    const d = tmp();
    const f = path.join(d, 's.jsonl');
    fs.writeFileSync(f, 'one\ntw');
    const st = { offset: 0 };
    let lines = [];
    await A.readFrom(f, st, (b) => lines.push(b.toString()));
    assert.deepStrictEqual(lines, ['one']);
    assert.strictEqual(st.offset, 4);
    fs.appendFileSync(f, 'o\nthree\n');
    lines = [];
    await A.readFrom(f, st, (b) => lines.push(b.toString()));
    assert.deepStrictEqual(lines, ['two', 'three']);
    assert.strictEqual(st.offset, fs.statSync(f).size);
});
test('scanFile: a file that shrinks or is replaced is read again from the start', async () => {
    const d = tmp();
    const f = path.join(d, 's.jsonl');
    fs.writeFileSync(f, L({ type: 'user', message: { content: 'x'.repeat(5000) } }));
    const idx = A.emptyIndex();
    await A.scanFile(idx, { file: f, sessionId: 's', agent: 'claude' }, fs.statSync(f));
    fs.writeFileSync(f, L({ type: 'user', message: { content: 'new ' + U2 } }));
    await A.scanFile(idx, { file: f, sessionId: 's', agent: 'claude' }, fs.statSync(f));
    assert.ok(idx.artifacts['AbCdEfGhJkLmNpQrStUvWx']);
});

// ── HTTP guard ──
const req = (headers, method = 'GET', ra = '127.0.0.1') => ({ method, headers, socket: { remoteAddress: ra } });
test('guard: loopback peer and Host only', () => {
    assert.strictEqual(A.guardReason(req({ host: '127.0.0.1:6085' }), 6085), null);
    assert.strictEqual(A.guardReason(req({ host: '127.0.0.1:6085' }, 'GET', '10.0.0.2'), 6085), 'non-loopback peer');
    assert.strictEqual(A.guardReason(req({ host: 'attacker.example:6085' }), 6085), 'bad host');
});
test('guard: cross-site only from the public front end through the daemon proxy', () => {
    const cs = { host: '127.0.0.1:6085', 'sec-fetch-site': 'cross-site' };
    assert.strictEqual(A.guardReason(req({ ...cs, origin: 'https://www.s0a.app' }), 6085), 'cross-site request');
    assert.strictEqual(A.guardReason(req({ ...cs, origin: 'https://www.s0a.app', 'x-forwarded-for': '1.2.3.4' }), 6085), null);
    assert.strictEqual(A.guardReason(req({ ...cs, origin: 'https://www.s0a.app', via: '1.1 x' }), 6085), 'cross-site request');
    assert.strictEqual(A.guardReason(req({ ...cs, origin: 'https://evil.example', 'x-forwarded-for': '1.2.3.4' }), 6085), 'cross-site request');
    assert.strictEqual(A.guardReason(req({ host: '127.0.0.1:6085', 'sec-fetch-site': 'same-site' }, 'POST'), 6085), 'cross-site request');
});

// ── the service end to end ──
function freePort() { return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
function get(port, p, method = 'GET', headers = {}) {
    return new Promise((resolve, reject) => {
        const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ host: `127.0.0.1:${port}` }, headers) }, (r) => {
            let b = ''; r.on('data', (x) => (b += x)); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: r.statusCode, body: j }); });
        });
        rq.on('error', reject); rq.end();
    });
}
test('service: lists, looks up, rescans (coalesced) and refuses bad requests', async (t) => {
    const home = tmp();
    const proj = path.join(home, '.claude', 'projects', '-w-a');
    const sid = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    fs.mkdirSync(path.join(proj, sid, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(proj, sid + '.jsonl'), use('p1', { file_path: '/w/a/1.html', title: 'Main' }, 1) + res('p1', `Published /w/a/1.html at ${U1}`, 2));
    fs.writeFileSync(path.join(proj, sid, 'subagents', 'agent-1.jsonl'), use('s1', { file_path: '/w/a/2.html', title: 'From a subagent' }, 3) + res('s1', `Published /w/a/2.html at ${U2}`, 4));
    const port = await freePort();
    const child = spawn(process.execPath, [SCRIPT, 'serve'], { env: Object.assign({}, process.env, {
        HOME: home, SOA_WEB_STATE_DIR: path.join(home, 'state'), SOA_ARTIFACTS_PORT: String(port), SOA_ARTIFACTS_DAEMON: 'http://127.0.0.1:9', SOA_ARTIFACTS_RESCAN_S: '3600' }), stdio: 'ignore' });
    t.after(() => child.kill());
    let r;
    for (let i = 0; i < 50; i++) {
        try { r = await get(port, '/artifacts'); if (r.body && r.body.total >= 2) break; } catch (_) {}
        await new Promise((z) => setTimeout(z, 100));
    }
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.total, 2);
    const sub = r.body.artifacts.find((a) => a.id === 'AbCdEfGhJkLmNpQrStUvWx');
    assert.strictEqual(sub.title, 'From a subagent');
    assert.deepStrictEqual(sub.sessions.map((s) => s.sessionId), [sid], 'a subagent is credited to its parent session');
    assert.ok(!JSON.stringify(r.body).includes('.html'), 'no file paths in the payload');
    assert.strictEqual((await get(port, '/artifacts/NoSuchIdAAAAAAAAAAAAAA')).status, 404);
    assert.strictEqual((await get(port, '/artifacts/' + '11111111-1111-4111-8111-111111111111'.toUpperCase())).body.artifact.title, 'Main');
    assert.strictEqual((await get(port, '/artifacts?q=subagent')).body.total, 1);
    assert.strictEqual((await get(port, '/artifacts', 'GET', { host: 'evil.example' })).status, 403);
    assert.strictEqual((await get(port, '/rescan', 'POST', { 'content-type': 'application/x-www-form-urlencoded' })).status, 403);
    assert.strictEqual((await get(port, '/rescan', 'POST', { 'content-length': '100000' })).status, 413);
    const kinds = [];
    for (let i = 0; i < 5; i++) kinds.push((await get(port, '/rescan', 'POST')).body.scan);
    assert.ok(kinds.filter((k) => k === 'started').length <= 1, kinds.join(','));
});
