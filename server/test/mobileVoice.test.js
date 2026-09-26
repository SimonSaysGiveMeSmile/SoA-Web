const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../web/public/m');
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const voiceModule = import(asModule(fs.readFileSync(path.join(root, 'voice-chat.js'), 'utf8')));
const terminalModule = import(asModule(fs.readFileSync(path.join(root, 'terminal.js'), 'utf8')
    .replace("'./ansi.js'", JSON.stringify(asModule(fs.readFileSync(path.join(root, 'ansi.js'), 'utf8'))))
    .replace("'./vendor/xterm-headless.mjs'", JSON.stringify(pathToFileURL(path.join(root, 'vendor/xterm-headless.mjs')).href))));
const write = (t, text) => new Promise(resolve => t.write(text, resolve));

test('mobile terminal: every chunk boundary preserves Codex redraws, Unicode, and colors', async () => {
    const { TermBuffer } = await terminalModule;
    const stream = '\x1b[?1049h\x1b[2J\x1b[HWorking…\r\nold answer\x1b[2;1H\x1b[2K\x1b[32mHello 世界 🌍\x1b[0m\x1b[4;1H› Send a message';
    const whole = new TermBuffer({ cols: 40, rows: 8 });
    await write(whole, stream);
    const expected = whole.toHtml();
    for (let i = 1; i < stream.length; i++) {
        const t = new TermBuffer({ cols: 40, rows: 8 });
        await write(t, stream.slice(0, i));
        await write(t, stream.slice(i));
        assert.equal(t.toHtml(), expected, 'split at ' + i);
        t.dispose();
    }
    assert.match(expected, /Hello 世界 🌍/);
    assert.doesNotMatch(expected, /old answer/);
    whole.dispose();
});

test('mobile terminal: alternate screen, scroll regions, reconnect reset and HTML safety', async () => {
    const { TermBuffer } = await terminalModule;
    const t = new TermBuffer({ cols: 20, rows: 5 });
    await write(t, 'shell history\x1b[?1049h\x1b[Hscreen\x1b[5;1Hfooter\x1b[1;4r\x1b[4;1Hscroll\r\nnext');
    assert.match(t.recentText(), /footer/);
    await write(t, '\x1b[?1049l');
    assert.match(t.recentText(), /shell history/);
    t.write('obsolete\x1b[');
    t.reset();
    await write(t, '<img onerror=x>');
    assert.doesNotMatch(t.toHtml(), /obsolete|<img/);
    assert.match(t.toHtml(), /&lt;img/);
    t.dispose();
});

test('mobile terminal: publish only complete synchronized redraws', async () => {
    const { TermBuffer } = await terminalModule;
    let renders = 0;
    const t = new TermBuffer({ onChange: () => renders++ });
    await write(t, '\x1b[?2026hpartial');
    assert.equal(renders, 0);
    await write(t, ' complete\x1b[?2026l');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(renders, 1);
    t.dispose();
});

test('mobile terminal: bounded geometry and DOM, coalesced refresh, disposal stops pending work', async () => {
    const { TermBuffer } = await terminalModule;
    let renders = 0;
    const t = new TermBuffer({ cols: Infinity, rows: -1, onChange: () => renders++ });
    assert.equal(t.term.cols, 80); assert.equal(t.term.rows, 24);
    t.setSize(1000000, 1000000);
    assert.equal(t.term.cols, 512); assert.equal(t.term.rows, 200);
    t.setSize(80, 24);
    for (let i = 0; i < 100; i++) t.write('stream ' + i + '\r\n');
    await write(t, 'last\r\n'.repeat(1000));
    assert.ok(t.lineCount() <= 624);
    assert.ok(t.toHtml().split('\n').length <= 400);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.ok(renders < 10, 'burst does not request a render per chunk');
    await write(t, 'pending');
    t.dispose();
    const before = renders;
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(renders, before);
});

