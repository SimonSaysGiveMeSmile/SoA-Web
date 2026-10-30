'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RemoteExtension, geometry, globalPoint, localPoint } = require('../../scripts/lib/remoteExtension.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const specFor = a => ({ w: a.w * 2, h: a.h * 2, pxW: a.w * 4, pxH: a.h * 4, hidpi: true });
function setup(t, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-extend-unit-'));
    const calls = [], changes = [], released = [];
    const e = new RemoteExtension({ binary: '/fake/virtual-display', build: () => true, workDir: dir, specFor,
        blocked: () => null, beforeChange: ws => released.push(ws), changed: () => changes.push(e.state), graceMs: 35, debounceMs: 5, checkMs: 60000, ...options });
    let current = { id: 42, online: true, main: 1, mirrorOf: 0, mode: { width: 800, height: 1200, pixelWidth: 1600, pixelHeight: 2400 }, bounds: { x: 1728, y: 0 } };
    e.startHelper = () => { e.child = { pid: 123, kill: () => {} }; calls.push('spawn'); };
    e.cmd = async line => {
        calls.push(line);
        const [verb, w, h, hd] = line.split(' ');
        if (verb === 'create' || verb === 'resize') current.mode = { width: +w / (+hd ? 2 : 1), height: +h / (+hd ? 2 : 1), pixelWidth: +w, pixelHeight: +h };
        if (verb === 'extend') current.bounds.x = w === 'left' ? -current.mode.width : 1728;
        return { ok: true, id: current.id };
    };
    e.query = async () => current;
    e.remove = async () => { e.child = null; calls.push('remove'); };
    t.after(() => { clearInterval(e.watch); clearTimeout(e.leaveTimer); clearTimeout(e.resizeTimer); fs.rmSync(dir, { recursive: true, force: true }); });
    const viewer = dev => ({ dev, mode: 'h264', readyState: 1, messages: [], send(data) { this.messages.push(JSON.parse(data)); } });
    const request = (ws, action = 'start', rest = {}) => e.request(ws, { dev: ws.dev, action, area: { w: 400, h: 600 }, ...rest });
    return { e, calls, changes, released, viewer, request, current };
}

