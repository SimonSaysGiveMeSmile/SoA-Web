// isLocalRequest must not trust a page that DNS-rebinds its own name to
// 127.0.0.1: the user's browser then calls the daemon from loopback with no
// proxy header, but with the page's name in Host (and its Origin). These pin
// the Host + Origin checks, and that the local-key path is unaffected.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isLocalRequest } = require('../src/sessionManager');
const localHost = require('../src/localHost');
const { LOCAL_KEY } = require('../src/localKey');

const req = (headers, ip = '127.0.0.1') => ({ headers, socket: { remoteAddress: ip } });

test('loopback socket + 127.0.0.1 Host is local', () => {
    assert.equal(isLocalRequest(req({ host: '127.0.0.1:4010' })), true);
    assert.equal(isLocalRequest(req({ host: '127.0.0.1' })), true);
    assert.equal(isLocalRequest(req({ host: '[::1]:4010' }, '::1')), true);
    assert.equal(isLocalRequest(req({ host: '::1' }, '::1')), true);
});

test('loopback socket + localhost:4010 Host is local (any case)', () => {
    assert.equal(isLocalRequest(req({ host: 'localhost:4010' })), true);
    assert.equal(isLocalRequest(req({ host: 'LocalHost:4010' }, '::ffff:127.0.0.1')), true);
});

test('loopback socket + a rebinding Host is NOT local', () => {
    for (const host of ['attacker.example:4010', 'attacker.example', 'localhost.attacker.example:4010',
        '127.0.0.1.attacker.example', 'evil.localhost:4010', '[::2]:4010', '127.0.0.1:4010:1', '127.0.0.1@evil:4010', '']) {
        assert.equal(isLocalRequest(req({ host })), false, host);
    }
    // No Host at all: every browser sends one, so its absence is not a local CLI either.
    assert.equal(isLocalRequest(req({})), false);
});

test('forwarding headers are NOT local even with a loopback Host', () => {
    for (const h of [{ 'cf-connecting-ip': '203.0.113.7' }, { 'x-forwarded-for': '203.0.113.7' },
        { 'x-real-ip': '203.0.113.7' }, { forwarded: 'for=203.0.113.7' }]) {
        assert.equal(isLocalRequest(req({ host: '127.0.0.1:4010', ...h })), false, JSON.stringify(h));
    }
});

test('a non-loopback socket is NOT local even with a loopback Host', () => {
    assert.equal(isLocalRequest(req({ host: '127.0.0.1:4010' }, '192.168.1.20')), false);
});

test('the local key is local regardless of Host, Origin or socket', () => {
    assert.equal(isLocalRequest(req({ 'x-soa-local-key': LOCAL_KEY, host: 'attacker.example:4010' })), true);
    assert.equal(isLocalRequest(req({ 'x-soa-local-key': LOCAL_KEY, host: 'mac.lan:4010', origin: 'https://attacker.example' }, '10.0.0.5')), true);
    assert.equal(isLocalRequest(req({ 'x-soa-local-key': 'wrong', host: 'attacker.example:4010' })), false);
});

test('a third-party Origin is NOT local, even with a loopback Host', () => {
    // No rebinding needed for this one: any page can fetch http://127.0.0.1:4010.
    for (const origin of ['https://attacker.example', 'http://attacker.example:4010', 'null', 'not a url',
        'http://127.0.0.1.attacker.example', 'file://']) {
        assert.equal(isLocalRequest(req({ host: '127.0.0.1:4010', origin })), false, origin);
    }
});

test('a loopback Origin, or none, stays local', () => {
    for (const origin of ['http://127.0.0.1:4010', 'http://localhost:4010', 'http://[::1]:4010', 'http://127.0.0.1:6081', 'https://localhost']) {
        assert.equal(isLocalRequest(req({ host: '127.0.0.1:4010', origin })), true, origin);
    }
    assert.equal(isLocalRequest(req({ host: '127.0.0.1:4010', origin: '' })), true);
});

test('an allowed origin (deployed front end, app shell, tunnel) stays local', () => {
    const list = ['https://www.s0a.app', 'capacitor://localhost'];
    localHost.setTrustedOrigins(list);
    try {
        assert.equal(isLocalRequest(req({ host: 'localhost:4010', origin: 'https://www.s0a.app' })), true);
        assert.equal(isLocalRequest(req({ host: '127.0.0.1:4010', origin: 'capacitor://localhost' })), true);
        assert.equal(isLocalRequest(req({ host: '127.0.0.1:4010', origin: 'https://tunnel.example' })), false);
        // Held by reference: an origin pushed on later (tunnel up) is seen.
        list.push('https://tunnel.example');
        assert.equal(isLocalRequest(req({ host: '127.0.0.1:4010', origin: 'https://tunnel.example' })), true);
        // Still never a way around the Host check.
        assert.equal(isLocalRequest(req({ host: 'attacker.example:4010', origin: 'https://www.s0a.app' })), false);
    } finally { localHost.setTrustedOrigins(null); }
});

test('WebSocket upgrade requests (raw IncomingMessage: no req.ip) use the same rules', () => {
    const up = (headers) => ({ headers: { upgrade: 'websocket', connection: 'Upgrade', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    assert.equal(isLocalRequest(up({ host: '127.0.0.1:4010', origin: 'http://127.0.0.1:4010' })), true);
    assert.equal(isLocalRequest(up({ host: 'attacker.example:4010', origin: 'http://attacker.example:4010' })), false);
});

test('isLoopbackHost parses host[:port] strictly', () => {
    const { isLoopbackHost } = localHost;
    for (const h of ['127.0.0.1', '127.0.0.1:1', 'localhost', 'localhost:65535', '[::1]', '[::1]:4010', '::1']) assert.equal(isLoopbackHost(h), true, h);
    for (const h of [null, undefined, 42, '', '[::1', '[::1]x', '[::1]:', 'localhost:', 'localhost:abc', '127.0.0.2', '0.0.0.0', 'localhost.']) assert.equal(isLoopbackHost(h), false, String(h));
});