test('voice manager resumes its conversation with the reply relay still attached', () => {
    const { buildArgs } = require('../../scripts/voice-manager.cjs');
    const args = buildArgs('saved-thread', { SOA_WEB_TAB: '7', SOA_WEB_TTS_URL: 'http://127.0.0.1:4010/api/tts' });
    assert.deepEqual(args.slice(0, 2), ['resume', 'saved-thread']);
    assert.ok(args.some(x => x.startsWith('notify=') && x.includes('soa-codex-notify.cjs')));
    const notify = JSON.parse(args.find(x => x.startsWith('notify=')).slice(7));
    const { parseArgs } = require('../../scripts/soa-codex-notify.cjs');
    const parsed = parseArgs([...notify.slice(2), JSON.stringify({ type: 'agent-turn-complete' })], { SOA_WEB_TAB: '99' });
    assert.equal(parsed.env.SOA_WEB_TAB, '7', 'a shared daemon cannot redirect the reply to its inherited tab');
    assert.equal(parsed.env.SOA_WEB_TTS_URL, 'http://127.0.0.1:4010/api/tts');
    assert.ok(!buildArgs().includes('resume'));
});

function recognitionHost() {
    const instances = [];
    const host = { isSecureContext: true, navigator: { language: 'en-US' },
        speechSynthesis: { cancel() {} },
        SpeechRecognition: class {
            constructor() { instances.push(this); }
            start() { this.onstart(); }
            stop() { this.onend(); }
            abort() { this.onend(); }
        } };
    return { host, instances };
}

test('voice chat: revised transcripts become one draft; stop never submits or restarts', async () => {
    const { VoiceChat } = await voiceModule;
    const { host, instances } = recognitionHost();
    const drafts = [], states = [];
    const v = new VoiceChat({ host, onDraft: t => drafts.push(t), onState: s => states.push(s) });
    v.start('Please');
    const rec = instances[0];
    rec.onresult({ results: [[{ transcript: 'check' }]] });
    rec.onresult({ results: [[{ transcript: 'check the deployment' }]] });
    v.stop();
    assert.deepEqual(drafts, ['Please check', 'Please check the deployment']);
    assert.equal(v.active, false);
    assert.equal(instances.length, 1);
    assert.equal(states.at(-1), 'review');
    v.cancel();
});

test('voice chat: cancelled recognition cannot overwrite another tab’s draft; errors allow retry', async () => {
    const { VoiceChat } = await voiceModule;
    const { host, instances } = recognitionHost();
    const drafts = [], errors = [];
    const v = new VoiceChat({ host, onDraft: x => drafts.push(x), onError: x => errors.push(x) });
    v.start();
    v.cancel();
    instances[0].onresult({ results: [[{ transcript: 'late text' }]] });
    assert.deepEqual(drafts, []);
    v.start();
    instances[1].onerror({ error: 'not-allowed' });
    assert.equal(v.active, false);
    assert.match(errors[0], /denied/);
    v.start();
    assert.equal(v.active, true);
    v.cancel();
});

test('voice chat: unavailable/insecure speech provides keyboard dictation fallback', async () => {
    const { VoiceChat } = await voiceModule;
    const errors = [];
    for (const host of [{}, { ...recognitionHost().host, isSecureContext: false }]) {
        const v = new VoiceChat({ host, onError: e => errors.push(e) });
        v.start();
        assert.equal(v.active, false);
    }
    assert.equal(errors.length, 2);
    assert.match(errors[0], /dictation/);
});

test('Codex reply relay uses only its own SoA tab and a loopback target', async () => {
    const { relay } = require('../../scripts/soa-codex-notify.cjs');
    const requests = [];
    const send = async (url, opts) => { requests.push({ url, opts }); return { ok: true }; };
    const env = { SOA_WEB_TTS_URL: 'http://127.0.0.1:4010/api/tts', SOA_WEB_TAB: '3', SOA_WEB_LOCAL_KEY: 'test' };
    const event = { type: 'agent-turn-complete', 'last-assistant-message': 'Ready.' };
    assert.equal(await relay(event, env, send), true);
    assert.deepEqual(JSON.parse(requests[0].opts.body), { text: 'Ready.', tab: 3 });
    assert.equal(await relay(event, {}, send), false);
    assert.equal(await relay(event, { ...env, SOA_WEB_TTS_URL: 'https://example.com' }, send), false);
    assert.equal(requests.length, 1);
});
