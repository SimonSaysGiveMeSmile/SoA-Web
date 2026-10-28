/**
 * PhoneSizeClaim — the phone sizes the terminal while you are typing on it.
 *
 * A tab has ONE PTY grid. The daemon sets it to the smallest viewport that a
 * visible client has declared (server/src/termGeometry.js). The companion used
 * to declare nothing: it adopted the desktop's `cols` and shrank its font to
 * fit, with a 12px readability floor. A ~95-column desktop grid on a ~50-column
 * phone therefore ran off the right edge. That is harmless for output you are
 * reading, and very visible for input you are writing. Dictate a long sentence
 * and Claude's prompt box wraps it at 95 columns, so the line keeps growing to
 * the right of the screen instead of moving down to a new line.
 *
 * The dashboard already settled this between desktops: the device you are USING
 * sizes the terminal, and a screen with no input for 90 s releases its claim
 * (VIEWER_IDLE_MS in assets/app.js). This is the same rule for the phone, with
 * one difference: a phone that is only watching never claims at all. It starts
 * claiming at the first keystroke or dictated word and stops when idle, so
 * leaving the companion open on a desk never narrows the Mac.
 *
 * Releasing is not "send nothing": the daemon keeps a socket's last viewport.
 * The phone re-declares the grid it saw before it claimed, marked hidden. A
 * hidden viewer has no vote while anyone is looking, and if nobody is looking
 * it restores the earlier width instead of pinning the phone's.
 *
 * Only the active tab is claimed, and the claim never widens a grid.
 */

export const VIEWER_IDLE_MS = 90 * 1000;
export const MIN_CLAIM_COLS = 20;

/** Columns of `fontPx` monospace text that fit in `availW` CSS pixels. */
export function colsThatFit(availW, charWPerPx, fontPx) {
    if (!(availW > 0) || !(charWPerPx > 0) || !(fontPx > 0)) return 0;
    return Math.max(MIN_CLAIM_COLS, Math.floor(availW / (charWPerPx * fontPx)));
}

export class PhoneSizeClaim {
    /**
     * @param {object} o
     * @param {(d: {id, cols, rows, hidden}) => void} o.send  one term-resize input
     * @param {() => number} [o.now]
     * @param {number} [o.idleMs]
     */
    constructor({ send, now = () => performance.now(), idleMs = VIEWER_IDLE_MS }) {
        this._send = send;
        this._now = now;
        this._idleMs = idleMs;
        this._lastInput = -Infinity;
        this._grids = new Map();    // tabId → the grid the server last reported
        this._before = new Map();   // tabId → the grid to hand back on release
        this._claimed = new Map();  // tabId → cols this phone declared
    }

    get claiming() { return this._claimed.size > 0; }

    /** The daemon reported a tab's grid (snapshot or term-size). */
    observe(id, cols, rows) {
        if (id == null || !(cols > 1) || !(rows > 1)) return;
        this._grids.set(id, { cols, rows });
        // While this phone holds the tab, the reported grid is (at most) ours.
        // Handing THAT back later would pin the phone's width on the desktop.
        if (!this._claimed.has(id)) this._before.set(id, { cols, rows });
    }

    /**
     * The user typed, dictated or sent something into tab `id`, on a screen
     * that has room for `cols` readable columns.
     * Returns true when a claim was sent.
     */
    activity(id, cols) {
        this._lastInput = this._now();
        if (id == null || !(cols >= MIN_CLAIM_COLS)) return false;
        const grid = this._grids.get(id);
        if (!grid) return false;
        if (this._claimed.get(id) === cols) return false;
        // Already narrow enough: claiming would change nothing for this phone,
        // and declaring would only add a viewer that can later narrow others.
        if (!this._claimed.has(id) && grid.cols <= cols) return false;
        this._claimed.set(id, cols);
        this._send({ id, cols, rows: grid.rows, hidden: false });
        return true;
    }

    /** Call periodically. Releases every claim once input has gone quiet. */
    tick() {
        if (this.claiming && this._now() - this._lastInput > this._idleMs) this.release();
    }

    /** Give the width back now (idle, page hidden, disconnect). */
    release() {
        for (const id of [...this._claimed.keys()]) {
            this._claimed.delete(id);
            const back = this._before.get(id) || this._grids.get(id);
            if (back) this._send({ id, cols: back.cols, rows: back.rows, hidden: true });
        }
    }

    /** Socket reconnected: the daemon forgot this viewport, so forget the claims too. */
    reset() {
        this._claimed.clear();
    }

    /** A tab closed. */
    forget(id) {
        this._grids.delete(id);
        this._before.delete(id);
        this._claimed.delete(id);
    }
}
