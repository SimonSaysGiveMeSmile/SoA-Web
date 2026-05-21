const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const crypto = require('crypto');

const STATE_DIR = path.join(os.homedir(), '.soa-web');
const PILOT_FILE = path.join(STATE_DIR, 'autopilot.json');

function ensureDir() {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadState() {
    try {
        const raw = fs.readFileSync(PILOT_FILE, 'utf8');
        return normalizeState(JSON.parse(raw));
    } catch (_) {
        return normalizeState(null);
    }
}

function normalizeState(data) {
    const d = data && typeof data === 'object' ? data : {};
    return {
        paused: typeof d.paused === 'boolean' ? d.paused : false,
        schedules: Array.isArray(d.schedules) ? d.schedules.map(normalizeSchedule).filter(Boolean) : [],
        orchestrator: normalizeOrchestrator(d.orchestrator),
    };
}

function normalizeSchedule(s) {
    if (!s || typeof s !== 'object') return null;
    return {
        id: s.id || crypto.randomBytes(6).toString('hex'),
        tabId: Number(s.tabId) || 0,
        message: typeof s.message === 'string' ? s.message.slice(0, 2000) : '',
        intervalMs: Math.max(10000, Math.min(3600000, Number(s.intervalMs) || 300000)),
        enabled: typeof s.enabled === 'boolean' ? s.enabled : true,
        lastFired: Number(s.lastFired) || 0,
    };
}

function normalizeOrchestrator(o) {
    const d = o && typeof o === 'object' ? o : {};
    return {
        enabled: typeof d.enabled === 'boolean' ? d.enabled : false,
        systemPrompt: typeof d.systemPrompt === 'string' ? d.systemPrompt.slice(0, 4000) : '',
        checkIntervalMs: Math.max(15000, Math.min(600000, Number(d.checkIntervalMs) || 30000)),
    };
}

function saveState(state) {
    ensureDir();
    const normalized = normalizeState(state);
    fs.writeFileSync(PILOT_FILE, JSON.stringify(normalized, null, 2), 'utf8');
    return normalized;
}

class AutoPilot {
    constructor() {
        this._tabMgr = null;
        this._agentStatus = null;
        this._timer = null;
        this._orchTimer = null;
    }

    attach(tabMgr, agentStatusFn) {
        this._tabMgr = tabMgr;
        this._agentStatus = agentStatusFn;
        this._startTick();
    }

    detach() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._orchTimer) { clearInterval(this._orchTimer); this._orchTimer = null; }
        this._tabMgr = null;
    }

    _startTick() {
        if (this._timer) clearInterval(this._timer);
        this._timer = setInterval(() => this._tick(), 1000);
        if (this._timer.unref) this._timer.unref();
    }

    _tick() {
        if (!this._tabMgr) return;
        const state = loadState();
        if (state.paused) return;

        const now = Date.now();
        let dirty = false;

        for (const sched of state.schedules) {
            if (!sched.enabled || !sched.message) continue;
            if (now - sched.lastFired < sched.intervalMs) continue;

            const tab = this._tabMgr.get(sched.tabId);
            if (!tab || tab.exited) continue;

            const status = this._agentStatus ? this._agentStatus(sched.tabId) : 'idle';
            if (status === 'working' || status === 'attention') continue;

            tab.write(sched.message + '\r');
            sched.lastFired = now;
            dirty = true;
        }

        if (dirty) saveState(state);
    }

    getState() { return loadState(); }

    addSchedule(sched) {
        const state = loadState();
        const entry = normalizeSchedule({ ...sched, id: crypto.randomBytes(6).toString('hex') });
        if (!entry) return null;
        state.schedules.push(entry);
        saveState(state);
        return entry;
    }

    updateSchedule(id, patch) {
        const state = loadState();
        const idx = state.schedules.findIndex(s => s.id === id);
        if (idx === -1) return null;
        state.schedules[idx] = normalizeSchedule({ ...state.schedules[idx], ...patch, id });
        saveState(state);
        return state.schedules[idx];
    }

    removeSchedule(id) {
        const state = loadState();
        state.schedules = state.schedules.filter(s => s.id !== id);
        saveState(state);
        return true;
    }

    setOrchestrator(config) {
        const state = loadState();
        state.orchestrator = normalizeOrchestrator({ ...state.orchestrator, ...config });
        saveState(state);
        return state.orchestrator;
    }

    setPaused(paused) {
        const state = loadState();
        state.paused = !!paused;
        saveState(state);
        return state.paused;
    }
}

const instance = new AutoPilot();

function mount(app, requireAuthed) {
    const router = express.Router();

    router.get('/api/autopilot', requireAuthed, (req, res) => {
        res.json({ ok: true, ...instance.getState() });
    });

    router.post('/api/autopilot/schedules', requireAuthed, (req, res) => {
        const { id, ...body } = req.body || {};
        if (id) {
            const updated = instance.updateSchedule(id, body);
            if (!updated) return res.status(404).json({ ok: false, error: 'schedule not found' });
            return res.json({ ok: true, schedule: updated });
        }
        const entry = instance.addSchedule(body);
        if (!entry) return res.status(400).json({ ok: false, error: 'invalid schedule' });
        res.json({ ok: true, schedule: entry });
    });

    router.delete('/api/autopilot/schedules/:id', requireAuthed, (req, res) => {
        instance.removeSchedule(req.params.id);
        res.json({ ok: true });
    });

    router.post('/api/autopilot/orchestrator', requireAuthed, (req, res) => {
        const orch = instance.setOrchestrator(req.body || {});
        res.json({ ok: true, orchestrator: orch });
    });

    router.post('/api/autopilot/pause', requireAuthed, (req, res) => {
        const paused = instance.setPaused(true);
        res.json({ ok: true, paused });
    });

    router.post('/api/autopilot/resume', requireAuthed, (req, res) => {
        const paused = instance.setPaused(false);
        res.json({ ok: true, paused });
    });

    app.use(router);
}

module.exports = { AutoPilot, instance, mount };

