/** Read-only xterm parser with a touch-friendly HTML surface. */
import { Terminal } from './vendor/xterm-headless.mjs';
import { escHtml, spanFor, palette256 } from './ansi.js';

export class TermBuffer {
    constructor({ rows = 24, cols = 80, maxRows = 1200, onChange = () => {} } = {}) {
        this.term = new Terminal({ rows, cols, scrollback: maxRows, allowProposedApi: true });
        this.onChange = onChange;
        this._disposed = false;
        this._sync = false;
        // DEC synchronized output: publish the completed repaint, or release
        // after a bounded wait if a broken stream omits its closing marker.
        for (const final of ['h', 'l']) this.term.parser.registerCsiHandler(
            { prefix: '?', final }, params => {
                if (!params.includes(2026)) return false;
                this._sync = final === 'h';
                clearTimeout(this._syncTimer);
                if (this._sync) this._syncTimer = setTimeout(() => {
                    this._sync = false;
                    if (!this._disposed) this.onChange();
                }, 1000);
                return false;
            });
    }

    setSize(cols, rows) {
        cols = Number(cols) > 0 ? Number(cols) : this.term.cols;
        rows = Number(rows) > 0 ? Number(rows) : this.term.rows;
        if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
    }
    setRows(rows) { this.setSize(null, rows); }
    write(text, done) {
        if (this._disposed) return;
        this.term.write(text, () => {
            if (this._disposed) return;
            if (!this._sync) this.onChange();
            if (done) done();
        });
    }
    reset() {
        clearTimeout(this._syncTimer);
        this._sync = false;
        // Ordered behind writes already accepted by the asynchronous parser.
        this.write('\x18\x1bc');
    }
    dispose() {
        this._disposed = true;
        clearTimeout(this._syncTimer);
        this.term.dispose();
    }
    lineCount() { return this.term.buffer.active.length; }
    recentText(n = 40) {
        const b = this.term.buffer.active, out = [];
        for (let i = Math.max(0, b.length - n); i < b.length; i++)
            out.push(b.getLine(i)?.translateToString(true) || '');
        return out.join('\n');
    }
    tailText(n = 4) { return this.recentText(this.lineCount()).split('\n').filter(s => s.trim()).slice(-n).join('\n'); }
    previewLines(n = 3) {
        return this.recentText(this.lineCount()).split('\n')
            .map(s => s.replace(/[─-▟⠀-⣿■-◿]/g, ' ').replace(/\s+/g, ' ').trim())
            .filter(s => s.length > 1 && /[\p{L}\p{N}]/u.test(s)).slice(-n).join('\n');
    }
    toHtml() {
        const b = this.term.buffer.active, out = [];
        const color = (cell, fg) => {
            const n = fg ? cell.getFgColor() : cell.getBgColor();
            if (fg ? cell.isFgRGB() : cell.isBgRGB()) return '#' + n.toString(16).padStart(6, '0');
            if (fg ? cell.isFgPalette() : cell.isBgPalette()) return palette256(n);
            return null;
        };
        for (let r = 0; r < b.length; r++) {
            const line = b.getLine(r);
            let html = '', run = '', signature = '', tag = null;
            const flush = () => { if (run) html += (tag || '') + escHtml(run) + (tag ? '</span>' : ''); run = ''; };
            for (let c = 0; line && c < line.length; c++) {
                const cell = line.getCell(c);
                if (!cell || cell.getWidth() === 0) continue;
                const style = { bold: cell.isBold(), dim: cell.isDim(), italic: cell.isItalic(),
                    underline: cell.isUnderline(), reverse: cell.isInverse(),
                    fg: color(cell, true), bg: color(cell, false) };
                const next = spanFor(style);
                if (next !== signature) { flush(); signature = tag = next; }
                run += cell.isInvisible() ? ' ' : cell.getChars() || ' ';
            }
            flush();
            out.push(html);
        }
        return out.join('\n');
    }
}
