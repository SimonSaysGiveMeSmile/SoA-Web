/**
 * Dictation — speech typed into whatever text field has focus.
 *
 * Shared by the phone companion (m/app.js) and the desktop dashboard
 * (assets/widgets.js imports it from /m/, like qrscan.js). This file owns the
 * microphone, the recognizer and the typing; each host only draws a toggle
 * and a status light, and says where the terminal is.
 *
 * Engines, best first:
 *
 *   1. MAC WHISPER. soa-dictate on the Mac, reached
 *      through the daemon's /preview/6082/ proxy: GET /token mints a socket
 *      token, the socket takes PCM16 16 kHz mono and answers with finals. The
 *      audio stays on the user's own machines. A fresh token is fetched on
 *      every connect attempt; a dropped socket is retried 0.5 s → 8 s.
 *   2. ON-DEVICE browser recognition, when the browser can promise it
 *      (SpeechRecognition.available({processLocally}) says 'available').
 *   3. CLOUD browser recognition. Labelled "(cloud)" everywhere it shows,
 *      because here the audio leaves the device for the browser's service.
 *
 * Two rules the hosts rely on: a final is typed, never submitted (no Enter,
 * ever), and the microphone is released whenever dictation is off or the
 * page is hidden.
 */

const WHISPER_TIMEOUT_MS = 4000;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 8000;
const RETRY_BEFORE_FALLBACK = 3;   // failed reconnects before a browser engine takes over
const OUT_RATE = 16000;
const FRAME_SAMPLES = 640;         // 40 ms at 16 kHz → 1280-byte frames, far under 64 KB
const PRE_START_FRAMES = 50;       // ~2 s of audio kept while the socket is opening

export const ENGINE_LABEL = {
    whisper: 'Mac Whisper',
    local: 'On-device',
    cloud: 'Browser (cloud)',
};

// ── typing ─────────────────────────────────────────────────────────────

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'tel', '']);

/** A field speech may be typed into. Password fields are deliberately not. */
export function isEditable(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return TEXT_INPUTS.has((el.getAttribute('type') || '').toLowerCase());
    return !!el.isContentEditable;
}

const CJK = /[　-〿぀-ヿ㐀-鿿豈-﫿＀-￯]/;

// A space between two dictated phrases, unless one side is already a space,
// the new text opens with punctuation, or either side is CJK (no word gaps).
function needsSpace(prev, text) {
    if (!prev || /\s$/.test(prev)) return false;
    const first = text.charAt(0);
    if (/^[\s.,;:!?)\]}'"’”、。，！？]/.test(first)) return false;
    return !(CJK.test(prev.slice(-1)) || CJK.test(first));
}

function charBeforeCaret(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const at = el.selectionStart == null ? el.value.length : el.selectionStart;
        return el.value.slice(Math.max(0, at - 1), at);
    }
    const sel = el.ownerDocument.getSelection && el.ownerDocument.getSelection();
    const node = sel && sel.anchorNode;
    if (!node || node.nodeType !== 3) return '';
    return node.data.slice(Math.max(0, sel.anchorOffset - 1), sel.anchorOffset);
}

/**
 * Insert text at the caret of a focused field. execCommand('insertText') is
 * tried first because it is what a keyboard does: it fires real
 * beforeinput/input events (so the phone's compose box forwards the delta to
 * the terminal) and keeps undo. setRangeText + a synthetic input event is the
 * fallback for browsers that refuse it.
 */
export function typeInto(el, text) {
    const doc = el.ownerDocument;
    if (needsSpace(charBeforeCaret(el), text)) text = ' ' + text;
    let done = false;
    try { done = doc.execCommand('insertText', false, text); } catch (_) {}
    if (done) return text;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const s = el.selectionStart, e = el.selectionEnd;
        if (s == null) el.value += text;
        else el.setRangeText(text, s, e, 'end');
    } else {
        const sel = doc.getSelection();
        if (!sel || !sel.rangeCount) { el.append(text); }
        else {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            const node = doc.createTextNode(text);
            range.insertNode(node);
            range.setStartAfter(node);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        }
    }
    const IE = doc.defaultView.InputEvent || doc.defaultView.Event;
    el.dispatchEvent(new IE('input', { bubbles: true, inputType: 'insertText', data: text }));
    return text;
}

