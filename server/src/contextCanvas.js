/**
 * contextCanvas — per-Claude-session context for the right-hand canvas.
 *
 * One canvas per Claude session, updated in place: the client asks for a cwd and
 * gets back the session that owns it plus everything worth showing about it. The
 * sessionId in the payload IS the canvas identity — when it changes the client
 * rebinds the same canvas rather than opening a second one.
 *
 * Sources, all local files Claude Code already writes:
 *   ~/.claude/history.jsonl                     user prompts, tagged {project, sessionId}
 *   ~/.claude/projects/<enc-cwd>/<sid>.jsonl    the transcript — TodoWrite + published artifacts
 *   <cwd>/.git/HEAD                             branch, read directly (no shell)
 *
 * The canvas is READ-WRITE, and the agent working in the tab is a first-class
 * author: next steps and artifacts are merged from what the transcript shows and
 * what the agent registered through /api/context/* (the `soa-ctx` CLI). An agent
 * publishing an artifact does not have to remember to tell anyone — the URL is
 * picked out of its own transcript — but it can also post one explicitly, and
 * read the whole canvas back on its next turn.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { stateFile } = require('./stateDir');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HISTORY = path.join(CLAUDE_DIR, 'history.jsonl');
const PROJECTS = path.join(CLAUDE_DIR, 'projects');

// history.jsonl is append-only and unbounded; only the tail can hold the current
// session, so never read the whole file on a poll.
const HISTORY_TAIL_BYTES = 512 * 1024;
// A transcript is tens of MB. TodoWrite state is whatever was written LAST, so
// scan a window off the end rather than parsing from the top.
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_PROMPTS = 40;
const CACHE_TTL_MS = 1500;

function readTail(file, maxBytes) {
    let fd = null;
    try {
        const size = fs.statSync(file).size;
        const start = Math.max(0, size - maxBytes);
        const len = size - start;
        if (len <= 0) return '';
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        const text = buf.toString('utf8');
        // A mid-file start almost certainly lands inside a line; drop the shard.
        return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } catch (_) {
        return '';
    } finally {
        if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
    }
}

function promptsForCwd(cwd) {
    const out = [];
    let sessionId = null;
    for (const line of readTail(HISTORY, HISTORY_TAIL_BYTES).split('\n')) {
        if (!line.trim()) continue;
        let d;
        try { d = JSON.parse(line); } catch (_) { continue; }
        if (d.project !== cwd) continue;
        const text = String(d.display || '').trim();
        if (!text) continue;
        sessionId = d.sessionId || sessionId;
        const prev = out[out.length - 1];
        // The CLI re-logs the in-progress line as it is edited, so consecutive
        // duplicates and growing prefixes are the same prompt, not new turns.
        if (prev && (prev.text === text || text.startsWith(prev.text))) {
            prev.text = text;
            prev.at = Number(d.timestamp) || prev.at;
            prev.sessionId = sessionId;
            continue;
        }
        out.push({ text, at: Number(d.timestamp) || 0, sessionId });
    }
    return { prompts: out.slice(-MAX_PROMPTS), sessionId };
}

// Claude Code encodes the cwd into the project dir name lossily ('/', '.' and
// '-' all become '-'), so resolve by reading the cwd back out of a transcript
// instead of trying to reverse the encoding.
function transcriptFor(cwd, sessionId) {
    const guess = cwd.replace(/[/.]/g, '-');
    const candidates = [guess, guess.replace(/^-/, '')];
    for (const dir of candidates) {
        const p = path.join(PROJECTS, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(p)) return p;
    }
    let entries;
    try { entries = fs.readdirSync(PROJECTS); } catch (_) { return null; }
    for (const e of entries) {
        const p = path.join(PROJECTS, e, `${sessionId}.jsonl`);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function nextStepsFrom(file) {
    if (!file) return [];
    const text = readTail(file, TRANSCRIPT_TAIL_BYTES);
    let latest = null;
    for (const line of text.split('\n')) {
        if (!line.includes('TodoWrite')) continue;
        let d;
        try { d = JSON.parse(line); } catch (_) { continue; }
        const content = (d.message && d.message.content) || [];
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            if (part && part.type === 'tool_use' && part.name === 'TodoWrite' && part.input && Array.isArray(part.input.todos)) {
                latest = part.input.todos;
            }
        }
    }
    if (!latest) return [];
    return latest.map(t => ({
        text: String(t.content || t.activeForm || '').slice(0, 200),
        status: ['completed', 'in_progress', 'pending'].includes(t.status) ? t.status : 'pending',
    }));
}

// Published artifacts, straight out of the transcript. Claude Code prints the
// URL when an artifact is created or updated, so the last occurrence of an id is
// its most recent touch — dedupe by id, keep that order, newest last.
const ARTIFACT_RE = /https:\/\/claude\.ai\/(?:code\/artifact|public\/artifacts)\/([A-Za-z0-9_-]{6,64})/g;
const MAX_ARTIFACTS = 20;

function artifactsFrom(file) {
    if (!file) return [];
    const text = readTail(file, TRANSCRIPT_TAIL_BYTES);
    const byId = new Map();
    for (const line of text.split('\n')) {
        if (!line.includes('claude.ai/')) continue;
        // A title is worth having but never worth failing over: prefer the
        // Artifact tool_use input, fall back to the id.
        let title = null, at = 0;
        try {
            const d = JSON.parse(line);
            at = Date.parse(d.timestamp) || 0;
            const content = (d.message && d.message.content) || [];
            if (Array.isArray(content)) {
                for (const part of content) {
                    if (part && part.type === 'tool_use' && /artifact/i.test(part.name || '') && part.input) {
                        title = String(part.input.title || part.input.description || '').slice(0, 80) || null;
                    }
                }
            }
        } catch (_) { /* not JSON — the URL scan below still works */ }
        ARTIFACT_RE.lastIndex = 0;
        let m;
        while ((m = ARTIFACT_RE.exec(line))) {
            const id = m[1];
            const prev = byId.get(id);
            byId.delete(id);   // re-insert so the most recent mention sorts last
            byId.set(id, {
                id, url: m[0],
                title: title || (prev && prev.title) || null,
                at: at || (prev && prev.at) || 0,
                source: 'transcript',
            });
        }
    }
    return [...byId.values()].slice(-MAX_ARTIFACTS);
}

