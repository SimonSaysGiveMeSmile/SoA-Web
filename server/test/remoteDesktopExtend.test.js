'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const WebSocket = require('ws');
const { launch, until, sleep } = require('./fixtures/remote/harness.cjs');

test('real service: independent streams, scoped input, reconnect, cleanup and no main-screen fallback', { timeout: 40000 }, async t => {
    const h = await launch(); t.after(h.stop);
    const a = await h.connect(), b = await h.connect('tablet-456');
    await until(() => a.frames && b.frames);
    a.extend();
    const on = await until(() => a.messages.find(m => m.t === 'extend' && m.state === 'on' && m.mine));
    assert.ok(on.screen.x > 0);
    await until(() => h.calls().some(c => c.kind === 'screen' && c.message.includes('--strict-display')));
    const capture = h.calls().filter(c => c.kind === 'screen').at(-1);
    assert.equal(capture.message[4], '42');
    assert.ok(b.messages.filter(m => m.t === 'status').every(m => !m.screen || m.screen.displayId === 0));
    b.extend(); await until(() => b.messages.some(m => m.t === 'extend' && m.reason === 'owned'));
    b.json({ t: 'fit', on: true, dev: b.dev, take: true, area: { w: 600, h: 400 } });
    await until(() => b.messages.some(m => m.t === 'fit' && m.reason === 'extend'));
    const incompatible = await h.connect('old-browser', true);
    incompatible.json({ t: 'mode', mode: 'jpeg' }); await sleep(100);
    assert.equal((await h.health()).extension.state, 'on'); incompatible.close();
    a.json({ t: 'click', x: 10, y: 20, displayId: 0, revision: 0 }); await sleep(100);
    assert.ok(!h.inputs.some(line => line.startsWith('click')));
    a.json({ t: 'click', x: 10, y: 20, displayId: 42, revision: on.screen.revision });
    await until(() => h.inputs.includes('click 1738 20 left 1 -'));
    a.extend('resize', { position: 'left' });
    const left = await until(() => a.messages.find(m => m.t === 'extend' && m.state === 'on' && m.screen?.x < 0));
    a.json({ t: 'down', x: 10, y: 20, mods: ['shift'], displayId: 42, revision: left.screen.revision });
    await until(() => h.inputs.includes(`down ${left.screen.x + 10} 20 left shift`));
    a.close();
    await until(() => h.inputs.includes(`up ${left.screen.x + 10} 20`)); // release is global; no double origin
    const a2 = await h.connect('phone-123', true); a2.extend('resume');
    await until(() => a2.messages.some(m => m.t === 'extend' && m.mine && m.state === 'on'));
    assert.equal(h.calls().filter(c => c.kind === 'virtual' && String(c.message).startsWith('create')).length, 1);
    a2.close();
    await until(async () => (await h.health()).extension.state === 'off');
    assert.equal((await h.health()).viewers, 1); // another viewer does not hold this display open
    assert.ok(!h.calls().some(c => c.kind === 'virtual' && /mirror|restore|set-mode/.test(String(c.message))));
    const a3 = await h.connect('phone-123', true); a3.extend('resume');
    await until(() => a3.messages.some(m => m.t === 'extend' && m.reason === 'expired'));
    const previousCaptures = h.calls().filter(c => c.kind === 'screen' && c.message.includes('--strict-display')).length;
    a3.extend(); await until(() => a3.messages.some(m => m.t === 'extend' && m.mine && m.state === 'on'));
    // Kill only this test's fake capture, forcing strict capture failure.
    const pid = await until(() => { const captures = h.calls().filter(c => c.kind === 'screen' && c.message.includes('--strict-display')); return captures.length > previousCaptures && captures.at(-1).pid; });
    fs.writeFileSync(path.join(h.dir, 'fail-capture'), '1');
    process.kill(pid, 'SIGTERM');
    await until(() => a3.messages.some(m => m.t === 'extend' && m.state === 'error'), 12000);
    const frozen = a3.frames; await sleep(600); assert.equal(a3.frames, frozen);
    const otherFrames = b.frames; await until(() => b.frames > otherFrames);
    assert.equal((await h.health()).fit.state, 'off');
    a3.extend('stop'); await until(() => a3.messages.some(m => m.t === 'extend' && m.state === 'off' && !m.selected));
    await until(() => a3.frames > frozen);
    const denied = new WebSocket(h.base.replace('http:', 'ws:') + 'ws?token=invalid');
    await new Promise(resolve => denied.on('unexpected-response', (_, response) => { assert.equal(response.statusCode, 401); response.resume(); denied.terminate(); resolve(); }).on('error', () => {}));
});
