const test = require('node:test');
const assert = require('node:assert/strict');
const { TermBatcher } = require('../src/termBatch');
const { MSG, parse } = require('../src/protocol');

class Socket {
    constructor(caps) {
        this.readyState = 1;
        this.frames = [];
        if (caps) this._caps = caps;
    }
    send(raw) { this.frames.push(parse(raw)); }
}

const batching = () => new Socket({ termBatch: true });

// delayMs 0 uses setImmediate, so one await of a macrotask is enough.
const tick = () => new Promise(r => setImmediate(() => setImmediate(r)));

test('many chunks across many tabs become ONE frame', async () => {
    const ws = batching();
    const b = new TermBatcher({ sockets: () => [ws], delayMs: 0, bgDelayMs: 0 });
    for (let i = 0; i < 10; i++) {
        b.push(1, 'a' + i);
        b.push(2, 'b' + i);
        b.push(3, 'c' + i);
    }
    await tick();
    assert.equal(ws.frames.length, 1, 'thirty chunks, one frame');
    const f = ws.frames[0];
    assert.equal(f.t, MSG.TERM_BATCH);
    assert.equal(f.d.items.length, 3);
    const byId = Object.fromEntries(f.d.items.map(i => [i.id, i.data]));
    assert.equal(byId[1], 'a0a1a2a3a4a5a6a7a8a9', 'order within a tab is preserved');
    assert.equal(byId[2], 'b0b1b2b3b4b5b6b7b8b9');
    assert.equal(byId[3], 'c0c1c2c3c4c5c6c7c8c9');
});

test('a client that has not opted in still gets one TERM_DATA per tab', async () => {
    const legacy = new Socket();
    const modern = batching();
    const b = new TermBatcher({ sockets: () => [legacy, modern], delayMs: 0, bgDelayMs: 0 });
    b.push(1, 'x');
    b.push(2, 'y');
    await tick();
    assert.deepEqual(legacy.frames.map(f => f.t), [MSG.TERM_DATA, MSG.TERM_DATA]);
    assert.deepEqual(legacy.frames.map(f => f.d.data), ['x', 'y']);
    assert.deepEqual(modern.frames.map(f => f.t), [MSG.TERM_BATCH]);
});

test('a socket awaiting replay for a tab is not sent that tab live', async () => {
    const ws = batching();
    ws._pendingReplayTabs = new Set([2]);
    const b = new TermBatcher({ sockets: () => [ws], delayMs: 0, bgDelayMs: 0 });
    b.push(1, 'keep');
    b.push(2, 'drop');
    await tick();
    assert.equal(ws.frames.length, 1);
    assert.deepEqual(ws.frames[0].d.items, [{ id: 1, data: 'keep' }]);
});

test('a socket awaiting replay for every pending tab gets no frame at all', async () => {
    const ws = batching();
    ws._pendingReplayTabs = new Set([1]);
    const b = new TermBatcher({ sockets: () => [ws], delayMs: 0, bgDelayMs: 0 });
    b.push(1, 'drop');
    await tick();
    assert.equal(ws.frames.length, 0);
});

test('closed sockets are skipped', async () => {
    const ws = batching();
    ws.readyState = 3;
    const b = new TermBatcher({ sockets: () => [ws], delayMs: 0, bgDelayMs: 0 });
    b.push(1, 'x');
    await tick();
    assert.equal(ws.frames.length, 0);
});

test('share viewers keep the unbatched per-tab frame', async () => {
    const seen = [];
    const b = new TermBatcher({
        sockets: () => [],
        onShare: (id, f) => seen.push([id, parse(f)]),
        delayMs: 0, bgDelayMs: 0,
    });
    b.push(7, 'hello');
    await tick();
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 7);
    assert.equal(seen[0][1].t, MSG.TERM_DATA);
    assert.equal(seen[0][1].d.data, 'hello');
});

test('a send that throws does not stop the other sockets', async () => {
    const bad = batching();
    bad.send = () => { throw new Error('gone'); };
    const good = batching();
    const b = new TermBatcher({ sockets: () => [bad, good], delayMs: 0, bgDelayMs: 0 });
    b.push(1, 'x');
    await tick();
    assert.equal(good.frames.length, 1);
});

test('destroy flushes what is queued', () => {
    const ws = batching();
    const b = new TermBatcher({ sockets: () => [ws], delayMs: 50, bgDelayMs: 50 });
    b.push(1, 'last words');
    assert.equal(ws.frames.length, 0, 'still waiting on the timer');
    b.destroy();
    assert.equal(ws.frames.length, 1);
    assert.equal(ws.frames[0].d.items[0].data, 'last words');
});

test('flush with nothing pending is a no-op', () => {
    const ws = batching();
    const b = new TermBatcher({ sockets: () => [ws], delayMs: 0, bgDelayMs: 0 });
    b.flush();
    assert.equal(ws.frames.length, 0);
});

test('the timer restarts after a flush', async () => {
    const ws = batching();
    const b = new TermBatcher({ sockets: () => [ws], delayMs: 0, bgDelayMs: 0 });
    b.push(1, 'first');
    await tick();
    b.push(1, 'second');
    await tick();
    assert.deepEqual(ws.frames.map(f => f.d.items[0].data), ['first', 'second']);
});

test('the tab on screen flushes every tick; the rest wait for their own window', async () => {
    const ws = batching();
    let clock = 1000;
    const b = new TermBatcher({
        sockets: () => [ws], activeTab: () => 1,
        delayMs: 0, bgDelayMs: 100, now: () => clock,
    });
    // The first flush opens the background window, so it carries both.
    b.push(1, 'visible');
    b.push(2, 'hidden');
    await tick();
    assert.deepEqual(ws.frames[0].d.items, [{ id: 1, data: 'visible' }, { id: 2, data: 'hidden' }]);

    // Inside that window only the tab on screen keeps going out; nothing is
    // painting the others, so holding them costs nothing and saves a frame.
    for (const n of ['a', 'b', 'c']) {
        b.push(1, n);
        b.push(2, n);
        clock += 10;
        await tick();
    }
    assert.deepEqual(ws.frames.slice(1).map(f => f.d.items), [
        [{ id: 1, data: 'a' }], [{ id: 1, data: 'b' }], [{ id: 1, data: 'c' }],
    ], 'three visible frames, zero background frames');

    // Once the window elapses the held chunks go as ONE item.
    clock += 100;
    b.flush();
    assert.deepEqual(ws.frames[4].d.items, [{ id: 2, data: 'abc' }]);
});

test('a held background tab is not forgotten when nothing else arrives', async () => {
    const ws = batching();
    let clock = 1000;
    const b = new TermBatcher({
        sockets: () => [ws], activeTab: () => 1,
        delayMs: 0, bgDelayMs: 40, now: () => clock,
    });
    b.push(2, 'hidden');
    await tick();                     // first tick: the window has not elapsed
    assert.equal(ws.frames.length, 0);
    clock += 60;
    await new Promise(r => setTimeout(r, 60));
    assert.equal(ws.frames.length, 1, 'it re-armed for itself');
    assert.deepEqual(ws.frames[0].d.items, [{ id: 2, data: 'hidden' }]);
});

test('destroy flushes background tabs too', () => {
    const ws = batching();
    const b = new TermBatcher({ sockets: () => [ws], activeTab: () => 1, delayMs: 5, bgDelayMs: 5000 });
    b.push(2, 'would have waited five seconds');
    b.destroy();
    assert.equal(ws.frames.length, 1);
    assert.equal(ws.frames[0].d.items[0].data, 'would have waited five seconds');
});
