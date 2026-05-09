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

import { t as tr, LANGS, getLang, setLang } from '/assets/i18n.js?v=5';

const STORAGE_KEY = 'soa-web:settings';
const LS_BACKEND_KEY = 'soa_web_backend';

export const DEFAULTS = Object.freeze({
    termFontSize: 13,
    cursorBlink: true,
    nocursor: false,
    nointro: false,
    audio: true,
    audioVolume: 1.0,
    disableFeedbackAudio: false,
    clockHours: 24,
});

function clampFont(n)   { n = Number(n); return Number.isFinite(n) ? Math.max(8, Math.min(28, Math.round(n))) : DEFAULTS.termFontSize; }
function clampVol(n)    { n = Number(n); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULTS.audioVolume; }
function asBool(v, dflt){ return typeof v === 'boolean' ? v : dflt; }
function asHours(n)     { n = Number(n); return n === 12 ? 12 : 24; }

function normalize(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
        termFontSize: clampFont(s.termFontSize ?? DEFAULTS.termFontSize),
        cursorBlink: asBool(s.cursorBlink, DEFAULTS.cursorBlink),
        nocursor: asBool(s.nocursor, DEFAULTS.nocursor),
        nointro: asBool(s.nointro, DEFAULTS.nointro),
        audio: asBool(s.audio, DEFAULTS.audio),
        audioVolume: clampVol(s.audioVolume ?? DEFAULTS.audioVolume),
        disableFeedbackAudio: asBool(s.disableFeedbackAudio, DEFAULTS.disableFeedbackAudio),
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
    window.dispatchEvent(new CustomEvent('soa:settings', { detail: { ...current } }));
    return { ...current };
}

export function resetSettings() {
    current = normalize(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    applyCursorClass();
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

function buildAppearancePane(s) {
    return el('table', { class: 'settings-table' }, [
        el('thead', {}, [el('tr', {}, [
            el('th', { text: tr('settings.col.key') }),
            el('th', { text: tr('settings.col.desc') }),
            el('th', { text: tr('settings.col.value') }),
        ])]),
        el('tbody', {}, [
            kvRow('termFontSize', 'settings.desc.termFontSize', numInput('set-termFontSize', s.termFontSize, 8, 28, 1)),
            kvRow('cursorBlink',  'settings.desc.cursorBlink',  boolSelect('set-cursorBlink', s.cursorBlink)),
            kvRow('nocursor',     'settings.desc.nocursor',     boolSelect('set-nocursor', s.nocursor)),
            kvRow('nointro',      'settings.desc.nointro',      boolSelect('set-nointro', s.nointro)),
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

function collectFromDOM(prev) {
    const get = id => document.getElementById(id);
    return {
        termFontSize:         Number(get('set-termFontSize').value),
        cursorBlink:          get('set-cursorBlink').value === 'true',
        nocursor:             get('set-nocursor').value === 'true',
        nointro:              get('set-nointro').value === 'true',
        audio:                get('set-audio').value === 'true',
        audioVolume:          Number(get('set-audioVolume').value),
        disableFeedbackAudio: get('set-disableFeedbackAudio').value === 'true',
        clockHours:           Number(get('set-clockHours').value),
        _lang:                get('set-lang').value,
    };
}

export function openSettingsModal() {
    if (document.getElementById('settings-modal')) return;

    const backdrop = el('div', { class: 'soa-modal-backdrop', id: 'settings-modal' });
    const card = el('div', { class: 'soa-modal soa-settings' });
    const close = () => { backdrop.remove(); document.removeEventListener('keydown', escHandler); };
    const escHandler = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', escHandler);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

    const s = getSettings();
    const panes = {
        appearance: buildAppearancePane(s),
        audio:      buildAudioPane(s),
        misc:       buildMiscPane(s),
        connection: buildConnPane(),
    };
    Object.values(panes).forEach(p => p.classList.add('settings-pane'));
    panes.appearance.classList.add('settings-pane--active');

    const tabDefs = [
        ['appearance', tr('settings.tab.appearance')],
        ['audio',      tr('settings.tab.audio')],
        ['misc',       tr('settings.tab.misc')],
        ['connection', tr('settings.tab.connection')],
    ];
    const tabs = tabDefs.map(([k, label]) => {
        const t = el('div', { class: 'settings-tab' + (k === 'appearance' ? ' settings-tab--active' : ''), text: label });
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