// ── microphone → PCM16 16 kHz ──────────────────────────────────────────

const WORKLET_SRC = `
class SoaDictateTap extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
    process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) for (let i = 0; i < ch.length; i++) {
            this.buf[this.n++] = ch[i];
            if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
        }
        return true;
    }
}
registerProcessor('soa-dictate-tap', SoaDictateTap);`;

/**
 * Box-filter downsampler: each output sample is the mean of the input
 * samples it covers, which is enough anti-aliasing for speech and keeps
 * state across chunks so frame edges don't click.
 */
export class Downsampler {
    constructor(inRate, outRate = OUT_RATE) {
        this.ratio = inRate / outRate;
        this.pos = 0; this.acc = 0; this.n = 0;
        this.out = new Int16Array(FRAME_SAMPLES); this.fill = 0;
    }
    push(f32, emit) {
        for (let i = 0; i < f32.length; i++) {
            this.acc += f32[i]; this.n++; this.pos += 1;
            if (this.pos < this.ratio) continue;
            this.pos -= this.ratio;
            const v = Math.max(-1, Math.min(1, this.acc / this.n));
            this.acc = 0; this.n = 0;
            this.out[this.fill++] = v < 0 ? v * 0x8000 : v * 0x7fff;
            if (this.fill === FRAME_SAMPLES) { emit(this.out); this.out = new Int16Array(FRAME_SAMPLES); this.fill = 0; }
        }
    }
}

class PcmCapture {
    constructor(host) { this.host = host; this.stream = null; this.ctx = null; this.node = null; }

    // The AudioContext is made before the permission await, inside the
    // user's gesture: iOS will not start one later.
    async start(onFrame) {
        const AC = this.host.AudioContext || this.host.webkitAudioContext;
        const md = this.host.navigator && this.host.navigator.mediaDevices;
        if (!AC || !md || !md.getUserMedia) throw Object.assign(new Error('This browser cannot record audio.'), { code: 'no_capture' });
        const ctx = new AC();
        this.ctx = ctx;
        try { const r = ctx.resume && ctx.resume(); if (r && r.catch) r.catch(() => {}); } catch (_) {}
        let stream;
        try {
            stream = await md.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        } catch (e) {
            this.stop();
            const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
            throw Object.assign(new Error(denied ? 'Microphone access denied. Allow it for this site, then try again.' : 'No microphone is available.'), { code: denied ? 'denied' : 'no_mic' });
        }
        if (this.ctx !== ctx) { stream.getTracks().forEach(t => t.stop()); throw Object.assign(new Error('stopped'), { code: 'stopped' }); }
        this.stream = stream;
        // Ask again now the mic is live: a context made outside a gesture (the
        // resume after the page was hidden) starts suspended on iOS, and an
        // active capture is what lets WebKit run it.
        if (ctx.state !== 'running') { try { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } catch (_) {} }
        const ds = new Downsampler(ctx.sampleRate);
        const src = ctx.createMediaStreamSource(stream);
        // A silent sink: some engines only pull nodes that reach the destination.
        const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
        let node = null;
        if (ctx.audioWorklet && this.host.AudioWorkletNode) {
            try {
                const url = this.host.URL.createObjectURL(new this.host.Blob([WORKLET_SRC], { type: 'application/javascript' }));
                await ctx.audioWorklet.addModule(url);
                this.host.URL.revokeObjectURL(url);
                node = new this.host.AudioWorkletNode(ctx, 'soa-dictate-tap');
                node.port.onmessage = ev => ds.push(ev.data, onFrame);
            } catch (_) { node = null; }
        }
        if (!node) {
            node = ctx.createScriptProcessor(4096, 1, 1);
            node.onaudioprocess = ev => ds.push(ev.inputBuffer.getChannelData(0), onFrame);
        }
        if (this.ctx !== ctx) { this.stop(); throw Object.assign(new Error('stopped'), { code: 'stopped' }); }
        src.connect(node); node.connect(sink);
        this.node = node;
    }

