/**
 * Web-app subset of the desktop Settings panel.
 *
 * The Electron build exposes knobs for shell, monitor placement, ad overlay,
 * etc. — none of which apply in the browser. Here we keep only the subset
 * that maps onto things a web runtime actually controls:
 *
 *   Appearance: terminal font size, cursor blink, hide OS cursor, skip intro
 *   Audio:      enable, master volume, mute recurring feedback cues
 *   Clock:      12h / 24h sidebar widget
 *   Language:   delegates to i18n.js (its own storage)
 *   Connection: shows the resolved backend and clears the saved one
 *
 * Consumers subscribe via `onSettings` or read `getSettings()`. Mutations
 * broadcast a `soa:settings` window event so widgets/tabs can re-render.
 */

import { t as tr, LANGS, getLang, setLang } from '/assets/i18n.js?v=17';

const STORAGE_KEY = 'soa-web:settings';
const LS_BACKEND_KEY = 'soa_web_backend';

export const DEFAULTS = Object.freeze({
    theme: 'dark',   // default to dark regardless of system preference
    uiLang: 'tron',  // UI language: 'tron' (terminal classic) | 'minimal' (porcelain modern)
    termFontSize: 13,
    cursorBlink: true,
    nocursor: false,
    nointro: false,
    audio: true,
    audioVolume: 1.0,
    disableFeedbackAudio: false,
    agentDoneSound: true,
    clockHours: 24,
});

const THEMES = ['auto', 'dark', 'light', 'dim'];
function asTheme(v) { return THEMES.includes(v) ? v : DEFAULTS.theme; }

const UILANGS = ['tron', 'minimal'];
function asUiLang(v) { return UILANGS.includes(v) ? v : DEFAULTS.uiLang; }

// Reflect the UI language onto <html data-ui> so minimal.css activates.
// index.html sets it pre-paint from localStorage; this keeps it in sync on
// every change (app.js _applyTheme then re-themes open xterm instances).
function applyUiAttr() {
    const want = current ? current.uiLang : DEFAULTS.uiLang;
    if (document.documentElement.dataset.ui !== want) {
        document.documentElement.dataset.ui = want;
    }
}

function clampFont(n)   { n = Number(n); return Number.isFinite(n) ? Math.max(8, Math.min(28, Math.round(n))) : DEFAULTS.termFontSize; }
function clampVol(n)    { n = Number(n); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULTS.audioVolume; }
function asBool(v, dflt){ return typeof v === 'boolean' ? v : dflt; }
function asHours(n)     { n = Number(n); return n === 12 ? 12 : 24; }

function normalize(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
        theme: asTheme(s.theme ?? DEFAULTS.theme),
        uiLang: asUiLang(s.uiLang ?? DEFAULTS.uiLang),
        termFontSize: clampFont(s.termFontSize ?? DEFAULTS.termFontSize),
        cursorBlink: asBool(s.cursorBlink, DEFAULTS.cursorBlink),
        nocursor: asBool(s.nocursor, DEFAULTS.nocursor),
        nointro: asBool(s.nointro, DEFAULTS.nointro),
        audio: asBool(s.audio, DEFAULTS.audio),
        audioVolume: clampVol(s.audioVolume ?? DEFAULTS.audioVolume),
        disableFeedbackAudio: asBool(s.disableFeedbackAudio, DEFAULTS.disableFeedbackAudio),
        agentDoneSound: asBool(s.agentDoneSound, DEFAULTS.agentDoneSound),
        clockHours: asHours(s.clockHours ?? DEFAULTS.clockHours),
    };
}

function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return normalize(raw ? JSON.parse(raw) : null);
    } catch (_) { return normalize(null); }
}

let current = load();

export function getSettings() { return { ...current }; }

export function saveSettings(patch) {
    current = normalize({ ...current, ...(patch || {}) });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch (_) {}
    applyCursorClass();
    applyUiAttr();
    window.dispatchEvent(new CustomEvent('soa:settings', { detail: { ...current } }));
    return { ...current };
}

export function resetSettings() {
    current = normalize(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    applyCursorClass();
    applyUiAttr();
    window.dispatchEvent(new CustomEvent('soa:settings', { detail: { ...current } }));
    return { ...current };
}

export function onSettings(fn) {
    const h = e => fn(e.detail);
    window.addEventListener('soa:settings', h);
    return () => window.removeEventListener('soa:settings', h);
}

export function applyCursorClass() {
    if (document && document.body) {
        document.body.classList.toggle('nocursor', !!current.nocursor);
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyCursorClass, { once: true });
    } else {
        applyCursorClass();
    }
}

