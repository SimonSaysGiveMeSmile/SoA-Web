/**
 * VirtualKeyboard — OS-native input with a slim modifier strip.
 *
 * The hidden input is actually visible as a compose preview so the user
 * can see what they've typed before sending. Each edit (add/remove/
 * autocorrect replace) is diffed against the previous value and the delta
 * is synchronized to the remote shell as term-keys. Hitting Enter sends
 * the newline hotkey and clears the preview.
 */

const MOD_KEYS = [
    { label: 'esc',   kind: 'hotkey', combo: 'esc' },
    { label: 'tab',   kind: 'hotkey', combo: 'tab' },
    { label: 'ctrl',  kind: 'sticky-ctrl' },
    { label: '⌫',     kind: 'special', text: '\x7f' },
    { label: '◀',     kind: 'hotkey', combo: 'left',  css: 'k-arrow' },
    { label: '▼',     kind: 'hotkey', combo: 'down',  css: 'k-arrow' },
    { label: '▲',     kind: 'hotkey', combo: 'up',    css: 'k-arrow' },
    { label: '▶',     kind: 'hotkey', combo: 'right', css: 'k-arrow' },
    { label: '↵',     kind: 'hotkey', combo: 'enter', css: 'k-enter' },
];

export class VirtualKeyboard {
    constructor(rootEl, { onInput }) {
        this.root = rootEl;
        this.onInput = onInput;
        this.ctrl = false;
        this._lastValue = '';

        this._render();
    }

    _render() {
        this.root.innerHTML = '';
        this.root.className = 'kbd-strip';

        this.input = document.createElement('input');
        this.input.type = 'text';
        this.input.className = 'kbd-hidden-input';
        this.input.autocomplete = 'on';
        this.input.autocapitalize = 'sentences';
        this.input.autocorrect = 'on';
        this.input.spellcheck = true;
        this.input.placeholder = 'Type here…';
        this.input.setAttribute('enterkeyhint', 'send');
        this.root.appendChild(this.input);

        this.input.addEventListener('input', () => this._onInputEvent());

        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._flushPendingAndClear();
                this.onInput('hotkey', { combo: 'enter' });
            }
        });

        const strip = document.createElement('div');
        strip.className = 'kbd-mods';
        for (const m of MOD_KEYS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'k k-mod';
            if (m.css) btn.classList.add(m.css);
            btn.textContent = m.label;
            btn.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                this._handleMod(m, btn);
            });
            strip.appendChild(btn);
        }
        this.root.appendChild(strip);
    }

    _onInputEvent() {
        const cur = this.input.value;
        const prev = this._lastValue;
        if (cur === prev) return;

        // Find common prefix
        let i = 0;
        const minLen = Math.min(cur.length, prev.length);
        while (i < minLen && cur.charCodeAt(i) === prev.charCodeAt(i)) i++;

        const toDelete = prev.length - i;
        const toInsert = cur.slice(i);

        // Delete backwards first
        for (let n = 0; n < toDelete; n++) {
            this.onInput('term-keys', { text: '\x7f' });
        }
        // Then insert new text (handling ctrl-prefix for single chars)
        if (toInsert) {
            if (this.ctrl && toInsert.length === 1) {
                const lower = toInsert.toLowerCase();
                if (lower >= 'a' && lower <= 'z') {
                    this.onInput('term-keys', { text: String.fromCharCode(lower.charCodeAt(0) - 96) });
                } else {
                    this.onInput('term-keys', { text: toInsert });
                }
                this._setCtrl(false);
            } else {
                this.onInput('term-keys', { text: toInsert });
            }
        }

        this._lastValue = cur;
    }

    _flushPendingAndClear() {
        this.input.value = '';
        this._lastValue = '';
    }

    _handleMod(m, el) {
        el.classList.add('pressed');
        setTimeout(() => el.classList.remove('pressed'), 80);
        switch (m.kind) {
            case 'sticky-ctrl':
                this._setCtrl(!this.ctrl);
                break;
            case 'hotkey':
                if (m.combo === 'enter') {
                    this._flushPendingAndClear();
                }
                if (this.ctrl && m.combo && /^[a-z]$/.test(m.combo)) {
                    this.onInput('hotkey', { combo: `ctrl+${m.combo}` });
                    this._setCtrl(false);
                } else {
                    this.onInput('hotkey', { combo: m.combo });
                }
                break;
            case 'special':
                // Handle local backspace — trim the preview too
                if (m.text === '\x7f' && this._lastValue.length > 0) {
                    this._lastValue = this._lastValue.slice(0, -1);
                    this.input.value = this._lastValue;
                }
                this.onInput('term-keys', { text: m.text });
                break;
        }
    }

    _setCtrl(on) {
        this.ctrl = on;
        this.root.querySelectorAll('.k.k-mod').forEach(b => {
            if (b.textContent === 'ctrl') b.classList.toggle('active', on);
        });
    }

    focus() {
        if (this.input) this.input.focus();
    }

    blur() {
        if (this.input) this.input.blur();
    }

    show() { this.root.classList.remove('hidden'); }
    hide() { this.root.classList.add('hidden'); }
}
