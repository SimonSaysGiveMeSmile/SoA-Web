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
const sessionModel = require('./sessionModel');
const localKey = require('./localKey');
const entitlements = require('./entitlements');
const meetStore = require('./meetStore');

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
            // Group meetings, keyed by room name ({ "<room>": {members,…} }).
            // Members are keyed by cwd (with the join-time tab id as a hint) for
            // the same reason groups and lifecycles are: tab ids are reassigned
            // on every daemon restart, so a room stored by id would silently
            // reconvene the wrong agents. The transcript is NOT here — it lives
            // in the append-only bus ledger (see meetStore.js); this is only the
            // roster + turn-taking budgets, which is what must survive a restart.
            meetings: (d.meetings && typeof d.meetings === 'object' && !Array.isArray(d.meetings)) ? d.meetings : {},
        };
    } catch (_) {
        return { autoResume: false, autoResumeText: 'continue', closeInactive: CLOSE_INACTIVE_ENV === true, schedules: [], todos: [], groups: {}, lifecycles: {}, meetings: {} };
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

// "You've hit your session limit · resets 2:30am (America/Los_Angeles)"
const LIMIT_RE = /hit your (?:session|usage|weekly) limit[^\n]*?resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

// Next wall-clock occurrence of H:MM am/pm, as epoch ms (server-local time).
function nextOccurrence(h12, min, ampm, now = Date.now()) {
    let h = h12 % 12;
    if (/pm/i.test(ampm)) h += 12;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setTime(d.getTime() + 24 * 60 * 60 * 1000);
    return d.getTime();
}

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
];
// done = agent finished its turn, idle at its input box, waiting for the user
// (orange). Whitespace-flexible (\s*) so modern Claude Code's cursor-positioned
// footer ("bypass permissions on" → "bypasspermissionson" after the strip) still
// matches — otherwise a waiting agent reads as a plain idle shell. Keep in sync
// with web/public/assets/app.js + web/public/m/agentDetect.js.
const DONE = [/╭─+╮/, /│\s*>\s*│/, /╰─+╯/, /│\s*>\s*$/m, /bypass\s*permissions\s*on/i, /accept\s*edits\s*on/i, /plan\s*mode\s*on/i, /shift\s*\+?\s*tab\s*to\s*cycle/i, /⏵⏵/];
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
function launchClaude(tab, cwd, { resume = true, model = '', sessionId = null, coldFallback = true } = {}) {
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
    // Live meeting roster: `meeting:<room>` → every agent currently in that room.
    // Reads snapshot.meeting (set by snapshot()) rather than manager state so this
    // stays pure and testable, exactly like the group: arm above. Empty room name
    // resolves to [] — never a whole-fleet fan-out from a typo.
    const mm = /^meeting:(.+)$/i.exec(str);
    if (mm) {
        const room = mm[1].trim();
        return room ? snapshot.sessions.filter(x => x.meeting === room).map(x => x.id) : [];
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

// ── Group meetings: turn-taking limits ──────────────────────────────────────
// A meeting types real prompts into real Claude sessions, so every one of these
// is a spend control as much as a correctness control. Each has an env override
// because the right value depends on the fleet's size and the user's quota.
const envInt = (name, dflt, min, max) => {
    const n = parseInt(process.env[name] || '', 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
// How many agent-only relay rounds may follow one human message. This is THE
// anti-echo-storm control: agents answer each other for at most this many hops,
// then the room goes quiet until the user speaks again. Only a human message
// recharges it, so a meeting can never sustain itself.
const MEET_RELAY_MAX  = envInt('SOA_MEET_RELAY_MAX', 2, 0, 8);
// Minimum gap between two pokes into the SAME tab. Guards against a burst of
// messages inside one tick turning into a burst of prompts.
const MEET_POKE_MS    = envInt('SOA_MEET_POKE_MS', 8_000, 1_000, 120_000);
// Hard stop on a single room's length. On exhaustion the room adjourns itself
// rather than quietly ignoring messages.
const MEET_MSG_BUDGET = envInt('SOA_MEET_MSG_BUDGET', 40, 4, 400);
// A room with no human message for this long adjourns. The user walking away
// mid-meeting must not leave agents prompting each other.
const MEET_IDLE_MS    = envInt('SOA_MEET_IDLE_MS', 5 * 60_000, 60_000, 60 * 60_000);
// Roster caps. Every extra member is another full Claude turn per round, so the
// soft cap is what the UI offers and the hard cap is what the API accepts.
const MEET_MAX_MEMBERS = envInt('SOA_MEET_MAX_MEMBERS', 6, 2, 12);
// How many recent lines ride along inside a poke. Inlining the transcript delta
// is what lets an agent answer WITHOUT spending a tool call to catch up.
const MEET_RECENT_K   = envInt('SOA_MEET_RECENT_K', 4, 1, 10);

/**
 * Resolve a stored roster to live tab ids. Pure and exported so the resolution
 * rule is testable without a daemon.
 *
 * Identity here is a genuinely awkward problem, and the shape of this function
 * is the answer to it. A member cannot be stored by tab id alone: ids are
 * reassigned on every daemon restart and by soa-restore-fleet, so a room would
 * reconvene whoever happens to hold id 3 next boot. It cannot be stored by cwd
 * alone either: TabManager explicitly supports SIBLING tabs in one directory
 * (it auto-titles them "api-1", "api-2"), so a cwd-keyed roster would collapse
 * two distinct agents into one member and would tag every tab in that folder as
 * a participant — letting a non-member speak and get prompted.
 *
 * So a member is stored as (cwd, title, join-time id) and resolved in
 * decreasing-confidence order:
 *   1. the exact tab id, while it still points at the same cwd — the common
 *      no-restart case, unambiguous even among siblings;
 *   2. else the unique live tab matching BOTH cwd and title — how siblings are
 *      told apart after a restart, since titles persist with the tabs;
 *   3. else the unique live tab matching the cwd — covers a tab renamed since
 *      the room opened;
 *   4. else nobody. Poking the wrong agent is much worse than a member sitting
 *      the round out, so every ambiguity resolves to `null`.
 *
 * Each entry reports `resolved` ('id' | 'title' | 'cwd' | 'ambiguous' | 'gone')
 * so the roster UI can say *why* someone is unreachable instead of silently
 * dropping them. Two members never resolve to the same tab: an id already
 * claimed earlier in the roster is off the table for everyone after it.
 */
function meetRosterIds(snapshot, members) {
    const sessions = snapshot.sessions || [];
    const byId = new Map(sessions.map(x => [x.id, x]));
    const taken = new Set();
    const out = [];
    const claim = (m, row, how) => { taken.add(row.id); out.push({ ...m, id: row.id, title: row.title, resolved: how }); };
    for (const m of members || []) {
        const cwd = m && m.cwd ? m.cwd : null;
        const title = m && m.title ? m.title : null;
        const hintId = m && m.tabId != null ? Number(m.tabId) : null;
        const exact = hintId != null ? byId.get(hintId) : null;
        if (exact && !taken.has(exact.id) && (!cwd || exact.cwd === cwd)) { claim(m, exact, 'id'); continue; }
        const free = sessions.filter(x => !taken.has(x.id));
        const byTitle = (cwd && title) ? free.filter(x => x.cwd === cwd && x.title === title) : [];
        if (byTitle.length === 1) { claim(m, byTitle[0], 'title'); continue; }
        const byCwd = cwd ? free.filter(x => x.cwd === cwd) : [];
        if (byCwd.length === 1) { claim(m, byCwd[0], 'cwd'); continue; }
        const contenders = byTitle.length || byCwd.length;
        out.push({ ...m, id: null, resolved: contenders > 1 ? 'ambiguous' : 'gone' });
    }
    return out;
}

/**
 * Decide whether a member may be prompted right now. Pure and exported: this is
 * the single gate between "there is something new to say" and "type into a live
 * Claude TUI", so every reason to hold back lives here and is unit-tested.
 *
 * `m` is a snapshot row plus `{looksDone, lastPokeAt}`. Returns
 * `{ok:true}` or `{ok:false, why:'<reason>'}` — the reason rides the
 * `meeting-skip` event so a stalled room is diagnosable from `soa-sessions
 * watch` rather than by guesswork.
 */
function shouldPoke(m, opts = {}) {
    if (!m) return { ok: false, why: 'gone' };
    const now = opts.now != null ? opts.now : Date.now();
    const pokeMs = opts.pokeMs != null ? opts.pokeMs : MEET_POKE_MS;
    const relayMax = opts.relayMax != null ? opts.relayMax : MEET_RELAY_MAX;
    if (m.id == null) return { ok: false, why: 'unresolved' };
    // Budget first — it is the loop guard, so it must win over every "but this
    // agent looks ready" condition below.
    if (opts.relayHops != null && opts.relayHops >= relayMax) return { ok: false, why: 'relay-budget' };
    // A rate-limited agent cannot answer; typing at it just queues garbage that
    // lands whenever the limit lifts.
    if (m.limited) return { ok: false, why: 'limited' };
    // Sitting at a permission dialog: submitToTab presses Enter, which would
    // ANSWER the dialog instead of starting a turn. Never poke into a prompt.
    if (m.status === 'attention') return { ok: false, why: 'attention' };
    // Mid-turn. Wait for the input box rather than interleaving with live work.
    if (!m.looksDone) return { ok: false, why: 'busy' };
    if (m.lastPokeAt && (now - m.lastPokeAt) < pokeMs) return { ok: false, why: 'cooldown' };
    // Near the context ceiling a fresh turn is expensive and likely to trigger a
    // compact mid-meeting. Let the throttle loop deal with it first.
    if (m.ctxPct != null && m.ctxPct >= HIGH_CTX) return { ok: false, why: 'high-context' };
    if (m.lifecycle && m.lifecycle !== 'active') return { ok: false, why: 'lifecycle' };
    return { ok: true };
}

/**
 * The line typed into a member's terminal. Everything the agent needs to answer
 * is INLINE — the room, how many lines are new, the recent transcript with
 * speaker labels, and the exact command to reply with — so a turn costs one
 * prompt and no catch-up tool call.
 *
 * The two rules at the end are load-bearing, not decoration: an agent that
 * blocks in `soa-meet watch` never ends its turn and stalls the whole room, and
 * an agent that writes an essay defeats the groupchat pacing.
 */
function meetPokeLine(room, msgs, opts = {}) {
    const k = opts.recentK != null ? opts.recentK : MEET_RECENT_K;
    const recent = (msgs || []).slice(-k)
        .map(m => `${m.who === 'user' ? 'you' : '#' + m.who}: "${m.text}"`)
        .join(' | ');
    const n = (msgs || []).length;
    return `[meeting ${room}] ${n} new · you're up. RECENT: ${recent}`
        + ` — reply with ONE line: soa-meet say ${room} "<=2 sentences>".`
        + ' Do not block on `soa-meet watch`; answer, then stop.';
}

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
        // ── Meetings: HOT state only ────────────────────────────────────────
        // `<room>\0<cwd>` → {lastPokeAt, cursor}. Deliberately transient: a
        // restart should re-brief every member from the durable ledger rather
        // than assume they still remember a conversation their process never saw.
        // Durable roster + budgets live in this.state.meetings (manager.json).
        this._meetSeat = new Map();
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

    // ── Group meetings ──────────────────────────────────────────────────────
    // A meeting is a groupchat between the user (as manager) and a hand-picked
    // set of agents. The user opens a room, the daemon relays each line to the
    // other members by typing a short brief into their terminals, and each agent
    // answers with one `soa-meet say`. That relay is the whole mechanism: there
    // is no shared Claude context, so the ledger + the inlined delta in each
    // poke IS the shared context, and it is what lets separate instances
    // actually respond to each other instead of talking past each other.

    // Open room a cwd currently belongs to, or null. Closed rooms don't count —
    // an adjourned meeting must not keep an agent flagged as in-session.
    _meetingFor(tabId, resolved) {
        if (tabId == null) return null;
        const map = resolved || this._resolvedRooms();
        for (const [name, ids] of map) if (ids.has(tabId)) return name;
        return null;
    }

    /**
     * Every OPEN room's roster, resolved to live tab ids: `Map<room, Set<id>>`.
     *
     * This — not a cwd comparison — is the authoritative answer to "is this tab
     * in a meeting?". Resolution has to run for membership, because a member is
     * identified by (cwd, title, join-time id) and only the resolver knows which
     * live tab a stored member actually is. Asking by cwd alone would tag every
     * SIBLING tab in a project as a participant, letting an uninvited agent
     * speak in the room and get prompted by it.
     */
    _resolvedRooms() {
        const sessions = this._bareSessions();
        const out = new Map();
        const rooms = this.state.meetings || {};
        for (const name of Object.keys(rooms)) {
            const r = rooms[name];
            if (!r || r.closedAt) continue;
            const ids = new Set();
            for (const e of meetRosterIds({ sessions }, r.members)) if (e.id != null) ids.add(e.id);
            out.set(name, ids);
        }
        return out;
    }

    // Transient per-seat state (poke cooldown + how far this member has been
    // briefed). Keyed by LIVE tab id: seats are hot state, rebuilt from scratch
    // after a restart anyway, and ids are never reused within one daemon run —
    // so this sidesteps the stored-identity problem entirely, and a mid-meeting
    // rename cannot silently reset somebody's seat. `floor` seeds the cursor so
    // a member is never briefed on transcript from before it joined, and after a
    // restart is re-briefed from the ledger rather than assumed to remember a
    // conversation its own process never saw.
    _seat(room, tabId, floor = 0) {
        const k = room + '\u0000' + tabId;
        let s = this._meetSeat.get(k);
        if (!s) { s = { lastPokeAt: 0, cursor: Number(floor) || 0, skipWhy: null }; this._meetSeat.set(k, s); }
        return s;
    }

    // Normalize a member spec ({id} or {cwd}) into the stored shape. The title
    // is captured alongside the cwd because it is what tells SIBLING tabs in one
    // directory apart after a restart has reassigned their ids.
    _meetMember(spec) {
        const mgr = this.session.tabMgr;
        let cwd = spec && typeof spec.cwd === 'string' && spec.cwd ? spec.cwd : null;
        const tabId = spec && spec.id != null ? Number(spec.id) : null;
        let title = spec && typeof spec.title === 'string' && spec.title ? spec.title : null;
        if (tabId != null && mgr) {
            const tab = mgr.get(tabId);
            if (tab) { cwd = cwd || tab.cwd; title = title || tab.title; }
        }
        if (!cwd) return null;
        return { cwd, tabId, title, baseSeq: 0 };
    }

    /**
     * Open a room. Returns `{ok, room}` or `{ok:false, error}`.
     *
     * The roster is capped because every member is a full Claude turn per round;
     * `convener` is excluded by the caller (the manager must not prompt itself).
     * A tab may only sit in one open room at a time — two rooms poking one
     * terminal would interleave two conversations into one prompt stream.
     */
    meetStart({ room, title, members, mode, convener } = {}) {
        const name = String(room == null ? '' : room).trim().slice(0, 40);
        if (!name) return { ok: false, error: 'room name required' };
        if (!this.state.meetings) this.state.meetings = {};
        const existing = this.state.meetings[name];
        if (existing && !existing.closedAt) return { ok: false, error: 'room already open', code: 'ROOM_OPEN' };
        // Dedup by TAB, not by cwd: two sibling tabs in one project are two
        // distinct agents (TabManager even auto-titles them api-1 / api-2), and
        // collapsing them would silently drop a member the user picked.
        const seen = new Set();
        const rooms0 = this._resolvedRooms();
        const roster = [];
        for (const spec of members || []) {
            const m = this._meetMember(spec);
            if (!m) continue;
            const key = m.tabId != null ? '#' + m.tabId : m.cwd + '\u0000' + (m.title || '');
            if (seen.has(key)) continue;
            const busy = m.tabId != null ? this._meetingFor(m.tabId, rooms0) : null;
            if (busy) return { ok: false, error: `#${m.tabId} is already in meeting "${busy}"`, code: 'MEMBER_BUSY' };
            seen.add(key);
            roster.push(m);
        }
        if (roster.length < 1) return { ok: false, error: 'no resolvable members' };
        if (roster.length > MEET_MAX_MEMBERS) {
            return { ok: false, error: `too many members (${roster.length} > ${MEET_MAX_MEMBERS}) — a meeting costs one Claude turn per member per round`, code: 'ROSTER_CAP' };
        }
        // Baseline every member at the ledger head so reopening a room name does
        // not replay the previous meeting's transcript into fresh terminals.
        const base = meetStore.headSeq(name);
        roster.forEach(m => { m.baseSeq = base; });
        const now = Date.now();
        const r = {
            room: name,
            title: String(title == null ? '' : title).trim().slice(0, 120) || name,
            members: roster,
            convener: convener == null ? 'user' : String(convener),
            // 'round' asks members to answer in roster order (cheaper, calmer with
            // many agents); 'free' lets everyone answer every message.
            mode: mode === 'round' ? 'round' : (roster.length > 4 ? 'round' : 'free'),
            createdAt: now,
            lastHumanAt: now,
            relayHops: 0,
            msgBudget: MEET_MSG_BUDGET,
            baseSeq: base,
            headSeq: base,
            closedAt: null,
            closedWhy: null,
        };
        this.state.meetings[name] = r;
        this._pruneMeetings();
        this._saveState();
        this._emit('meeting-open', roster[0] && roster[0].tabId ? roster[0].tabId : 0, {
            detail: `${name} · ${roster.length} member(s) · mode ${r.mode}`,
        });
        this.broadcast();
        return { ok: true, room: this.meetView(name) };
    }

    // Adjourn a room. Writes a closing line into the transcript so the reason is
    // visible to anyone reading the ledger, not just to whoever saw the event.
    meetEnd(room, why = 'closed') {
        const r = (this.state.meetings || {})[room];
        if (!r) return { ok: false, error: 'no such room' };
        if (r.closedAt) return { ok: true, room: this.meetView(room), alreadyClosed: true };
        r.closedAt = Date.now();
        r.closedWhy = String(why).slice(0, 40);
        meetStore.append(room, { v: 'say', room, who: 'system', text: `— meeting adjourned (${r.closedWhy})`, via: 'system' }, 'system');
        this._saveState();
        this._emit('meeting-close', 0, { detail: `${room} (${r.closedWhy})` });
        this.broadcast();
        return { ok: true, room: this.meetView(room) };
    }

    // Add/remove a member mid-meeting. A late joiner is baselined at the current
    // head, so it is briefed on what happens next rather than the whole backlog.
    meetJoin(room, spec) {
        const r = (this.state.meetings || {})[room];
        if (!r || r.closedAt) return { ok: false, error: 'no open room' };
        const m = this._meetMember(spec);
        if (!m) return { ok: false, error: 'cannot resolve member' };
        // Already seated in THIS room (by live tab, not by directory) — idempotent.
        const here = this._resolvedRooms().get(room) || new Set();
        if (m.tabId != null && here.has(m.tabId)) return { ok: true, room: this.meetView(room) };
        const busy = m.tabId != null ? this._meetingFor(m.tabId) : null;
        if (busy) return { ok: false, error: `already in meeting "${busy}"`, code: 'MEMBER_BUSY' };
        if ((r.members || []).length >= MEET_MAX_MEMBERS) return { ok: false, error: 'roster full', code: 'ROSTER_CAP' };
        m.baseSeq = meetStore.headSeq(room);
        r.members.push(m);
        this._saveState();
        this.broadcast();
        return { ok: true, room: this.meetView(room) };
    }

    meetLeave(room, spec) {
        const r = (this.state.meetings || {})[room];
        if (!r) return { ok: false, error: 'no such room' };
        const m = this._meetMember(spec);
        const wantId = m && m.tabId != null ? m.tabId : null;
        const cwd = m ? m.cwd : (spec && spec.cwd) || null;
        if (!cwd && wantId == null) return { ok: false, error: 'cannot resolve member' };
        const before = (r.members || []).length;
        // Remove the ONE stored member that currently resolves to that tab. A
        // cwd-wide filter would evict a sibling agent the user never excused.
        const resolved = meetRosterIds({ sessions: this._bareSessions() }, r.members);
        let dropIndex = wantId != null ? resolved.findIndex(e => e.id === wantId) : -1;
        if (dropIndex === -1) dropIndex = resolved.findIndex(e => e.cwd === cwd && (!m || !m.title || e.title === m.title));
        if (dropIndex === -1) dropIndex = resolved.findIndex(e => e.cwd === cwd);
        if (dropIndex !== -1) {
            r.members = (r.members || []).filter((_, i) => i !== dropIndex);
            if (wantId != null) this._meetSeat.delete(room + '\u0000' + wantId);
        }
        this._saveState();
        this.broadcast();
        // An empty room is over — leaving the last member would otherwise leave a
        // room "open" forever, blocking the name and burning the idle timer.
        if (r.members.length === 0 && !r.closedAt) this.meetEnd(room, 'empty');
        return { ok: true, removed: before !== r.members.length, room: this.meetView(room) };
    }

    /**
     * Record one line in a room. `who` is 'user' for the manager or a tab id for
     * an agent. Returns the appended message so the caller can echo it back.
     *
     * A HUMAN line resets the relay budget; an agent line does not. That single
     * asymmetry is what makes a meeting terminate: agents can answer each other
     * for MEET_RELAY_MAX rounds, then the room waits for the user.
     */
    meetSay(room, { who, cwd, text, via } = {}) {
        const r = (this.state.meetings || {})[room];
        if (!r) return { ok: false, error: 'no such room', code: 'NO_ROOM' };
        if (r.closedAt) return { ok: false, error: 'meeting adjourned', code: 'ROOM_CLOSED' };
        const body = String(text == null ? '' : text).trim();
        if (!body) return { ok: false, error: 'text required' };
        const isHuman = who === 'user' || who == null;
        // Membership is decided by RESOLVED tab id, never by cwd: a sibling tab
        // in a member's directory is a different agent and was not invited.
        if (!isHuman) {
            const here = this._resolvedRooms().get(room) || new Set();
            if (!here.has(Number(who))) return { ok: false, error: 'not a member of this meeting', code: 'NOT_MEMBER' };
        }
        if ((r.msgBudget | 0) <= 0) {
            this.meetEnd(room, 'budget');
            return { ok: false, error: 'meeting message budget exhausted', code: 'BUDGET' };
        }
        const mgr = this.session.tabMgr;
        const tab = (!isHuman && mgr && who != null) ? mgr.get(Number(who)) : null;
        const from = isHuman ? 'you (manager)' : `#${who} ${(tab && tab.title) || ''}`.trim();
        const rec = meetStore.append(room, {
            v: 'say', room, who: isHuman ? 'user' : String(who), cwd: cwd || null,
            text: body, via: via || (isHuman ? 'user' : 'cli'),
        }, from);
        if (!rec) return { ok: false, error: 'ledger write failed' };
        r.msgBudget = (r.msgBudget | 0) - 1;
        r.headSeq = Math.max(r.headSeq || 0, rec.seq);
        if (isHuman) { r.lastHumanAt = Date.now(); r.relayHops = 0; }
        // The speaker has by definition seen its own line — advance its own seat
        // so the very next tick doesn't brief it on what it just said.
        if (!isHuman) this._seat(room, Number(who), r.baseSeq).cursor = rec.seq;
        this._saveState();
        this._emit('meeting-say', isHuman ? 0 : Number(who), { detail: `${room}: ${meetStore.capLine(body, 80)}` });
        const msg = meetStore.parseRecord(JSON.stringify(rec));
        this.meetPush(room, msg);
        this.broadcast();
        return { ok: true, seq: rec.seq, msg };
    }

    meetRead(room, sinceSeq = 0, limit = 100) {
        const r = (this.state.meetings || {})[room];
        const out = meetStore.read(room, { sinceSeq, limit });
        return { ok: true, room: r ? this.meetView(room) : null, ...out };
    }

    // Client-facing view of a room: roster resolved to live ids (with a reason
    // when a member can't be resolved) plus the budgets the UI shows as meters.
    meetView(room) {
        const r = (this.state.meetings || {})[room];
        if (!r) return null;
        const snap = { sessions: this._bareSessions() };
        const roster = meetRosterIds(snap, r.members).map(e => ({
            cwd: e.cwd, id: e.id, title: e.title || null, resolved: e.resolved,
            status: e.id != null ? this._state(e.id).status : null,
        }));
        return {
            room: r.room, title: r.title, mode: r.mode,
            members: roster,
            live: roster.filter(e => e.id != null).length,
            convener: r.convener,
            createdAt: r.createdAt, lastHumanAt: r.lastHumanAt,
            relayHops: r.relayHops | 0, relayMax: MEET_RELAY_MAX,
            msgBudget: r.msgBudget | 0, headSeq: r.headSeq || 0,
            closedAt: r.closedAt || null, closedWhy: r.closedWhy || null,
            open: !r.closedAt,
        };
    }

    // Minimal id/title/cwd rows for roster resolution. snapshot() itself calls
    // meetView (for the meetings list), so meetView must NOT call snapshot() —
    // this is the small, recursion-free substitute.
    _bareSessions() {
        const mgr = this.session.tabMgr;
        if (!mgr) return [];
        return mgr.order.map(id => {
            const tab = mgr.get(id);
            return { id, title: (tab && tab.title) || `tab ${id}`, cwd: (tab && tab.cwd) || null };
        });
    }

    // Keep manager.json tidy: an unbounded closed-room history would grow
    // forever. Ten adjourned rooms is plenty of scrollback for the UI.
    _pruneMeetings() {
        const rooms = this.state.meetings || {};
        const closed = Object.keys(rooms)
            .filter(k => rooms[k] && rooms[k].closedAt)
            .sort((a, b) => rooms[a].closedAt - rooms[b].closedAt);
        while (closed.length > 10) delete rooms[closed.shift()];
    }

    /**
     * Advance every open room by one step. Called from the 3s supervisor tick —
     * NOT its own timer, so there is nothing extra to tear down in destroy().
     *
     * The tick is the driver rather than the agents themselves, deliberately: an
     * agent that blocked waiting for its turn would never end its Claude turn,
     * and the room would deadlock behind a tool timeout. Here the daemon decides
     * who is ready, types one brief into that terminal, and returns.
     *
     * It also POLLS readiness (`looksDone`) instead of waiting for a status
     * event: `feed()` only emits on a status CHANGE, so an agent that was
     * already at its input box can finish a turn without emitting anything at
     * all — a room driven purely by events can wait forever for a wakeup that is
     * never coming.
     */
    tickMeetings() {
        const mgr = this.session.tabMgr;
        if (!mgr) return;
        const rooms = this.state.meetings || {};
        const names = Object.keys(rooms);
        if (!names.length) return;
        const now = Date.now();
        const snapSessions = this._bareSessions();
        for (const room of names) {
            const r = rooms[room];
            if (!r || r.closedAt) continue;
            // The user walked away: adjourn rather than leave agents prompting
            // each other unattended.
            if (r.lastHumanAt && (now - r.lastHumanAt) > MEET_IDLE_MS) { this.meetEnd(room, 'idle'); continue; }
            if ((r.msgBudget | 0) <= 0) { this.meetEnd(room, 'budget'); continue; }

            const roster = meetRosterIds({ sessions: snapSessions }, r.members).filter(e => e.id != null);
            if (!roster.length) continue;

            let minCursor = Infinity;
            for (const e of roster) minCursor = Math.min(minCursor, this._seat(room, e.id, e.baseSeq || r.baseSeq).cursor);
            if (!Number.isFinite(minCursor)) minCursor = r.baseSeq || 0;
            // Nothing new for even the furthest-behind member → no disk read, no
            // pokes. "Never poke when nothing is new" is the cheapest of all the
            // spend controls, so it goes first.
            if ((r.headSeq || 0) <= minCursor) continue;

            const all = meetStore.read(room, { sinceSeq: minCursor, limit: 100 }).msgs;
            if (!all.length) continue;
            const head = all[all.length - 1].seq;
            if (head > (r.headSeq || 0)) r.headSeq = head;   // pick up an out-of-band append

            // 'round' mode: at most one member is prompted per tick, in roster
            // order, so a big room reads as a turn-taking meeting instead of N
            // simultaneous monologues (and costs one turn per tick, not N).
            const order = r.mode === 'round' ? roster.slice(0, 1).concat(roster.slice(1)) : roster;
            let poked = 0;
            for (const e of order) {
                const seat = this._seat(room, e.id, e.baseSeq || r.baseSeq);
                // Never brief a member on its OWN line — that is the tightest
                // possible echo loop (agent replies, gets told about its reply).
                // Matched on speaker id, not cwd: a sibling tab in the same
                // directory is a different agent and must still hear it.
                const pending = all.filter(m => m.seq > seat.cursor && String(m.who) !== String(e.id));
                if (!pending.length) continue;
                const row = snapSessions.find(x => x.id === e.id) || {};
                const st = this._state(e.id);
                const gate = shouldPoke({
                    ...row, id: e.id,
                    status: st.status, ctxPct: st.ctxPct, limited: !!st.limit,
                    lifecycle: this._lifecycleFor(row.cwd),
                    looksDone: looksDone(st.recent),
                    lastPokeAt: seat.lastPokeAt,
                }, { now, relayHops: r.relayHops | 0 });
                if (!gate.ok) {
                    // Edge-triggered: one event per reason, not one every 3s. A
                    // stalled room is then explainable from `soa-sessions watch`.
                    if (seat.skipWhy !== gate.why) {
                        seat.skipWhy = gate.why;
                        this._emit('meeting-skip', e.id, { detail: `${room}: ${gate.why}` });
                    }
                    continue;
                }
                seat.skipWhy = null;
                const tab = mgr.get(e.id);
                if (!tab || tab.exited) continue;
                submitToTab(tab, meetPokeLine(room, pending));
                seat.lastPokeAt = now;
                seat.cursor = head;
                poked++;
                this._emit('meeting-poke', e.id, { detail: `${room}: ${pending.length} new` });
                if (r.mode === 'round') break;   // one turn per tick
            }
            // Count a relay round only when it was driven by agents. A human
            // message must never spend the budget it just recharged.
            if (poked > 0 && all[all.length - 1].who !== 'user') {
                r.relayHops = (r.relayHops | 0) + 1;
            }
            if (poked > 0) this._saveState();
        }
    }

    // ── One-shot "send text to tab at time" schedules ──
    schedule(tabId, at, text) {
        const id = Math.random().toString(36).slice(2, 10);
        // Capture the cwd: tab ids are reassigned on a daemon restart, so cwd is
        // the only stable identity for resolving the target when the schedule fires.
        const tab = this.session.tabMgr && this.session.tabMgr.get(tabId);
        const cwd = tab && tab.cwd ? tab.cwd : null;
        // One pending auto/manual resume per tab — newest wins.
        this.state.schedules = this.state.schedules.filter(s => s.tabId !== tabId);
        this.state.schedules.push({ id, tabId, cwd, at, text: String(text).slice(0, 500) });
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
            submitToTab(tab, s.text);
        }
        this.broadcast();
    }

    _state(id) {
        let s = this.tabs.get(id);
        if (!s) {
            s = { status: 'idle', ctxPct: null, recent: '', lastOutputAt: 0, lastStatusAt: 0, limit: null };
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
            // Output is flowing again as real work → the limit is behind us.
            if (next === 'working') s.limit = null;
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
        // Usage-limit banner → remember when it lifts; optionally schedule an
        // automatic resume nudge shortly after the reset time.
        const lm = strip(s.recent).slice(-1000).match(LIMIT_RE);
        if (lm) {
            const resetAt = nextOccurrence(+lm[1], +(lm[2] || 0), lm[3]);
            if (!s.limit || s.limit.resetAt !== resetAt) {
                s.limit = { resetAt, label: lm[0].slice(0, 120) };
                this._emit('limited', id, { detail: s.limit.label });
                if (this.state.autoResume) {
                    this.schedule(id, resetAt + 2 * 60_000, this.state.autoResumeText);
                }
            }
        }
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
        this._meetSeat.clear();
    }

    // Build the supervisor view of every live tab.
    snapshot() {
        const mgr = this.session.tabMgr;
        const order = mgr ? mgr.order : [];
        const now = Date.now();
        // Resolve every open room's roster ONCE — it is O(rooms x members x tabs)
        // and snapshot() runs on the 3s tick for every connected client.
        const rooms = this._resolvedRooms();
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
                // Open meeting this agent is sitting in, or null. Also what the
                // `meeting:<room>` cohort selector filters on, so the CLI and both
                // UIs read one field instead of three lookups.
                meeting: this._meetingFor(id, rooms),
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
                limited: !!s.limit,
                limitResetAt: s.limit ? s.limit.resetAt : null,
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
            inMeeting: sessions.filter(x => x.meeting).length,
        };
        // Rooms ride the MANAGER snapshot (already pushed every 3s) so both the
        // dashboard and the phone get the roster + budget meters with no new
        // protocol type. Transcript deltas travel separately — see MSG.MEETING.
        const meetings = Object.keys(this.state.meetings || {})
            .map(name => this.meetView(name))
            .filter(Boolean)
            .sort((a, b) => (b.open - a.open) || (b.createdAt - a.createdAt));
        return {
            sessions, counts, ts: now,
            autoResume: this.state.autoResume,
            closeInactive: this.state.closeInactive === true,
            todos: this.state.todos,
            meetings,
            managerTabId,
            managerActive: managerTabId != null,
            managerStatus,
        };
    }

    broadcast() {
        try { this.session.send(frame(MSG.MANAGER, this.snapshot())); } catch (_) {}
    }

    // Push one meeting message to every connected client immediately. The 3s
    // MANAGER snapshot carries the roster, but a groupchat needs its lines to
    // land as they are said — a three-second lag reads as a broken chat.
    meetPush(room, msg) {
        if (!msg) return;
        try { this.session.send(frame(MSG.MEETING, { room, msgs: [msg] })); } catch (_) {}
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
                const buildLine = (tab) => {
                    switch (verb) {
                        case 'goal': return '/goal ' + text;
                        case 'btw': return '/btw ' + text;
                        case 'clear': return '/clear';
                        case 'continue': return 'claude --continue';
                        case 'resume': {
                            let sid = null;
                            try { const hit = claudeSessions.latestSessionByCwd(72).get(tab.cwd); if (hit) sid = hit.sessionId; } catch (_) {}
                            return sid ? `claude --resume ${sid} || claude --continue` : 'claude --continue';
                        }
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
                let tab;
                try { tab = mgr.open({ title, cwd, env: envStore.getEnvForShell(), silent: false }); }
                catch (e) { return res.status(500).json({ ok: false, error: (e && e.message) || 'spawn failed' }); }
                // Optional: create the tab with a non-active lifecycle (soa-sessions
                // spawn --lifecycle …). Keyed by cwd, so it sticks across respawns.
                if (body.lifecycle && tab.cwd) man.setLifecycle(tab.cwd, body.lifecycle);
                if (wantClaude) {
                    const tm = setTimeout(() => {
                        try { launchClaude(tab, tab.cwd, { resume, model }); } catch (_) {}
                        if (goalText) { const g = setTimeout(() => submitToTab(tab, '/goal ' + goalText), 3000); if (g.unref) g.unref(); }
                    }, 1200); // let the fresh shell print its prompt first
                    if (tm.unref) tm.unref();
                }
                man._emit('spawned', tab.id, { detail: cwd || null });
                return res.json({ ok: true, id: tab.id, title: tab.title, cwd: tab.cwd, claudeLaunched: wantClaude });
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

            // ── Group meetings (the agent-facing half; `soa-meet` speaks this) ──
            // The daemon is the SINGLE writer of a room's transcript, so the IM
            // cap, the membership check, the event emit, and the relay all happen
            // in exactly one place no matter who is talking.
            //
            // meet-say: one line into a room, from the CALLING tab. Identity is
            // taken from the caller's own tab (body.self / body.id), never from a
            // claimed name — otherwise any local process could speak as any agent.
            if (action === 'meet-say') {
                const room = String(body.room || '').trim();
                const id = body.self != null ? Number(body.self) : (body.id != null ? Number(body.id) : null);
                if (!room) return res.status(400).json({ ok: false, error: 'room required' });
                if (id == null || !Number.isFinite(id)) {
                    return res.status(400).json({ ok: false, error: 'cannot determine your tab — run inside a SoA tab' });
                }
                const tab = mgr.get(id);
                if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
                const r = man.meetSay(room, { who: id, cwd: tab.cwd, text: body.text, via: 'cli' });
                if (!r.ok) {
                    // 409 for a policy refusal (adjourned / not a member / budget
                    // spent) so the CLI can exit 3 and the agent stops trying.
                    const code = r.code === 'NO_ROOM' ? 404 : (r.code ? 409 : 400);
                    return res.status(code).json(r);
                }
                return res.json(r);
            }
            // meet-read: non-blocking transcript read. This is the agent default —
            // there is deliberately no blocking read on this surface.
            if (action === 'meet-read') {
                const room = String(body.room || '').trim();
                if (!room) return res.status(400).json({ ok: false, error: 'room required' });
                return res.json(man.meetRead(room, Number(body.since) || 0, Number(body.limit) || 100));
            }
            // meet-list: every room the manager knows (open first).
            if (action === 'meet-list') {
                const rooms = Object.keys(man.state.meetings || {}).map(n => man.meetView(n)).filter(Boolean);
                rooms.sort((a, b) => (b.open - a.open) || (b.createdAt - a.createdAt));
                return res.json({ ok: true, rooms });
            }
            // meet-start: convene a room over a cohort selector. `self` is
            // excluded — a manager agent runs the meeting, it doesn't sit in it.
            if (action === 'meet-start') {
                const room = String(body.room || '').trim();
                const self = body.self != null ? Number(body.self) : null;
                let ids = resolveTargets(body.with);
                ids = activeOnlyIds(body.with, ids, man.snapshot(), body.includeInactive);
                if (self != null) ids = ids.filter(x => x !== self);
                const r = man.meetStart({
                    room, title: body.title, mode: body.mode,
                    members: ids.map(id => ({ id })),
                    convener: self != null ? String(self) : 'user',
                });
                if (!r.ok) return res.status(r.code === 'ROOM_OPEN' || r.code === 'MEMBER_BUSY' || r.code === 'ROSTER_CAP' ? 409 : 400).json(r);
                return res.json(r);
            }
            if (action === 'meet-end') {
                const r = man.meetEnd(String(body.room || '').trim(), body.why || 'closed');
                return res.status(r.ok ? 200 : 404).json(r);
            }
            if (action === 'meet-join' || action === 'meet-leave') {
                const room = String(body.room || '').trim();
                const id = body.id != null ? Number(body.id) : (body.self != null ? Number(body.self) : null);
                if (!room || id == null || !Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'room and id required' });
                const r = action === 'meet-join' ? man.meetJoin(room, { id }) : man.meetLeave(room, { id });
                return res.status(r.ok ? 200 : (r.code ? 409 : 404)).json(r);
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
    resolveCohort, activeOnlyIds, makeEventFilter, isLocalRequest, autoGroupFromCwd,
    // Meeting pure helpers — exported for the same reason resolveCohort is: the
    // rules that decide who gets prompted must be testable without a daemon.
    meetRosterIds, shouldPoke, meetPokeLine, looksDone,
    MEET_RELAY_MAX, MEET_POKE_MS, MEET_MSG_BUDGET, MEET_MAX_MEMBERS,
};
