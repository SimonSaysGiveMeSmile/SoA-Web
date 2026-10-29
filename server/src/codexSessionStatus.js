'use strict';
// Read the already-running official control socket. Never start/resume a thread.
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

class CodexSessionStatus {
    constructor({ socket, timeout = 5000 } = {}) {
        this.socket = socket || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
            'app-server-control/app-server-control.sock');
        this.timeout = timeout;
        this.pending = new Map();
        this.sequence = 0;
        this.connection = null;
    }
    connect() {
        if (this.connection) return this.connection;
        this.connection = new Promise((resolve, reject) => {
            const ws = this.ws = new WebSocket('ws+unix://' + this.socket + ':');
            const fail = error => {
                clearTimeout(timer);
                reject(error);
                // A closing socket must not invalidate a newer connection.
                if (this.ws !== ws) return;
                this.ws = null;
                this.connection = null;
                for (const request of this.pending.values()) {
                    clearTimeout(request.timer);
                    request.reject(error);
                }
                this.pending.clear();
            };
            const timer = setTimeout(() => {
                fail(new Error('Codex metadata connection timed out'));
                ws.terminate();
            }, this.timeout);
            timer.unref?.();
            this.disconnect = fail;
            ws.on('error', fail);
            ws.on('close', () => fail(new Error('Codex metadata connection closed')));
            ws.on('message', raw => {
                if (this.ws !== ws) return;
                let message;
                try { message = JSON.parse(raw); } catch (_) { return; }
                const request = this.pending.get(message.id);
                if (!request) return;
                this.pending.delete(message.id);
                clearTimeout(request.timer);
                if (message.error) request.reject(new Error(message.error.message));
                else request.resolve(message.result);
            });
            ws.once('open', async () => {
                if (this.ws !== ws) return ws.close();
                try {
                    await this.request('initialize', {
                        clientInfo: { name: 'soa_session_status', title: 'Son of Anton session status', version: '1' },
                        capabilities: { experimentalApi: true },
                    });
                    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
                    clearTimeout(timer);
                    resolve(this);
                } catch (error) { fail(error); ws.close(); }
            });
        });
        return this.connection;
    }
    request(method, params) {
        return new Promise((resolve, reject) => {
            if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('Codex metadata unavailable'));
            const id = ++this.sequence;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('Codex metadata request timed out'));
            }, this.timeout);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, timer });
            this.ws.send(JSON.stringify({ id, method, params }), error => {
                if (!error) return;
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            });
        });
    }
    async read(threadId) {
        await this.connect();
        const { thread } = await this.request('thread/read', { threadId, includeTurns: false });
        if (!thread || thread.id !== threadId) throw new Error('Codex returned a different thread');
        return thread;
    }
    close() {
        const ws = this.ws;
        this.disconnect?.(new Error('Codex metadata client closed'));
        ws?.close();
    }
}
module.exports = { CodexSessionStatus };
