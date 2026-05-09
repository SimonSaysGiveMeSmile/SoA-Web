/**
 * Bridge — thin WebSocket client that wraps the shared protocol.
 *
 * Auto-reconnect with exponential backoff capped at 10s, because a web terminal
 * should survive laptop sleep and flaky wifi without the user having to refresh.
 */

import { MSG, INPUT_KIND, frame, parse } from '/assets/protocol.js?v=8';

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
            this._emit('status', { state: 'open' });
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
            this._emit('status', { state: 'closed', code: ev.code });
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
