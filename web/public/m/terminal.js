/**
 * Cursor-addressed terminal buffer for the mobile view.
 *
 * The old renderer was append-only: it converted ANSI to HTML and appended,
 * dropping cursor-movement escapes. Full-screen TUI apps (an agent CLI spinner,
 * htop, etc.) repaint by moving the cursor and overwriting cells in place — so
 * append-only either stacked thousands of blank lines (cursor-up ignored) or,
 * with a delete-on-cursor-up hack, erased real content down to nothing.
 *
 * This is a small grid emulator: a list of rows of styled cells plus a cursor.
 * It honours CR/LF/BS/TAB, cursor up/down/left/right/column/position, erase
 * line/display, and SGR colour. Writes OVERWRITE the cell under the cursor, so
 * repaints replace in place — stable and correct for the common cases. It is
 * NOT a full VT100 (no scroll regions, origin mode, tab-stop table, or the
 * alternate buffer as a separate surface) but covers what shells and CLI agents
 * actually emit. Scrollback beyond `maxRows` is dropped from the top.
 */

import { applySgr, spanFor, escHtml } from './ansi.js';

const ESC = '\x1b';

function blankCell() { return { ch: ' ', sig: '', style: null }; }

export class TermBuffer {
    constructor({ rows = 24, maxRows = 1200 } = {}) {
        this.screenRows = rows > 0 ? rows : 24;
        this.maxRows = maxRows;
        this.lines = [[]];     // array of rows; each row is array of cells
        this.row = 0;          // cursor row (index into this.lines)
        this.col = 0;          // cursor column
        this.style = newStyle();
        this._sig = '';        // signature of current style (for grouping)
        // sig → frozen style snapshot. Cells store only the sig; the live
        // `this.style` keeps mutating as SGR codes arrive, so storing a
        // reference would make every cell render with the FINAL style (e.g.
        // monochrome after the trailing reset). Snapshot per distinct style.
        this._styleTable = Object.create(null);
        this._styleTable[''] = null;
    }

    setRows(rows) { if (rows > 0) this.screenRows = rows; }

    _styleSig() {
        const s = this.style;
        return `${s.bold?1:0}${s.dim?1:0}${s.italic?1:0}${s.underline?1:0}${s.reverse?1:0}|${s.fg||''}|${s.bg||''}|${s.link||''}`;
    }

    // Recompute the current style signature and register a frozen snapshot for it.
    _commitStyle() {
        this._sig = this._styleSig();
        if (!(this._sig in this._styleTable)) {
            this._styleTable[this._sig] = this._sig === '' ? null : { ...this.style };
        }
    }

    _ensureRow(r) {
        while (this.lines.length <= r) this.lines.push([]);
    }

    _ensureCol(line, c) {
        while (line.length < c) line.push(blankCell());
    }

    _newline() {
        this.row++;
        this._ensureRow(this.row);
        // Cap scrollback: drop from the top so cursor stays in range.
        if (this.lines.length > this.maxRows) {
            const drop = this.lines.length - this.maxRows;
            this.lines.splice(0, drop);
            this.row -= drop;
            if (this.row < 0) this.row = 0;
        }
    }

    _putChar(ch) {
        this._ensureRow(this.row);
        const line = this.lines[this.row];
        this._ensureCol(line, this.col);
        line[this.col] = { ch, sig: this._sig };
        this.col++;
    }

    write(input) {
        const n = input.length;
        let i = 0;
        while (i < n) {
            const c = input[i];
            const code = input.charCodeAt(i);
            if (c === ESC) { i = this._esc(input, i); continue; }
            if (c === '\n') { this._newline(); i++; continue; }
            if (c === '\r') { this.col = 0; i++; continue; }
            if (c === '\b') { if (this.col > 0) this.col--; i++; continue; }
            if (c === '\t') { this.col = (this.col + 8) & ~7; i++; continue; }
            if (code < 0x20) { i++; continue; } // other control chars: ignore
            this._putChar(c);
            i++;
        }
    }

    _esc(input, i) {
        const next = input[i + 1];
        if (next === '[') return this._csi(input, i);
        if (next === ']') return this._osc(input, i);
        if (next === 'c') { this.reset(); return i + 2; }          // RIS
        if (next === 'M') { if (this.row > 0) this.row--; return i + 2; } // reverse index
        if (next === '7' || next === '8') return i + 2;            // save/restore cursor: ignore
        if (next === '(' || next === ')') return i + 3;            // charset select: skip designator
        return i + 2;                                              // unknown 2-byte: skip
    }

