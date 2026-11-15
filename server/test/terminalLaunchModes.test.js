const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchClaude } = require('../src/sessionManager');

test('both CLI launches clear inherited mouse tracking before starting and after exiting', async () => {
    const { Terminal } = await import('../../web/public/m/vendor/xterm-headless.mjs');
    for (const agent of ['codex', 'claude']) {
        const writes = [];
        const tab = { exited: false, write: s => writes.push(String(s)) };
        launchClaude(tab, null, { resume: false, agent });
        for (let i = 0; i < 5 && !writes.length; i++) await new Promise(r => setImmediate(r));
        assert.ok(writes.length, 'the launch command must be submitted');
        // Shell functions stand in for the CLIs: no auth, real sessions or
        // quota involved. Split at the moment the next application starts.
        const setup = `printf '\\033[?1003h\\033[?1006h'; ${agent}() { printf 'START\\033[?1003h\\033[?1006h'; }; `;
        const output = execFileSync('/bin/sh', ['-c', setup + writes[0]], { encoding: 'utf8' });
        const [before, after] = output.split('START');
        assert.notEqual(after, undefined, 'the requested agent actually runs');
        const term = new Terminal({ allowProposedApi: true });
        try {
            await new Promise(resolve => term.write(before, resolve));
            assert.equal(term.modes.mouseTrackingMode, 'none', `${agent} starts without inherited mouse reports`);
            await new Promise(resolve => term.write(after, resolve));
            assert.equal(term.modes.mouseTrackingMode, 'none', `${agent} leaves a clean shell`);
        } finally { term.dispose(); }
    }
});
