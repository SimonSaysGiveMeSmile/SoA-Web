// Browser fullscreen and Home Screen installation are separate from hiding
// the terminal's own controls. Unsupported/denied requests keep a visible way
// forward, including on iPhone and inside another app's browser.
export class MobileFullscreen {
    constructor() {
        this.button = document.getElementById('btn-fullscreen');
        this.dialog = document.getElementById('fullscreen-help');
        this.hint = document.getElementById('install-hint');
        this.installButton = document.getElementById('fullscreen-install');
        this.message = document.getElementById('fullscreen-message');
        this.prompt = null;
        this.modes = ['standalone', 'fullscreen'].map(mode => window.matchMedia(`(display-mode: ${mode})`));

        this.button.addEventListener('click', () => this.toggle());
        document.getElementById('fullscreen-close').addEventListener('click', () => this.dialog.close());
        this.dialog.addEventListener('click', e => { if (e.target === this.dialog) this.dialog.close(); });
        this.installButton.addEventListener('click', () => this.install());
        this.hint.querySelector('.ih-action').addEventListener('click', () => this.showHelp());
        this.hint.querySelector('.ih-close').addEventListener('click', () => {
            this.hint.hidden = true;
            clearTimeout(this.hintTimer);
            try { localStorage.setItem('soa.m.installHint', 'dismissed'); } catch (_) {}
        });
        for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
            document.addEventListener(event, () => this.sync());
        }
        for (const mode of this.modes) mode.addEventListener?.('change', () => this.sync());
        window.addEventListener('beforeinstallprompt', e => {
            e.preventDefault();
            this.prompt = e;
            this.installButton.hidden = false;
        });
        window.addEventListener('appinstalled', () => {
            this.prompt = null;
            this.installButton.hidden = true;
            this.hint.hidden = true;
            this.message.textContent = 'Installed. Open Son of Anton from your Home Screen to hide the browser bars.';
            this.sync();
        });
        this.sync();
    }

    get element() { return document.fullscreenElement || document.webkitFullscreenElement; }
    get chromeless() {
        return !!window.Capacitor || navigator.standalone === true || this.modes.some(mode => mode.matches);
    }

    sync() {
        const active = !!this.element;
        this.button.hidden = this.chromeless && !active;
        this.button.setAttribute('aria-pressed', String(active));
        const label = active ? 'Exit full screen' : 'Full screen — hide browser bars';
        this.button.title = label;
        this.button.setAttribute('aria-label', label);
        this.button.textContent = active ? '⤢' : '⛶';
        if (this.chromeless || active) {
            this.hint.hidden = true;
            if (this.dialog.open) this.dialog.close();
        }
    }

    async toggle() {
        const root = document.documentElement;
        const active = !!this.element;
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        const request = root.requestFullscreen || root.webkitRequestFullscreen;
        if (!active && !request) { this.showHelp(); return; }
        this.button.disabled = true;
        try {
            if (active) await exit.call(document);
            else if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
            else await request.call(root);
            this.sync();
        } catch (_) {
            this.sync();
            this.showHelp(active
                ? 'Use your browser’s Back or Exit Full Screen control to leave full screen.'
                : 'This browser could not enter full screen. Open the app from your Home Screen to hide the browser bars.');
        } finally {
            this.button.disabled = false;
        }
    }

    showHint(force = false) {
        if (this.chromeless || this.element) return;
        if (force) { this.showHelp(); return; }
        try { if (localStorage.getItem('soa.m.installHint') === 'dismissed') return; } catch (_) {}
        this.hint.querySelector('.ih-text').textContent = 'Hide the browser bars: add SoA to your Home Screen.';
        this.hint.hidden = false;
        clearTimeout(this.hintTimer);
        this.hintTimer = setTimeout(() => { this.hint.hidden = true; }, 20000);
    }

    showHelp(message = '') {
        const ua = navigator.userAgent || '';
        const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const inApp = (ios && !/Safari\//.test(ua)) || /\bwv\b|FBAN|FBAV|Instagram|Line\/|ntfy|GSA\//i.test(ua);
        const steps = [];
        if (inApp) steps.push(ios ? 'Open this page in Safari using this app’s menu.' : 'Open this page in Chrome or your usual browser using this app’s menu.');
        if (ios) {
            steps.push('Tap Share (or Page Menu → Share), then Add to Home Screen.',
                'Keep Open as Web App enabled if shown, then tap Add.');
        } else {
            steps.push('Open your browser menu and choose Install app or Add to Home screen.',
                'Confirm the installation.');
        }
        steps.push('Launch Son of Anton from its Home Screen icon. The browser’s address bar and toolbar will be hidden.');
        document.getElementById('fullscreen-steps').replaceChildren(...steps.map(text => {
            const li = document.createElement('li');
            li.textContent = text;
            return li;
        }));
        this.message.textContent = message;
        this.installButton.hidden = !this.prompt;
        this.hint.hidden = true;
        clearTimeout(this.hintTimer);
        if (!this.dialog.open) this.dialog.showModal();
    }

    async install() {
        const prompt = this.prompt;
        if (!prompt) return;
        this.prompt = null;
        this.installButton.disabled = true;
        try {
            // Must be called directly from the tap, before awaiting anything.
            await prompt.prompt();
            const choice = await prompt.userChoice;
            this.message.textContent = choice?.outcome === 'accepted'
                ? 'Finish installing, then open Son of Anton from your Home Screen.'
                : 'You can install later using your browser menu.';
        } catch (_) {
            this.message.textContent = 'Use your browser menu to add the app to your Home Screen.';
        } finally {
            this.installButton.disabled = false;
            this.installButton.hidden = !this.prompt;
        }
    }
}
