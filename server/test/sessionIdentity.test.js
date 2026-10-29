// Identity is OBSERVED, not guessed. These pin the two properties that make it
// safe to write the result straight into `tab.sessionId`:
//   - we read the id off the agent's own command line, so it is exact;
//   - when there is no id to read we leave the tab blank rather than inventing
//     one, because a wrong "identity" is resumed forever while a blank one falls
//     back to the allocator that knows which threads are already owned.

const test = require('node:test');
const assert = require('node:assert/strict');

const si = require('../src/sessionIdentity');

const SID = 'fd99cf1d-e97c-4581-aba5-c3a9770fa320';
const OTHER = '01a0dbf3-1b52-7500-bff7-d3d897e1e73b';

/** Build a fake process table: [pid, ppid, command] rows. */
function table(rows) {
    const procs = new Map();
    const kids = new Map();
    for (const [pid, ppid, cmd] of rows) {
        procs.set(pid, { ppid, cmd });
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
    }
    return { procs, kids };
}

test('reads a claude thread id off the command line', () => {
    assert.deepEqual(si.idFromCommand(`claude --resume ${SID}`), { agent: 'claude', sessionId: SID });
    assert.deepEqual(si.idFromCommand(`/opt/homebrew/bin/claude -r ${SID}`), { agent: 'claude', sessionId: SID });
});

test('reads a codex thread id, and ignores codex infrastructure processes', () => {
    assert.deepEqual(si.idFromCommand(`codex resume ${OTHER}`), { agent: 'codex', sessionId: OTHER });
    assert.equal(si.idFromCommand('codex app-server daemon pid-update-loop'), null);
    assert.equal(si.idFromCommand('/x/codex-code-mode-host'), null);
});

test('a bare agent reports its KIND but no thread — never an invented one', () => {
    assert.deepEqual(si.idFromCommand('claude'), { agent: 'claude', sessionId: null });
    assert.deepEqual(si.idFromCommand('codex'), { agent: 'codex', sessionId: null });
    // `--last` and `--continue` are "whatever ran here most recently", which is
    // precisely the thing that is not an identity.
    assert.equal(si.idFromCommand('codex resume --last').sessionId, null);
    assert.equal(si.idFromCommand('claude --continue').sessionId, null);
});

test('a command that merely MENTIONS an agent is not an agent', () => {
    assert.equal(si.idFromCommand(`grep claude --resume ${SID}`), null);
    assert.equal(si.idFromCommand(`node build.js --resume ${SID}`), null);
    assert.equal(si.idFromCommand(''), null);
    assert.equal(si.idFromCommand(null), null);
});

test('observe finds the agent under a pty, through the launcher shell', () => {
    const t = table([
        [100, 1, '/bin/zsh'],
        [101, 100, `claude --resume ${SID}`],
    ]);
    assert.deepEqual(si.observe(100, t), { agent: 'claude', sessionId: SID });
});

test('observe takes the tab\'s OWN agent, not a nested subagent\'s thread', () => {
    // The shallow agent was started bare; a subagent under it carries an id.
    // Adopting that id would hand the tab its own subagent's conversation.
    const t = table([
        [100, 1, '/bin/zsh'],
        [101, 100, 'claude'],
        [102, 101, `claude --resume ${OTHER}`],
    ]);
    assert.deepEqual(si.observe(100, t), { agent: 'claude', sessionId: null },
        'a nested subagent must not donate its thread to the tab');
});

test('observe returns null for a pty with no agent in it', () => {
    const t = table([[100, 1, '/bin/zsh'], [101, 100, 'vim notes.md']]);
    assert.equal(si.observe(100, t), null);
    assert.equal(si.observe(0, t), null);
    assert.equal(si.observe(100, null), null);
});

test('stampTabs fills in a blank id and records the agent kind', () => {
    const t = table([
        [100, 1, '/bin/zsh'], [101, 100, `claude --resume ${SID}`],
        [200, 1, '/bin/zsh'], [201, 200, `codex resume ${OTHER}`],
    ]);
    const tabs = [
        { pty: { pid: 100 } },
        { pty: { pid: 200 }, agent: 'claude' },   // misdetected: it is codex
    ];
    const r = si.stampTabs(tabs, { table: t });
    assert.equal(tabs[0].sessionId, SID);
    assert.equal(tabs[0].agent, 'claude');
    assert.equal(tabs[1].sessionId, OTHER);
    assert.equal(tabs[1].agent, 'codex', 'the running process outranks TUI-paint detection');
    assert.equal(r.stamped, 2);
});

test('a LIVE observation supersedes a stale remembered id', () => {
    // The tab was launched on SID, but someone has since pointed it at OTHER by
    // hand. The running process is the only thing that is true now; keeping SID
    // would resume a conversation this tab has already left.
    const t = table([[100, 1, '/bin/zsh'], [101, 100, `claude --resume ${OTHER}`]]);
    const tabs = [{ pty: { pid: 100 }, sessionId: SID }];
    const r = si.stampTabs(tabs, { table: t });
    assert.equal(tabs[0].sessionId, OTHER);
    assert.equal(r.stamped, 1);
});

test('an unchanged id is not re-stamped, so a quiet sweep writes nothing', () => {
    // stamped:0 is what keeps the 30s sweep from rewriting tabs.json forever.
    const t = table([[100, 1, '/bin/zsh'], [101, 100, `claude --resume ${SID}`]]);
    const tabs = [{ pty: { pid: 100 }, sessionId: SID, agent: 'claude' }];
    assert.equal(si.stampTabs(tabs, { table: t }).stamped, 0);
});

test('stampTabs never CLEARS an id when the agent has exited', () => {
    // The tab still knows which conversation it was on — that is exactly what
    // the next resume needs.
    const t = table([[100, 1, '/bin/zsh']]);
    const tabs = [{ pty: { pid: 100 }, sessionId: SID }];
    si.stampTabs(tabs, { table: t });
    assert.equal(tabs[0].sessionId, SID);
});

test('stampTabs skips exited and pid-less tabs without throwing', () => {
    const t = table([[100, 1, '/bin/zsh'], [101, 100, `claude --resume ${SID}`]]);
    const tabs = [{ exited: true, pty: { pid: 100 } }, { pty: null }, null, { pty: { pid: 100 } }];
    assert.doesNotThrow(() => si.stampTabs(tabs, { table: t }));
    assert.equal(tabs[0].sessionId, undefined, 'an exited tab is not re-read from a recycled pid');
    assert.equal(tabs[3].sessionId, SID);
});

test('a cyclic/deep tree cannot hang the sweep', () => {
    const rows = [[100, 1, '/bin/zsh']];
    for (let i = 0; i < 600; i++) rows.push([1000 + i, i === 0 ? 100 : 999 + i, 'sh']);
    rows.push([100, 1000 + 599, '/bin/zsh']); // parent claim that closes a loop
    const t = table(rows);
    assert.doesNotThrow(() => si.observe(100, t));
});

test('the real process table is readable and well-formed', () => {
    const t = si.processTable();
    assert.ok(t && t.procs.size > 0, 'ps must yield a table on this platform');
    assert.ok(t.procs.has(process.pid), 'our own pid must be in it');
    assert.equal(t.procs.get(process.pid).ppid, process.ppid);
});
