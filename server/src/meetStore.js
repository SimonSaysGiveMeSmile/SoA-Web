/**
 * Meeting ledger — the append-only transcript for agent group meetings.
 *
 * A meeting is a groupchat: the user (as manager) picks a few agents, and every
 * line anyone says lands here. This module is the ONLY writer/reader of that
 * transcript, and it deliberately rides the existing `soa-bus` substrate rather
 * than inventing a store: one `.jsonl` file per room under `<state>/a2a/`, in
 * soa-bus's own record shape, so `soa-bus read meet-<room>` and `soa-bus
 * channels` see meetings for free — and the same LOCAL-ONLY privacy guarantee
 * holds. Pure local files: never networked, never uploaded, never shared off
 * this machine. No daemon, no database.
 *
 * Record layering follows `soa-work` (which does the same over `work-claims`):
 * the OUTER record is a literal soa-bus message, and the structured payload is
 * JSON inside its `msg` string. That keeps the file readable by the plain bus
 * CLI while still carrying the fields a meeting needs.
 *
 *   {"t":1787206945908,"from":"#7 soa-web",
 *    "msg":"{\"v\":\"say\",\"room\":\"standup\",\"seq\":1787206945908,
 *            \"who\":\"7\",\"text\":\"api is green\",\"via\":\"cli\"}",
 *    "chan":"meet-standup"}
 *
 * Two invariants earn their own comments below because getting them wrong is
 * silent rather than loud: text is capped BEFORE the write (so one message is
 * one atomic append — macOS has no flock), and the relay cursor is a max `seq`,
 * never a line count (the trim rewrites the file, so a count-based baseline goes
 * deaf the moment a room gets busy).
 *
 * Intentionally requires nothing but node builtins — no express — so the unit
 * tests run in a bare checkout.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Per-file soft cap, mirroring soa-bus's own (SOA_BUS_MAXLINES=5000, trimmed to
// the last 2/5). A room that runs long keeps its tail, not its opening.
const MAXLINES = 5000;
const TRIM_TO = 2000;
// Hard ceiling on the serialized record, mirroring soa-bus's SOA_BUS_MAXMSG.
// The IM cap below keeps us an order of magnitude under it; this is the backstop
// that guarantees the single-append atomicity the lock-free design relies on.
const MAXREC = 4000;

// IM discipline, enforced in code rather than prose: a meeting line is a chat
// message, not a memo. Everything longer is truncated, not rejected — an agent
// that over-explains still gets heard, just trimmed.
function msgCap() {
    const n = parseInt(process.env.SOA_MEET_MSG_CAP || '280', 10);
    return Math.max(40, Number.isFinite(n) && n > 0 ? n : 280);
}

/**
 * Resolve the shared bus dir. This is the IDENTICAL 4-step chain used by
 * `scripts/soa-bus` (:22-27) and `scripts/soa-work` (:27-31), and it must stay
 * identical: if the daemon resolves one dir while the shell-side `soa-meet`
 * resolves another, every participant writes to a ledger nobody else reads — a
 * room where all the messages vanish, with no error anywhere.
 *
 * Deliberately NOT `stateDir.js`: that resolves `$SOA_WEB_STATE_DIR` else
 * `~/.soa-web`, skipping the `~/.soa-web-local` probe every CLI performs. (The
 * daemon also now injects SOA_WEB_STATE_DIR into every PTY — see tts.envFor —
 * so in practice both sides take the second branch and agree explicitly.)
 * Resolved per call, not at load, so a test can point it at a temp dir.
 */
function busDir() {
    if (process.env.SOA_BUS_DIR) return process.env.SOA_BUS_DIR;
    if (process.env.SOA_WEB_STATE_DIR) return path.join(process.env.SOA_WEB_STATE_DIR, 'a2a');
    const local = path.join(os.homedir(), '.soa-web-local');
    try { if (fs.existsSync(local)) return path.join(local, 'a2a'); } catch (_) {}
    return path.join(os.homedir(), '.soa-web', 'a2a');
}

// Channel name for a room. Same normalization as soa-bus's `norm()`
// (`tr -c 'A-Za-z0-9._@-' '_'`), so a room name can be typed freely without
// escaping a path separator into the filename.
function chanName(room) {
    const prefix = process.env.SOA_MEET_CHAN_PREFIX || 'meet-';
    return prefix + String(room == null ? '' : room).replace(/[^A-Za-z0-9._@-]/g, '_');
}

function chanFile(room) {
    return path.join(busDir(), chanName(room) + '.jsonl');
}

/**
 * Collapse a message to a single IM-sized line. Newlines become spaces (a
 * meeting line must be ONE atomic append and one readable bubble), and the
 * truncation slices by code point rather than UTF-16 unit so a multi-byte
 * character is never cut in half into a lone surrogate.
 */
function capLine(text, cap) {
    const limit = cap == null ? msgCap() : Math.max(8, cap);
    const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const chars = Array.from(flat);
    if (chars.length <= limit) return flat;
    return chars.slice(0, limit - 1).join('') + '…';
}