// Next steps are the one part of the canvas the user writes. TodoWrite would be
// the natural source, but no transcript on this machine contains a single
// TodoWrite call, so a purely derived list would always render empty. Persist an
// editable list per Claude session instead, seeded from TodoWrite when it exists.
function stepsPath(sessionId) {
    return stateFile(path.join('context', `${sessionId}.json`));
}

function readStore(sessionId) {
    if (!sessionId) return {};
    try { return JSON.parse(fs.readFileSync(stepsPath(sessionId), 'utf8')) || {}; }
    catch (_) { return {}; }
}

function writeStore(sessionId, patch) {
    const file = stepsPath(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next = { ...readStore(sessionId), ...patch, updatedAt: Date.now() };
    fs.writeFileSync(file, JSON.stringify(next, null, 1));
    _cache.clear();
    return next;
}

function readSteps(sessionId) {
    const d = readStore(sessionId);
    return Array.isArray(d.steps) ? d.steps : null;
}

// Artifacts an agent registered by hand (soa-ctx artifact <url>). Merged over the
// transcript-derived list so an explicit title wins over a guessed one.
function readArtifacts(sessionId) {
    const d = readStore(sessionId);
    return Array.isArray(d.artifacts) ? d.artifacts : [];
}

function writeArtifact(sessionId, { url, title }) {
    const clean = String(url || '').trim();
    if (!/^https:\/\/claude\.ai\/[A-Za-z0-9/_-]+$/.test(clean)) throw new Error('claude.ai artifact url required');
    const id = (clean.match(/([A-Za-z0-9_-]{6,64})\/?$/) || [])[1] || clean;
    const kept = readArtifacts(sessionId).filter(a => a && a.id !== id);
    kept.push({ id, url: clean, title: title ? String(title).slice(0, 80) : null, at: Date.now(), source: 'agent' });
    writeStore(sessionId, { artifacts: kept.slice(-MAX_ARTIFACTS) });
    return kept;
}

function mergeArtifacts(sessionId, derived) {
    const byId = new Map();
    for (const a of derived || []) byId.set(a.id, a);
    for (const a of readArtifacts(sessionId)) {
        const prev = byId.get(a.id);
        byId.set(a.id, { ...prev, ...a, title: a.title || (prev && prev.title) || null });
    }
    return [...byId.values()].sort((x, y) => (x.at || 0) - (y.at || 0)).slice(-MAX_ARTIFACTS);
}

function writeSteps(sessionId, steps) {
    const clean = (Array.isArray(steps) ? steps : []).slice(0, 60).map(s => ({
        text: String((s && s.text) || '').slice(0, 240),
        status: ['completed', 'in_progress', 'pending'].includes(s && s.status) ? s.status : 'pending',
    })).filter(s => s.text);
    writeStore(sessionId, { steps: clean });
    return clean;
}

function gitBranch(cwd) {
    try {
        const head = fs.readFileSync(path.join(cwd, '.git', 'HEAD'), 'utf8').trim();
        const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return m ? m[1] : head.slice(0, 8);
    } catch (_) {
        return null;
    }
}

const _cache = new Map();

function contextFor(cwd) {
    const hit = _cache.get(cwd);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

    const { prompts, sessionId } = promptsForCwd(cwd);
    const transcript = sessionId ? transcriptFor(cwd, sessionId) : null;
    let turns = 0, lastActivity = 0;
    if (transcript) {
        try { lastActivity = fs.statSync(transcript).mtimeMs; } catch (_) {}
    }
    turns = prompts.length;

    const data = {
        // Canvas identity. The client keys its single canvas on this and rebinds
        // when it changes; it never opens a second one.
        sessionId: sessionId || null,
        workspace: {
            cwd,
            name: path.basename(cwd) || cwd,
            branch: gitBranch(cwd),
            hasTranscript: !!transcript,
        },
        prompts,
        // Saved list wins: it is the user's own, and TodoWrite only ever seeds it.
        nextSteps: readSteps(sessionId) || nextStepsFrom(transcript),
        // Whatever this session published, whether it announced it or not.
        artifacts: mergeArtifacts(sessionId, artifactsFrom(transcript)),
        turns,
        lastActivity,
        updatedAt: Date.now(),
    };
    _cache.set(cwd, { at: Date.now(), data });
    return data;
}

function mount(app, requireAuthed) {
    app.get('/api/context', requireAuthed, (req, res) => {
        const cwd = String(req.query.cwd || '').trim();
        // Only ever an absolute path the caller already has a tab in; the reads
        // below are confined to ~/.claude plus <cwd>/.git/HEAD.
        if (!cwd || !cwd.startsWith('/') || cwd.includes('\0')) {
            return res.status(400).json({ ok: false, error: 'absolute cwd required' });
        }
        try {
            res.json({ ok: true, data: contextFor(path.resolve(cwd)) });
        } catch (e) {
            res.status(500).json({ ok: false, error: String((e && e.message) || e) });
        }
    });

    // The agent's own write path: register an artifact it just published, so the
    // canvas shows it even when the URL never appears in the transcript tail.
    app.post('/api/context/artifacts', requireAuthed, express.json({ limit: '8kb' }), (req, res) => {
        const sessionId = String((req.body && req.body.sessionId) || '').trim();
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(sessionId)) {
            return res.status(400).json({ ok: false, error: 'valid sessionId required' });
        }
        try {
            res.json({ ok: true, artifacts: writeArtifact(sessionId, req.body || {}) });
        } catch (e) {
            res.status(400).json({ ok: false, error: String((e && e.message) || e) });
        }
    });

    app.post('/api/context/steps', requireAuthed, express.json({ limit: '32kb' }), (req, res) => {
        const sessionId = String((req.body && req.body.sessionId) || '').trim();
        // Session ids name a file; keep them to the shape Claude Code emits.
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(sessionId)) {
            return res.status(400).json({ ok: false, error: 'valid sessionId required' });
        }
        try {
            res.json({ ok: true, steps: writeSteps(sessionId, req.body && req.body.steps) });
        } catch (e) {
            res.status(500).json({ ok: false, error: String((e && e.message) || e) });
        }
    });
}

module.exports = { mount, contextFor };
