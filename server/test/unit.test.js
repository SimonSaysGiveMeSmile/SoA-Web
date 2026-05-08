const test = require('node:test');
const assert = require('node:assert/strict');

const auth = require('../src/auth');
const { frame, parse, MSG } = require('../src/protocol');
const { SessionStore } = require('../src/sessionStore');

test('auth: sign/verify round-trip', () => {
    const key = 'x'.repeat(32);
    const signed = auth.sign('hello', key);
    assert.equal(auth.verify(signed, key), 'hello');
});

test('auth: verify rejects tampered mac', () => {
    const key = 'x'.repeat(32);
    const signed = auth.sign('hello', key).replace(/.$/, c => c === 'A' ? 'B' : 'A');
    assert.equal(auth.verify(signed, key), null);
});

test('auth: readCookie parses single + multi-value headers', () => {
    assert.equal(auth.readCookie('a=1; b=2', 'b'), '2');
    assert.equal(auth.readCookie('only=value', 'only'), 'value');
    assert.equal(auth.readCookie('', 'x'), null);
    assert.equal(auth.readCookie(null, 'x'), null);
});

test('auth: resolveMode prefers explicit env', () => {
    assert.equal(auth.resolveMode({ SOA_WEB_AUTH: 'shared' }), 'shared');
    assert.equal(auth.resolveMode({ SOA_WEB_AUTH: 'NONE' }), 'none');
    assert.equal(auth.resolveMode({ SOA_WEB_PASSWORD: 'x' }), 'shared');
    assert.equal(auth.resolveMode({}), 'open');
});

test('auth: constantTimeEq', () => {
    assert.equal(auth.constantTimeEq('abc', 'abc'), true);
    assert.equal(auth.constantTimeEq('abc', 'abd'), false);
    assert.equal(auth.constantTimeEq('abc', 'abcd'), false);
});

test('protocol: frame/parse round-trip', () => {
    const f = frame(MSG.HELLO, { x: 1 });
    const p = parse(f);
    assert.equal(p.t, 'hello');
    assert.deepEqual(p.d, { x: 1 });
    assert.equal(p.v, 1);
});

test('protocol: parse rejects junk and wrong version', () => {
    assert.equal(parse('not json'), null);
    assert.equal(parse('{"t":"hello","v":99}'), null);
    assert.equal(parse('{"no":"type"}'), null);
});

test('sessions: create + lookup + destroy', () => {
    const store = new SessionStore({ idleTtlMs: 10_000 });
    const s = store.create();
    assert.equal(store.get(s.id), s);
    assert.equal(store.getByToken(s.token), s);
    store.destroy(s);
    assert.equal(store.get(s.id), null);
    store.shutdown();
});

test('sessions: gc evicts stale sessions', () => {
    const store = new SessionStore({ idleTtlMs: 1 });
    const s = store.create();
    s.lastSeen = Date.now() - 1000;
    store.gc();
    assert.equal(store.get(s.id), null);
    store.shutdown();
});
