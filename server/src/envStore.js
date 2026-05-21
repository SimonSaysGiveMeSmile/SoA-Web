const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');

const STATE_DIR = path.join(os.homedir(), '.soa-web');
const ENV_FILE = path.join(STATE_DIR, 'env.json');

function ensureDir() {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function load() {
    try {
        const raw = fs.readFileSync(ENV_FILE, 'utf8');
        const data = JSON.parse(raw);
        return normalize(data);
    } catch (_) {
        return normalize(null);
    }
}

function normalize(data) {
    const d = data && typeof data === 'object' ? data : {};
    return {
        claude: {
            baseUrl: typeof (d.claude && d.claude.baseUrl) === 'string' ? d.claude.baseUrl : '',
            apiKey: typeof (d.claude && d.claude.apiKey) === 'string' ? d.claude.apiKey : '',
        },
        custom: Array.isArray(d.custom)
            ? d.custom.filter(e => e && typeof e.key === 'string' && typeof e.value === 'string')
            : [],
    };
}

function save(config) {
    ensureDir();
    const data = normalize(config);
    fs.writeFileSync(ENV_FILE, JSON.stringify(data, null, 2), 'utf8');
    return data;
}

function getEnvForShell() {
    const config = load();
    const env = {};
    if (config.claude.baseUrl) env.ANTHROPIC_BASE_URL = config.claude.baseUrl;
    if (config.claude.apiKey) env.ANTHROPIC_API_KEY = config.claude.apiKey;
    for (const { key, value } of config.custom) {
        if (key && key.trim()) env[key.trim()] = value;
    }
    return env;
}

function maskKey(key) {
    if (!key || key.length < 8) return key ? '****' : '';
    return '****' + key.slice(-4);
}

function mount(app, requireAuthed) {
    const router = express.Router();

    router.get('/api/env', requireAuthed, (req, res) => {
        const config = load();
        res.json({
            ok: true,
            claude: {
                baseUrl: config.claude.baseUrl,
                apiKey: maskKey(config.claude.apiKey),
                hasKey: !!config.claude.apiKey,
            },
            custom: config.custom,
        });
    });

    router.post('/api/env', requireAuthed, (req, res) => {
        const body = req.body || {};
        const current = load();
        const next = {
            claude: {
                baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : current.claude.baseUrl,
                apiKey: typeof body.apiKey === 'string' ? body.apiKey : current.claude.apiKey,
            },
            custom: Array.isArray(body.custom) ? body.custom : current.custom,
        };
        const saved = save(next);
        res.json({
            ok: true,
            claude: {
                baseUrl: saved.claude.baseUrl,
                apiKey: maskKey(saved.claude.apiKey),
                hasKey: !!saved.claude.apiKey,
            },
            custom: saved.custom,
        });
    });

    app.use(router);
}

module.exports = { load, save, getEnvForShell, mount };

