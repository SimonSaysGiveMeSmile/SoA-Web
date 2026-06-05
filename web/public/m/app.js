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
const MOBILE_BUILD = 'v35 · web-preview · 2026-06-05';

const STORAGE_KEY = 'son-of-anton.session';
const THEME_KEY = 'son-of-anton.theme';
const MIC_SETTINGS_KEY = 'son-of-anton.mic-settings';

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
            '--bg':             '#f0f2f5',
            '--bg-alt':         '#e8eaed',
            '--fg':             '#1d1d1f',
            '--fg-dim':         'rgba(29,29,31,0.5)',
            '--fg-faint':       'rgba(29,29,31,0.15)',
            '--accent':         '#0071e3',
            '--accent-glow':    'rgba(0,113,227,0.3)',
            '--accent-bg':      'rgba(0,113,227,0.08)',
            '--accent-bg-hover':'rgba(0,113,227,0.14)',
            '--warn':           '#e67e00',
            '--err':            '#e3342f',
            '--line':           'rgba(0,0,0,0.1)',
            '--radius':         '14px',
            '--panel-bg':       'rgba(255,255,255,0.55)',
            '--font':           "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif",
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
    const effectiveBackend = backend || null;
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
    return { token: null, backend: null, altOrigin: null };
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
        this.kbdEl       = document.getElementById('kbd');
        this.viewEls     = Array.from(document.querySelectorAll('.view'));
        this.viewBtns    = Array.from(document.querySelectorAll('.bb-btn[data-view]'));
        this.btnNewTab   = document.getElementById('btn-newtab');
        this.btnMic      = document.getElementById('btn-mic');
        this.btnSettings = document.getElementById('btn-settings');
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

        this.micDeviceSelect = document.getElementById('mic-device-select');
        this.micGainSlider = document.getElementById('mic-gain-slider');
        this.micGainValue = document.getElementById('mic-gain-value');
        this.micMeterBar = document.getElementById('mic-meter-bar');
        this.btnTestMic = document.getElementById('btn-test-mic');
        this.btnRefreshDevices = document.getElementById('btn-refresh-devices');

        this._snapshot = null;
        this._activeTab = 0;
        this._activeTabId = 0;
        this._connectedDevices = 0;
        this._tabStates = new Map();
        this._tabStatuses = new Map();
        this._toastTimer = null;
        this._flushScheduled = false;
        this._currentTheme = loadSavedTheme();
        this._idleTimer = null;
        this._chromeHidden = false;

        this._minFontSize = 5;
        this._maxFontSize = 15;
        this._termCols = 80;
        this._userScrolledUp = false;

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
        this._wireMicSettings();
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

        this._wireSocket();
        this._wireUi();
        this._buildDiagPanel();
        this._wireWebPreview();

        window.addEventListener('resize', () => this._fitTerminalFont());

        this.termEl.addEventListener('scroll', () => {
            this._userScrolledUp = !this._isAtBottom();
        }, { passive: true });

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
        this._wireReloadControls();
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
            this.btnRefreshDevices.addEventListener('click', () => this._enumerateMicDevices());
        }
    }

    async _enumerateMicDevices() {
        if (!this.micDeviceSelect) return;

        try {
            // Request permission first to get device labels
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop());

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
        this._chromeHidden = true;
        const bb = document.getElementById('bottombar');
        if (bb) bb.classList.add('chrome-hidden');
        if (this.kbdEl) this.kbdEl.classList.add('chrome-hidden');
        this._pullHint.classList.add('visible');
    }

    _showChrome() {
        if (this._chromeHidden) {
            this._chromeHidden = false;
            const bb = document.getElementById('bottombar');
            if (bb) bb.classList.remove('chrome-hidden');
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
                    if (attempt > 1) this._showReconnect(`attempt ${attempt}`);
                    break;
                case SocketState.CONNECTED:
                    this._setStatus('connected', 'paired');
                    this._hideReconnect();
                    if (this._prevSocketState !== SocketState.CONNECTED) sounds.play('connect');
                    break;
                case SocketState.DISCONNECTED:
                    this._setStatus('disconnected', `link lost${code ? ` (${code})` : ''}`);
                    this._showReconnect('link lost · retrying');
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
                case 'term-data': this._applyTerminalChunk(msg.d); break;
                case 'term-exit': break;
                case 'notice':    this._showNotice(msg.d); break;
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

        this.btnNewTab.addEventListener('click', () => this.socket.sendInput('new-tab'));
        this.btnMic.addEventListener('click', () => this.socket.sendInput('voice-toggle'));

        this.termEl.addEventListener('click', () => {
            this._showView('terminal-view');
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
        this.viewEls.forEach(v => v.classList.toggle('active', v.id === target));
        this.viewBtns.forEach(b => b.setAttribute('aria-pressed', b.getAttribute('data-view') === target ? 'true' : 'false'));
        if (target === 'terminal-view') {
            this.kbd.show();
        } else {
            this.kbd.hide();
            this.kbd.blur();
        }
        if (target === 'web-view') this._refreshWebPorts();
    }

    // ── Web preview ──────────────────────────────────────────────────────
    // Open a local dev-server port (proxied via /preview/<port>/ so it's
    // viewable through the tunnel) or an arbitrary URL in an embedded frame.
    _wireWebPreview() {
        this._webPortSel = document.getElementById('web-port');
        this._webUrlInp = document.getElementById('web-url');
        this._webFrame = document.getElementById('web-frame');
        this._webEmpty = document.getElementById('web-empty');
        const go = document.getElementById('web-go');
        const reload = document.getElementById('web-reload');
        if (!this._webFrame) return;

        const openUrl = (raw) => {
            let u = (raw || '').trim();
            if (!u) return;
            // localhost:3000 / 127.0.0.1:3000 → proxy so the phone can reach it.
            const lm = u.replace(/^https?:\/\//, '').match(/^(?:localhost|127\.0\.0\.1):(\d{1,5})(\/.*)?$/i);
            if (lm) u = `/preview/${lm[1]}${lm[2] || '/'}`;
            else if (/^\d{1,5}$/.test(u)) u = `/preview/${u}/`;           // bare port number
            else if (!/^https?:\/\//.test(u) && !u.startsWith('/')) u = 'https://' + u;
            this._openWeb(u);
        };

        this._webPortSel.addEventListener('change', () => {
            const p = this._webPortSel.value;
            if (p) { this._webUrlInp.value = ''; this._openWeb(`/preview/${p}/`); }
        });
        go.addEventListener('click', () => openUrl(this._webUrlInp.value));
        this._webUrlInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') openUrl(this._webUrlInp.value); });
        if (reload) reload.addEventListener('click', () => { if (this._webFrame.src) this._webFrame.src = this._webFrame.src; });
    }

    _openWeb(src) {
        if (!this._webFrame) return;
        this._webFrame.src = src;
        this._webFrame.style.display = 'block';
        if (this._webEmpty) this._webEmpty.style.display = 'none';
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

    _showReconnect(text) {
        this.reconnectOverlay.hidden = false;
        if (text) this.reconnectSub.textContent = text;
        this.reconnectRetry.hidden = false;
    }
    _hideReconnect() {
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
    }

    _applySnapshot(snap) {
        if (!snap) return;
        this._snapshot = snap;

        // Server sends: { tabs: [{id, title, cols, rows, exited}], activeId: N }
        // Normalize to the shape our renderer expects.
        const rawTabs = snap.tabs || [];
        // Defensive activeId resolution. Snapshot broadcasts can carry
        // activeId:0 or omit it entirely (undefined) — the server's HELLO
        // resolves a real id via a tabList fallback, but its periodic/
        // device-count/REQUEST snapshots don't. Blindly trusting that clobbers
        // a known-good _activeTabId to 0, after which TERM_DATA frames for the
        // real tab mismatch _activeTabId and get buffered forever (T counter
        // rises, screen stays blank). Only accept activeId when it names a real
        // tab; otherwise keep the current active tab, falling back to the first.
        const idList = rawTabs.map(t => t.id);
        let activeId = snap.activeId;
        if (!idList.includes(activeId)) {
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
        this._renderActiveTerminal();
        this._updateDeviceCount();
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
        addBtn.addEventListener('click', () => this.socket.sendInput('new-tab'));
        frag.appendChild(addBtn);

        this.tabsEl.innerHTML = '';
        this.tabsEl.appendChild(frag);
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
                this.socket.sendInput('switch-tab', { id: tab.id });
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
            sb.recent = '';                // avoid re-detecting stale patterns
        }
    }

    _setTabStatusDom(id, status) {
        const css = cssStatus(status);
        const el = this.tabsEl && this.tabsEl.querySelector(`[data-tab-id="${id}"]`);
        if (!el) return;
        if (css) el.setAttribute('data-status', css);
        else el.removeAttribute('data-status');
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
    if ('serviceWorker' in navigator && location.pathname === '/') {
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
