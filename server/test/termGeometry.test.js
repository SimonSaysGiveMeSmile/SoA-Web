const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeViewport, liveViewports, agreedSize } = require('../src/termGeometry');

const sock = (cols, rows, readyState = 1) => ({ readyState, _viewport: cols == null ? null : { cols, rows } });

test('normalizeViewport rejects anything a terminal cannot be', () => {
    assert.deepEqual(normalizeViewport(115, 53), { cols: 115, rows: 53 });
    assert.deepEqual(normalizeViewport('115', '53'), { cols: 115, rows: 53 });
    assert.deepEqual(normalizeViewport(115.9, 53.9), { cols: 115, rows: 53 });
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
    assert.deepEqual(vps, [{ cols: 115, rows: 53 }, { cols: 100, rows: 40 }]);
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