// ── Modal ─────────────────────────────────────────────────────────────────
const el = (tag, props = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v != null) n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
};

function resolvedBackendLabel() {
    const cfg = window.__SOA_WEB__ || {};
    if (cfg._resolvedBackend) {
        try { return new URL(cfg._resolvedBackend).host; } catch (_) { return cfg._resolvedBackend; }
    }
    return tr('settings.conn.none');
}

function resolvedModeLabel() {
    const cfg = window.__SOA_WEB__ || {};
    if (cfg._resolvedBackend) return tr('settings.conn.mode_server');
    return tr('settings.conn.mode_sandbox');
}

function kvRow(labelKey, descKey, control) {
    return el('tr', {}, [
        el('td', { class: 'k' }, [el('code', { text: labelKey })]),
        el('td', { class: 'd', text: tr(descKey) }),
        el('td', { class: 'v' }, [control]),
    ]);
}

function boolSelect(id, value) {
    const s = el('select', { id });
    for (const v of [true, false]) {
        const o = el('option', { value: String(v), text: String(v) });
        if (v === value) o.selected = true;
        s.appendChild(o);
    }
    return s;
}

function numInput(id, value, min, max, step) {
    const inp = el('input', { id, type: 'number', value: String(value) });
    if (min != null) inp.min = String(min);
    if (max != null) inp.max = String(max);
    if (step != null) inp.step = String(step);
    return inp;
}

function hoursSelect(id, value) {
    const s = el('select', { id });
    for (const v of [24, 12]) {
        const o = el('option', { value: String(v), text: `${v}h` });
        if (v === value) o.selected = true;
        s.appendChild(o);
    }
    return s;
}

function langSelect(id) {
    const s = el('select', { id });
    const cur = getLang();
    for (const l of LANGS) {
        const o = el('option', { value: l.code, text: `${l.label} · ${l.name}` });
        if (l.code === cur) o.selected = true;
        s.appendChild(o);
    }
    return s;
}

function uiLangSelect(id, value) {
    const sel = el('select', { id });
    for (const [v, label] of [['tron', 'TRON · terminal classic'], ['minimal', 'MINIMAL · porcelain modern']]) {
        const o = el('option', { value: v, text: label });
        if (v === value) o.selected = true;
        sel.appendChild(o);
    }
    // Instant apply, same pipeline as theme: saveSettings sets <html data-ui>
    // (applyUiAttr) and 'soa:settings' → app.js _applyTheme re-themes xterm.
    sel.addEventListener('change', () => saveSettings({ uiLang: asUiLang(sel.value) }));
    return sel;
}

function themeSelect(id, value) {
    const sel = el('select', { id });
    for (const [v, label] of [['auto', 'Auto (system)'], ['dark', 'Dark'], ['light', 'Light'], ['dim', 'Dim']]) {
        const o = el('option', { value: v, text: label });
        if (v === value) o.selected = true;
        sel.appendChild(o);
    }
    // Instant apply: changing the dropdown re-themes the whole UI immediately
    // (saveSettings → 'soa:settings' → app.js _applySettings → _applyTheme).
    sel.addEventListener('change', () => saveSettings({ theme: asTheme(sel.value) }));
    return sel;
}

// A read-only settings row (label / description / static value).
function staticRow(label, desc, valueText) {
    return el('tr', {}, [
        el('td', { class: 'k' }, [el('code', { text: label })]),
        el('td', { class: 'd', text: desc }),
        el('td', { class: 'v' }, [el('span', { text: valueText })]),
    ]);
}

function buildAppearancePane(s) {
    return el('table', { class: 'settings-table' }, [
        el('thead', {}, [el('tr', {}, [
            el('th', { text: tr('settings.col.key') }),
            el('th', { text: tr('settings.col.desc') }),
            el('th', { text: tr('settings.col.value') }),
        ])]),
        el('tbody', {}, [
            el('tr', {}, [
                el('td', { class: 'k' }, [el('code', { text: 'uiLang' })]),
                el('td', { class: 'd', text: 'UI language — TRON is the classic terminal look; MINIMAL is a modern porcelain skin with dark terminal cards (it brings its own palette, so theme below only affects TRON). Applies instantly.' }),
                el('td', { class: 'v' }, [uiLangSelect('set-uiLang', s.uiLang)]),
            ]),
            el('tr', {}, [
                el('td', { class: 'k' }, [el('code', { text: 'theme' })]),
                el('td', { class: 'd', text: 'Color theme — Auto follows your system; Light/Dim are bright variants. Applies instantly.' }),
                el('td', { class: 'v' }, [themeSelect('set-theme', s.theme)]),
            ]),
            kvRow('termFontSize', 'settings.desc.termFontSize', numInput('set-termFontSize', s.termFontSize, 8, 28, 1)),
            kvRow('cursorBlink',  'settings.desc.cursorBlink',  boolSelect('set-cursorBlink', s.cursorBlink)),
            kvRow('nocursor',     'settings.desc.nocursor',     boolSelect('set-nocursor', s.nocursor)),
            kvRow('nointro',      'settings.desc.nointro',      boolSelect('set-nointro', s.nointro)),
            staticRow('version', 'SoA-Web build', 'v' + ((window.__SOA_WEB__ || {}).version || 'dev')),
        ]),
    ]);
}

