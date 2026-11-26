// soa-notify's shared push budget: a token bucket and a 429 circuit breaker,
// against a stub ntfy server with an injected clock. Never reaches ntfy.sh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

const BIN = path.join(__dirname, '..', '..', 'scripts', 'soa-notify');
const T0 = 1800000000;

async function stub(t) {
    const replies = [], hits = [];
    const server = http.createServer((req, res) => {
        let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
            hits.push({ url: req.url, title: req.headers.title, body });
            const r = replies.shift() || { status: 200 };
            res.writeHead(r.status, r.headers || {}); res.end('{}');
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => server.close(r)));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-notify-test-'));
    t.after(() => fs.rmSync(state, { recursive: true, force: true }));
    const run = (now, extra = {}) => new Promise(resolve => execFile(BIN, ['-t', 'T', 'hello'], {
        env: { PATH: process.env.PATH, HOME: state, SOA_WEB_STATE_DIR: state, SOA_NOTIFY_TOPIC: 'topic',
               SOA_NOTIFY_SERVER: `http://127.0.0.1:${server.address().port}`, SOA_NOTIFY_NOW: String(now), ...extra },
        timeout: 20000,
    }, (e, out, err) => resolve({ code: e ? e.code : 0, out, err })));
    return { replies, hits, run, state };
}

test('token bucket: 4 pushes per 10 min, the 5th is deferred (exit 75) without a POST', async t => {
    const s = await stub(t);
    for (let i = 0; i < 4; i++) assert.equal((await s.run(T0 + i)).code, 0);
    const r = await s.run(T0 + 10);
    assert.equal(r.code, 75); assert.match(r.err, /push deferred \(push budget spent/);
    assert.equal(s.hits.length, 4);
    assert.equal((await s.run(T0 + 601)).code, 0, 'a slot frees once the oldest push leaves the window');
    assert.equal(s.hits.length, 5);
});

test('429 breaker: 5 → 15 → 30 min, Retry-After honoured, a 2xx resets it', async t => {
    const s = await stub(t);
    const env = { SOA_NOTIFY_BUDGET: '0' };   // isolate the breaker from the bucket
    s.replies.push({ status: 429 });
    let r = await s.run(T0, env);
    assert.equal(r.code, 75); assert.match(r.err, /rate limited \(429 #1\)/);
    assert.equal((await s.run(T0 + 299, env)).code, 75); assert.equal(s.hits.length, 1, 'no POST while open');
    s.replies.push({ status: 429 });
    assert.equal((await s.run(T0 + 300, env)).code, 75);
    assert.equal((await s.run(T0 + 300 + 899, env)).code, 75); assert.equal(s.hits.length, 2);
    s.replies.push({ status: 429, headers: { 'retry-after': '3600' } });
    assert.equal((await s.run(T0 + 1200, env)).code, 75);
    const st = JSON.parse(fs.readFileSync(path.join(s.state, '.push-budget.json'), 'utf8'));
    assert.equal(st.blockedUntil, T0 + 1200 + 3600, 'Retry-After longer than the 30-min step wins');
    assert.equal(st.strikes, 3);
    r = await s.run(T0 + 4800, env);
    assert.equal(r.code, 0); assert.equal(s.hits.length, 4);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.state, '.push-budget.json'), 'utf8')).strikes, 0);
});

test('a non-429 failure is still exit 1 and does not open the breaker', async t => {
    const s = await stub(t);
    s.replies.push({ status: 500 });
    const r = await s.run(T0);
    assert.equal(r.code, 1); assert.match(r.err, /POST failed \(HTTP 500/);
    assert.equal((await s.run(T0 + 1)).code, 0);
});

test('soa-doors shares the breaker: a doors 429 defers soa-notify, a notify 429 pauses doors', async t => {
    const s = await stub(t);
    process.env.SOA_WEB_STATE_DIR = s.state;
    const doors = require('../../scripts/soa-doors');
    const now = Math.floor(Date.now() / 1000);
    doors.updateBreaker(429, now * 1000);
    assert.equal(doors.breakerUntil(now * 1000), (now + 300) * 1000);
    const r = await s.run(now + 10);
    assert.equal(r.code, 75); assert.equal(s.hits.length, 0);
    doors.updateBreaker(429, (now + 301) * 1000);
    assert.equal(doors.breakerUntil((now + 301) * 1000), (now + 301 + 900) * 1000, 'the step follows the shared strike count');
    doors.updateBreaker(200, (now + 2000) * 1000);
    assert.equal(doors.breakerUntil(now * 1000), 0);
    s.replies.push({ status: 429 });
    assert.equal((await s.run(now)).code, 75);
    assert.ok(doors.breakerUntil(now * 1000) > now * 1000, 'doors sees the breaker soa-notify opened');
});

test('fails open: a corrupt budget file or a bad env value never holds pushes back', async t => {
    const s = await stub(t);
    const file = path.join(s.state, '.push-budget.json');
    fs.writeFileSync(file, '{"strikes":"x","blockedUntil":"soon","sent":"nope"}');
    let r = await s.run(T0);
    assert.equal(r.code, 0, r.err); assert.equal(s.hits.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sent, [T0], 'the corrupt state was dropped and rewritten');
    r = await s.run(T0 + 1, { SOA_NOTIFY_BUDGET: 'lots', SOA_NOTIFY_BUDGET_WINDOW: 'x', SOA_NOTIFY_BACKOFF: 'a,b' });
    assert.equal(r.code, 0, r.err); assert.equal(s.hits.length, 2);
    // An unparseable/unwritable state still sends (the check crashing is not "spent").
    fs.rmSync(file); fs.mkdirSync(file);
    r = await s.run(T0 + 2);
    assert.equal(r.code, 0, r.err); assert.equal(s.hits.length, 3);
    assert.match(r.err, /budget check failed .* sending anyway/);
});

test('a network failure gives its budget slot back', async t => {
    const s = await stub(t);
    const dead = { SOA_NOTIFY_SERVER: 'http://127.0.0.1:9' };   // nothing listens: HTTP 000
    for (let i = 0; i < 3; i++) assert.equal((await s.run(T0 + i, dead)).code, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.state, '.push-budget.json'), 'utf8')).sent, []);
    for (let i = 0; i < 4; i++) assert.equal((await s.run(T0 + 10 + i)).code, 0, 'all four slots are still there');
});

test('soa-doors only writes the breaker under the lock, via its own tmp file', async t => {
    const s = await stub(t);
    process.env.SOA_WEB_STATE_DIR = s.state;
    delete require.cache[require.resolve('../../scripts/soa-doors')];
    const doors = require('../../scripts/soa-doors');
    const file = path.join(s.state, '.push-budget.json');
    fs.writeFileSync(file, JSON.stringify({ sent: [], blockedUntil: T0 + 900, strikes: 2 }));
    fs.mkdirSync(file + '.lock');   // soa-notify holds it
    doors.updateBreaker(200, T0 * 1000);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).strikes, 2, 'no unlocked write over the breaker');
    fs.rmdirSync(file + '.lock');
    doors.updateBreaker(200, T0 * 1000);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).strikes, 0);
    assert.deepEqual(fs.readdirSync(s.state).filter(f => f.endsWith('.tmp')), []);
});
