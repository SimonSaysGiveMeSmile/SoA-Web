/**
 * Voice control backend.
 *
 * The browser half of voice control (web/public/assets/voice-*.js) can do
 * speech recognition and speech synthesis on its own, but three things it
 * genuinely CANNOT do from a web page, and those are what lives here:
 *
 *   1. AUDIO ROUTING. `SpeechRecognition` takes no deviceId and
 *      `speechSynthesis` takes no sinkId — both follow the macOS *default*
 *      device, full stop. So "connect my Bluetooth headset from the UI" is not
 *      a web API call, it is a system call: list the CoreAudio devices and the
 *      paired Bluetooth radios, connect one, and set it as the default in/out.
 *      We shell out to `system_profiler` (always present) for the read side and
 *      to `blueutil` / `SwitchAudioSource` (brew, optional) for the write side,
 *      degrading to a copyable install hint when they're missing.
 *
 *   2. UNDERSTANDING. A regex parser handles "read output" but not "hey anton,
 *      hop over to the iPlan repo and help me finish the migration". The client
 *      tries its regex table first (zero latency, offline); anything it can't
 *      place comes here and a fast headless `claude -p --model haiku` turns the
 *      sentence into one of the intents in INTENTS below. Strict JSON out, hard
 *      timeout, and `{intent:'unknown'}` on any failure so the caller can fall
 *      back rather than hang.
 *
 *   3. VISION INGEST. Smart glasses (Meta Ray-Bans included) expose no camera
 *      API to a web page. What they DO is drop photos into a folder on this
 *      machine once the companion app syncs. So we watch a folder, and any new
 *      image lands in front of the agent as a file path typed into its tab —
 *      the same trick pasteImage.js uses for clipboard images. Phones and
 *      UVC-webcam glasses go the other way: the client captures a frame and
 *      POSTs the bytes to /api/voice/vision.
 */

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const { stateFile } = require('./stateDir');

// system_profiler/blueutil live in sbin dirs a launchd job doesn't inherit.
const SYS_PATH = '/usr/sbin:/sbin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin';
const ENV = { ...process.env, PATH: `${SYS_PATH}:${process.env.PATH || ''}` };

const VISION_DIR = stateFile('vision');
const CONFIG_FILE = stateFile('voice.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// The intent vocabulary. This is the CONTRACT between three parties: the
// client's regex parser (voice-control.js), the model prompt below, and the
// executor (voice-commands.js). Adding an intent means touching all three.
const INTENTS = [
    'read_output',        // {lines}      speak the tail of the active terminal
    'check_status',       // {}           is it working / erroring / idle
    'check_progress',     // {}           how far along is it
    'switch_tab',         // {tabId}      go to tab N
    'switch_project',     // {query}      go to the tab whose title/cwd matches
    'open_project',       // {query}      open a NEW tab on a project not open yet
    'next_tab',           // {}
    'prev_tab',           // {}
    'new_goal',           // {text}       give the agent a task, as a /goal
    'type_text',          // {text}       type without submitting
    'run_command',        // {command}    type + Enter
    'send_key',           // {key}        enter|tab|escape|up|down
    'interrupt',          // {}           Ctrl-C
    'clear_screen',       // {}
    'continue_session',   // {}
    'change_model',       // {model}      /model opus|sonnet|haiku|fable
    'usage_report',       // {scope}      speak spend from /api/claude-usage
    'fleet_status',       // {}           speak the fleet summary
    'capture_image',      // {source}     grab a frame from camera/glasses
    'set_verbosity',      // {level}      brief|detailed
    'sleep',              // {}           stop listening until the wake word
    'app_action',         // {actionId}   any dashboard control (see the client registry)
    'help',               // {}
];

// ── config ──────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
    wakeWord: 'hey anton',
    wakeMode: 'wake',          // 'wake' (require the phrase) | 'always'
    interpret: true,           // allow the headless-model fallback
    interpretModel: 'haiku',
    vision: {
        enabled: false,
        watchDir: '',          // e.g. ~/Pictures/Meta View
        targetTab: null,       // tab id to hand new photos to; null = active
        prompt: 'Look at this image and tell me what you see.',
    },
};

function loadConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return { ...DEFAULT_CONFIG, ...raw, vision: { ...DEFAULT_CONFIG.vision, ...(raw.vision || {}) } };
    } catch (_) {
        return { ...DEFAULT_CONFIG, vision: { ...DEFAULT_CONFIG.vision } };
    }
}

function saveConfig(cfg) {
    try {
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
        return true;
    } catch (_) { return false; }
}

// ── shell helpers ───────────────────────────────────────────────────────
function run(cmd, args, { timeout = 8000, input = null } = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = execFile(cmd, args, { timeout, env: ENV, maxBuffer: 8 * 1024 * 1024 },
                (err, stdout, stderr) => resolve({
                    ok: !err,
                    code: err ? (err.code == null ? -1 : err.code) : 0,
                    stdout: String(stdout || ''),
                    stderr: String(stderr || ''),
                }));
        } catch (e) {
            return resolve({ ok: false, code: -1, stdout: '', stderr: e.message });
        }
        if (input != null && child.stdin) {
            try { child.stdin.end(input); } catch (_) {}
        }
    });
}

function have(cmd) {
    return run('/usr/bin/which', [cmd], { timeout: 2000 }).then(r => r.ok && r.stdout.trim().length > 0);
}

// ── audio devices ───────────────────────────────────────────────────────
// system_profiler's CoreAudio dump. `coreaudio_device_transport` tells us
// bluetooth from built-in from virtual, which is what makes the headset
// findable without the user reading a raw device list.
const TRANSPORT = {
    coreaudio_device_type_bluetooth: 'bluetooth',
    coreaudio_device_type_builtin: 'builtin',
    coreaudio_device_type_usb: 'usb',
    coreaudio_device_type_virtual: 'virtual',
    coreaudio_device_type_hdmi: 'hdmi',
    coreaudio_device_type_displayport: 'displayport',
    coreaudio_device_type_airplay: 'airplay',
    coreaudio_device_type_aggregate: 'aggregate',
};

async function audioDevices() {
    const r = await run('system_profiler', ['SPAudioDataType', '-json'], { timeout: 12000 });
    if (!r.ok) return [];
    let items = [];
    try {
        const parsed = JSON.parse(r.stdout);
        for (const group of parsed.SPAudioDataType || []) {
            items = items.concat(group._items || []);
        }
    } catch (_) { return []; }

    return items.map((it) => {
        const transport = TRANSPORT[it.coreaudio_device_transport] || 'other';
        const inputs = Number(it.coreaudio_device_input || 0);
        const outputs = Number(it.coreaudio_device_output || 0);
        return {
            name: it._name,
            manufacturer: it.coreaudio_device_manufacturer || '',
            transport,
            bluetooth: transport === 'bluetooth',
            inputs, outputs,
            canInput: inputs > 0,
            canOutput: outputs > 0,
            sampleRate: Number(it.coreaudio_device_srate || 0) || null,
            defaultInput: it.coreaudio_default_audio_input_device === 'spaudio_yes',
            defaultOutput: it.coreaudio_default_audio_output_device === 'spaudio_yes',
            defaultSystem: it.coreaudio_default_audio_system_device === 'spaudio_yes',
        };
    });
}

// ── bluetooth ───────────────────────────────────────────────────────────
// SPBluetoothDataType nests each device as a single-key object under
// device_connected / device_not_connected, so flatten to {name, ...props}.
const AUDIO_MINOR = /headphone|headset|speaker|earpiece|audio|hands-?free|glasses|eyewear/i;

