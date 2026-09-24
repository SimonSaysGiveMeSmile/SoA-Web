// Voice control unit tests.
//
// Three things here are worth pinning down, and none of them is the happy path:
//
//   1. WAKE-WORD FUZZINESS. Browser ASR mangles a two-syllable name constantly.
//      If "hey antoine" doesn't wake it, the feature reads as broken — but if
//      the budget is too loose, ordinary speech triggers commands. These tests
//      fix both edges.
//   2. THE INTENT TABLE'S PRECEDENCE. "stop" must interrupt, not be swallowed
//      by a project match; "change model to opus" must not become run_command.
//      Ordering bugs in a regex cascade are silent, so they are asserted.
//   3. MODEL OUTPUT PARSING. A headless `claude -p` answers with prose around
//      its JSON often enough that a naive JSON.parse loses real commands.
//
// STATE_DIR is redirected before requiring voice.js — it writes voice.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), `soa-web-voice-test-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.SOA_WEB_STATE_DIR = TMP;
// interpret() spawns the Claude CLI; point it at a binary that exits at once
// so the test below can prove a dead child cannot take the daemon down.
process.env.SOA_VOICE_CLAUDE = '/usr/bin/false';

const voice = require('../src/voice');

// The browser modules are plain scripts with a CommonJS tail, but they touch
// `window` at construction time. A minimal stub is enough for the pure logic.
global.window = {
    SpeechRecognition: function () {
        return { start() {}, stop() {}, addEventListener() {} };
    },
    speechSynthesis: { speak() {}, cancel() {}, getVoices: () => [] },
    localStorage: { getItem: () => null, setItem: () => {} },
};
global.localStorage = global.window.localStorage;
global.SpeechRecognition = global.window.SpeechRecognition;

const { VoiceControl } = require('../../web/public/assets/voice-control.js');
const { VoiceCommands } = require('../../web/public/assets/voice-commands.js');

function newVoice() {
    const v = new VoiceControl();
    v.speak = () => true;          // don't touch synthesis in tests
    return v;
}

// ── wake word ───────────────────────────────────────────────────────────
test('wake word matches the exact phrase and returns the remainder', () => {
    const v = newVoice();
    assert.equal(v._matchWake('hey anton'), '');
    assert.equal(v._matchWake('hey anton read the output'), 'read the output');
    assert.equal(v._matchWake('Hey Anton, go to the iPlan project'), 'go to the iplan project');
});

test('wake word survives the mangles browser ASR actually produces', () => {
    const v = newVoice();
    // Every one of these is a real Chrome transcription of "hey anton".
    for (const heard of ['hey antoine', 'hay anton', 'hey anthon', 'hey antone', 'hey anton,']) {
        assert.notEqual(v._matchWake(heard + ' next tab'), null, heard + ' should wake');
    }
});

test('wake word tolerates a leading filler word', () => {
    const v = newVoice();
    assert.equal(v._matchWake('okay hey anton next tab'), 'next tab');
});

test('wake word does not fire on unrelated speech', () => {
    const v = newVoice();
    for (const heard of ['the deployment finished', 'can you hand me that', 'hey there everyone', 'anyone want coffee']) {
        assert.equal(v._matchWake(heard), null, heard + ' must NOT wake');
    }
});

test('wake word does not fire on ordinary English that merely starts with "hey"', () => {
    // These are within two edits of "hey anton" as a whole phrase. A false
    // wake opens a 15s window in which a bare "stop" is a Ctrl-C to a live
    // agent, so the near-neighbours are the edge that matters.
    const v = newVoice();
    for (const heard of [
        'hey anyone know why the build broke',
        'hey anyone else seeing this',
        'hey and on the deploy front we should ship friday',
        'hey anything else',
        'hey anybody home',
        'hey and one more thing',
        'they often break',
        // one edit from the name across a word boundary — the split path is gone
        'hey a ton of tests are failing',
        'hey an ton of stuff',
        'hey at on second thought',
        'hey a town called malice',
        // real names two edits from the name
        'hey anthony will review it',
        'hey antonio said yes',
        'hey antenna is loose',
        // short words that share "an" and sit within two edits
        'hey ann can you look at this pr',
        'hey ants are all over the kitchen',
        'hey anti aliasing looks wrong here',
        'hey ant build is broken',
        'hey ant stop',
        'he ants marched in',
    ]) {
        assert.equal(v._matchWake(heard), null, heard + ' must NOT wake');
    }
});

