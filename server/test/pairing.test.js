// PairingManager tunnel lifecycle. 2026-08-25: cloudflared exited twice (laptop
// slept through its reconnect budget) and the manager sat in `error` until a
// human clicked START — the phone's link was dead for hours each time. The
// manager must re-open the tunnel on its own, announce the new URL, and never
// resurrect a tunnel the user stopped or one that died during shutdown.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

process.env.SOA_WEB_STATE_DIR = path.join(os.tmpdir(), `soa-web-pairing-test-${process.pid}`);

const { PairingManager } = require('../src/pairing');

// A tunnel handle shaped like tunnel.js returns: url, close(), and an onDeath
// setter the manager subscribes to. `kill()` simulates the process dying.
function fakeTunnel(url) {
    let onDeath = null;
    return {
        url,
        closed: false,
        close() { this.closed = true; },
        set onDeath(fn) { onDeath = fn; },
        kill() { if (onDeath) onDeath(); },
    };
}

function mkManager({ urls, restartDelayMs = 5 } = {}) {
    const opened = [];
    const openTunnel = async (port) => {
        const url = urls.shift();
        if (!url) return null;
        const t = fakeTunnel(url);
        opened.push(t);
        return t;
    };
    const pair = new PairingManager({ port: 4010, openTunnel, adopt: async () => null, restartDelayMs });
    return { pair, opened };
}

const tick = (ms) => new Promise(r => setTimeout(r, ms));

test('pairing: a dead tunnel is re-opened automatically and the new URL is announced', async () => {
    const { pair, opened } = mkManager({ urls: ['https://one.trycloudflare.com', 'https://two.trycloudflare.com'] });
    const announced = [];
    pair.onTunnelUp = (url) => announced.push(url);
    const snap = await pair.start();
    assert.equal(snap.state, 'online');
    assert.equal(snap.publicUrl, 'https://one.trycloudflare.com');

    opened[0].kill();
    assert.equal(pair.state, 'error', 'death is visible immediately');
    assert.match(pair.error, /restarting/);

    await tick(40);
    assert.equal(pair.state, 'online');
    assert.equal(pair.publicUrl, 'https://two.trycloudflare.com');
    assert.deepEqual(announced, ['https://two.trycloudflare.com']);
    assert.equal(opened.length, 2);
});

test('pairing: keeps retrying while the provider is still down', async () => {
    const { pair, opened } = mkManager({ urls: ['https://one.trycloudflare.com', null, null, 'https://back.trycloudflare.com'] });
    await pair.start();
    opened[0].kill();
    await tick(80);
    assert.equal(pair.state, 'online');
    assert.equal(pair.publicUrl, 'https://back.trycloudflare.com');
    pair.stop();
});

test('pairing: stop() is final — no auto-restart after an explicit stop', async () => {
    const { pair, opened } = mkManager({ urls: ['https://one.trycloudflare.com', 'https://two.trycloudflare.com'] });
    await pair.start();
    pair.stop();
    assert.equal(pair.state, 'idle');
    opened[0].kill();   // late exit notification from the process we just closed
    await tick(40);
    assert.equal(pair.state, 'idle');
    assert.equal(opened.length, 1, 'no second tunnel was opened');
});

test('pairing: detach() (daemon shutdown) never restarts a tunnel that dies afterwards', async () => {
    const { pair, opened } = mkManager({ urls: ['https://one.trycloudflare.com', 'https://two.trycloudflare.com'] });
    await pair.start();
    const t = opened[0];
    pair.detach();
    t.kill();
    await tick(40);
    assert.equal(opened.length, 1);
    assert.equal(pair.tunnel, null);
});

test('pairing: a manual start() during the restart window cancels the pending timer (one tunnel, not two)', async () => {
    const { pair, opened } = mkManager({ urls: ['https://one.trycloudflare.com', 'https://two.trycloudflare.com', 'https://three.trycloudflare.com'], restartDelayMs: 30 });
    await pair.start();
    opened[0].kill();
    await pair.start();   // the user clicks START before the 30ms auto-restart fires
    await tick(80);
    assert.equal(opened.length, 2, 'the auto-restart did not open a third tunnel');
    assert.equal(pair.publicUrl, 'https://two.trycloudflare.com');
    pair.stop();
});