    stop() {
        const { stream, ctx, node } = this;
        this.stream = null; this.ctx = null; this.node = null;
        try { if (node) { node.disconnect(); if (node.port) node.port.onmessage = null; node.onaudioprocess = null; } } catch (_) {}
        try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (_) {}
        try { const r = ctx && ctx.close && ctx.close(); if (r && r.catch) r.catch(() => {}); } catch (_) {}
    }
}

// ── engine 1: Mac Whisper over /preview/6082 ───────────────────────────

class WhisperEngine {
    constructor(d) { this.d = d; this.ws = null; this.capture = null; this.queue = []; this.started = false; this.pending = 0; this.closed = false; }

    // Resolves once the socket says 'started'; rejects if the service cannot
    // be reached, so the caller can fall back to a browser engine.
    async open() {
        const d = this.d;
        const tokenUrl = d.whisperUrl('/token');
        if (!tokenUrl) throw new Error('no backend');
        const ac = new d.host.AbortController();
        const timer = setTimeout(() => ac.abort(), WHISPER_TIMEOUT_MS);
        // On a page served by another origin (the public site talking to a
        // paired daemon over its tunnel) the daemon answers with CORS for its
        // allowlisted origins. The header skips a tunnel's browser-warning
        // interstitial, which would otherwise answer without CORS; it costs one
        // preflight, which the daemon answers for those same origins.
        let cross = false;
        try { cross = new URL(tokenUrl, d.host.location.href).origin !== d.host.location.origin; } catch (_) {}
        let token;
        try {
            const r = await d.host.fetch(tokenUrl, { credentials: 'include', cache: 'no-store', signal: ac.signal,
                headers: cross ? { 'ngrok-skip-browser-warning': 'true' } : undefined });
            const j = r.ok ? await r.json().catch(() => null) : null;
            token = j && j.token;
        } finally { clearTimeout(timer); }
        if (!token) throw new Error('Mac Whisper is not reachable');
        if (this.closed) throw new Error('stopped');
        const u = new URL(d.whisperUrl('/ws'));
        u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
        u.searchParams.set('token', token);
        const ws = new d.host.WebSocket(u.toString());
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        await new Promise((resolve, reject) => {
            const fail = () => { clearTimeout(t); reject(new Error('Mac Whisper refused the connection')); };
            const t = setTimeout(() => { try { ws.close(); } catch (_) {} fail(); }, WHISPER_TIMEOUT_MS);
            ws.onerror = fail;
            ws.onclose = fail;
            ws.onmessage = ev => {
                const m = parse(ev.data);
                if (!m) return;
                const kind = m.t || m.type;
                if (kind === 'hello') ws.send(JSON.stringify({ t: 'start', lang: d.whisperLang, partials: true }));
                else if (kind === 'started') { clearTimeout(t); resolve(); }
                else if (kind === 'error' && m.code !== 'engine_unavailable') { clearTimeout(t); try { ws.close(); } catch (_) {} reject(new Error(m.message || m.code)); }
            };
        });
        if (this.closed) { try { ws.close(); } catch (_) {} throw new Error('stopped'); }
        this.started = true;
        ws.onmessage = ev => this._onMessage(ev.data);
        ws.onerror = null;
        ws.onclose = () => { if (this.ws === ws) this._lost(); };
        for (const f of this.queue) ws.send(f);
        this.queue = [];
        this._ping = setInterval(() => { try { ws.send(JSON.stringify({ t: 'ping', at: Date.now() })); } catch (_) {} }, 15000);
    }

