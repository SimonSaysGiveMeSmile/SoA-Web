/** One explicit microphone turn. Speech is a draft, never terminal controls. */
export class VoiceChat {
    constructor({ host = window, onDraft = () => {}, onState = () => {}, onError = () => {} } = {}) {
        Object.assign(this, { host, onDraft, onState, onError });
        this.rec = null;
    }
    get supported() { return !!(this.host.SpeechRecognition || this.host.webkitSpeechRecognition); }
    get active() { return !!this.rec; }
    start(draft = '') {
        if (this.rec) return;
        const SR = this.host.SpeechRecognition || this.host.webkitSpeechRecognition;
        if (!SR || this.host.isSecureContext === false) {
            this.onError('Voice input is unavailable here. Use your keyboard’s dictation microphone, or open the secure link in Safari or Chrome.');
            return;
        }
        this.host.speechSynthesis?.cancel();
        const rec = new SR();
        this.rec = rec;
        rec.lang = this.host.navigator?.language || 'en-US';
        rec.continuous = false;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        const prefix = draft.trim();
        let latest = '';
        rec.onstart = () => { if (this.rec === rec) this.onState('listening'); };
        rec.onresult = event => {
            if (this.rec !== rec) return;
            latest = Array.from(event.results, r => r[0]?.transcript || '').join(' ').trim();
            this.onDraft([prefix, latest].filter(Boolean).join(' '));
        };
        rec.onerror = event => {
            if (this.rec !== rec) return;
            const errors = {
                'not-allowed': 'Microphone access denied. Allow access in browser settings, or use keyboard dictation.',
                'service-not-allowed': 'Speech recognition is unavailable here. Try Safari or keyboard dictation.',
                'audio-capture': 'No microphone is available. Check your headset and try again.',
                'network': 'Speech recognition lost its connection. Your draft is kept; try again.',
                'no-speech': 'No speech detected. Tap Talk to try again.',
            };
            this.cancel();
            if (event.error !== 'aborted') this.onError(errors[event.error] || 'Voice input failed. Your draft is kept.');
        };
        rec.onend = () => {
            if (this.rec !== rec) return;
            this.rec = null;
            clearTimeout(this.timer);
            this.onState(latest ? 'review' : 'idle');
        };
        this.onState('starting');
        try {
            rec.start();
            this.timer = setTimeout(() => this.stop(), 45000);
        } catch (_) {
            this.cancel();
            this.onError('Could not start the microphone. Tap Talk again or use keyboard dictation.');
        }
    }
    stop() {
        const rec = this.rec;
        if (!rec) return;
        this.onState('finishing');
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.cancel(), 2000);
        try { rec.stop(); } catch (_) { this.cancel(); }
    }
    cancel() {
        const rec = this.rec;
        this.rec = null;
        clearTimeout(this.timer);
        if (rec) { try { rec.abort(); } catch (_) {} }
        this.onState('idle');
    }
}
