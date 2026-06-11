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

function normalizeProvider(p) {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name.trim()) return null;
    return {
        id: typeof p.id === 'string' && p.id ? p.id : p.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: p.name.trim().slice(0, 60),
        baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '',
        token: typeof p.token === 'string' ? p.token.trim() : '',
        // Proxies usually want ANTHROPIC_AUTH_TOKEN (bearer); the official API
        // uses ANTHROPIC_API_KEY. Stored per provider so both kinds work.
        tokenVar: p.tokenVar === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN',
        model: typeof p.model === 'string' ? p.model.trim() : '',
    };
}

function normalize(data) {
    const d = data && typeof data === 'object' ? data : {};
    const providers = Array.isArray(d.providers) ? d.providers.map(normalizeProvider).filter(Boolean) : [];
    return {
        claude: {
            baseUrl: typeof (d.claude && d.claude.baseUrl) === 'string' ? d.claude.baseUrl : '',
            apiKey: typeof (d.claude && d.claude.apiKey) === 'string' ? d.claude.apiKey : '',
        },
        custom: Array.isArray(d.custom)
            ? d.custom.filter(e => e && typeof e.key === 'string' && typeof e.value === 'string')
            : [],
        // Named model-access profiles. active='' = subscription: no injection
        // beyond legacy claude{} settings — new shells inherit the login session.
        providers,
        active: typeof d.active === 'string' && providers.some(p => p.id === d.active) ? d.active : '',
    };
}

function save(config) {
    ensureDir();
    const data = normalize(config);
    fs.writeFileSync(ENV_FILE, JSON.stringify(data, null, 2), 'utf8');
    return data;
}

function activeProvider(config) {
    const c = config || load();
    return c.active ? c.providers.find(p => p.id === c.active) || null : null;
}

function getEnvForShell() {
    const config = load();
    const env = {};
    // Legacy single-endpoint settings first, then the active provider profile
    // overrides — switching providers in Settings wins over old env.json fields.
    if (config.claude.baseUrl) env.ANTHROPIC_BASE_URL = config.claude.baseUrl;
    if (config.claude.apiKey) env.ANTHROPIC_API_KEY = config.claude.apiKey;
    const p = activeProvider(config);
    if (p) {
        if (p.baseUrl) env.ANTHROPIC_BASE_URL = p.baseUrl;
        if (p.token) env[p.tokenVar] = p.token;
        if (p.model) env.ANTHROPIC_MODEL = p.model;
    }
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

    function publicView(config) {
        return {
            ok: true,
            claude: {
                baseUrl: config.claude.baseUrl,
                apiKey: maskKey(config.claude.apiKey),
                hasKey: !!config.claude.apiKey,
            },
            custom: config.custom,
            active: config.active,
            providers: config.providers.map(p => ({
                id: p.id, name: p.name, baseUrl: p.baseUrl,
                token: maskKey(p.token), hasToken: !!p.token,
                tokenVar: p.tokenVar, model: p.model,
            })),
        };
    }

    router.get('/api/env', requireAuthed, (req, res) => {
        res.json(publicView(load()));
    });

    router.post('/api/env', requireAuthed, (req, res) => {
        const body = req.body || {};
        const current = load();
        let providers = current.providers;
        if (body.providerAction === 'upsert' && body.provider) {
            const p = normalizeProvider(body.provider);
            if (!p) return res.status(400).json({ ok: false, error: 'invalid provider' });
            // Masked token round-trip from the UI means "keep the stored one".
            const prev = providers.find(x => x.id === p.id);
            if (prev && (!p.token || p.token.startsWith('****'))) p.token = prev.token;
            providers = providers.filter(x => x.id !== p.id).concat([p]);
        } else if (body.providerAction === 'delete' && typeof body.providerId === 'string') {
            providers = providers.filter(x => x.id !== body.providerId);
        }
        const next = {
            claude: {
                baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : current.claude.baseUrl,
                apiKey: typeof body.apiKey === 'string' ? body.apiKey : current.claude.apiKey,
            },
            custom: Array.isArray(body.custom) ? body.custom : current.custom,
            providers,
            active: typeof body.active === 'string' ? body.active : current.active,
        };
        res.json(publicView(save(next)));
    });

    app.use(router);
}

module.exports = { load, save, getEnvForShell, activeProvider, mount };