    async start() {
        const d = this.d;
        // Mic first (inside the gesture), socket second; frames captured in
        // between are queued so the first words are not lost.
        this.capture = new PcmCapture(d.host);
        await this.capture.start(frame => this._frame(frame));
        try { await this.open(); }
        catch (e) { this.capture.stop(); this.capture = null; throw e; }
    }

    _frame(frame) {
        const buf = frame.buffer.byteLength === frame.byteLength ? frame.buffer : frame.slice().buffer;
        const ws = this.ws;
        if (this.started && ws && ws.readyState === 1) { ws.send(buf); return; }
        this.queue.push(buf);
        if (this.queue.length > PRE_START_FRAMES) this.queue.shift();
    }

    _onMessage(data) {
        const m = parse(data);
        if (!m) return;
        const d = this.d;
        // After stop() only finals still count: the last phrase is typed,
        // but the light and the notices belong to whatever runs next.
        if (this.closed && (m.t || m.type) !== 'final') return;
        switch (m.t || m.type) {
            case 'vad':
                if (m.speaking) d._set('listening', 'Hearing you…');
                else { this.pending++; d._set('transcribing'); }
                break;
            case 'partial':
                if (m.text) d._partial(m.text);
                break;
            case 'final':
                this.pending = Math.max(0, this.pending - 1);
                // skipped: 'too_short' | 'noise' — a segment that was never
                // decoded. Nothing is typed for it, not even a space.
                if (!m.skipped && m.text && m.text.trim()) d._final(m.text.trim());
                if (!this.pending && !this.closed) d._set('listening');
                break;
            case 'error':
                if (m.code === 'engine_unavailable') d._notice('The Mac recognizer is starting; your words are queued.');
                else if (m.code === 'overloaded') d._notice('Mac Whisper is busy; some audio was dropped.');
                else if (m.code === 'engine_error') d._notice('Mac Whisper could not read that phrase.');
                break;
            case 'stopped':
                try { this.ws && this.ws.close(); } catch (_) {}
                break;
        }
    }

    // The socket dropped mid-session: retry with a fresh token, backing off.
    // After a few failures a browser engine takes over so dictation keeps working.
    _lost() {
        clearInterval(this._ping);
        this.ws = null;
        this.started = false;
        if (this.closed) return;
        this.pending = 0;
        this._retries = (this._retries || 0) + 1;
        if (this._retries > RETRY_BEFORE_FALLBACK) { this.stop(); this.d._fallBack(); return; }
        const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * Math.pow(2, this._retries - 1));
        this.d._set('error', 'Reconnecting…');
        this._retry = setTimeout(() => {
            if (this.closed) return;
            this.open().then(() => { this._retries = 0; this.d._set('listening'); }, () => this._lost());
        }, delay);
    }

    stop() {
        this.closed = true;
        clearTimeout(this._retry);
        clearInterval(this._ping);
        if (this.capture) { this.capture.stop(); this.capture = null; }
        this.queue = [];
        const ws = this.ws;
        this.ws = null;
        if (!ws) return;
        // Ask for the open utterance to be finalised, and keep listening for
        // it briefly — the last thing said should still land.
        ws.onclose = null;
        ws.onmessage = ev => {
            const m = parse(ev.data);
            if (m && (m.t || m.type) === 'final') this._onMessage(ev.data);
            if (m && (m.t || m.type) === 'stopped') { try { ws.close(); } catch (_) {} }
        };
        try { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'stop' })); else ws.close(); } catch (_) {}
        setTimeout(() => { try { ws.close(); } catch (_) {} }, 3000);
    }
}

function parse(data) {
    if (typeof data !== 'string') return null;
    try { const m = JSON.parse(data); return m && typeof m === 'object' ? m : null; } catch (_) { return null; }
}

// ── engines 2 + 3: browser SpeechRecognition ───────────────────────────

class BrowserEngine {
    constructor(d, local) { this.d = d; this.local = local; this.rec = null; this.closed = false; this.errs = 0; }

    async start() {
        const SR = this.d.host.SpeechRecognition || this.d.host.webkitSpeechRecognition;
        this._SR = SR;
        this._run();
    }

