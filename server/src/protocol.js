/**
 * SoA-Web Protocol
 *
 * Wire format shared by the server and the browser client. Frames are JSON over
 * WebSocket with the shape:
 *
 *   { v: 1, t: <type>, d: <payload>, id?: <correlation id> }
 *
 * This file is copied to both the server and the browser bundle at boot so the
 * two sides never drift.
 */

const PROTOCOL_VERSION = 1;

const MSG = Object.freeze({
    HELLO:      'hello',
    SNAPSHOT:   'snapshot',
    TERM_DATA:  'term-data',
    TERM_EXIT:  'term-exit',
    NOTICE:     'notice',
    PONG:       'pong',
    BYE:        'bye',

    AUTH:       'auth',
    INPUT:      'input',
    PING:       'ping',
    REQUEST:    'request',
});

const INPUT_KIND = Object.freeze({
    TERM_KEYS:      'term-keys',
    TERM_RESIZE:    'term-resize',
    SWITCH_TAB:     'switch-tab',
    NEW_TAB:        'new-tab',
    CLOSE_TAB:      'close-tab',
    MOVE_TAB:       'move-tab',
    RENAME_TAB:     'rename-tab',
    RESTORE_TAB:    'restore-tab',
    HOTKEY:         'hotkey',
    SHELL_COMMAND:  'shell-command',
});

function frame(type, data, id) {
    const f = { v: PROTOCOL_VERSION, t: type, d: data == null ? {} : data };
    if (id) f.id = id;
    return JSON.stringify(f);
}

function parse(raw) {
    try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || typeof obj.t !== 'string') return null;
        if (obj.v && obj.v !== PROTOCOL_VERSION) return null;
        return obj;
    } catch (_) {
        return null;
    }
}

module.exports = { PROTOCOL_VERSION, MSG, INPUT_KIND, frame, parse };
