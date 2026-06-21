// Unit tests for procMem.subtreeBytes — the pure process-tree RSS summation
// behind the per-tab memory tooltip. snapshot() shells out to `ps` (covered by
// the isolated-daemon smoke), so here we feed a synthetic snapshot.

const test = require('node:test');
const assert = require('node:assert/strict');
const { subtreeBytes } = require('../src/procMem');

// Build a {info,kids} snapshot like procMem.snapshot() returns. rss in KiB.
function mkSnap(rows) {
    const info = new Map();
    const kids = new Map();
    for (const [pid, ppid, rssKb] of rows) {
        info.set(pid, { ppid, rssKb });
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
    }
    return { info, kids };
}

test('sums the whole subtree (root + children + grandchildren), KiB→bytes', () => {
    // 100 (shell) → 200 (claude) → 300 (node), plus 101 a sibling under init.
    const snap = mkSnap([
        [1, 0, 1000],
        [100, 1, 10],   // shell
        [200, 100, 20], // claude under shell
        [300, 200, 30], // node under claude
        [101, 1, 999],  // unrelated process — must NOT be counted
    ]);
    // 10 + 20 + 30 = 60 KiB = 61440 bytes
    assert.equal(subtreeBytes(100, snap), 60 * 1024);
});

test('single leaf pid returns its own rss only', () => {
    const snap = mkSnap([[42, 1, 7]]);
    assert.equal(subtreeBytes(42, snap), 7 * 1024);
});

test('unknown root pid → 0 (degrades to "—")', () => {
    const snap = mkSnap([[100, 1, 10]]);
    assert.equal(subtreeBytes(999, snap), 0);
    assert.equal(subtreeBytes(0, snap), 0);
    assert.equal(subtreeBytes(undefined, snap), 0);
});

test('cycle-safe: a parent/child loop terminates and counts each pid once', () => {
    // Pathological: 100↔200 cite each other as children. Must not infinite-loop.
    const info = new Map([
        [100, { ppid: 200, rssKb: 5 }],
        [200, { ppid: 100, rssKb: 6 }],
    ]);
    const kids = new Map([[200, [100]], [100, [200]]]);
    assert.equal(subtreeBytes(100, { info, kids }), 11 * 1024);
});

test('null/empty snapshot → 0, never throws', () => {
    assert.equal(subtreeBytes(100, { info: new Map(), kids: new Map() }), 0);
    assert.equal(subtreeBytes(100, null), 0);
});
