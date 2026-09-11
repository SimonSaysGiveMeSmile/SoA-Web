const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Session } = require('../src/sessionStore');
const { Tab, TabManager } = require('../src/tabManager');
const { MSG, frame, parse } = require('../src/protocol');
const { streamBackgroundReplay, REPLAY_HIGH_WATER } = require('../src/terminalReplay');

class Socket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1;
        this.bufferedAmount = 0;
        this.frames = [];
    }
    send(raw) { this.frames.push(parse(raw)); }
    close() { this.readyState = 3; this.emit('close'); }
}

function setup(ids = [1, 2, 3]) {
    const session = new Session('replay-test');
    session.tabMgr = new TabManager();
    for (const id of ids) {
        const tab = new Tab({ id, scrollbackBytes: 1024 });
        session.tabMgr.tabs.set(id, tab);
        session.tabMgr.order.push(id);
    }
    const socket = new Socket();
    const established = new Socket();
    session.attachSocket(socket);
    session.attachSocket(established);
    const scheduled = [];
    const waits = [];
    const scheduler = {
        schedule(fn) { scheduled.push(fn); },
        wait(fn, ms) { waits.push(ms); scheduled.push(fn); },
    };
    const seed = (id, data) => session.tabMgr.get(id).scrollback.push(data);
    const output = (id, data) => {
        seed(id, data);
        session.sendTerminalData(id, frame(MSG.TERM_DATA, { id, data }));
    };
    const start = () => streamBackgroundReplay(socket, session, session.tabMgr.list(), 1, scheduler);
    const step = () => {
        assert.ok(scheduled.length, 'expected deferred replay work');
        scheduled.shift()();
    };
    return { session, socket, established, scheduled, waits, seed, output, start, step };
}

function terminalFrames(socket, id) {
    return socket.frames.filter(f => f.d.id === id && (f.t === MSG.REPLAY || f.t === MSG.TERM_DATA));
}

test('terminal replay: each snapshot precedes live bytes without duplicating its tail', () => {
    const h = setup();
    h.seed(2, 'old-2\r\n');
    h.seed(3, 'old-3\r\n');
    h.start();

    h.output(2, 'during-2\r\n');
    h.output(3, 'during-3\r\n');
    h.output(1, 'active\r\n');
    assert.deepEqual(h.socket.frames.map(f => f.d.id), [1], 'active tab streams during replay');
    assert.deepEqual(h.established.frames.map(f => f.d.id), [2, 3, 1], 'existing clients receive every live chunk');

    h.step(); // replay tab 2 only; yield before tab 3
    h.output(2, 'after-2\r\n');
    h.output(3, 'later-3\r\n');
    h.step();
    h.output(3, 'after-3\r\n');

    assert.deepEqual(terminalFrames(h.socket, 2).map(f => [f.t, f.d.data]), [
        [MSG.REPLAY, 'old-2\r\nduring-2\r\n'],
        [MSG.TERM_DATA, 'after-2\r\n'],
    ]);
    assert.deepEqual(terminalFrames(h.socket, 3).map(f => [f.t, f.d.data]), [
        [MSG.REPLAY, 'old-3\r\nduring-3\r\nlater-3\r\n'],
        [MSG.TERM_DATA, 'after-3\r\n'],
    ]);
    assert.equal(h.scheduled.length, 0);
});

test('terminal replay: backpressure pauses snapshots while heartbeats and metadata flow', () => {
    const h = setup([1, 2]);
    h.seed(2, 'old\r\n');
    h.socket.bufferedAmount = REPLAY_HIGH_WATER + 1;
    h.start();
    h.step();
    h.output(2, 'while-blocked\r\n');
    h.session.send(frame(MSG.PONG, { ts: 1 }));
    h.session.send(frame(MSG.SNAPSHOT, { tabs: [] }));
    assert.deepEqual(h.socket.frames.map(f => f.t), [MSG.PONG, MSG.SNAPSHOT]);
    assert.deepEqual(h.waits, [50]);
    assert.equal(terminalFrames(h.established, 2)[0].d.data, 'while-blocked\r\n');

    h.socket.bufferedAmount = 0;
    h.step();
    h.output(2, 'after-drain\r\n');
    assert.deepEqual(terminalFrames(h.socket, 2).map(f => f.d.data), [
        'old\r\nwhile-blocked\r\n', 'after-drain\r\n',
    ]);
});

test('terminal replay: vanished and empty tabs do not prevent later replay or live output', () => {
    const h = setup([1, 2, 3, 4]);
    h.seed(4, 'last-tab\r\n');
    h.start();
    h.session.tabMgr.tabs.delete(2);
    h.socket.bufferedAmount = REPLAY_HIGH_WATER + 1;
    h.step(); // vanished tab does not wait for backpressure
    assert.deepEqual(h.waits, []);
    h.socket.bufferedAmount = 0;
    h.step(); // empty tab
    h.output(3, 'first-byte\r\n');
    h.step(); // remaining populated tab
    assert.deepEqual(h.socket.frames.map(f => [f.t, f.d.id, f.d.data]), [
        [MSG.TERM_DATA, 3, 'first-byte\r\n'],
        [MSG.REPLAY, 4, 'last-tab\r\n'],
    ]);
    assert.equal(h.scheduled.length, 0);
});

test('terminal replay: closing a socket cancels its pending replay without affecting peers', () => {
    const h = setup([1, 2]);
    h.start();
    h.socket.bufferedAmount = REPLAY_HIGH_WATER + 1;
    h.step();
    h.socket.close();
    h.step();
    h.output(2, 'still-live\r\n');
    assert.equal(h.socket.frames.length, 0);
    assert.equal(h.scheduled.length, 0);
    assert.equal(h.socket.listenerCount('close'), 0);
    assert.equal(terminalFrames(h.established, 2)[0].d.data, 'still-live\r\n');
});

test('terminal replay: a failed send releases replay state and stops scheduling', () => {
    const h = setup([1, 2]);
    h.seed(2, 'old\r\n');
    h.socket.send = () => { throw new Error('socket write failed'); };
    h.start();
    h.step();
    assert.equal(h.scheduled.length, 0);
    assert.equal(h.socket.listenerCount('close'), 0);
    h.socket.send = Socket.prototype.send;
    h.output(2, 'next\r\n');
    assert.equal(terminalFrames(h.socket, 2)[0].d.data, 'next\r\n');
});

test('terminal replay: a single active tab needs no replay gate', () => {
    const h = setup([1]);
    h.start();
    h.output(1, 'hello\r\n');
    assert.equal(h.scheduled.length, 0);
    assert.equal(h.socket.listenerCount('close'), 0);
    assert.equal(terminalFrames(h.socket, 1)[0].d.data, 'hello\r\n');
});
