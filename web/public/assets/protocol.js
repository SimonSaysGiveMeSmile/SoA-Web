/**
 * SoA-Web wire protocol — ESM copy for the browser.
 *
 * Mirrors server/src/protocol.js. Sync is MANUAL — there is no generator (an
 * earlier version of this header promised a `scripts/sync-protocol.js` that
 * never existed, and the two copies had silently drifted apart by three message
 * types as a result). When you add a `t` value on the server, add it here in the
 * same commit, and to the mobile client's own `switch (msg.t)` in
 * web/public/m/app.js — that one is hand-written and ignores anything unlisted.
 */

export const PROTOCOL_VERSION = 1;

export const MSG = Object.freeze({
    HELLO:     'hello',
    REPLAY:    'replay',
    SNAPSHOT:  'snapshot',
    TERM_DATA: 'term-data',
    TERM_EXIT: 'term-exit',
    NOTICE:    'notice',
    PONG:      'pong',
    BYE:       'bye',
    TTS:       'tts',
    BROWSER_FRAME: 'browser-frame',
    MANAGER:   'manager',
    TAB_MEM:   'tab-mem',
    MEETING:   'meeting',

    AUTH:      'auth',
    INPUT:     'input',
    PING:      'ping',
    REQUEST:   'request',
});

export const INPUT_KIND = Object.freeze({
    TERM_KEYS:     'term-keys',
    TERM_RESIZE:   'term-resize',
    SWITCH_TAB:    'switch-tab',
    NEW_TAB:       'new-tab',
    CLOSE_TAB:     'close-tab',
    MOVE_TAB:      'move-tab',
    RENAME_TAB:    'rename-tab',
    RESTORE_TAB:   'restore-tab',
    HOTKEY:        'hotkey',
    SHELL_COMMAND: 'shell-command',
    SET_TITLE:     'set-title',
    CTX_REPORT:    'ctx-report',
    BROWSER_SUBSCRIBE:   'browser-subscribe',
    BROWSER_UNSUBSCRIBE: 'browser-unsubscribe',
    BROWSER_CLICK:       'browser-click',
    WINDOW_CONTROL:      'window-control',
});

export function frame(type, data, id) {
    const f = { v: PROTOCOL_VERSION, t: type, d: data == null ? {} : data };
    if (id) f.id = id;
    return JSON.stringify(f);
}

export function parse(raw) {
    try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || typeof obj.t !== 'string') return null;
        if (obj.v && obj.v !== PROTOCOL_VERSION) return null;
        return obj;
    } catch (_) {
        return null;
    }
}
