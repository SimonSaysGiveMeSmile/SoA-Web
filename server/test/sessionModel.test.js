const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionModels, encodeCwd } = require('../src/sessionModel');

const CLAUDE_A = '11111111-1111-4111-8111-111111111111';
const CLAUDE_B = '22222222-2222-4222-8222-222222222222';
const CODEX_A = '33333333-3333-4333-8333-333333333333';
const CODEX_B = '44444444-4444-4444-8444-444444444444';
const cwd = '/projects/shared';
const assistant = model => JSON.stringify({ type: 'assistant', message: { model } }) + '\n';

function fixture(t, readCodex = async () => { throw new Error('offline'); }) {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-session-model-'));
    const dir = path.join(projectsDir, encodeCwd(cwd));
    fs.mkdirSync(dir);
    let now = 1000;
    const models = new SessionModels({ projectsDir, readCodex, now: () => now, ttl: 10, observe: false });
    t.after(() => { models.close(); fs.rmSync(projectsDir, { recursive: true, force: true }); });
    return { models, dir, advance: () => { now += 11; } };
}

test('siblings sharing a directory retain their own Claude and Codex models', async t => {
    const requests = [];
    const { models, dir } = fixture(t, async id => {
        requests.push(id);
        return { id, model: id === CODEX_A ? 'gpt-6-astra' : 'gpt-6.1-sol', reasoningEffort: id === CODEX_A ? 'max' : 'high' };
    });
    fs.writeFileSync(path.join(dir, CLAUDE_A + '.jsonl'), assistant('claude-opus-5-5'));
    fs.writeFileSync(path.join(dir, CLAUDE_B + '.jsonl'), assistant('claude-fable-5'));
    const a = { cwd, agent: 'claude', sessionId: CLAUDE_A };
    const b = { cwd, agent: 'claude', sessionId: CLAUDE_B };
    const x = { cwd, agent: 'codex', sessionId: CODEX_A };
    const y = { cwd, agent: 'codex', sessionId: CODEX_B };
    assert.equal(models.forTab(a).model, 'claude-opus-5-5');
    assert.equal(models.forTab(b).model, 'claude-fable-5');
    assert.equal(models.forTab(x, { effort: 'ultracode' }).effort, null);
    models.forTab(y);
    await models.settle();
    assert.equal(models.forTab(x).model, 'gpt-6-astra');
    assert.equal(models.forTab(x).effort, 'max');
    assert.equal(models.forTab(y).model, 'gpt-6.1-sol');
    assert.equal(models.forTab(y).effort, 'high');
    assert.deepEqual(requests.sort(), [CODEX_A, CODEX_B]);
});

test('missing or invalid identity never borrows the newest transcript in the directory', t => {
    const { models, dir } = fixture(t);
    fs.writeFileSync(path.join(dir, CLAUDE_B + '.jsonl'), assistant('claude-fable-5'));
    for (const agent of ['claude', 'codex']) {
        assert.equal(models.forTab({ cwd, agent }).model, null);
        assert.equal(models.forTab({ cwd, agent, sessionId: '../' + CLAUDE_B }).model, null);
        assert.equal(models.forTab({ cwd, agent, sessionId: CLAUDE_A }).model, null);
    }
});

test('Claude model changes update from the exact conversation and ignore quoted models', t => {
    const { models, dir, advance } = fixture(t);
    const file = path.join(dir, CLAUDE_A + '.jsonl');
    const tab = { cwd, agent: 'claude', sessionId: CLAUDE_A };
    fs.writeFileSync(file, assistant('claude-opus-5-5'));
    assert.equal(models.forTab(tab).model, 'claude-opus-5-5');
    fs.appendFileSync(file, assistant('claude-sonnet-4-6') +
        JSON.stringify({ type: 'user', message: { model: 'claude-fable-5' } }) + '\n' + assistant('<synthetic>'));
    advance();
    assert.equal(models.forTab(tab).model, 'claude-sonnet-4-6');
});

test('Codex model switches, thread switches, and source failures cannot leave stale Claude metadata', async t => {
    let model = 'gpt-6-astra', fail = false;
    const { models, advance } = fixture(t, async id => {
        if (fail) throw new Error('socket unavailable');
        return { id, model, reasoningEffort: 'max' };
    });
    const tab = { id: 7, cwd, agent: 'codex', sessionId: CODEX_A };
    models.forTab(tab); await models.settle();
    assert.equal(models.forTab(tab).model, model);
    model = 'gpt-6.1-sol'; advance();
    models.forTab(tab); await models.settle();
    assert.equal(models.forTab(tab).model, model);
    tab.sessionId = CODEX_B;
    assert.equal(models.forTab(tab).model, null, 'a new thread has a new cache entry');
    await models.settle();
    fail = true; advance();
    models.forTab(tab); await models.settle();
    assert.equal(models.forTab(tab).model, null);
    assert.equal(models.forTab(tab).effort, null);
});

test('a wrong thread response or a Claude model in Codex metadata is rejected', async t => {
    const { models, advance } = fixture(t, async id => ({ id: CODEX_B, model: 'claude-fable-5', reasoningEffort: 'ultracode' }));
    const tab = { cwd, agent: 'codex', sessionId: CODEX_A };
    models.forTab(tab); await models.settle();
    assert.equal(models.forTab(tab).model, null);
    tab.sessionId = CODEX_B; advance();
    models.forTab(tab); await models.settle();
    assert.equal(models.forTab(tab).model, null);
    assert.equal(models.forTab(tab).effort, null);
});
