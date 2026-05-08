/**
 * AudioFX — classic SoA sound cues in the browser.
 *
 * The desktop app used Howler to juggle multiple simultaneous plays. In the
 * browser we pool a few HTMLAudioElement instances per cue so rapid triggers
 * (e.g. stdout on every chunk) don't block each other. Everything is muted
 * until the user's first interaction so Chromium's autoplay policy doesn't
 * swallow the theme sound.
 */

const CUES = {
    stdout:   { file: 'stdout.wav',   volume: 0.35, pool: 4 },
    stdin:    { file: 'stdin.wav',    volume: 0.35, pool: 3 },
    folder:   { file: 'folder.wav',   volume: 0.8,  pool: 2 },
    granted:  { file: 'granted.wav',  volume: 0.8,  pool: 2 },
    keyboard: { file: 'keyboard.wav', volume: 0.6,  pool: 3 },
    theme:    { file: 'theme.wav',    volume: 0.8,  pool: 1 },
    expand:   { file: 'expand.wav',   volume: 0.7,  pool: 2 },
    panels:   { file: 'panels.wav',   volume: 0.7,  pool: 3 },
    scan:     { file: 'scan.wav',     volume: 0.5,  pool: 1 },
    denied:   { file: 'denied.wav',   volume: 0.8,  pool: 2 },
    info:     { file: 'info.wav',     volume: 0.8,  pool: 2 },
    alarm:    { file: 'alarm.wav',    volume: 0.8,  pool: 1 },
    error:    { file: 'error.wav',    volume: 0.8,  pool: 2 },
};

export class AudioFX {
    constructor({ enabled = true, volume = 1.0, base = '/assets/audio/' } = {}) {
        this.enabled = enabled;
        this.masterVolume = volume;
        this.base = base;
        this._pools = {};
        this._armed = false;
        for (const [name, cfg] of Object.entries(CUES)) {
            const pool = [];
            for (let i = 0; i < cfg.pool; i++) {
                const a = new Audio(base + cfg.file);
                a.volume = cfg.volume * volume;
                a.preload = 'auto';
                pool.push({ el: a, volume: cfg.volume });
            }
            this._pools[name] = { pool, idx: 0 };
        }
        const arm = () => {
            this._armed = true;
            window.removeEventListener('pointerdown', arm, true);
            window.removeEventListener('keydown', arm, true);
        };
        window.addEventListener('pointerdown', arm, true);
        window.addEventListener('keydown', arm, true);
    }

    setEnabled(on) { this.enabled = !!on; }

    setVolume(v) {
        this.masterVolume = Math.max(0, Math.min(1, v));
        for (const { pool } of Object.values(this._pools)) {
            for (const entry of pool) entry.el.volume = entry.volume * this.masterVolume;
        }
    }

    play(cue) {
        if (!this.enabled || !this._armed) return false;
        const slot = this._pools[cue];
        if (!slot) return false;
        const entry = slot.pool[slot.idx];
        slot.idx = (slot.idx + 1) % slot.pool.length;
        try {
            entry.el.currentTime = 0;
            const p = entry.el.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
            return true;
        } catch (_) { return false; }
    }
}

export const CUE_NAMES = Object.keys(CUES);
