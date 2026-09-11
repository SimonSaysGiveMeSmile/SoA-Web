const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the shipped browser class without booting Shell, a browser, or PTYs.
// These fakes control only DOM geometry, xterm's asynchronous write boundary,
// and its option-change contract; all queueing and fitting is production code.
const source = fs.readFileSync(path.join(__dirname, '../../web/public/assets/app.js'), 'utf8');
const start = source.indexOf('class TabRuntime {');
const end = source.indexOf('class Shell {', start);
assert.ok(start >= 0 && end > start, 'locate the actual TabRuntime class');
const classSource = source.slice(start, end);

function harness({ width = 1000, height = 500, cell = { width: 10, height: 20 } } = {}) {
    const frames = new Map();
    const timers = new Map();
    let nextTask = 1;
    let canvasMeasurements = 0;
    let fontCell = null;

    class Element {
        constructor() {
            this.clientWidth = width;
            this.clientHeight = height;
            this.children = [];
            this.style = {};
            this.dataset = {};
        }
        appendChild(child) { this.children.push(child); }
        getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight }; }
        querySelector() { return null; }
        addEventListener() {}
        remove() {}
    }

    class Terminal {
        constructor(options) {
            this.cols = 80;
            this.rows = 24;
            this.writes = []; // Writes accepted by xterm, still awaiting its parser.
            this.resizes = [];
            this.optionChanges = [];
            this.openCount = 0;
            this.resetCount = 0;
            this._core = { _renderService: { dimensions: { css: { cell } } } };
            this.options = new Proxy({ ...options }, {
                set: (target, key, value) => {
                    // xterm 5.3 does not dispatch an event for a same-value set.
                    if (target[key] === value) return true;
                    target[key] = value;
                    this.optionChanges.push({ key, value });
                    if (key === 'fontFamily' && fontCell) this.setCell(fontCell);
                    return true;
                },
            });
        }
        loadAddon() {}
        open(container) { this.element = container; this.openCount++; }
        onRender() {}
        onScroll() {}
        onData() {}
        onResize(listener) { this.resizeListener = listener; }
        onTitleChange() {}
        write(data) { this.writes.push(data); }
        reset() { this.resetCount++; }
        resize(cols, rows) {
            this.cols = cols;
            this.rows = rows;
            this.resizes.push({ cols, rows });
            if (this.resizeListener) this.resizeListener({ cols, rows });
        }
        setCell(next) { this._core._renderService.dimensions.css.cell = next; }
    }

    const context = {
        Terminal,
        FitAddon: { FitAddon: class {} },
        WebLinksAddon: { WebLinksAddon: class {} },
        el: () => new Element(),
        getSettings: () => ({ termFontSize: 14, cursorBlink: false, theme: 'dark' }),
        resolveTheme: value => value,
        xtermTheme: () => ({}),
        tr: () => 'terminal',
        PERF: { on: false },
        window: {},
        performance: { now: () => 1000 },
        getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0' }),
        // Deliberately different from renderer cell width: a glyph measurement
        // misses letter spacing and device-pixel rounding in the painted grid.
        document: { createElement: () => ({ getContext: () => ({
            measureText: () => { canvasMeasurements++; return { width: 7.5 }; },
        }) }) },
        requestAnimationFrame: fn => { const id = nextTask++; frames.set(id, fn); return id; },
        cancelAnimationFrame: id => frames.delete(id),
        setTimeout: fn => { const id = nextTask++; timers.set(id, fn); return id; },
        clearTimeout: id => timers.delete(id),
    };
    const Runtime = vm.runInNewContext(classSource + '\nTabRuntime;', context);
    const rt = new Runtime(1, 'test');
    return {
        rt,
        Runtime,
        context,
        get canvasMeasurements() { return canvasMeasurements; },
        get scheduledCount() { return frames.size + timers.size; },
        setFontCell: next => { fontCell = next; },
        show: (w = width, h = height) => { rt.container.clientWidth = w; rt.container.clientHeight = h; },
        drain() {
            // Run callbacks in registration order, respecting cancellations.
            for (let turns = 0; frames.size || timers.size; turns++) {
                assert.ok(turns < 20, 'bounded browser callback schedule');
                const id = Math.min(...frames.keys(), ...timers.keys());
                const queue = frames.has(id) ? frames : timers;
                const callback = queue.get(id);
                queue.delete(id);
                callback();
            }
        },
    };
}

test('terminal client: reconnect drops obsolete app queues and orders RIS after accepted xterm writes', () => {
    const h = harness();
    const { rt } = h;
    rt.fitNow();
    rt.write('already accepted by xterm');
    rt._flushWrites();
    rt.write('obsolete pending frame');
    rt.queueReplay('obsolete hidden history');
    assert.ok(h.scheduledCount > 0);

    rt.resetReplay('replacement snapshot');
    assert.equal(h.scheduledCount, 0, 'cancel callbacks belonging to obsolete output');
    assert.equal(rt.term.resetCount, 0, 'never reset synchronously ahead of queued xterm parsing');
    assert.deepEqual(rt.term.writes, ['already accepted by xterm']);
    assert.equal(rt.flushPendingReplay(), true);
    rt.write('live after snapshot');
    h.drain();

    assert.deepEqual(rt.term.writes, [
        'already accepted by xterm',
        '\x18\x1bcreplacement snapshot',
        'live after snapshot',
    ]);
    assert.equal(rt.flushPendingReplay(), false, 'replacement reset is emitted only once');
});