    _run() {
        if (this.closed) return;
        const rec = new this._SR();
        this.rec = rec;
        rec.lang = this.d.browserLang;
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        if (this.local) { try { rec.processLocally = true; } catch (_) {} }
        rec.onresult = ev => {
            if (this.rec !== rec) return;
            this.errs = 0;
            for (let i = ev.resultIndex; i < ev.results.length; i++) {
                const text = (ev.results[i][0] && ev.results[i][0].transcript || '').trim();
                if (!text) continue;
                if (ev.results[i].isFinal) { this.d._final(text); this.d._set('listening'); }
                else { this.d._partial(text); this.d._set('transcribing'); }
            }
        };
        rec.onerror = ev => {
            if (this.rec !== rec) return;
            if (ev.error === 'no-speech' || ev.error === 'aborted') return;
            if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
                this.closed = true;
                this.d._fail('Microphone access denied. Allow it for this site, then try again.');
                return;
            }
            this.errs++;
        };
        // Recognition ends itself after silence; continuous dictation means
        // restarting, with a backoff so a broken mic does not spin.
        rec.onend = () => {
            if (this.rec !== rec || this.closed) return;
            if (this.errs >= 6) { this.closed = true; this.d._fail('Speech recognition keeps failing. Turn dictation off and on to retry.'); return; }
            const delay = this.errs ? Math.min(250 * Math.pow(2, this.errs), 8000) : 150;
            this._restart = setTimeout(() => this._run(), delay);
        };
        try { rec.start(); }
        catch (_) { this.closed = true; this.d._fail('Speech recognition could not start.'); }
    }

    stop() {
        this.closed = true;
        clearTimeout(this._restart);
        const rec = this.rec;
        this.rec = null;
        // stop(), not abort(): the phrase in flight still arrives as a final.
        if (rec) { try { rec.onend = null; rec.stop(); } catch (_) {} }
    }
}

/** 'local' when the browser can recognise this language on the device, else 'cloud' (or null). */
export async function browserEngineKind(host, lang) {
    const SR = host.SpeechRecognition || host.webkitSpeechRecognition;
    if (!SR) return null;
    if (typeof SR.available === 'function') {
        try {
            const a = await SR.available({ langs: [lang], processLocally: true });
            if (a === 'available') return 'local';
        } catch (_) {}
    }
    return 'cloud';
}

// ── the controller the hosts use ───────────────────────────────────────

export class Dictation {
    /**
     * @param {object} o
     * @param {function(string):(string|null)} o.whisperUrl  '/token' | '/ws' → absolute
     *        URL under the daemon's /preview/6082 (with its t/u), or null when
     *        there is no daemon to ask.
     * @param {function(Element):({key:*, write:function(string)}|null)} [o.terminalSink]
     *        the terminal behind the focused element, if it is one.
     * @param {function(object)} [o.onState]   {on, state, engine, label, detail}
     * @param {function(string)} [o.onNotice]  one-line messages worth showing.
     * @param {function(string, object)} [o.onTyped]
     */
    constructor({ host = window, whisperUrl = () => null, terminalSink = () => null,
                  whisperLang = 'auto', browserLang, onState = () => {}, onNotice = () => {}, onTyped = () => {} } = {}) {
        Object.assign(this, { host, whisperUrl, terminalSink, whisperLang, onState, onNotice, onTyped });
        this.browserLang = browserLang || (host.navigator && host.navigator.language) || 'en-US';
        this.on = false;
        this.state = 'idle';
        this.engine = null;
        this.detail = '';
        this._impl = null;
        this._gen = 0;
        this._lastTerm = null;
        this._onVis = ev => this._visibility(ev);
        host.document.addEventListener('visibilitychange', this._onVis);
        host.addEventListener('pagehide', this._onVis);
    }

    get label() {
        if (!this.on) return 'Off';
        if (this.engine) return ENGINE_LABEL[this.engine];
        return this.state === 'error' ? 'Unavailable' : 'Starting…';
    }