test('independent display preserves primary, and input maps both positive and negative origins', () => {
    const q = { online: true, id: 3, main: 1, mirrorOf: 0, mode: { width: 800, height: 600, pixelWidth: 1600, pixelHeight: 1200 }, bounds: { x: -800, y: 100 } };
    const g = geometry(q);
    assert.deepEqual(globalPoint(g, 10, 20), { x: -790, y: 120 });
    assert.deepEqual(localPoint(g, -790, 120), { x: 10, y: 20 });
    assert.deepEqual(globalPoint(g, Infinity, -5), { x: -800, y: 100 });
    assert.deepEqual(globalPoint({ ...g, x: 1728 }, 9999, 9999), { x: 2527, y: 699 });
    assert.equal(geometry({ ...q, main: 3 }), null);
    assert.equal(geometry({ ...q, mirrorOf: 1 }), null);
    assert.equal(geometry({ ...q, online: false }), null);
});
test('create, resize and stop only operate on a virtual display', async t => {
    const { e, calls, viewer, request } = setup(t);
    const a = viewer('phone-123'); await request(a);
    assert.equal(e.state, 'on'); assert.equal(e.source(a).displayId, 42);
    assert.deepEqual(calls, ['spawn', 'create 1600 2400 1 SoA Second Display', 'extend right']);
    await request(a, 'resize', { position: 'left' }); await sleep(15);
    assert.equal(e.source(a).x, -800);
    assert.ok(!calls.some(c => /mirror|restore|set-mode/.test(c)));
    await request(a, 'stop'); assert.equal(e.state, 'off'); assert.equal(a.extended, false);
});
test('another viewer cannot take over, resize or remove the second display', async t => {
    const { e, calls, viewer, request } = setup(t);
    const a = viewer('phone-123'), b = viewer('tablet-456'); await request(a);
    await request(b); await request(b, 'resize'); await request(b, 'stop');
    assert.equal(e.owner, a); assert.equal(e.source(b), null);
    assert.equal(b.messages.filter(m => m.reason === 'owned').length, 3);
    assert.equal(calls.filter(c => c === 'spawn').length, 1);
});
test('resume keeps the same display and expires even while other viewers stay connected', async t => {
    const { e, calls, viewer, request } = setup(t);
    const a = viewer('phone-123'); await request(a); e.left(a);
    const b = viewer('phone-123'); await request(b, 'resume');
    assert.equal(e.owner, b); assert.equal(e.source(b).displayId, 42);
    await sleep(50); assert.equal(e.state, 'on');
    e.left(b); await sleep(50); assert.equal(e.state, 'off');
    const c = viewer('phone-123'); await request(c, 'resume');
    assert.equal(c.messages.at(-1).reason, 'expired');
    assert.equal(calls.filter(c => c === 'spawn').length, 1);
});
test('resume supersedes an old socket without letting its later close remove the new owner', async t => {
    const { e, released, viewer, request } = setup(t);
    const a = viewer('phone-123'), b = viewer('phone-123'); await request(a); await request(b, 'resume');
    e.left(a); await sleep(50);
    assert.equal(e.owner, b); assert.equal(a.extended, false); assert.equal(e.state, 'on'); assert.ok(released.includes(a));
});
test('guard unsupported codec, Fit conflict, malformed messages, and no automatic start from resize', async t => {
    const { e, calls, viewer, request } = setup(t);
    const a = viewer('phone-123'); a.mode = 'jpeg'; await request(a);
    assert.equal(a.messages.at(-1).reason, 'video'); a.mode = 'h264';
    e.blocked = () => 'fit'; await request(a); assert.equal(a.messages.at(-1).reason, 'fit'); e.blocked = () => null;
    await request(a, 'resize'); await request(a, 'start', { area: { w: Infinity, h: 600 } });
    await request(a, 'start', { dev: 'bad\ncommand' });
    assert.deepEqual(calls, []); assert.equal(e.held, false);
});
test('display removal pauses the selected viewer and never silently changes its target', async t => {
    const { e, viewer, request, current } = setup(t);
    const a = viewer('phone-123'); await request(a); current.online = false; await e.check();
    assert.equal(e.state, 'error'); assert.equal(a.extended, true); assert.equal(e.source(a), null);
    assert.match(e.info(a).message, /disconnected/);
    await request(a, 'stop'); assert.equal(a.extended, false);
});
test('orientation resizes coalesce; toolbar jitter does not recreate the display', async t => {
    const { e, viewer, request, calls } = setup(t);
    const a = viewer('phone-123'); await request(a);
    await request(a, 'resize', { area: { w: 400, h: 550 } }); await sleep(15);
    assert.equal(calls.filter(c => c.startsWith('resize')).length, 0);
    await request(a, 'resize', { area: { w: 500, h: 450 } });
    await request(a, 'resize', { area: { w: 600, h: 400 } }); await sleep(20);
    assert.equal(calls.filter(c => c.startsWith('resize')).length, 1);
    assert.equal(e.screen.width, 1200);
});
test('stop during creation cancels it and cannot publish a late display', async t => {
    const { e, viewer, request } = setup(t);
    let done; e.cmd = () => new Promise(r => { done = r; });
    const a = viewer('phone-123'); const creating = request(a);
    const stopping = request(a, 'stop'); done({ ok: true, id: 42 });
    await Promise.all([creating, stopping]);
    assert.equal(e.state, 'off'); assert.equal(e.screen, null); assert.equal(e.owner, null);
});
test('physical arrangement changes update coordinates and reject stale revisions', async t => {
    const { e, viewer, request, current } = setup(t);
    const a = viewer('phone-123'); await request(a);
    const old = e.source(a); current.bounds = { x: -800, y: 300 }; await e.check();
    assert.equal(e.source(a).revision, old.revision + 1);
    assert.deepEqual(globalPoint(e.source(a), 10, 15), { x: -790, y: 315 });
});
