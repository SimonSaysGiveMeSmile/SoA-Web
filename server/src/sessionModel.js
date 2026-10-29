'use strict';
// A folder is not a session: sibling Claude/Codex tabs can share a cwd while
// using different models. Resolve exact identities and cache by provider + ID.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const identity = require('./sessionIdentity');
const { CodexSessionStatus } = require('./codexSessionStatus');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORT = /^(?:none|minimal|low|medium|high|xhigh|max|ultra|ultracode)$/i;
const encodeCwd = cwd => String(cwd).replace(/[^A-Za-z0-9]/g, '-');
const cleanModel = value => typeof value === 'string' && value.length <= 160 && !/[\x00-\x1f<>]/.test(value) ? value : null;

function lastModel(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - 1024 * 1024);
        const buffer = Buffer.alloc(size - start);
        const count = fs.readSync(fd, buffer, 0, buffer.length, start);
        const lines = buffer.toString('utf8', 0, count).split('\n');
        if (start) lines.shift();
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].includes('"model"')) continue;
            let row;
            try { row = JSON.parse(lines[i]); } catch (_) { continue; }
            if (row.type !== 'assistant') continue;
            const model = cleanModel(row.message?.model);
            if (model && /^claude[-.]/i.test(model)) return model;
        }
    } catch (_) { /* Unknown is preferable to another tab's model. */ }
    finally { if (fd != null) fs.closeSync(fd); }
    return null;
}

class SessionModels {
    constructor({ projectsDir = path.join(os.homedir(), '.claude', 'projects'),
        readCodex, now = Date.now, ttl = 5000, observe = true } = {}) {
        this.projectsDir = projectsDir;
        this.now = now;
        this.ttl = ttl;
        this.observe = observe;
        this.cache = new Map();
        this.client = readCodex ? null : new CodexSessionStatus();
        this.readCodex = readCodex || (id => this.client.read(id));
        this.identityAt = -Infinity;
        this.identityBusy = false;
    }

    _identity(tab, state) {
        if (this.observe && tab?.pty?.pid && this.now() - this.identityAt >= 15000 && !this.identityBusy) {
            this.identityAt = this.now();
            this.table = identity.processTable();
            this.identityBusy = true;
            identity.claudeAgents(registry => { this.registry = registry; this.identityBusy = false; });
        }
        const observed = this.observe && tab?.pty?.pid && this.table
            ? identity.observe(tab.pty.pid, this.table, this.registry) : null;
        const agent = observed?.agent || tab?.agent || state?.agent || null;
        // An observed provider switch invalidates the old provider's saved ID.
        const sessionId = observed?.sessionId ||
            ((!observed || observed.agent === tab?.agent) ? tab?.sessionId : null);
        return { agent, sessionId: UUID.test(sessionId || '') ? sessionId : null };
    }

    forTab(tab, state = {}) {
        const { agent, sessionId } = this._identity(tab, state);
        const empty = { agent, model: null, effort: agent === 'claude' && EFFORT.test(state.effort || '') ? state.effort : null,
            modelSource: null, modelObservedAt: null };
        if (!sessionId || (agent !== 'claude' && agent !== 'codex')) return empty;
        const key = agent + ':' + sessionId;
        const now = this.now();
        let cached = this.cache.get(key);
        if (agent === 'claude') {
            if (!tab?.cwd) return empty;
            const file = path.join(this.projectsDir, encodeCwd(tab.cwd), sessionId + '.jsonl');
            if (!cached || cached.file !== file || now - cached.checkedAt >= this.ttl) {
                let stat;
                try { stat = fs.statSync(file); } catch (_) {}
                const unchanged = stat && cached?.file === file && cached.mtime === stat.mtimeMs && cached.size === stat.size;
                const model = unchanged ? cached.model : (stat ? lastModel(file) : null);
                cached = { file, model, checkedAt: now, mtime: stat?.mtimeMs, size: stat?.size,
                    observedAt: model ? (unchanged ? cached.observedAt : now) : null };
                this.cache.set(key, cached);
            }
            return { ...empty, model: cached.model, modelSource: cached.model ? 'claude-transcript' : null, modelObservedAt: cached.observedAt };
        }
        if (!cached) {
            cached = { model: null, effort: null, checkedAt: -Infinity, observedAt: null, pending: null };
            this.cache.set(key, cached);
        }
        if (!cached.pending && now - cached.checkedAt >= this.ttl) {
            cached.checkedAt = now;
            cached.pending = Promise.resolve().then(() => this.readCodex(sessionId)).then(thread => {
                if (thread?.id !== sessionId) throw new Error('Mismatched Codex session');
                const model = cleanModel(thread.model);
                cached.model = model && !/^claude[-.]/i.test(model) ? model : null;
                cached.effort = EFFORT.test(thread.reasoningEffort || '') && thread.reasoningEffort !== 'ultracode'
                    ? thread.reasoningEffort : null;
                cached.observedAt = this.now();
            }).catch(() => {
                // Do not present stale telemetry as current after source failure.
                cached.model = null;
                cached.effort = null;
                cached.observedAt = null;
            }).finally(() => { cached.pending = null; });
        }
        return { ...empty, model: cached.model, effort: cached.effort,
            modelSource: cached.model ? 'codex-thread' : null, modelObservedAt: cached.observedAt };
    }

    async settle() { await Promise.all([...this.cache.values()].map(c => c.pending).filter(Boolean)); }
    close() { this.client?.close(); }
}

const models = new SessionModels();
module.exports = { forTab: (tab, state) => models.forTab(tab, state), SessionModels, encodeCwd, lastModel };
