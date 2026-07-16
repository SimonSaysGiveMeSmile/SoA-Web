/**
 * Son of Anton — Mobile Companion App entry point.
 *
 * Lifecycle:
 *   1. Read the session token from the URL (?t=…) or localStorage.
 *   2. Open a BridgeSocket to the same host that served us. Once paired we
 *      remember the token so accidental tab closes can resume seamlessly.
 *   3. Render snapshots into the tab strip + active terminal view.
 *   4. Stream incremental terminal output into the <pre>.
 *   5. Forward every user input back to the desktop.
 *
 * Reconnection is handled inside BridgeSocket — we just react to its state
 * events to show / hide the reconnect overlay.
 */

import { BridgeSocket, SocketState, Diagnosis, getLogBuffer, pushLog } from './socket.js';
import { ansiToHtml, newState } from './ansi.js';
import { TermBuffer } from './terminal.js';
import { classifyAgent, cssStatus } from './agentDetect.js';
import { VirtualKeyboard } from './keyboard.js';
import { sounds, PROFILES as SOUND_PROFILES } from './sounds.js';

// Build marker — bump on every mobile-client change. Shown in the on-screen
// diagnostics panel so a phone (no console) can confirm whether it loaded the
// latest code or a stale cached bundle. If the panel shows an old marker, the
// service worker / HTTP cache is stale → use FORCE RELOAD in Settings.
const MOBILE_BUILD = 'v56 · mobile UX · tab-jump + anti-flicker · 2026-07-16';

const STORAGE_KEY = 'son-of-anton.session';
const THEME_KEY = 'son-of-anton.theme';
const MIC_SETTINGS_KEY = 'son-of-anton.mic-settings';
const FONT_SCALE_KEY = 'son-of-anton.font-scale';
// Grace period before the full-screen RECONNECTING overlay is raised. Tunnel
// blips reconnect in well under a second; flashing the overlay on every micro
// drop is the single jankiest thing on mobile. We keep the small status dot
// live immediately but only raise the big overlay if we're STILL down after
// this delay (and cancel it the instant we reconnect).
const RECONNECT_OVERLAY_DELAY_MS = 1400;

/* ── Theme definitions ──────────────────────────────── */

const THEMES = {
    mono: {
        name: 'Mono',
        preview: ['#000000', '#ffffff'],
        vars: {
            '--bg':             '#000000',
            '--bg-alt':         '#111111',
            '--fg':             '#e0e0e0',
            '--fg-dim':         'rgba(224,224,224,0.55)',
            '--fg-faint':       'rgba(224,224,224,0.2)',
            '--accent':         '#ffffff',
            '--accent-glow':    'rgba(255,255,255,0.5)',
            '--accent-bg':      'rgba(255,255,255,0.08)',
            '--accent-bg-hover':'rgba(255,255,255,0.15)',
            '--warn':           '#ffb84d',
            '--err':            '#ff5d6f',
            '--line':           'rgba(224,224,224,0.22)',
            '--radius':         '2px',
            '--panel-bg':       'rgba(0,0,0,0.75)',
            '--font':           'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        },
        colorScheme: 'dark',
    },
    matrix: {
        name: 'Matrix',
        preview: ['#000000', '#5fff5f'],
        vars: {
            '--bg':             '#000000',
            '--bg-alt':         '#03130a',
            '--fg':             '#aaffaa',
            '--fg-dim':         'rgba(170,255,170,0.55)',
            '--fg-faint':       'rgba(170,255,170,0.2)',
            '--accent':         '#5fff5f',
            '--accent-glow':    'rgba(95,255,95,0.6)',
            '--accent-bg':      'rgba(95,255,95,0.08)',
            '--accent-bg-hover':'rgba(95,255,95,0.15)',
            '--warn':           '#ffb84d',
            '--err':            '#ff5d6f',
            '--line':           'rgba(170,255,170,0.22)',
            '--radius':         '2px',
            '--panel-bg':       'rgba(3,19,10,0.85)',
            '--font':           'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        },
        colorScheme: 'dark',
    },
    amber: {
        name: 'Amber',
        preview: ['#0a0800', '#ffb347'],
        vars: {
            '--bg':             '#0a0800',
            '--bg-alt':         '#141000',
            '--fg':             '#ffd9a0',
            '--fg-dim':         'rgba(255,217,160,0.55)',
            '--fg-faint':       'rgba(255,217,160,0.2)',
            '--accent':         '#ffb347',
            '--accent-glow':    'rgba(255,179,71,0.6)',
            '--accent-bg':      'rgba(255,179,71,0.08)',
            '--accent-bg-hover':'rgba(255,179,71,0.15)',
            '--warn':           '#ffe066',
            '--err':            '#ff5d6f',
            '--line':           'rgba(255,217,160,0.22)',
            '--radius':         '2px',
            '--panel-bg':       'rgba(10,8,0,0.85)',
            '--font':           'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        },
        colorScheme: 'dark',
    },
    ocean: {
        name: 'Ocean',
        preview: ['#020c18', '#5fa8ff'],
        vars: {
            '--bg':             '#020c18',
            '--bg-alt':         '#081828',
            '--fg':             '#b0d4ff',
            '--fg-dim':         'rgba(176,212,255,0.55)',
            '--fg-faint':       'rgba(176,212,255,0.2)',
            '--accent':         '#5fa8ff',
            '--accent-glow':    'rgba(95,168,255,0.6)',
            '--accent-bg':      'rgba(95,168,255,0.08)',
            '--accent-bg-hover':'rgba(95,168,255,0.15)',
            '--warn':           '#ffb84d',
            '--err':            '#ff5d6f',
            '--line':           'rgba(176,212,255,0.22)',
            '--radius':         '2px',
            '--panel-bg':       'rgba(2,12,24,0.85)',
            '--font':           'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        },
        colorScheme: 'dark',
    },
    rose: {
        name: 'Rose',
        preview: ['#0e0408', '#ff6b8a'],
        vars: {
            '--bg':             '#0e0408',
            '--bg-alt':         '#180812',
            '--fg':             '#ffc0d0',
            '--fg-dim':         'rgba(255,192,208,0.55)',
            '--fg-faint':       'rgba(255,192,208,0.2)',
            '--accent':         '#ff6b8a',
            '--accent-glow':    'rgba(255,107,138,0.6)',
            '--accent-bg':      'rgba(255,107,138,0.08)',
            '--accent-bg-hover':'rgba(255,107,138,0.15)',
            '--warn':           '#ffb84d',
            '--err':            '#ff5d6f',
            '--line':           'rgba(255,192,208,0.22)',
            '--radius':         '2px',
            '--panel-bg':       'rgba(14,4,8,0.85)',
            '--font':           'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        },
        colorScheme: 'dark',
    },
    'liquid-glass': {
        name: 'Liquid Glass',
        preview: ['#f0f2f5', '#0071e3'],
        vars: {
            '--bg':             '#eef1f5',
            '--bg-alt':         '#ffffff',
            '--fg':             '#1c1c1e',
            '--fg-dim':         'rgba(28,28,30,0.58)',
            '--fg-faint':       'rgba(28,28,30,0.34)',
            '--accent':         '#0a84ff',
            '--accent-glow':    'rgba(10,132,255,0.3)',
            '--accent-bg':      'rgba(10,132,255,0.1)',
            '--accent-bg-hover':'rgba(10,132,255,0.16)',
            '--warn':           '#d97706',
            '--err':            '#e0352b',
            '--line':           'rgba(17,24,39,0.1)',
            '--radius':         '14px',
            '--panel-bg':       'rgba(255,255,255,0.68)',
            '--font':           "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif",
        },
        colorScheme: 'light',
    },

    // ── Tron neon family — dark, mono, glow ───────────────────────────────
    tron: {
        name: 'Tron',
        preview: ['#04080f', '#00e5ff'],
        vars: {
            '--bg':             '#04080f',
            '--bg-alt':         '#081420',
            '--fg':             '#c7f0ff',
            '--fg-dim':         'rgba(199,240,255,0.55)',
            '--fg-faint':       'rgba(199,240,255,0.2)',
            '--accent':         '#00e5ff',
            '--accent-glow':    'rgba(0,229,255,0.6)',
            '--accent-bg':      'rgba(0,229,255,0.08)',
            '--accent-bg-hover':'rgba(0,229,255,0.16)',
            '--warn':           '#ffb84d',
            '--err':            '#ff5d6f',
            '--line':           'rgba(0,229,255,0.22)',
            '--radius':         '4px',
            '--panel-bg':       'rgba(4,8,15,0.82)',
            '--font':           'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        },
        colorScheme: 'dark',
    },
    synthwave: {
        name: 'Synthwave',
        preview: ['#0d0418', '#ff2bd6'],
        vars: {
            '--bg':             '#0d0418',
            '--bg-alt':         '#160a28',
            '--fg':             '#f3d6ff',
            '--fg-dim':         'rgba(243,214,255,0.55)',
            '--fg-faint':       'rgba(243,214,255,0.2)',
            '--accent':         '#ff2bd6',
            '--accent-glow':    'rgba(255,43,214,0.6)',
            '--accent-bg':      'rgba(255,43,214,0.08)',
            '--accent-bg-hover':'rgba(255,43,214,0.16)',
            '--warn':           '#ffd166',
            '--err':            '#ff5d6f',
            '--line':           'rgba(243,214,255,0.2)',
            '--radius':         '4px',
            '--panel-bg':       'rgba(13,4,24,0.82)',
            '--font':           'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        },
        colorScheme: 'dark',
    },

    // ── Liquid Glass family — translucent panels, SF font, rounded ────────
    // LIQUID — the mobile face of the desktop LIQUID UI language: black & white,
    // a near-pure OLED-black ground, systemBlue reserved for what you touch. The
    // full glass treatment (ground blooms, frosted panels, edge-lensing rims and
    // specular) lives in the [data-theme="liquid"] block in styles.css.
    liquid: {
        name: 'Liquid · iOS',
        preview: ['#050506', '#0a84ff'],
        vars: {
            '--bg':             '#050506',
            '--bg-alt':         '#0d0d12',
            '--fg':             '#f5f5f7',
            '--fg-dim':         'rgba(245,245,247,0.62)',
            '--fg-faint':       'rgba(245,245,247,0.34)',
            '--accent':         '#ffffff',
            '--accent-glow':    'rgba(255,255,255,0.5)',
            '--accent-bg':      'rgba(255,255,255,0.1)',
            '--accent-bg-hover':'rgba(255,255,255,0.16)',
            '--warn':           '#ff9f0a',
            '--err':            '#ff453a',
            '--line':           'rgba(255,255,255,0.12)',
            '--radius':         '18px',
            '--panel-bg':       'rgba(255,255,255,0.06)',
            '--font':           "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif",
        },
        colorScheme: 'dark',
    },
    'liquid-dark': {
        name: 'Liquid Dark',
        preview: ['#0a0c10', '#0a84ff'],
        vars: {
            '--bg':             '#0a0c10',
            '--bg-alt':         '#14171d',
            '--fg':             '#e8eaed',
            '--fg-dim':         'rgba(232,234,237,0.55)',
            '--fg-faint':       'rgba(232,234,237,0.18)',
            '--accent':         '#0a84ff',
            '--accent-glow':    'rgba(10,132,255,0.45)',
            '--accent-bg':      'rgba(10,132,255,0.12)',
            '--accent-bg-hover':'rgba(10,132,255,0.2)',
            '--warn':           '#ff9f0a',
            '--err':            '#ff453a',
            '--line':           'rgba(255,255,255,0.12)',
            '--radius':         '14px',
            '--panel-bg':       'rgba(30,32,38,0.55)',
            '--font':           "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif",
        },
        colorScheme: 'dark',
    },
    'liquid-mint': {
        name: 'Liquid Mint',
        preview: ['#eef5f2', '#00a884'],
        vars: {
            '--bg':             '#eef4f1',
            '--bg-alt':         '#ffffff',
            '--fg':             '#12352b',
            '--fg-dim':         'rgba(18,53,43,0.58)',
            '--fg-faint':       'rgba(18,53,43,0.32)',
            '--accent':         '#00a884',
            '--accent-glow':    'rgba(0,168,132,0.3)',
            '--accent-bg':      'rgba(0,168,132,0.1)',
            '--accent-bg-hover':'rgba(0,168,132,0.16)',
            '--warn':           '#d97706',
            '--err':            '#e0352b',
            '--line':           'rgba(6,45,34,0.11)',
            '--radius':         '14px',
            '--panel-bg':       'rgba(255,255,255,0.68)',
            '--font':           "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif",
        },
        colorScheme: 'light',
    },
    'liquid-gold': {
        name: 'Liquid Gold',
        preview: ['#f6f2ea', '#bf9b30'],
        vars: {
            '--bg':             '#f5f1e8',
            '--bg-alt':         '#fffdf8',
            '--fg':             '#2a2214',
            '--fg-dim':         'rgba(42,34,20,0.58)',
            '--fg-faint':       'rgba(42,34,20,0.32)',
            '--accent':         '#a9822a',
            '--accent-glow':    'rgba(169,130,42,0.35)',
            '--accent-bg':      'rgba(169,130,42,0.12)',
            '--accent-bg-hover':'rgba(169,130,42,0.2)',
            '--warn':           '#c2410c',
            '--err':            '#c02826',
            '--line':           'rgba(60,45,15,0.14)',
            '--radius':         '14px',
            '--panel-bg':       'rgba(255,253,248,0.7)',
            '--font':           "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif",
        },
        colorScheme: 'light',
    },

    // ── MINIMAL — mobile face of the desktop MINIMAL UI language ──────────
    // Porcelain chrome, ink text, ONE teal accent; the terminal stays dark
    // (slate card) via the [data-theme="minimal"] block in styles.css.
    minimal: {
        name: 'Minimal',
        preview: ['#f2f0ea', '#0c7d72'],
        vars: {
            '--bg':             '#f2f0ea',
            '--bg-alt':         '#faf9f5',
            '--fg':             '#22252b',
            '--fg-dim':         'rgba(34,37,43,0.58)',
            '--fg-faint':       'rgba(34,37,43,0.32)',
            '--accent':         '#0c7d72',
            '--accent-glow':    'rgba(12,125,114,0.28)',
            '--accent-bg':      'rgba(12,125,114,0.09)',
            '--accent-bg-hover':'rgba(12,125,114,0.16)',
            '--warn':           '#a16207',
            '--err':            '#c02626',
            '--line':           'rgba(34,37,43,0.13)',
            '--radius':         '10px',
            '--panel-bg':       'rgba(250,249,245,0.86)',
            '--font':           "'Familjen Grotesk', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
        },
        colorScheme: 'light',
    },
};

const DEFAULT_THEME = 'mono';

function applyTheme(name) {
    const theme = THEMES[name] || THEMES[DEFAULT_THEME];
    const root = document.documentElement;
    for (const [prop, val] of Object.entries(theme.vars)) {
        root.style.setProperty(prop, val);
    }
    root.setAttribute('data-theme', name);
    root.setAttribute('data-scheme', theme.colorScheme);   // 'light' | 'dark' — powers scheme-wide styling
    root.style.colorScheme = theme.colorScheme;
    root.style.fontFamily = theme.vars['--font'];
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.vars['--bg']);
    try { localStorage.setItem(THEME_KEY, name); } catch (_) {}
}

function loadSavedTheme() {
    try {
        const saved = localStorage.getItem(THEME_KEY);
        if (saved && THEMES[saved]) return saved;
    } catch (_) {}
    return DEFAULT_THEME;
}

/* ── Boot theme immediately to avoid FOUC ────────── */
applyTheme(loadSavedTheme());

/* ── App ─────────────────────────────────────────── */

// In a native shell (the Capacitor iOS/Android app) the page is served from the
// app bundle — location.origin is `capacitor://localhost`, which is NOT a usable
// backend. The backend URL is supplied by the bundled native config
// (window.__SOA_BACKEND__, injected before this script) or by a user-set override
// persisted on-device. On the plain web `/m/` build both are absent and the app
// falls back to location.origin exactly as before, so this is a no-op there.
// Deep-link the initial view via `?view=` (search) or `#view=` (hash), so the
// app can open straight onto CHAT / DASH / BROWSER / SYSTEM instead of always
// the terminal — handy for bookmarking a view, and for capturing per-view
// screenshots on a device without any tapping. Accepts the friendly aliases the
// bottom-bar uses. Captured at module load because readToken() rewrites the
// hash away once a session token is present.
const VIEW_ALIASES = {
    terminal: 'terminal-view', term: 'terminal-view',
    chat: 'chat-view',
    dash: 'tiles-view', fleet: 'tiles-view', tiles: 'tiles-view',
    browser: 'web-view', web: 'web-view',
    system: 'widgets-view', widgets: 'widgets-view',
};
const INITIAL_VIEW = (() => {
    try {
        const search = new URLSearchParams(location.search);
        const hash = new URLSearchParams((location.hash || '').replace(/^#/, ''));
        const raw = (search.get('view') || hash.get('view') || '').toLowerCase();
        return VIEW_ALIASES[raw] || null;
    } catch (_) { return null; }
})();

const NATIVE_BACKEND_KEY = 'soa.native.backend';
function nativeBackend() {
    try {
        const saved = localStorage.getItem(NATIVE_BACKEND_KEY);
        if (saved) return saved.replace(/\/+$/, '');
    } catch (_) {}
    if (typeof window !== 'undefined' && window.__SOA_BACKEND__) {
        return String(window.__SOA_BACKEND__).replace(/\/+$/, '');
    }
    return null;
}

function readToken() {
    const params = new URLSearchParams(location.search);
    let t = params.get('t');
    let backend = params.get('backend');
    // The QR-encoded URL embeds an alternate transport as `#alt=<origin>` so
    // the mobile client can fail over LAN↔tunnel without a re-scan.
    let altOrigin = null;
    if (location.hash) {
        const hashParams = new URLSearchParams(location.hash.slice(1));
        if (!t) t = hashParams.get('t');
        altOrigin = hashParams.get('alt');
        if (!backend) backend = hashParams.get('backend');
    }
    if (!t) {
        const pathMatch = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)/);
        if (pathMatch) t = pathMatch[1];
    }
    // When served same-origin as the backend (the common case via the local
    // server's /m/), there's no `backend` param — fall back to location.origin.
    // In the native shell, fall back to the configured native backend instead.
    const effectiveBackend = backend || nativeBackend() || null;
    if (t) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                token: t,
                origin: location.origin,
                backend: effectiveBackend,
                altOrigin: altOrigin || null,
                ts: Date.now(),
            }));
        } catch (_) {}
        if (history.replaceState) {
            const clean = location.origin + location.pathname;
            history.replaceState(null, '', clean);
        }
        return { token: t, backend: effectiveBackend, altOrigin };
    }
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (saved && saved.token && saved.origin === location.origin) {
            return {
                token: saved.token,
                backend: saved.backend || null,
                altOrigin: saved.altOrigin || null,
            };
        }
    } catch (_) {}
    return { token: null, backend: nativeBackend(), altOrigin: null };
}