// Monotonic sequence source. `seq` is the relay cursor's currency, so two
// messages posted inside the same millisecond must NOT collide — a duplicate seq
// makes a `> cursor` comparison drop one of them forever. Clamping to
// lastSeq + 1 keeps it strictly increasing while staying a readable timestamp.
let _lastSeq = 0;
function nextSeq() {
    _lastSeq = Math.max(Date.now(), _lastSeq + 1);
    return _lastSeq;
}

// Trim an overgrown ledger to its tail. Read-all + rewrite, exactly like
// soa-bus's cap — safe here because the daemon is the single writer in the
// normal path; the degraded `soa-meet say` direct-append is the only other
// writer and it is best-effort by design.
function _trim(file) {
    try {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        // split('\n') on a trailing-newline file yields a final '' — drop it so
        // the count is real lines, not lines+1.
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        if (lines.length <= MAXLINES) return;
        fs.writeFileSync(file, lines.slice(-TRIM_TO).join('\n') + '\n');
    } catch (_) { /* best-effort — a failed trim only wastes disk */ }
}

/**
 * Append one meeting message. `payload` carries the structured fields; `from` is
 * the soa-bus-style display identity ("#7 api", "you (manager)"). Returns the
 * written record (with its assigned `seq`) so the caller can advance a cursor,
 * or null if the write failed.
 */
function append(room, payload, from) {
    const file = chanFile(room);
    const seq = payload && payload.seq != null ? Number(payload.seq) : nextSeq();
    const rec = {
        t: Date.now(),
        from: String(from == null ? '?' : from).slice(0, 80),
        // Cap BEFORE serializing: the atomicity of a lock-free append is only
        // guaranteed for a write small enough to land in one syscall.
        msg: JSON.stringify({ ...payload, seq, text: capLine(payload && payload.text) }),
        chan: chanName(room),
    };
    let line = JSON.stringify(rec) + '\n';
    if (line.length > MAXREC) {
        // Only reachable if a payload field other than `text` is oversized;
        // shrink the text further rather than dropping the message.
        rec.msg = JSON.stringify({ ...payload, seq, text: capLine(payload && payload.text, 120) });
        line = JSON.stringify(rec) + '\n';
    }
    try {
        fs.mkdirSync(path.join(busDir(), 'dm'), { recursive: true });
        fs.appendFileSync(file, line);
    } catch (_) { return null; }
    _trim(file);
    return { ...rec, seq };
}

// Unwrap one raw JSONL line into a flat meeting message, or null when the line
// is unparseable / not a meeting record. Tolerant by design: the ledger is a
// plain file a human may have poked at, and a bad line must not end a read.
function parseRecord(line) {
    const s = String(line || '').trim();
    if (!s) return null;
    let outer;
    try { outer = JSON.parse(s); } catch (_) { return null; }
    if (!outer || typeof outer !== 'object') return null;
    let p;
    try { p = JSON.parse(outer.msg || '{}'); } catch (_) { return null; }
    if (!p || typeof p !== 'object' || p.v !== 'say') return null;
    return {
        seq: Number(p.seq || outer.t || 0),
        t: Number(outer.t || 0),
        room: p.room || null,
        who: p.who == null ? '?' : String(p.who),
        from: outer.from || '?',
        text: String(p.text == null ? '' : p.text),
        via: p.via || 'cli',
    };
}

/**
 * Fold raw lines into ordered messages after `sinceSeq`, keeping the last
 * `limit`. Pure (no fs) so the ordering/cursor rules are unit-testable.
 */
function foldTranscript(lines, sinceSeq, limit) {
    const since = Number(sinceSeq) || 0;
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    const out = [];
    for (const line of lines || []) {
        const m = parseRecord(line);
        if (!m || m.seq <= since) continue;
        out.push(m);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out.slice(-n);
}

// Read a room's transcript. `{ msgs, cursor }` — cursor is the max seq SEEN, so
// an empty read leaves the caller's cursor untouched rather than rewinding it.
function read(room, { sinceSeq = 0, limit = 100 } = {}) {
    let lines = [];
    try { lines = fs.readFileSync(chanFile(room), 'utf8').split('\n'); }
    catch (_) { return { msgs: [], cursor: Number(sinceSeq) || 0 }; }
    const msgs = foldTranscript(lines, sinceSeq, limit);
    const cursor = msgs.length ? msgs[msgs.length - 1].seq : (Number(sinceSeq) || 0);
    return { msgs, cursor };
}

// Highest seq in a room, without materializing the transcript. Used to baseline
// a member's cursor at join time so joining doesn't replay the whole backlog.
function headSeq(room) {
    let lines = [];
    try { lines = fs.readFileSync(chanFile(room), 'utf8').split('\n'); }
    catch (_) { return 0; }
    let max = 0;
    for (const line of lines) {
        const m = parseRecord(line);
        if (m && m.seq > max) max = m.seq;
    }
    return max;
}

module.exports = {
    busDir, chanName, chanFile, capLine, msgCap, nextSeq,
    append, read, headSeq, parseRecord, foldTranscript,
    MAXLINES, TRIM_TO, MAXREC,
};
