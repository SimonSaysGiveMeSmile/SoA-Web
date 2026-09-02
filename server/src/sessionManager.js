/**
 * Session Manager — a server-side supervisor over ALL tabs in a session.
 *
 * Always-on: it runs in the daemon, independent of any connected client, so the
 * fleet is watched even when no phone or desktop is open. For every tab it:
 *   - classifies agent status from the live PTY stream (working / attention /
 *     done / idle),
 *   - tracks context % (best-effort from the stream; refined by client reports),
 *   - derives management signals: needs-attention, stuck, idle, high-context,
 *   - broadcasts a MANAGER snapshot to the session's clients (dashboard summary).
 *
 * It is also the data/action source for `soa-sessions`, the CLI a *manager agent*
 * (a dedicated Claude session with its own context) uses to read and act on every
 * other session — list them, read their recent output, send input, compact.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const { MSG, frame } = require('./protocol');
const envStore = require('./envStore');
const claudeSessions = require('./claudeSessions');
const codexSessions  = require('./codexSessions');
const sessionModel = require('./sessionModel');
const localKey = require('./localKey');
const entitlements = require('./entitlements');

// ── Manager config + pending resume schedules (persisted across restarts) ──
const { STATE_DIR } = require('./stateDir');
const MANAGER_FILE = path.join(STATE_DIR, 'manager.json');
// Optional hard override for the "manager may close inactive tabs" policy.
// SOA_MANAGER_CLOSE_INACTIVE=1 forces it ON, =0 forces OFF, unset → use the
// persisted manager.json value (which itself defaults OFF). Off by default.
const CLOSE_INACTIVE_ENV = process.env.SOA_MANAGER_CLOSE_INACTIVE == null
    ? null
    : /^(1|true|on|yes)$/i.test(String(process.env.SOA_MANAGER_CLOSE_INACTIVE));

function loadManagerState() {
    try {
        const d = JSON.parse(fs.readFileSync(MANAGER_FILE, 'utf8'));
        return {
            autoResume: d.autoResume === true,
            autoResumeText: typeof d.autoResumeText === 'string' && d.autoResumeText ? d.autoResumeText.slice(0, 200) : 'continue',
            // Whether the manager agent is allowed to CLOSE (stop) live/inactive
            // tabs. Default OFF — the manager never reaps a tab unless the user
            // explicitly opts in. Env override wins for headless/prod pinning.
            closeInactive: CLOSE_INACTIVE_ENV != null ? CLOSE_INACTIVE_ENV : (d.closeInactive === true),
            schedules: Array.isArray(d.schedules) ? d.schedules.filter(s => s && Number(s.at) > 0) : [],
            todos: Array.isArray(d.todos) ? d.todos.filter(x => x && typeof x.id === 'string' && typeof x.text === 'string').slice(0, 500) : [],
            // User-defined agent groups: manual overrides keyed by cwd
            // ({ "<cwd>": "<groupName>" }). Absent a match, a session's group is
            // auto-derived from its cwd (the project folder name). Keyed by cwd
            // because tab ids are reassigned on every daemon restart.
            groups: (d.groups && typeof d.groups === 'object' && !Array.isArray(d.groups)) ? d.groups : {},
            // Per-project lifecycle labels keyed by cwd ({ "<cwd>": "inactive"|"archive" }).
            // Absent → 'active' (the default). Keyed by cwd like groups so it survives
            // the tab-id reassignment every daemon restart / soa-restore-fleet respawn
            // brings. Non-active projects are skipped by cohort fan-outs + supervisors,
            // so the manager stops spending tokens (and the weekly quota) on them.
            lifecycles: (d.lifecycles && typeof d.lifecycles === 'object' && !Array.isArray(d.lifecycles)) ? d.lifecycles : {},
        };
    } catch (_) {
        return { autoResume: false, autoResumeText: 'continue', closeInactive: CLOSE_INACTIVE_ENV === true, schedules: [], todos: [], groups: {}, lifecycles: {} };
    }
}

// Auto-group name for a cwd = its project folder (basename). Pure + exported so
// snapshot(), resolveCohort tests, and the CLI all derive the same default.
function autoGroupFromCwd(cwd) {
    if (!cwd || typeof cwd !== 'string') return 'ungrouped';
    const base = path.basename(cwd.replace(/[\\/]+$/, ''));
    return base || 'ungrouped';
}
function saveManagerState(st) {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(MANAGER_FILE, JSON.stringify(st, null, 2), 'utf8');
    } catch (_) { /* best-effort */ }
}

// Next wall-clock occurrence of H:MM am/pm, as epoch ms (server-local time).
function nextOccurrence(h12, min, ampm, now = Date.now()) {
    let h = h12 % 12;
    if (/pm/i.test(ampm)) h += 12;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setTime(d.getTime() + 24 * 60 * 60 * 1000);
    return d.getTime();
}

// ── Usage-limit banners: Claude Code AND Codex CLI ────────────────────────────
// Claude Code (cli.js Rd()):
//   "You've hit your session limit · resets 9pm (America/Los_Angeles)"
//   >24h out: "… weekly limit · resets Sep 4, 6pm (…)" (year appended if it differs)
//   fast tier: "… fast limit · resets in 2h 15m"
// Codex CLI (tui):
//   "■ You've hit your usage limit. Upgrade to Plus to continue using Codex (…), or try
//    again at Sep 30th, 2026 3:09 AM."   ← wraps mid-sentence at the terminal width,
//   so every gap is \s+; "try again at" is the Codex tell, "resets" the Claude one.
//   Admin-managed: "You've hit your usage limit. To get more access now, send a request
//   to your admin" (no reset time — flagged limited, nothing to schedule).
const TIME_PHRASE = String.raw`(?:[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:\d{4},?\s+)?(?:at\s+)?)?\d{1,2}(?::\d{2})?\s*[AaPp]\.?[Mm]`;
const CLAUDE_LIMIT_RE = new RegExp(String.raw`hit your (?:[a-z-]+ ){0,2}limit\b[\s\S]{0,120}?resets\s+(in\s+(?:\d+\s*h(?:ours?)?\s*)?(?:\d+\s*m(?:in(?:ute)?s?)?)?|${TIME_PHRASE})`, 'ig');
const CODEX_LIMIT_RE  = new RegExp(String.raw`hit your usage limit\b[\s\S]{0,320}?try\s+again\s+at\s+(${TIME_PHRASE})`, 'ig');
const CODEX_LIMIT_NOTIME_RE = /hit your usage limit\.\s+To get more access/ig;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const H = 3600_000;