async function bluetoothDevices() {
    const r = await run('system_profiler', ['SPBluetoothDataType', '-json'], { timeout: 15000 });
    if (!r.ok) return { ok: false, devices: [], powered: null };
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (_) { return { ok: false, devices: [], powered: null }; }

    const out = [];
    let powered = null;
    for (const group of parsed.SPBluetoothDataType || []) {
        const props = group.controller_properties || {};
        if (props.controller_state) powered = props.controller_state === 'attrib_on';
        for (const [key, connected] of [['device_connected', true], ['device_not_connected', false]]) {
            for (const entry of group[key] || []) {
                for (const [name, d] of Object.entries(entry || {})) {
                    const minor = d.device_minorType || d.device_majorType || '';
                    out.push({
                        name,
                        address: d.device_address || '',
                        connected,
                        kind: minor,
                        // The audio flag is what the UI filters on so a paired
                        // TV/mouse doesn't clutter the headset picker.
                        audio: AUDIO_MINOR.test(minor) || AUDIO_MINOR.test(name),
                        battery: d.device_batteryLevelMain || d.device_batteryLevel || null,
                        vendorID: d.device_vendorID || '',
                        productID: d.device_productID || '',
                    });
                }
            }
        }
    }
    // Connected first, then audio devices, then the rest — the order the
    // picker wants to render in.
    out.sort((a, b) => (b.connected - a.connected) || (b.audio - a.audio) || a.name.localeCompare(b.name));
    return { ok: true, devices: out, powered };
}

async function tooling() {
    const [blue, sw] = await Promise.all([have('blueutil'), have('SwitchAudioSource')]);
    return {
        blueutil: blue,
        switchaudio: sw,
        // Everything the write side needs, in one copyable line.
        installHint: (blue && sw) ? null : 'brew install blueutil switchaudio-osx',
    };
}

// ── natural language → intent ───────────────────────────────────────────
const CLAUDE_BIN = process.env.SOA_VOICE_CLAUDE || 'claude';
const INTERPRET_TIMEOUT_MS = Number(process.env.SOA_VOICE_TIMEOUT_MS || 9000);

function buildPrompt(transcript, ctx) {
    // Names only. The model resolves "the iPlan project" to a NAME; the client
    // maps that name back to a tab or a path itself (voice-commands.js
    // bestMatch on title/basename). Absolute paths would leave the machine for
    // nothing — this prompt goes to the Anthropic API via `claude -p`.
    const tabs = (ctx.tabs || []).slice(0, 40)
        .map(t => {
            const proj = t.cwd ? path.basename(String(t.cwd)) : '';
            const title = String(t.title || proj);
            // A renamed tab keeps its project name in parentheses so "the
            // iPlan project" still resolves to an OPEN tab (switch, not open).
            const label = (proj && title !== proj && !title.includes('/')) ? `${title} (${proj})` : (title.includes('/') ? proj || title : title);
            return `  #${t.id} "${label}"${t.status ? ' [' + t.status + ']' : ''}`;
        })
        .join('\n');
    const projects = (ctx.projects || []).slice(0, 40).map(p => '  ' + path.basename(String(p))).join('\n');
    // The client owns the control registry (it is what executes them), so it
    // ships the menu with each request rather than the server keeping a second
    // copy that could drift out of sync.
    const controls = (ctx.controls || []).slice(0, 60).map(c => '  ' + c).join('\n');

    return `You translate ONE spoken sentence from a developer into a single terminal-control intent.
They are driving a multi-tab terminal ("Son of Anton") hands-free, each tab usually running a Claude Code agent.

Reply with ONE line of JSON and nothing else:
{"intent":"<intent>","params":{...},"say":"<=8 word confirmation to speak"}

Valid intents and their params:
${INTENTS.join(', ')}

Rules:
- switch_project {"query":"..."} when they name a project/repo that IS in the open tabs.
- open_project {"query":"..."} when they name one that is NOT open but IS in known projects.
- new_goal {"text":"..."} for any request to WORK on something ("help me build X", "take a look at
  the failing tests", "refactor the parser"). Put the full instruction in text, cleaned up, first person.
- run_command only for a literal shell command they dictated. Never invent one.
- change_model {"model":"opus"|"sonnet"|"haiku"|"fable"}.
- usage_report for spend/tokens/limits. fleet_status for "how are the agents doing".
- app_action {"actionId":"..."} for anything about the APP rather than the terminal — views,
  sidebar, theme, settings, tabs, sound, time machine. Use an id from the control list below, verbatim.
- unknown if it is chatter, not a command.

App controls (actionId: what it does):
${controls || '  (none)'}

Open tabs:
${tabs || '  (none)'}

Known projects:
${projects || '  (none)'}

Sentence: ${JSON.stringify(String(transcript || ''))}`;
}

