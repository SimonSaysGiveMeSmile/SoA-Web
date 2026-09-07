/**
 * WorkspaceTransfer
 *
 * Moves a whole workspace — every tab (title, cwd, order), its scrollback,
 * and each tab's latest Claude Code conversation transcript — from this
 * SoA install to another one, wirelessly, over the existing tunnel link.
 *
 * Flow (no new auth surface, no cloud storage):
 *
 *   SOURCE   POST /api/workspace/export        (cookie-authed, the SPA)
 *            → snapshots the live session into a gzipped JSON bundle held
 *              IN MEMORY, minted under a one-time 256-bit token, and returns
 *              a share link:  <publicUrl>/api/workspace/bundle/<token>
 *
 *   TARGET   POST /api/workspace/import {url}  (cookie-authed, the SPA)
 *            → the *target daemon* fetches the bundle over the tunnel,
 *              installs each Claude transcript under
 *              ~/.claude/projects/<enc(cwd)>/<sessionId>.jsonl (never
 *              overwriting an existing file), opens the tabs with their
 *              scrollback seeded, and auto-resumes Claude in every tab whose
 *              project folder exists on this machine.
 *
 *   ANYONE   GET /api/workspace/bundle/:token  — token IS the auth
 *            (constant-time compared, short TTL, few downloads, then gone).
 *            index.js exempts this one path from the SOA_WEB_SESSION_TOKEN
 *            gate: the receiving device can't know that token, and the
 *            one-time bundle token is strictly stronger.
 *
 * The bundle carries the source homedir so cwds under it are remapped to the
 * target's homedir (Users differ across machines); transcripts get the same
 * one-string "cwd" rewrite so `claude --resume` picks them up in the mapped
 * project dir. Project FILES are not copied — tabs whose cwd doesn't exist on
 * the target open in $HOME with their scrollback intact, and the report says
 * so (sync the repo, reopen, resume still works: the transcript is installed).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const claudeSessions = require('./claudeSessions');
const sessionManager = require('./sessionManager');
const { MSG, frame } = require('./protocol');
const tabPersist = require('./tabPersist');
const envStore = require('./envStore');
const { stateFile } = require('./stateDir');

const BUNDLE_KIND = 'soa-workspace';
const BUNDLE_VERSION = 1;
const BUNDLE_TTL_MS = 15 * 60 * 1000;   // link lives 15 minutes
const BUNDLE_MAX_DOWNLOADS = 3;         // survives a couple of botched fetches
const MAX_SCROLLBACK_PER_TAB = 128 * 1024;        // mirror tabPersist's on-disk cap
const MAX_TRANSCRIPT_BYTES = 24 * 1024 * 1024;    // per-conversation cap (raw jsonl)
const MAX_BUNDLE_RAW_BYTES = 256 * 1024 * 1024;   // whole-bundle safety valve
const IMPORT_FETCH_TIMEOUT_MS = 120 * 1000;
const RESUME_STAGGER_MS = 1500;         // match index.js scheduleAutoResume

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Claude Code's project-dir encoding of a cwd (see claudeSessions.js: lossy,
// every non-alphanumeric becomes '-'; `/Users/me/.soa-web` → `-Users-me--soa-web`).
function encodeCwd(cwd) { return String(cwd).replace(/[^a-zA-Z0-9]/g, '-'); }

// Same reset bracket index.js wraps replayed scrollback in, so a transferred
// tab can't re-arm mouse-tracking/alt-screen modes the source TUI left on.
const SANE_TERM_RESET =
    '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1049l\x1b[?2004l\x1b[?25h\x1b>';

// ── One-time bundle store (one live bundle at a time) ───────────────────────
let _bundle = null; // { token, gz, createdAt, downloads, meta }

function _bundleAlive() {
    if (!_bundle) return false;
    if (Date.now() - _bundle.createdAt > BUNDLE_TTL_MS) { _bundle = null; return false; }
    if (_bundle.downloads >= BUNDLE_MAX_DOWNLOADS) { _bundle = null; return false; }
    return true;
}

function _tokenMatches(presented) {
    if (!_bundleAlive() || typeof presented !== 'string') return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(_bundle.token);
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(a, b); } catch (_) { return false; }
}

// ── Export ───────────────────────────────────────────────────────────────────
function buildBundle(session) {
    const mgr = session.tabMgr;
    let sessionsByCwd = new Map();
    try { sessionsByCwd = claudeSessions.latestSessionByCwd(72); } catch (_) {}

    const tabs = [];
    const skippedTranscripts = [];
    let rawBytes = 0;
    const transcriptDone = new Set(); // one transcript per cwd, not per tab

    for (const id of mgr.order) {
        const tab = mgr.tabs.get(id);
        if (!tab) continue;
        let scrollback = '';
        try { scrollback = tab.scrollback ? tab.scrollback.snapshot() : ''; } catch (_) {}
        if (scrollback.length > MAX_SCROLLBACK_PER_TAB) {
            scrollback = scrollback.slice(scrollback.length - MAX_SCROLLBACK_PER_TAB);
        }
        const entry = {
            title: tab.userRenamed ? tab.title : null,
            userRenamed: !!tab.userRenamed,
            cwd: tab.cwd || null,
            active: session.activeTab === id,
            scrollback,
            claude: null,
        };
        rawBytes += scrollback.length;

        const hit = tab.cwd ? sessionsByCwd.get(tab.cwd) : null;
        if (hit) {
            entry.claude = { sessionId: hit.sessionId, transcript: null };
            if (!transcriptDone.has(tab.cwd)) {
                transcriptDone.add(tab.cwd);
                const file = path.join(PROJECTS_DIR, encodeCwd(tab.cwd), hit.sessionId + '.jsonl');
                try {
                    const st = fs.statSync(file);
                    if (st.size > MAX_TRANSCRIPT_BYTES || rawBytes + st.size > MAX_BUNDLE_RAW_BYTES) {
                        skippedTranscripts.push({ cwd: tab.cwd, sessionId: hit.sessionId, bytes: st.size, reason: 'too large' });
                    } else {
                        entry.claude.transcript = fs.readFileSync(file, 'utf8');
                        rawBytes += st.size;
                    }
                } catch (_) { /* transcript unreadable → sessionId only */ }
            }
        }
        tabs.push(entry);
    }

    return {
        kind: BUNDLE_KIND,
        version: BUNDLE_VERSION,
        host: os.hostname(),
        homedir: os.homedir(),
        savedAt: new Date().toISOString(),
        tabs,
        skippedTranscripts,
    };
}

