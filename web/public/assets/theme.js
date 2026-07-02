// theme.js — theme resolution + xterm palettes, shared by app.js (terminals) and
// settings.js (the selector). The CSS chrome re-themes via :root[data-theme=…]
// token overrides in styles.css; the xterm terminals need their JS theme swapped
// to match, which is what xtermTheme() provides.

export const THEME_SETTINGS = ['auto', 'dark', 'light', 'dim'];

const lightMQ = () => (window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null);

// Map a stored SETTING (auto/dark/light/dim) to a concrete RESOLVED theme.
export function resolveTheme(setting) {
    if (setting === 'light' || setting === 'dim' || setting === 'dark') return setting;
    const m = lightMQ();                       // 'auto' / unknown → follow the OS
    return (m && m.matches) ? 'light' : 'dark';
}

// Standard TRON ANSI 16 (dark) — program output owns these.
const ANSI_DARK = {
    black: '#000000', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#6272a4', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#262828', brightRed: '#ff6e6e', brightGreen: '#69ff94',
    brightYellow: '#ffffa5', brightBlue: '#7b93bd', brightMagenta: '#ff92df',
    brightCyan: '#a4ffff', brightWhite: '#ffffff',
};
// Darkened ANSI for a light/dim surface so colored output stays legible.
const ANSI_LIGHT = {
    black: '#1c2b2a', red: '#b91c1c', green: '#15803d', yellow: '#a16207',
    blue: '#3b4d8f', magenta: '#9333ea', cyan: '#0e7490', white: '#e6eaeb',
    brightBlack: '#52646a', brightRed: '#dc2626', brightGreen: '#16a34a',
    brightYellow: '#ca8a04', brightBlue: '#4f63b0', brightMagenta: '#a855f7',
    brightCyan: '#0891b2', brightWhite: '#ffffff',
};

// MINIMAL UI language: terminals are dark graphite "slate cards" floating on
// the porcelain chrome, whatever the theme setting says — the inversion is the
// language's signature. Calmer, desaturated ANSI to match.
const ANSI_MINIMAL = {
    black: '#171a20', red: '#e06c62', green: '#57ab5a', yellow: '#c69026',
    blue: '#539bf5', magenta: '#b083f0', cyan: '#39c5cf', white: '#d9dee7',
    brightBlack: '#525964', brightRed: '#ff938a', brightGreen: '#6bc46d',
    brightYellow: '#daaa3f', brightBlue: '#6cb6ff', brightMagenta: '#dcbdfb',
    brightCyan: '#56d4dd', brightWhite: '#ffffff',
};
const MINIMAL_XTERM = {
    foreground: '#d9dee7', background: '#14171d', cursor: '#35b8ab',
    cursorAccent: '#14171d', selectionBackground: 'rgba(53,184,171,0.28)', ...ANSI_MINIMAL,
};

// True while the MINIMAL UI language is active (data-ui set pre-paint by
// index.html and kept in sync by settings.js on change).
export function isMinimalUi() {
    return document.documentElement.dataset.ui === 'minimal';
}

// xterm theme object for a RESOLVED theme. Surface + ink + cursor + selection are
// swapped to match the CSS palette; ANSI follows the surface brightness.
export function xtermTheme(resolved) {
    if (isMinimalUi()) return { ...MINIMAL_XTERM };
    if (resolved === 'light') return {
        foreground: '#15302e', background: '#f7f9fa', cursor: '#0e6b73',
        cursorAccent: '#f7f9fa', selectionBackground: 'rgba(14,107,115,0.25)', ...ANSI_LIGHT,
    };
    if (resolved === 'dim') return {
        foreground: '#1c2b2a', background: '#dde3e5', cursor: '#11595f',
        cursorAccent: '#dde3e5', selectionBackground: 'rgba(17,89,95,0.25)', ...ANSI_LIGHT,
    };
    return { // dark (default)
        foreground: '#aacfd1', background: '#05080d', cursor: '#aacfd1',
        cursorAccent: '#aacfd1', selectionBackground: 'rgba(170,207,209,0.3)', ...ANSI_DARK,
    };
}

// Set <html data-theme> from a setting; returns the resolved theme.
export function applyThemeAttr(setting) {
    const resolved = resolveTheme(setting);
    if (document.documentElement.dataset.theme !== resolved) {
        document.documentElement.dataset.theme = resolved;
    }
    return resolved;
}

// Fire cb whenever the OS light/dark preference flips (only meaningful while the
// setting is 'auto'; the caller decides whether to act).
export function onSystemThemeChange(cb) {
    const m = lightMQ();
    if (!m) return () => {};
    const h = () => cb();
    if (m.addEventListener) m.addEventListener('change', h);
    else if (m.addListener) m.addListener(h);
    return () => {
        if (m.removeEventListener) m.removeEventListener('change', h);
        else if (m.removeListener) m.removeListener(h);
    };
}