function wsBaseFromHttp(origin) {
    if (origin.startsWith('https://')) return 'wss://' + origin.slice('https://'.length);
    if (origin.startsWith('http://'))  return 'ws://'  + origin.slice('http://'.length);
    return origin;
}

class App {
    constructor() {
        this.statusDot   = document.querySelector('#status .status-dot');
        this.statusText  = document.querySelector('#status .status-text');
        this.tabsEl      = document.getElementById('tabs');
        this.termEl      = document.getElementById('term');
        this.widgetsEl   = document.getElementById('widgets');
        this.tilesEl     = document.getElementById('tiles');
        this.kbdEl       = document.getElementById('kbd');
        this.viewEls     = Array.from(document.querySelectorAll('.view'));
        this.viewBtns    = Array.from(document.querySelectorAll('.bb-btn[data-view]'));
        this.btnNewTab   = document.getElementById('btn-newtab');
        this.btnMic      = document.getElementById('btn-mic');
        this.btnSpeak    = document.getElementById('btn-speak');
        this.btnCamera   = document.getElementById('btn-camera');
        this.btnFullscreen = document.getElementById('btn-fullscreen');
        this.cameraInput = document.getElementById('camera-input');
        this.btnSettings = document.getElementById('btn-settings');
        // Tab jump: a persistent chip in the top bar shows the CURRENT tab (which
        // otherwise scrolls off among 20+ pills) and opens a searchable sheet of
        // every tab so you can jump straight to one instead of scrubbing the strip.
        this.btnTabchip   = document.getElementById('btn-tabchip');
        this.tabchipName  = document.getElementById('tabchip-name');
        this.tabchipCount = document.getElementById('tabchip-count');
        this.tabsheetOverlay = document.getElementById('tabsheet-overlay');
        this.tabsheetList    = document.getElementById('tabsheet-list');
        this.tabsheetSearch  = document.getElementById('tabsheet-search');
        this.reconnectOverlay = document.getElementById('reconnect-overlay');
        this.reconnectSub     = document.getElementById('reconnect-sub');
        this.reconnectDiag    = document.getElementById('reconnect-diag');
        this.reconnectRetry   = document.getElementById('reconnect-retry');
        this.reconnectOpenBrowser = document.getElementById('reconnect-open-browser');

        this.settingsOverlay = document.getElementById('settings-overlay');
        this.themeGrid = document.getElementById('theme-grid');
        this.soundGrid = document.getElementById('sound-grid');
        this.settingsClose = document.getElementById('settings-close');
        this.btnReload = document.getElementById('btn-reload');
        this.btnForceReload = document.getElementById('btn-force-reload');

        this.fontScaleSlider = document.getElementById('font-scale-slider');
        this.fontScaleValue  = document.getElementById('font-scale-value');
        this.btnFontReset    = document.getElementById('btn-font-reset');
        this.micDeviceSelect = document.getElementById('mic-device-select');
        this.micGainSlider = document.getElementById('mic-gain-slider');
        this.micGainValue = document.getElementById('mic-gain-value');
        this.micMeterBar = document.getElementById('mic-meter-bar');
        this.btnTestMic = document.getElementById('btn-test-mic');
        this.btnRefreshDevices = document.getElementById('btn-refresh-devices');

        this.chatLog      = document.getElementById('chat-log');
        this.chatInput    = document.getElementById('chat-input');
        this.chatComposer = document.getElementById('chat-composer');
        this.chatBadge    = document.getElementById('chat-badge');
        this.chatStatus   = document.getElementById('chat-status');
        this._chatThreads = new Map();   // tabId → [{ from:'agent'|'you', text, full, t }]
        this._chatUnread  = 0;

        this._snapshot = null;
        this._activeTab = 0;
        this._activeTabId = 0;
        // Per-device active tab. The server keeps ONE session-global active tab
        // and stamps it into every snapshot's activeId (3s cwd poll, device
        // connect/disconnect, and any device's switch). We must NOT blindly
        // follow that — otherwise this phone's view gets yanked whenever another
        // device switches tabs. A user TAP is handled optimistically-local
        // (_switchTabLocal), so it never depends on the server echo. The only
        // thing we follow from the server is a tab THIS device just CREATED,
        // whose id the server assigns: when we send new-tab we capture the set
        // of ids that exist right then, and _applySnapshot adopts the activeId
        // of the first snapshot naming an id NOT in that set (the genuinely new
        // tab), then clears it. Matching the NEW id — not "any valid activeId" —
        // stops a racing poll/device-count snapshot from stealing the focus.
        this._adoptNewTabIds = null;
        this._connectedDevices = 0;
        this._tabStates = new Map();
        this._tabStatuses = new Map();
        this._ctxPct = new Map();      // tabId → 0-100 context usage %
        this._toastTimer = null;
        this._tilesTimer = null;
        this._flushScheduled = false;
        this._ttsEnabled = false;
        try { this._ttsEnabled = localStorage.getItem('soa_web_tts') === '1'; } catch (_) {}
        this._currentTheme = loadSavedTheme();
        this._idleTimer = null;
        this._chromeHidden = false;

        // Readability floor: on a phone, fitting the desktop's ~80 cols would
        // push the auto-fit down to ~8px, which is painful to read. Hold a
        // legible minimum instead — content wider than the screen pans
        // horizontally (#term is overflow-x:auto / white-space:pre), which is a
        // better trade than unreadable text. Users can still fine-tune via the
        // font-scale control (_fontScale).
        this._minFontSize = 12;
        this._maxFontSize = 20;
        // User font preference: a multiplier over the auto-fit size. 1.0 = the
        // default auto-fit; >1 enlarges (terminal scrolls horizontally), <1 shrinks.
        this._fontScale = 1;
        try {
            const v = parseFloat(localStorage.getItem(FONT_SCALE_KEY));
            if (!Number.isNaN(v) && v >= 0.5 && v <= 3) this._fontScale = v;
        } catch (_) {}
        this._termCols = 80;
        this._userScrolledUp = false;
        this._currentView = 'terminal-view';   // HTML default; kept in sync by _showView
        this.termJump = document.getElementById('term-jump');

        this._micStream = null;
        this._micAnalyser = null;
        this._micGainNode = null;
        this._micMonitorInterval = null;
        this._micDevices = [];
        this._micSettings = this._loadMicSettings();

        this._pullHint = document.createElement('div');
        this._pullHint.className = 'pull-hint';
        document.body.appendChild(this._pullHint);

        if (this.themeGrid) this._renderThemeGrid();
        if (this.soundGrid) this._renderSoundGrid();
        if (this.btnSettings) this._wireSettings();
        this._wireFontSetting();
        this._wireModelAccess();
        this._wireMicSettings();
        this._wireFleet();
        this._wireTabSheet();
        this._wireIdleHide();

        const { token, backend, altOrigin } = readToken();
        const primaryOrigin = backend || location.origin;

        if (!token) {
            // The QR/link arrived without a token. That's only fine if the
            // backend isn't gating /ws on a session token — otherwise the WS
            // upgrade would 401 forever. Probe /api/ping (which is open) to
            // find out which case we're in.
            this._bootWithoutToken(primaryOrigin, altOrigin);
            return;
        }

        this._boot(primaryOrigin, altOrigin, token);
    }

    async _bootWithoutToken(primaryOrigin, altOrigin) {
        let tokenRequired = true;
        try {
            const res = await fetch(primaryOrigin + '/api/ping', { cache: 'no-store' });
            if (res.ok) {
                const body = await res.json().catch(() => null);
                if (body && body.tokenRequired === false) tokenRequired = false;
            }
        } catch (_) { /* network failure → fall through to fatal */ }

        if (tokenRequired) {
            this._showFatal('No session token. Re-scan the QR code on the desktop.');
            return;
        }
        this._boot(primaryOrigin, altOrigin, '');
    }

    _boot(primaryOrigin, altOrigin, token) {
        this.socket = new BridgeSocket({
            url: wsBaseFromHttp(primaryOrigin),
            altUrls: altOrigin ? [wsBaseFromHttp(altOrigin)] : [],
            token,
        });

        this.kbd = new VirtualKeyboard(this.kbdEl, {
            onInput: (kind, payload) => {
                sounds.play('key');
                if (kind === 'term-keys' || kind === 'hotkey') {
                    payload.id = this._activeTabId;
                }
                this.socket.sendInput(kind, payload);
            },
        });

        // Premium-feature gate — default the DASH/FLEET manager tab to HIDDEN
        // (fail safe) until /api/capabilities proves this install is entitled.
        this._caps = { manager: false };
        this._applyManagerGate();
        this._pullCapabilities();

        this._wireSocket();
        this._wireUi();
        this._buildDiagPanel();
        this._wireWebPreview();

        // Honour a `?view=`/`#view=` deep link (see INITIAL_VIEW) once the views
        // and bottom-bar are wired; otherwise the HTML default (terminal) stands.
        if (INITIAL_VIEW) this._showView(INITIAL_VIEW);

        window.addEventListener('resize', () => this._fitTerminalFont());

        this.termEl.addEventListener('scroll', () => {
            this._userScrolledUp = !this._isAtBottom();
            this._updateTermJump();
        }, { passive: true });

        // "Jump to latest" pill: when the user has scrolled up in the terminal
        // and new output is streaming below, tap to snap back to the live tail.
        if (this.termJump) {
            this.termJump.addEventListener('click', () => {
                this._userScrolledUp = false;
                this._scrollTermBottom();
                this._updateTermJump();
            });
        }

        this.socket.connect();
    }

    /* ── Settings / Themes ── */

