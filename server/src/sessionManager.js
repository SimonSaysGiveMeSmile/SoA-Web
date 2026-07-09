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
        };
    } catch (_) {
        return { autoResume: false, autoResumeText: 'continue', closeInactive: CLOSE_INACTIVE_ENV === true, schedules: [], todos: [], groups: {} };
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
    const flag = {
        working: x => x.status === 'working',
        attention: x => x.attention,
        stuck: x => x.stuck,
        idle: x => x.idle,
        done: x => x.status === 'done',
        highContext: x => x.highContext,
        limited: x => x.limited,
    }[str];
    return flag ? snapshot.sessions.filter(flag).map(x => x.id) : [];
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
            return res.status(400).json({ ok: false, error: 'unknown action: ' + action });
        } catch (err) {
            return res.status(500).json({ ok: false, error: (err && err.message) || 'failed' });
        }
    });
}

module.exports = {
    SessionManager, ensure, mount,
    classifyAgent, extractCtxPct, launchClaude, submitToTab, writeToTab,
    resolveCohort, makeEventFilter, isLocalRequest, autoGroupFromCwd,
};