test('terminal client: an empty reconnect snapshot still clears the previous screen in order', () => {
    const { rt } = harness();
    rt.fitNow();
    rt.resetReplay();
    assert.equal(rt.flushPendingReplay(), true);
    assert.deepEqual(rt.term.writes, ['\x18\x1bc']);
    assert.equal(rt.flushPendingReplay(), false);
});

test('terminal client: one oversized replay is bounded and resumes at a complete ANSI boundary', () => {
    const { rt, Runtime } = harness();
    rt.fitNow();
    rt.queueReplay('old queued history');
    const suffix = '\x1b[32mretained\x1b[0m';
    rt.queueReplay('x'.repeat(Runtime.REPLAY_CAP + 20) + suffix);
    assert.ok(rt._replayLen <= Runtime.REPLAY_CAP, 'single-frame history respects the cap');
    assert.ok(rt._replayChunks.join('').length <= Runtime.REPLAY_CAP);
    rt.flushPendingReplay();
    assert.deepEqual(rt.term.writes, ['\x18\x1b[0m' + suffix]);
});

test('terminal client: chunk eviction repairs a partial command even when retained bytes are below the cap', () => {
    const { rt, Runtime } = harness();
    rt.fitNow();
    rt.queueReplay('x'.repeat(Runtime.REPLAY_CAP - 20) + '\x1b[');
    rt.queueReplay('31mBROKEN\n' + '\x1b[34mkept\x1b[0m' + 'z'.repeat(32));
    assert.ok(rt._replayLen < Runtime.REPLAY_CAP, 'eviction can leave less than a full buffer');
    rt.flushPendingReplay();
    assert.deepEqual(rt.term.writes, ['\x18\x1b[0m\x1b[34mkept\x1b[0m' + 'z'.repeat(32)]);
});

test('terminal client: intact ANSI sequences split across small chunks are preserved byte-for-byte', () => {
    const { rt } = harness();
    rt.fitNow();
    const chunks = ['before\x1b[', '31mred\x1b[0', 'm\r\nafter'];
    chunks.forEach(chunk => rt.queueReplay(chunk));
    rt.flushPendingReplay();
    assert.deepEqual(rt.term.writes, [chunks.join('')]);
});

test('terminal client: missing renderer metrics keep replay and live output queued until fitting succeeds', () => {
    for (const cell of [null, { width: 0, height: 20 }, { width: 10, height: NaN }]) {
        const { rt } = harness({ cell });
        rt.queueReplay('history');
        rt.fitNow();
        assert.equal(rt._everFit, false);
        assert.equal(rt.flushPendingReplay(), false);
        rt.write('live');
        assert.deepEqual(rt.term.writes, []);
        assert.deepEqual(rt.term.resizes, []);

        rt.term.setCell({ width: 10, height: 20 });
        assert.equal(rt.flushPendingReplay(), true);
        assert.equal(rt._everFit, true);
        assert.deepEqual(rt.term.writes, ['historylive']);
    }
});

test('terminal client: hidden containers do not open, claim a fit, or consume replay', () => {
    const h = harness({ width: 0, height: 0 });
    const { rt } = h;
    rt.queueReplay('history');
    rt.fitNow();
    rt.write('live');
    assert.equal(rt._everFit, false);
    assert.equal(rt.term.openCount, 0);
    assert.deepEqual(rt.term.writes, []);
    assert.equal(rt.flushPendingReplay(), false);

    h.show(1000, 500);
    assert.equal(rt.flushPendingReplay(), true);
    assert.equal(rt.term.openCount, 1);
    assert.deepEqual(rt.term.writes, ['historylive']);
});

test('terminal client: dirty fonts trigger real option events once the terminal is visible', () => {
    const h = harness();
    const { rt } = h;
    rt.fitNow();
    const family = rt.term.options.fontFamily;
    rt.term.options.fontFamily = family;
    assert.equal(rt.term.optionChanges.length, 0, 'fake models xterm ignoring equal assignments');

    h.setFontCell({ width: 12.5, height: 20 });
    h.show(0, 0);
    rt.invalidateFontMetrics();
    rt.fitNow();
    assert.equal(rt.term.optionChanges.length, 0, 'defer measurement while hidden');
    assert.equal(rt._fontMetricsDirty, true);

    h.show();
    rt.fitNow();
    assert.equal(rt.term.optionChanges.length, 2, 'change the option then restore the original');
    assert.ok(rt.term.optionChanges.every(change => change.key === 'fontFamily'));
    assert.notEqual(rt.term.optionChanges[0].value, family);
    assert.equal(rt.term.options.fontFamily, family);
    assert.equal(rt.term.cols, 80, 'fit uses the refreshed 12.5px cell');
    assert.equal(rt._fontMetricsDirty, false);
    const resizeCount = rt.term.resizes.length;
    rt.fitNow();
    assert.equal(rt.term.optionChanges.length, 2, 'stable fonts do not churn option events');
    assert.equal(rt.term.resizes.length, resizeCount);
});

