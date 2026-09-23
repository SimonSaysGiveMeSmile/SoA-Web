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

test('a custom wake phrase replaces the default', () => {
    const v = newVoice();
    v.setWakeWord('yo computer');
    assert.equal(v._matchWake('yo computer read output'), 'read output');
    assert.equal(v._matchWake('hey anton read output'), null);
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
    assert.match(p, /\/Users\/x\/iPlan/);
    assert.match(p, /\/Users\/x\/other/);
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