function buildAudioPane(s) {
    return el('table', { class: 'settings-table' }, [
        el('thead', {}, [el('tr', {}, [
            el('th', { text: tr('settings.col.key') }),
            el('th', { text: tr('settings.col.desc') }),
            el('th', { text: tr('settings.col.value') }),
        ])]),
        el('tbody', {}, [
            kvRow('audio',               'settings.desc.audio',               boolSelect('set-audio', s.audio)),
            kvRow('audioVolume',         'settings.desc.audioVolume',         numInput('set-audioVolume', s.audioVolume, 0, 1, 0.05)),
            kvRow('disableFeedbackAudio','settings.desc.disableFeedbackAudio',boolSelect('set-disableFeedbackAudio', s.disableFeedbackAudio)),
            el('tr', {}, [
                el('td', { class: 'k' }, [el('code', { text: 'agentDoneSound' })]),
                el('td', { class: 'd', text: 'Play a chime when a fleet agent finishes a turn (working → done).' }),
                el('td', { class: 'v' }, [boolSelect('set-agentDoneSound', s.agentDoneSound)]),
            ]),
        ]),
    ]);
}

function buildMiscPane(s) {
    return el('table', { class: 'settings-table' }, [
        el('thead', {}, [el('tr', {}, [
            el('th', { text: tr('settings.col.key') }),
            el('th', { text: tr('settings.col.desc') }),
            el('th', { text: tr('settings.col.value') }),
        ])]),
        el('tbody', {}, [
            kvRow('clockHours', 'settings.desc.clockHours', hoursSelect('set-clockHours', s.clockHours)),
            kvRow('lang',       'settings.desc.lang',       langSelect('set-lang')),
        ]),
    ]);
}

function buildConnPane() {
    const cfg = window.__SOA_WEB__ || {};
    const saved = (() => {
        try { const raw = localStorage.getItem(LS_BACKEND_KEY); return raw ? JSON.parse(raw) : null; }
        catch (_) { return null; }
    })();
    const disconnect = el('button', { class: 'soa-modal-copy', text: tr('settings.conn.disconnect') });
    disconnect.addEventListener('click', () => {
        try { localStorage.removeItem(LS_BACKEND_KEY); } catch (_) {}
        disconnect.textContent = tr('settings.conn.disconnected');
        disconnect.disabled = true;
    });
    if (!saved) { disconnect.disabled = true; }

    return el('div', { class: 'settings-pane-body' }, [
        el('div', { class: 'kv' }, [
            el('span', { class: 'k', text: tr('settings.conn.mode') }),
            el('span', { class: 'v', text: resolvedModeLabel() }),
        ]),
        el('div', { class: 'kv' }, [
            el('span', { class: 'k', text: tr('settings.conn.backend') }),
            el('span', { class: 'v', text: resolvedBackendLabel() }),
        ]),
        el('div', { class: 'kv' }, [
            el('span', { class: 'k', text: tr('settings.conn.saved') }),
            el('span', { class: 'v', text: saved ? (saved.backend || '—') : tr('settings.conn.none') }),
        ]),
        el('div', { class: 'settings-row-actions' }, [disconnect]),
        el('p', { class: 'settings-hint', text: tr('settings.conn.hint') }),
    ]);
}

function _apiBase() {
    const cfg = window.__SOA_WEB__ || {};
    return cfg._resolvedBackend || '';
}

function _apiFetch(path, opts = {}) {
    const cfg = window.__SOA_WEB__ || {};
    const base = cfg._resolvedBackend || '';
    const token = cfg._resolvedToken || '';
    const url = new URL(base + path);
    if (token) url.searchParams.set('t', token);
    return fetch(url.toString(), { credentials: 'include', ...opts });
}