    toggle() { return this.on ? (this.stop(), false) : (this.start(), true); }

    /** Call from a user gesture: it opens the microphone. */
    async start() {
        if (this.on) return;
        this.on = true;
        this._set('listening', 'Starting…');
        await this._open(false);
    }

    stop() {
        this.on = false;
        this._paused = false;
        this._gen++;
        this._close();
        this.engine = null;
        this._set('idle');
    }

    destroy() {
        this.stop();
        this.host.document.removeEventListener('visibilitychange', this._onVis);
        this.host.removeEventListener('pagehide', this._onVis);
    }

    async _open(skipWhisper) {
        const gen = ++this._gen;
        this._close();
        if (!skipWhisper && this.whisperUrl('/token')) {
            const w = new WhisperEngine(this);
            this._impl = w;
            try {
                await w.start();
                if (gen !== this._gen) { w.stop(); return; }
                this.engine = 'whisper';
                this._set('listening');
                return;
            } catch (e) {
                if (gen !== this._gen) return;
                this._impl = null;
                if (e && (e.code === 'denied' || e.code === 'no_mic' || e.code === 'no_capture')) {
                    // A microphone problem is not a reason to try the cloud.
                    if (e.code !== 'no_capture') { this._fail(e.message); return; }
                }
            }
        }
        const kind = await browserEngineKind(this.host, this.browserLang);
        if (gen !== this._gen) return;
        if (!kind) { this._fail('No speech engine here: Mac Whisper is unreachable and this browser has no speech recognition.'); return; }
        const b = new BrowserEngine(this, kind === 'local');
        this._impl = b;
        this.engine = kind;
        await b.start();
        if (gen !== this._gen) { b.stop(); return; }
        if (b.closed) return;            // failed synchronously; _fail already reported it
        this._set('listening');
        this._notice(kind === 'cloud'
            ? 'Mac Whisper is unreachable — using the browser’s cloud recognition (audio leaves this device).'
            : 'Mac Whisper is unreachable — using on-device recognition.');
    }

    _fallBack() {
        if (!this.on) return;
        this._open(true);
    }

    _close() {
        const impl = this._impl;
        this._impl = null;
        if (impl) impl.stop();
    }

    // Hidden page → the mic is released; visible again → dictation resumes
    // on the same engine order.
    _visibility(ev) {
        if (!this.on) return;
        if (this.host.document.hidden || (ev && ev.type === 'pagehide')) {
            if (this._paused) return;
            this._gen++;
            this._close();
            this._paused = true;
            this._set('idle', 'Paused while the page is hidden');
        } else if (this._paused) {
            this._paused = false;
            this._set('listening', 'Starting…');
            this._open(false);
        }
    }

    // ── engine callbacks ───────────────────────────────────────────────
    _set(state, detail = '') {
        this.state = state;
        this.detail = detail;
        try { this.onState({ on: this.on, state, engine: this.engine, label: this.label, detail }); } catch (_) {}
    }

    _notice(text) { try { this.onNotice(text); } catch (_) {} }

    _partial(text) { if (this.on) this._set(this.state === 'error' ? 'listening' : this.state, '… ' + text); }

    _fail(message) {
        this._close();
        this.engine = null;
        this._set('error', message);
        this._notice(message);
    }

    _final(text) {
        const doc = this.host.document;
        const el = doc.activeElement;
        const sink = el && el !== doc.body ? this.terminalSink(el) : null;
        if (sink) {
            const last = this._lastTerm;
            const out = last && last.key === sink.key && needsSpace(last.tail, text) ? ' ' + text : text;
            sink.write(out);
            this._lastTerm = { key: sink.key, tail: out.slice(-1) };
            this.onTyped(out, { target: 'terminal' });
            return;
        }
        this._lastTerm = null;
        if (isEditable(el)) {
            const out = typeInto(el, text);
            this.onTyped(out, { target: 'field', el });
            return;
        }
        this._notice('Not typed — focus a text field first: “' + text + '”');
    }
}
