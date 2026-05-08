/**
 * SoA-Web wire protocol — ESM copy for the browser.
 *
 * Mirrors server/src/protocol.js. Kept in sync by `scripts/sync-protocol.js`
 * (runs on `npm run prebuild` and as a `postinstall` safety net). Edit the
 * server copy, then run `npm run sync:protocol`.
 */

export const PROTOCOL_VERSION = 1;

export const MSG = Object.freeze({
    HELLO:     'hello',
    SNAPSHOT:  'snapshot',
    TERM_DATA: 'term-data',
    TERM_EXIT: 'term-exit',
    NOTICE:    'notice',
    PONG:      'pong',
    BYE:       'bye',

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
    HOTKEY:        'hotkey',
    SHELL_COMMAND: 'shell-command',
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