function extractJson(text) {
    const s = String(text || '');
    // The model sometimes wraps in a fence or adds a trailing sentence; take
    // the first balanced object.
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (_) { return null; } } }
    }
    return null;
}

function interpret(transcript, ctx = {}, opts = {}) {
    const model = opts.model || loadConfig().interpretModel || 'haiku';
    return new Promise((resolve) => {
        let child;
        const done = (v) => { resolve(v); };
        try {
            child = spawn(CLAUDE_BIN, ['-p', '--model', model], {
                env: ENV, stdio: ['pipe', 'pipe', 'ignore'],
            });
        } catch (e) {
            return done({ intent: 'unknown', params: {}, source: 'error', error: e.message });
        }

        let out = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, INTERPRET_TIMEOUT_MS);

        // stdin/stdout are Sockets: a write that fails AFTER end() returns —
        // EPIPE when the timeout above SIGKILLs the child with the prompt still
        // queued past the 64KB pipe buffer — surfaces as an 'error' EVENT, not a
        // throw. Unhandled, that event is an uncaughtException that takes the
        // whole daemon (and every PTY it hosts) down. 'close' still settles us.
        child.stdin.on('error', () => {});
        child.stdout.on('error', () => {});
        child.stdout.on('data', (d) => { out += d; if (out.length > 64 * 1024) { try { child.kill('SIGKILL'); } catch (_) {} } });
        child.on('error', (e) => { clearTimeout(timer); done({ intent: 'unknown', params: {}, source: 'error', error: e.message }); });
        child.on('close', () => {
            clearTimeout(timer);
            const parsed = extractJson(out);
            if (!parsed || !INTENTS.includes(parsed.intent)) {
                return done({ intent: 'unknown', params: {}, source: 'model', raw: out.slice(0, 400) });
            }
            done({
                intent: parsed.intent,
                params: (parsed.params && typeof parsed.params === 'object') ? parsed.params : {},
                say: typeof parsed.say === 'string' ? parsed.say.slice(0, 120) : '',
                source: 'model',
            });
        });

        try { child.stdin.end(buildPrompt(transcript, ctx)); } catch (_) {}
    });
}

// ── project discovery ───────────────────────────────────────────────────
// "Go to the iPlan project" has to resolve to a path even when no tab is open
// on it. Claude Code already keeps one directory per project it has ever run
// in, so that list IS the user's project vocabulary.
function knownProjects(hours = 24 * 30) {
    try {
        const { latestSessionByCwd } = require('./claudeSessions');
        const map = latestSessionByCwd(hours);
        const dirs = [];
        for (const cwd of map.keys ? map.keys() : Object.keys(map)) {
            if (typeof cwd === 'string' && fs.existsSync(cwd)) dirs.push(cwd);
        }
        return dirs.sort();
    } catch (_) { return []; }
}

// ── vision ingest ───────────────────────────────────────────────────────
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif']);
const EXT_FOR_MIME = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic',
};

function pruneVision() {
    try {
        const now = Date.now();
        for (const f of fs.readdirSync(VISION_DIR)) {
            const p = path.join(VISION_DIR, f);
            try { if (now - fs.statSync(p).mtimeMs > MAX_AGE_MS) fs.unlinkSync(p); } catch (_) {}
        }
    } catch (_) {}
}