function buildEnvPane() {
    const pane = el('div', { class: 'settings-pane-body settings-env-pane' });
    const baseUrlInput = el('input', { id: 'set-env-baseurl', type: 'text', placeholder: 'https://api.anthropic.com' });
    const apiKeyInput = el('input', { id: 'set-env-apikey', type: 'password', placeholder: 'sk-ant-...' });
    const customList = el('div', { class: 'env-custom-list' });
    const addBtn = el('button', { class: 'soa-modal-copy', text: '+ ' + tr('settings.env.add_var') });
    const saveEnvBtn = el('button', { class: 'soa-modal-copy', text: tr('settings.btn.save') });
    const envStatus = el('p', { class: 'settings-status' });

    function addCustomRow(key = '', value = '') {
        const row = el('div', { class: 'env-custom-row' });
        const kInput = el('input', { type: 'text', placeholder: 'KEY', value: key, class: 'env-key-input' });
        const vInput = el('input', { type: 'text', placeholder: 'value', value: value, class: 'env-val-input' });
        const rm = el('button', { class: 'env-rm-btn', text: '×' });
        rm.addEventListener('click', () => row.remove());
        row.append(kInput, vInput, rm);
        customList.appendChild(row);
    }

    addBtn.addEventListener('click', () => addCustomRow());

    saveEnvBtn.addEventListener('click', async () => {
        const custom = [];
        for (const row of customList.querySelectorAll('.env-custom-row')) {
            const k = row.querySelector('.env-key-input').value.trim();
            const v = row.querySelector('.env-val-input').value;
            if (k) custom.push({ key: k, value: v });
        }
        const body = {
            baseUrl: baseUrlInput.value.trim(),
            apiKey: apiKeyInput.value || undefined,
            custom,
        };
        if (body.apiKey === undefined) delete body.apiKey;
        try {
            const res = await _apiFetch('/api/env', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (data.ok) envStatus.textContent = tr('settings.status.saved', { t: new Date().toTimeString().slice(0, 8) });
            else envStatus.textContent = 'Error: ' + (data.error || 'unknown');
        } catch (e) { envStatus.textContent = 'Error: ' + e.message; }
    });

    (async () => {
        try {
            const res = await _apiFetch('/api/env');
            const data = await res.json();
            if (data.ok) {
                baseUrlInput.value = data.claude.baseUrl || '';
                apiKeyInput.placeholder = data.claude.hasKey ? '****' + data.claude.apiKey.slice(-4) : 'sk-ant-...';
                for (const { key, value } of (data.custom || [])) addCustomRow(key, value);
            }
        } catch (_) {}
    })();

    pane.append(
        el('h4', { class: 'settings-section-title', text: tr('settings.env.claude_title') }),
        el('div', { class: 'env-field' }, [
            el('label', { text: 'ANTHROPIC_BASE_URL', class: 'env-label' }),
            baseUrlInput,
        ]),
        el('div', { class: 'env-field' }, [
            el('label', { text: 'ANTHROPIC_API_KEY', class: 'env-label' }),
            apiKeyInput,
        ]),
        el('h4', { class: 'settings-section-title', text: tr('settings.env.custom_title') }),
        customList,
        addBtn,
        el('div', { class: 'settings-row-actions' }, [saveEnvBtn]),
        envStatus,
        el('p', { class: 'settings-hint', text: tr('settings.env.hint') }),
    );
    return pane;
}

const AVATAR_COLORS = [
    { color: '#4a6566', name: 'Slate' },
    { color: '#aacfd1', name: 'Teal' },
    { color: '#ffb86c', name: 'Orange' },
    { color: '#50fa7b', name: 'Green' },
    { color: '#ff5555', name: 'Red' },
    { color: '#6272a4', name: 'Blue' },
    { color: '#bd93f9', name: 'Purple' },
];

function buildProfilePane() {
    const pane = el('div', { class: 'settings-pane-body' });

    const nameInput = el('input', { class: 'profile-input', type: 'text', maxlength: '50', placeholder: 'Your display name' });
    let selectedColor = '#4a6566';

    const swatches = el('div', { class: 'profile-avatar-swatches' });
    for (const { color, name: cname } of AVATAR_COLORS) {
        const s = el('button', { class: 'profile-avatar-swatch', title: cname, style: `background:${color}` });
        s.addEventListener('click', () => {
            swatches.querySelectorAll('.profile-avatar-swatch').forEach(x => x.classList.remove('selected'));
            s.classList.add('selected');
            selectedColor = color;
        });
        swatches.appendChild(s);
    }

    const locToggle = el('input', { class: 'profile-loc-toggle', type: 'checkbox', id: 'set-loc-toggle' });
    const locLabel  = el('label', { class: 'profile-loc-label', for: 'set-loc-toggle', text: 'Show my location on the globe' });
    const locStatus = el('div', { class: 'profile-loc-status' });

    locToggle.addEventListener('change', () => {
        if (!locToggle.checked) { locStatus.textContent = ''; return; }
        if (!navigator.geolocation) {
            locToggle.checked = false;
            locStatus.textContent = 'GPS not available in this browser.';
            return;
        }
        locStatus.textContent = 'Requesting location permission…';
        navigator.geolocation.getCurrentPosition(
            pos => {
                locStatus.textContent = `Permission granted ✓  (${pos.coords.latitude.toFixed(2)}, ${pos.coords.longitude.toFixed(2)})`;
                window.dispatchEvent(new CustomEvent('soa:user-location', {
                    detail: { lat: pos.coords.latitude, lon: pos.coords.longitude, name: nameInput.value.trim() || 'You' },
                }));
            },
            err => {
                locToggle.checked = false;
                locStatus.textContent = err.code === 1 ? 'Location permission denied.' : 'Could not get location.';
            },
            { timeout: 10_000, maximumAge: 10 * 60_000 },
        );
    });

    const saveBtn   = el('button', { class: 'soa-modal-copy', text: 'Save profile' });
    const saveStatus = el('p', { class: 'settings-status' });

    saveBtn.addEventListener('click', async () => {
        try {
            const body = {
                displayName: nameInput.value.trim() || 'User',
                avatarColor: selectedColor,
                locationPermission: locToggle.checked,
            };
            const res = await _apiFetch('/api/user/profile', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (data.ok) {
                saveStatus.textContent = 'Saved at ' + new Date().toTimeString().slice(0, 8);
                window.dispatchEvent(new CustomEvent('soa:profile-updated', { detail: data.profile }));
            } else {
                saveStatus.textContent = 'Error: ' + (data.error || 'unknown');
            }
        } catch (e) { saveStatus.textContent = 'Error: ' + e.message; }
    });

    // Press Enter in the name field to save (name is freely editable/modifiable).
    nameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
    });

    // ── Live account stats (polled only while this pane is on screen) ───────────
    const statClients = el('span', { class: 'profile-stat-val', text: '—' });
    const statTokens  = el('span', { class: 'profile-stat-val', text: '—' });
    const statFlag    = el('span', { class: 'profile-stat-flag', text: '🌍' });
    const statPlace   = el('span', { class: 'profile-stat-val', text: '—' });

    async function refreshStats() {
        try {
            const res = await _apiFetch('/api/user/stats');
            const d = await res.json();
            if (!d || !d.ok) return;
            statClients.textContent = String(d.connectedClients ?? 0)
                + (d.connectedClients === 1 ? ' client' : ' clients');
            statTokens.textContent = formatTokens(d.estTokens) + ' ctx'
                + (d.activeTabs ? `  ·  ${d.activeTabs} tab${d.activeTabs === 1 ? '' : 's'}` : '');
            const flag = iso2ToFlagEmoji(d.country);
            statFlag.textContent = flag;
            statPlace.textContent = [d.city, d.country].filter(Boolean).join(', ') || 'Unknown';
            // Mirror the flag onto the always-visible topbar chip.
            window.dispatchEvent(new CustomEvent('soa:user-geo', { detail: { country: d.country, flag } }));
        } catch (_) { /* transient — keep last values */ }
    }
    refreshStats();
    const statsTimer = setInterval(() => {
        if (!pane.isConnected) { clearInterval(statsTimer); return; }
        refreshStats();
    }, 3000);

    // Load existing profile
    (async () => {
        try {
            const res = await _apiFetch('/api/user/profile');
            const { ok, profile } = await res.json();
            if (!ok) return;
            nameInput.value = profile.displayName || '';
            selectedColor = profile.avatarColor || '#4a6566';
            swatches.querySelectorAll('.profile-avatar-swatch').forEach(s => {
                if (s.style.backgroundColor === selectedColor ||
                    s.style.background === selectedColor ||
                    s.title === AVATAR_COLORS.find(c => c.color === selectedColor)?.name) {
                    s.classList.add('selected');
                }
            });
            // Match by background style
            swatches.querySelectorAll('.profile-avatar-swatch').forEach(s => {
                const hex = rgbToHex(s.style.background || s.style.backgroundColor);
                if (hex && hex.toLowerCase() === selectedColor.toLowerCase()) s.classList.add('selected');
            });
            locToggle.checked = !!profile.locationPermission;
        } catch (_) {}
    })();

    pane.append(
        el('div', { class: 'profile-field' }, [
            el('div', { class: 'profile-label', text: 'Live Account' }),
            el('div', { class: 'profile-stats' }, [
                el('div', { class: 'profile-stat-row' }, [
                    el('span', { class: 'profile-stat-key', text: 'Connected' }), statClients,
                ]),
                el('div', { class: 'profile-stat-row' }, [
                    el('span', { class: 'profile-stat-key', text: 'Tokens (fleet)' }), statTokens,
                ]),
                el('div', { class: 'profile-stat-row' }, [
                    el('span', { class: 'profile-stat-key', text: 'Location (IP)' }),
                    el('span', { class: 'profile-stat-loc' }, [statFlag, statPlace]),
                ]),
            ]),
        ]),
        el('div', { class: 'profile-field' }, [
            el('div', { class: 'profile-label', text: 'Display Name' }),
            nameInput,
        ]),
        el('div', { class: 'profile-field' }, [
            el('div', { class: 'profile-label', text: 'Avatar Color' }),
            swatches,
        ]),
        el('div', { class: 'profile-field' }, [
            el('div', { class: 'profile-label', text: 'Location' }),
            el('div', { class: 'profile-loc-row' }, [locToggle, locLabel]),
            locStatus,
        ]),
        el('div', { class: 'settings-row-actions' }, [saveBtn]),
        saveStatus,
        el('p', { class: 'settings-hint', text: 'Browser GPS is shared only with this device\'s globe widget — never sent to any server. The IP location/flag above is the server\'s egress.' }),
    );
    return pane;
}

