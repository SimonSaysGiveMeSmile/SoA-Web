/**
 * Minimal ANSI → HTML renderer for the mobile terminal view.
 *
 * We do NOT emulate a full VT100 — that would mean shipping xterm.js to mobile,
 * which is heavy. Instead, we:
 *
 *   - strip cursor-positioning sequences (CUP, CUF, ED, EL, etc.) so they don't
 *     show up as garbage;
 *   - convert SGR colour/style sequences into <span> tags with class names;
 *   - escape HTML chars to keep things safe;
 *   - honour \r as "go to start of line" inside the current logical line by
 *     replacing the line-being-built (good enough for spinners and progress).
 *
 * This trades correctness for footprint and battery life. A future iteration
 * can swap to xterm.js if we ever need full fidelity.
 */

const ESC = '\x1b';

const PALETTE = [
    '#000000', '#ff5d6f', '#5fff5f', '#ffe066', '#5fa8ff',
    '#d979ff', '#5fffe0', '#dddddd',
    '#666666', '#ff8c95', '#9bff9b', '#fff39c', '#9bc8ff',
    '#e6a3ff', '#9fffe9', '#ffffff'
];

export function escHtml(s) {
    return s.replace(/[&<>"']/g, c => (
        { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
    ));
}

export function spanFor(state) {
    const styles = [];
    const classes = [];
    if (state.bold)      classes.push('ansi-bold');
    if (state.dim)       classes.push('ansi-dim');
    if (state.italic)    classes.push('ansi-italic');
    if (state.underline) classes.push('ansi-under');
    if (state.reverse)   classes.push('ansi-rev');
    if (state.link)      classes.push('ansi-link');
    if (state.fg) styles.push(`color:${state.fg}`);
    if (state.bg) styles.push(`background:${state.bg}`);
    if (!styles.length && !classes.length && !state.link) return null;
    const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
    const sty = styles.length  ? ` style="${styles.join(';')}"`  : '';
    if (state.link) {
        const href = escHtml(state.link);
        return `<a href="${href}" target="_blank" rel="noopener"${cls}${sty}>`;
    }
    return `<span${cls}${sty}>`;
}

export function applySgr(state, params) {
    if (!params.length) params = [0];
    let i = 0;
    while (i < params.length) {
        const p = params[i];
        if (p === 0) {
            state.bold = state.dim = state.italic = state.underline = state.reverse = false;
            state.fg = null; state.bg = null;
        } else if (p === 1)  state.bold = true;
        else if (p === 2)    state.dim = true;
        else if (p === 3)    state.italic = true;
        else if (p === 4)    state.underline = true;
        else if (p === 7)    state.reverse = true;
        else if (p === 22)   { state.bold = false; state.dim = false; }
        else if (p === 23)   state.italic = false;
        else if (p === 24)   state.underline = false;
        else if (p === 27)   state.reverse = false;
        else if (p === 39)   state.fg = null;
        else if (p === 49)   state.bg = null;
        else if (p >= 30  && p <= 37)  state.fg = PALETTE[p - 30];
        else if (p >= 40  && p <= 47)  state.bg = PALETTE[p - 40];
        else if (p >= 90  && p <= 97)  state.fg = PALETTE[p - 90 + 8];
        else if (p >= 100 && p <= 107) state.bg = PALETTE[p - 100 + 8];
        else if (p === 38 || p === 48) {
            const target = p === 38 ? 'fg' : 'bg';
            const mode = params[i + 1];
            if (mode === 5) {
                const idx = params[i + 2];
                state[target] = palette256(idx);
                i += 2;
            } else if (mode === 2) {
                const r = params[i + 2], g = params[i + 3], b = params[i + 4];
                state[target] = `rgb(${r||0},${g||0},${b||0})`;
                i += 4;
            }
        }
        i++;
    }
}

export function palette256(idx) {
    if (idx < 16) return PALETTE[idx];
    if (idx >= 232) {
        const v = 8 + (idx - 232) * 10;
        return `rgb(${v},${v},${v})`;
    }
    const n = idx - 16;
    const r = Math.floor(n / 36) * 51;
    const g = Math.floor((n / 6) % 6) * 51;
    const b = (n % 6) * 51;
    return `rgb(${r},${g},${b})`;
}

const URL_RE = /\bhttps?:\/\/[^\s<>&"')\]]+/g;

function linkifyUrls(htmlStr) {
    return htmlStr.replace(URL_RE, match => {
        return `<a href="${match}" class="ansi-link" target="_blank" rel="noopener">${match}</a>`;
    });
}

/**
 * Convert an ANSI string into an HTML fragment (sanitized).
 */
export function ansiToHtml(input, state = newState()) {
    let out = '';
    let buf = '';
    let openTag = false;
    // Set when the stream asks to wipe the screen (erase-display 2J/3J, full
    // reset ESC c, or alternate-screen switch). Full-screen TUI apps (e.g. an
    // agent CLI) redraw by clearing + repainting every frame; without honoring
    // the clear, an append-only renderer accumulates a screenful of mostly-
    // blank lines per frame (hundreds of frames ⇒ thousands of blank lines that
    // bury the real output). The caller wipes the terminal when this is true.
    let cleared = false;

    const flushBuf = () => {
        if (!buf) return;
        out += linkifyUrls(escHtml(buf));
        buf = '';
    };

    const closeTag = () => {
        if (openTag) {
            out += state.link ? '</a>' : '</span>';
            openTag = false;
        }
    };

    const openTagIfNeeded = () => {
        const s = spanFor(state);
        if (s) { out += s; openTag = true; }
    };

    let i = 0;
    while (i < input.length) {
        const c = input[i];
        if (c === '\r') { i++; continue; }
        if (c === '\n') {
            flushBuf();
            closeTag();
            out += '\n';
            openTagIfNeeded();
            i++;
            continue;
        }
        if (c !== ESC) {
            buf += c;
            i++;
            continue;
        }
        // Escape sequence
        flushBuf();
        closeTag();

        const next = input[i + 1];
        if (next === '[') {
            // CSI sequence
            let j = i + 2;
            // Collect parameter bytes (digits, ;, ?)
            let params = '';
            while (j < input.length && /[0-9;?]/.test(input[j])) {
                params += input[j++];
            }
            const final = input[j];
            j++; // consume final
            i = j;
            if (final === 'm') {
                const nums = params.split(';').filter(Boolean).map(Number);
                applySgr(state, nums);
                openTagIfNeeded();
            } else if (final === 'J' && (params === '2' || params === '3')) {
                // Erase entire display (and scrollback for 3J) — wipe and
                // restart this render from a clean screen.
                cleared = true;
                out = ''; openTag = false;
                openTagIfNeeded();
            } else if (final === 'A') {
                // Cursor up N rows. Full-screen TUIs (e.g. an agent CLI spinner)
                // print N blank lines then move back up to repaint in place. An
                // append-only renderer can't move a cursor, so without this each
                // repaint stacks N more lines (thousands of blank lines pile up).
                // Emit a sentinel the caller turns into "drop the last N lines",
                // which the app's repaint then refills — net-stable line count.
                const n = Math.max(1, parseInt(params, 10) || 1);
                flushBuf();
                closeTag();
                out += '\x01U' + n + '\x01';
                openTagIfNeeded();
            } else if ((final === 'h' || final === 'l') &&
                       /^\?(1049|1047|47)$/.test(params)) {
                // Enter/leave the alternate screen buffer — treat either as a
                // fresh screen so full-screen apps don't stack onto the log.
                cleared = true;
                out = ''; openTag = false;
                openTagIfNeeded();
            } else {
                /* drop everything else — cursor moves, line erases, etc. */
            }
        } else if (next === ']') {
            // OSC sequence
            let j = i + 2;
            let oscBody = '';
            while (j < input.length) {
                if (input[j] === '\x07') { j++; break; }
                if (input[j] === ESC && input[j + 1] === '\\') { j += 2; break; }
                oscBody += input[j];
                j++;
            }
            i = j;
            // OSC 8 — hyperlink: \e]8;params;uri\a ... \e]8;;\a
            if (oscBody.startsWith('8;')) {
                const parts = oscBody.slice(2);
                const semiIdx = parts.indexOf(';');
                if (semiIdx !== -1) {
                    const uri = parts.slice(semiIdx + 1);
                    state.link = uri || null;
                }
            }
            openTagIfNeeded();
        } else if (next === 'c') {
            // RIS — full terminal reset. Wipe and start clean.
            cleared = true;
            out = ''; openTag = false;
            state.bold = state.dim = state.italic = state.underline = state.reverse = false;
            state.fg = null; state.bg = null; state.link = null;
            i += 2;
            openTagIfNeeded();
        } else {
            // Skip any 2-byte escape we don't model
            i += 2;
        }
    }

    flushBuf();
    closeTag();
    return { html: out, state, cleared };
}

export function newState() {
    return {
        bold: false, dim: false, italic: false, underline: false, reverse: false,
        fg: null, bg: null, link: null,
    };
}
