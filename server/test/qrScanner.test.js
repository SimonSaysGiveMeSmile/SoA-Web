const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../web/public/m/qrscan.js'), 'utf8')
    .replace(/^export /gm, '').replace(/import\.meta\.url/g, "'https://example.test/m/qrscan.js'");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(fn) {
    for (let i = 0; i < 30 && !fn(); i++) await new Promise(r => setImmediate(r));
    assert.ok(fn(), 'expected asynchronous boundary was reached');
}
function stream(id = 'back') {
    const track = { stopped: false, getSettings: () => ({ deviceId: id }), getCapabilities: () => ({}),
        stop() { this.stopped = true; } };
    return { id, track, getTracks: () => [track], getVideoTracks: () => [track] };
}
function harness({ gum, enumerate, play } = {}) {
    class Element {
        constructor() { this.dataset = {}; this.children = []; this.nodes = {}; this.classList = { remove() {}, add() {} }; }
        querySelector(selector) { return this.nodes[selector] ||= new Element(); }
        contains() { return false; }
        appendChild(child) { this.children.push(child); }
        addEventListener(type, fn) { this['on' + type] = fn; }
        focus() {}
        remove() {}
    }
    class Video extends EventTarget {
        constructor() { super(); this.readyState = 0; this.videoWidth = this.videoHeight = 0; this.paused = true; }
        set srcObject(value) { this._stream = value; if (!value) this.readyState = this.videoWidth = this.videoHeight = 0; }
        get srcObject() { return this._stream; }
        pause() { this.paused = true; }
        play() {
            if (play) return play(this);
            this.readyState = 2; this.videoWidth = 640; this.videoHeight = 480; this.paused = false;
            this.dispatchEvent(new Event('loadeddata'));
            return Promise.resolve();
        }
    }
    let seq = 0;
    const timers = new Map(), intervals = new Map(), calls = [], streams = [];
    const mediaDevices = {
        async getUserMedia(constraints) {
            calls.push(constraints);
            const s = gum ? await gum(constraints, calls.length) : stream();
            streams.push(s); return s;
        },
        enumerateDevices: enumerate || (async () => []),
    };
    const context = { navigator: { mediaDevices }, window: {}, URL, Event, Error,
        document: { activeElement: null, createElement: () => new Element(), removeEventListener() {} },
        setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
        clearTimeout: id => timers.delete(id),
        setInterval: fn => { const id = ++seq; intervals.set(id, fn); return id; },
        clearInterval: id => intervals.delete(id),
    };
    const QrScanner = vm.runInNewContext(source + '\nQrScanner;', context);
    const errors = [];
    const scanner = new QrScanner({ onError: e => errors.push(e.message), actions: { paste() {}, password() {} } });
    scanner.el = new Element(); scanner.video = new Video(); scanner.detector = { detect: async () => [] };
    return { scanner, video: scanner.video, calls, streams, errors, timers, intervals,
        timeout() { const [id, item] = timers.entries().next().value; timers.delete(id); item.fn(); } };
}

test('QR: blocked playback offers a direct preview retry instead of claiming live video', async () => {
    let attempts = 0;
    const h = harness({ play: video => {
        if (++attempts === 1) return Promise.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' }));
        video.readyState = 2; video.videoWidth = 640; video.videoHeight = 480; video.paused = false;
        return Promise.resolve();
    } });
    assert.equal(await h.scanner._open(), false);
    assert.equal(h.scanner.el.dataset.state, 'paused');
    assert.equal(h.streams[0].track.stopped, false, 'a user-gesture retry can reuse the granted stream');
    assert.equal(h.intervals.size, 0, 'no decoding before playback');
    const button = h.scanner.el.querySelector('.qr-state').querySelector('.qr-state-actions').children[0];
    button.onclick();
    assert.equal(attempts, 2, 'play is called in the click handler, without an asynchronous camera request first');
    await until(() => h.scanner.el.dataset.state === 'live');
    assert.equal(h.calls.length, 1);
    h.scanner.stop();
    assert.ok(h.streams[0].track.stopped);
});