// Convert CSS rgb(...) string to hex for comparison
function rgbToHex(rgb) {
    const m = String(rgb).match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return rgb; // already hex or empty
    return '#' + [m[1], m[2], m[3]].map(n => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
}

// ISO-3166-1 alpha-2 (e.g. 'US') → flag emoji via regional-indicator symbols.
// Returns a globe for missing/invalid codes so the UI never shows a broken glyph.
export function iso2ToFlagEmoji(iso2) {
    if (!iso2 || typeof iso2 !== 'string' || iso2.length !== 2 || !/^[a-z]{2}$/i.test(iso2)) return '🌍';
    const cps = iso2.toUpperCase().split('').map(c => 127397 + c.charCodeAt(0));
    return String.fromCodePoint(...cps);
}

// Compact token formatting: 850 → "850", 12300 → "12k", 1_250_000 → "1.3M".
function formatTokens(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
    return (n / 1_000_000).toFixed(1) + 'M';
}

function buildAutomationPane() {
    const pane = el('div', { class: 'settings-pane-body settings-auto-pane' });
    const enableCompact = el('select', { id: 'set-auto-compact-enabled' });
    enableCompact.append(el('option', { value: 'true', text: 'true' }), el('option', { value: 'false', text: 'false' }));
    const thresholdInput = el('input', { id: 'set-auto-compact-threshold', type: 'number', value: '10', min: '5', max: '95' });
    const cooldownInput = el('input', { id: 'set-auto-compact-cooldown', type: 'number', value: '60', min: '30', max: '300' });

    const schedList = el('div', { class: 'auto-sched-list' });
    const addSchedBtn = el('button', { class: 'soa-modal-copy', text: '+ ' + tr('settings.auto.add_schedule') });
    const orchEnabled = el('select', { id: 'set-orch-enabled' });
    orchEnabled.append(el('option', { value: 'false', text: 'false' }), el('option', { value: 'true', text: 'true' }));
    const orchPrompt = el('textarea', { id: 'set-orch-prompt', rows: '4', placeholder: tr('settings.auto.orch_prompt_hint') });
    const orchInterval = el('input', { id: 'set-orch-interval', type: 'number', value: '30', min: '15', max: '600' });

    const saveAutoBtn = el('button', { class: 'soa-modal-copy', text: tr('settings.btn.save') });
    const autoStatus = el('p', { class: 'settings-status' });

    function addSchedRow(tabId = '', message = '', intervalSec = 300, id = '') {
        const row = el('div', { class: 'auto-sched-row', 'data-sched-id': id });
        const tInput = el('input', { type: 'number', placeholder: 'Tab ID', value: String(tabId), class: 'sched-tab-input' });
        const mInput = el('input', { type: 'text', placeholder: 'Message to send', value: message, class: 'sched-msg-input' });
        const iInput = el('input', { type: 'number', placeholder: 'Interval (s)', value: String(intervalSec), class: 'sched-int-input', min: '10' });
        const rm = el('button', { class: 'env-rm-btn', text: '×' });
        rm.addEventListener('click', () => row.remove());
        row.append(tInput, mInput, iInput, rm);
        schedList.appendChild(row);
    }

    addSchedBtn.addEventListener('click', () => addSchedRow());

    saveAutoBtn.addEventListener('click', async () => {
        try {
            await _apiFetch('/api/automation', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    autoCompact: {
                        enabled: enableCompact.value === 'true',
                        threshold: Number(thresholdInput.value),
                        cooldownSec: Number(cooldownInput.value),
                    },
                }),
            });

            const schedRows = schedList.querySelectorAll('.auto-sched-row');
            for (const row of schedRows) {
                const sched = {
                    id: row.dataset.schedId || undefined,
                    tabId: Number(row.querySelector('.sched-tab-input').value),
                    message: row.querySelector('.sched-msg-input').value,
                    intervalMs: Number(row.querySelector('.sched-int-input').value) * 1000,
                    enabled: true,
                };
                await _apiFetch('/api/autopilot/schedules', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(sched),
                });
            }

            await _apiFetch('/api/autopilot/orchestrator', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    enabled: orchEnabled.value === 'true',
                    systemPrompt: orchPrompt.value,
                    checkIntervalMs: Number(orchInterval.value) * 1000,
                }),
            });

            autoStatus.textContent = tr('settings.status.saved', { t: new Date().toTimeString().slice(0, 8) });
        } catch (e) { autoStatus.textContent = 'Error: ' + e.message; }
    });

    (async () => {
        try {
            const [autoRes, pilotRes] = await Promise.all([
                _apiFetch('/api/automation'),
                _apiFetch('/api/autopilot'),
            ]);
            const autoData = await autoRes.json();
            const pilotData = await pilotRes.json();
            if (autoData.ok) {
                enableCompact.value = String(autoData.autoCompact.enabled);
                thresholdInput.value = String(autoData.autoCompact.threshold);
                cooldownInput.value = String(autoData.autoCompact.cooldownSec);
            }
            if (pilotData.ok) {
                for (const s of (pilotData.schedules || [])) {
                    addSchedRow(s.tabId, s.message, Math.round(s.intervalMs / 1000), s.id);
                }
                orchEnabled.value = String(pilotData.orchestrator.enabled);
                orchPrompt.value = pilotData.orchestrator.systemPrompt || '';
                orchInterval.value = String(Math.round(pilotData.orchestrator.checkIntervalMs / 1000));
            }
        } catch (_) {}
    })();

    pane.append(
        el('h4', { class: 'settings-section-title', text: tr('settings.auto.compact_title') }),
        el('div', { class: 'env-field' }, [
            el('label', { text: tr('settings.auto.enabled'), class: 'env-label' }), enableCompact,
        ]),
        el('div', { class: 'env-field' }, [
            el('label', { text: tr('settings.auto.threshold'), class: 'env-label' }), thresholdInput,
        ]),
        el('div', { class: 'env-field' }, [
            el('label', { text: tr('settings.auto.cooldown'), class: 'env-label' }), cooldownInput,
        ]),
        el('h4', { class: 'settings-section-title', text: tr('settings.auto.schedules_title') }),
        el('p', { class: 'settings-hint', text: tr('settings.auto.schedules_hint') }),
        schedList,
        addSchedBtn,
        el('h4', { class: 'settings-section-title', text: tr('settings.auto.orch_title') }),
        el('div', { class: 'env-field' }, [
            el('label', { text: tr('settings.auto.enabled'), class: 'env-label' }), orchEnabled,
        ]),
        el('div', { class: 'env-field' }, [
            el('label', { text: tr('settings.auto.orch_prompt'), class: 'env-label' }), orchPrompt,
        ]),
        el('div', { class: 'env-field' }, [
            el('label', { text: tr('settings.auto.orch_interval'), class: 'env-label' }), orchInterval,
        ]),
        el('div', { class: 'settings-row-actions' }, [saveAutoBtn]),
        autoStatus,
    );
    return pane;
}

