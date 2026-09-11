/**
 * Bridge — thin WebSocket client that wraps the shared protocol.
 *
 * Auto-reconnect with exponential backoff capped at 10s, because a web terminal
 * should survive laptop sleep and flaky wifi without the user having to refresh.
 */

import { MSG, INPUT_KIND, frame, parse } from '/assets/protocol.js?v=19';

export class Bridge extends EventTarget {
    constructor({ url }) {
        super();
        this.url = url;
        this.ws = null;
        this.backoff = 500;
        this.closed = false;
        this._ping = null;
    }

    connect() {
        this.closed = false;
        this._open();
    }

    close() {
        this.closed = true;
        this._clearPing();
        if (this.ws) { try { this.ws.close(1000, 'client-close'); } catch (_) {} this.ws = null; }
    }

    send(type, data, id) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        try { this.ws.send(frame(type, data, id)); return true; } catch (_) { return false; }
    }

    input(kind, extra = {}) {
        return this.send(MSG.INPUT, { kind, ...extra });
    }

    _open() {
        this._clearPing();
        this._emit('status', { state: 'connecting' });
        const ws = new WebSocket(this.url);
        this.ws = ws;

        ws.addEventListener('open', () => {
            this.backoff = 500;
            this.attempts = 0;
            this._emit('status', { state: 'open' });
            // Tell the daemon what this socket can decode, before anything else
            // goes out. Without it we keep getting one frame per chunk per tab,
            // which is correct but is the cost that scales with agent count.
            this.input(INPUT_KIND.CLIENT_CAPS, { caps: { termBatch: true } });
            this._ping = setInterval(() => this.send(MSG.PING, { ts: Date.now() }), 20_000);
        });

        ws.addEventListener('message', ev => {
            const msg = parse(ev.data);
            if (!msg) return;
            this._emit(msg.t, msg.d || {});
        });

        ws.addEventListener('close', ev => {
            this._clearPing();
            this.ws = null;
            // Report the retry we are about to make, not just the failure. A UI
            // that can say "attempt 3, next try in 4s" turns a silent outage
            // into something visibly still working on your behalf.
            const willRetry = !this.closed && ev.code !== 1008 && ev.code !== 4401;
            this.attempts = (this.attempts || 0) + 1;
            this._emit('status', {
                state: 'closed', code: ev.code,
                attempt: this.attempts,
                retryIn: willRetry ? this.backoff : null,
            });
            if (this.closed) return;
            if (ev.code === 1008 || ev.code === 4401) {
                // 1008 = policy violation / 4401 = our custom "relogin please"
                this._emit('unauthorized', {});
                return;
            }
            setTimeout(() => this._open(), this.backoff);
            this.backoff = Math.min(this.backoff * 2, 10_000);
        });

        ws.addEventListener('error', () => { /* close will follow */ });
    }

    _clearPing() {
        if (this._ping) { clearInterval(this._ping); this._ping = null; }
    }

    _emit(name, detail) {
        this.dispatchEvent(new CustomEvent(name, { detail }));
    }
}

export { MSG, INPUT_KIND };
