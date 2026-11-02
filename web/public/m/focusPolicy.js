/**
 * focusPolicy — may this page move the caret into a text field on its own?
 *
 * On a desktop, focusing the terminal after a tab switch is what lets you keep
 * typing. On a phone or tablet the same call raises the on-screen keyboard and
 * covers half the screen, though all you did was look at another tab. Both
 * front ends (the dashboard and the /m/ companion) share this file, so the
 * answer is the same everywhere. It has no imports; the dashboard loads it as
 * /m/focusPolicy.js, the companion as ./focusPolicy.js.
 *
 * Only PROGRAMMATIC focus goes through maybeFocus(). A tap on a field is the
 * user asking for the keyboard, and the browser handles that without us.
 *
 * The setting (one key, shared by both front ends on this origin):
 *   auto   — allow on a fine pointer with hover; on a touch-first device only
 *            once a hardware keyboard has shown itself
 *   always — always allow
 *   tap    — never allow; the keyboard opens only when you tap a field
 *
 * "A hardware keyboard has shown itself" means either a caller reported one
 * through setHardwareKeyboardHint() or a key arrived that a touch keyboard
 * cannot send:
 * one typed while no text field had focus, or one with Ctrl/Alt/Cmd, Escape,
 * an arrow or a function key (not Tab: the iPad's on-screen keyboard has
 * one). That signal only loosens autofocus. It
 * never hides the touch keyboard, so a wrong guess costs a keyboard you can
 * dismiss, not one you cannot get back.
 */

const PREF_KEY = 'soa.keyboard.autofocus';
export const AUTOFOCUS_PREFS = Object.freeze(['auto', 'always', 'tap']);
const HW_WINDOW_MS = 10 * 60e3;   // a keyboard silent this long may have been put away
const HW_ONLY_KEY = /^(Escape|Arrow(Up|Down|Left|Right)|F\d{1,2}|Home|End|PageUp|PageDown|Insert|Meta|Control|Alt|OS)$/;
const EDITABLE = 'input:not([type="file"]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, select, [contenteditable=""], [contenteditable="true"]';

const listeners = new Set();
let lastHwKey = 0;
let hwHint = null;          // true / false from KeyboardMode, null = no opinion
let lastAllowed = null;

function mq(q) {
    try { return window.matchMedia(q); } catch (_) { return null; }
}
const fineMq = mq('(pointer: fine) and (hover: hover)');
const touchMq = mq('(pointer: coarse) and (hover: none)');

export function isEditable(el) {
    try { return !!(el && el.matches && el.matches(EDITABLE)); } catch (_) { return false; }
}

// The same test as isPhone() in assets/app.js, except that a fine pointer with
// hover wins first: an iPad with a trackpad attached reports exactly that, and
// it is being used like a laptop.
export function isTouchPrimary() {
    try {
        if (fineMq && fineMq.matches) return false;
        if (touchMq && touchMq.matches) return true;
        return /Mac/.test(navigator.platform || '') && navigator.maxTouchPoints > 1;
    } catch (_) { return false; }
}

export function hardwareKeyboardLikely() {
    if (hwHint === true) return true;
    if (hwHint === false) return false;
    return lastHwKey > 0 && Date.now() - lastHwKey < HW_WINDOW_MS;
}

export function getAutoFocusPref() {
    try {
        const v = localStorage.getItem(PREF_KEY);
        if (AUTOFOCUS_PREFS.includes(v)) return v;
    } catch (_) {}
    return 'auto';
}

export function setAutoFocusPref(v) {
    if (!AUTOFOCUS_PREFS.includes(v)) v = 'auto';
    try {
        if (v === 'auto') localStorage.removeItem(PREF_KEY);
        else localStorage.setItem(PREF_KEY, v);
    } catch (_) {}
    notify(true);
    return v;
}

export function autoFocusAllowed() {
    const pref = getAutoFocusPref();
    if (pref === 'always') return true;
    if (pref === 'tap') return false;
    if (!isTouchPrimary()) return true;
    return hardwareKeyboardLikely();
}

// Focus el (an element, or anything with a focus() method such as a terminal
// runtime) only if the policy allows it. Under Auto, a field that already has
// the caret means the keyboard is already open, so passing the caret on (one
// terminal to the next, the terminal to the chat box) raises nothing new.
// Returns whether focus was moved.
export function maybeFocus(el, opts) {
    if (!el || typeof el.focus !== 'function') return false;
    let ok = autoFocusAllowed();
    if (!ok && getAutoFocusPref() === 'auto' && isEditable(document.activeElement)) ok = true;
    if (!ok) return false;
    try { el.focus(opts); } catch (_) { return false; }
    return true;
}

// For a caller that knows better than key sniffing (a native shell's report,
// a manual keyboard-mode toggle): true = hardware keyboard, false = touch,
// null = no opinion, fall back to the keys seen.
export function setHardwareKeyboardHint(v) {
    const next = v === true ? true : v === false ? false : null;
    if (hwHint === true && next !== true) lastHwKey = 0;   // unplugged: forget the old keypresses too
    hwHint = next;
    notify();
}

// Run fn whenever autoFocusAllowed() may have changed (setting, pointer,
// hardware keyboard). It receives the new answer. Returns an unsubscribe.
export function onAutoFocusChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function notify(force) {
    const now = autoFocusAllowed();
    if (!force && now === lastAllowed) return;
    lastAllowed = now;
    for (const fn of listeners) { try { fn(now); } catch (_) {} }
}

function onKey(e) {
    if (!e.isTrusted || e.isComposing || e.keyCode === 229) return;
    const hwOnly = HW_ONLY_KEY.test(e.key || '') || e.ctrlKey || e.metaKey || e.altKey;
    if (!hwOnly && isEditable(e.target)) return;   // could be the touch keyboard
    const first = !hardwareKeyboardLikely();
    lastHwKey = Date.now();
    if (first) notify();
}

try {
    document.addEventListener('keydown', onKey, true);
    for (const m of [fineMq, touchMq]) {
        if (m && m.addEventListener) m.addEventListener('change', () => notify());
    }
    window.addEventListener('storage', e => { if (e.key === PREF_KEY) notify(true); });
    lastAllowed = autoFocusAllowed();
} catch (_) {}
