/**
 * Sound effects for the mobile companion — mirrors the desktop palette.
 *
 * Uses the HTML5 Audio element (lighter than WebAudio for short one-shots)
 * with a per-clip pool so rapid events like key taps don't cut each other
 * off. All assets live under /audio/ and are the same WAV files the desktop
 * ships, so the two apps feel identical.
 *
 * Browsers require a user gesture to start audio playback; we lazily prime
 * the context on the first touch/pointer event and silently no-op before
 * that (so autoplay policies don't throw).
 */

const PROFILE_KEY = 'son-of-anton.sound-profile';

// Which logical events each profile plays. Matches the desktop AudioManager.
const PROFILES = {
    off: {
        name: 'Silent',
        events: {},
    },
    subtle: {
        name: 'Subtle',
        events: {
            connect:    { clip: 'granted', volume: 0.5 },
            disconnect: { clip: 'denied',  volume: 0.5 },
            tabSwitch:  { clip: 'panels',  volume: 0.35 },
        },
    },
    full: {
        name: 'Full',
        events: {
            connect:    { clip: 'granted',  volume: 0.6 },
            disconnect: { clip: 'denied',   volume: 0.6 },
            tabSwitch:  { clip: 'panels',   volume: 0.5 },
            key:        { clip: 'keyboard', volume: 0.35 },
            themeSwitch:{ clip: 'theme',    volume: 0.5 },
        },
    },
};

const DEFAULT_PROFILE = 'subtle';
const POOL_SIZE = 4;

class SoundEngine {
    constructor() {
        this.profile = this._loadProfile();
        this._primed = false;
        this._pools = {};
        this._globalVolume = 0.8;

        // Prime on first user gesture so iOS allows playback.
        const prime = () => {
            this._primed = true;
            window.removeEventListener('pointerdown', prime, true);
            window.removeEventListener('keydown', prime, true);
            window.removeEventListener('touchstart', prime, true);
        };
        window.addEventListener('pointerdown', prime, true);
        window.addEventListener('keydown', prime, true);
        window.addEventListener('touchstart', prime, true);
    }

    _loadProfile() {
        try {
            const saved = localStorage.getItem(PROFILE_KEY);
            if (saved && PROFILES[saved]) return saved;
        } catch (_) {}
        return DEFAULT_PROFILE;
    }

    setProfile(name) {
        if (!PROFILES[name]) return;
        this.profile = name;
        try { localStorage.setItem(PROFILE_KEY, name); } catch (_) {}
    }

    getProfile() { return this.profile; }
    listProfiles() {
        return Object.entries(PROFILES).map(([key, p]) => ({ key, name: p.name }));
    }

    _getPool(clipName) {
        if (this._pools[clipName]) return this._pools[clipName];
        const pool = [];
        for (let i = 0; i < POOL_SIZE; i++) {
            const a = new Audio(`audio/${clipName}.wav`);
            a.preload = 'auto';
            pool.push(a);
        }
        this._pools[clipName] = { items: pool, next: 0 };
        return this._pools[clipName];
    }

    play(eventName) {
        if (!this._primed) return;
        const profile = PROFILES[this.profile];
        if (!profile) return;
        const mapping = profile.events[eventName];
        if (!mapping) return;

        try {
            const pool = this._getPool(mapping.clip);
            const el = pool.items[pool.next];
            pool.next = (pool.next + 1) % pool.items.length;
            el.currentTime = 0;
            el.volume = Math.max(0, Math.min(1, (mapping.volume || 1) * this._globalVolume));
            const p = el.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {}
    }
}

export const sounds = new SoundEngine();
export { PROFILES };
