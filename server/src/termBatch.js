/**
 * termBatch — one WebSocket frame per tick, not one per PTY read.
 *
 * Every chunk a tab produced used to become its own frame: JSON.stringify on
 * the server, a `message` event and a JSON.parse in the browser, then the
 * detector pass and the replay append. That is a fixed per-message cost paid
 * once per chunk per tab, and node-pty emits small chunks very often — so the
 * work the client does scales with (number of agents x their chunk rate) even
 * though 21 of 22 terminals are not on screen and will never be painted.
 *
 * The bytes were never the problem; the message count was. So hold whatever
 * arrives during one short window and send it as a single TERM_BATCH frame
 * carrying every tab's slice. The client then pays ONE parse for the whole
 * fleet's output per tick instead of one per chunk, and the cost stops scaling
 * with the number of running agents.
 *
 * JSON escaping is the tax that rides along with it: terminal output is mostly
 * escape sequences, and every ESC costs six characters on the wire. Batching
 * does not remove that, but it stops re-paying the envelope, the send, and the
 * parse for each fragment.
 *
 * Latency is spent where it is visible and saved where it is not. The tab on
 * screen flushes on a one-frame window (12ms, SOA_TERM_BATCH_MS) — less than
 * the requestAnimationFrame the client already coalesces its xterm writes to.
 * Every other tab is not being painted at all: nothing renders its bytes until
 * you switch to it, so it waits for a much longer window (100ms,
 * SOA_TERM_BATCH_BG_MS) and collapses far harder. With one agent on screen and
 * twenty-one behind it, almost all of the traffic is on the slow path.
 *
 * Set either to 0 to flush on the next tick instead, which still merges
 * everything node delivered in the same poll phase.
 *
 * ECHO is the exception to all of it. For 300ms after a key reaches a tab
 * (SOA_TERM_ECHO_MS), that tab's output is the characters appearing under
 * somebody's cursor, and a 12ms hold on a keystroke is felt in a way that a
 * 12ms hold on a stream never is — so during that window the active tab flushes
 * on the next tick. Typing is bounded by how fast a person types, so this costs
 * a handful of extra frames per second and nothing else.
 *
 * Compatibility is per socket, never global: a client opts in by sending
 * INPUT_KIND.CLIENT_CAPS with `{termBatch:true}`. Anything that has not opted
 * in — a tab still running the previous bundle, the read-only share viewers —
 * keeps receiving one TERM_DATA frame per chunk exactly as before.
 */

const { MSG, frame } = require('./protocol');

const envMs = (name, fallback) => {
    const raw = parseInt(process.env[name] || '', 10);
    return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 2000) : fallback;
};
const BATCH_MS = envMs('SOA_TERM_BATCH_MS', 12);
const BATCH_BG_MS = envMs('SOA_TERM_BATCH_BG_MS', 100);
// How long after a keystroke a tab's output is treated as echo and flushed on
// the next tick instead of waiting out the batching window.
const ECHO_WINDOW_MS = envMs('SOA_TERM_ECHO_MS', 300);

class TermBatcher {
    /**
     * @param {object} opts
     * @param {() => Iterable} opts.sockets                             live session sockets
     * @param {(tabId:number, frameStr:string) => void} [opts.onShare]  read-only viewers
     * @param {() => number} [opts.activeTab]   the tab currently on screen
     * @param {number} [opts.delayMs]           window for the tab on screen
     * @param {number} [opts.bgDelayMs]         window for everything else
     * @param {() => number} [opts.now]
     */
    constructor({ sockets, onShare, activeTab, delayMs = BATCH_MS, bgDelayMs = BATCH_BG_MS, now }) {
        this._sockets = sockets;
        this._onShare = onShare || null;
        this._activeTab = activeTab || (() => null);
        this._delayMs = delayMs;
        this._bgDelayMs = Math.max(bgDelayMs, delayMs);
        this._now = now || (() => Date.now());
        this._pending = new Map();   // tabId -> string[]
        this._timer = null;
        this._immediate = null;
        this._lastBgFlush = 0;
        this._typedAt = new Map();   // tabId -> when that tab last received input
    }

