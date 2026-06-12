/**
 * Text-to-speech relay.
 *
 * Claude Code has no spoken output. To give SoA a "talk to me" mode we install
 * a Claude Code **Stop hook** (scripts/soa-tts-hook.mjs) that fires when Claude
 * finishes a turn, reads the final assistant message from the transcript, and
 * POSTs it here. We then push a `tts` frame to every browser in the session;
 * the client speaks it with the Web Speech API (speechSynthesis).
 *
 * Per-tab wiring: each PTY gets SOA_WEB_TTS_URL and SOA_WEB_TAB in its env (see
 * envFor), so the hook — which runs as a child of the shell — knows where to
 * post and which tab it belongs to. The client uses the tab id to decide
 * whether to speak (active tab only, or all tabs, per a user setting).
 */

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MSG, frame } = require('./protocol');

let _port = null;

// Discovery file so the Stop hook and `soa-msg` can find us even when a shell
// missed the SOA_WEB_TTS_URL env injection (restored tabs, tabs that predate
// the feature, env not inherited). This is what makes "the agent texts you"
// reliable rather than dependent on per-PTY env.
const BRIDGE_FILE = require('./stateDir').stateFile('bridge.json');
function setPort(p) {
    _port = p;
    try {
        fs.mkdirSync(path.dirname(BRIDGE_FILE), { recursive: true });
        fs.writeFileSync(BRIDGE_FILE, JSON.stringify({
            port: p,
            ttsUrl: `http://127.0.0.1:${p}/api/tts`,
            updatedAt: Date.now(),
        }));
    } catch (_) { /* best-effort */ }
}

// Env injected into every PTY so the Stop hook can reach us. Empty until the
// server is listening (no port yet) — the hook no-ops when the URL is absent.
function envFor(tabId) {
    if (!_port) return {};
    return {
        SOA_WEB_TAB: String(tabId),
        SOA_WEB_TTS_URL: `http://127.0.0.1:${_port}/api/tts`,
    };
}

function isLoopback(req) {
    const ip = (req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function mount(app, sessions) {
    // The hook posts from localhost only. No session token is required — we
    // bind to loopback and broadcast to every live session (in practice the
    // desktop + paired phone share one session).
    app.post('/api/tts', express.json({ limit: '512kb' }), (req, res) => {
        if (!isLoopback(req)) return res.status(403).json({ ok: false, error: 'loopback only' });
        const body = req.body || {};
        let text = typeof body.text === 'string' ? body.text : '';
        text = text.replace(/\s+/g, ' ').trim().slice(0, 4000);
        if (!text) return res.json({ ok: true, skipped: 'empty' });
        const tab = body.tab != null ? Number(body.tab) : null;
        const payload = frame(MSG.TTS, { text, tab });
        let delivered = 0;
        for (const s of sessions.sessions.values()) {
            if (s.send(payload)) delivered++;
        }
        res.json({ ok: true, delivered });
    });
}

module.exports = { mount, setPort, envFor };
