/**
 * Group meetings — the human-facing REST surface.
 *
 * The user is the manager: they pick which agents are in the room, they open it,
 * and their messages are what keep it going. Those actions arrive from a browser
 * or a paired phone over the tunnel, so unlike the agent-facing half (which
 * rides the loopback-only `/api/sessions` action surface) every route here is
 * cookie-authed and manager-entitled.
 *
 * This module is a thin shell on purpose. All meeting logic — roster resolution,
 * the poke gate, the relay budget, the ledger — lives in `sessionManager.js` and
 * `meetStore.js`, so the CLI, the dashboard, and the phone cannot drift into
 * three different sets of rules.
 *
 * Routes (all requireAuthed + manager entitlement):
 *   GET  /api/meetings                    every room, open first
 *   GET  /api/meetings/:room?since=<seq>  roster + transcript delta
 *   POST /api/meetings                    {op:'start'|'end'|'join'|'leave'}
 *   POST /api/meetings/:room/say          the human's turn
 *
 * Why `say` is one POST and not a fan-out into N terminals: a fan-out would give
 * each agent only the user's text and never each other's, which is exactly the
 * "agents talking past each other" failure a meeting exists to avoid. One append
 * to the shared ledger, then the supervisor tick relays it — so every member
 * sees the same conversation.
 */

const express = require('express');
const sessionManager = require('./sessionManager');
const entitlements = require('./entitlements');

function mount(app, requireAuthed, sessions) {
    const router = express.Router();
    const gateManager = entitlements.requireEntitled('manager');
    const json = express.json({ limit: '16kb' });

    // A phone gets its own cookie session with zero tabs of its own, so
    // `req.session.tabMgr` is empty there and a naive lookup would silently
    // no-op every request from the device most likely to be running the meeting.
    // Fall back to the primary tab-owning session, exactly like tabApi.
    function resolveSession(req) {
        if (req.session && req.session.tabMgr && req.session.tabMgr.order.length) return req.session;
        for (const s of sessions.sessions.values()) {
            if (s.tabMgr && s.tabMgr.order.length > 0) return s;
        }
        if (req.session && req.session.tabMgr) return req.session;
        return null;
    }

    function withManager(req, res) {
        const s = resolveSession(req);
        if (!s) { res.status(503).json({ ok: false, error: 'no active session' }); return null; }
        return sessionManager.ensure(s);
    }

    router.get('/api/meetings', requireAuthed, gateManager, (req, res) => {
        const man = withManager(req, res);
        if (!man) return;
        const rooms = Object.keys(man.state.meetings || {}).map(n => man.meetView(n)).filter(Boolean);
        rooms.sort((a, b) => (b.open - a.open) || (b.createdAt - a.createdAt));
        // The picker needs the candidate agents too, so opening the view is one
        // request rather than a meetings fetch racing a manager fetch.
        const snap = man.snapshot();
        const candidates = snap.sessions.map(s => ({
            id: s.id, title: s.title, cwd: s.cwd, group: s.group,
            status: s.status, ctxPct: s.ctxPct, lifecycle: s.lifecycle, meeting: s.meeting,
        }));
        res.json({ ok: true, rooms, candidates, managerTabId: snap.managerTabId });
    });

    router.get('/api/meetings/:room', requireAuthed, gateManager, (req, res) => {
        const man = withManager(req, res);
        if (!man) return;
        const room = String(req.params.room || '').trim();
        const view = man.meetView(room);
        if (!view) return res.status(404).json({ ok: false, error: 'no such room' });
        const since = Number(req.query.since) || 0;
        const limit = Number(req.query.limit) || 100;
        const { msgs, cursor } = man.meetRead(room, since, limit);
        res.json({ ok: true, room: view, msgs, cursor });
    });

    router.post('/api/meetings', requireAuthed, gateManager, json, (req, res) => {
        const man = withManager(req, res);
        if (!man) return;
        const body = req.body || {};
        const op = String(body.op || 'start');
        const room = String(body.room || '').trim();
        if (op === 'start') {
            // The user picks explicit tab ids in the UI; a cohort selector string
            // is also accepted so the same endpoint serves "meet with everything
            // that needs input".
            let members = Array.isArray(body.members) ? body.members.map(m => (typeof m === 'object' ? m : { id: Number(m) })) : [];
            if (!members.length && body.with) {
                const snap = man.snapshot();
                let ids = sessionManager.resolveCohort(snap, body.with);
                ids = sessionManager.activeOnlyIds(body.with, ids, snap, body.includeInactive);
                members = ids.map(id => ({ id }));
            }
            const r = man.meetStart({ room, title: body.title, mode: body.mode, members, convener: 'user' });
            if (!r.ok) return res.status(r.code ? 409 : 400).json(r);
            return res.json(r);
        }
        if (op === 'end') {
            const r = man.meetEnd(room, body.why || 'closed');
            return res.status(r.ok ? 200 : 404).json(r);
        }
        if (op === 'join' || op === 'leave') {
            const spec = body.cwd ? { cwd: String(body.cwd) } : { id: Number(body.id) };
            const r = op === 'join' ? man.meetJoin(room, spec) : man.meetLeave(room, spec);
            return res.status(r.ok ? 200 : (r.code ? 409 : 404)).json(r);
        }
        res.status(400).json({ ok: false, error: 'bad op — start|end|join|leave' });
    });

    router.post('/api/meetings/:room/say', requireAuthed, gateManager, json, (req, res) => {
        const man = withManager(req, res);
        if (!man) return;
        const room = String(req.params.room || '').trim();
        const r = man.meetSay(room, { who: 'user', text: (req.body || {}).text, via: 'user' });
        // 409 for a policy refusal (adjourned room, spent budget) so the client
        // can show "meeting is over" instead of a generic failure.
        if (!r.ok) return res.status(r.code === 'NO_ROOM' ? 404 : (r.code ? 409 : 400)).json(r);
        res.json({ ok: true, ...r, roomView: man.meetView(room) });
    });

    app.use(router);
}

module.exports = { mount };