    _csi(input, i) {
        let j = i + 2;
        let params = '';
        while (j < input.length && /[0-9;?]/.test(input[j])) params += input[j++];
        const final = input[j];
        j++;
        const nums = params.replace('?', '').split(';');
        const n1 = parseInt(nums[0], 10);
        const arg = isNaN(n1) ? 0 : n1;
        switch (final) {
            case 'A': this.row = Math.max(0, this.row - (arg || 1)); break;
            case 'B': this.row += (arg || 1); this._ensureRow(this.row); break;
            case 'C': this.col += (arg || 1); break;
            case 'D': this.col = Math.max(0, this.col - (arg || 1)); break;
            case 'E': this.row += (arg || 1); this.col = 0; this._ensureRow(this.row); break;
            case 'F': this.row = Math.max(0, this.row - (arg || 1)); this.col = 0; break;
            case 'G': this.col = Math.max(0, (arg || 1) - 1); break;
            case 'd': { const top = this._screenTop(); this.row = top + Math.max(0, (arg || 1) - 1); this._ensureRow(this.row); break; }
            case 'H': case 'f': {
                const r = arg || 1;
                const cc = parseInt(nums[1], 10) || 1;
                const top = this._screenTop();
                this.row = top + (r - 1);
                this.col = cc - 1;
                this._ensureRow(this.row);
                break;
            }
            case 'J': this._eraseDisplay(isNaN(n1) ? 0 : n1); break;
            case 'K': this._eraseLine(isNaN(n1) ? 0 : n1); break;
            case 'm': applySgr(this.style, params.split(';').filter(Boolean).map(Number)); this._commitStyle(); break;
            default: break; // unsupported: ignore
        }
        return j;
    }

    _osc(input, i) {
        let j = i + 2;
        let body = '';
        while (j < input.length) {
            if (input[j] === '\x07') { j++; break; }
            if (input[j] === ESC && input[j + 1] === '\\') { j += 2; break; }
            body += input[j++];
        }
        if (body.startsWith('8;')) {
            const parts = body.slice(2);
            const semi = parts.indexOf(';');
            if (semi !== -1) { this.style.link = parts.slice(semi + 1) || null; this._commitStyle(); }
        }
        return j;
    }

    _screenTop() {
        // Approximate the top of the visible screen for absolute positioning:
        // the last screenRows lines of the buffer are treated as the screen.
        return Math.max(0, this.lines.length - this.screenRows);
    }

    _eraseLine(mode) {
        const line = this.lines[this.row];
        if (!line) return;
        if (mode === 0) line.length = Math.min(line.length, this.col);          // cursor → end
        else if (mode === 1) { for (let k = 0; k <= this.col && k < line.length; k++) line[k] = blankCell(); }
        else if (mode === 2) line.length = 0;                                   // whole line
    }

    _eraseDisplay(mode) {
        if (mode === 2 || mode === 3) {
            // Clear the visible screen: blank the last screenRows lines and move
            // the cursor home (within the screen). Keeps earlier scrollback.
            const top = this._screenTop();
            for (let r = top; r < this.lines.length; r++) this.lines[r] = [];
            this.row = top;
            this.col = 0;
        } else if (mode === 0) {
            // cursor → end of display
            const line = this.lines[this.row];
            if (line) line.length = Math.min(line.length, this.col);
            this.lines.length = this.row + 1;
        }
    }

    reset() {
        this.lines = [[]];
        this.row = 0; this.col = 0;
        this.style = newStyle();
        this._sig = '';
    }

    _styleFor(sig) { return this._styleTable[sig] || null; }

    /** Render the buffer to a sanitized HTML string (spans grouped by style). */
    toHtml() {
        let out = '';
        for (let r = 0; r < this.lines.length; r++) {
            const line = this.lines[r];
            let curSig = null, open = false, curStyle = null, run = '';
            const flush = () => {
                if (!run) return;
                out += escHtml(run);
                run = '';
            };
            const closeTag = () => { if (open) { out += curStyle && curStyle.link ? '</a>' : '</span>'; open = false; } };
            for (let cIdx = 0; cIdx < line.length; cIdx++) {
                const cell = line[cIdx] || blankCell();
                if (cell.sig !== curSig) {
                    flush(); closeTag();
                    curSig = cell.sig; curStyle = this._styleFor(cell.sig);
                    const tag = curStyle ? spanFor(curStyle) : null;
                    if (tag) { out += tag; open = true; }
                }
                run += cell.ch;
            }
            flush(); closeTag();
            if (r < this.lines.length - 1) out += '\n';
        }
        return out;
    }

    lineCount() { return this.lines.length; }
}

function newStyle() {
    return { bold: false, dim: false, italic: false, underline: false, reverse: false, fg: null, bg: null, link: null };
}