test('a custom wake phrase replaces the default', () => {
    const v = newVoice();
    v.setWakeWord('yo computer');
    assert.equal(v._matchWake('yo computer read output'), 'read output');
    assert.equal(v._matchWake('hey anton read output'), null);
});

test('a one-word wake phrase must match exactly — no fuzz, so ordinary sentences cannot wake it', () => {
    const v = newVoice();
    v.setWakeWord('computer');
    assert.equal(v._matchWake('computer next tab'), 'next tab');
    assert.equal(v._matchWake('okay computer next tab'), 'next tab');
    assert.equal(v._matchWake('my computer crashed'), null);
    assert.equal(v._matchWake('the computer is slow'), null);
    assert.equal(v._matchWake('compute the total'), null);
});

test('"stop talking" silences speech and never Ctrl-Cs the agent', () => {
    const v = newVoice();
    for (const said of ['stop talking', 'stop reading', 'stop speaking', 'be quiet', 'shut up']) {
        const r = v._parseCommand(said);
        assert.equal(r.intent, 'app_action', said + ' must be an app action');
        assert.equal(r.params.actionId, 'shut_up', said);
    }
    assert.equal(v._parseCommand('stop').intent, 'interrupt');
    assert.equal(v._parseCommand('stop it').intent, 'interrupt');
    assert.equal(v._parseCommand('stop the build').intent, 'interrupt');
    assert.notEqual(v._parseCommand('stop worrying and ship it').intent, 'interrupt');
    // "stop reading the output" is a request for silence, not for more reading
    const r = v._parseCommand('stop reading the output');
    assert.equal(r.intent, 'app_action'); assert.equal(r.params.actionId, 'shut_up');
    // the TTS toggle's own advertised phrase turns narration off
    const t = v._parseCommand('stop speaking replies');
    assert.equal(t.intent, 'app_action'); assert.equal(t.params.actionId, 'toggle_tts');
});

test('a dead interpreter child cannot crash the daemon (EPIPE on a large prompt)', async () => {
    // SOA_VOICE_CLAUDE is /usr/bin/false: the child exits before reading
    // stdin, so ending a >64KB prompt into it fails asynchronously with
    // EPIPE. With no 'error' listener that was an uncaughtException.
    let crashed = null;
    const onUncaught = (e) => { crashed = e; };
    process.on('uncaughtException', onUncaught);
    try {
        const r = await voice.interpret('x'.repeat(300 * 1024), { tabs: [], projects: [], controls: [] }, { model: 'haiku' });
        assert.equal(r.intent, 'unknown');
        await new Promise(res => setTimeout(res, 150));   // let any late stream error surface
        assert.equal(crashed, null, 'stdin/stdout error must be handled: ' + (crashed && crashed.message));
    } finally {
        process.off('uncaughtException', onUncaught);
    }
});

// ── intent parsing ──────────────────────────────────────────────────────
test('control intents beat everything else in the cascade', () => {
    const v = newVoice();
    // "stop" must always reach the process, never get read as a project name.
    assert.equal(v._parseCommand('stop').intent, 'interrupt');
    assert.equal(v._parseCommand('cancel').intent, 'interrupt');
    assert.equal(v._parseCommand('go to sleep').intent, 'sleep');
});

