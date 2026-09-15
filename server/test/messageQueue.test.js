const test = require('node:test');
const assert = require('node:assert/strict');
const sessionManager = require('../src/sessionManager');

// submitToTab writes through a per-tab FIFO promise chain, and holds that chain
// for SUBMIT_DELAY_MS between the text and the Enter — so a SECOND submit's text
// cannot land until the first one's Enter has gone. Tests that assert on two
// deliveries have to outwait that, which is the behaviour being asserted.
const settle = () => new Promise(r => setImmediate(r));
const settleChain = () => new Promise(r => setTimeout(r, 160));

// A minimal session: the queue only needs a tab manager that can resolve ids
// to {id, cwd, exited} and accept writes.
let _n = 0;
function fakeSession(tabs) {
    const map = new Map(tabs.map(t => [t.id, { exited: false, written: [], write(s) { this.written.push(s); }, ...t }]));
    return {
        // Unique per test: ensure() memoises the manager per session, so a
        // shared id would hand every test the same queue.
        id: 'test-session-' + (++_n),
        tabMgr: {
            order: [...map.keys()],
            get: id => map.get(id) || null,
            announce() {},
        },
        _tabs: map,
    };
}

function mgrFor(session) {
    const m = sessionManager.ensure(session);
    m.state.queues = [];
    m._queueSentAt = new Map();
    return m;
}

// The agent is sitting at its input box — Claude Code's composer box, which is
// what looksDone() actually matches on.
const READY = '\n╭──────────────────╮\n│ >                │\n╰──────────────────╯\n  shift+tab to cycle\n';
// Mid-turn.
const BUSY = '\n⠹ Pondering… (12s · esc to interrupt)\n';

test('a message waits for the input box and is delivered once it appears', async () => {
    const session = fakeSession([{ id: 1, cwd: '/repo/a' }]);
    const m = mgrFor(session);
    m._state(1).recent = BUSY;
    m._state(1).status = 'working';

    assert.ok(m.queueAdd(1, 'run the tests'), 'queued');
    assert.equal(m.queueGate(1).why, 'busy');
    m.tickQueues();
    assert.equal(m.queueList(1).length, 1, 'still queued while the agent works');

    m._state(1).recent = READY;
    m._state(1).status = 'idle';
    m.tickQueues();
    assert.equal(m.queueList(1).length, 0, 'delivered once the agent is ready');
    await settle();
    assert.deepEqual(session._tabs.get(1).written, ['run the tests']);
});

test('never types into a permission dialog', () => {
    // The Enter that submits a message would ANSWER the dialog instead. This is
    // the failure that matters: it is not a missed message, it is an unintended
    // "yes" to whatever was being asked.
    const session = fakeSession([{ id: 1, cwd: '/repo/a' }]);
    const m = mgrFor(session);
    m.queueAdd(1, 'ship it');
    m._state(1).recent = READY;      // the prompt box looks idle...
    m._state(1).status = 'attention'; // ...but the agent is asking permission
    m.tickQueues();
    assert.equal(m.queueList(1).length, 1, 'held');
    assert.equal(m.queueList(1)[0].why, 'attention', 'and says why');
    assert.deepEqual(session._tabs.get(1).written, []);
});

test('never types into a rate-limited agent', () => {
    const session = fakeSession([{ id: 1, cwd: '/repo/a' }]);
    const m = mgrFor(session);
    m.queueAdd(1, 'continue');
    m._state(1).recent = READY;
    m._state(1).limit = { until: Date.now() + 60000 };
    m.tickQueues();
    assert.equal(m.queueList(1).length, 1);
    assert.equal(m.queueList(1)[0].why, 'limited');
});

test('one message per turn, not the whole queue into one prompt', async () => {
    // Between two ticks the agent has not produced output yet, so it still
    // LOOKS ready. Without the cooldown the entire queue would land in a single
    // prompt, which is the one thing a queue must not do.
    const session = fakeSession([{ id: 1, cwd: '/repo/a' }]);
    const m = mgrFor(session);
    m.queueAdd(1, 'first');
    m.queueAdd(1, 'second');
    m._state(1).recent = READY;
    m.tickQueues();
    m.tickQueues();
    await settle();
    assert.deepEqual(session._tabs.get(1).written, ['first'], 'only the first went');
    assert.equal(m.queueList(1).length, 1, 'the second is still queued');
    assert.equal(m.queueList(1).length, 1);
    assert.equal(m.queueGate(1).why, 'cooldown');

    // Past the gap, the next one goes.
    m._queueSentAt.set(1, Date.now() - 60_000);
    m.tickQueues();
    await settleChain();
    assert.deepEqual(
        session._tabs.get(1).written.filter(w => w !== '\r'),
        ['first', 'second'],
    );
});

test('queues are per tab, even when tabs share a directory', async () => {
    const session = fakeSession([{ id: 1, cwd: '/repo/a' }, { id: 2, cwd: '/repo/a' }]);
    const m = mgrFor(session);
    m.queueAdd(1, 'for one');
    m.queueAdd(2, 'for two');
    m._state(1).recent = READY;
    m._state(2).recent = READY;
    m.tickQueues();
    await settle();
    assert.deepEqual(session._tabs.get(1).written, ['for one']);
    assert.deepEqual(session._tabs.get(2).written, ['for two']);
});

test('edit and remove before it fires', async () => {
    const session = fakeSession([{ id: 1, cwd: '/repo/a' }]);
    const m = mgrFor(session);
    const a = m.queueAdd(1, 'typo');
    const b = m.queueAdd(1, 'drop me');
    assert.equal(m.queueEdit(a.id, 'fixed').text, 'fixed');
    assert.equal(m.queueRemove(b.id), true);
    assert.equal(m.queueRemove('nope'), false);
    m._state(1).recent = READY;
    m.tickQueues();
    await settle();
    assert.deepEqual(session._tabs.get(1).written, ['fixed']);
});

test('empty text is not a message', () => {
    const session = fakeSession([{ id: 1, cwd: '/repo/a' }]);
    const m = mgrFor(session);
    assert.equal(m.queueAdd(1, '   '), null);
    assert.equal(m.queueAdd(1, ''), null);
    assert.equal(m.queueAdd(99, 'no such tab'), null);
    assert.equal(m.queueList(1).length, 0);
});

test('a queued message survives a daemon restart', () => {
    // Half the reason the queue lives in the daemon instead of a browser tab.
    // loadManagerState is a WHITELIST: a field it does not name is written to
    // disk and then silently dropped on the way back in — which is exactly what
    // happened the first time this was tested end to end.
    const { normalizeQueues } = sessionManager;
    const kept = normalizeQueues([
        { id: 'a1', tabId: 3, cwd: '/repo/a', text: 'still here', at: 1 },
        { id: 'b2', tabId: 3, text: '   ' },                    // no body
        { id: 'c3', text: 'no way to find its tab again' },     // no tabId, no cwd
        { id: 'd4', cwd: '/repo/b', text: 'cwd is enough' },    // id is gone, cwd resolves it
        null,
    ]);
    assert.deepEqual(kept.map(q => q.text), ['still here', 'cwd is enough']);
    assert.deepEqual(normalizeQueues(undefined), []);
});