    /**
     * Somebody typed into this tab. For a short window after that, its output is
     * ECHO — the characters appearing under the cursor of whoever is watching —
     * and holding echo for a batching window is the one delay in this file that
     * is felt directly. 12ms is nothing against a stream and everything against
     * a keystroke, so during the window the tab flushes on the next tick.
     */
    noteInput(tabId) {
        if (tabId != null) this._typedAt.set(tabId, this._now());
        // The map only ever holds tabs someone is typing in; still, don't let a
        // long-lived session accumulate an entry per tab that ever saw a key.
        if (this._typedAt.size > 64) {
            const cutoff = this._now() - ECHO_WINDOW_MS;
            for (const [id, at] of this._typedAt) if (at < cutoff) this._typedAt.delete(id);
        }
    }

    _isEcho(tabId) {
        const at = this._typedAt.get(tabId);
        return at != null && (this._now() - at) < ECHO_WINDOW_MS;
    }

    /** Queue one tab's output. Ordering within a tab is preserved. */
    push(tabId, data) {
        if (!data) return;
        const q = this._pending.get(tabId);
        if (q) q.push(data);
        else this._pending.set(tabId, [data]);
        if (tabId === this._activeTab()) this._arm(this._isEcho(tabId) ? 0 : this._delayMs);
        else this._arm(this._bgDelayMs);
    }

    // Wake no later than the soonest thing waiting needs. A background chunk
    // arriving behind an active one must not push the active one's flush out.
    _arm(delayMs) {
        if (this._immediate) return;
        if (this._timer) {
            if (this._timerAt <= this._now() + delayMs) return;
            clearTimeout(this._timer);
            this._timer = null;
        }
        if (delayMs > 0) {
            this._timerAt = this._now() + delayMs;
            this._timer = setTimeout(() => this.flush(), delayMs);
            if (this._timer.unref) this._timer.unref();
        } else {
            this._immediate = setImmediate(() => this.flush());
        }
    }

    /**
     * Send what is due. The tab on screen goes every tick; the rest ride along
     * only once their own, much longer window has elapsed — nothing is painting
     * them, so holding them is free, and it is where nearly all of the traffic
     * is when one agent is visible and twenty-one are not.
     */
    flush() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (this._immediate) { clearImmediate(this._immediate); this._immediate = null; }
        if (!this._pending.size) return;

        const now = this._now();
        const active = this._activeTab();
        const bgDue = this._bgDelayMs <= this._delayMs || (now - this._lastBgFlush) >= this._bgDelayMs;
        if (bgDue) this._lastBgFlush = now;

        const items = [];
        for (const [id, chunks] of this._pending) {
            if (!bgDue && id !== active) continue;
            items.push({ id, data: chunks.length === 1 ? chunks[0] : chunks.join('') });
            this._pending.delete(id);
        }
        if (this._pending.size) this._arm(this._bgDelayMs - (now - this._lastBgFlush));
        if (!items.length) return;

        // Each wire form is built at most once, and only if somebody needs it.
        let batchAll = null;
        const perItem = new Map();
        const itemFrame = (it) => {
            let f = perItem.get(it);
            if (!f) { f = frame(MSG.TERM_DATA, { id: it.id, data: it.data }); perItem.set(it, f); }
            return f;
        };

        for (const ws of this._sockets() || []) {
            if (!ws || ws.readyState !== 1 /* OPEN */) continue;
            // A socket that has been promised a replay for a tab must not see
            // that tab's live bytes first — the replay carries them already.
            const held = ws._pendingReplayTabs;
            const mine = (held && held.size) ? items.filter(it => !held.has(it.id)) : items;
            if (!mine.length) continue;
            try {
                if (ws._caps && ws._caps.termBatch) {
                    const payload = mine === items
                        ? (batchAll || (batchAll = frame(MSG.TERM_BATCH, { items })))
                        : frame(MSG.TERM_BATCH, { items: mine });
                    ws.send(payload);
                } else {
                    for (const it of mine) ws.send(itemFrame(it));
                }
            } catch (_) { /* drop — the close handler cleans up */ }
        }

        if (this._onShare) {
            for (const it of items) {
                try { this._onShare(it.id, itemFrame(it)); } catch (_) {}
            }
        }
    }

    /** Flush everything, background included, and stop. */
    destroy() {
        this._lastBgFlush = 0;
        try { this.flush(); } catch (_) {}
        this._pending.clear();
    }
}

module.exports = { TermBatcher, BATCH_MS };