test('terminal-specific intents parse', () => {
    const v = newVoice();
    const cases = [
        ['read the output', 'read_output'],
        ['what is happening', 'read_output'],
        ['any errors', 'check_status'],
        ['is it done', 'check_progress'],
        ['how is my usage', 'usage_report'],
        ['how much have I spent today', 'usage_report'],
        ['how are the agents', 'fleet_status'],
        ['change model to opus', 'change_model'],
        ['switch to sonnet', 'change_model'],
        ['go to tab 3', 'switch_tab'],
        ['next tab', 'next_tab'],
        ['run npm test', 'run_command'],
        ['type hello world', 'type_text'],
        ['press enter', 'send_key'],
        ['clear the screen', 'clear_screen'],
        ['continue', 'continue_session'],
        ['take a picture', 'capture_image'],
        ['be brief', 'set_verbosity'],
        ['help', 'help'],
    ];
    for (const [said, want] of cases) {
        assert.equal(v._parseCommand(said).intent, want, `"${said}" → ${want}`);
    }
});

test('model and tab parameters are extracted, not just matched', () => {
    const v = newVoice();
    assert.equal(v._parseCommand('change model to opus').params.model, 'opus');
    assert.equal(v._parseCommand('go to tab 7').params.tabId, 7);
    assert.equal(v._parseCommand('run npm test -- --watch').params.command, 'npm test -- --watch');
    assert.equal(v._parseCommand('read the last 5 lines of output').params.lines, 5);
    assert.equal(v._parseCommand('how much did I spend this week').params.scope, 'week');
});

test('a project name becomes switch_project with the name as the query', () => {
    const v = newVoice();
    const p = v._parseCommand('go to the iplan project');
    assert.equal(p.intent, 'switch_project');
    assert.equal(p.params.query, 'iplan');
});

test('free-form requests fall through to unknown so the model can take them', () => {
    const v = newVoice();
    for (const said of [
        'i need your help building the migration',
        'take a look at why the tests are failing',
        'what do you think about the api design',
    ]) {
        assert.equal(v._parseCommand(said).intent, 'unknown', said);
    }
});

// ── echo suppression ────────────────────────────────────────────────────
test('transcripts arriving while speaking are dropped', () => {
    const v = newVoice();
    v.settings.wakeMode = 'always';
    v.awake = true;
    let fired = 0;
    v.onCommand = () => { fired++; };
    v.isSpeaking = true;
    v._handleFinal(['next tab']);
    assert.equal(fired, 0, 'own TTS must not command the terminal');
    v.isSpeaking = false;
    v._lastSpokenAt = 0;
    v._handleFinal(['next tab']);
    assert.equal(fired, 1);
});

// ── fuzzy project matching ──────────────────────────────────────────────
test('project matching scores titles and cwd basenames', () => {
    const tabs = [
        { id: 1, title: 'soa-web', cwd: '/Users/x/Desktop/Hireal/soa-web' },
        { id: 2, title: 'iPlan', cwd: '/Users/x/Desktop/Summer-2026/iPlan' },
        { id: 3, title: 'manager', cwd: '/Users/x/.soa-web' },
    ];
    assert.equal(VoiceCommands.bestMatch('iplan', tabs, ['title', 'basename']).item.id, 2);
    assert.equal(VoiceCommands.bestMatch('i plan', tabs, ['title', 'basename']).item.id, 2);
    assert.equal(VoiceCommands.bestMatch('soa web', tabs, ['title', 'basename']).item.id, 1);
    assert.equal(VoiceCommands.bestMatch('nonsense zzz', tabs, ['title', 'basename']), null);
});

// ── model output parsing ────────────────────────────────────────────────
test('extractJson pulls the object out of chatty model output', () => {
    const cases = [
        '{"intent":"next_tab","params":{}}',
        'Sure! {"intent":"next_tab","params":{}}',
        '```json\n{"intent":"next_tab","params":{}}\n```',
        '{"intent":"next_tab","params":{}}\nHope that helps.',
    ];
    for (const raw of cases) {
        const got = voice.extractJson(raw);
        assert.equal(got && got.intent, 'next_tab', raw.slice(0, 30));
    }
});

