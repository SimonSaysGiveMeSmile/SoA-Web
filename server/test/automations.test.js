// The automations switchboard (MANAGER widget backend) + attribution divider.
// 2026-08-27: automated/remote input rendered exactly like local typing and the
// only controls were env vars scattered across the launchd plist — these tests
// pin the contract: env vars stay the default, automations.json overrides them,
// and announce() writes a display-only divider gated by the attribution toggle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), `soa-web-automations-test-${process.pid}`);
process.env.SOA_WEB_STATE_DIR = TMP;

const automations = require('../src/automations');
const { TabManager } = require('../src/tabManager');

function resetStore() { try { fs.unlinkSync(automations.FILE); } catch (_) {} }

test('enabled: env vars are the defaults until a toggle is stored', () => {
    resetStore();
    delete process.env.SOA_WEB_NO_AUTO_RESUME;
    delete process.env.SOA_WEB_NO_BOOT_RESUME;
    assert.equal(automations.enabled('autoResume'), true);
    assert.equal(automations.enabled('bootResume'), true);
    assert.equal(automations.enabled('attribution'), true);
    process.env.SOA_WEB_NO_AUTO_RESUME = '1';
    assert.equal(automations.enabled('autoResume'), false, 'env kill-switch still honored');
    delete process.env.SOA_WEB_NO_AUTO_RESUME;
});

test('set: a stored toggle overrides the env default, both directions', () => {
    resetStore();
    process.env.SOA_WEB_NO_AUTO_RESUME = '1';
    assert.equal(automations.set('autoResume', true), true);
    assert.equal(automations.enabled('autoResume'), true, 'stored ON beats env OFF');
    assert.equal(automations.set('autoResume', false), false);
    delete process.env.SOA_WEB_NO_AUTO_RESUME;
    assert.equal(automations.enabled('autoResume'), false, 'stored OFF beats env ON');
    assert.equal(automations.set('nonsense', true), null, 'unknown toggles are rejected');
    resetStore();
});

test('toggles: reports every switch with overrides folded in', () => {
    resetStore();
    automations.set('bootResume', false);
    assert.deepEqual(automations.toggles(), { autoResume: true, bootResume: false, attribution: true });
    resetStore();
});

test('tabManager.announce: display-only divider — scrollback + onData, never the pty', () => {
    const out = [];
    const mgr = new TabManager({ onData: (id, data) => out.push([id, data]) });
    const pushed = [];
    let ptyWrites = 0;
    mgr.tabs.set(7, { id: 7, exited: false, scrollback: { push: x => pushed.push(x) }, write: () => { ptyWrites++; } });
    mgr.order.push(7);
    assert.equal(mgr.announce(7, 'manager · broadcast'), true);
    assert.equal(pushed.length, 1);
    assert.match(pushed[0], /── manager · broadcast ──/);
    assert.deepEqual(out[0][0], 7);
    assert.equal(out[0][1], pushed[0], 'clients see exactly what scrollback keeps');
    assert.equal(ptyWrites, 0, 'the divider must never reach the shell');
    assert.equal(mgr.announce(7, '\x1b[31mevil\x07'), true, 'control bytes stripped');
    assert.doesNotMatch(pushed[1], /\x07/);
    assert.equal(mgr.announce(99, 'x'), false, 'missing tab is a no-op');
    assert.equal(mgr.announce(7, '   '), false, 'blank label is a no-op');
});

test('automations.announce: gated by the attribution toggle', () => {
    resetStore();
    const calls = [];
    const mgr = { announce: (id, label) => { calls.push([id, label]); return true; } };
    assert.equal(automations.announce(mgr, 1, 'autopilot'), true);
    automations.set('attribution', false);
    assert.equal(automations.announce(mgr, 1, 'autopilot'), false);
    assert.equal(calls.length, 1, 'no divider while attribution is off');
    resetStore();
});

test('parseSupervisors: finds installed launchd jobs by label column', () => {
    const out = [
        'PID\tStatus\tLabel',
        '10709\t0\tapp.s0a.web.local',
        '-\t0\tcom.soa-web.effort-4010',
        '123\t0\tcom.apple.Finder',
        '-\t-9\tcom.soa-web.fleet-loop',
    ].join('\n');
    const rows = automations.parseSupervisors(out);
    const installed = rows.filter(r => r.installed).map(r => r.label);
    assert.deepEqual(installed, ['com.soa-web.effort-4010', 'com.soa-web.fleet-loop']);
    assert.equal(rows.length, automations.SUPERVISOR_LABELS.length);
});
