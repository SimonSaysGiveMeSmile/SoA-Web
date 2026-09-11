const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeViewport, liveViewports, agreedSize } = require('../src/termGeometry');

const sock = (cols, rows, readyState = 1, hidden = false) =>
    ({ readyState, _viewport: cols == null ? null : { cols, rows, hidden } });

test('normalizeViewport rejects anything a terminal cannot be', () => {
    assert.deepEqual(normalizeViewport(115, 53), { cols: 115, rows: 53, hidden: false });
    assert.deepEqual(normalizeViewport('115', '53'), { cols: 115, rows: 53, hidden: false });
    assert.deepEqual(normalizeViewport(115.9, 53.9), { cols: 115, rows: 53, hidden: false });
    assert.deepEqual(normalizeViewport(115, 53, true), { cols: 115, rows: 53, hidden: true });
    assert.equal(normalizeViewport(1, 53), null);
    assert.equal(normalizeViewport(115, 1), null);
    assert.equal(normalizeViewport(NaN, 53), null);
    assert.equal(normalizeViewport(undefined, undefined), null);
});

test('liveViewports ignores closed sockets and sockets that never declared', () => {
    const vps = liveViewports([
        sock(115, 53),
        sock(134, 61, 3 /* CLOSED */),
        sock(null),
        null,
        sock(100, 40),
    ]);
    assert.deepEqual(vps, [{ cols: 115, rows: 53, hidden: false }, { cols: 100, rows: 40, hidden: false }]);
});

test('the smallest attached viewer defines the grid, per axis', () => {
    // The bug this exists to prevent: a 134-column PTY drawn into a 115-column
    // emulator wraps every line, and the tail lands on the next row's left.
    assert.deepEqual(agreedSize([{ cols: 134, rows: 61 }, { cols: 115, rows: 53 }]), { cols: 115, rows: 53 });
    // Axes are independent — a tall narrow viewer and a short wide one agree
    // on the rectangle both can actually show.
    assert.deepEqual(agreedSize([{ cols: 160, rows: 30 }, { cols: 100, rows: 50 }]), { cols: 100, rows: 30 });
});

test('a single viewer gets exactly what it asked for', () => {
    assert.deepEqual(agreedSize([{ cols: 115, rows: 53 }]), { cols: 115, rows: 53 });
});

test('nobody attached means leave the PTY alone, never guess a default', () => {
    assert.equal(agreedSize([]), null);
});

test('a departing viewer stops constraining the grid', () => {
    const wide = sock(134, 61);
    const narrow = sock(100, 40);
    assert.deepEqual(agreedSize(liveViewports([wide, narrow])), { cols: 100, rows: 40 });
    narrow.readyState = 3;   // the narrow window closes
    assert.deepEqual(agreedSize(liveViewports([wide, narrow])), { cols: 134, rows: 61 });
});

test('a viewer nobody is looking at does not decide the grid', () => {
    // The regression this exists to prevent: a dashboard left open in a
    // background browser tab (or an automation browser parked on the page) is
    // narrower than the window you are reading, and under a plain minimum it
    // decided the grid — a wide black strip down the right of a terminal with
    // room for sixty more columns.
    const looking = sock(168, 46);
    const background = sock(105, 40, 1, true);
    assert.deepEqual(agreedSize(liveViewports([looking, background])), { cols: 168, rows: 46 });
    // It gets its vote back the moment it is on screen, because then it really
    // can be clipped.
    background._viewport.hidden = false;
    assert.deepEqual(agreedSize(liveViewports([looking, background])), { cols: 105, rows: 40 });
});

test('when every viewer is hidden the whole set still counts', () => {
    // Otherwise a session whose windows are all in the background would have
    // no declared viewport at all and fall back to a guess.
    const a = sock(168, 46, 1, true);
    const b = sock(105, 40, 1, true);
    assert.deepEqual(agreedSize(liveViewports([a, b])), { cols: 105, rows: 40 });
});