// "9pm" | "9:30pm" | "Sep 4, 6pm" | "Sep 30th, 2026 3:09 AM" | "in 2h 15m" → epoch ms (null if unparsable)
function parseResetTime(phrase, now = Date.now()) {
    const t = String(phrase || '').replace(/\s+/g, ' ').trim();
    let m;
    if ((m = t.match(/^in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i)) && (m[1] || m[2])) {
        return now + (+(m[1] || 0)) * H + (+(m[2] || 0)) * 60_000;
    }
    m = t.match(/^(?:([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]/);
    if (!m) return null;
    const h12 = +m[4], min = +(m[5] || 0), ampm = m[6].toLowerCase() === 'p' ? 'pm' : 'am';
    if (!m[1]) return nextOccurrence(h12, min, ampm, now);
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon == null) return null;
    let h = h12 % 12; if (ampm === 'pm') h += 12;
    const year = m[3] ? +m[3] : new Date(now).getFullYear();
    const d = new Date(year, mon, +m[2], h, min, 0, 0);
    if (!m[3] && d.getTime() < now - 12 * H) d.setFullYear(year + 1);   // undated month/day already past → next year
    return d.getTime();
}

function lastMatch(re, text) {
    re.lastIndex = 0;
    let m, last = null;
    while ((m = re.exec(text))) { last = m; if (!m[0].length) re.lastIndex++; }
    return last;
}

// Newest limit banner in the (ANSI-stripped) tail → { agent, resetAt, label } | null.
function detectLimit(plain, now = Date.now()) {
    const hits = [];
    const cx = lastMatch(CODEX_LIMIT_RE, plain);
    if (cx) hits.push({ agent: 'codex', idx: cx.index, resetAt: parseResetTime(cx[1], now), label: cx[0] });
    const cn = lastMatch(CODEX_LIMIT_NOTIME_RE, plain);
    if (cn) hits.push({ agent: 'codex', idx: cn.index, resetAt: null, label: cn[0] });
    const cl = lastMatch(CLAUDE_LIMIT_RE, plain);
    if (cl) hits.push({ agent: 'claude', idx: cl.index, resetAt: parseResetTime(cl[1], now), label: cl[0] });
    if (!hits.length) return null;
    hits.sort((a, b) => b.idx - a.idx);
    const h = hits[0];
    return { agent: h.agent, resetAt: h.resetAt, label: h.label.replace(/\s+/g, ' ').slice(0, 120) };
}

// A TUI keeps the banner on screen (and re-paints it into the stream) long after
// the reset it names has passed. Re-parsing "resets 9pm" at 9:02pm yields TOMORROW
// 9pm — which used to re-arm the auto-resume a day out and re-fire `limited`.
// `ref` is the current or most recently lifted limit for the tab.
function isStaleBanner(det, ref, now = Date.now()) {
    if (det.resetAt != null && det.resetAt <= now) return true;          // absolute time already behind us
    if (!ref) return false;
    if (det.resetAt == null) return ref.resetAt == null && ref.label === det.label;
    if (ref.resetAt != null && now >= ref.resetAt && now - ref.resetAt < 12 * H
        && Math.abs((det.resetAt - ref.resetAt) - 24 * H) < 2 * H) return true;   // same wall-clock, rolled to tomorrow
    return false;
}

// ── Which agent runs in a tab: Claude Code vs Codex CLI ───────────────────────
// Stream markers each TUI paints persistently; the marker nearest the end of the
// tail wins, so a tab that switches agents flips as soon as the new one draws.
const CODEX_MARKS = [
    /OpenAI Codex/, /using Codex\b/, /tell Codex what/i, /\bcodex resume\b/,
    /(?:^|\n)\s*›\s/m,                                                       // Codex composer prompt (U+203A)
    /\b(?:gpt-[\w.-]+|o[134](?:-[\w-]+)?|codex[\w.-]*)\s+(?:minimal|low|medium|high|xhigh)\s*·/i,   // "gpt-5.4-mini medium · ~/proj" status line
    /ctrl \+ t to view transcript/i, /Type "\/" for a list of supported commands/,
];
const CLAUDE_MARKS = [
    /(?:^|\n)\s*❯\s/m,                                                       // Claude Code composer prompt (U+276F)
    /bypass\s*permissions/i, /accept\s*edits\s*on/i, /plan\s*mode\s*on/i, /shift\s*\+?\s*tab\s*to\s*cycle/i, /⏵⏵/,
    /\bclaude-(?:opus|sonnet|haiku|fable|mythos)/i, /\/usage-credits/, /Claude Code/,
];
function lastIndexOfAny(marks, text) {
    let best = -1;
    for (const p of marks) {
        const re = new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g');
        const m = lastMatch(re, text);
        if (m && m.index > best) best = m.index;
    }
    return best;
}
function detectAgentKind(plain) {
    const cx = lastIndexOfAny(CODEX_MARKS, plain);
    const cl = lastIndexOfAny(CLAUDE_MARKS, plain);
    if (cx < 0 && cl < 0) return null;
    return cx > cl ? 'codex' : 'claude';
}
// Fallback when a tab has painted nothing yet (fresh shell after a restart):
// whichever agent's transcript for this cwd is newer.
function agentForCwd(cwd, hours = 72, maps = null) {
    if (!cwd) return null;
    let c = null, x = null;
    try { c = (maps && maps.claude ? maps.claude : claudeSessions.latestSessionByCwd(hours)).get(cwd); } catch (_) {}
    try { x = (maps && maps.codex ? maps.codex : codexSessions.latestSessionByCwd(hours)).get(cwd); } catch (_) {}
    if (x && (!c || x.mtime > c.mtime)) return 'codex';
    return c ? 'claude' : null;
}
function sessionMaps(hours = 72) {
    let claude = new Map(), codex = new Map();
    try { claude = claudeSessions.latestSessionByCwd(hours); } catch (_) {}
    try { codex = codexSessions.latestSessionByCwd(hours); } catch (_) {}
    return { claude, codex };
}
// The relaunch line for a tab's agent: resume its latest thread, else the most recent.
function resumeLineFor(agent, cwd, { model = '', coldFallback = false, maps = null } = {}) {
    const mm = maps || sessionMaps(72);
    if (agent === 'codex') {
        const hit = cwd ? mm.codex.get(cwd) : null;
        const flag = model ? ` -m ${model}` : '';
        const tail = coldFallback ? ` || codex${flag}` : '';
        return hit ? `codex resume ${hit.sessionId}${flag} || codex resume --last${flag}${tail}` : `codex resume --last${flag}${tail}`;
    }
    const hit = cwd ? mm.claude.get(cwd) : null;
    const flag = model ? ` --model ${model}` : '';
    const tail = coldFallback ? ` || claude${flag}` : '';
    return hit ? `claude --resume ${hit.sessionId}${flag} || claude --continue${flag}${tail}` : `claude --continue${flag}${tail}`;
}

// Prompts typed into a limited tab are REJECTED by the TUI ("… resets 9pm"); we
// capture them and replay them at the reset instead of a bare "continue".
const REJECT_WINDOW_MS = 20_000;       // a prompt committed this close before the banner IS the rejected one
const LIMIT_LIFT_GRACE_MS = 5 * 60_000; // drop the LIMITED flag this long after the reset
const QUEUE_CAP = 10;
// Control/meta commands are not work — never replay them.
const NO_REPLAY_RE = /^(?:continue|\/(?:usage-credits|usage|cost|status|help|login|logout|exit|quit|clear|new|compact|effort|model|resume|config|doctor|bug|keymap|theme|mcp|hooks|memory|init|review)\b)/i;

// ── Stream detectors (ported from web/public/m/agentDetect.js; keep in sync) ──
const WORKING = [
    /esc to interrupt/i,
    /\(esc\s+to\s+cancel\)/i,
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
    /✳/,
    /\b(?:Thinking|Pondering|Crafting|Running|Executing|Processing|Working|Reading|Writing|Editing|Searching|Fetching|Analyzing|Compiling|Installing|Building|Testing|Formatting|Linting|Deploying|Pushing|Pulling|Cloning|Downloading|Uploading|Generating|Updating|Checking|Scanning|Indexing|Resolving|Compacting|Streaming|Connecting|Loading|Preparing|Initializing|Starting|Applying|Committing|Merging|Rebasing|Diffing)\b[.…]/i,
];
// Attention = a genuine choice/permission prompt only. Kept NARROW so idle
// input-box placeholders ("Try …") and prose mentioning approve/confirm don't
// trip a false NEEDS-INPUT (mirrors the client detector in web/.../app.js).
const ATTENTION = [
    /❯\s*(?:Yes|No|Allow once|Allow always|Deny|Accept|Reject)\b/i,
    /❯\s*\d+\.\s*(?:Yes|No|Allow|Deny|Accept|Reject)/i,
    /─{10,}[\s\S]{0,200}☐/,
    /☐\s+\S+[\s\S]{0,300}❯\s+\d+\./,
    /Do you want to (?:proceed|continue|make this change|accept|create|run|overwrite|delete)/i,
    /\(y\/n\)/i, /\[Y\/n\]/i, /\(Y\)es\s*\/\s*\(N\)o/i,
    /Allow\s+(?:Read|Write|Edit|Bash|Execute|NotebookEdit|WebFetch|WebSearch|Agent|LSP|Monitor)\b/i,
    /\bPermission\s+(?:required|needed)\b/i,
    // Codex CLI approval modal ("Yes, proceed" / "No, and tell Codex what to do differently").
    /tell Codex what to do/i,
    /Would you like to (?:run|approve|allow)\b/i,
];
// done = agent finished its turn, idle at its input box, waiting for the user
// (orange). Whitespace-flexible (\s*) so modern Claude Code's cursor-positioned
// footer ("bypass permissions on" → "bypasspermissionson" after the strip) still
// matches — otherwise a waiting agent reads as a plain idle shell. Keep in sync
// with web/public/assets/app.js + web/public/m/agentDetect.js.
const DONE = [/╭─+╮/, /│\s*>\s*│/, /╰─+╯/, /│\s*>\s*$/m, /bypass\s*permissions\s*on/i, /accept\s*edits\s*on/i, /plan\s*mode\s*on/i, /shift\s*\+?\s*tab\s*to\s*cycle/i, /⏵⏵/,
    // Codex CLI idle: its "› " composer prompt + "<model> <reasoning> · <cwd>" status line
    // (without these a parked Codex tab stays 'working' forever and reads as STUCK).
    /(?:^|\n)\s*›\s/m, /\b(?:gpt-[\w.-]+|o[134](?:-[\w-]+)?|codex[\w.-]*)\s+(?:minimal|low|medium|high|xhigh)\s*·/i];
const SHELL_PROMPT = /(?:^|\n)[^\n]{0,80}?(?:[➜❯▶►»](?:\s|$)|[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+[^\n]*[$#%]\s*$)/m;

function strip(s) {
    return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b[()][AB012]/g, '');
}
function classifyAgent(recent, current) {
    const tail = strip(recent).slice(-600);
    if (WORKING.some(p => p.test(tail)))   return 'working';
    if (ATTENTION.some(p => p.test(tail))) return 'attention';
    if (DONE.some(p => p.test(tail)))      return 'done';
    if (SHELL_PROMPT.test(tail.slice(-200))) return (current && current !== 'idle') ? 'idle' : null;
    return null;
}

// Live-work markers: a spinner / "esc to interrupt" that Claude renders ONLY
// while a turn is actively running (unlike the input box + footer, which the
// modern TUI draws persistently even mid-work).
const WORK_LIVE = [/esc to interrupt/i, /\(esc\s+to\s+cancel\)/i, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, /✳/];

// A tab is "finished, idle at its input box" only when its recent output shows the
// DONE chrome AND NO live-work marker. Used to suppress a FALSE 'stuck': a finished
// agent can stay classified 'working' (a trailing gerund-verb status line outranks
// the box in classifyAgent), go silent, then trip 'stuck' after STUCK_MS though it's
// simply idle at its prompt. CRITICAL: the box+footer coexist with the spinner during
// active work, so the box ALONE is not "done" — requiring the absence of a live-work
// marker keeps a genuinely hung agent (frozen spinner still in view) detectable as stuck.
function looksDone(recent) {
    const tail = strip(recent || '').slice(-600);
    return DONE.some(p => p.test(tail)) && !WORK_LIVE.some(p => p.test(tail));
}
function extractCtxPct(text) {
    if (!text) return null;
    const clamp = n => Math.min(100, Math.max(0, Math.round(n)));
    const lines = strip(String(text)).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i];
        if (!t || t.indexOf('%') === -1) continue;
        let m;
        if ((m = t.match(/(\d{1,3})\s*%\s*context\s*used/i)))                  return clamp(+m[1]);
        if ((m = t.match(/context\s*used\s*[:\-]?\s*(\d{1,3})\s*%/i)))          return clamp(+m[1]);
        if ((m = t.match(/(\d{1,3})\s*%\s+(?:left\s+)?until\s+auto-?compact/i))) return clamp(100 - +m[1]);
        if ((m = t.match(/context\s+left\s*[:\-]?\s*(\d{1,3})\s*%/i)))          return clamp(100 - +m[1]);
        if ((m = t.match(/(\d{1,3})\s*%\s+context\s+(?:left|remaining)/i)))     return clamp(100 - +m[1]);
        if (/context/i.test(t) && (m = t.match(/[█▓▒░]\s*(\d{1,3})\s*%/)))      return clamp(+m[1]);
        if ((m = t.match(/[█▓▒░]{3,}\s*(\d{1,3})\s*%/)))                       return clamp(+m[1]);
        if ((m = t.match(/context[^%\d]{0,24}?(\d{1,3})\s*%/i)))               return clamp(+m[1]);
    }
    return null;
}
// Effort level from the Claude Code footer ("◉ xhigh · /effort" / "/effort
// ultracode") — the transcript carries the model but not the effort, so we read
// it off the same footer the status detector sees. Whitespace-flexible: the
// cursor-positioned footer strips to no spaces ("◉xhigh·/effort").
const EFFORT_LV = 'ultracode|xhigh|high|medium|low|minimal';
function extractEffort(text) {
    if (!text) return null;
    const t = strip(String(text)).slice(-1000);
    let m;
    if ((m = t.match(new RegExp('[◉●]\\s*(' + EFFORT_LV + ')\\b', 'i')))) return m[1].toLowerCase();
    if ((m = t.match(new RegExp('\\b(' + EFFORT_LV + ')\\b\\s*[·|]?\\s*/effort', 'i')))) return m[1].toLowerCase();
    if ((m = t.match(new RegExp('effort\\s*(?:level\\s*to\\s*)?[:·|]?\\s*(' + EFFORT_LV + ')\\b', 'i')))) return m[1].toLowerCase();
    return null;
}

// ── Reliable submit ─────────────────────────────────────────────────────────
// A glued "text\r" written into a Claude TUI in one chunk is intermittently
// swallowed as a *pasted* newline and never submits. Writing the text, then the
// Enter as a SEPARATE write a beat later, submits reliably. node-pty serializes
// writes per-PTY, so the ordering holds. This is the single chokepoint every
// agent-driven submit (send / compact / goal / broadcast / scheduled resume /
// claude launch) routes through.
const SUBMIT_DELAY_MS = Math.max(0, parseInt(process.env.SOA_WEB_SUBMIT_DELAY_MS || '90', 10) || 90);
// Per-tab FIFO so submit N's deferred '\r' lands before submit N+1's text.
// Without this, two submits to one tab inside the delay window interleave as
// "A B \r \r" (one garbled line) instead of "A \r B \r". WeakMap → entries drop
// when the Tab is GC'd; node-pty has no per-tab write lock of its own.
const _submitChain = new WeakMap();
function submitToTab(tab, text) {
    if (!tab) return;
    const prev = _submitChain.get(tab) || Promise.resolve();
    const next = prev.then(() => new Promise((resolve) => {
        try { tab.write(String(text)); } catch (_) { return resolve(); }
        const t = setTimeout(() => { try { tab.write('\r'); } catch (_) {} resolve(); }, SUBMIT_DELAY_MS);
        if (t.unref) t.unref();
    }));
    _submitChain.set(tab, next.catch(() => {}));
}

// Chain-aware raw write (NO trailing Enter). Shares the per-tab FIFO with
// submitToTab so a submit:false write ('say' / non-submit broadcast) can't land
// BETWEEN a pending submit's text and its deferred '\r' — which would glue them
// into one garbled auto-submitted line. Use for every agent-driven text write
// that must order against pending submits; raw interactive keystrokes stay direct.
function writeToTab(tab, text) {
    if (!tab) return;
    const prev = _submitChain.get(tab) || Promise.resolve();
    const next = prev.then(() => { try { tab.write(String(text)); } catch (_) {} });
    _submitChain.set(tab, next.catch(() => {}));
}

// Launch (or resume) a Claude agent in a freshly-spawned tab. Shared by the
// daemon's boot-restore auto-resume (index.js scheduleAutoResume) and the
// manager-agent `spawn` action so the resume-vs-fresh decision + reliable
// submit can never drift apart. When a recent transcript exists for the tab's
// cwd we resume it, falling back through --continue to a cold start; otherwise
// we cold-start. Returns the resumed sessionId (or null for a fresh start).
// coldFallback: append a bare `claude` if BOTH --resume and --continue fail.
// spawn wants this (cold-start a new agent); boot-restore does NOT — a bare
// `claude` there starts a FRESH session, losing pre-restart context AND
// poisoning future --continue (see feedback: never bare-claude after a restart),
// so index.js passes coldFallback:false to keep the original 2-step chain.
// agent: 'claude' | 'codex' | null (null → whichever agent's transcript for the
// cwd is newer, defaulting to claude). A Codex tab relaunches `codex resume`.
function launchClaude(tab, cwd, { resume = true, model = '', sessionId = null, coldFallback = true, agent = null } = {}) {
    const kind = agent || (tab && tab.agent) || agentForCwd(cwd) || 'claude';
    if (tab) tab.agent = kind;
    if (kind === 'codex') {
        let sid = sessionId;
        if (sid == null && resume && cwd) { try { const hit = codexSessions.latestSessionByCwd(72).get(cwd); if (hit) sid = hit.sessionId; } catch (_) {} }
        const flag = model ? ` -m ${model}` : '';
        const tail = coldFallback ? ` || codex${flag}` : '';
        const line = !resume ? `codex${flag}`
            : sid ? `codex resume ${sid}${flag} || codex resume --last${flag}${tail}`
            : `codex resume --last${flag}${tail}`;
        submitToTab(tab, line);
        return sid;
    }
    let sid = sessionId;
    if (sid == null && resume && cwd) {
        try { const hit = claudeSessions.latestSessionByCwd(72).get(cwd); if (hit) sid = hit.sessionId; }
        catch (_) { /* no resume → cold start */ }
    }
    const flag = model ? ` --model ${model}` : '';
    const tail = coldFallback ? ` || claude${flag}` : '';
    const line = sid
        ? `claude --resume ${sid}${flag} || claude --continue${flag}${tail}`
        : `claude${flag}`;
    submitToTab(tab, line);
    return sid;
}
// Resolved agent kind for a live tab: what the supervisor saw it paint, else the
// newest transcript for its cwd, else claude.
function agentKindFor(man, tab, maps = null) {
    if (!tab) return 'claude';
    const s = man && man.tabs ? man.tabs.get(tab.id) : null;
    if (s && s.agent) return s.agent;
    if (tab.agent) return tab.agent;
    return agentForCwd(tab.cwd, 72, maps) || 'claude';
}

// ── Loopback trust gate for /api/sessions (the ONLY auth on that surface) ──────
// CRITICAL: a request relayed through the public tunnel re-originates from
// localhost (cloudflared dials 127.0.0.1), so the socket peer is loopback even
// for an internet caller — making a naive socket-IP check trivially bypassable
// (remote fleet control / RCE). Forwarding headers (cf-connecting-ip /
// x-forwarded-for / x-real-ip / forwarded) are injected by the tunnel/any proxy
// and are ABSENT on a genuine local CLI call, so their presence means "not a true
// local caller". Fail closed. (Mirrors index.js's real-client-IP recovery.)
function isLocalRequest(req) {
    const h = (req && req.headers) || {};
    // POSITIVE proof first: the per-daemon secret injected into every spawned tab's
    // env (SOA_WEB_LOCAL_KEY) and echoed by the local CLIs. Robust to any proxy
    // header behavior and to a local reverse proxy in front of the daemon.
    if (localKey.matches(h['x-soa-local-key'])) return true;
    // Fallback for keyless callers (e.g. manual curl): a loopback socket AND no
    // tunnel/proxy forwarding header (which a tunneled internet caller always
    // carries — cloudflared dials localhost so the socket IP alone is not enough).
    if (h['cf-connecting-ip'] || h['x-forwarded-for'] || h['x-real-ip'] || h['forwarded']) return false;
    const ip = (req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

// Resolve a target selector → tab ids against a snapshot. Pure (exported for
// tests). number / numeric-string → that id if live; numeric array → those live
// ids; 'all' → every id; a known signal name → tabs with that flag. ANY unknown /
// empty / whitespace selector → [] — never an accidental fleet-wide fan-out.
function resolveCohort(snapshot, sel) {
    const byId = new Map(snapshot.sessions.map(x => [x.id, x]));
    if (Array.isArray(sel)) return sel.map(Number).filter(n => byId.has(n));
    const str = String(sel == null ? '' : sel).trim();
    if (typeof sel === 'number' || /^\d+$/.test(str)) {
        const n = Number(str);
        return byId.has(n) ? [n] : [];
    }
    if (str === 'all') return snapshot.sessions.map(x => x.id);
    // Static user-defined group: `group:<name>` → every session in that group.
    const gm = /^group:(.+)$/i.exec(str);
    if (gm) {
        const g = gm[1].trim();
        return g ? snapshot.sessions.filter(x => x.group === g).map(x => x.id) : [];
    }
    const flag = {
        working: x => x.status === 'working',
        attention: x => x.attention,
        stuck: x => x.stuck,
        idle: x => x.idle,
        done: x => x.status === 'done',
        highContext: x => x.highContext,
        limited: x => x.limited,
        // Lifecycle cohorts — target projects by their manager label.
        active: x => (x.lifecycle || 'active') === 'active',
        inactive: x => x.lifecycle === 'inactive',
        archive: x => x.lifecycle === 'archive',
    }[str];
    return flag ? snapshot.sessions.filter(flag).map(x => x.id) : [];
}

// Restrict a resolved id set to ACTIVE projects — the DEFAULT for cohort fan-outs
// (goal/btw/clear/resume/broadcast) so the manager never spends tokens (or the
// weekly quota) on inactive/archived projects. Left untouched — the caller's exact
// targets are honored — when the selector was explicit ids (a number or id array),
// an explicit lifecycle cohort ('active'/'inactive'/'archive'), or includeInactive
// was passed. `sel` is the ORIGINAL selector the caller sent (body.id / body.to).
function activeOnlyIds(sel, ids, snapshot, includeInactive) {
    if (includeInactive === true) return ids;
    if (Array.isArray(sel)) return ids;                                          // explicit id list
    const str = String(sel == null ? '' : sel).trim();
    if (/^\d+$/.test(str)) return ids;                                           // explicit single id
    if (str === 'active' || str === 'inactive' || str === 'archive') return ids; // explicit lifecycle cohort
    const byId = new Map(snapshot.sessions.map(x => [x.id, x]));
    return ids.filter(id => {
        const x = byId.get(id);
        return x && (x.lifecycle || 'active') === 'active';
    });
}

// Build a manager-event filter from {self, kinds}. Hides the caller's own tab (so
// a manager never wakes on its own output) and optionally restricts to kinds.
function makeEventFilter(body) {
    const self = body && body.self != null ? Number(body.self) : null;
    const kinds = body && Array.isArray(body.kinds) && body.kinds.length ? new Set(body.kinds.map(String)) : null;
    return (e) => (self == null || e.id !== self) && (!kinds || kinds.has(e.kind));
}

const STUCK_MS    = 4 * 60 * 1000;   // working but silent this long → stuck
const HIGH_CTX    = 80;              // context % considered "high"
const EVENT_CAP   = 500;             // depth of the in-memory manager event ring
// Per-process identity stamped on every watch/events reply. A daemon restart
// resets _seq to 0; a long-lived CLI watcher compares this epoch and re-baselines
// its dedup the instant it changes — so NO post-restart event is lost even when
// the new _seq has already climbed past the watcher's stale cursor (the "busy
// restart" gap a bare cursor>head check misses).
const BOOT_EPOCH  = `${process.pid}.${Date.now()}`;

class SessionManager {
    constructor(session) {
        this.session = session;
        this.tabs = new Map();       // tabId → state
        this.state = loadManagerState();   // {autoResume, autoResumeText, schedules, todos}
        if (!Array.isArray(this.state.todos)) this.state.todos = [];
        // ── Event ring: manager-agent triggers ──────────────────────────────
        // In-memory, monotonic, transient. Events are WAKEUPS, not history —
        // snapshot()/`list` is always ground truth. A daemon restart resets
        // _seq; the watch cursor logic self-heals (cursor > head → synthetic
        // 'daemon-restart' event → reconcile). Edge-triggered: one state change
        // = one event (no level spam).
        this._events = [];               // capped ring of emitted events
        this._seq = 0;                   // monotonic sequence (head)
        this._waiters = new Set();       // parked long-poll responders
        this._stuckEmitted = new Map();  // tabId → true once per stuck episode
        // Fire due resume schedules even when no client is connected.
        this._schedTimer = setInterval(() => this._fireDue(), 15_000);
        if (this._schedTimer.unref) this._schedTimer.unref();
    }

    _saveState() { saveManagerState(this.state); }

    // Resolved group for a cwd: manual override (manager.json) else cwd auto-group.
    _groupFor(cwd) {
        const overrides = this.state.groups || {};
        if (cwd && overrides[cwd]) return overrides[cwd];
        return autoGroupFromCwd(cwd);
    }

    // Set/clear a manual group override for a cwd. Empty group → revert to auto.
    setGroup(cwd, group) {
        if (!cwd) return null;
        if (!this.state.groups) this.state.groups = {};
        const g = (typeof group === 'string' ? group.trim() : '').slice(0, 40);
        if (g) this.state.groups[cwd] = g; else delete this.state.groups[cwd];
        this._saveState();
        return g || autoGroupFromCwd(cwd);
    }

    // Resolved lifecycle for a cwd: 'active' (default) | 'inactive' | 'archive'.
    // Keyed by cwd (like groups) so it survives the tab-id churn of every restart
    // and every soa-restore-fleet respawn. 'active' is implicit (no stored entry).
    _lifecycleFor(cwd) {
        const m = this.state.lifecycles || {};
        return (cwd && m[cwd]) || 'active';
    }

    // Set/clear a project's lifecycle label (keyed by cwd). Returns the resolved
    // value, or null if `lifecycle` is invalid. Storing 'active' (the default)
    // clears the entry so manager.json stays tidy — an absent cwd already reads
    // 'active'. Non-active projects are excluded from cohort fan-outs and the
    // always-on supervisors, throttling the manager's token spend on them.
    setLifecycle(cwd, lifecycle) {
        if (!cwd) return null;
        const lc = String(lifecycle == null ? '' : lifecycle).trim().toLowerCase();
        if (lc && lc !== 'active' && lc !== 'inactive' && lc !== 'archive') return null;
        if (!this.state.lifecycles) this.state.lifecycles = {};
        if (!lc || lc === 'active') delete this.state.lifecycles[cwd];
        else this.state.lifecycles[cwd] = lc;
        this._saveState();
        return lc || 'active';
    }

    // ── One-shot "send text to tab at time" schedules ──
    schedule(tabId, at, text, extra = {}) {
        const id = Math.random().toString(36).slice(2, 10);
        // Capture the cwd: tab ids are reassigned on a daemon restart, so cwd is
        // the only stable identity for resolving the target when the schedule fires.
        const tab = this.session.tabMgr && this.session.tabMgr.get(tabId);
        const cwd = tab && tab.cwd ? tab.cwd : null;
        // One pending auto/manual resume per tab — newest wins.
        this.state.schedules = this.state.schedules.filter(s => s.tabId !== tabId);
        this.state.schedules.push({
            id, tabId, cwd, at, text: String(text).slice(0, 500),
            auto: extra.auto === true,                 // armed by the limit detector (vs a manual `schedule`)
            agent: extra.agent || null,
            queued: Array.isArray(extra.queued) ? extra.queued.slice(-QUEUE_CAP) : [],   // rejected prompts to replay
        });
        this._saveState();
        return id;
    }

    unschedule(id) {
        const before = this.state.schedules.length;
        this.state.schedules = this.state.schedules.filter(s => s.id !== id);
        if (this.state.schedules.length !== before) this._saveState();
        return this.state.schedules.length !== before;
    }

    // ── Manager to-do store (persisted; surfaced in snapshot for the dashboard) ──
    addTodo(text, { source = 'manager', tab = null } = {}) {
        const todo = {
            id: 't' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
            text: String(text).slice(0, 400),
            done: false,
            createdAt: Date.now(),
            source: source === 'user' ? 'user' : 'manager',
            tab: tab == null ? null : Number(tab),
        };
        this.state.todos.push(todo);
        if (this.state.todos.length > 500) this.state.todos = this.state.todos.slice(-500);
        this._saveState();
        this.broadcast();
        return todo;
    }

    toggleTodo(id) {
        const t = this.state.todos.find(x => x.id === id);
        if (t) t.done = !t.done;
        this._saveState();
        this.broadcast();
        return this.state.todos;
    }

    delTodo(id) {
        this.state.todos = this.state.todos.filter(x => x.id !== id);
        this._saveState();
        this.broadcast();
        return this.state.todos;
    }

    _fireDue() {
        const now = Date.now();
        // Sweep: drop the LIMITED flag once the reset is comfortably behind us, or
        // when the tab has been genuinely working for a while (e.g. /usage-credits).
        for (const [tid, st] of this.tabs) {
            if (!st.limit) continue;
            if ((st.limit.resetAt != null && now >= st.limit.resetAt + LIMIT_LIFT_GRACE_MS)
                || (st.status === 'working' && now - st.lastStatusAt > 90_000)) this._liftLimit(tid, st, st.status === 'working' ? 'working' : 'reset');
        }
        const due = this.state.schedules.filter(s => s.at <= now);
        if (!due.length) return;
        this.state.schedules = this.state.schedules.filter(s => s.at > now);
        this._saveState();
        const mgr = this.session.tabMgr;
        if (!mgr) { this.broadcast(); return; }
        for (const s of due) {
            // Prefer the original tab id when it still maps to the SAME project
            // (live cwd unchanged) — the common no-restart case, and unambiguous
            // even when two tabs share a dir. Only when the id is gone OR now points
            // at a DIFFERENT cwd (ids are reassigned across a daemon restart) fall
            // back to a live tab whose cwd matches the one captured at schedule time.
            // If neither resolves cleanly, SKIP — a missed nudge is far safer than
            // firing a resume into the wrong agent.
            let tab = mgr.get(s.tabId);
            if (s.cwd && (!tab || tab.cwd !== s.cwd)) {
                tab = null;
                for (const tid of mgr.order) { const t = mgr.get(tid); if (t && t.cwd === s.cwd) { tab = t; break; } }
            }
            if (!tab) continue;
            // Replay the prompts the TUI rejected while limited (live queue first,
            // else the copy persisted on the schedule), otherwise the plain nudge.
            const st = this._state(tab.id);
            const live = st.limit && Array.isArray(st.limit.queued) ? st.limit.queued : [];
            const queued = live.length ? live : (Array.isArray(s.queued) ? s.queued : []);
            const lines = queued.length ? queued.slice() : [s.text || 'continue'];
            lines.forEach((line, i) => {
                const t = setTimeout(() => submitToTab(tab, line), i * 900);
                if (t.unref) t.unref();
            });
            console.log(`[sessions] resume fired → #${tab.id} "${tab.title}" (${s.agent || st.agent || 'agent'}): ${lines.length} line(s)${queued.length ? ' replayed' : ''}`);
            if (st.limit) this._liftLimit(tab.id, st, 'resume');
        }
        this.broadcast();
    }

    _state(id) {
        let s = this.tabs.get(id);
        if (!s) {
            s = { status: 'idle', ctxPct: null, recent: '', lastOutputAt: 0, lastStatusAt: 0, limit: null,
                  agent: null, limitPrev: null, inputLine: '', lastInput: null };
            this.tabs.set(id, s);
        }
        return s;
    }

    // Fed from the PTY stream for every tab (see index.js onData). This is the
    // chokepoint where status transitions are detected → the natural place to
    // emit edge-triggered manager events.
    feed(id, data) {
        const s = this._state(id);
        s.lastOutputAt = Date.now();
        s.recent = (s.recent + data).slice(-6000);
        const next = classifyAgent(s.recent, s.status);
        if (next && next !== s.status) {
            const prev = s.status;
            s.status = next; s.lastStatusAt = Date.now();
            // Real work after the reset → the limit is behind us. BEFORE the reset a
            // 'working' flash is just the rejected prompt's spinner ("Crunched for 0s"),
            // so keep the limit (and its replay queue); _fireDue's sweep lifts it if
            // the work genuinely persists (e.g. /usage-credits).
            if (next === 'working' && s.limit && s.limit.resetAt != null && Date.now() >= s.limit.resetAt) this._liftLimit(id, s, 'working');
            // Leaving 'working' re-arms the stuck latch for the next episode.
            if (next !== 'working') this._stuckEmitted.delete(id);
            this._emit(next, id, { from: prev, to: next, ctxPct: s.ctxPct });
        }
        const prevPct = s.ctxPct;
        const pct = extractCtxPct(s.recent);
        if (pct != null) s.ctxPct = pct;
        const eff = extractEffort(s.recent);
        if (eff) s.effort = eff;
        // Edge-trigger high-context only on the UPWARD crossing of the threshold
        // (was below/unknown, now at/above) so it fires once, not every chunk.
        if (s.ctxPct != null && (prevPct == null || prevPct < HIGH_CTX) && s.ctxPct >= HIGH_CTX) {
            this._emit('highContext', id, { ctxPct: s.ctxPct });
        }
        const plain = strip(s.recent).slice(-1500);
        // Which agent is painting this tab (Claude Code vs Codex CLI). Sticky:
        // the last known agent still names the right relaunch after it exits.
        const tab = this.session.tabMgr && this.session.tabMgr.get(id);
        if (s.agent == null && tab && tab.agent) s.agent = tab.agent;
        const kind = detectAgentKind(plain);
        if (kind && kind !== s.agent) { s.agent = kind; if (tab) tab.agent = kind; }
        // Usage-limit banner (either agent) → one `limited` episode per reset time,
        // a replay queue for the prompts the TUI rejects meanwhile, and an
        // automatic resume shortly after the reset.
        // A restored tab replays its pre-restart scrollback (seeded, ending in the
        // "context restored" marker) — a banner in there is history, not a live limit.
        const cut = plain.lastIndexOf('context restored from previous session');
        const det = detectLimit(cut >= 0 ? plain.slice(cut) : plain);
        if (det) {
            const now = Date.now();
            const cur = s.limit, prev = s.limitPrev;
            const same = l => l && l.agent === det.agent && l.resetAt === det.resetAt && (det.resetAt != null || l.label === det.label);
            if (same(cur)) { /* same episode, banner merely re-painted */ }
            else if (same(prev) && prev.liftedBy !== 'working' && !(prev.resetAt != null && now >= prev.resetAt)) {
                s.limit = prev; s.limitPrev = null;    // lifted too eagerly — restore silently (no re-emit, no re-arm)
            } else if (!isStaleBanner(det, cur || prev, now)) {
                s.limit = { agent: det.agent, resetAt: det.resetAt, label: det.label, at: now, queued: [] };
                s.limitPrev = null;
                if (det.agent && det.agent !== s.agent) { s.agent = det.agent; if (tab) tab.agent = det.agent; }
                // The prompt the user just submitted is what the banner rejected.
                if (s.lastInput && now - s.lastInput.at < REJECT_WINDOW_MS) this._queueForResume(id, s, s.lastInput.text);
                this._emit('limited', id, { detail: `${det.agent}: ${det.label}` });
                if (this.state.autoResume && det.resetAt != null) {
                    this.schedule(id, det.resetAt + 2 * 60_000, this.state.autoResumeText, { auto: true, agent: det.agent, queued: s.limit.queued });
                }
            }
        }
    }

    // Fed with every byte typed INTO a tab (keyboard, mobile line, manager
    // `send`/`goal`). Reassembles committed lines so that, while the tab is
    // limited, the rejected prompts are queued for replay at the reset.
    feedInput(id, data) {
        const s = this._state(id);
        const clean = String(data)
            .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '')   // CSI incl. bracketed-paste markers
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b\r/g, ' ')                    // shift+enter newline inside a prompt
            .replace(/\x1b[\s\S]/g, '');
        for (const ch of clean) {
            if (ch === '\r' || ch === '\n') { this._commitInputLine(id, s); continue; }
            if (ch === '\x7f' || ch === '\b') { s.inputLine = s.inputLine.slice(0, -1); continue; }
            if (ch === '\x03' || ch === '\x15') { s.inputLine = ''; continue; }   // ctrl-c / ctrl-u
            if (ch < ' ' && ch !== '\t') continue;
            s.inputLine = (s.inputLine + ch).slice(-4000);
        }
    }
    _commitInputLine(id, s) {
        const line = (s.inputLine || '').trim();
        s.inputLine = '';
        if (!line) return;
        s.lastInput = { text: line, at: Date.now() };
        if (s.limit && (s.limit.resetAt == null || Date.now() < s.limit.resetAt)) this._queueForResume(id, s, line);
    }
    _queueForResume(id, s, line) {
        if (!s.limit || !line || NO_REPLAY_RE.test(line)) return;
        const q = s.limit.queued || (s.limit.queued = []);
        if (q[q.length - 1] === line) return;
        q.push(line.slice(0, 2000));
        if (q.length > QUEUE_CAP) q.splice(0, q.length - QUEUE_CAP);
        // Mirror into the pending auto-resume so the replay survives a daemon restart.
        const sch = this.state.schedules.find(x => x.tabId === id && x.auto);
        if (sch) { sch.queued = q.slice(); this._saveState(); }
    }
    _liftLimit(id, s, by) {
        if (!s.limit) return;
        s.limitPrev = { ...s.limit, liftedAt: Date.now(), liftedBy: by || null };
        s.limit = null;
    }

    // ── Event ring internals ────────────────────────────────────────────────
    // Push an event, evict beyond the cap, then synchronously wake any parked
    // long-poll waiters whose filter now matches. Node's single thread means
    // total ordering with no lock. Returns the event.
    _emit(kind, id, extra = {}) {
        const mgr = this.session.tabMgr;
        const tab = mgr && mgr.get(id);
        const e = {
            seq: ++this._seq,
            ts: Date.now(),
            kind,
            id,
            title: (tab && tab.title) || (id ? `tab ${id}` : ''),
            from: extra.from != null ? extra.from : null,
            to: extra.to != null ? extra.to : null,
            ctxPct: extra.ctxPct != null ? extra.ctxPct : null,
            detail: extra.detail != null ? extra.detail : null,
        };
        this._events.push(e);
        if (this._events.length > EVENT_CAP) this._events.splice(0, this._events.length - EVENT_CAP);
        this._drainWaiters();
        return e;
    }

    _drainWaiters() {
        if (!this._waiters.size) return;
        for (const w of Array.from(this._waiters)) {
            let m = null;
            try { m = this._eventsSince(w.cursor, w.filter); } catch (_) { m = null; }
            if (m && m.events.length) {
                this._waiters.delete(w);
                clearTimeout(w.timer);
                w.resolve(m);
            }
        }
    }

    // Events strictly after `cursor` passing `filter`. `dropped` reports how
    // many seqs below the cursor were already evicted (so a long-asleep watcher
    // knows to reconcile via list). A cursor above head means the ring was reset
    // under the watcher (daemon restart) → one synthetic 'daemon-restart' event.
    // Returned cursor is always the current head: every event up to head has
    // been examined, so filtered-out events are never re-scanned next call.
    _eventsSince(cursor, filter) {
        const head = this._seq;
        if (cursor != null && cursor > head) {
            return {
                events: [{ seq: head, ts: Date.now(), kind: 'daemon-restart', id: 0, title: '', from: null, to: null, ctxPct: null, detail: 'event ring reset — reconcile via list' }],
                cursor: head, dropped: 0,
            };
        }
        const floor = this._events.length ? this._events[0].seq : head;
        let dropped = 0;
        if (cursor != null && cursor + 1 < floor) dropped = floor - 1 - cursor;
        const out = [];
        for (const e of this._events) {
            if (cursor != null && e.seq <= cursor) continue;
            if (filter && !filter(e)) continue;
            out.push(e);
        }
        return { events: out, cursor: head, dropped };
    }

    // Time-derived 'stuck' is not a feed transition — swept from the 3s tick.
    // One event per stuck episode via the latch (cleared when the tab leaves
    // 'working' in feed()).
    emitStuckSweep() {
        const mgr = this.session.tabMgr;
        if (!mgr) return;
        const now = Date.now();
        for (const id of mgr.order) {
            const s = this.tabs.get(id);
            if (!s) continue;
            const stuck = s.status === 'working' && s.lastOutputAt > 0 && (now - s.lastOutputAt) > STUCK_MS && !looksDone(s.recent);
            if (stuck && !this._stuckEmitted.get(id)) {
                this._stuckEmitted.set(id, true);
                this._emit('stuck', id, { ctxPct: s.ctxPct });
            } else if (!stuck) {
                // Output resumed (or left 'working') → re-arm so the NEXT stall
                // fires a fresh wakeup, even within one continuous 'working' run.
                // (lastOutputAt resets on every feed(), so !stuck flips back true
                // the first sweep after output resumes.) This makes the latch
                // episode-per-stall, not episode-per-working-run.
                this._stuckEmitted.delete(id);
            }
        }
    }

    // Called from the TabManager onExit path (index.js): emit a clean 'exited'
    // event with the tab's last status, then forget its state.
    noteExit(id) {
        const prev = this.tabs.get(id);
        this._emit('exited', id, { from: prev ? prev.status : null });
        this.forget(id);
    }

    // Clients (desktop/mobile) can report an authoritative ctx reading.
    reportCtx(id, pct) {
        if (Number.isFinite(pct)) this._state(id).ctxPct = Math.min(100, Math.max(0, Math.round(pct)));
    }

    forget(id) { this.tabs.delete(id); this._stuckEmitted.delete(id); }

    // Stop background timers + release parked waiters when the owning session is
    // destroyed (GC'd past idle TTL). Without this the 15s _schedTimer keeps
    // firing forever and its closure pins the whole SessionManager — the Session,
    // the tabs Map, the event ring — long after the session is gone.
    destroy() {
        if (this._schedTimer) { clearInterval(this._schedTimer); this._schedTimer = null; }
        for (const w of this._waiters) { try { clearTimeout(w.timer); } catch (_) {} }
        this._waiters.clear();
    }

    // Build the supervisor view of every live tab.
    snapshot() {
        const mgr = this.session.tabMgr;
        const order = mgr ? mgr.order : [];
        const now = Date.now();
        let managerTabId = null;
        let managerStatus = null;
        const sessions = order.map(id => {
            const tab = mgr.get(id);
            const s = this._state(id);
            if (managerTabId == null && tab && typeof tab.title === 'string' && tab.title.trim().toLowerCase() === 'manager') { managerTabId = id; managerStatus = s.status; }
            const stuck = s.status === 'working' && s.lastOutputAt > 0 && (now - s.lastOutputAt) > STUCK_MS && !looksDone(s.recent);
            // Match the schedule the way _fireDue resolves it (prefer the exact id
            // when its cwd still matches, else the cwd) so resumeAt shows on the tab
            // that will actually receive the nudge — even after a restart reassigned ids.
            const sched = this.state.schedules.find(x => x.tabId === id && (!x.cwd || (tab && x.cwd === tab.cwd)))
                || (tab ? this.state.schedules.find(x => {
                    // cwd fallback applies ONLY when the schedule's own tab is gone or
                    // reassigned (restart) — never to a live sibling sharing the cwd,
                    // which would falsely show RESUME@ on the unscheduled sibling.
                    if (!x.cwd || x.cwd !== tab.cwd) return false;
                    const orig = mgr.get(x.tabId);
                    return !orig || orig.cwd !== x.cwd;
                }) : undefined);
            return {
                id,
                title: (tab && tab.title) || `tab ${id}`,
                cwd: (tab && tab.cwd) || null,
                group: this._groupFor(tab && tab.cwd),
                // Manager-only lifecycle label (active|inactive|archive), keyed by
                // cwd. Cohort fan-outs + supervisors act on ACTIVE projects only.
                lifecycle: this._lifecycleFor(tab && tab.cwd),
                // Current model (raw id, e.g. "claude-opus-4-8"), read from the
                // live transcript so it tracks in-session /model switches. The
                // client renders it as a tier-colored badge on the tab/tile.
                model: sessionModel.modelFor(tab && tab.cwd),
                effort: s.effort || null,   // effort level from the /effort footer (all tabs, server-detected)
                status: s.status,
                ctxPct: s.ctxPct,
                attention: s.status === 'attention',
                idle: s.status === 'idle' || s.status === 'done',
                stuck,
                highContext: s.ctxPct != null && s.ctxPct >= HIGH_CTX,
                idleMs: s.lastOutputAt ? now - s.lastOutputAt : null,
                agent: s.agent || null,               // 'claude' | 'codex' | null (unknown / plain shell)
                limited: !!s.limit,
                limitResetAt: s.limit ? s.limit.resetAt : null,
                limitAgent: s.limit ? s.limit.agent : null,
                limitQueued: s.limit && Array.isArray(s.limit.queued) ? s.limit.queued.length : 0,
                resumeAt: sched ? sched.at : null,
            };
        });
        const counts = {
            total: sessions.length,
            working: sessions.filter(x => x.status === 'working').length,
            attention: sessions.filter(x => x.attention).length,
            stuck: sessions.filter(x => x.stuck).length,
            idle: sessions.filter(x => x.idle).length,
            highContext: sessions.filter(x => x.highContext).length,
            limited: sessions.filter(x => x.limited).length,
            codex: sessions.filter(x => x.agent === 'codex').length,
        };
        return {
            sessions, counts, ts: now,
            autoResume: this.state.autoResume,
            closeInactive: this.state.closeInactive === true,
            todos: this.state.todos,
            managerTabId,
            managerActive: managerTabId != null,
            managerStatus,
        };
    }

    broadcast() {
        try { this.session.send(frame(MSG.MANAGER, this.snapshot())); } catch (_) {}
    }
}

// Attach a manager to a session (idempotent).
function ensure(session) {
    if (!session._manager) session._manager = new SessionManager(session);
    return session._manager;
}

// ── soa-sessions backing API (loopback) + manager config ────────────────────
// Operates on the primary session's tabMgr so a manager agent in any tab can
// see and drive the whole fleet.
function mount(app, requireAuthed, sessions) {
    function primary() {
        for (const s of sessions.sessions.values()) {
            if (s.tabMgr && s.tabMgr.order.length > 0) return s;
        }
        return null;
    }
    // Loopback trust gate is module-level + tunnel-aware (see isLocalRequest).
    const isLoopback = isLocalRequest;
    // Premium gate: the whole manager surface is a paid feature. Every route
    // below is entitlement-gated so a free install can't reach it (403). See
    // entitlements.js — today per-install, per-user once accounts land.
    const gateManager = entitlements.requireEntitled('manager');

    // Read-only fleet view (authed; powers the dashboard too).
    // Authed config (the mobile Settings sheet) — same knobs as the loopback
    // 'config' action, but reachable from the phone over the tunnel.
    app.post('/api/manager/config', requireAuthed, gateManager, express.json({ limit: '8kb' }), (req, res) => {
        const s = (req.session && req.session.tabMgr) ? req.session : primary();
        if (!s) return res.status(503).json({ ok: false, error: 'no active session' });
        const man = ensure(s);
        const body = req.body || {};
        if (typeof body.autoResume === 'boolean') man.state.autoResume = body.autoResume;
        if (typeof body.closeInactive === 'boolean') man.state.closeInactive = body.closeInactive;
        if (typeof body.autoResumeText === 'string' && body.autoResumeText.trim()) {
            man.state.autoResumeText = body.autoResumeText.trim().slice(0, 200);
        }
        man._saveState();
        res.json({ ok: true, autoResume: man.state.autoResume, closeInactive: man.state.closeInactive === true, autoResumeText: man.state.autoResumeText });
    });

    // Authed manager to-do mutations (the desktop Manager view, over the tunnel).
    app.post('/api/manager/todo', requireAuthed, gateManager, express.json({ limit: '8kb' }), (req, res) => {
        const s = (req.session && req.session.tabMgr) ? req.session : primary();
        if (!s) return res.status(503).json({ ok: false, error: 'no active session' });
        const man = ensure(s);
        const body = req.body || {};
        const op = String(body.op || '');
        if (op === 'add') {
            if (!body.text || !String(body.text).trim()) return res.status(400).json({ ok: false, error: 'text required' });
            man.addTodo(String(body.text), { source: body.source, tab: body.tab });
        } else if (op === 'toggle') {
            man.toggleTodo(String(body.id || ''));
        } else if (op === 'del') {
            man.delTodo(String(body.id || ''));
        } else {
            return res.status(400).json({ ok: false, error: 'bad op — add|toggle|del' });
        }
        res.json({ ok: true, todos: man.state.todos });
    });

    app.get('/api/manager', requireAuthed, gateManager, (req, res) => {
        const s = req.session && req.session.tabMgr ? req.session : primary();
        if (!s) return res.json({ ok: true, sessions: [], counts: {} });
        res.json({ ok: true, ...ensure(s).snapshot() });
    });

    // Assign/clear an agent's group (authed → reachable from the dashboard and
    // the phone). Keyed by cwd; {id} is resolved to its cwd. Empty group reverts
    // that cwd to its auto (project-folder) group. Pushes a fresh snapshot so
    // every connected client re-renders immediately.
    app.post('/api/manager/group', requireAuthed, gateManager, express.json({ limit: '8kb' }), (req, res) => {
        const s = (req.session && req.session.tabMgr) ? req.session : primary();
        if (!s) return res.status(503).json({ ok: false, error: 'no active session' });
        const man = ensure(s);
        const body = req.body || {};
        let cwd = (typeof body.cwd === 'string' && body.cwd) ? body.cwd : null;
        if (!cwd && body.id != null) { const tab = s.tabMgr.get(Number(body.id)); if (tab) cwd = tab.cwd; }
        if (!cwd) return res.status(400).json({ ok: false, error: 'need id or cwd' });
        const group = man.setGroup(cwd, body.group);
        man.broadcast();
        res.json({ ok: true, cwd, group });
    });

    // Action surface for the manager agent (loopback only — same trust model as
    // /api/tts). The global express.json({limit:'16kb'}) in index.js runs first
    // and short-circuits any per-route parser, so 16kb is the real (ample) limit —
    // no misleading per-route override here.
    app.post('/api/sessions', (req, res) => {
        if (!isLoopback(req)) return res.status(403).json({ ok: false, error: 'loopback only' });
        // Premium gate: even a loopback CLI caller (soa-sessions) needs the
        // manager entitlement. Keeps the paid surface off on free installs.
        if (!entitlements.isEnabled('manager', { req })) {
            return res.status(403).json({ ok: false, code: 'FEATURE_NOT_ENTITLED', feature: 'manager',
                error: 'Fleet Manager is not enabled for this install' });
        }
        const s = primary();
        if (!s || !s.tabMgr) return res.status(503).json({ ok: false, error: 'no active session' });
        const mgr = s.tabMgr;
        const man = ensure(s);
        const body = req.body || {};
        const action = String(body.action || '');
        // Cohort resolution + event filtering are module-level pure fns (tested).
        const resolveTargets = (sel) => resolveCohort(man.snapshot(), sel);
        const eventFilter = makeEventFilter;
        try {
            if (action === 'list') {
                return res.json({ ok: true, ...man.snapshot() });
            }
            if (action === 'read') {
                const id = Number(body.id);
                const tab = mgr.get(id);
                if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
                const n = Math.max(1, Math.min(400, Number(body.lines) || 80));
                const raw = strip(mgr.scrollback(id) || '');
                const tail = raw.split('\n').filter(l => l.trim()).slice(-n).join('\n');
                const st = man._state(id);
                return res.json({ ok: true, id, title: tab.title, status: st.status, ctxPct: st.ctxPct, text: tail });
            }
            if (action === 'send') {
                const id = Number(body.id);
                const tab = mgr.get(id);
                if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
                const text = String(body.text || '');
                const submit = body.submit !== false;   // default: press Enter
                if (submit) submitToTab(tab, text);      // reliable split-write
                else writeToTab(tab, text);              // FIFO-ordered, no Enter
                return res.json({ ok: true, id, sent: text.length, submitted: submit });
            }
            if (action === 'compact') {
                const id = Number(body.id);
                const tab = mgr.get(id);
                if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
                submitToTab(tab, '/compact');
                return res.json({ ok: true, id, compacted: true });
            }
            // schedule: queue text to be typed into tab(s) at a future time.
            // {action:'schedule', id|'all'|'limited', at: epochMs | '+Nm' | 'H:MM(am|pm)', text}
            if (action === 'schedule') {
                const text = String(body.text || 'continue');
                let at = null;
                const when = body.at;
                if (typeof when === 'number' && when > 0) at = when;
                else if (typeof when === 'string') {
                    let m;
                    if ((m = when.match(/^\+(\d+)m$/i))) at = Date.now() + (+m[1]) * 60_000;
                    else if ((m = when.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i))) at = nextOccurrence(+m[1], +(m[2] || 0), m[3]);
                }
                if (!at) return res.status(400).json({ ok: false, error: 'bad time — use epochMs, "+15m", or "2:30am"' });
                const self = body.self != null ? Number(body.self) : null;
                let targets;
                if (body.id === 'all') targets = mgr.order.slice();
                else if (body.id === 'limited') targets = mgr.order.filter(tid => man._state(tid).limit);
                else {
                    const id = Number(body.id);
                    if (self != null && id === self) return res.status(400).json({ ok: false, error: 'refusing to schedule into your own tab' });
                    if (!mgr.get(id)) return res.status(404).json({ ok: false, error: 'tab not found' });
                    targets = [id];
                }
                // For a cohort ('all'/'limited') silently exclude self — schedule the
                // rest of the fleet, just never a self-nudge into the manager's own tab.
                if (self != null) targets = targets.filter(tid => tid !== self);
                const scheduled = targets.map(tid => ({ tabId: tid, scheduleId: man.schedule(tid, at, text) }));
                return res.json({ ok: true, at, text, scheduled });
            }
            if (action === 'schedules') {
                return res.json({ ok: true, autoResume: man.state.autoResume, schedules: man.state.schedules });
            }
            if (action === 'unschedule') {
                return res.json({ ok: man.unschedule(String(body.scheduleId || '')) });
            }
            // config: {action:'config', autoResume?:bool, closeInactive?:bool, autoResumeText?:string}
            if (action === 'config') {
                if (typeof body.autoResume === 'boolean') man.state.autoResume = body.autoResume;
                if (typeof body.closeInactive === 'boolean') man.state.closeInactive = body.closeInactive;
                if (typeof body.autoResumeText === 'string' && body.autoResumeText.trim()) {
                    man.state.autoResumeText = body.autoResumeText.trim().slice(0, 200);
                }
                man._saveState();
                return res.json({ ok: true, autoResume: man.state.autoResume, closeInactive: man.state.closeInactive === true, autoResumeText: man.state.autoResumeText });
            }

            // ── Manager to-do store ─────────────────────────────────────────
            if (action === 'todos') {
                return res.json({ ok: true, todos: man.state.todos });
            }
            if (action === 'todo-add') {
                if (!body.text || !String(body.text).trim()) return res.status(400).json({ ok: false, error: 'text required' });
                const todo = man.addTodo(String(body.text), { source: body.source, tab: body.tab });
                return res.json({ ok: true, todo });
            }
            if (action === 'todo-toggle') {
                return res.json({ ok: true, todos: man.toggleTodo(String(body.id || '')) });
            }
            if (action === 'todo-del') {
                return res.json({ ok: true, todos: man.delTodo(String(body.id || '')) });
            }

            // ── Manager-agent: event triggers ───────────────────────────────
            // watch: BLOCKING long-poll. Returns matching events with seq>cursor
            // immediately, else parks the response until one is emitted or the
            // (clamped) timeout fires a heartbeat. First call with no cursor →
            // start from 'now' (no replay storm); pass cursor:0 to drain backlog.
            if (action === 'watch') {
                const cursor = (body.cursor === undefined || body.cursor === null) ? null : Number(body.cursor);
                const filter = eventFilter(body);
                if (cursor == null) {
                    return res.json({ ok: true, epoch: BOOT_EPOCH, cursor: man._seq, events: [], dropped: 0, timedOut: false, now: Date.now() });
                }
                const immediate = man._eventsSince(cursor, filter);
                if (immediate.events.length) {
                    return res.json({ ok: true, epoch: BOOT_EPOCH, cursor: immediate.cursor, events: immediate.events, dropped: immediate.dropped, timedOut: false, now: Date.now() });
                }
                let timeoutMs = Number(body.timeoutMs);
                if (!Number.isFinite(timeoutMs)) timeoutMs = 25000;
                timeoutMs = Math.max(1000, Math.min(55000, timeoutMs));
                const waiter = {
                    cursor, filter, timer: null,
                    resolve: (m) => { if (res.headersSent) return; res.json({ ok: true, epoch: BOOT_EPOCH, cursor: m.cursor, events: m.events, dropped: m.dropped, timedOut: false, now: Date.now() }); },
                };
                waiter.timer = setTimeout(() => {
                    man._waiters.delete(waiter);
                    if (res.headersSent) return;
                    res.json({ ok: true, epoch: BOOT_EPOCH, cursor, events: [], dropped: 0, timedOut: true, now: Date.now() });
                }, timeoutMs);
                if (waiter.timer.unref) waiter.timer.unref();
                res.on('close', () => { man._waiters.delete(waiter); clearTimeout(waiter.timer); });
                man._waiters.add(waiter);
                return; // response deferred (long-poll)
            }
            // events: NON-blocking instant drain (startup reconciliation).
            if (action === 'events') {
                const since = body.since != null ? Number(body.since) : null;
                const r = man._eventsSince(since, eventFilter(body));
                let events = r.events;
                const limit = Math.max(1, Math.min(500, Number(body.limit) || 500));
                if (events.length > limit) events = events.slice(-limit);
                return res.json({ ok: true, epoch: BOOT_EPOCH, cursor: r.cursor, events, dropped: r.dropped, now: Date.now() });
            }
            // whoami: identity probe for bootstrap — echoes the caller's own tab.
            if (action === 'whoami') {
                const self = body.self != null ? Number(body.self) : null;
                let title = null, status = null;
                if (self != null) {
                    const tab = mgr.get(self);
                    if (tab) { title = tab.title; status = man._state(self).status; }
                }
                return res.json({ ok: true, epoch: BOOT_EPOCH, self, title, status, cursor: man._seq });
            }

            // ── Manager-agent: mass / individual commands + Claude controls ──
            // goal: fan a desire/control out to one tab or a cohort. verb picks
            // the line: goal→/goal, btw→/btw, clear→/clear, continue/resume→
            // claude relaunch, raw→verbatim. Excludes the caller's own tab.
            if (action === 'goal') {
                const self = body.self != null ? Number(body.self) : null;
                const verb = String(body.verb || 'goal');
                const text = String(body.text || '');
                let ids = resolveTargets(body.id);
                // Cohort fan-outs skip non-active projects by default (token/quota
                // guard). Explicit ids + `active`/`inactive`/`archive` cohorts, or
                // includeInactive:true, bypass the filter.
                ids = activeOnlyIds(body.id, ids, man.snapshot(), body.includeInactive);
                if (self != null) ids = ids.filter(x => x !== self);
                const maps = (verb === 'continue' || verb === 'resume') ? sessionMaps(72) : null;
                const buildLine = (tab) => {
                    const agent = agentKindFor(man, tab, maps);
                    switch (verb) {
                        case 'goal': return '/goal ' + text;
                        case 'btw': return agent === 'codex' ? text : '/btw ' + text;      // Codex has no /btw — a plain aside queues fine
                        case 'clear': return agent === 'codex' ? '/new' : '/clear';
                        case 'continue': return agent === 'codex' ? 'codex resume --last' : 'claude --continue';
                        case 'resume': return resumeLineFor(agent, tab.cwd, { maps });
                        case 'raw': default: return text;
                    }
                };
                const targets = [];
                ids.forEach((id, i) => {
                    const tab = mgr.get(id);
                    if (!tab || tab.exited) { targets.push({ id, ok: false, error: 'no live tab' }); return; }
                    const line = buildLine(tab);
                    const delay = i * 120; // stagger so N TUIs don't cold-start at once
                    if (delay) { const tm = setTimeout(() => submitToTab(tab, line), delay); if (tm.unref) tm.unref(); }
                    else submitToTab(tab, line);
                    targets.push({ id, line, ok: true });
                });
                return res.json({ ok: true, verb, count: targets.filter(t => t.ok).length, targets });
            }
            // broadcast: fleet-wide plain-text nudge to a cohort (excludes self).
            if (action === 'broadcast') {
                const self = body.self != null ? Number(body.self) : null;
                const text = String(body.text || '');
                const submit = body.submit !== false;
                let ids = resolveTargets(body.to);
                ids = activeOnlyIds(body.to, ids, man.snapshot(), body.includeInactive);
                if (self != null) ids = ids.filter(x => x !== self);
                const hit = [];
                ids.forEach((id, i) => {
                    const tab = mgr.get(id);
                    if (!tab || tab.exited) return;
                    const fire = () => { if (submit) submitToTab(tab, text); else writeToTab(tab, text); };
                    const delay = i * 120;
                    if (delay) { const tm = setTimeout(fire, delay); if (tm.unref) tm.unref(); } else fire();
                    hit.push(id);
                });
                return res.json({ ok: true, to: body.to, count: hit.length, ids: hit });
            }

            // ── Manager-agent: lifecycle ────────────────────────────────────
            // spawn: open a new tab and (optionally) cold-start/resume a Claude
            // agent in it, with the same env a human tab gets.
            if (action === 'spawn') {
                const cwd = (typeof body.cwd === 'string' && body.cwd && fs.existsSync(body.cwd)) ? body.cwd : undefined;
                const title = (typeof body.title === 'string' && body.title) ? body.title.slice(0, 64) : undefined;
                const wantClaude = body.claude !== false;
                const resume = body.resume !== false;
                const model = typeof body.model === 'string' ? body.model : '';
                const goalText = typeof body.goal === 'string' ? body.goal : '';
                const agent = body.agent === 'codex' ? 'codex' : body.agent === 'claude' ? 'claude' : null;
                let tab;
                try { tab = mgr.open({ title, cwd, env: envStore.getEnvForShell(), silent: false }); }
                catch (e) { return res.status(500).json({ ok: false, error: (e && e.message) || 'spawn failed' }); }
                // Optional: create the tab with a non-active lifecycle (soa-sessions
                // spawn --lifecycle …). Keyed by cwd, so it sticks across respawns.
                if (body.lifecycle && tab.cwd) man.setLifecycle(tab.cwd, body.lifecycle);
                if (wantClaude) {
                    const tm = setTimeout(() => {
                        try { launchClaude(tab, tab.cwd, { resume, model, agent }); } catch (_) {}
                        if (goalText) { const g = setTimeout(() => submitToTab(tab, '/goal ' + goalText), 3000); if (g.unref) g.unref(); }
                    }, 1200); // let the fresh shell print its prompt first
                    if (tm.unref) tm.unref();
                }
                man._emit('spawned', tab.id, { detail: cwd || null });
                return res.json({ ok: true, id: tab.id, title: tab.title, cwd: tab.cwd, agent: agent || tab.agent || null, claudeLaunched: wantClaude });
            }
            // stop: kill a tab/agent. Refuses the caller's own tab.
            if (action === 'stop') {
                const id = Number(body.id);
                const self = body.self != null ? Number(body.self) : null;
                if (self != null && id === self) return res.status(400).json({ ok: false, error: 'refusing to stop your own tab' });
                const tab = mgr.get(id);
                if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
                // Policy gate: by default the manager must NOT close inactive tabs.
                // Off unless the user opted in (closeInactive) or the caller passes
                // an explicit force:true for a genuinely dead/finished agent.
                if (!man.state.closeInactive && body.force !== true) {
                    return res.status(409).json({
                        ok: false, id, disabled: true,
                        error: 'manager tab-closing is disabled (closeInactive=off) — not closing inactive tabs; pass force:true to override',
                    });
                }
                const wasStatus = man._state(id).status;
                mgr.close(id); // onExit → noteExit() emits 'exited' + forgets
                return res.json({ ok: true, id, closed: true, wasStatus });
            }
            // interrupt: send Ctrl-C (no Enter) to unwedge a stuck agent.
            if (action === 'interrupt') {
                const id = Number(body.id);
                const tab = mgr.get(id);
                if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
                try { tab.write('\x03'); } catch (_) {}
                return res.json({ ok: true, id, interrupted: true });
            }
            // setGroup: assign/clear an agent's group (keyed by cwd). Lets the
            // manager agent organize the fleet; empty group reverts to auto.
            // {action:'setGroup', id?|cwd?, group: string|''}
            if (action === 'setGroup') {
                let cwd = (typeof body.cwd === 'string' && body.cwd) ? body.cwd : null;
                if (!cwd && body.id != null) { const tab = mgr.get(Number(body.id)); if (tab) cwd = tab.cwd; }
                if (!cwd) return res.status(400).json({ ok: false, error: 'need id or cwd' });
                const group = man.setGroup(cwd, body.group);
                man.broadcast();
                return res.json({ ok: true, cwd, group });
            }
            // label: set a project's lifecycle (active|inactive|archive), keyed by
            // cwd like setGroup so it survives restarts + soa-restore-fleet respawns.
            // Non-active projects are skipped by cohort fan-outs (goal/btw/clear/
            // resume/broadcast) and by the always-on supervisors, so the manager
            // stops spending tokens on them. {action:'label', id?|cwd?, lifecycle}
            if (action === 'label') {
                let cwd = (typeof body.cwd === 'string' && body.cwd) ? body.cwd : null;
                if (!cwd && body.id != null) { const tab = mgr.get(Number(body.id)); if (tab) cwd = tab.cwd; }
                if (!cwd) return res.status(400).json({ ok: false, error: 'need id or cwd' });
                const lifecycle = man.setLifecycle(cwd, body.lifecycle);
                if (!lifecycle) return res.status(400).json({ ok: false, error: 'lifecycle must be active|inactive|archive' });
                man.broadcast();
                return res.json({ ok: true, cwd, lifecycle });
            }
            return res.status(400).json({ ok: false, error: 'unknown action: ' + action });
        } catch (err) {
            return res.status(500).json({ ok: false, error: (err && err.message) || 'failed' });
        }
    });
}

module.exports = {
    SessionManager, ensure, mount,
    classifyAgent, extractCtxPct, launchClaude, submitToTab, writeToTab,
    detectLimit, parseResetTime, isStaleBanner, detectAgentKind, agentForCwd, sessionMaps, resumeLineFor,
    resolveCohort, activeOnlyIds, makeEventFilter, isLocalRequest, autoGroupFromCwd,
};
