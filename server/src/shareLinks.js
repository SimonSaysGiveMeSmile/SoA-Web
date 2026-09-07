/**
 * shareLinks — HTTP surface for creating/revoking read-only per-tab share links
 * and serving the viewer page. Mounted only when SHARE is enabled; entirely
 * additive (a new /share/* + /api/share/* route subtree). Never touches the
 * existing WS/PTY/auth paths.
 */

const express = require('express');
const path = require('path');
const shareRegistry = require('./shareRegistry');

// opts: { requireAuthed, publicDir }
function mount(app, opts) {
    const { requireAuthed, publicDir, closeViewersForShare } = opts;

    // Owner mints a read-only share for one of THEIR tabs. requireAuthed puts
    // the owning session on req.session, so a share can only ever point at a tab
    // the caller actually owns.
    app.post('/api/share/create', requireAuthed, express.json({ limit: '4kb' }), (req, res) => {
        const tabId = Number(req.body && req.body.tabId);
        if (!Number.isFinite(tabId)) return res.status(400).json({ ok: false, error: 'tabId required' });
        const session = req.session;
        if (!session || !session.tabMgr || !session.tabMgr.get(tabId)) {
            return res.status(404).json({ ok: false, error: 'no such tab in your session' });
        }
        const rec = shareRegistry.create({ sessionId: session.id, tabId, mode: 'read' });
        res.json({
            ok: true,
            shareId: rec.shareId,
            path: `/share/${rec.shareId}?st=${encodeURIComponent(rec.token)}`,
            expiresAt: rec.expiresAt,
        });
    });

    app.post('/api/share/revoke', requireAuthed, express.json({ limit: '2kb' }), (req, res) => {
        const shareId = String((req.body && req.body.shareId) || '');
        // Only the OWNING session may revoke; then cut any live viewer sockets.
        const meta = shareRegistry.getMeta(shareId);
        if (!meta || meta.sessionId !== req.session.id) return res.status(404).json({ ok: false, error: 'no such share' });
        const ok = shareRegistry.revoke(shareId);
        const closed = (ok && typeof closeViewersForShare === 'function') ? closeViewersForShare(shareId) : 0;
        res.json({ ok, closed });
    });

    app.get('/api/shares', requireAuthed, (req, res) => {
        const list = shareRegistry.listFor(req.session.id).map(r => ({
            shareId: r.shareId, tabId: r.tabId, mode: r.mode, expiresAt: r.expiresAt,
        }));
        res.json({ ok: true, shares: list });
    });

    // The read-only viewer page. Public (the token in the URL is the auth); the
    // page reads shareId from the path + token from ?st= and opens the WS.
    app.get('/share/:shareId', (req, res) => {
        res.sendFile(path.join(publicDir, 'share.html'));
    });
}

module.exports = { mount };