test('terminal client: fit uses painted cells including spacing and repeated stable fits do not resize', () => {
    const h = harness({ cell: { width: 10.5, height: 20 } });
    const { rt } = h;
    rt.term.options.letterSpacing = 3;
    const size = rt.fitNow();
    assert.equal(size.cols, 95); // floor(1000 / 10.5), not floor(1000 / 7.5 glyph width)
    assert.equal(size.rows, 25);
    assert.equal(h.canvasMeasurements, 0);
    assert.deepEqual(rt.term.resizes, [{ cols: 95, rows: 25 }]);
    rt.fitNow();
    rt.fitNow();
    assert.equal(rt.term.resizes.length, 1);
    assert.equal(h.context.window.__soaGrid.cellW, 10.5);
});

test('terminal client: resizing A to B and back to A cancels the stale pending B notification', () => {
    const h = harness();
    const sent = [];
    h.rt.attach(() => {}, (cols, rows) => sent.push({ cols, rows }));
    h.rt.fitNow();
    h.drain();
    assert.deepEqual(sent, [{ cols: 100, rows: 25 }]);

    h.show(1200, 500);
    h.rt.fitNow();
    assert.ok(h.scheduledCount > 0, 'B is waiting in the resize debounce');
    h.show(1000, 500);
    h.rt.fitNow();
    h.drain();
    assert.deepEqual(sent, [{ cols: 100, rows: 25 }], 'server remains at the latest local size A');
    assert.equal(h.rt.term.cols, 100);
});

test('terminal client: a lone viewer still renders and reports its own measurement', () => {
    const h = harness({ width: 1000, height: 500, cell: { width: 10, height: 20 } });
    const { rt } = h;
    const reported = [];
    rt.attach(() => {}, (cols, rows) => reported.push({ cols, rows }));
    rt.fitNow();
    h.drain();
    assert.deepEqual({ cols: rt.term.cols, rows: rt.term.rows }, { cols: 100, rows: 25 });
    assert.deepEqual(reported, [{ cols: 100, rows: 25 }]);
});

test('terminal client: the daemon\'s grid is what gets rendered, and is never echoed back', () => {
    const h = harness({ width: 1000, height: 500, cell: { width: 10, height: 20 } });
    const { rt } = h;
    const reported = [];
    rt.attach(() => {}, (cols, rows) => reported.push({ cols, rows }));
    rt.fitNow();
    h.drain();
    reported.length = 0;

    // Another, narrower window attaches: the PTY is now 84x20 for everyone.
    // Rendering at our own 100 columns is the left-hand corruption bug — the
    // agent's 84-column lines would be drawn into a 100-column grid, and on the
    // way back every line longer than 84 would wrap onto the row below.
    assert.equal(rt.adoptGrid(84, 20), true);
    h.drain();
    assert.deepEqual({ cols: rt.term.cols, rows: rt.term.rows }, { cols: 84, rows: 20 });
    assert.deepEqual(reported, [], 'an adopted grid is an answer, not a request');

    // Re-fitting must not fight the adopted grid back to 100. The request is
    // unchanged, so nothing new is sent — but the request on record is still
    // 100x25, not the 84x20 we are drawing at, which is what stops the reported
    // size ratcheting down to the minimum a little more every round.
    rt.fitNow();
    h.drain();
    assert.deepEqual({ cols: rt.term.cols, rows: rt.term.rows }, { cols: 84, rows: 20 });
    assert.deepEqual(reported, [], 'an unchanged request is not re-sent');

    // A genuine change to OUR window is still reported, at our size.
    h.show(1200, 500);
    rt.fitNow();
    h.drain();
    assert.deepEqual({ cols: rt.term.cols, rows: rt.term.rows }, { cols: 84, rows: 20 });
    assert.deepEqual(reported, [{ cols: 120, rows: 25 }]);

    // The narrow window leaves; the daemon reopens the grid.
    assert.equal(rt.adoptGrid(100, 25), true);
    h.drain();
    assert.deepEqual({ cols: rt.term.cols, rows: rt.term.rows }, { cols: 100, rows: 25 });
});

test('terminal client: adopting the grid already on screen changes nothing', () => {
    const h = harness({ width: 1000, height: 500, cell: { width: 10, height: 20 } });
    const { rt } = h;
    rt.attach(() => {}, () => {});
    rt.fitNow();
    h.drain();
    const before = rt.term.resizes.length;
    assert.equal(rt.adoptGrid(100, 25), false);
    assert.equal(rt.term.resizes.length, before, 'no redundant SIGWINCH-inducing resize');
});
