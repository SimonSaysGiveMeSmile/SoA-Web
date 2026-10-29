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

// Terminal.app's "Basic" profile ANSI table (the same in light and dark).
const TERMINAL_APP_BASIC = {
    black: '#000000', red: '#990000', green: '#00a600', yellow: '#999900',
    blue: '#0000b2', magenta: '#b200b2', cyan: '#00a6b2', white: '#bfbfbf',
    brightBlack: '#666666', brightRed: '#e50000', brightGreen: '#00d900',
    brightYellow: '#e5e500', brightBlue: '#0000ff', brightMagenta: '#e500e5',
    brightCyan: '#00e5e5', brightWhite: '#e5e5e5',
};
// Windows Terminal "Campbell" (its default) and "One Half Light" (bundled). One Half
// Light's white is #FAFAFA — its own background — so plain-white output would vanish;
// it is the one value nudged, to the scheme's bright-black.
const WT_CAMPBELL = {
    black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00',
    blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
    brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c',
    brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e',
    brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
};
const WT_ONE_HALF_LIGHT = {
    black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
    blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#4f525d',
    brightBlack: '#4f525d', brightRed: '#df6c75', brightGreen: '#98c379',
    brightYellow: '#e4c07a', brightBlue: '#61afef', brightMagenta: '#c577dd',
    brightCyan: '#56b5c1', brightWhite: '#ffffff',
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

// LIQUID UI language: terminals are deep near-black glass cards floating on the
// lit graphite ground. Monochrome white cursor/selection; program output keeps
// the standard ANSI 16 (dark) so colors read as themselves.
const LIQUID_XTERM = {
    foreground: '#e6e6ea', background: '#0a0a0e', cursor: '#ffffff',
    cursorAccent: '#0a0a0e', selectionBackground: 'rgba(255,255,255,0.22)', ...ANSI_DARK,
};

// True while the MINIMAL UI language is active (data-ui set pre-paint by
// index.html and kept in sync by settings.js on change).
export function isMinimalUi() {
    return document.documentElement.dataset.ui === 'minimal';
}

// True while the LIQUID (liquid-glass / iOS) UI language is active.
export function isLiquidUi() {
    return document.documentElement.dataset.ui === 'liquid';
}

// xterm theme object for a RESOLVED theme. Surface + ink + cursor + selection are
// swapped to match the CSS palette; ANSI follows the surface brightness.
export function xtermTheme(resolved) {
    const pack = document.documentElement.dataset.ui;
    // Desktop packs ship their platform's real terminal: Terminal.app "Basic"
    // (white / #1E1E1E and its ANSI table), Windows Terminal ("Campbell" in the
    // dark, "One Half Light" in the light), and for Soft UI the slab itself.
    const desktop = {
        macos27: { light: '#ffffff', dim: '#f5f5f7', dark: '#1e1e1e', ink: '#000000', inkDark: '#ffffff',
            cursor: '#7f7f7f', cursorDark: '#8c8c8c', sel: 'rgba(179,215,255,.6)', selDark: 'rgba(90,110,140,.55)',
            ansi: TERMINAL_APP_BASIC, ansiDark: TERMINAL_APP_BASIC },
        windows11: { light: '#fafafa', dim: '#f0f0f0', dark: '#0c0c0c', ink: '#383a42', inkDark: '#cccccc',
            cursor: '#383a42', cursorDark: '#ffffff', sel: 'rgba(56,58,66,.2)', selDark: 'rgba(255,255,255,.3)',
            ansi: WT_ONE_HALF_LIGHT, ansiDark: WT_CAMPBELL },
        neumorphism: { light: '#e0e5ec', dim: '#d4dae3', dark: '#2c3038', ink: '#3b4a60', inkDark: '#dfe5ef',
            cursor: '#4a67f0', cursorDark: '#7f95ff', sel: 'rgba(74,103,240,.2)', selDark: 'rgba(127,149,255,.3)',
            ansi: ANSI_LIGHT, ansiDark: ANSI_DARK },
    }[pack];
    if (desktop) {
        const dark = resolved === 'dark', background = desktop[resolved] || desktop.dark;
        return {
            ...(dark ? desktop.ansiDark : desktop.ansi),
            foreground: dark ? desktop.inkDark : desktop.ink, background,
            cursor: dark ? desktop.cursorDark : desktop.cursor, cursorAccent: background,
            selectionBackground: dark ? desktop.selDark : desktop.sel,
        };
    }
    if (pack === 'brutalist') return {
        ...ANSI_DARK, foreground: '#eeedda', background: '#181916', cursor: '#ffed43',
        cursorAccent: '#181916', selectionBackground: 'rgba(255,237,67,0.25)',
    };
    if (pack === 'classic') return {
        ...ANSI_LIGHT, foreground: '#202737', background: '#fffef8', cursor: '#164b9b',
        white: '#4d5a68', brightWhite: '#1e2938',
        cursorAccent: '#fffef8', selectionBackground: 'rgba(49,106,197,0.24)',
    };
    if (pack === 'dos') return {
        ...ANSI_DARK, foreground: '#e5e9c7', background: '#050b18', cursor: '#fff697',
        cursorAccent: '#050b18', selectionBackground: 'rgba(185,198,208,0.32)',
    };
    if (isMinimalUi()) return { ...MINIMAL_XTERM };
    if (isLiquidUi()) return resolved === 'dark' ? { ...LIQUID_XTERM } : {
        ...ANSI_LIGHT, foreground: '#1b354b', background: '#f4f8fc', cursor: '#1265ad',
        white: '#4d6576', brightWhite: '#1b354b',
        cursorAccent: '#f4f8fc', selectionBackground: 'rgba(18,101,173,0.22)',
    };
    if (resolved === 'light') return {
        foreground: '#15302e', background: '#f7f9fa', cursor: '#0e6b73',
        cursorAccent: '#f7f9fa', selectionBackground: 'rgba(14,107,115,0.25)', ...ANSI_LIGHT,
    };
    if (resolved === 'dim') return {
        foreground: '#1c2b2a', background: '#dde3e5', cursor: '#11595f',
        cursorAccent: '#dde3e5', selectionBackground: 'rgba(17,89,95,0.25)', ...ANSI_LIGHT,
    };
    return { // dark (default)
        foreground: '#c4e6ec', background: '#060f16', cursor: '#79e5ee',
        cursorAccent: '#060f16', selectionBackground: 'rgba(121,229,238,0.25)', ...ANSI_DARK,
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