    _renderThemeGrid() {
        this.themeGrid.innerHTML = '';
        for (const [id, theme] of Object.entries(THEMES)) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'theme-swatch' + (id === this._currentTheme ? ' active' : '');
            btn.dataset.theme = id;

            const [bgColor, accentColor] = theme.preview;
            btn.innerHTML = `
                <div class="swatch-preview" style="background:${bgColor};">
                    <div style="position:absolute;inset:25%;border-radius:50%;background:${accentColor};"></div>
                </div>
                <span class="swatch-name">${escapeHtml(theme.name)}</span>
            `;
            btn.addEventListener('click', () => this._selectTheme(id));
            this.themeGrid.appendChild(btn);
        }
    }

    _selectTheme(id) {
        if (!THEMES[id]) return;
        this._currentTheme = id;
        applyTheme(id);
        this.themeGrid.querySelectorAll('.theme-swatch').forEach(el => {
            el.classList.toggle('active', el.dataset.theme === id);
        });
    }

    _renderSoundGrid() {
        this.soundGrid.innerHTML = '';
        const current = sounds.getProfile();
        for (const { key, name } of sounds.listProfiles()) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sound-option' + (key === current ? ' active' : '');
            btn.dataset.profile = key;
            btn.textContent = name;
            btn.addEventListener('click', () => this._selectSoundProfile(key));
            this.soundGrid.appendChild(btn);
        }
    }

    _selectSoundProfile(key) {
        sounds.setProfile(key);
        this.soundGrid.querySelectorAll('.sound-option').forEach(el => {
            el.classList.toggle('active', el.dataset.profile === key);
        });
        sounds.play('tabSwitch');
    }

    _wireSettings() {
        if (!this.settingsOverlay || !this.settingsClose) return;
        this.btnSettings.addEventListener('click', () => this._openSettings());
        this.settingsClose.addEventListener('click', () => this._closeSettings());
        this.settingsOverlay.addEventListener('click', (e) => {
            if (e.target === this.settingsOverlay) this._closeSettings();
        });
        this._wireWindowControls();
        this._wireReloadControls();
    }

    // Desktop-window presets: ask the server to resize/move the desktop SoA
    // window (Chrome) via AppleScript. Result/errors come back as a notice.
    _wireWindowControls() {
        const btns = this.settingsOverlay.querySelectorAll('[data-win]');
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = btn.getAttribute('data-win');
                this.socket.sendInput('window-control', { preset });
                if ('vibrate' in navigator) { try { navigator.vibrate(8); } catch (_) {} }
                sounds.play('tabSwitch');
            });
        });
    }

    // Reload controls. Deliberately client-local so they work even when the
    // desktop is wedged: soft reload just bounces the websocket + re-renders
    // from the latest snapshot; force reload wipes caches + SW and pulls
    // everything fresh. Neither touches the desktop session state.
    _wireReloadControls() {
        if (this.btnReload) {
            this.btnReload.addEventListener('click', () => this._softReload());
        }
        if (this.btnForceReload) {
            this.btnForceReload.addEventListener('click', () => this._forceReload());
        }
    }

    _softReload() {
        this._closeSettings();
        try { this.socket && this.socket.close(); } catch (_) {}
        // Reset local render state so the next snapshot rebuilds from scratch
        // rather than diffing against stale data from before the hang.
        this._snapshot = null;
        this._tabStates = new Map();
        this._hasReceivedSnapshot = false;
        if (this.termEl) this.termEl.innerHTML = '';
        try { this.socket && this.socket.connect(); } catch (_) {}
    }

    async _forceReload() {
        if (!confirm('Force reload will clear cached assets and reload the app. Continue?')) return;
        this._closeSettings();
        try { this.socket && this.socket.close(); } catch (_) {}
        // Nuke the service-worker cache so the reload pulls fresh JS/CSS/HTML
        // instead of whatever the SW had pinned. Keep localStorage intact so
        // the session token + theme survive.
        try {
            if ('caches' in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            }
        } catch (_) {}
        try {
            if (navigator.serviceWorker) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(r => r.unregister()));
            }
        } catch (_) {}
        // Cache-busted URL to bypass any disk cache the browser still has.
        const url = new URL(location.href);
        url.searchParams.set('_r', Date.now().toString(36));
        location.replace(url.toString());
    }

    _openSettings() {
        if (this.settingsOverlay) this.settingsOverlay.classList.add('open');
        this._refreshModelAccess();
    }

    // Authed JSON call against the backend (cookie + ?t= token like _refreshWidgets).
    async _api(path, body) {
        const base = (this.socket && this.socket.baseUrl)
            ? this.socket.baseUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '') : '';
        const tok = this.socket && this.socket.token;
        const url = base + path + (tok ? (path.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(tok) : '');
        const res = await fetch(url, {
            method: body ? 'POST' : 'GET',
            credentials: 'include',
            cache: 'no-store',
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        return res.json();
    }

    /* ── Model Access (provider profiles) + Auto-Resume settings ── */

    async _refreshModelAccess() {
        const listEl = document.getElementById('provider-list');
        if (!listEl) return;
        try {
            const env = await this._api('/api/env');
            this._envConfig = env;
            this._renderProviderList(env);
        } catch (_) {
            listEl.innerHTML = '<div class="settings-hint">Could not load providers.</div>';
        }
        // Manager-gated: skip the fetch on a free install (403 anyway).
        if (this._caps && this._caps.manager) {
            try {
                const mgr = await this._api('/api/manager');
                this._setAutoResumeBtn(!!mgr.autoResume);
                this._setCloseInactiveBtn(!!mgr.closeInactive);
            } catch (_) {}
        }
    }

    _setAutoResumeBtn(on) {
        const btn = document.getElementById('btn-auto-resume');
        if (!btn) return;
        this._autoResume = on;
        btn.textContent = 'AUTO-RESUME: ' + (on ? 'ON' : 'OFF');
        btn.classList.toggle('active', on);
    }

    _setCloseInactiveBtn(on) {
        const btn = document.getElementById('btn-close-inactive');
        if (!btn) return;
        this._closeInactive = on;
        btn.textContent = 'CLOSE INACTIVE: ' + (on ? 'ON' : 'OFF');
        btn.classList.toggle('active', on);
    }

    _renderProviderList(env) {
        const listEl = document.getElementById('provider-list');
        if (!listEl) return;
        const rows = [];
        const mkRow = (id, name, detail, isActive, deletable) =>
            `<div class="provider-row${isActive ? ' active' : ''}" data-pid="${escapeHtml(id)}">` +
            `<span class="provider-dot"></span>` +
            `<span class="provider-name">${escapeHtml(name)}</span>` +
            `<span class="provider-detail">${escapeHtml(detail)}</span>` +
            (deletable ? `<button type="button" class="provider-edit" data-edit="${escapeHtml(id)}">✎</button>` +
                         `<button type="button" class="provider-del" data-del="${escapeHtml(id)}">×</button>` : '') +
            `</div>`;
        rows.push(mkRow('', 'Subscription', 'claude.ai login (default)', !env.active, false));
        for (const p of env.providers || []) {
            const host = (p.baseUrl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
            rows.push(mkRow(p.id, p.name, `${host || 'api.anthropic.com'} · ${p.token || 'no key'}`, env.active === p.id, true));
        }
        listEl.innerHTML = rows.join('');
    }

    _wireModelAccess() {
        const listEl = document.getElementById('provider-list');
        const form = document.getElementById('provider-form');
        const addBtn = document.getElementById('btn-provider-add');
        const arBtn = document.getElementById('btn-auto-resume');
        const ciBtn = document.getElementById('btn-close-inactive');
        if (!listEl || !form) return;
        const f = (id) => document.getElementById(id);
        const showForm = (p) => {
            form.hidden = false;
            f('pf-id').value = p ? p.id : '';
            f('pf-name').value = p ? p.name : '';
            f('pf-baseurl').value = p ? p.baseUrl : '';
            f('pf-token').value = p ? (p.token || '') : '';   // masked = keep stored
            f('pf-tokenvar').value = p ? p.tokenVar : 'ANTHROPIC_AUTH_TOKEN';
            f('pf-model').value = p ? p.model : '';
        };
        listEl.addEventListener('click', async (e) => {
            const del = e.target.closest('[data-del]');
            const edit = e.target.closest('[data-edit]');
            const row = e.target.closest('.provider-row');
            try {
                if (del) {
                    const r = await this._api('/api/env', { providerAction: 'delete', providerId: del.dataset.del });
                    this._envConfig = r; this._renderProviderList(r);
                } else if (edit) {
                    const p = (this._envConfig.providers || []).find(x => x.id === edit.dataset.edit);
                    if (p) showForm(p);
                } else if (row) {
                    const r = await this._api('/api/env', { active: row.dataset.pid });
                    this._envConfig = r; this._renderProviderList(r);
                    this._toast(row.dataset.pid ? 'Provider set for new shells' : 'Back to subscription');
                }
            } catch (_) { this._toast('Update failed'); }
        });
        if (addBtn) addBtn.addEventListener('click', () => showForm(null));
        const cancel = f('pf-cancel');
        if (cancel) cancel.addEventListener('click', () => { form.hidden = true; });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const provider = {
                id: f('pf-id').value || undefined,
                name: f('pf-name').value,
                baseUrl: f('pf-baseurl').value,
                token: f('pf-token').value,
                tokenVar: f('pf-tokenvar').value,
                model: f('pf-model').value,
            };
            if (!provider.name.trim()) return this._toast('Name required');
            try {
                const r = await this._api('/api/env', { providerAction: 'upsert', provider });
                this._envConfig = r; this._renderProviderList(r);
                form.hidden = true;
            } catch (_) { this._toast('Save failed'); }
        });
        if (arBtn) arBtn.addEventListener('click', async () => {
            try {
                const r = await this._api('/api/manager/config', { autoResume: !this._autoResume });
                this._setAutoResumeBtn(!!r.autoResume);
            } catch (_) { this._toast('Update failed'); }
        });
        if (ciBtn) ciBtn.addEventListener('click', async () => {
            try {
                const r = await this._api('/api/manager/config', { closeInactive: !this._closeInactive });
                this._setCloseInactiveBtn(!!r.closeInactive);
            } catch (_) { this._toast('Update failed'); }
        });
    }

    _closeSettings() {
        if (this.settingsOverlay) this.settingsOverlay.classList.remove('open');
        this._stopMicMonitor();
    }

    /* ── Microphone Settings ── */

    _loadMicSettings() {
        try {
            const saved = localStorage.getItem(MIC_SETTINGS_KEY);
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (_) {}
        return { deviceId: 'default', gain: 100 };
    }

    _saveMicSettings() {
        try {
            localStorage.setItem(MIC_SETTINGS_KEY, JSON.stringify(this._micSettings));
        } catch (_) {}
    }

    // Terminal font preference. The slider is a percentage over the auto-fit
    // default (100% = auto). Applied live and persisted per device.
    _wireFontSetting() {
        if (!this.fontScaleSlider) return;
        const sync = () => {
            const pct = Math.round((this._fontScale || 1) * 100);
            this.fontScaleSlider.value = String(pct);
            if (this.fontScaleValue) {
                this.fontScaleValue.textContent = pct === 100 ? '100% · auto' : `${pct}%`;
            }
        };
        sync();
        this.fontScaleSlider.addEventListener('input', (e) => {
            const pct = parseInt(e.target.value, 10) || 100;
            this._fontScale = pct / 100;
            if (this.fontScaleValue) this.fontScaleValue.textContent = pct === 100 ? '100% · auto' : `${pct}%`;
            try { localStorage.setItem(FONT_SCALE_KEY, String(this._fontScale)); } catch (_) {}
            this._fitTerminalFont();
            this._scrollTermBottom();
        });
        if (this.btnFontReset) {
            this.btnFontReset.addEventListener('click', () => {
                this._fontScale = 1;
                try { localStorage.removeItem(FONT_SCALE_KEY); } catch (_) {}
                sync();
                this._fitTerminalFont();
                this._scrollTermBottom();
                sounds.play('tabSwitch');
            });
        }
    }

    _wireMicSettings() {
        if (!this.micDeviceSelect || !this.micGainSlider) return;

        // Load saved settings
        if (this.micGainSlider) {
            this.micGainSlider.value = this._micSettings.gain;
            if (this.micGainValue) this.micGainValue.textContent = `${this._micSettings.gain}%`;
        }

        // Enumerate devices on load
        this._enumerateMicDevices();

        // Device selection
        this.micDeviceSelect.addEventListener('change', (e) => {
            this._micSettings.deviceId = e.target.value;
            this._saveMicSettings();
            // If mic is active, restart with new device
            if (this._micStream) {
                this._stopMicMonitor();
                this._startMicMonitor();
            }
        });

        // Gain control
        this.micGainSlider.addEventListener('input', (e) => {
            const gain = parseInt(e.target.value, 10);
            this._micSettings.gain = gain;
            if (this.micGainValue) this.micGainValue.textContent = `${gain}%`;
            this._saveMicSettings();
            // Apply gain in real-time if monitoring
            if (this._micGainNode) {
                this._micGainNode.gain.value = gain / 100;
            }
        });

        // Test mic button
        if (this.btnTestMic) {
            this.btnTestMic.addEventListener('click', () => this._toggleMicMonitor());
        }

        // Refresh devices button
        if (this.btnRefreshDevices) {
            this.btnRefreshDevices.addEventListener('click', () => this._enumerateMicDevices(true));
        }
    }

    async _enumerateMicDevices(requestPermission = false) {
        if (!this.micDeviceSelect) return;

        try {
            // Only prompt for the microphone when the user explicitly opts in
            // (taps REFRESH DEVICES / TEST MIC). On load we just list devices —
            // labels stay generic until permission is granted. Requesting mic on
            // boot is intrusive and an App Store review risk (sensitive perm with
            // no user intent), so it is gated behind an explicit action.
            if (requestPermission) {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(t => t.stop());
            }

            const devices = await navigator.mediaDevices.enumerateDevices();
            this._micDevices = devices.filter(d => d.kind === 'audioinput');

            this.micDeviceSelect.innerHTML = '';

            if (this._micDevices.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'No microphones found';
                this.micDeviceSelect.appendChild(opt);
                return;
            }

            // Add default option
            const defaultOpt = document.createElement('option');
            defaultOpt.value = 'default';
            defaultOpt.textContent = 'Default Microphone';
            this.micDeviceSelect.appendChild(defaultOpt);

            // Add each device
            for (const device of this._micDevices) {
                const opt = document.createElement('option');
                opt.value = device.deviceId;
                opt.textContent = device.label || `Microphone ${this._micDevices.indexOf(device) + 1}`;
                this.micDeviceSelect.appendChild(opt);
            }

            // Restore saved selection
            if (this._micSettings.deviceId) {
                this.micDeviceSelect.value = this._micSettings.deviceId;
            }

        } catch (err) {
            console.error('Failed to enumerate mic devices:', err);
            this.micDeviceSelect.innerHTML = '<option value="">Permission denied</option>';
        }
    }

    async _toggleMicMonitor() {
        if (this._micStream) {
            this._stopMicMonitor();
            if (this.btnTestMic) this.btnTestMic.textContent = 'TEST MIC';
        } else {
            const success = await this._startMicMonitor();
            if (success && this.btnTestMic) {
                this.btnTestMic.textContent = 'STOP TEST';
            }
        }
    }

    async _startMicMonitor() {
        try {
            const constraints = {
                audio: {
                    deviceId: this._micSettings.deviceId === 'default'
                        ? undefined
                        : { exact: this._micSettings.deviceId },
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: false,
                }
            };

            this._micStream = await navigator.mediaDevices.getUserMedia(constraints);

            // Create audio context for analysis
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            const audioContext = new AudioContext();
            const source = audioContext.createMediaStreamSource(this._micStream);

            // Gain node for volume control
            this._micGainNode = audioContext.createGain();
            this._micGainNode.gain.value = this._micSettings.gain / 100;

            // Analyser for level metering
            this._micAnalyser = audioContext.createAnalyser();
            this._micAnalyser.fftSize = 256;
            this._micAnalyser.smoothingTimeConstant = 0.8;

            source.connect(this._micGainNode).connect(this._micAnalyser);

            // Start monitoring
            this._updateMicMeter();

            return true;
        } catch (err) {
            console.error('Failed to start mic monitor:', err);
            alert('Failed to access microphone: ' + err.message);
            return false;
        }
    }

    _stopMicMonitor() {
        if (this._micMonitorInterval) {
            clearInterval(this._micMonitorInterval);
            this._micMonitorInterval = null;
        }

        if (this._micStream) {
            this._micStream.getTracks().forEach(track => track.stop());
            this._micStream = null;
        }

        if (this._micAnalyser) {
            try {
                this._micAnalyser.disconnect();
            } catch (_) {}
            this._micAnalyser = null;
        }

        if (this._micGainNode) {
            try {
                this._micGainNode.disconnect();
            } catch (_) {}
            this._micGainNode = null;
        }

        if (this.micMeterBar) {
            this.micMeterBar.style.width = '0%';
        }

        if (this.btnTestMic) {
            this.btnTestMic.textContent = 'TEST MIC';
        }
    }

    _updateMicMeter() {
        if (!this._micAnalyser || !this.micMeterBar) return;

        const update = () => {
            if (!this._micAnalyser) return;

            const dataArray = new Uint8Array(this._micAnalyser.frequencyBinCount);
            this._micAnalyser.getByteTimeDomainData(dataArray);

            // Calculate RMS level
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                const normalized = (dataArray[i] - 128) / 128;
                sum += normalized * normalized;
            }
            const rms = Math.sqrt(sum / dataArray.length);
            const db = 20 * Math.log10(rms + 0.0001);
            const level = Math.max(0, Math.min(100, (db + 60) * (100 / 60)));

            if (this.micMeterBar) {
                this.micMeterBar.style.width = `${level}%`;
                // Color code: green -> yellow -> red
                if (level < 70) {
                    this.micMeterBar.style.background = 'var(--accent)';
                } else if (level < 90) {
                    this.micMeterBar.style.background = 'var(--warn)';
                } else {
                    this.micMeterBar.style.background = 'var(--err)';
                }
            }

            if (this._micStream) {
                requestAnimationFrame(update);
            }
        };

        update();
    }

    /* ── Auto-hide chrome ── */

    _wireIdleHide() {
        const app = document.getElementById('app');
        const resetIdle = () => this._showChrome();
        for (const evt of ['pointerdown', 'pointermove', 'keydown', 'touchstart']) {
            app.addEventListener(evt, resetIdle, { passive: true });
        }
        this._resetIdleTimer();
    }

    _resetIdleTimer() {
        clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(() => {
            if (this.settingsOverlay && this.settingsOverlay.classList.contains('open')) return;
            if (this.reconnectOverlay && !this.reconnectOverlay.hidden) return;
            this._hideChrome();
        }, 5000);
    }

    _hideChrome() {
        if (this._chromeHidden) return;
        // Only auto-hide over the terminal (to maximise reading area). On the
        // DASH/FLEET, CHAT, BROWSER and SYSTEM views the top bar is the primary
        // navigation, so hiding it would strand the user.
        if (this._currentView && this._currentView !== 'terminal-view') return;
        this._chromeHidden = true;
        const top = document.getElementById('topbar');
        if (top) top.classList.add('chrome-hidden');
        if (this.kbdEl) this.kbdEl.classList.add('chrome-hidden');
        this._pullHint.classList.add('visible');
    }

    _showChrome() {
        if (this._chromeHidden) {
            this._chromeHidden = false;
            const top = document.getElementById('topbar');
            if (top) top.classList.remove('chrome-hidden');
            if (this.kbdEl) this.kbdEl.classList.remove('chrome-hidden');
            this._pullHint.classList.remove('visible');
        }
        this._resetIdleTimer();
    }

    /* ── Socket ── */

    _wireSocket() {
        this.socket.addEventListener('state', (ev) => {
            const { state, attempt, code } = ev.detail;
            switch (state) {
                case SocketState.CONNECTING:
                    this._setStatus('connecting', `connecting${attempt > 1 ? ` · try ${attempt}` : '…'}`);
                    if (attempt > 1) this._scheduleReconnect(`attempt ${attempt}`);
                    break;
                case SocketState.CONNECTED:
                    this._setStatus('connected', 'paired');
                    this._hideReconnect();
                    this._acquireWakeLock();        // keep the screen on while streaming
                    if (this._prevSocketState !== SocketState.CONNECTED) sounds.play('connect');
                    break;
                case SocketState.DISCONNECTED:
                    this._setStatus('disconnected', `link lost${code ? ` (${code})` : ''}`);
                    this._scheduleReconnect('link lost · retrying');
                    this._releaseWakeLock();
                    if (this._prevSocketState === SocketState.CONNECTED) sounds.play('disconnect');
                    break;
            }
            this._prevSocketState = state;
        });

        this.socket.addEventListener('reconnect-scheduled', (ev) => {
            const { delay } = ev.detail;
            const secs = Math.max(0, Math.round(delay / 100) / 10);
            this.reconnectSub.textContent = secs > 0
                ? `retrying in ${secs}s`
                : 'retrying now…';
        });

        this._msgCounts = { hello: 0, snapshot: 0, 'term-data': 0, notice: 0, other: 0 };
        this._lastMsgAt = 0;

        this.socket.addEventListener('message', (ev) => {
            const msg = ev.detail;
            this._lastMsgAt = Date.now();
            this._msgCounts[msg.t] = (this._msgCounts[msg.t] || 0) + 1;
            switch (msg.t) {
                case 'hello':    this._applyHello(msg.d); break;
                case 'snapshot': this._applySnapshot(msg.d); break;
                // Background tabs' scrollback, streamed one frame per tab after
                // HELLO (active tab ships inline with HELLO). Same handling as a
                // live term-data chunk: write the off-screen buffer + classify.
                case 'replay':    this._applyTerminalChunk(msg.d); break;
                case 'term-data': this._applyTerminalChunk(msg.d); break;
                case 'term-exit': break;
                case 'notice':    this._showNotice(msg.d); break;
                case 'tts':       this._onTTS(msg.d); this._onAgentMessage(msg.d); break;
                case 'browser-frame': this._onBrowserFrame(msg.d); break;
                case 'manager':   this._onManager(msg.d); break;
            }
        });

        this.socket.addEventListener('diagnosis', (ev) => {
            this._showDiagnosis(ev.detail.diagnosis);
        });

        this.socket.addEventListener('endpoint-switched', (ev) => {
            const host = (() => {
                try { return new URL(ev.detail.url.replace(/^ws/, 'http')).host; }
                catch (_) { return ev.detail.url; }
            })();
            this.reconnectSub.textContent = `trying alternate link · ${host}`;
        });
    }

    _wireUi() {
        this.viewBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.getAttribute('data-view');
                this._showView(target);
            });
        });

        this.btnNewTab.addEventListener('click', () => this._showNewTabChooser());
        this.btnMic.addEventListener('click', () => this.socket.sendInput('voice-toggle'));

        // Chat composer: send a message to the active tab's PTY (exactly like
        // typing it in the terminal) and echo it as an outgoing bubble.
        if (this.chatComposer && this.chatInput) {
            const autosize = () => {
                this.chatInput.style.height = 'auto';
                this.chatInput.style.height = Math.min(120, this.chatInput.scrollHeight) + 'px';
            };
            this.chatInput.addEventListener('input', autosize);
            this.chatComposer.addEventListener('submit', (e) => { e.preventDefault(); this._sendChat(); });
            // Enter sends; Shift+Enter inserts a newline (desktop keyboards).
            this.chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendChat(); }
            });
        }

        if (this.btnSpeak) {
            this.btnSpeak.setAttribute('aria-pressed', this._ttsEnabled ? 'true' : 'false');
            this.btnSpeak.addEventListener('click', () => {
                this._ttsEnabled = !this._ttsEnabled;
                this.btnSpeak.setAttribute('aria-pressed', this._ttsEnabled ? 'true' : 'false');
                try { localStorage.setItem('soa_web_tts', this._ttsEnabled ? '1' : '0'); } catch (_) {}
                if (this._ttsEnabled) this._speak('Speech on.');      // tap unlocks iOS speech
                else if (window.speechSynthesis) window.speechSynthesis.cancel();
            });
        }

        // Camera / photo → upload → drop the file path into the active terminal
        // (Claude reads the image, text-in-image included).
        if (this.btnCamera && this.cameraInput) {
            this.btnCamera.addEventListener('click', () => this.cameraInput.click());
            this.cameraInput.addEventListener('change', () => {
                const file = this.cameraInput.files && this.cameraInput.files[0];
                this.cameraInput.value = '';           // allow re-picking the same file
                if (file) this._sendPhoto(file);
            });
        }

        // Focus / fullscreen toggle.
        if (this.btnFullscreen) {
            this.btnFullscreen.addEventListener('click', () => this._toggleFocus());
        }
        const focusExit = document.getElementById('focus-exit');
        if (focusExit) focusExit.addEventListener('click', () => this._toggleFocus(false));

        // Re-acquire the wake lock when returning to the tab (locks drop on hide).
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && this.socket && this.socket.state === 'connected') {
                this._acquireWakeLock();
            }
        });

        // Keyboard-aware layout: pin #app to the *visible* viewport so the bottom
        // bar / keyboard toolbar sit above the on-screen keyboard, not under it.
        if (window.visualViewport) {
            const appEl = document.getElementById('app');
            const fit = () => {
                const vv = window.visualViewport;
                appEl.style.height = vv.height + 'px';
                // Keep the prompt in view as the keyboard animates — but ONLY if
                // the user is already parked at the bottom. If they've scrolled up
                // to read, yanking them back to the bottom on every keyboard
                // open/close/scroll event is the classic mobile-terminal fight.
                if (!this._userScrolledUp) this._scrollTermBottom();
            };
            window.visualViewport.addEventListener('resize', fit);
            window.visualViewport.addEventListener('scroll', fit);
        }

        // Tapping the terminal is the explicit "I want to type" gesture — this
        // is the ONLY place that raises the keyboard. Switching views (incl. from
        // the dashboard) never engages it on its own.
        this.termEl.addEventListener('click', () => {
            this._showView('terminal-view');
            this.kbd.show();
            this.kbd.focus();
        });

        this.reconnectRetry.addEventListener('click', () => {
            this.reconnectSub.textContent = 'retrying now…';
            this.socket.retryNow();
        });

        this.reconnectOpenBrowser.addEventListener('click', () => {
            window.open('http://captive.apple.com/hotspot-detect.html', '_blank');
        });
    }

    _showView(target) {
        // Premium-feature gate: the DASH/FLEET view is manager-only. On a
        // free/unlicensed install (`capabilities.manager` false) navigating to
        // it is a no-op that falls back to the terminal — the /api/manager
        // endpoint would only 403 anyway. Fails safe to hidden (see _caps init).
        if (target === 'tiles-view' && !(this._caps && this._caps.manager)) {
            target = 'terminal-view';
        }
        this._currentView = target;
        this.viewEls.forEach(v => v.classList.toggle('active', v.id === target));
        this.viewBtns.forEach(b => b.setAttribute('aria-pressed', b.getAttribute('data-view') === target ? 'true' : 'false'));
        this._updateTermJump();
        if (target === 'terminal-view') {
            // Don't auto-raise the keyboard on entry (e.g. tapping a dashboard
            // tile). It appears only when the user taps the terminal to type.
        } else {
            this.kbd.hide();
            this.kbd.blur();
        }
        // Chat: render the active tab's thread and clear the unread badge.
        if (target === 'chat-view') {
            this._chatUnread = 0;
            this._updateChatBadge();
            this._renderChat();
            this._renderChatStatus();
            setTimeout(() => { try { this.chatInput && this.chatInput.focus(); } catch (_) {} }, 60);
        }
        if (target === 'web-view') {
            this._refreshWebPorts();
            if (this._agentMode) this.socket.sendInput('browser-subscribe');
        } else if (this._agentMode) {
            this.socket.sendInput('browser-unsubscribe');   // pause stream when away
        }
        // Dashboard: render immediately, then keep the terminal-tail previews
        // live with a 1s tick while the view is open (cheap; stopped on leave).
        if (target === 'tiles-view') {
            this._pullManager();          // freshen the server fleet view on open
            this._renderFleet();
            if (!this._tilesTimer) this._tilesTimer = setInterval(() => this._renderFleet(), 1200);
        } else if (this._tilesTimer) {
            clearInterval(this._tilesTimer);
            this._tilesTimer = null;
        }
        // System: poll host/cpu/ram/device while the view is open.
        if (target === 'widgets-view') {
            this._refreshWidgets();
            if (!this._widgetsTimer) this._widgetsTimer = setInterval(() => this._refreshWidgets(), 2000);
        } else if (this._widgetsTimer) {
            clearInterval(this._widgetsTimer);
            this._widgetsTimer = null;
        }
    }

    async _refreshWidgets() {
        if (!this.widgetsEl) return;
        const get = async (p) => {
            try {
                const base = (this.socket && this.socket.baseUrl)
                    ? this.socket.baseUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '') : '';
                const tok = this.socket && this.socket.token;
                const res = await fetch(base + p + (tok ? (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(tok) : ''),
                    { credentials: 'include', cache: 'no-store' });
                if (!res.ok) return null;
                return (await res.json()).data;
            } catch (_) { return null; }
        };
        const [sysd, cpu, ram, dev] = await Promise.all([get('/api/sys'), get('/api/cpu'), get('/api/ram'), get('/api/device')]);
        const GB = 1073741824;
        const cards = [];
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        cards.push(card('CLOCK', `${hh}:${mm}:${ss}`, now.toDateString()));
        if (sysd) cards.push(card('HOST', sysd.hostname || '—', `${(sysd.platform || '').toUpperCase()} · ${sysd.arch || ''}`));
        if (cpu && Array.isArray(cpu.loadavg) && cpu.cores) {
            cards.push(meterCard('CPU LOAD', Math.min(100, Math.round((cpu.loadavg[0] / cpu.cores) * 100))));
            cards.push(card('CPU', cpu.model || '—', `${cpu.cores} cores`));
        }
        if (ram && ram.usedPct != null) {
            cards.push(meterCard('MEMORY', ram.usedPct));
            cards.push(card('MEMORY', `${(ram.used / GB).toFixed(1)} / ${(ram.total / GB).toFixed(0)} GB`, `${ram.usedPct}% used`));
        }
        if (dev) {
            const bat = dev.battery != null ? `${dev.battery}%${dev.charging ? ' ⚡' : ''}` : 'N/A';
            const meta = `${dev.online ? 'online' : 'offline'}${dev.cpuTemp != null ? ' · ' + dev.cpuTemp + '°C' : ''}${dev.batteryHealth != null ? ' · health ' + dev.batteryHealth + '%' : ''}`;
            cards.push(card('DEVICE', bat, meta));
        }
        this.widgetsEl.innerHTML = cards.join('')
            || `<div class="w-card"><h2>No data</h2><div class="w-meta">Desktop unreachable.</div></div>`;
    }

    // ── Dashboard (2-D tile view) ────────────────────────────────────────
    // Mirrors the desktop tiles: one card per tab with its status colour and a
    // live peek of the last few terminal lines, so you can tell at a glance
    // which project needs attention. Per the mobile design there is NO close
    // (×) button on a tile — tap a tile to jump into that tab's terminal.
    // Overarching supervisor summary (server-side, always-on). Shows fleet-wide
    // counts and flags which sessions need attention / are stuck / high-context.
    _onManager(d) {
        // Manager-gated: ignore fleet frames on a free/unlicensed install.
        if (!(this._caps && this._caps.manager)) return;
        this._manager = d;
        this._updateTodoBadge();
        if (this._currentView === 'tiles-view') this._renderFleet();
    }

    // Pull the authoritative server fleet view (also arrives live via the WS
    // `manager` frame, but a fetch on view-open avoids a cold first paint).
    async _pullManager() {
        // Manager-gated: skip the fetch entirely on a free install (403 anyway).
        if (!(this._caps && this._caps.manager)) return;
        try {
            const d = await this._api('/api/manager');
            if (d && d.ok !== false && d.counts) { this._manager = d; this._updateTodoBadge(); }
        } catch (_) { /* fall back to the last WS frame */ }
    }

    // Premium-feature gate — fetch the server's capability set and (re)apply the
    // manager gate. Fails safe: any error leaves `manager` DISABLED (hidden).
    async _pullCapabilities() {
        try {
            const d = await this._api('/api/capabilities');
            const mgr = !!(d && d.ok !== false && d.capabilities && d.capabilities.manager);
            this._caps = { manager: mgr };
        } catch (_) {
            this._caps = { manager: false };
        }
        this._applyManagerGate();
    }

    // Show/hide the DASH (tiles-view) top-bar tab per entitlement, and bounce
    // off the fleet view if it was somehow open while unentitled.
    _applyManagerGate() {
        const on = !!(this._caps && this._caps.manager);
        this.viewBtns.forEach(btn => {
            if (btn.getAttribute('data-view') === 'tiles-view') btn.hidden = !on;
        });
        if (!on && this._currentView === 'tiles-view') this._showView('terminal-view');
    }

    // ── FLEET manager view (SESSIONS · MONITOR · TO-DO + BROADCAST) ──────────
    _wireFleet() {
        this._fleetSub = 'sessions';
        this._bcastCohort = 'attention';
        document.querySelectorAll('.fleet-seg-btn').forEach(btn => {
            btn.addEventListener('click', () => this._setFleetSub(btn.dataset.fleet));
        });
        const bcBtn = document.getElementById('btn-broadcast');
        if (bcBtn) bcBtn.addEventListener('click', () => this._openBroadcast());
        const bcClose = document.getElementById('bcast-close');
        if (bcClose) bcClose.addEventListener('click', () => this._closeBroadcast());
        const bcOverlay = document.getElementById('broadcast-overlay');
        if (bcOverlay) bcOverlay.addEventListener('click', (e) => { if (e.target === bcOverlay) this._closeBroadcast(); });
        const bcForm = document.getElementById('bcast-form');
        if (bcForm) bcForm.addEventListener('submit', (e) => { e.preventDefault(); this._sendBroadcast(); });
        const todoForm = document.getElementById('todo-form');
        if (todoForm) todoForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const inp = document.getElementById('todo-input');
            const text = inp && inp.value.trim();
            if (text) { this._todoOp({ op: 'add', text, source: 'user' }); inp.value = ''; }
        });
    }

    _setFleetSub(sub) {
        this._fleetSub = sub;
        document.querySelectorAll('.fleet-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.fleet === sub));
        ['sessions', 'monitor', 'todos'].forEach(s => {
            const pane = document.getElementById('fleet-' + s);
            if (pane) pane.hidden = s !== sub;
        });
        this._renderFleet();
        if (sub === 'monitor') this._refreshMonitor();
    }

    // Master render for the DASH/FLEET view — dispatches to the active sub-pane.
    _renderFleet() {
        this._renderManagerBar();
        const sub = this._fleetSub || 'sessions';
        if (sub === 'sessions') this._renderTiles();
        else if (sub === 'todos') this._renderTodos();
        else if (sub === 'monitor') this._renderMonitor();
    }

    _updateTodoBadge() {
        const badge = document.getElementById('fleet-todo-badge');
        if (!badge) return;
        const open = ((this._manager && this._manager.todos) || []).filter(t => !t.done).length;
        badge.textContent = open ? String(open) : '';
        badge.hidden = !open;
    }

    _renderManagerBar() {
        const bar = document.getElementById('manager-bar');
        if (!bar) return;
        const d = this._manager;
        if (!d || !d.counts || !d.counts.total) { bar.hidden = true; return; }
        const c = d.counts;
        const chip = (label, n, cls) => n > 0
            ? `<span class="mgr-chip ${cls}">${n} ${label}</span>` : '';
        const attentionTabs = (d.sessions || []).filter(s => s.attention).map(s => s.title);
        const stuckTabs = (d.sessions || []).filter(s => s.stuck).map(s => s.title);
        const callout = [];
        if (attentionTabs.length) callout.push(`⚠ awaiting you: ${attentionTabs.slice(0, 3).join(', ')}${attentionTabs.length > 3 ? '…' : ''}`);
        if (stuckTabs.length) callout.push(`◷ stuck: ${stuckTabs.slice(0, 3).join(', ')}`);
        // Manager-active badge: lit when a fleet-manager tab is running; flips to
        // a warning style if tab-closing was opted into (closeInactive).
        const mgrBadge = d.managerActive
            ? `<span class="mgr-chip mgr-active${d.closeInactive ? ' mgr-active-reaping' : ''}">${d.closeInactive ? '◉ MGR · closing ON' : '◉ MGR'}</span>`
            : '';
        bar.innerHTML =
            `<div class="mgr-row">` +
            `<span class="mgr-title">FLEET · ${c.total}</span>` +
            mgrBadge +
            chip('working', c.working, 'mgr-working') +
            chip('need input', c.attention, 'mgr-attention') +
            chip('stuck', c.stuck, 'mgr-stuck') +
            chip('idle', c.idle, 'mgr-idle') +
            chip('high&nbsp;ctx', c.highContext, 'mgr-ctx') +
            chip('limited', c.limited, 'mgr-limited') +
            `</div>` +
            (callout.length ? `<div class="mgr-callout">${escapeHtml(callout.join('  ·  '))}</div>` : '');
        bar.hidden = false;
    }

    // Per-session oversight list. Uses the server supervisor view
    // (this._manager.sessions — the whole fleet, with authoritative status +
    // flags) as the source of truth, merged with local tab data (preview,
    // exited). Falls back to the local tab list before the first manager frame.
    _renderTiles() {
        if (!this.tilesEl) return;
        const sup = (this._manager && this._manager.sessions) || [];
        const tabs = (this._snapshot && this._snapshot.tabs) || [];
        const byId = new Map(tabs.map(t => [t.id, t]));
        // Prefer the supervisor list (full fleet); else the local tabs.
        const rows = sup.length
            ? sup.map(s => ({ sup: s, tab: byId.get(s.id) }))
            : tabs.map(t => ({ sup: null, tab: t }));
        if (!rows.length) {
            this.tilesEl.innerHTML = '<div class="m-tile-empty">No sessions yet — tap + to open one.</div>';
            return;
        }
        const hhmm = (ms) => { const d = new Date(ms); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); };
        const ago = (ms) => {
            if (ms == null) return '';
            const s = Math.round(ms / 1000);
            if (s < 60) return s + 's';
            const m = Math.round(s / 60);
            return m < 60 ? m + 'm' : Math.round(m / 60) + 'h';
        };
        const frag = document.createDocumentFragment();
        rows.forEach(({ sup: s, tab: t }, i) => {
            const id = s ? s.id : t.id;
            const exited = t ? !!t.exited : false;
            // Status: server truth first, else the local heuristic.
            const status = exited ? 'exited' : (s ? s.status : (this._mobileStatus && this._mobileStatus.get(id)) || 'idle');
            const css = exited ? 'exited' : cssStatus(status);
            const name = (s && s.title) || (t && t.title) || `TAB ${i + 1}`;
            const ts = this._tabStates && this._tabStates.get(id);
            if (ts && ts.term) this._scanCtx(id);
            const pct = (s && s.ctxPct != null) ? s.ctxPct : this._ctxPct.get(id);

            // Flags — the reason a human should care about this row.
            const flags = [];
            if (s && s.stuck) flags.push('<span class="fl fl-stuck">STUCK</span>');
            if (s && s.attention) flags.push('<span class="fl fl-attn">NEEDS YOU</span>');
            if (s && s.highContext) flags.push('<span class="fl fl-ctx">HIGH CTX</span>');
            if (s && s.limited) {
                const when = s.resumeAt ? `resume ${hhmm(s.resumeAt)}` : (s.limitResetAt ? `resets ${hhmm(s.limitResetAt)}` : 'limited');
                flags.push(`<span class="fl fl-limit">⏾ ${escapeHtml(when)}</span>`);
            }
            const idle = (s && s.idleMs != null && (status === 'idle' || status === 'done')) ? `idle ${ago(s.idleMs)}` : '';
            const meta = [this._tileStatusLabel(exited ? null : status, exited), idle].filter(Boolean).join(' · ');

            const ctxHtml = (pct != null)
                ? `<span class="fleet-ctx" title="Context ${pct}% used"><span class="fleet-ctx-bar"><span style="width:${pct}%;background:${ctxColor(pct)}"></span></span><span class="fleet-ctx-pct">${pct}%</span></span>`
                : '';

            // Model tier chip — which Claude model this session runs, from the
            // supervisor snapshot (live, tracks /model switches). Color-coded so
            // the odd one out (e.g. a Fable unstick) is spottable in the list.
            const mt = (function (r) {
                r = String(r || '').toLowerCase();
                if (r.includes('opus')) return 'opus';
                if (r.includes('sonnet')) return 'sonnet';
                if (r.includes('haiku')) return 'haiku';
                if (r.includes('fable') || r.includes('mythos')) return 'fable';
                return '';
            })(s && s.model);
            const modelHtml = mt ? `<span class="fleet-model" data-tier="${mt}">${mt}</span>` : '';

            const row = document.createElement('div');
            row.className = 'fleet-row' + (id === this._activeTabId ? ' active' : '');
            row.dataset.tabId = String(id);
            if (css) row.setAttribute('data-status', css);
            row.innerHTML =
                `<div class="fleet-main" data-open="${id}">` +
                    `<span class="fleet-dot"></span>` +
                    `<div class="fleet-body">` +
                        `<div class="fleet-line1"><span class="fleet-name">${escapeHtml(name)}</span>${flags.join('')}</div>` +
                        `<div class="fleet-line2"><span class="fleet-meta">${escapeHtml(meta)}</span>${modelHtml}${ctxHtml}</div>` +
                    `</div>` +
                `</div>` +
                `<button class="fleet-act" data-act-toggle="${id}" aria-label="Session actions">⋯</button>` +
                `<div class="fleet-actions" hidden>` +
                    `<button class="fleet-a" data-a="open" data-id="${id}">OPEN</button>` +
                    `<button class="fleet-a" data-a="interrupt" data-id="${id}">INTERRUPT</button>` +
                    `<button class="fleet-a" data-a="compact" data-id="${id}">COMPACT</button>` +
                    `<button class="fleet-a" data-a="cast" data-id="${id}">CAST…</button>` +
                `</div>`;
            frag.appendChild(row);
        });
        this.tilesEl.replaceChildren(frag);
        if (!this._fleetDelegated) {
            this._fleetDelegated = true;
            this.tilesEl.addEventListener('click', (e) => this._onFleetClick(e));
        }
    }

    _onFleetClick(e) {
        const open = e.target.closest('[data-open]');
        if (open) { this._openSession(+open.dataset.open); return; }
        const toggle = e.target.closest('[data-act-toggle]');
        if (toggle) {
            const row = toggle.closest('.fleet-row');
            const menu = row && row.querySelector('.fleet-actions');
            if (menu) menu.hidden = !menu.hidden;
            return;
        }
        const a = e.target.closest('.fleet-a');
        if (a) { this._fleetAction(a.dataset.a, +a.dataset.id); }
    }

    _openSession(id) {
        this._switchTabLocal(id);
        this._showView('terminal-view');
    }

    // Per-session actions, driven over the WS input path (the same reliable path
    // the keyboard uses) so they work from the phone over the tunnel.
    _fleetAction(action, id) {
        if (action === 'open') { this._openSession(id); return; }
        if (action === 'interrupt') { this.socket.sendInput('hotkey', { id, combo: 'ctrl+c' }); this._toast('Ctrl-C → ' + this._tabName(id)); }
        else if (action === 'compact') { this.socket.sendInput('term-keys', { id, text: '/compact\r' }); this._toast('/compact → ' + this._tabName(id)); }
        else if (action === 'cast') { this._openBroadcast([id]); return; }
        // collapse the menu after acting
        const row = this.tilesEl.querySelector(`.fleet-row[data-tab-id="${id}"] .fleet-actions`);
        if (row) row.hidden = true;
    }

    _tileStatusLabel(status, exited) {
        if (exited) return 'exited';
        switch (status) {
            case 'working':   return 'Working…';
            case 'attention': return 'Needs input';
            case 'done':      return 'Awaiting next prompt';
            case 'idle':      return 'Idle';
            default:          return 'Shell ready';
        }
    }

    // ── TO-DO list (manager) ─────────────────────────────────────────────────
    _renderTodos() {
        const listEl = document.getElementById('todo-list');
        if (!listEl) return;
        const todos = (this._manager && this._manager.todos) || [];
        if (!todos.length) {
            listEl.innerHTML = '<div class="m-tile-empty">No to-dos. Add one above — the fleet manager sees it too.</div>';
            return;
        }
        const rows = todos.map(td => {
            const tab = td.tab != null ? ` <span class="todo-tab">#${td.tab}</span>` : '';
            const src = td.source === 'manager' ? ' <span class="todo-src">◉ mgr</span>' : '';
            return `<div class="todo-item${td.done ? ' done' : ''}">` +
                `<button class="todo-check" data-toggle="${td.id}" aria-label="Toggle">${td.done ? '☑' : '☐'}</button>` +
                `<span class="todo-text">${escapeHtml(td.text)}${tab}${src}</span>` +
                `<button class="todo-del" data-del="${td.id}" aria-label="Delete">×</button>` +
                `</div>`;
        }).join('');
        listEl.innerHTML = rows;
        if (!this._todoDelegated) {
            this._todoDelegated = true;
            listEl.addEventListener('click', (e) => {
                const tog = e.target.closest('[data-toggle]');
                if (tog) { this._todoOp({ op: 'toggle', id: tog.dataset.toggle }); return; }
                const del = e.target.closest('[data-del]');
                if (del) { this._todoOp({ op: 'del', id: del.dataset.del }); }
            });
        }
    }

    async _todoOp(body) {
        try {
            const r = await this._api('/api/manager/todo', body);
            if (r && r.todos) {
                if (!this._manager) this._manager = {};
                this._manager.todos = r.todos;
                this._updateTodoBadge();
                this._renderTodos();
            }
        } catch (_) { this._toast('Could not reach the fleet manager.'); }
    }

    // ── MONITOR — agent browsers + localhost ports ───────────────────────────
    async _refreshMonitor() {
        try {
            const [ab, ports] = await Promise.all([
                this._api('/api/agent-browser', { action: 'list' }).catch(() => null),
                this._api('/api/ports').catch(() => null),
            ]);
            this._monitorData = { ab, ports };
        } catch (_) { this._monitorData = null; }
        this._renderMonitor();
    }

    _renderMonitor() {
        const el = document.getElementById('fleet-monitor');
        if (!el) return;
        const d = this._monitorData || {};
        const instances = (d.ab && (d.ab.instances || d.ab.list || d.ab.sessions)) || [];
        const portList = (d.ports && d.ports.data && d.ports.data.ports) || [];
        const abHtml = instances.length
            ? instances.map(ins => {
                const title = ins.title || ins.tabTitle || ('tab ' + (ins.tabId ?? ins.id ?? '?'));
                const url = ins.url || ins.currentUrl || '';
                return `<div class="mon-cell"><div class="mon-cell-t">${escapeHtml(title)}</div>` +
                    `<div class="mon-cell-u">${escapeHtml(url || 'idle')}</div></div>`;
            }).join('')
            : '<div class="m-tile-empty">No agent browsers open.</div>';
        const portHtml = portList.length
            ? portList.map(p => {
                const port = p.port || p;
                const name = p.name || p.process || '';
                return `<button class="mon-port" data-port="${escapeHtml(String(port))}">:${escapeHtml(String(port))}${name ? ` <span>${escapeHtml(name)}</span>` : ''}</button>`;
            }).join('')
            : '<div class="m-tile-empty">No local ports detected.</div>';
        el.innerHTML =
            `<div class="mon-sec-title">◉ AGENT BROWSERS</div>` +
            `<div class="mon-grid">${abHtml}</div>` +
            `<div class="mon-sec-title">⊞ LOCALHOST PORTS</div>` +
            `<div class="mon-ports">${portHtml}</div>`;
        if (!this._monDelegated) {
            this._monDelegated = true;
            el.addEventListener('click', (e) => {
                const p = e.target.closest('[data-port]');
                if (p) { this._openPortInWebView(p.dataset.port); }
            });
        }
    }

    _openPortInWebView(port) {
        this._showView('web-view');
        const inp = document.getElementById('web-url');
        if (inp) { inp.value = 'localhost:' + port; }
        const go = document.getElementById('web-go');
        if (go) go.click();
    }

    // ── BROADCAST — fan a command to a cohort of sessions ────────────────────
    _openBroadcast(preIds) {
        const overlay = document.getElementById('broadcast-overlay');
        if (!overlay) return;
        this._bcastPreIds = Array.isArray(preIds) ? preIds : null;
        if (this._bcastPreIds) this._bcastCohort = 'selected';
        this._renderBroadcast();
        overlay.classList.add('visible');
        setTimeout(() => { const i = document.getElementById('bcast-input'); if (i) i.focus(); }, 80);
    }

    _closeBroadcast() {
        const overlay = document.getElementById('broadcast-overlay');
        if (overlay) overlay.classList.remove('visible');
    }

    _renderBroadcast() {
        const sessions = (this._manager && this._manager.sessions) || [];
        const count = (pred) => sessions.filter(pred).length;
        const cohorts = [
            { key: 'all', label: 'All', n: sessions.length },
            { key: 'attention', label: 'Needs you', n: count(s => s.attention) },
            { key: 'stuck', label: 'Stuck', n: count(s => s.stuck) },
            { key: 'idle', label: 'Idle', n: count(s => s.idle) },
            { key: 'working', label: 'Working', n: count(s => s.status === 'working') },
            { key: 'highContext', label: 'High ctx', n: count(s => s.highContext) },
        ];
        if (this._bcastPreIds) cohorts.unshift({ key: 'selected', label: `#${this._bcastPreIds.join(', #')}`, n: this._bcastPreIds.length });
        const cEl = document.getElementById('bcast-cohorts');
        if (cEl) cEl.innerHTML = cohorts.map(c =>
            `<button class="bcast-chip${c.key === this._bcastCohort ? ' on' : ''}${c.n ? '' : ' empty'}" data-cohort="${c.key}">${escapeHtml(c.label)}<span class="bcast-n">${c.n}</span></button>`
        ).join('');
        const presets = [
            { label: 'continue', text: 'continue', enter: true },
            { label: '/compact', text: '/compact', enter: true },
            { label: '/clear', text: '/clear', enter: true },
            { label: 'Esc', hotkey: 'esc' },
            { label: 'Ctrl-C', hotkey: 'ctrl+c' },
        ];
        const pEl = document.getElementById('bcast-presets');
        if (pEl) pEl.innerHTML = presets.map((p, i) =>
            `<button class="bcast-preset" data-preset="${i}">${escapeHtml(p.label)}</button>`).join('');
        this._bcastPresets = presets;
        if (!this._bcastDelegated) {
            this._bcastDelegated = true;
            if (cEl) cEl.addEventListener('click', (e) => {
                const c = e.target.closest('[data-cohort]');
                if (c) { this._bcastCohort = c.dataset.cohort; this._renderBroadcast(); }
            });
            if (pEl) pEl.addEventListener('click', (e) => {
                const b = e.target.closest('[data-preset]');
                if (!b) return;
                const p = this._bcastPresets[+b.dataset.preset];
                if (p.hotkey) this._sendBroadcast(p);
                else { const inp = document.getElementById('bcast-input'); if (inp) inp.value = p.text; this._sendBroadcast(p); }
            });
        }
    }

    _broadcastTargets() {
        const sessions = (this._manager && this._manager.sessions) || [];
        const c = this._bcastCohort;
        if (c === 'selected' && this._bcastPreIds) return this._bcastPreIds.slice();
        if (c === 'all') return sessions.map(s => s.id);
        if (c === 'attention') return sessions.filter(s => s.attention).map(s => s.id);
        if (c === 'stuck') return sessions.filter(s => s.stuck).map(s => s.id);
        if (c === 'idle') return sessions.filter(s => s.idle).map(s => s.id);
        if (c === 'working') return sessions.filter(s => s.status === 'working').map(s => s.id);
        if (c === 'highContext') return sessions.filter(s => s.highContext).map(s => s.id);
        return [];
    }

    _sendBroadcast(preset) {
        const ids = this._broadcastTargets();
        if (!ids.length) { this._toast('No sessions in that cohort.'); return; }
        const enterEl = document.getElementById('bcast-enter');
        const wantEnter = enterEl ? enterEl.checked : true;
        if (preset && preset.hotkey) {
            ids.forEach(id => this.socket.sendInput('hotkey', { id, combo: preset.hotkey }));
        } else {
            const inp = document.getElementById('bcast-input');
            const text = preset ? preset.text : (inp ? inp.value : '');
            if (!text) { this._toast('Type a command first.'); return; }
            const line = text + ((preset ? preset.enter : wantEnter) ? '\r' : '');
            ids.forEach(id => this.socket.sendInput('term-keys', { id, text: line }));
            if (inp && !preset) inp.value = '';
        }
        sounds.play('tabSwitch');
        this._toast(`Sent to ${ids.length} session${ids.length > 1 ? 's' : ''}.`);
        this._closeBroadcast();
    }

    // ── Text-to-speech ───────────────────────────────────────────────────
    // A `tts` frame arrived (Claude finished a turn; its Stop hook sent text).
    // Speak the active tab's reply via the Web Speech API.
    _onTTS(d) {
        if (!this._ttsEnabled) return;
        const text = d && d.text;
        if (!text) return;
        const tab = d.tab;
        if (tab != null && this._activeTabId != null && tab !== this._activeTabId) return;
        this._speak(text);
    }

    // ── Chat / IM mode ───────────────────────────────────────────────────
    // The agent's clean final message for a turn (same feed that drives TTS)
    // becomes an incoming bubble on that tab's thread. Raw terminal output never
    // enters here, so the conversation stays readable.
    _onAgentMessage(d) {
        const text = d && d.text;
        if (!text) return;
        const tab = (d.tab != null) ? d.tab : this._activeTabId;
        this._pushChat(tab, { from: 'agent', full: String(text), t: Date.now() });
        const onChat = this._currentView === 'chat-view';
        const onThisTab = tab === this._activeTabId;
        if (onChat && onThisTab) {
            this._renderChat();
        } else {
            this._chatUnread++;
            this._updateChatBadge();
        }
    }

    _pushChat(tabId, msg) {
        if (tabId == null) return;
        if (!this._chatThreads.has(tabId)) this._chatThreads.set(tabId, []);
        const thread = this._chatThreads.get(tabId);
        thread.push(msg);
        if (thread.length > 200) thread.shift();   // cap memory per tab
    }

    _sendChat() {
        const raw = (this.chatInput && this.chatInput.value || '').trim();
        if (!raw) return;
        const id = this._activeTabId;
        if (id == null) return;
        // Chat-mode verbosity commands (/brief, /verbose, /details) rewrite to a
        // plain instruction so the agent adjusts how it replies — the terminal
        // stays clean and the bubble still shows what you typed.
        const text = this._chatCommand(raw) || raw;
        // Type it into the PTY (newline submits, like pressing Enter in terminal).
        this.socket.sendInput('term-keys', { id, text: text + '\r' });
        this._pushChat(id, { from: 'you', full: raw, t: Date.now() });
        this.chatInput.value = '';
        this.chatInput.style.height = 'auto';
        this._renderChat();
        sounds.play('tabSwitch');
    }

    // Chat-mode quick commands: map a typed slash-command to a plain-English
    // instruction the agent understands. Returns null for normal messages.
    _chatCommand(raw) {
        const map = {
            '/brief':   '[chat-mode] Keep replies brief: short, direct, proportional to my input — no tables or headers.',
            '/verbose': '[chat-mode] Verbose replies are OK until I send /brief.',
            '/details': '[chat-mode] Expand your previous reply with full detail.',
        };
        return map[raw.toLowerCase()] || null;
    }

    // Trim an agent message to ≤50 words for the bubble; the full text stays
    // available behind a tap (expandable). Keeps the IM glanceable.
    _summarize(text, limit = 50) {
        const clean = String(text).replace(/\s+/g, ' ').trim();
        const words = clean.split(' ');
        if (words.length <= limit) return { short: clean, truncated: false };
        return { short: words.slice(0, limit).join(' ') + '…', truncated: true };
    }

    _renderChat() {
        if (!this.chatLog) return;
        const thread = this._chatThreads.get(this._activeTabId) || [];
        if (!thread.length) {
            this.chatLog.innerHTML =
                `<div class="chat-empty">No messages yet on this tab.<br>` +
                `Type below to prompt the agent — its replies appear here, summarized. ` +
                `Switch tabs to follow another conversation.</div>`;
            return;
        }
        const frag = document.createDocumentFragment();
        for (const m of thread) {
            const bubble = document.createElement('div');
            bubble.className = 'chat-msg ' + (m.from === 'you' ? 'you' : 'agent');
            if (m.from === 'agent') {
                const { short, truncated } = this._summarize(m.full);
                if (truncated) {
                    bubble.classList.add('expandable');
                    bubble.dataset.expanded = '0';
                    bubble.textContent = short;
                    const more = document.createElement('span');
                    more.className = 'chat-more';
                    more.textContent = ' more';
                    bubble.appendChild(more);
                    bubble.addEventListener('click', () => {
                        const exp = bubble.dataset.expanded === '1';
                        bubble.dataset.expanded = exp ? '0' : '1';
                        bubble.textContent = exp ? short : m.full.replace(/\s+/g, ' ').trim();
                        if (exp) { const mm = document.createElement('span'); mm.className = 'chat-more'; mm.textContent = ' more'; bubble.appendChild(mm); }
                        this._scrollChatBottom();
                    });
                } else {
                    bubble.textContent = short;
                }
            } else {
                bubble.textContent = m.full;
            }
            frag.appendChild(bubble);
        }
        this.chatLog.innerHTML = '';
        this.chatLog.appendChild(frag);
        this._scrollChatBottom();
    }

    _scrollChatBottom() {
        if (this.chatLog) this.chatLog.scrollTop = this.chatLog.scrollHeight;
    }

    // Live status strip: reflects the active tab's detected agent state so you
    // can see it's thinking / waiting on you even between final messages.
    _renderChatStatus() {
        if (!this.chatStatus) return;
        const status = (this._mobileStatus && this._mobileStatus.get(this._activeTabId)) || 'idle';
        const css = cssStatus(status);   // working→running, attention→input, done→completed
        const map = {
            running:   { state: 'working',   text: 'Agent working' },
            input:     { state: 'input',     text: 'Awaiting your input' },
            completed: { state: 'completed', text: 'Done' },
        };
        const m = map[css];
        const textEl = this.chatStatus.querySelector('.chat-status-text');
        const pct = this._ctxPct.get(this._activeTabId);
        const ctxSuffix = (pct != null) ? ` · ctx ${pct}%` : '';
        this.chatStatus.hidden = false;
        if (!m) {
            // idle: keep a quiet "ready" line rather than hiding, so the strip
            // doesn't flicker in and out as state changes.
            this.chatStatus.removeAttribute('data-state');
            if (textEl) textEl.textContent = 'Idle · ready' + ctxSuffix;
            return;
        }
        this.chatStatus.setAttribute('data-state', m.state);
        if (textEl) textEl.textContent = m.text + ctxSuffix;
    }

    _updateChatBadge() {
        if (!this.chatBadge) return;
        if (this._chatUnread > 0) {
            this.chatBadge.textContent = this._chatUnread > 99 ? '99+' : String(this._chatUnread);
            this.chatBadge.hidden = false;
        } else {
            this.chatBadge.hidden = true;
        }
    }

    _speak(text) {
        try {
            const synth = window.speechSynthesis;
            if (!synth) return;
            if (!this._ttsVoice) this._ttsVoice = this._pickVoice();
            synth.cancel();
            const u = new SpeechSynthesisUtterance(String(text).slice(0, 4000));
            u.rate = 1.05; u.pitch = 1.0;
            if (this._ttsVoice) u.voice = this._ttsVoice;
            synth.speak(u);
        } catch (_) {}
    }

    _pickVoice() {
        try {
            const voices = window.speechSynthesis.getVoices() || [];
            if (!voices.length) return null;
            return voices.find(v => /Samantha|Karen|Daniel|Google US English/i.test(v.name) && /^en/i.test(v.lang))
                || voices.find(v => /en[-_]US/i.test(v.lang))
                || voices.find(v => /^en/i.test(v.lang)) || null;
        } catch (_) { return null; }
    }

    // ── Camera / photo → prompt ──────────────────────────────────────────
    async _sendPhoto(file) {
        try {
            const path = await this._uploadImage(file);
            if (path && this._activeTabId != null) {
                // Bracketed paste (ESC[200~ … ESC[201~) so Claude Code treats the
                // path like a drag-drop and attaches the image, not as typed text.
                this.socket.sendInput('term-keys', { id: this._activeTabId, text: '\x1b[200~' + path + '\x1b[201~' });
                if ('vibrate' in navigator) try { navigator.vibrate(12); } catch (_) {}
            }
        } catch (_) {
            this._showNotice({ level: 'warn', text: 'Photo upload failed — is the desktop reachable?' });
        }
    }

    async _uploadImage(blob) {
        const base = (this.socket && this.socket.baseUrl)
            ? this.socket.baseUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '') : location.origin;
        const tok = this.socket && this.socket.token;
        const url = base + '/api/paste-image' + (tok ? '?t=' + encodeURIComponent(tok) : '');
        const res = await fetch(url, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob,
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data || !data.ok || !data.path) throw new Error('bad response');
        return data.path;
    }

    _quotePath(p) {
        if (/^[\w@%+=:,./-]+$/.test(p)) return p;
        return "'" + String(p).replace(/'/g, "'\\''") + "'";
    }

    // ── Focus / fullscreen ───────────────────────────────────────────────
    _toggleFocus(force) {
        const app = document.getElementById('app');
        const on = force != null ? force : !app.classList.contains('focus-mode');
        app.classList.toggle('focus-mode', on);
        if (this.btnFullscreen) this.btnFullscreen.setAttribute('aria-pressed', on ? 'true' : 'false');
        try {
            if (on && document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen().catch(() => {});
            } else if (!on && document.fullscreenElement && document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            }
        } catch (_) {}
        // iPhone Safari can't fullscreen a page — nudge the PWA install once.
        if (on && !document.documentElement.requestFullscreen && !this._fsHinted) {
            this._fsHinted = true;
            const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
            if (!standalone) this._showNotice({ level: 'info', text: 'Tip: Share → “Add to Home Screen” for true fullscreen on iPhone.' });
        }
        setTimeout(() => this._scrollTermBottom(), 120);
    }

    // ── Screen wake lock — keep the display on while streaming ────────────
    async _acquireWakeLock() {
        try {
            if (!('wakeLock' in navigator) || this._wakeLock) return;
            this._wakeLock = await navigator.wakeLock.request('screen');
            this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
        } catch (_) { this._wakeLock = null; }
    }

    _releaseWakeLock() {
        try { if (this._wakeLock) { this._wakeLock.release(); this._wakeLock = null; } } catch (_) {}
    }

    // ── Web preview ──────────────────────────────────────────────────────
    // Open a local dev-server port (proxied via /preview/<port>/ so it's
    // viewable through the tunnel) or an arbitrary URL in an embedded frame.
    _wireWebPreview() {
        this._webPortSel = document.getElementById('web-port');
        this._webUrlInp = document.getElementById('web-url');
        this._webFrame = document.getElementById('web-frame');
        this._webEmpty = document.getElementById('web-empty');
        this._agentFrame = document.getElementById('agent-frame');
        this._agentToggle = document.getElementById('agent-toggle');
        const go = document.getElementById('web-go');
        const reload = document.getElementById('web-reload');
        if (!this._webFrame) return;

        const openUrl = (raw) => {
            const u = (raw || '').trim();
            if (!u) return;
            if (this._agentMode) { this._agentNavigate(u); return; }
            this._openWeb(this._resolveWebTarget(u));
        };

        this._webPortSel.addEventListener('change', () => {
            const p = this._webPortSel.value;
            if (!p) return;
            this._webUrlInp.value = '';
            if (this._agentMode) this._agentNavigate('localhost:' + p);
            else this._openWeb(this._proxyUrl(`/preview/${p}/`));
        });
        go.addEventListener('click', () => openUrl(this._webUrlInp.value));
        this._webUrlInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') openUrl(this._webUrlInp.value); });
        if (reload) reload.addEventListener('click', () => { if (!this._agentMode && this._webFrame.src) this._webFrame.src = this._webFrame.src; });

        if (this._agentToggle) this._agentToggle.addEventListener('click', () => this._setAgentMode(!this._agentMode));

        // Tap the live agent view → forward as a click at the page's coords.
        if (this._agentFrame) {
            this._agentFrame.addEventListener('click', (e) => {
                const r = this._agentFrame.getBoundingClientRect();
                if (!r.width || !r.height) return;
                const x = Math.round((e.clientX - r.left) / r.width * 1024);
                const y = Math.round((e.clientY - r.top) / r.height * 768);
                this.socket.sendInput('browser-click', { x, y });
            });
        }
    }

    // ── Agent browser (live, isolated headless Chrome) ───────────────────
    _onBrowserFrame(d) {
        if (this._agentFrame && d && d.data) this._agentFrame.src = 'data:image/jpeg;base64,' + d.data;
    }

    _setAgentMode(on) {
        this._agentMode = on;
        if (this._agentToggle) this._agentToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (this._agentFrame) this._agentFrame.hidden = !on;
        if (this._webFrame) this._webFrame.style.display = on ? 'none' : '';
        if (this._webEmpty) this._webEmpty.style.display = on ? 'none' : '';
        if (this._webUrlInp) this._webUrlInp.placeholder = on ? 'agent browser — type a URL' : 'localhost:3000 or https://…';
        this.socket.sendInput(on ? 'browser-subscribe' : 'browser-unsubscribe');
    }

    async _agentCmd(action, args) {
        try {
            const base = (this.socket && this.socket.baseUrl)
                ? this.socket.baseUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '') : '';
            const tok = this.socket && this.socket.token;
            const res = await fetch(base + '/api/agent-browser' + (tok ? '?t=' + encodeURIComponent(tok) : ''), {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }),
            });
            return res.ok ? res.json() : null;
        } catch (_) { return null; }
    }

    _agentNavigate(url) { this._agentCmd('navigate', { url }); }

    _openWeb(src) {
        if (!this._webFrame) return;
        this._webFrame.src = src;
        this._webFrame.style.display = 'block';
        if (this._webEmpty) this._webEmpty.style.display = 'none';
    }

    // New-tab chooser: every "+" asks what to open — a Terminal (shell tab), a
    // Localhost port, or a Webpage URL. The two web options land in the preview
    // pane (not a persistent tab).
    _showNewTabChooser() {
        if (this._newTabSheet) return;
        const sheet = document.createElement('div');
        sheet.className = 'newtab-sheet';
        sheet.innerHTML =
            '<div class="newtab-card">' +
              '<div class="newtab-title">OPEN NEW…</div>' +
              '<button class="newtab-opt" data-kind="terminal"><span class="nt-ico">❯_</span><span class="nt-txt"><b>Terminal</b><i>A shell in a new tab</i></span></button>' +
              '<button class="newtab-opt" data-kind="localhost"><span class="nt-ico">◉</span><span class="nt-txt"><b>Localhost</b><i>Preview a local port (e.g. 5555)</i></span></button>' +
              '<button class="newtab-opt" data-kind="webpage"><span class="nt-ico">⊕</span><span class="nt-txt"><b>Webpage</b><i>Open any URL</i></span></button>' +
              '<button class="newtab-cancel" type="button">Cancel</button>' +
            '</div>';
        document.body.appendChild(sheet);
        this._newTabSheet = sheet;
        const close = () => { if (this._newTabSheet) { this._newTabSheet.remove(); this._newTabSheet = null; } };
        sheet.addEventListener('click', (e) => {
            if (e.target === sheet || e.target.classList.contains('newtab-cancel')) { close(); return; }
            const opt = e.target.closest('.newtab-opt');
            if (!opt) return;
            const kind = opt.dataset.kind;
            close();
            if (kind === 'terminal') {
                // This device is creating the tab, so it SHOULD focus the new
                // server-assigned tab. Capture the current id set; _applySnapshot
                // adopts the activeId of the first snapshot naming an id NOT in
                // this set (the genuinely new tab), so a racing poll/device-count
                // snapshot carrying an old id can't steal the focus.
                this._adoptNewTabIds = new Set((this._snapshot && this._snapshot.tabs || []).map(t => t.id));
                this.socket.sendInput('new-tab');
            }
            else if (kind === 'localhost') this._promptLocalhost();
            else if (kind === 'webpage') this._promptWebpage();
        });
    }

    _promptLocalhost() {
        const raw = prompt('Local port (e.g. 5555):');
        if (raw == null) return;
        const port = String(raw).trim().replace(/[^\d]/g, '');
        if (!/^\d{1,5}$/.test(port)) return;
        this._showView('web-view');
        if (this._webUrlInp) this._webUrlInp.value = port;
        this._openWeb(this._proxyUrl(`/preview/${port}/`));
    }

    _promptWebpage() {
        const raw = prompt('Web address (URL or localhost:port):');
        if (raw == null) return;
        const u = String(raw).trim();
        if (!u) return;
        this._showView('web-view');
        if (this._webUrlInp) this._webUrlInp.value = u;
        this._openWeb(this._resolveWebTarget(u));
    }

    // Build an absolute /preview/ URL against the BACKEND origin (not the page
    // origin — the client may be served from Vercel or a cached SW, where a
    // relative /preview/ would 404 to the SoA landing page). Carry the session
    // token so the proxy is reachable from a remote device.
    _proxyUrl(path) {
        const base = (this.socket && this.socket.baseUrl)
            ? this.socket.baseUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '')
            : location.origin;
        const tok = this.socket && this.socket.token;
        let url = base + path;
        if (tok) url += (url.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(tok);
        return url;
    }

    // Turn a user string into a frame URL. Bare port (5555) or localhost:5555 /
    // 127.0.0.1:5555 → proxied through the backend; anything else → external URL.
    _resolveWebTarget(raw) {
        let u = (raw || '').trim();
        const lm = u.replace(/^https?:\/\//, '').match(/^(?:localhost|127\.0\.0\.1):(\d{1,5})(\/.*)?$/i);
        if (lm) return this._proxyUrl(`/preview/${lm[1]}${lm[2] || '/'}`);
        if (/^\d{1,5}$/.test(u)) return this._proxyUrl(`/preview/${u}/`);   // bare port → localhost
        return /^https?:\/\//.test(u) ? u : 'https://' + u;
    }

    async _refreshWebPorts() {
        if (!this._webPortSel) return;
        try {
            const base = (this.socket && this.socket.baseUrl)
                ? this.socket.baseUrl.replace(/^ws(s?):\/\//, 'http$1://') : '';
            const res = await fetch(base + '/api/ports', { credentials: 'include', cache: 'no-store' });
            if (!res.ok) return;
            const { data } = await res.json();
            const cur = this._webPortSel.value;
            const ports = (data && data.ports) || [];
            this._webPortSel.innerHTML = '<option value="">port…</option>' +
                ports.map(p => `<option value="${p.port}">:${p.port} ${escapeHtml(p.process || '')}</option>`).join('');
            if (cur) this._webPortSel.value = cur;
        } catch (_) { /* ports are best-effort */ }
    }

    _setStatus(state, text) {
        this.statusDot.setAttribute('data-state', state);
        this.statusText.textContent = text;
        if (state === 'connected' && !this._diagTimer) {
            this._diagTimer = setInterval(() => this._updateDiagStatus(), 2000);
        }
    }

    _updateDiagStatus() {
        if (this.socket.state !== 'connected') {
            if (this._diagTimer) { clearInterval(this._diagTimer); this._diagTimer = null; }
            return;
        }
        const s = this._msgCounts.snapshot;
        const t = this._msgCounts['term-data'];
        this.statusText.textContent = `paired · S:${s} T:${t}`;
    }

    diag() {
        const age = this._lastMsgAt ? ((Date.now() - this._lastMsgAt) / 1000).toFixed(1) + 's ago' : 'never';
        return {
            socketState: this.socket.state,
            messages: { ...this._msgCounts },
            lastMessage: age,
            activeTab: this._activeTab,
            activeTabId: this._activeTabId,
            connectedDevices: this._connectedDevices,
            tabStates: Array.from(this._tabStates.entries()).map(([k, v]) => ({
                tab: k,
                lines: v.term ? v.term.lineCount() : 0,
            })),
            termChildNodes: this.termEl.childNodes.length,
        };
    }

    // ── On-screen diagnostics panel ──────────────────────────────────────
    // A phone has no console. This builds an always-available log/status panel
    // toggled by a floating "LOG" chip (bottom-left). It surfaces the build
    // marker (to detect stale cache), connection state, message counts, the
    // resolved activeTabId, per-tab buffered bytes (orphan detection), and a
    // live event log — everything needed to diagnose "screen stays blank".
    _buildDiagPanel() {
        const btn = document.createElement('button');
        btn.id = 'diag-toggle';
        btn.textContent = 'LOG';
        btn.setAttribute('aria-label', 'Diagnostics');
        // Sit in the top bar next to the brand name so it never overlaps the
        // bottom control bar. Falls back to floating if the brand isn't found.
        const brandHost = document.querySelector('#topbar .brand');

        const panel = document.createElement('div');
        panel.id = 'diag-panel';
        panel.hidden = true;
        panel.innerHTML =
            '<div class="diag-head">' +
              '<span class="diag-title">DIAGNOSTICS</span>' +
              '<span class="diag-build"></span>' +
              '<button class="diag-copy" type="button">COPY</button>' +
              '<button class="diag-close" type="button">×</button>' +
            '</div>' +
            '<pre class="diag-summary"></pre>' +
            '<div class="diag-log-h">EVENT LOG (newest first)</div>' +
            '<pre class="diag-log"></pre>';

        if (brandHost) brandHost.appendChild(btn); else document.body.appendChild(btn);
        document.body.appendChild(panel);

        this._diagPanel = panel;
        this._diagSummaryEl = panel.querySelector('.diag-summary');
        this._diagLogEl = panel.querySelector('.diag-log');
        panel.querySelector('.diag-build').textContent = MOBILE_BUILD;

        const toggle = () => {
            panel.hidden = !panel.hidden;
            if (!panel.hidden) {
                this._updateDiagPanel();
                this._diagPanelTimer = setInterval(() => this._updateDiagPanel(), 1000);
            } else if (this._diagPanelTimer) {
                clearInterval(this._diagPanelTimer); this._diagPanelTimer = null;
            }
        };
        btn.addEventListener('click', toggle);
        panel.querySelector('.diag-close').addEventListener('click', toggle);
        panel.querySelector('.diag-copy').addEventListener('click', () => {
            const text = this._diagSummaryEl.textContent + '\n\n' + this._diagLogEl.textContent;
            try { navigator.clipboard.writeText(text); } catch (_) {}
            const c = panel.querySelector('.diag-copy');
            c.textContent = 'COPIED'; setTimeout(() => { c.textContent = 'COPY'; }, 1200);
        });
        pushLog('diag panel ready · build ' + MOBILE_BUILD);
    }

    _updateDiagPanel() {
        if (!this._diagPanel || this._diagPanel.hidden) return;
        const d = this.diag();
        let endpoint = '(none)';
        try { endpoint = new URL(this.socket.baseUrl.replace(/^ws/, 'http')).host; } catch (_) {}
        const ctrl = (navigator.serviceWorker && navigator.serviceWorker.controller) ? 'yes' : 'no';
        const tabs = d.tabStates.map(t =>
            `#${t.tab}${t.tab === d.activeTabId ? '*' : ''} ln=${t.lines}`).join('  ') || '(none)';
        const allLines = (this.termEl.textContent || '').split('\n');
        const blank = allLines.filter(l => l.trim() === '').length;
        this._diagSummaryEl.textContent =
            `BUILD     ${MOBILE_BUILD}\n` +
            `PATH      ${location.pathname}   SW-ctrl: ${ctrl}\n` +
            `SOCKET    ${d.socketState}\n` +
            `ENDPOINT  ${endpoint}\n` +
            `MSGS      hello=${d.messages.hello||0} snap=${d.messages.snapshot||0} term=${d.messages['term-data']||0} notice=${d.messages.notice||0}\n` +
            `ACTIVE    tabIndex=${d.activeTab}  activeTabId=${d.activeTabId}\n` +
            `TABS      ${tabs}\n` +
            `LAST MSG  ${d.lastMessage}\n` +
            `TERMLINES ${allLines.length} (blank ${blank})   nodes=${d.termChildNodes}\n` +
            `DEVICES   ${d.connectedDevices}`;
        const log = getLogBuffer();
        const lines = [];
        for (let i = log.length - 1; i >= 0 && lines.length < 80; i--) {
            const e = log[i];
            const ts = new Date(e.t).toLocaleTimeString();
            lines.push(`${ts}  ${e.line}`);
        }
        this._diagLogEl.textContent = lines.join('\n');
    }

    // Debounced overlay: only raise RECONNECTING if we're STILL down after a
    // grace period. If the link comes back first (the common case for a tunnel
    // blip), _hideReconnect cancels the pending show and nothing ever flashes.
    _scheduleReconnect(text) {
        if (text) this._pendingReconnectText = text;
        // Already visible → just keep the subtext fresh, no re-arm needed.
        if (this.reconnectOverlay && !this.reconnectOverlay.hidden) {
            if (text) this.reconnectSub.textContent = text;
            return;
        }
        if (this._reconnectTimer) return;   // one pending show at a time
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            // Reconciled? Only show if we haven't recovered in the meantime.
            if (!this.socket || this.socket.state !== SocketState.CONNECTED) {
                this._showReconnect(this._pendingReconnectText || 'reconnecting…');
            }
        }, RECONNECT_OVERLAY_DELAY_MS);
    }

    _showReconnect(text) {
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        this.reconnectOverlay.hidden = false;
        if (text) this.reconnectSub.textContent = text;
        this.reconnectRetry.hidden = false;
    }
    _hideReconnect() {
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        this.reconnectOverlay.hidden = true;
        this.reconnectDiag.hidden = true;
        this.reconnectRetry.hidden = true;
        this.reconnectOpenBrowser.hidden = true;
    }

    _showDiagnosis(diag) {
        if (diag === Diagnosis.CONNECTED || diag === Diagnosis.NONE) {
            this.reconnectDiag.hidden = true;
            this.reconnectOpenBrowser.hidden = true;
            return;
        }
        // A real diagnosis (captive portal, server unreachable, offline) is a
        // persistent problem, not a blip — surface the overlay now rather than
        // waiting out the debounce.
        this._showReconnect();
        this.reconnectDiag.hidden = false;
        this.reconnectRetry.hidden = false;
        this.reconnectOpenBrowser.hidden = true;

        switch (diag) {
            case Diagnosis.CAPTIVE_PORTAL:
                this.reconnectDiag.textContent =
                    'WiFi login required — complete the WiFi sign-in page, then tap RETRY.';
                this.reconnectOpenBrowser.hidden = false;
                break;
            case Diagnosis.SERVER_UNREACHABLE:
                this.reconnectDiag.textContent =
                    'Desktop not reachable on this network. Public WiFi often blocks local connections — re-scan the PUB (tunnel) QR code from the desktop.';
                break;
            case Diagnosis.NETWORK_OFFLINE:
                this.reconnectDiag.textContent =
                    'No internet connection. Connect to a network and tap RETRY.';
                break;
        }
    }

    _applyHello(data) {
        if (!data) return;
        // HELLO carries the full initial state: tabs, activeId, replay (scrollback)
        this._applySnapshot(data);
        // Replay scrollback for each tab so the terminal shows existing output
        const replay = data.replay || [];
        for (const r of replay) {
            if (r.id != null && r.data) {
                this._applyTerminalChunk({ id: r.id, data: r.data });
            }
        }
        // The per-tab detector is throttled (250ms), so a fast replay burst can
        // leave a tab's status stale at 'idle' after a reconnect/restart. Force
        // a fresh classification from each tab's buffered tail now.
        this._redetectAllTabs();
    }

    // Re-run agent-status detection for every known tab, ignoring the throttle.
    // Used after a reconnect replay so the status indicators reflect the current
    // on-screen state instead of waiting for the next live byte.
    _redetectAllTabs() {
        if (!this._agentRecent) return;
        for (const [id, sb] of this._agentRecent) {
            const cur = (this._mobileStatus && this._mobileStatus.get(id)) || 'idle';
            const next = classifyAgent(sb.recent, cur);
            if (next && next !== cur) {
                if (!this._mobileStatus) this._mobileStatus = new Map();
                this._mobileStatus.set(id, next);
                this._setTabStatusDom(id, next);
            }
        }
        if (this._currentView === 'chat-view') this._renderChatStatus();
    }

    // Switch the viewed tab OPTIMISTICALLY-LOCAL, then notify the server. A
    // mobile switch is a server round-trip, but we must NOT wait for the echo:
    // the server suppresses the echo snapshot when the session-global active tab
    // is already this id (e.g. the desktop is sitting on it), which would leave
    // the tap dead. Rendering locally also means no intent flag that could dangle
    // and later hijack an unrelated snapshot. We re-apply the last snapshot with
    // _activeTabId pre-set: its keep-path resolves activeId to our new id and
    // repaints tabs + terminal. Output for every tab is already buffered, so the
    // switched-to tab shows correct content immediately.
    _switchTabLocal(id) {
        if (id == null) return;
        if (this._activeTabId !== id && this._snapshot) {
            this._activeTabId = id;
            this._applySnapshot(this._snapshot);
        }
        this.socket.sendInput('switch-tab', { id });
    }

    _applySnapshot(snap) {
        if (!snap) return;
        this._snapshot = snap;

        // Server sends: { tabs: [{id, title, cols, rows, exited}], activeId: N }
        // Normalize to the shape our renderer expects.
        const rawTabs = snap.tabs || [];
        // Per-device active-tab resolution.
        //
        // "Which tab this phone is viewing" is a CLIENT-LOCAL concept. The server
        // keeps one session-global active tab and re-stamps it into snap.activeId
        // on its 3s cwd poll, on device connect/disconnect, and on ANY device's
        // switch. If we adopted snap.activeId every time, another device switching
        // tabs would involuntarily yank this phone's view. So we adopt the server
        // activeId in only two cases:
        //   1. INITIAL load / manual resync — !this._hasReceivedSnapshot. Covers
        //      a fresh page and _resync() (which clears the flag); _applyHello()
        //      funnels through here before _hasReceivedSnapshot is set, so HELLO
        //      is covered. NOTE: a transparent auto-reconnect does NOT clear the
        //      flag, so it intentionally keeps this phone's current tab.
        //   2. THIS device just created a tab: _adoptNewTabIds holds the id set
        //      captured at new-tab time, and we adopt the activeId of the first
        //      snapshot naming an id NOT in that set (the genuinely new tab).
        //      Matching the NEW id rather than "any valid activeId" means a racing
        //      cwd-poll/device-count/foreign-switch snapshot carrying the
        //      old-but-still-valid activeId cannot burn the intent.
        // A user TAP is not handled here at all — _switchTabLocal sets the active
        // tab optimistically, so it works even when the server suppresses the echo
        // (it does when the session-global tab is already that id). For every
        // other snapshot we KEEP this._activeTabId, applying the close-active-tab
        // fallback only if the tab we're viewing vanished from the list.
        //
        // Defensive note (kept): snapshot broadcasts can carry activeId:0 or omit
        // it entirely. We only accept activeId when it names a real tab; otherwise
        // we keep the current tab so TERM_DATA frames keep matching _activeTabId
        // (mismatched frames buffer forever — blank screen).
        const idList = rawTabs.map(t => t.id);
        let activeId;
        if (!this._hasReceivedSnapshot) {
            this._adoptNewTabIds = null;
            activeId = idList.includes(snap.activeId) ? snap.activeId
                : (idList.includes(this._activeTabId) ? this._activeTabId : (idList[0] || 0));
        } else if (this._adoptNewTabIds && idList.includes(snap.activeId) && !this._adoptNewTabIds.has(snap.activeId)) {
            this._adoptNewTabIds = null;
            activeId = snap.activeId;
        } else {
            // Keep the device-local active tab; fall back to the first tab only if
            // the one we were viewing is gone (e.g. it was just closed).
            activeId = idList.includes(this._activeTabId) ? this._activeTabId : (idList[0] || 0);
        }
        const tabs = rawTabs.map((t, i) => ({
            index: i,
            id: t.id,
            name: t.title || `TAB ${i + 1}`,
            active: t.id === activeId,
            status: t.exited ? 'exited' : null,
            cols: t.cols,
        }));

        const activeTab = tabs.find(t => t.active);
        const newActiveTab = activeTab ? activeTab.index : 0;
        if (this._hasReceivedSnapshot && newActiveTab !== this._activeTab) {
            sounds.play('tabSwitch');
        }
        this._hasReceivedSnapshot = true;
        this._activeTab = newActiveTab;
        this._activeTabId = activeId;
        pushLog(`snapshot: raw=${JSON.stringify(snap.activeId)} → resolved activeId=${activeId} tabs=[${idList.join(',')}]`);
        console.log('%c[app] snapshot activeId=' + activeId + ' (type: ' + typeof activeId + ')', 'color:#ff9');

        for (const t of tabs) {
            if (!this._tabStates.has(t.id)) {
                this._tabStates.set(t.id, { term: new TermBuffer({ rows: t.rows || 24 }) });
            } else if (t.rows) {
                this._tabStates.get(t.id).term.setRows(t.rows);
            }
        }

        this._connectedDevices = snap.connectedDevices || 0;
        this._renderTabs(tabs);
        this._updateTabChip();
        if (this.tabsheetOverlay && this.tabsheetOverlay.classList.contains('open')) this._renderTabSheet();
        this._renderActiveTerminal();
        this._updateDeviceCount();
        // Keep the dashboard in sync with tab add/remove/switch when it's open.
        if (this._tilesTimer) this._renderTiles();
        // Follow the active tab's conversation when the chat view is open.
        if (this._currentView === 'chat-view') { this._renderChat(); this._renderChatStatus(); }
    }

    _renderTabs(tabs) {
        // Check for status transitions before re-rendering
        for (const t of tabs) {
            const prev = this._tabStatuses.get(t.id);
            if (prev !== undefined && prev !== t.status && t.status === 'input') {
                this._showAgentToast(t.name || `TAB ${t.index + 1}`);
            }
            this._tabStatuses.set(t.id, t.status);
        }
        const frag = document.createDocumentFragment();
        for (const t of tabs) {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'tab' + (t.active ? ' active' : '');
            el.dataset.tabIndex = String(t.index);
            el.dataset.tabId = String(t.id);
            // Prefer our locally-detected agent status (server sends none);
            // fall back to any status the snapshot happened to include.
            const mob = this._mobileStatus && this._mobileStatus.get(t.id);
            const status = mob ? cssStatus(mob) : (t.status || null);
            if (status) el.setAttribute('data-status', status);
            el.innerHTML = `<span class="tab-name">${escapeHtml(t.name)}</span>`;
            this._attachTabPointerHandlers(el, t);
            frag.appendChild(el);
        }

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'tab tab-add';
        addBtn.textContent = '+';
        addBtn.addEventListener('click', () => this._showNewTabChooser());
        frag.appendChild(addBtn);

        this.tabsEl.innerHTML = '';
        this.tabsEl.appendChild(frag);
    }

    /* ── Tab jump sheet ── */

    _wireTabSheet() {
        if (this.btnTabchip) this.btnTabchip.addEventListener('click', () => this._openTabSheet());
        if (this.tabsheetOverlay) {
            this.tabsheetOverlay.addEventListener('click', (e) => {
                if (e.target === this.tabsheetOverlay) this._closeTabSheet();
            });
            const closeBtn = document.getElementById('tabsheet-close');
            if (closeBtn) closeBtn.addEventListener('click', () => this._closeTabSheet());
        }
        if (this.tabsheetSearch) {
            this.tabsheetSearch.addEventListener('input', () => this._renderTabSheet());
        }
    }

    // Keep the top-bar chip showing the tab this phone is viewing (the active
    // pill often scrolls off the strip) plus the total count.
    _updateTabChip() {
        if (!this.btnTabchip) return;
        const tabs = (this._snapshot && this._snapshot.tabs) || [];
        if (this.tabchipName)  this.tabchipName.textContent = this._tabName(this._activeTabId) || '—';
        if (this.tabchipCount) this.tabchipCount.textContent = tabs.length ? String(tabs.length) : '';
    }

    _openTabSheet() {
        if (!this.tabsheetOverlay) return;
        if (this.tabsheetSearch) this.tabsheetSearch.value = '';
        this._renderTabSheet();
        this.tabsheetOverlay.classList.add('open');
    }

    _closeTabSheet() {
        if (this.tabsheetOverlay) this.tabsheetOverlay.classList.remove('open');
        try { if (this.tabsheetSearch) this.tabsheetSearch.blur(); } catch (_) {}
    }

    _renderTabSheet() {
        if (!this.tabsheetList) return;
        const tabs = (this._snapshot && this._snapshot.tabs) || [];
        const q = (this.tabsheetSearch && this.tabsheetSearch.value || '').trim().toLowerCase();
        const frag = document.createDocumentFragment();
        let shown = 0;
        tabs.forEach((t, i) => {
            const name = t.title || `TAB ${i + 1}`;
            if (q && !name.toLowerCase().includes(q)) return;
            shown++;
            const mob = this._mobileStatus && this._mobileStatus.get(t.id);
            const status = mob ? cssStatus(mob) : (t.exited ? 'exited' : null);
            const pct = this._ctxPct && this._ctxPct.get(t.id);
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'tabsheet-row' + (t.id === this._activeTabId ? ' active' : '');
            if (status) row.setAttribute('data-status', status);
            row.innerHTML =
                `<span class="tabsheet-dot"></span>` +
                `<span class="tabsheet-name">${escapeHtml(name)}</span>` +
                (pct != null ? `<span class="tabsheet-ctx">${pct}%</span>` : '') +
                (t.id === this._activeTabId ? `<span class="tabsheet-here">VIEWING</span>` : '');
            row.addEventListener('click', () => {
                this._switchTabLocal(t.id);
                this._showView('terminal-view');
                this._closeTabSheet();
            });
            frag.appendChild(row);
        });
        if (!shown) {
            const empty = document.createElement('div');
            empty.className = 'tabsheet-empty';
            empty.textContent = q ? 'No tabs match.' : 'No open tabs.';
            frag.appendChild(empty);
        }
        this.tabsheetList.innerHTML = '';
        this.tabsheetList.appendChild(frag);
    }

    _renderActiveTerminal() {
        // Repaint the active tab's grid buffer (e.g. after a tab switch or a
        // snapshot). Content lives in each tab's TermBuffer; here we just render
        // whichever is active and fit the font.
        const activeTab = this._snapshot && this._snapshot.tabs
            ? this._snapshot.tabs.find(t => t.id === this._activeTabId)
            : null;
        if (activeTab && activeTab.cols) this._fitTerminalFont(activeTab.cols);
        const ts = this._getTabState(this._activeTabId);
        if (activeTab && activeTab.rows) ts.term.setRows(activeTab.rows);
        this.termEl.innerHTML = ts.term.toHtml();
        this._scrollTermBottom();
    }

    _updateDeviceCount() {
        const count = this._connectedDevices || 0;
        if (count > 1) {
            this.statusText.textContent = `paired · ${count} devices`;
        }
    }

    // Unified pointer state machine for each tab:
    //   tap                      → switch-tab
    //   hold ~280ms + drag       → reorder (see _beginTabDrag)
    //   hold ~500ms stationary   → open menu
    _attachTabPointerHandlers(el, tab) {
        const DRAG_ARM_MS = 280;
        const MENU_MS = 500;
        const MOVE_THRESHOLD = 8;
        const state = { startX: 0, startY: 0, armed: false, dragging: false, cancelled: false, didMenu: false };
        let armTimer = null, menuTimer = null;
        const clearTimers = () => {
            if (armTimer) { clearTimeout(armTimer); armTimer = null; }
            if (menuTimer) { clearTimeout(menuTimer); menuTimer = null; }
        };

        el.addEventListener('pointerdown', (e) => {
            if (e.button != null && e.button !== 0) return;
            state.startX = e.clientX;
            state.startY = e.clientY;
            state.armed = false;
            state.dragging = false;
            state.cancelled = false;
            state.didMenu = false;
            clearTimers();
            armTimer = setTimeout(() => {
                if (state.cancelled || state.dragging) return;
                state.armed = true;
                el.classList.add('tab-armed');
                try { if (navigator.vibrate) navigator.vibrate(8); } catch (_) {}
            }, DRAG_ARM_MS);
            menuTimer = setTimeout(() => {
                if (state.dragging || state.cancelled) return;
                state.didMenu = true;
                el.classList.remove('tab-armed');
                this._showTabMenu(tab, el);
            }, MENU_MS);
        });

        el.addEventListener('pointermove', (e) => {
            if (state.cancelled || state.dragging) return;
            const moved = Math.hypot(e.clientX - state.startX, e.clientY - state.startY) > MOVE_THRESHOLD;
            if (!moved) return;
            if (!state.armed) {
                // Moved before the drag-arm fired — treat as a scroll gesture
                // and let the strip pan horizontally.
                clearTimers();
                state.cancelled = true;
                return;
            }
            state.dragging = true;
            clearTimers();
            el.classList.remove('tab-armed');
            this._beginTabDrag(el, tab, e, state);
        });

        const endTap = (e) => {
            if (!state.dragging && !state.cancelled && !state.didMenu && !state.armed) {
                // User tapped this tab on THIS device — switch optimistically
                // (a mobile switch is a server round-trip whose echo may be
                // suppressed when another device already sits on this tab).
                this._switchTabLocal(tab.id);
            } else if (state.armed && !state.dragging && !state.didMenu) {
                el.classList.remove('tab-armed');
                this._showTabMenu(tab, el);
                if (e && e.preventDefault) e.preventDefault();
            }
            clearTimers();
            if (!state.dragging) el.classList.remove('tab-armed');
            state.cancelled = true;
        };
        el.addEventListener('pointerup', endTap);
        el.addEventListener('pointercancel', () => {
            clearTimers();
            el.classList.remove('tab-armed');
            state.cancelled = true;
        });
    }

    // Drag-reorder implementation. Browser-tab feel: the picked-up tab floats
    // under the finger; neighbors slide live as you move; on release we send
    // `move-tab` to the desktop, which authoritatively reorders its strip and
    // the next snapshot confirms the new order.
    _beginTabDrag(srcEl, tab, startEvent, state) {
        const strip = this.tabsEl;
        if (!strip) return;

        const startRect = srcEl.getBoundingClientRect();
        const grabOffsetX = startEvent.clientX - startRect.left;
        const ghost = srcEl.cloneNode(true);
        ghost.classList.add('tab-ghost');
        ghost.style.width = `${startRect.width}px`;
        ghost.style.height = `${startRect.height}px`;
        ghost.style.left = `${startRect.left}px`;
        ghost.style.top = `${startRect.top}px`;
        document.body.appendChild(ghost);
        srcEl.classList.add('tab-dragging');

        // Prevent the horizontal strip from scroll-panning while we drag.
        const prevOverflow = strip.style.overflowX;
        strip.style.overflowX = 'hidden';

        let finalBeforeId = null;
        const tabSelector = '.tab:not(.tab-add):not(.tab-dragging)';

        const update = (clientX, clientY) => {
            ghost.style.left = `${clientX - grabOffsetX}px`;
            ghost.style.top = `${startRect.top}px`;

            // Find the tab (or + button) the finger is over within the strip.
            const siblings = Array.from(strip.querySelectorAll(tabSelector));
            const addBtn = strip.querySelector('.tab-add');
            let placeBefore = null; // DOM node to insertBefore(); null = append at end
            for (const sib of siblings) {
                const r = sib.getBoundingClientRect();
                const mid = r.left + r.width / 2;
                if (clientX < mid) { placeBefore = sib; break; }
            }
            if (!placeBefore && addBtn) placeBefore = addBtn;

            if (placeBefore && placeBefore !== srcEl.nextSibling) {
                strip.insertBefore(srcEl, placeBefore);
            }

            // Auto-scroll the strip when the finger nears either edge.
            const sr = strip.getBoundingClientRect();
            const EDGE = 40;
            if (clientX < sr.left + EDGE) strip.scrollLeft -= 8;
            else if (clientX > sr.right - EDGE) strip.scrollLeft += 8;
        };

        const move = (e) => {
            e.preventDefault();
            update(e.clientX, e.clientY);
        };
        const end = (e) => {
            document.removeEventListener('pointermove', move, { capture: true });
            document.removeEventListener('pointerup', end, { capture: true });
            document.removeEventListener('pointercancel', end, { capture: true });

            ghost.remove();
            srcEl.classList.remove('tab-dragging');
            strip.style.overflowX = prevOverflow;

            // Compute neighbor id for the move-tab payload: the tab now to
            // the right of src (skipping the + button). -1 means "append".
            let after = srcEl.nextElementSibling;
            while (after && after.classList.contains('tab-add')) after = after.nextElementSibling;
            let finalBeforeId;
            if (after && after.dataset.tabId != null) {
                finalBeforeId = parseInt(after.dataset.tabId, 10);
            } else {
                finalBeforeId = -1;
            }

            // Only send if the position actually changed since pickup.
            const originalNext = srcEl.dataset.origNextId;
            if (String(finalBeforeId) !== originalNext) {
                this.socket.sendInput('move-tab', { id: tab.id, before: finalBeforeId });
            }
            delete srcEl.dataset.origNextId;
            state.cancelled = true;
        };

        // Record the neighbor id at pickup time so we can skip no-op sends.
        let origNext = srcEl.nextElementSibling;
        while (origNext && origNext.classList.contains('tab-add')) origNext = origNext.nextElementSibling;
        srcEl.dataset.origNextId = String(
            (origNext && origNext.dataset.tabId != null) ? parseInt(origNext.dataset.tabId, 10) : -1
        );

        document.addEventListener('pointermove', move, { capture: true, passive: false });
        document.addEventListener('pointerup', end, { capture: true });
        document.addEventListener('pointercancel', end, { capture: true });

        // Apply the initial position using the pointerdown event that triggered us.
        update(startEvent.clientX, startEvent.clientY);
    }

    _showTabMenu(tab, anchorEl) {
        this._dismissTabMenu();
        const menu = document.createElement('div');
        menu.className = 'tab-menu';

        const rect = anchorEl.getBoundingClientRect();
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.bottom + 4}px`;

        const resyncBtn = document.createElement('button');
        resyncBtn.textContent = 'RESYNC';
        resyncBtn.addEventListener('click', () => {
            this._dismissTabMenu();
            this._resync();
        });

        const renameBtn = document.createElement('button');
        renameBtn.textContent = 'RENAME';
        renameBtn.addEventListener('click', () => {
            this._dismissTabMenu();
            const name = prompt('Tab name:', tab.name || '');
            if (name !== null) this.socket.sendInput('rename-tab', { id: tab.id, title: name });
        });

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'CLOSE';
        closeBtn.addEventListener('click', () => {
            this._dismissTabMenu();
            if (confirm(`Close ${tab.name || 'this tab'}?`)) {
                this.socket.sendInput('close-tab', { id: tab.id });
            }
        });

        menu.appendChild(resyncBtn);
        menu.appendChild(renameBtn);
        menu.appendChild(closeBtn);
        document.body.appendChild(menu);
        this._tabMenu = menu;

        const dismiss = (e) => {
            if (!menu.contains(e.target)) {
                this._dismissTabMenu();
                document.removeEventListener('pointerdown', dismiss);
            }
        };
        requestAnimationFrame(() => document.addEventListener('pointerdown', dismiss));
    }

    _dismissTabMenu() {
        if (this._tabMenu) {
            this._tabMenu.remove();
            this._tabMenu = null;
        }
    }

    _resync() {
        this._tabStates.clear();
        this._hasReceivedSnapshot = false;
        this._adoptNewTabIds = null;
        this.termEl.innerHTML = '';
        this.socket.send('request', { what: 'snapshot' });
    }

    _renderTerminalSnapshot(term) {
        const ts = this._getTabState(this._activeTabId);
        ts.term.reset();
        if (term.rows) ts.term.setRows(term.rows);
        ts.term.write(term.screen || term.recent || '');
        this.termEl.innerHTML = ts.term.toHtml();
        this._fitTerminalFont(term.cols);
        this._scrollTermBottom();
    }

    _applyTerminalChunk(payload) {
        if (!payload || typeof payload.data !== 'string') return;
        // Server sends { id: tabId, data: "..." }. Feed every tab's grid buffer
        // immediately (cheap, no DOM) so switching tabs shows correct state and
        // no frame is ever lost; only the active tab triggers a re-render.
        const tabId = payload.id ?? this._activeTabId;
        const ts = this._getTabState(tabId);
        ts.term.write(payload.data);
        this._detectTabAgent(tabId, payload.data);
        if (tabId === this._activeTabId && !this._flushScheduled) {
            this._flushScheduled = true;
            requestAnimationFrame(() => this._renderActive());
        }
    }

    // Watch each tab's stream for agent-status patterns (green=working,
    // orange=needs input, blue=idle) and colour the tab. Mirrors the desktop's
    // client-side detection since the server doesn't send a status field.
    _detectTabAgent(id, data) {
        if (!this._agentRecent) this._agentRecent = new Map();
        if (!this._mobileStatus) this._mobileStatus = new Map();
        let sb = this._agentRecent.get(id);
        if (!sb) { sb = { recent: '', last: 0 }; this._agentRecent.set(id, sb); }
        sb.recent += data;
        if (sb.recent.length > 2048) sb.recent = sb.recent.slice(-1500);
        const now = Date.now();
        if (now - sb.last < 250) return;   // throttle per tab
        sb.last = now;
        const cur = this._mobileStatus.get(id) || 'idle';
        const next = classifyAgent(sb.recent, cur);
        if (next && next !== cur) {
            this._mobileStatus.set(id, next);
            this._setTabStatusDom(id, next);
            if (next === 'attention') this._showAgentToast(this._tabName(id));
            // Keep the IM status strip live for the tab being viewed.
            if (this._currentView === 'chat-view' && id === this._activeTabId) this._renderChatStatus();
            sb.recent = '';                // avoid re-detecting stale patterns
        }
        // Track context % live from the tab's rendered screen (the statusline
        // where Claude prints it). Scanning the buffer — not the raw stream
        // window — survives redraws and partial chunks.
        this._scanCtx(id);
    }

    _setTabStatusDom(id, status) {
        const css = cssStatus(status);
        const el = this.tabsEl && this.tabsEl.querySelector(`[data-tab-id="${id}"]`);
        if (!el) return;
        if (css) el.setAttribute('data-status', css);
        else el.removeAttribute('data-status');
    }

    // Read the tab's rendered screen for Claude's context % and record it.
    _scanCtx(id) {
        const ts = this._tabStates.get(id);
        if (!ts || !ts.term) return;
        const pct = extractCtxPct(ts.term.recentText(40));
        if (pct == null || this._ctxPct.get(id) === pct) return;
        this._ctxPct.set(id, pct);
        if (this._currentView === 'chat-view' && id === this._activeTabId) this._renderChatStatus();
    }

    _tabName(id) {
        const t = this._snapshot && this._snapshot.tabs && this._snapshot.tabs.find(x => x.id === id);
        return (t && t.title) || `TAB ${id}`;
    }

    _getTabState(id) {
        if (!this._tabStates.has(id)) {
            this._tabStates.set(id, { term: new TermBuffer({ rows: this._screenRows || 24 }) });
        }
        return this._tabStates.get(id);
    }

    // Re-render the active tab's grid buffer into the DOM. Coalesced via rAF so
    // a burst of frames produces at most one paint per animation frame.
    _renderActive() {
        this._flushScheduled = false;
        const ts = this._getTabState(this._activeTabId);
        const stayBottom = !this._userScrolledUp;
        const prevTop = this.termEl.scrollTop;
        this.termEl.innerHTML = ts.term.toHtml();
        this.termEl.scrollTop = stayBottom ? this.termEl.scrollHeight : prevTop;
    }

    _scrollTermBottom() {
        requestAnimationFrame(() => {
            this.termEl.scrollTop = this.termEl.scrollHeight;
        });
    }

    // Show the "↓ latest" pill only while the user is scrolled up AND looking at
    // the terminal. Snapping back to bottom fires a scroll event that clears it.
    _updateTermJump() {
        if (!this.termJump) return;
        const show = !!this._userScrolledUp && this._currentView === 'terminal-view';
        this.termJump.classList.toggle('visible', show);
    }

    _isAtBottom() {
        const el = this.termEl;
        return (el.scrollHeight - el.scrollTop - el.clientHeight) < 10;
    }

    _fitTerminalFont(cols) {
        if (cols && cols > 0) this._termCols = cols;

        const cs = getComputedStyle(this.termEl);
        const availW = this.termEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        if (availW <= 0) return;

        // Measure character width at a known reference size, then derive the
        // per-pixel advance (monospace ⇒ width scales linearly with font-size).
        const REF = 16;
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:' + REF + 'px/' + 1.45 + ' ' + cs.fontFamily;
        probe.textContent = 'M';
        document.body.appendChild(probe);
        const charWAtRef = probe.offsetWidth;
        document.body.removeChild(probe);
        if (charWAtRef <= 0) return;

        // Mobile is a VIEWER of the desktop's terminal. We do NOT resize the
        // shared PTY (that SIGWINCHes the desktop and corrupts its layout).
        // Instead we shrink our own font so the desktop's `cols` columns fit
        // the phone width, preserving the exact wrapping the desktop renders.
        const targetCols = this._termCols || 80;
        const charWPerPx = charWAtRef / REF;
        let fontSize = availW / (targetCols * charWPerPx);
        fontSize = Math.max(this._minFontSize, Math.min(this._maxFontSize, fontSize));
        // Apply the user's font preference on top of the auto-fit, then clamp to
        // an absolute safety range so an extreme value can't make it unusable.
        fontSize = fontSize * (this._fontScale || 1);
        fontSize = Math.max(4, Math.min(48, fontSize));

        this.termEl.style.fontSize = fontSize + 'px';
    }

    _renderWidgets(widgets, host) {
        const cards = [];
        if (host && host.name) {
            cards.push(card('HOST', host.name, host.platform ? host.platform.toUpperCase() : ''));
        }
        if (widgets.clock) {
            const t = new Date(widgets.clock.time);
            const hh = String(t.getHours()).padStart(2, '0');
            const mm = String(t.getMinutes()).padStart(2, '0');
            const ss = String(t.getSeconds()).padStart(2, '0');
            cards.push(card('CLOCK', `${hh}:${mm}:${ss}`, t.toDateString()));
        }
        if (widgets.cpu) {
            cards.push(meterCard('CPU', widgets.cpu.usagePct));
        }
        if (widgets.ram) {
            cards.push(meterCard('MEMORY', widgets.ram.usagePct));
        }
        if (widgets.net) {
            const inbps  = formatRate(widgets.net.rx_sec || widgets.net.rxBytesPerSec);
            const outbps = formatRate(widgets.net.tx_sec || widgets.net.txBytesPerSec);
            cards.push(card('NETWORK', `${inbps} ↓ · ${outbps} ↑`, ''));
        }
        if (widgets.deviceStatus) {
            const ds = widgets.deviceStatus;
            const batLabel = ds.battery ? ds.battery.label : 'N/A';
            const netLabel = ds.network || '—';
            const cpuLabel = ds.cpuTemp != null ? ds.cpuTemp + '°C' : 'N/A';
            const gpuLabel = ds.gpuTemp != null ? ds.gpuTemp + '°C' : 'N/A';
            cards.push(card('DEVICE STATUS',
                `${batLabel} · ${netLabel}`,
                `CPU ${cpuLabel}  GPU ${gpuLabel}`
            ));
        }
        this.widgetsEl.innerHTML = cards.join('') || `<div class="w-card"><h2>No data yet</h2><div class="w-meta">Waiting for the desktop to push state…</div></div>`;
    }

    _showNotice({ level, text }) {
        if (!text) return;
        const colour = level === 'error' ? '\x1b[91m' : (level === 'warn' ? '\x1b[93m' : '\x1b[92m');
        this._applyTerminalChunk({ data: `\r\n${colour}[${(level || 'info').toUpperCase()}] ${text}\x1b[0m\r\n` });
    }

    // Generic brief toast (reuses the agent-toast element).
    _toast(msg) {
        const toast = document.getElementById('agent-toast');
        if (!toast) return;
        clearTimeout(this._toastTimer);
        toast.textContent = msg;
        toast.classList.add('visible');
        this._toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
    }

    _showAgentToast(tabName) {
        const toast = document.getElementById('agent-toast');
        if (!toast) return;
        clearTimeout(this._toastTimer);
        toast.textContent = `Tab ${tabName} needs your attention.`;
        toast.classList.add('visible');
        this._toastTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
        if ('vibrate' in navigator) try { navigator.vibrate([80, 40, 80]); } catch (_) {}
    }

    _showFatal(text) {
        document.getElementById('app').innerHTML = `
            <div style="padding:32px;text-align:center;color:var(--err);font-size:14px;letter-spacing:.18em;">
                <div style="font-size:18px;margin-bottom:14px;color:var(--fg);">SESSION REQUIRED</div>
                <div>${escapeHtml(text)}</div>
            </div>`;
    }
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
    ));
}

// Pull Claude Code's context % out of recent terminal text. Mirrors the desktop
// detector: scan lines bottom-up, try several phrasings (used / remaining /
// custom bar-gauge statuslines). Returns a 0–100 integer or null.
function extractCtxPct(text) {
    if (!text) return null;
    const clamp = n => Math.min(100, Math.max(0, Math.round(n)));
    const lines = String(text).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i];
        if (!t || t.indexOf('%') === -1) continue;
        let m;
        if ((m = t.match(/(\d{1,3})\s*%\s*context\s*used/i)))                  return clamp(+m[1]);
        if ((m = t.match(/context\s*used\s*[:\-]?\s*(\d{1,3})\s*%/i)))          return clamp(+m[1]);
        if ((m = t.match(/context\s+is\s+(\d{1,3})\s*%/i)))                    return clamp(+m[1]);
        if ((m = t.match(/(\d{1,3})\s*%\s+(?:left\s+)?until\s+auto-?compact/i))) return clamp(100 - +m[1]);
        if ((m = t.match(/(?:left|remaining)\s+until\s+auto-?compact\s*[:\-]?\s*(\d{1,3})\s*%/i))) return clamp(100 - +m[1]);
        if ((m = t.match(/context\s+left\s*[:\-]?\s*(\d{1,3})\s*%/i)))          return clamp(100 - +m[1]);
        if ((m = t.match(/(\d{1,3})\s*%\s+context\s+(?:left|remaining)/i)))     return clamp(100 - +m[1]);
        if ((m = t.match(/context\s+low\s*\(\s*(\d{1,3})\s*%/i)))              return clamp(100 - +m[1]);
        if (/context/i.test(t) && (m = t.match(/[█▓▒░]\s*(\d{1,3})\s*%/)))      return clamp(+m[1]);
        if ((m = t.match(/[█▓▒░]{3,}\s*(\d{1,3})\s*%/)))                       return clamp(+m[1]);
        if ((m = t.match(/context[^%\d]{0,24}?(\d{1,3})\s*%/i)))               return clamp(+m[1]);
    }
    return null;
}

function ctxColor(pct) {
    return pct >= 80 ? '#ff5555' : pct >= 50 ? '#f1c40f' : '#2ecc71';
}

function card(title, value, meta) {
    return `<div class="w-card"><h2>${escapeHtml(title)}</h2><div class="w-value">${escapeHtml(value)}</div>${meta ? `<div class="w-meta">${escapeHtml(meta)}</div>` : ''}</div>`;
}

function meterCard(title, pct) {
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="w-card">
        <h2>${escapeHtml(title)}</h2>
        <div class="w-value">${v.toFixed(0)}%</div>
        <div class="w-bar"><span style="width:${v}%"></span></div>
    </div>`;
}

