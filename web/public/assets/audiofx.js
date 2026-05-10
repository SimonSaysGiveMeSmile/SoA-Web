/**
 * AudioFX — classic SoA sound cues in the browser.
 *
 * Web Audio API under the hood. Each cue's WAV is decoded once into an
 * AudioBuffer; each play() spawns a fresh AudioBufferSourceNode wired to a
 * per-play GainNode + (optionally) a StereoPanner. Because the nodes are
 * independent, dozens of concurrent plays mix naturally — when multiple
 * terminals stream in parallel their stdout cues overlap like crossfire
 * instead of cutting each other off the way the old HTMLAudioElement pool
 * did.
 *
 * Everything stays silent until the user's first pointerdown / keydown so
 * Chromium's autoplay policy doesn't reject the theme sound. At that point
 * we resume() the AudioContext and arm playback.
 */

const CUES = {
    stdout:   { file: 'stdout.wav',   volume: 0.35, feedback: true,  jitter: true  },
    stdin:    { file: 'stdin.wav',    volume: 0.35, feedback: true,  jitter: true  },
    folder:   { file: 'folder.wav',   volume: 0.8 },
    granted:  { file: 'granted.wav',  volume: 0.8 },
    keyboard: { file: 'keyboard.wav', volume: 0.6, feedback: true,   jitter: true  },
    theme:    { file: 'theme.wav',    volume: 0.8 },
    expand:   { file: 'expand.wav',   volume: 0.7 },
    panels:   { file: 'panels.wav',   volume: 0.7 },
    scan:     { file: 'scan.wav',     volume: 0.5 },
    denied:   { file: 'denied.wav',   volume: 0.8 },
    info:     { file: 'info.wav',     volume: 0.8 },
    alarm:    { file: 'alarm.wav',    volume: 0.8 },
    error:    { file: 'error.wav',    volume: 0.8 },
};

// Safety net: a single cue firing faster than this is redundant noise,
// not crossfire. The Web Audio graph handles hundreds of voices, but the
// human ear can't resolve anything denser than ~40Hz anyway.
const MIN_GAP_MS = 18;

export class AudioFX {
    constructor({ enabled = true, volume = 1.0, feedbackEnabled = true, base = '/assets/audio/' } = {}) {
        this.enabled = enabled;
        this.feedbackEnabled = feedbackEnabled;
        this.masterVolume = volume;
        this.base = base;

        this._buffers = {};          // cue → AudioBuffer
        this._cfg = {};              // cue → CUES entry
        this._lastPlayAt = {};       // cue → audioCtx.currentTime of last voice
        this._armed = false;

        this._ctx = null;
        this._master = null;

        for (const [name, cfg] of Object.entries(CUES)) {
            this._cfg[name] = cfg;
            this._buffers[name] = null;
            this._lastPlayAt[name] = 0;
        }

        const arm = () => {
            this._arm();
            window.removeEventListener('pointerdown', arm, true);
            window.removeEventListener('keydown', arm, true);
        };
        window.addEventListener('pointerdown', arm, true);
        window.addEventListener('keydown', arm, true);
    }

    _arm() {
        if (this._armed) return;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            this._ctx = new Ctx();
            this._master = this._ctx.createGain();
            this._master.gain.value = this.masterVolume;
            this._master.connect(this._ctx.destination);
            this._armed = true;
            // User gesture already opened the context, but some browsers
            // leave it "suspended" until an explicit resume.
            if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
            // Fire and forget — plays that arrive before decode finishes
            // are silently dropped, which matches the old behavior.
            this._loadAll();
        } catch (_) { /* no web audio — stay silent */ }
    }

    async _loadAll() {
        const ctx = this._ctx;
        if (!ctx) return;
        const tasks = Object.entries(this._cfg).map(async ([name, cfg]) => {
            try {
                const res = await fetch(this.base + cfg.file, { cache: 'force-cache' });
                if (!res.ok) return;
                const bytes = await res.arrayBuffer();
                const buf = await new Promise((resolve, reject) => {
                    // Use the callback form for Safari compatibility — the
                    // promise form exists but older iOS still requires the
                    // two-arg version.
                    try {
                        const p = ctx.decodeAudioData(bytes, resolve, reject);
                        if (p && typeof p.then === 'function') p.then(resolve, reject);
                    } catch (e) { reject(e); }
                });
                this._buffers[name] = buf;
            } catch (_) { /* skip this cue */ }
        });
        await Promise.all(tasks);
    }

    setEnabled(on) { this.enabled = !!on; }
    setFeedbackEnabled(on) { this.feedbackEnabled = !!on; }

    setVolume(v) {
        this.masterVolume = Math.max(0, Math.min(1, v));
        if (this._master) {
            try { this._master.gain.value = this.masterVolume; } catch (_) {}
        }
    }

    play(cue) {
        if (!this.enabled || !this._armed) return false;
        const cfg = this._cfg[cue];
        if (!cfg) return false;
        if (cfg.feedback && !this.feedbackEnabled) return false;
        const buf = this._buffers[cue];
        if (!buf || !this._ctx) return false;

        const now = this._ctx.currentTime;
        if (now - (this._lastPlayAt[cue] || 0) < MIN_GAP_MS / 1000) return false;
        this._lastPlayAt[cue] = now;

        try {
            const src = this._ctx.createBufferSource();
            src.buffer = buf;

            // Each voice gets its own gain so we can enforce the cue's
            // per-cue volume without touching the master.
            const g = this._ctx.createGain();
            g.gain.value = cfg.volume;

            // Crossfire feel: nudge pitch + pan a little per voice so
            // overlapping stdout from two tabs doesn't comb-filter into
            // one flat tone. Only on jittered cues — UI sounds stay pure.
            if (cfg.jitter) {
                src.playbackRate.value = 0.96 + Math.random() * 0.08;
                const pan = this._ctx.createStereoPanner
                    ? this._ctx.createStereoPanner()
                    : null;
                if (pan) {
                    pan.pan.value = (Math.random() * 2 - 1) * 0.6;
                    src.connect(g).connect(pan).connect(this._master);
                } else {
                    src.connect(g).connect(this._master);
                }
            } else {
                src.connect(g).connect(this._master);
            }

            src.start(0);
            src.onended = () => {
                try { src.disconnect(); g.disconnect(); } catch (_) {}
            };
            return true;
        } catch (_) { return false; }
    }
}

export const CUE_NAMES = Object.keys(CUES);