function resolvePublicUrl(pair, req) {
    try {
        const snap = pair && pair.snapshot && pair.snapshot();
        if (snap && snap.publicUrl) return snap.publicUrl;
    } catch (_) {}
    try {
        const t = JSON.parse(fs.readFileSync(stateFile('tunnel.json'), 'utf8'));
        if (t && t.url) return t.url;
    } catch (_) {}
    const host = req.get('host');
    return host ? `${req.protocol}://${host}` : null;
}

// ── Import ───────────────────────────────────────────────────────────────────
function mapCwd(cwd, srcHome, dstHome) {
    if (!cwd || !srcHome || srcHome === dstHome) return cwd;
    if (cwd === srcHome) return dstHome;
    if (cwd.startsWith(srcHome + path.sep)) return dstHome + cwd.slice(srcHome.length);
    return cwd;
}

// Install one transcript under the target's encoded project dir. Never
// overwrites: an existing same-session file on this machine is newer truth.
function installTranscript(srcCwd, dstCwd, sessionId, transcript) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return { installed: false, reason: 'bad session id' };
    const dir = path.join(PROJECTS_DIR, encodeCwd(dstCwd));
    const file = path.join(dir, sessionId + '.jsonl');
    if (fs.existsSync(file)) return { installed: false, reason: 'already present' };
    let body = transcript;
    if (srcCwd !== dstCwd) {
        // Precise, minimal remap: only the exact "cwd":"<src>" JSON pairs.
        body = body.split(JSON.stringify({ cwd: srcCwd }).slice(1, -1)).join(JSON.stringify({ cwd: dstCwd }).slice(1, -1));
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body, { mode: 0o600 });
    return { installed: true };
}