function formatRate(bps) {
    if (!Number.isFinite(bps)) return '—';
    if (bps < 1024) return `${bps.toFixed(0)} B/s`;
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
}

window.addEventListener('DOMContentLoaded', () => {
    window._app = new App();
    // Only register the service worker when served at the root scope (i.e.
    // same-origin as the backend). On Vercel we live under /m/ which would
    // give the SW the wrong scope and cache stale assets.
    // Skip the SW inside the native shell: Capacitor already serves the assets
    // from the app bundle (offline works without it) and registering a SW on the
    // capacitor:// scheme is unreliable. window.Capacitor is injected by the
    // native runtime and is undefined on the plain web build.
    if ('serviceWorker' in navigator && location.pathname === '/' && !window.Capacitor) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            location.reload();
        });
    }
    checkVersionMatch();
});

async function checkVersionMatch() {
    try {
        const app = window._app;
        const backend = (app && app.socket && app.socket.baseUrl)
            ? app.socket.baseUrl.replace(/^ws(s?):\/\//, 'http$1://')
            : location.origin;
        const versionUrl = location.pathname.startsWith('/m/') ? 'version.json' : '/version.json';
        const [mobileRes, desktopRes] = await Promise.allSettled([
            fetch(versionUrl, { cache: 'no-store' }),
            fetch(backend + '/api/ping', { cache: 'no-store' }),
        ]);
        if (mobileRes.status !== 'fulfilled' || !mobileRes.value.ok) return;
        if (desktopRes.status !== 'fulfilled' || !desktopRes.value.ok) return;
        const mobile = await mobileRes.value.json();
        const desktop = await desktopRes.value.json();
        if (!mobile.version || !desktop.desktopVersion) return;
        const a = mobile.version.split('.').slice(0, 2).join('.');
        const b = desktop.desktopVersion.split('.').slice(0, 2).join('.');
        if (a === b) return;
        showVersionMismatchBanner(mobile.version, desktop.desktopVersion);
    } catch (_) { /* silent */ }
}

function showVersionMismatchBanner(mobileVersion, desktopVersion) {
    const el = document.createElement('div');
    el.textContent = `VERSION MISMATCH — mobile ${mobileVersion} · desktop ${desktopVersion}. Please update both to the same release.`;
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;padding:8px 12px;background:#3a0a0a;color:#ffb3b3;font:12px/1.4 monospace;text-align:center;border-bottom:1px solid #ff5d6f;letter-spacing:.08em;';
    document.body.appendChild(el);
}