test('extractJson handles braces inside strings', () => {
    const got = voice.extractJson('{"intent":"type_text","params":{"text":"a } brace"}}');
    assert.equal(got.params.text, 'a } brace');
});

test('extractJson returns null rather than throwing on garbage', () => {
    assert.equal(voice.extractJson('no json at all'), null);
    assert.equal(voice.extractJson('{"broken": '), null);
    assert.equal(voice.extractJson(''), null);
});

// ── prompt construction ─────────────────────────────────────────────────
test('the interpret prompt carries the tab list so project names resolve', () => {
    const p = voice.buildPrompt('go to the iplan repo', {
        tabs: [{ id: 4, title: 'iPlan', cwd: '/Users/x/iPlan', status: 'working' }],
        projects: ['/Users/x/other'],
    });
    assert.match(p, /#4 "iPlan"/);
    assert.match(p, /^  other$/m, 'known projects are listed by name');
    // Names only: this prompt leaves the machine (claude -p → Anthropic API),
    // and the client resolves names back to tabs/paths itself.
    assert.doesNotMatch(p, /\/Users\/x/, 'absolute paths must not be sent');
    // The sentence must be JSON-quoted so an apostrophe can't break the prompt.
    assert.match(p, /Sentence: "go to the iplan repo"/);
});

test('every intent the prompt advertises is one the client can execute', () => {
    const cmds = Object.getOwnPropertyNames(VoiceCommands.prototype)
        .filter(n => n.startsWith('do_')).map(n => n.slice(3));
    for (const intent of voice.INTENTS) {
        assert.ok(cmds.includes(intent), `INTENTS has "${intent}" but VoiceCommands has no do_${intent}`);
    }
});

// ── config ──────────────────────────────────────────────────────────────
test('config round-trips and merges onto the defaults', () => {
    const base = voice.loadConfig();
    assert.equal(base.wakeWord, 'hey anton');
    assert.equal(base.wakeMode, 'wake');
    voice.saveConfig({ ...base, wakeWord: 'yo anton', vision: { enabled: true, watchDir: '/tmp' } });
    const back = voice.loadConfig();
    assert.equal(back.wakeWord, 'yo anton');
    assert.equal(back.vision.enabled, true);
    // Keys absent from the saved blob still come from the defaults.
    assert.equal(back.interpretModel, 'haiku');
    assert.equal(typeof back.vision.prompt, 'string');
    voice.saveConfig(base);
});

// ── typing into a tab ───────────────────────────────────────────────────
// The store is SessionStore: `.sessions` is a Map and there is NO primary().
function fakeStore(tabs, activeTab) {
    const writes = [];
    const byId = new Map(tabs.map(id => [id, { write: (d) => writes.push([id, d]) }]));
    const session = { tabMgr: { order: [...tabs], get: (id) => byId.get(id) }, activeTab };
    return { store: { sessions: new Map([['s1', session]]) }, session, writes };
}

test('typeIntoTab finds the fleet session without a primary() on the store', async () => {
    const { store, writes } = fakeStore([3, 7], 7);
    assert.equal(voice.typeIntoTab(store, null, 'hello', true), true);
    await new Promise(resolve => setImmediate(resolve));
    // null tab → the active tab; text now, Enter 160ms later (a glued CR
    // reads as a pasted newline in the TUI, not a submit)
    assert.deepEqual(writes, [[7, 'hello']]);
    await new Promise(r => setTimeout(r, 250));
    assert.deepEqual(writes, [[7, 'hello'], [7, '\r']]);
});

test('typeIntoTab prefers the caller\'s own session', async () => {
    const a = fakeStore([1], 1);
    const b = fakeStore([9], 9);
    assert.equal(voice.typeIntoTab(a.store, null, 'x', false, b.session), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(a.writes.length, 0);
    assert.deepEqual(b.writes, [[9, 'x']]);
});

test('typeIntoTab refuses text carrying a newline or other control byte', () => {
    const { store, writes } = fakeStore([1], 1);
    assert.equal(voice.typeIntoTab(store, 1, 'ok\rrm -rf ~', true), false);
    assert.equal(voice.typeIntoTab(store, 1, 'a;b\n', true), false);
    assert.equal(writes.length, 0);
    assert.equal(voice.isTypeSafe('/Users/x/Pictures/receipt 2.jpg look'), true);
    assert.equal(voice.isTypeSafe('receipt\nrm -rf HOME.jpg'), false);
});

test('typeIntoTab returns false, not a throw, with no fleet session', () => {
    assert.equal(voice.typeIntoTab({ sessions: new Map() }, null, 'x', true), false);
    assert.equal(voice.typeIntoTab(null, null, 'x', true), false);
});

// ── vision watcher ──────────────────────────────────────────────────────
test('the watcher refuses a missing directory instead of throwing', () => {
    const w = new voice.VisionWatcher(null);
    const r = w.start(path.join(TMP, 'does-not-exist'));
    assert.equal(r.ok, false);
    assert.match(r.error, /not found/);
    w.stop();
});

test('the watcher seeds on existing files so it does not replay a library', () => {
    const dir = path.join(TMP, 'photos');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.jpg'), 'x');
    const w = new voice.VisionWatcher(null);
    const r = w.start(dir);
    assert.equal(r.ok, true);
    assert.ok(w.seen.has('old.jpg'), 'pre-existing photos must be treated as seen');
    w.stop();
    assert.equal(w.dir, '');
});

test('the watcher cancels a pending ingest when stopped', async () => {
    const dir = path.join(TMP, 'photos-stop');
    fs.mkdirSync(dir, { recursive: true });
    let ingested = 0;
    const w = new voice.VisionWatcher(null);
    w.onIngest = () => { ingested++; };
    assert.equal(w.start(dir).ok, true);
    fs.writeFileSync(path.join(dir, 'new.png'), 'x');
    await new Promise(r => setTimeout(r, 150));   // let fs.watch schedule the 900ms ingest
    w.stop();
    assert.equal(w._timers.size, 0, 'pending timers must be cleared on stop');
    await new Promise(r => setTimeout(r, 1100));
    assert.equal(ingested, 0, 'nothing may be ingested after stop()');
});

test('the watcher hands a hostile filename to the tab as ONE quoted argument, in order', async () => {
    const dir = path.join(TMP, 'photos-quote');
    fs.mkdirSync(dir, { recursive: true });
    const { store, writes } = fakeStore([2], 2);
    voice.saveConfig({ ...voice.loadConfig(), vision: { ...voice.loadConfig().vision, targetTab: 2, prompt: 'describe' } });
    const w = new voice.VisionWatcher(store);
    assert.equal(w.start(dir).ok, true);
    fs.writeFileSync(path.join(dir, 'a;touch pwn.png'), 'x');
    await new Promise(r => setTimeout(r, 40));
    fs.writeFileSync(path.join(dir, 'b$(id).png'), 'x');
    await new Promise(r => setTimeout(r, 1500));
    w.stop();
    const lines = writes.map(([, d]) => d);
    // Each path single-quoted, then its own Enter — never "A B \r \r".
    assert.deepEqual(lines, [
        `'${path.join(dir, 'a;touch pwn.png')}' describe`, '\r',
        `'${path.join(dir, 'b$(id).png')}' describe`, '\r',
    ]);
    assert.equal(voice.shellQuote('/plain/path.jpg'), '/plain/path.jpg');
    assert.equal(voice.shellQuote("it's here.jpg"), "'it'\\''s here.jpg'");
});

test('the vision route refuses foreign browsers before auth, and follows the live allowlist', async () => {
    const express = require('express');
    const http = require('node:http');
    const { store, writes } = fakeStore([5], 5);
    const allowed = ['https://www.s0a.app'];
    let authed = 0;
    const app = express();
    voice.mount(app, (req, res, next) => { authed++; req.session = { tabMgr: { order: [] } }; next(); }, store, { allowedOrigins: allowed });
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, r));
    const port = srv.address().port;
    const post = (headers) => new Promise((resolve) => {
        const before = writes.length;
        const req = http.request({ port, path: '/api/voice/vision?prompt=look', method: 'POST', headers }, (res) => {
            res.resume(); res.on('end', () => setTimeout(() => resolve({ status: res.statusCode, typed: writes.length - before }), 150));
        });
        req.end(Buffer.from([0xff, 0xd8, 1, 2]));
    });
    try {
        for (const [headers, want] of [
            [{ 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' }, 403],
            [{ 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:9' }, 403],
            [{ origin: 'https://evil.example' }, 403],
            [{}, 200],
            [{ 'sec-fetch-site': 'same-origin' }, 200],
            [{ 'sec-fetch-site': 'none' }, 200],
            [{ origin: 'https://www.s0a.app' }, 200],
        ]) {
            const r = await post(headers);
            assert.equal(r.status, want, JSON.stringify(headers));
            assert.equal(r.typed > 0, want === 200, 'typed only on 200: ' + JSON.stringify(headers));
        }
        // A refused request never reached requireAuthed (no session provisioned).
        const before = authed;
        assert.equal((await post({ 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' })).status, 403);
        assert.equal(authed, before, 'gate must run before auth');
        // index.js pushes the tunnel origin onto the SAME array after mount.
        assert.equal((await post({ origin: 'https://abc.trycloudflare.com' })).status, 403);
        allowed.push('https://abc.trycloudflare.com');
        assert.equal((await post({ origin: 'https://abc.trycloudflare.com' })).status, 200, 'live allowlist, not a snapshot');
    } finally {
        srv.close();
    }
});

test('expandHome expands only a leading tilde', () => {
    assert.equal(voice.expandHome('~/Pictures'), path.join(os.homedir(), 'Pictures'));
    assert.equal(voice.expandHome('/abs/path'), '/abs/path');
});

// ── app control registry ────────────────────────────────────────────────
// Voice reaching the whole app (views, sidebar, theme, tabs, sound) rests on
// a phrase table. Two failure modes matter: a phrase that matches nothing
// (the control is unreachable by voice) and a phrase that matches too eagerly
// (voice yanks the user's view mid-sentence). Both are asserted.

const actions = require('../../web/public/assets/voice-actions.js');
global.matchVoiceAction = actions.matchVoiceAction;

test('every registry action is reachable by at least one of its own phrases', () => {
    for (const a of actions.VOICE_ACTIONS) {
        for (const phrase of a.phrases) {
            const hit = actions.matchVoiceAction(phrase);
            assert.ok(hit, `"${phrase}" matches nothing`);
            assert.equal(hit.action.id, a.id, `"${phrase}" → ${hit.action.id}, expected ${a.id}`);
        }
    }
});

test('every registry action can actually do something', () => {
    for (const a of actions.VOICE_ACTIONS) {
        assert.ok(a.click || typeof a.run === 'function', a.id + ' has neither click nor run');
        assert.ok(a.label && a.group, a.id + ' is missing a label or group');
    }
});

test('action ids are unique', () => {
    const ids = actions.VOICE_ACTIONS.map(a => a.id);
    assert.equal(new Set(ids).size, ids.length);
});

test('the registry does not fire on ordinary speech', () => {
    for (const said of [
        'the build is green',
        'I think we should refactor this',
        'what time is it',
        'can you look at the logs',
    ]) {
        assert.equal(actions.matchVoiceAction(said), null, said + ' must not trigger a control');
    }
});

test('terminal commands still beat app controls in the parser cascade', () => {
    const v = newVoice();
    // "fleet" is a registry phrase AND part of the fleet_status intent; the
    // terminal-facing reading has to win, and "stop" must never become an
    // app action.
    assert.equal(v._parseCommand('how are the agents').intent, 'fleet_status');
    assert.equal(v._parseCommand('stop').intent, 'interrupt');
    assert.equal(v._parseCommand('next tab').intent, 'next_tab');
    // ...but a pure app phrase does reach the registry.
    const p = v._parseCommand('hide the sidebar');
    assert.equal(p.intent, 'app_action');
    assert.equal(p.params.actionId, 'toggle_sidebar');
});

test('app controls resolve to real intents end to end', () => {
    const v = newVoice();
    const cases = [
        ['dark mode', 'toggle_theme'],
        ['open settings', 'open_settings'],
        ['time machine', 'time_machine'],
        ['restore the fleet', 'restore_fleet'],
        ['mute the sound', 'toggle_sound'],
        ['bigger text', 'bigger_text'],
        ['reopen the tab', 'restore_tab'],
    ];
    for (const [said, id] of cases) {
        const p = v._parseCommand(said);
        assert.equal(p.intent, 'app_action', said);
        assert.equal(p.params.actionId, id, said);
    }
});

test('the action menu handed to the model lists every id', () => {
    const menu = actions.voiceActionMenu();
    assert.equal(menu.length, actions.VOICE_ACTIONS.length);
    for (const a of actions.VOICE_ACTIONS) {
        assert.ok(menu.some(line => line.startsWith(a.id + ':')), a.id + ' missing from the menu');
    }
});

// ── mobile QR pairing ───────────────────────────────────────────────────
// The phone re-pairs by scanning the desktop QR in-app. Everything downstream
// depends on pulling the right token, origin and failover hint out of whatever
// string the camera read — including QRs older builds generated.

test('parsePairingPayload handles every QR shape the app has produced', async () => {
    const { parsePairingPayload } = await import('../../web/public/m/qrscan.js');

    const q = parsePairingPayload('https://x.trycloudflare.com/m/?t=abc123');
    assert.equal(q.token, 'abc123');
    assert.equal(q.origin, 'https://x.trycloudflare.com');

    // Token in the hash, plus the LAN/tunnel failover hint.
    const h = parsePairingPayload('https://x.example/m/#t=tok9&alt=https://192.168.1.4:4010');
    assert.equal(h.token, 'tok9');
    assert.equal(h.altOrigin, 'https://192.168.1.4:4010');

    // A QR pointing at the desktop root still lands on the mobile app.
    const root = parsePairingPayload('https://x.example/?t=zz');
    assert.match(root.url, /\/m\/\?t=zz$/);

    // A separate backend origin must survive — losing it strands the phone.
    const b = parsePairingPayload('https://front.example/m/?t=k1&backend=https://api.example');
    assert.equal(b.backend, 'https://api.example');

    // A bare host is a reasonable thing to put in a QR.
    const bare = parsePairingPayload('192.168.1.4:4010');
    assert.equal(bare.origin, 'https://192.168.1.4:4010');
});

test('parsePairingPayload rejects junk instead of half-connecting', async () => {
    const { parsePairingPayload } = await import('../../web/public/m/qrscan.js');
    for (const junk of ['', '   ', 'WIFI:S=home;T=WPA;P=pw;;', 'just some text', 'ftp://x.example/m/?t=a']) {
        assert.equal(parsePairingPayload(junk), null, JSON.stringify(junk));
    }
});

test('a pairing QR with no token is reported as tokenless, not as junk', async () => {
    const { parsePairingPayload } = await import('../../web/public/m/qrscan.js');
    const p = parsePairingPayload('https://x.example/m/');
    assert.ok(p, 'a valid URL must still parse');
    assert.equal(p.token, '');
});