function saveImage(buf, mime) {
    const ext = EXT_FOR_MIME[String(mime || '').toLowerCase()] || 'png';
    fs.mkdirSync(VISION_DIR, { recursive: true });
    pruneVision();
    const name = `vision-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const full = path.join(VISION_DIR, name);
    fs.writeFileSync(full, buf);
    return { path: full, name, bytes: buf.length };
}

/**
 * Watch a folder for images and hand each new one to an agent.
 *
 * This is the Meta Ray-Ban path, and the reason it is a folder watch rather
 * than a device integration: the glasses have no public camera API. They sync
 * captures to the phone's Meta AI app, which (with iCloud Photos or a Finder
 * sync folder) lands the file on this Mac. Anything that puts an image in a
 * folder works identically — AirDrop, a UVC capture script, a Shortcut.
 */
class VisionWatcher {
    constructor(sessions) {
        this.sessions = sessions;
        this.watcher = null;
        this.dir = '';
        this.seen = new Set();
        this.lastIngest = null;
        this.onIngest = null;
        this._timers = new Set();   // pending 900ms ingests, cleared by stop()
    }

    stop() {
        if (this.watcher) { try { this.watcher.close(); } catch (_) {} }
        this.watcher = null;
        this.dir = '';
        this.seen.clear();
        // A photo that landed just before stop() must not be typed into a tab
        // 900ms later by a watcher the user turned off.
        for (const t of this._timers) clearTimeout(t);
        this._timers.clear();
    }

    start(dir) {
        this.stop();
        if (!dir) return { ok: false, error: 'no directory' };
        const abs = expandHome(dir);
        let st;
        try { st = fs.statSync(abs); } catch (_) { return { ok: false, error: 'directory not found: ' + abs }; }
        if (!st.isDirectory()) return { ok: false, error: 'not a directory: ' + abs };

        // Seed with what's already there so turning the watch on doesn't
        // replay the user's whole photo library into a terminal.
        try { for (const f of fs.readdirSync(abs)) this.seen.add(f); } catch (_) {}

        this.dir = abs;
        try {
            this.watcher = fs.watch(abs, { persistent: false }, (_ev, filename) => {
                if (!filename) return;
                if (this.seen.has(filename)) return;
                if (!IMAGE_EXT.has(path.extname(filename).toLowerCase())) return;
                this.seen.add(filename);
                // The name is untrusted — it is whatever dropped the file (a
                // download, an AirDrop, a sync). It ends up typed into a PTY, so
                // a newline in it would submit a second line. Refuse those.
                if (!isTypeSafe(filename)) { console.warn('[voice] vision: refused a filename with control bytes'); return; }
                // fs.watch fires on create, before the writer has finished.
                const t = setTimeout(() => { this._timers.delete(t); this._ingest(path.join(abs, filename)); }, 900);
                this._timers.add(t);
            });
        } catch (e) {
            return { ok: false, error: e.message };
        }
        return { ok: true, dir: abs };
    }

    _ingest(file) {
        let st;
        try { st = fs.statSync(file); } catch (_) { return; }
        if (!st.size) return;
        const cfg = loadConfig();
        this.lastIngest = { path: file, at: Date.now() };
        const tabId = cfg.vision.targetTab;
        const prompt = cfg.vision.prompt || 'Look at this image and tell me what you see.';
        if (!typeIntoTab(this.sessions, tabId, `${shellQuote(file)} ${prompt}`, true)) {
            console.warn(`[voice] vision: could not hand ${path.basename(file)} to a tab (no fleet session, or unsafe text)`);
        }
        if (this.onIngest) { try { this.onIngest(file); } catch (_) {} }
    }
}

// ── tab typing ──────────────────────────────────────────────────────────
// Shared with sessionManager's split-write trick: a glued CR reads as a pasted
// newline in Claude Code's TUI rather than a submit, so send Enter separately.
function expandHome(p) {
    const d = String(p || '');
    return d.startsWith('~') ? path.join(os.homedir(), d.slice(1)) : d;
}

// A path typed into a tab must survive a bare shell prompt as ONE literal
// argument: the tab is pty.spawn($SHELL), and Claude Code is only sometimes the
// foreground process. Same rule as the dashboard's _shellQuote (app.js): leave
// plain names alone, single-quote anything else, escaping embedded quotes.
function shellQuote(p) {
    const str = String(p);
    if (/^[\w@%+=:,./-]+$/.test(str)) return str;
    return "'" + str.replace(/'/g, "'\\''") + "'";
}

// Only single-line text may be typed: a CR/LF or any other control byte in
// the payload would be delivered to the PTY as a keystroke — a newline is an
// Enter, i.e. a second, unreviewed submission.
function isTypeSafe(text) {
    return typeof text === 'string' && !/[\x00-\x1f\x7f]/.test(text);
}

// The session that owns the fleet. SessionStore has no primary(); the same
// walk sessionManager.mount does — first session with at least one tab —
// preferring the caller's own session when a request is in hand.
function fleetSession(sessions, prefer) {
    if (prefer && prefer.tabMgr && prefer.tabMgr.order.length > 0) return prefer;
    const all = sessions && sessions.sessions;
    if (!all || typeof all.values !== 'function') return null;
    for (const s of all.values()) {
        if (s && s.tabMgr && s.tabMgr.order.length > 0) return s;
    }
    return null;
}

function typeIntoTab(sessions, tabId, text, submit, prefer) {
    try {
        if (!isTypeSafe(text)) return false;
        const s = fleetSession(sessions, prefer);
        const mgr = s && s.tabMgr;
        if (!mgr) return false;
        // A null tabId means "whatever the user is looking at": the session
        // tracks that as activeTab, falling back to the first tab in order.
        const id = (tabId == null || tabId === '')
            ? (s.activeTab && mgr.get(s.activeTab) ? s.activeTab : mgr.order[0])
            : Number(tabId);
        const tab = mgr.get(id);
        if (!tab || tab.exited) return false;
        // Through sessionManager's per-tab FIFO, not a bare timer: two hands to
        // the same tab inside the Enter delay (two photos 40ms apart, or a
        // manager /compact overlapping an ingest) otherwise glue into one
        // submitted line. That FIFO is the chokepoint every agent-driven
        // submit already routes through.
        const sm = require('./sessionManager');
        if (submit) sm.submitToTab(tab, text); else sm.writeToTab(tab, text);
        return true;
    } catch (_) { return false; }
}

// ── routes ──────────────────────────────────────────────────────────────
function mount(app, requireAuthed, sessions, opts = {}) {
    const json = express.json({ limit: '64kb' });
    // The caller's live array, not a snapshot: index.js pushes the tunnel's
    // origin onto ALLOWED_ORIGINS after mount (tunnel-up, SIGHUP re-adopt),
    // and this gate must agree with the CORS and WS gates then too.
    const allowedOrigins = Array.isArray(opts.allowedOrigins) ? opts.allowedOrigins : [];

    // POST /api/voice/vision takes a raw body, so a typed-array POST from any
    // page is a CORS "simple" request — no preflight, so index.js's Origin
    // allowlist never runs — and on loopback requireAuthed provisions an
    // anonymous session. The browser still labels the request; refuse unless
    // it says same-origin/none, or the Origin is one the daemon already
    // trusts (the same list the CORS and WS gates use), or there is no
    // browser at all (no Sec-Fetch-Site AND no Origin: curl, the CLI).
    function browserAllowed(req) {
        const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
        const origin = req.headers.origin;
        if (sfs === 'same-origin' || sfs === 'none') return true;
        if (origin && allowedOrigins.includes(origin)) return true;
        if (!sfs && !origin) return true;
        return false;
    }
    // First on the route: refusing here means a hostile page's POST never
    // provisions (and persists) a session, and never buffers a 30MB body.
    function refuseForeign(req, res, next) {
        if (browserAllowed(req)) return next();
        res.status(403).json({ ok: false, error: 'request origin not allowed' });
    }
    const watcher = new VisionWatcher(sessions);
    require('./voiceChat').mount(app, requireAuthed, browserAllowed);

    // Restore a configured watch on boot.
    const boot = loadConfig();
    if (boot.vision.enabled && boot.vision.watchDir) {
        try { watcher.start(boot.vision.watchDir); } catch (_) {}
    }

    // Config: wake word, modes, vision.
    app.get('/api/voice/config', requireAuthed, (req, res) => {
        res.json({ ok: true, config: loadConfig(), intents: INTENTS, watching: watcher.dir || null });
    });

    app.post('/api/voice/config', requireAuthed, json, (req, res) => {
        const cur = loadConfig();
        const b = req.body || {};
        const next = {
            ...cur,
            wakeWord: typeof b.wakeWord === 'string' && b.wakeWord.trim() ? b.wakeWord.trim().toLowerCase().slice(0, 40) : cur.wakeWord,
            wakeMode: (b.wakeMode === 'always' || b.wakeMode === 'wake') ? b.wakeMode : cur.wakeMode,
            interpret: typeof b.interpret === 'boolean' ? b.interpret : cur.interpret,
            interpretModel: typeof b.interpretModel === 'string' ? b.interpretModel.slice(0, 40) : cur.interpretModel,
            vision: { ...cur.vision, ...(b.vision && typeof b.vision === 'object' ? b.vision : {}) },
        };
        if (!saveConfig(next)) {
            return res.status(500).json({ ok: false, error: 'could not write ' + CONFIG_FILE });
        }

        // Apply the watch change immediately — a saved-but-inert setting is
        // the classic "I turned it on and nothing happened".
        let watch = { ok: true, dir: watcher.dir || null };
        if (next.vision.enabled && next.vision.watchDir) {
            // watcher.dir is stored expanded; compare the expanded form or a
            // '~/…' setting restarts the watch on every save.
            if (watcher.dir !== expandHome(next.vision.watchDir)) watch = watcher.start(next.vision.watchDir);
        } else if (watcher.dir) {
            // Disabled, OR enabled with the folder cleared: either way the old
            // folder must stop being watched.
            watcher.stop();
            watch = { ok: true, dir: null };
        }
        res.json({ ok: true, config: next, watch });
    });

    // ── audio ───────────────────────────────────────────────────────────
    app.get('/api/voice/audio', requireAuthed, async (req, res) => {
        const [devices, bt, tools] = await Promise.all([audioDevices(), bluetoothDevices(), tooling()]);
        res.json({
            ok: true,
            platform: process.platform,
            devices,
            bluetooth: bt.devices,
            bluetoothPowered: bt.powered,
            tools,
            defaults: {
                input: (devices.find(d => d.defaultInput) || {}).name || null,
                output: (devices.find(d => d.defaultOutput) || {}).name || null,
            },
        });
    });

    // Set the macOS default input/output. This is the switch that actually
    // moves speech recognition and synthesis onto the headset — the Web Speech
    // APIs have no device parameter of their own.
    app.post('/api/voice/audio/default', requireAuthed, json, async (req, res) => {
        const name = String((req.body || {}).name || '').trim();
        const kind = (req.body || {}).kind === 'input' ? 'input' : 'output';
        if (!name) return res.status(400).json({ ok: false, error: 'name required' });
        if (!(await have('SwitchAudioSource'))) {
            return res.status(501).json({
                ok: false, code: 'TOOL_MISSING', tool: 'SwitchAudioSource',
                error: 'SwitchAudioSource not installed',
                hint: 'brew install switchaudio-osx',
            });
        }
        const r = await run('SwitchAudioSource', ['-t', kind, '-s', name], { timeout: 6000 });
        if (!r.ok) return res.status(500).json({ ok: false, error: (r.stderr || r.stdout || 'switch failed').trim() });
        res.json({ ok: true, kind, name });
    });

    // Connect/disconnect a paired Bluetooth device.
    app.post('/api/voice/bluetooth', requireAuthed, json, async (req, res) => {
        const b = req.body || {};
        const address = String(b.address || '').trim();
        const action = b.action === 'disconnect' ? 'disconnect' : 'connect';
        if (!/^[0-9a-fA-F:-]{11,23}$/.test(address)) {
            return res.status(400).json({ ok: false, error: 'valid address required' });
        }
        if (!(await have('blueutil'))) {
            return res.status(501).json({
                ok: false, code: 'TOOL_MISSING', tool: 'blueutil',
                error: 'blueutil not installed',
                hint: 'brew install blueutil',
            });
        }
        const r = await run('blueutil', [`--${action}`, address], { timeout: 20000 });
        if (!r.ok) return res.status(500).json({ ok: false, error: (r.stderr || r.stdout || (action + ' failed')).trim() });
        // Give CoreAudio a beat to publish the new device before we re-read.
        await new Promise(r2 => setTimeout(r2, 1200));
        const devices = await audioDevices();
        res.json({ ok: true, action, address, devices });
    });

    // ── understanding ───────────────────────────────────────────────────
    app.post('/api/voice/interpret', requireAuthed, json, async (req, res) => {
        const cfg = loadConfig();
        const transcript = String((req.body || {}).transcript || '').trim();
        if (!transcript) return res.status(400).json({ ok: false, error: 'transcript required' });
        if (!cfg.interpret) return res.json({ ok: true, intent: 'unknown', params: {}, source: 'disabled' });
        const ctx = {
            tabs: Array.isArray((req.body || {}).tabs) ? req.body.tabs : [],
            controls: Array.isArray((req.body || {}).controls) ? req.body.controls : [],
            projects: knownProjects(),
        };
        const t0 = Date.now();
        const result = await interpret(transcript, ctx, { model: cfg.interpretModel });
        res.json({ ok: true, ...result, ms: Date.now() - t0, transcript });
    });

    app.get('/api/voice/projects', requireAuthed, (req, res) => {
        const dirs = knownProjects();
        res.json({
            ok: true,
            projects: dirs.map(d => ({ path: d, name: path.basename(d) })),
        });
    });

    // ── vision ──────────────────────────────────────────────────────────
    // Raw image bytes in, absolute path out (and optionally typed straight
    // into a tab so the agent looks at it without the user touching anything).
    app.post('/api/voice/vision', refuseForeign, requireAuthed,
        express.raw({ type: () => true, limit: '30mb' }),
        (req, res) => {
            try {
                const buf = req.body;
                if (!Buffer.isBuffer(buf) || !buf.length) {
                    return res.status(400).json({ ok: false, error: 'empty body' });
                }
                const ct = String(req.headers['content-type'] || 'image/jpeg').split(';')[0].trim().toLowerCase();
                if (!ct.startsWith('image/')) return res.status(415).json({ ok: false, error: 'not an image' });

                const saved = saveImage(buf, ct);
                const q = req.query || {};
                let typed = false;
                if (q.tab !== undefined || q.prompt !== undefined) {
                    // One line only — strip control bytes rather than let a
                    // crafted prompt carry an Enter into the terminal.
                    const prompt = String(q.prompt || loadConfig().vision.prompt || '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
                    const tabId = q.tab === '' || q.tab === undefined ? null : Number(q.tab);
                    typed = typeIntoTab(sessions, tabId, `${shellQuote(saved.path)}${prompt ? ' ' + prompt : ''}`, true, req.session);
                }
                res.json({ ok: true, ...saved, typed });
            } catch (err) {
                res.status(500).json({ ok: false, error: (err && err.message) || 'write failed' });
            }
        });

    app.get('/api/voice/vision/status', requireAuthed, (req, res) => {
        const cfg = loadConfig();
        res.json({
            ok: true,
            watching: watcher.dir || null,
            enabled: !!cfg.vision.enabled,
            lastIngest: watcher.lastIngest,
            // The folders a Meta/phone sync typically lands in, so the UI can
            // offer a pick list instead of asking for a path.
            suggestions: [
                path.join(os.homedir(), 'Pictures', 'Meta View'),
                path.join(os.homedir(), 'Pictures', 'Meta AI'),
                path.join(os.homedir(), 'Pictures', 'SoA Vision'),
                path.join(os.homedir(), 'Downloads'),
            ].filter(p => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }),
        });
    });

    return { watcher };
}

module.exports = {
    mount, INTENTS,
    // exported for tests
    audioDevices, bluetoothDevices, extractJson, buildPrompt,
    loadConfig, saveConfig, knownProjects, VisionWatcher, TRANSPORT,
    typeIntoTab, isTypeSafe, fleetSession, expandHome, shellQuote, interpret,
};