function collectFromDOM(prev) {
    const get = id => document.getElementById(id);
    const themeEl = get('set-theme');
    const uiLangEl = get('set-uiLang');
    return {
        theme:                themeEl ? asTheme(themeEl.value) : (prev && prev.theme) || DEFAULTS.theme,
        uiLang:               uiLangEl ? asUiLang(uiLangEl.value) : (prev && prev.uiLang) || DEFAULTS.uiLang,
        termFontSize:         Number(get('set-termFontSize').value),
        cursorBlink:          get('set-cursorBlink').value === 'true',
        nocursor:             get('set-nocursor').value === 'true',
        nointro:              get('set-nointro').value === 'true',
        audio:                get('set-audio').value === 'true',
        audioVolume:          Number(get('set-audioVolume').value),
        disableFeedbackAudio: get('set-disableFeedbackAudio').value === 'true',
        agentDoneSound:       get('set-agentDoneSound') ? get('set-agentDoneSound').value === 'true' : (prev && prev.agentDoneSound),
        clockHours:           Number(get('set-clockHours').value),
        _lang:                get('set-lang').value,
    };
}

export function openSettingsModal({ tab: openTab } = {}) {
    if (document.getElementById('settings-modal')) return;

    // Anchored dropdown (not a full-screen dimmed modal) so opening settings is
    // low-interruption — see .soa-settings-drop in styles.css. The backdrop is a
    // transparent click-catcher that still closes on an outside click / Escape.
    const backdrop = el('div', { class: 'soa-modal-backdrop soa-settings-drop', id: 'settings-modal' });
    const card = el('div', { class: 'soa-modal soa-settings' });
    const close = () => { backdrop.remove(); document.removeEventListener('keydown', escHandler); };
    const escHandler = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', escHandler);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

    const s = getSettings();
    const defaultTab = openTab || 'appearance';
    const panes = {
        profile:    buildProfilePane(),
        appearance: buildAppearancePane(s),
        audio:      buildAudioPane(s),
        misc:       buildMiscPane(s),
        connection: buildConnPane(),
        env:        buildEnvPane(),
        automation: buildAutomationPane(),
    };
    Object.values(panes).forEach(p => p.classList.add('settings-pane'));
    (panes[defaultTab] || panes.appearance).classList.add('settings-pane--active');

    const tabDefs = [
        ['profile',    'Profile'],
        ['appearance', tr('settings.tab.appearance')],
        ['audio',      tr('settings.tab.audio')],
        ['misc',       tr('settings.tab.misc')],
        ['connection', tr('settings.tab.connection')],
        ['env',        tr('settings.tab.env')],
        ['automation', tr('settings.tab.automation')],
    ];
    const tabs = tabDefs.map(([k, label]) => {
        const isActive = k === defaultTab;
        const t = el('div', { class: 'settings-tab' + (isActive ? ' settings-tab--active' : ''), text: label });
        t.addEventListener('click', () => {
            card.querySelectorAll('.settings-tab').forEach(x => x.classList.remove('settings-tab--active'));
            card.querySelectorAll('.settings-pane').forEach(x => x.classList.remove('settings-pane--active'));
            t.classList.add('settings-tab--active');
            panes[k].classList.add('settings-pane--active');
        });
        return t;
    });

    const status = el('p', { class: 'settings-status', text: tr('settings.status.loaded') });

    const saveBtn = el('button', { class: 'soa-modal-copy', text: tr('settings.btn.save') });
    const resetBtn = el('button', { class: 'soa-modal-copy', text: tr('settings.btn.reset') });
    const closeBtn = el('button', { class: 'soa-modal-close', text: tr('settings.btn.close') });

    saveBtn.addEventListener('click', () => {
        const picked = collectFromDOM();
        const langCode = picked._lang;
        delete picked._lang;
        saveSettings(picked);
        if (langCode && langCode !== getLang()) setLang(langCode);
        status.textContent = tr('settings.status.saved', { t: new Date().toTimeString().slice(0, 8) });
    });
    resetBtn.addEventListener('click', () => {
        resetSettings();
        status.textContent = tr('settings.status.reset');
        setTimeout(() => { close(); openSettingsModal(); }, 80);
    });
    closeBtn.addEventListener('click', close);

    card.append(
        el('div', { class: 'soa-modal-title', text: tr('settings.title') }),
        el('div', { class: 'settings-tabbed' }, [
            el('div', { class: 'settings-sidebar' }, tabs),
            el('div', { class: 'settings-content' }, Object.values(panes)),
        ]),
        status,
        el('div', { class: 'settings-actions' }, [saveBtn, resetBtn, closeBtn]),
    );
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
}
