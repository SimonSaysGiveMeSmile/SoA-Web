const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');

const STATE_DIR = path.join(os.homedir(), '.soa-web');
const CONFIG_FILE = path.join(STATE_DIR, 'automation.json');

function ensureDir() {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const data = JSON.parse(raw);
        return normalizeConfig(data);
    } catch (_) {
        return normalizeConfig(null);
    }
}

function normalizeConfig(data) {
    const d = data && typeof data === 'object' ? data : {};
    const ac = d.autoCompact && typeof d.autoCompact === 'object' ? d.autoCompact : {};
    return {
        autoCompact: {
            enabled: typeof ac.enabled === 'boolean' ? ac.enabled : false,
            threshold: Math.max(5, Math.min(95, Number(ac.threshold) || 10)),
            cooldownSec: Math.max(30, Math.min(300, Number(ac.cooldownSec) || 60)),
        },
    };
}

function saveConfig(config) {
    ensureDir();
    const full = loadConfig();
    if (config.autoCompact) {
        full.autoCompact = normalizeConfig({ autoCompact: config.autoCompact }).autoCompact;
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(full, null, 2), 'utf8');
    return full;
}

const cooldowns = new Map();
const fallbackTimers = new Map();

function checkAndCompact(tabMgr, tabId, pct) {
    const config = loadConfig();
    if (!config.autoCompact.enabled) return false;
    if (pct < config.autoCompact.threshold) return false;

    const tab = tabMgr.get(tabId);
    if (!tab || tab.exited) return false;

    const now = Date.now();
    const lastCompact = cooldowns.get(tabId) || 0;
    const cooldownMs = config.autoCompact.cooldownSec * 1000;
    if (now - lastCompact < cooldownMs) return false;

    cooldowns.set(tabId, now);
    tab.write('\x0f');

    if (fallbackTimers.has(tabId)) clearTimeout(fallbackTimers.get(tabId));
    fallbackTimers.set(tabId, setTimeout(() => {
        fallbackTimers.delete(tabId);
    }, 10000));

    return true;
}

function reportCtx(tabMgr, tabId, pct) {
    if (fallbackTimers.has(tabId)) {
        if (pct < loadConfig().autoCompact.threshold) {
            clearTimeout(fallbackTimers.get(tabId));
            fallbackTimers.delete(tabId);
            return;
        }
        const tab = tabMgr.get(tabId);
        if (tab && !tab.exited) {
            clearTimeout(fallbackTimers.get(tabId));
            fallbackTimers.delete(tabId);
            tab.write('/compact\r');
        }
        return;
    }
    checkAndCompact(tabMgr, tabId, pct);
}

function mount(app, requireAuthed) {
    const router = express.Router();

    router.get('/api/automation', requireAuthed, (req, res) => {
        res.json({ ok: true, ...loadConfig() });
    });

    router.post('/api/automation', requireAuthed, (req, res) => {
        const saved = saveConfig(req.body || {});
        res.json({ ok: true, ...saved });
    });

    app.use(router);
}

module.exports = { loadConfig, saveConfig, checkAndCompact, reportCtx, mount };
