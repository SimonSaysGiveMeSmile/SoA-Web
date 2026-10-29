'use strict';
// Optional local administrative upgrade for an older running daemon. Preserve
// its PTYs, tunnel, timers and other in-memory upgrades until a normal restart.
const { AsyncLocalStorage } = require('node:async_hooks');

function install({ app, SessionManager, metadata }) {
    if (app._soaSessionStatus) return app._soaSessionStatus;
    const prototype = SessionManager?.prototype;
    const route = app._router?.stack.find(layer => layer.route?.path === '/api/fleet/status' && layer.route.methods.get)?.route;
    const handler = route?.stack.at(-1);
    if (typeof prototype?.snapshot !== 'function' || !handler || typeof metadata?.forTab !== 'function') {
        throw new Error('Incompatible session status upgrade');
    }
    const originalSnapshot = prototype.snapshot, originalHandler = handler.handle;
    const reads = new AsyncLocalStorage();
    const fields = row => ({ agent: row.agent, model: row.model, effort: row.effort,
        modelSource: row.modelSource, modelObservedAt: row.modelObservedAt });
    function snapshot(...args) {
        const previous = originalSnapshot.apply(this, args);
        const sessions = previous.sessions.map(row => {
            const tab = this.session.tabMgr.get(row.id);
            return { ...row, ...metadata.forTab(tab, row) };
        });
        const current = reads.getStore();
        if (current) for (const row of sessions) current.set(row.id, fields(row));
        return { ...previous, sessions, counts: { ...previous.counts, codex: sessions.filter(row => row.agent === 'codex').length } };
    }
    function status(req, res, next) {
        // Retain the old route's session selection and every auth middleware.
        // Its response whitelist predates the provider/source fields, so add
        // them from the snapshot produced INSIDE this particular request.
        const current = new Map(), json = res.json;
        res.json = function(body) {
            res.json = json;
            if (Array.isArray(body?.sessions)) body = { ...body,
                sessions: body.sessions.map(row => ({ ...row, ...current.get(row.id) })) };
            return json.call(this, body);
        };
        return reads.run(current, () => {
            try { return originalHandler.call(this, req, res, next); }
            catch (error) { res.json = json; throw error; }
        });
    }
    prototype.snapshot = snapshot;
    handler.handle = status;
    const result = app._soaSessionStatus = { version: 1, installedAt: new Date().toISOString() };
    app._soaSessionStatusRollback = () => {
        if (prototype.snapshot === snapshot) prototype.snapshot = originalSnapshot;
        if (handler.handle === status) handler.handle = originalHandler;
        metadata.close?.();
        reads.disable();
        delete app._soaSessionStatus;
        delete app._soaSessionStatusRollback;
    };
    return result;
}

module.exports = { install };
