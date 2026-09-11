/**
 * termGeometry — one shared PTY, several viewers, ONE honest grid.
 *
 * A tab's PTY has exactly one size, but any number of browsers can be looking
 * at it. The old rule was "resize the PTY to the LARGEST size any live client
 * wants", so a wide window could never be clipped by a narrow one. It has a
 * failure mode that is far worse than the gutter it was avoiding:
 *
 *   the PTY is told it has 134 columns, the viewer's xterm has 115, so every
 *   line the agent draws is ~19 characters too long. xterm soft-wraps it, and
 *   that 19-character tail lands in the LEFT-HAND columns of the next row —
 *   on top of the text already there. The screen fills with ragged fragments
 *   down the left edge and the reading order is destroyed.
 *
 * A terminal emulator cannot show more columns than it has. Every multiplexer
 * that has ever solved this (screen, tmux) solved it the same way: the SMALLEST
 * attached viewer defines the grid. A viewer wider than the grid gets unused
 * space on the right, which is cosmetic and self-explanatory; a viewer narrower
 * than the grid gets corruption, which is neither.
 *
 * So: the agreed size is the per-axis MINIMUM over the viewports that live
 * clients have actually declared. Only the desktop client declares one (the
 * mobile client is a passive viewer — it adopts the server's `cols` and shrinks
 * its own font to fit), so attaching a phone never narrows the desktop.
 *
 * Two rules keep it from going stale, which was the other half of the bug:
 *
 *   - a viewport belongs to the SOCKET, not to a tab. Every tab in a session
 *     shares one terminal area on screen, so one measurement describes them all
 *     and a tab you have never visited is still sized correctly.
 *   - when a socket goes away its viewport goes with it. The old code recorded
 *     per-tab sizes and only ever recomputed on an inbound resize, so a window
 *     that had since been closed went on pinning the PTY wide forever.
 */

const MIN_COLS = 2;
const MIN_ROWS = 2;

/** Normalise a client-declared viewport, or null if it isn't usable. */
function normalizeViewport(cols, rows) {
    const c = Math.trunc(Number(cols));
    const r = Math.trunc(Number(rows));
    if (!Number.isFinite(c) || !Number.isFinite(r)) return null;
    if (c < MIN_COLS || r < MIN_ROWS) return null;
    return { cols: c, rows: r };
}

/**
 * The viewports of every socket that is still open and has declared one.
 * `sockets` is any iterable of ws-like objects carrying `_viewport`.
 */
function liveViewports(sockets) {
    const out = [];
    for (const ws of sockets || []) {
        if (!ws || ws.readyState !== 1 /* OPEN */) continue;
        const vp = ws._viewport;
        if (!vp) continue;
        const norm = normalizeViewport(vp.cols, vp.rows);
        if (norm) out.push(norm);
    }
    return out;
}

/**
 * The grid every attached viewer can render without wrapping: the per-axis
 * minimum. Returns null when nobody has declared anything, which means "leave
 * the PTY exactly as it is" — never "fall back to a default", because guessing
 * here is how a tab ends up at the 120x32 spawn size while you look at it.
 */
function agreedSize(viewports) {
    let cols = 0, rows = 0;
    for (const vp of viewports) {
        cols = cols ? Math.min(cols, vp.cols) : vp.cols;
        rows = rows ? Math.min(rows, vp.rows) : vp.rows;
    }
    if (!cols || !rows) return null;
    return { cols, rows };
}

module.exports = { MIN_COLS, MIN_ROWS, normalizeViewport, liveViewports, agreedSize };
