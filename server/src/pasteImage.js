/**
 * Pasted-image upload.
 *
 * The web terminal can't hand a clipboard image to Claude Code the way a native
 * terminal does. Instead the client POSTs the raw image bytes here; we write
 * them to a temp file on THIS machine (the one running the shell) and return the
 * absolute path. The client then types that path into the prompt — exactly like
 * dragging an image file into Claude Code — so it loads the image by path.
 *
 * This is keybinding- and clipboard-independent, and works from a paired phone
 * too (the phone's clipboard image is uploaded, then referenced by a local path
 * the shell can actually read).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/svg+xml': 'svg',
};

const PASTE_DIR = path.join(os.homedir(), '.soa-web', 'pasted');
// Keep the folder from growing without bound — prune anything older than a day
// on each upload. Cheap, best-effort.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function prune() {
    try {
        const now = Date.now();
        for (const f of fs.readdirSync(PASTE_DIR)) {
            const p = path.join(PASTE_DIR, f);
            try {
                const st = fs.statSync(p);
                if (now - st.mtimeMs > MAX_AGE_MS) fs.unlinkSync(p);
            } catch (_) {}
        }
    } catch (_) {}
}

function mount(app, requireAuthed) {
    app.post(
        '/api/paste-image',
        requireAuthed,
        express.raw({ type: () => true, limit: '30mb' }),
        (req, res) => {
            try {
                const buf = req.body;
                if (!Buffer.isBuffer(buf) || buf.length === 0) {
                    return res.status(400).json({ ok: false, error: 'empty body' });
                }
                const ct = String(req.headers['content-type'] || 'image/png').split(';')[0].trim().toLowerCase();
                if (!ct.startsWith('image/')) {
                    return res.status(415).json({ ok: false, error: 'not an image' });
                }
                const ext = EXT[ct] || 'png';
                fs.mkdirSync(PASTE_DIR, { recursive: true });
                prune();
                const name = `paste-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
                const full = path.join(PASTE_DIR, name);
                fs.writeFileSync(full, buf);
                res.json({ ok: true, path: full, name, bytes: buf.length });
            } catch (err) {
                res.status(500).json({ ok: false, error: err && err.message || 'write failed' });
            }
        },
    );
}

module.exports = { mount, PASTE_DIR };