test('QR: an unusable video releases the camera and shows a recoverable error', async () => {
    const h = harness({ play: () => Promise.reject(new Error('decoder failed')) });
    assert.equal(await h.scanner._open(), false);
    assert.equal(h.scanner.el.dataset.state, 'error');
    assert.ok(h.streams[0].track.stopped);
    assert.equal(h.video.srcObject, null);
    assert.equal(h.intervals.size, 0);
});

test('QR: live means playable frames, not merely a resolved play promise', async () => {
    const h = harness({ play: () => Promise.resolve() });
    const opened = h.scanner._open();
    await until(() => h.calls.length > 0 && h.video.srcObject);
    assert.equal(h.scanner.el.dataset.state, 'starting');
    h.video.readyState = 2; h.video.videoWidth = 640; h.video.videoHeight = 480; h.video.paused = false;
    h.video.dispatchEvent(new Event('loadeddata'));
    assert.equal(await opened, true);
    assert.equal(h.scanner.el.dataset.state, 'live');
    assert.equal(h.video.muted, true);
    assert.equal(h.video.playsInline, true);
    assert.equal(h.timers.size, 0);
    h.scanner.stop();
});

test('QR: a stalled play promise times out and releases the camera', async () => {
    const h = harness({ play: () => new Promise(() => {}) });
    const opened = h.scanner._open();
    await until(() => h.timers.size > 0);
    h.timeout();
    assert.equal(await opened, false);
    assert.equal(h.scanner.el.dataset.state, 'error');
    assert.ok(h.streams[0].track.stopped);
    assert.equal(h.intervals.size, 0);
});

const cameras = async () => [
    { kind: 'videoinput', deviceId: 'front', label: 'Front Camera' },
    { kind: 'videoinput', deviceId: 'back', label: 'Back Camera' },
];
test('QR: an already selected back camera is not acquired a second time', async () => {
    const h = harness({ enumerate: cameras });
    assert.equal(await h.scanner._open(), true);
    assert.equal(h.calls.length, 1);
    h.scanner.stop();
});

test('QR: switching lenses releases the first camera before requesting another', async () => {
    const first = stream('front'), back = stream('back');
    const h = harness({ enumerate: cameras, gum: async (_c, n) => {
        if (n === 1) return first;
        if (!first.track.stopped) throw new Error('camera already in use');
        return back;
    } });
    assert.equal(await h.scanner._open(), true);
    assert.equal(h.scanner.stream, back);
    assert.ok(first.track.stopped);
    h.scanner.stop();
});

test('QR: an unavailable preferred lens falls back to a fresh permissive stream', async () => {
    const first = stream('front'), fallback = stream('front');
    const h = harness({ enumerate: cameras, gum: async (_c, n) => {
        if (n === 1) return first;
        if (n === 2) throw new Error('lens unavailable');
        return fallback;
    } });
    assert.equal(await h.scanner._open(), true);
    assert.equal(h.scanner.stream, fallback);
    assert.ok(first.track.stopped);
    h.scanner.stop();
});

test('QR: closing during permission disposes the late stream without requesting a second lens', async () => {
    const gate = deferred(), late = stream();
    const h = harness({ gum: () => gate.promise, enumerate: cameras });
    const opened = h.scanner._open();
    await until(() => h.calls.length === 1);
    h.scanner.stop(); gate.resolve(late);
    assert.equal(await opened, false);
    assert.ok(late.track.stopped);
    assert.equal(h.calls.length, 1);
    assert.equal(h.scanner.stream, null);
});

test('QR: closing during lens discovery releases the granted stream immediately', async () => {
    const gate = deferred(), first = stream('front');
    let enumerating = false;
    const h = harness({ gum: async () => first, enumerate: () => { enumerating = true; return gate.promise; } });
    const opened = h.scanner._open();
    await until(() => enumerating);
    h.scanner.stop();
    assert.ok(first.track.stopped);
    gate.resolve(await cameras());
    assert.equal(await opened, false);
    assert.equal(h.calls.length, 1);
});

test('QR: closing a stalled preview cancels readiness listeners and timers', async () => {
    const h = harness({ play: () => new Promise(() => {}) });
    const opened = h.scanner._open();
    await until(() => h.timers.size > 0);
    h.scanner.stop();
    assert.equal(await opened, false);
    assert.ok(h.streams[0].track.stopped);
    assert.equal(h.timers.size, 0);
    assert.equal(h.intervals.size, 0);
});