async function fetchBundle(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), IMPORT_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: ctl.signal,
            redirect: 'follow',
            headers: {
                // The source may sit behind ngrok's free tier: this header skips
                // the browser interstitial that would otherwise replace the bytes.
                'ngrok-skip-browser-warning': '1',
                'user-agent': 'soa-web-workspace-transfer',
            },
        });
        if (!res.ok) throw new Error(`source answered ${res.status}${res.status === 404 ? ' — link expired or already used?' : ''}`);
        const gz = Buffer.from(await res.arrayBuffer());
        const raw = zlib.gunzipSync(gz, { maxOutputLength: MAX_BUNDLE_RAW_BYTES + (64 << 20) });
        const bundle = JSON.parse(raw.toString('utf8'));
        if (!bundle || bundle.kind !== BUNDLE_KIND || !Array.isArray(bundle.tabs)) {
            throw new Error('not a SoA workspace bundle');
        }
        if (bundle.version > BUNDLE_VERSION) {
            throw new Error(`bundle version ${bundle.version} is newer than this install understands (${BUNDLE_VERSION}) — update SoA here first`);
        }
        return bundle;
    } finally {
        clearTimeout(timer);
    }
}

function importBundle(session, bundle) {
    const dstHome = os.homedir();
    const srcHome = typeof bundle.homedir === 'string' ? bundle.homedir : null;
    const shellEnv = envStore.getEnvForShell();
    const report = { imported: 0, resumed: 0, transcripts: 0, missingCwd: [], skipped: [] };
    const toResume = [];
    let activate = null;

    for (const entry of bundle.tabs) {
        if (!entry || typeof entry !== 'object') continue;
        const srcCwd = typeof entry.cwd === 'string' ? entry.cwd : null;
        const dstCwd = srcCwd ? mapCwd(srcCwd, srcHome, dstHome) : null;
        const cwdExists = !!(dstCwd && fs.existsSync(dstCwd));
        if (dstCwd && !cwdExists) report.missingCwd.push(dstCwd);

        if (srcCwd && entry.claude && entry.claude.sessionId && typeof entry.claude.transcript === 'string') {
            try {
                const r = installTranscript(srcCwd, dstCwd, entry.claude.sessionId, entry.claude.transcript);
                if (r.installed) report.transcripts++;
                else if (r.reason !== 'already present') report.skipped.push(`${dstCwd}: transcript ${r.reason}`);
            } catch (e) {
                report.skipped.push(`${dstCwd}: transcript write failed (${(e && e.message) || e})`);
            }
        }

        const label = entry.userRenamed && entry.title ? entry.title : (dstCwd || 'tab');
        const note = cwdExists
            ? 'workspace transferred from ' + (bundle.host || 'another device')
            : `project folder missing on this device (${dstCwd || 'unknown'}) — opened in $HOME`;
        const sb = typeof entry.scrollback === 'string' ? entry.scrollback : '';
        const seed = sb
            ? SANE_TERM_RESET + sb + `\r\n\x1b[2m── ${label} · ${note} ──\x1b[0m\r\n` + SANE_TERM_RESET
            : '';
        const tab = session.tabMgr.open({
            title: entry.userRenamed && entry.title ? entry.title : undefined,
            cwd: cwdExists ? dstCwd : undefined,
            env: shellEnv,
            silent: true,
            seedScrollback: seed || undefined,
        });
        if (!tab) { report.skipped.push(`${label}: tab open failed`); continue; }
        report.imported++;
        if (entry.active) activate = tab.id;
        if (cwdExists && entry.claude && entry.claude.sessionId) {
            toResume.push({ tab, cwd: dstCwd, sessionId: entry.claude.sessionId });
        }
    }

    // Resume like boot-restore does: staggered, resume→continue chain, never a
    // bare cold `claude` (which would start a fresh session over the context).
    toResume.forEach(({ tab, cwd, sessionId }, i) => {
        setTimeout(() => {
            try { sessionManager.launchClaude(tab, cwd, { resume: true, sessionId, coldFallback: false }); } catch (_) {}
        }, 1200 + i * RESUME_STAGGER_MS);
    });
    report.resumed = toResume.length;

    if (activate != null) session.activeTab = activate;
    tabPersist.save(session.tabMgr);
    return report;
}

