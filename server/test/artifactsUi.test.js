const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../web/public/m/artifacts.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
function panel(client) {
    const timers = new Map(); let seq = 0;
    const { ArtifactsPanel } = vm.runInNewContext(source + '\n({ ArtifactsPanel });', {
        URL, URLSearchParams, AbortController,
        setTimeout(fn) { const id = ++seq; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); },
    });
    const p = Object.assign(Object.create(ArtifactsPanel.prototype), {
        client, _seq: 0, _destroyed: false, _paused: false, scope: 'all', q: '', data: null,
        render() {},
    });
    return { p, timers };
}

test('artifact sheet: closing during a scan cancels its follow-up polling', async () => {
    let calls = 0;
    const { p, timers } = panel({ async list() { calls++; return { scanning: true, artifacts: [] }; } });
    await p.refresh();
    assert.equal(timers.size, 1);
    p.pause();
    assert.equal(timers.size, 0);
    await p.refresh();
    assert.equal(calls, 1, 'hidden sheets do not request more data');
});

test('artifact sheet: a late response cannot revive polling after close', async () => {
    let resolve;
    const { p, timers } = panel({ list: () => new Promise(r => { resolve = r; }) });
    const request = p.refresh();
    p.pause();
    resolve({ scanning: true, artifacts: [] });
    await request;
    assert.equal(p.data, null);
    assert.equal(timers.size, 0);
});

test('artifact sheet: returning to a visible sheet refreshes once', async () => {
    let calls = 0;
    const { p, timers } = panel({ async list() { calls++; return { scanning: false, artifacts: [] }; } });
    p.pause();
    await p.resume();
    assert.equal(calls, 1);
    assert.equal(timers.size, 0);
});