// ── Routes ───────────────────────────────────────────────────────────────────
function mount(app, requireAuthed, sessions, { pair } = {}) {
    function resolveSession(req) {
        if (req.session && req.session.tabMgr) return req.session;
        for (const s of sessions.sessions.values()) {
            if (s.tabMgr) return s;
        }
        return null;
    }

    app.post('/api/workspace/export', requireAuthed, (req, res) => {
        const s = resolveSession(req);
        if (!s || !s.tabMgr.order.length) {
            return res.status(503).json({ ok: false, error: 'no live workspace to export' });
        }
        let bundle, gz;
        try {
            bundle = buildBundle(s);
            gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 6 });
        } catch (e) {
            return res.status(500).json({ ok: false, error: 'export failed: ' + ((e && e.message) || e) });
        }
        const token = crypto.randomBytes(32).toString('base64url');
        _bundle = { token, gz, createdAt: Date.now(), downloads: 0 };
        const base = resolvePublicUrl(pair, req);
        const pathPart = '/api/workspace/bundle/' + token;
        console.log(`workspace-transfer: exported ${bundle.tabs.length} tab(s), ${gz.length} bytes gz (link valid ${BUNDLE_TTL_MS / 60000}m)`);
        res.json({
            ok: true,
            url: base ? base.replace(/\/$/, '') + pathPart : pathPart,
            expiresAt: new Date(_bundle.createdAt + BUNDLE_TTL_MS).toISOString(),
            tabs: bundle.tabs.length,
            transcripts: bundle.tabs.filter(t => t.claude && t.claude.transcript).length,
            skippedTranscripts: bundle.skippedTranscripts,
            bytes: gz.length,
        });
    });

    app.post('/api/workspace/export/revoke', requireAuthed, (req, res) => {
        _bundle = null;
        res.json({ ok: true });
    });

    // Token-authed download — the token in the path is the whole credential.
    app.get('/api/workspace/bundle/:token', (req, res) => {
        if (!_tokenMatches(req.params.token)) {
            return res.status(404).json({ ok: false, error: 'no such bundle (expired, used up, or revoked)' });
        }
        _bundle.downloads++;
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Length', _bundle.gz.length);
        res.setHeader('Cache-Control', 'no-store');
        res.end(_bundle.gz);
    });

    app.post('/api/workspace/import', requireAuthed, async (req, res) => {
        const url = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
        if (!/^https?:\/\/[^\s]+\/api\/workspace\/bundle\/[A-Za-z0-9_-]+$/.test(url)) {
            return res.status(400).json({ ok: false, error: 'that does not look like a SoA transfer link' });
        }
        const s = resolveSession(req);
        if (!s) return res.status(503).json({ ok: false, error: 'no active session to import into' });
        let bundle;
        try {
            bundle = await fetchBundle(url);
        } catch (e) {
            const msg = e && e.name === 'AbortError' ? 'timed out fetching the bundle' : ((e && e.message) || String(e));
            return res.status(502).json({ ok: false, error: 'could not fetch bundle: ' + msg });
        }
        try {
            const report = importBundle(s, bundle);
            // Live clients learn about the new tabs the same way a tab-API open
            // does — one SNAPSHOT frame, then scrollback replays lazily.
            try {
                s.send(frame(MSG.SNAPSHOT, {
                    tabs: s.tabMgr.list(),
                    activeId: s.activeTab,
                    graveyard: s.tabMgr.graveyardList(),
                }));
            } catch (_) {}
            console.log(`workspace-transfer: imported ${report.imported} tab(s) from ${bundle.host || 'unknown host'} (${report.transcripts} transcript(s), ${report.resumed} resume(s) armed)`);
            res.json({ ok: true, from: bundle.host || null, savedAt: bundle.savedAt || null, ...report });
        } catch (e) {
            res.status(500).json({ ok: false, error: 'import failed: ' + ((e && e.message) || e) });
        }
    });
}

module.exports = { mount, encodeCwd, mapCwd, buildBundle, importBundle, _tokenMatches };
