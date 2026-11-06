/**
 * In-app QR scanner — re-pair the phone without leaving the web app.
 *
 * The failure this exists for: the phone drops its session (tunnel rotated,
 * token expired, PWA cold-started with stale storage) and lands on SESSION
 * REQUIRED. The fix was always "scan the desktop's QR again", but from a
 * home-screen PWA that meant leaving the app, opening the camera, tapping the
 * banner, and getting bounced into Safari — often into a *different* browser
 * context than the PWA, so the token landed somewhere the app couldn't see it.
 * Scanning in-app keeps the token in the same storage the app reads.
 *
 * Decoding takes the cheap path when it exists:
 *   - BarcodeDetector — native, hardware-accelerated, zero download. Chrome on
 *     Android, and Safari 17+ on some builds.
 *   - jsQR — vendored locally, lazy-loaded on first use. iOS Safari still has
 *     no BarcodeDetector, and iOS is the main PWA target here, so this path is
 *     the common one rather than the exotic one.
 *
 * Camera constraints matter more than they look: `facingMode: environment` is
 * a *hint* iOS frequently ignores in favour of the ultra-wide lens, which
 * cannot focus at QR distance. Asking for a deviceId from enumerateDevices,
 * preferring a "Back Camera" label, gets the focusing lens.
 */

const QR_SCAN_INTERVAL_MS = 120;   // ~8 decodes/sec — plenty, and easy on battery

export class QrScanner {
    /**
     * @param {object} opts
     * @param {(value: string) => void} [opts.onResult]
     * @param {(err: Error) => void} [opts.onError]  fires on a camera failure. The
     *        overlay now STAYS open on its own state panel (denied / no camera /
     *        could not start) so the reason is readable; a caller may still
     *        stop() here, which closes it the old way.
     * @param {object} [opts.labels]   overrides for any string below.
     * @param {{paste?: Function, password?: Function}} [opts.actions]
     *        fallbacks offered in the overlay; a button renders only when its
     *        action is given. Choosing one stops the scanner, then calls it.
     * @param {DOMRect|{left:number,top:number,width:number,height:number}} [opts.fromRect]
     *        where the aiming frame grows from (the button that opened it).
     */
    constructor({ onResult, onError, labels, actions, fromRect } = {}) {
        this.onResult = onResult || (() => {});
        this.onError = onError || (() => {});
        // English defaults keep the /m/ companion working as-is; the localized
        // root landing passes its own strings.
        this.labels = Object.assign({
            cancel: 'Cancel',
            title: 'Scan the code on your computer',
            hint: 'Point at the QR code in the sidebar of the other computer (Mobile link).',
            starting: 'Starting the camera…',
            connecting: 'Connecting…',
            torch: 'Light',
            retry: 'Try again',
            paste: 'Paste the link',
            password: 'Use the pairing password',
            deniedTitle: 'Camera access is off',
            deniedText: 'Allow the camera for this site in your browser settings, then try again. Or connect another way.',
            nocamTitle: 'No camera available',
            nocamText: 'Paste the link from your computer, or use its pairing password.',
            errorTitle: 'The camera could not start',
            // The messages handed to onError (the page's own error line).
            errNoCam: 'This browser has no camera access.',
            errDenied: 'Camera access is off. Allow the camera for this site, then try again.',
            // '{detail}' is substituted with the underlying DOMException text.
            errOpen: 'The camera could not start: {detail}',
        }, labels || {});
        this.actions = actions || {};
        this.fromRect = fromRect || null;
        this.stream = null;
        this.el = null;
        this.video = null;
        this.canvas = null;
        this.timer = null;
        this.detector = null;
        this._jsQR = null;
        this._stopped = false;
        this._returnFocus = null;
        this._onKey = null;
        this._run = 0;
    }

    static get supported() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    // ── decoding backends ─────────────────────────────────────────────────
    async _initDecoder() {
        if ('BarcodeDetector' in window) {
            try {
                const formats = await window.BarcodeDetector.getSupportedFormats();
                if (formats.includes('qr_code')) {
                    this.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
                    return;
                }
            } catch (_) { /* fall through to jsQR */ }
        }
        this._jsQR = await QrScanner._loadJsQR();
    }

    static _loadJsQR() {
        if (window.jsQR) return Promise.resolve(window.jsQR);
        if (QrScanner._loading) return QrScanner._loading;
        QrScanner._loading = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            // Resolved against this module's own URL, not the site root: the
            // mobile app is served at /m/ by the daemon but at / by the
            // standalone build, and a root-absolute path is wrong in one of
            // the two whichever way it is written.
            s.src = new URL('./vendor/jsQR.min.js', import.meta.url).href;
            s.onload = () => resolve(window.jsQR);
            s.onerror = () => { QrScanner._loading = null; reject(new Error('QR decoder failed to load')); };
            document.head.appendChild(s);
        });
        return QrScanner._loading;
    }

    /** Prefer the real back camera over the ultra-wide, which cannot focus close. */
    async _pickCamera() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cams = devices.filter(d => d.kind === 'videoinput');
            if (cams.length < 2) return null;
            const back = cams.find(c => /back(?! ultra)|rear|environment/i.test(c.label) && !/ultra|wide|tele/i.test(c.label))
                      || cams.find(c => /back|rear/i.test(c.label));
            return back ? back.deviceId : null;
        } catch (_) { return null; }
    }

    // ── lifecycle ─────────────────────────────────────────────────────────
    async start() {
        this._stopped = false;
        this._returnFocus = document.activeElement;
        this._mount();
        if (!QrScanner.supported) {
            this._fail('nocam', this.labels.errNoCam);
            return false;
        }
        return this._open();
    }

    /** Ask for the camera and start decoding. Re-run by "Try again". */
    async _open() {
        const run = ++this._run;
        const hadPanelFocus = !!(this.el && this.el.querySelector('.qr-state').contains(document.activeElement));
        this._setState('starting');
        if (hadPanelFocus) { try { this.el.querySelector('.qr-cancel').focus({ preventScroll: true }); } catch (_) {} }
        try {
            if (!this.detector && !this._jsQR) await this._initDecoder();
        } catch (e) {
            if (run === this._run && !this._stopped) this._fail('error', e.message, e.message);
            return false;
        }
        if (run !== this._run || this._stopped) return false;

        // Labels are blank before a grant, so take a permissive stream first,
        // then re-open on the lens we actually want.
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' } }, audio: false,
            });
            const deviceId = await this._pickCamera();
            if (deviceId) {
                const better = await navigator.mediaDevices.getUserMedia({
                    video: { deviceId: { exact: deviceId } }, audio: false,
                }).catch(() => null);
                if (better) {
                    stream.getTracks().forEach(t => t.stop());
                    stream = better;
                }
            }
        } catch (e) {
            if (run !== this._run || this._stopped) return false;
            // Distinguish "said no" from "no camera" from "broke" — the fixes differ.
            const name = e && e.name;
            const detail = String((e && e.message) || e);
            if (name === 'NotAllowedError' || name === 'SecurityError') this._fail('denied', this.labels.errDenied);
            else if (name === 'NotFoundError' || name === 'OverconstrainedError') this._fail('nocam', this.labels.errNoCam);
            else this._fail('error', this.labels.errOpen.replace('{detail}', detail), detail);
            return false;
        }
        // Cancelled (or retried) while the permission prompt was up.
        if (run !== this._run || this._stopped || !this.el) {
            stream.getTracks().forEach(t => t.stop());
            return false;
        }
        this.stream = stream;
        this.video.srcObject = this.stream;
        try { await this.video.play(); } catch (_) {}
        if (run !== this._run || this._stopped) return false;
        this._setState('live');
        this._armTorch();
        clearInterval(this.timer);
        this.timer = setInterval(() => this._tick(), QR_SCAN_INTERVAL_MS);
        return true;
    }

    _release() {
        clearInterval(this.timer);
        this.timer = null;
        if (this.stream) this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
    }

    stop() {
        this._stopped = true;
        this._run++;
        this._release();
        if (this._onKey) { document.removeEventListener('keydown', this._onKey, true); this._onKey = null; }
        if (this.el) {
            const hadFocus = this.el.contains(document.activeElement);
            this.el.remove();
            this.el = null;
            // Back to the control that opened the scanner (a fallback action
            // may then move it on to its own field).
            const back = this._returnFocus;
            this._returnFocus = null;
            if (hadFocus && back && back.isConnected && typeof back.focus === 'function') {
                try { back.focus({ preventScroll: true }); } catch (_) {}
            }
        }
    }

    async _tick() {
        if (this._stopped || !this.video || this.video.readyState < 2) return;
        try {
            let value = null;

            if (this.detector) {
                const hits = await this.detector.detect(this.video);
                if (hits && hits.length) value = hits[0].rawValue;
            } else if (this._jsQR) {
                const w = this.video.videoWidth, h = this.video.videoHeight;
                if (!w || !h) return;
                // Downscale: jsQR is pure JS and a 4K frame is ~10× the work
                // for no accuracy gain at QR sizes.
                const scale = Math.min(1, 640 / Math.max(w, h));
                const cw = Math.round(w * scale), ch = Math.round(h * scale);
                if (!this.canvas) this.canvas = document.createElement('canvas');
                this.canvas.width = cw; this.canvas.height = ch;
                const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(this.video, 0, 0, cw, ch);
                const img = ctx.getImageData(0, 0, cw, ch);
                const res = this._jsQR(img.data, cw, ch, { inversionAttempts: 'dontInvert' });
                if (res && res.data) value = res.data;
            }

            if (value && !this._stopped) {
                clearInterval(this.timer);
                this.timer = null;
                this._flash();
                if (navigator.vibrate) try { navigator.vibrate(40); } catch (_) {}
                this.onResult(value);
            }
        } catch (_) { /* a bad frame is not an error worth surfacing */ }
    }

    /** Torch, where the platform exposes it — QR codes on a dim screen. */
    _armTorch() {
        const track = this.stream && this.stream.getVideoTracks()[0];
        const caps = track && track.getCapabilities && track.getCapabilities();
        const btn = this.el && this.el.querySelector('.qr-torch');
        if (!btn) return;
        btn.hidden = true;
        btn.onclick = null;
        if (!caps || !caps.torch) return;
        btn.hidden = false;
        let on = false;
        btn.setAttribute('aria-pressed', 'false');
        btn.onclick = async () => {
            on = !on;
            try {
                await track.applyConstraints({ advanced: [{ torch: on }] });
                btn.classList.toggle('on', on);
                btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            } catch (_) { on = !on; }
        };
    }

    // ── UI ────────────────────────────────────────────────────────────────
    _mount() {
        if (this.el) return;
        const el = document.createElement('div');
        el.className = 'qr-overlay';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        const titleId = 'qr-title-' + Math.random().toString(36).slice(2, 8);
        el.setAttribute('aria-labelledby', titleId);
        el.dataset.state = 'starting';
        el.innerHTML = `
            <video class="qr-video" playsinline muted autoplay></video>
            <div class="qr-top">
                <button class="qr-btn qr-cancel" type="button"></button>
                <h2 class="qr-title"></h2>
            </div>
            <div class="qr-stage"><div class="qr-reticle"><i></i><i></i><i></i><i></i><span class="qr-check" aria-hidden="true"></span></div></div>
            <p class="qr-hint" aria-live="polite"></p>
            <div class="qr-bar">
                <button class="qr-btn qr-torch" type="button" aria-pressed="false" hidden></button>
                <button class="qr-btn qr-alt" type="button" hidden></button>
            </div>
            <section class="qr-state" hidden>
                <h3 class="qr-state-title"></h3>
                <p class="qr-state-p"></p>
                <p class="qr-state-detail" hidden></p>
                <div class="qr-state-actions"></div>
            </section>`;
        // textContent, not interpolation: these strings are translated and a
        // language with an apostrophe or angle bracket must not break the markup.
        const L = this.labels;
        el.querySelector('.qr-title').id = titleId;
        el.querySelector('.qr-title').textContent = L.title;
        el.querySelector('.qr-cancel').textContent = L.cancel;
        el.querySelector('.qr-hint').textContent = L.starting;
        el.querySelector('.qr-torch').textContent = L.torch;
        const alt = el.querySelector('.qr-alt');
        if (this.actions.paste) {
            alt.textContent = L.paste;
            alt.addEventListener('click', () => this._choose('paste'));
        }
        el.querySelector('.qr-cancel').addEventListener('click', () => this.stop());

        const reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (!reduce) el.classList.add('qr-enter');
        document.body.appendChild(el);
        this.el = el;
        this.video = el.querySelector('.qr-video');

        // Escape cancels; Tab stays inside the dialog.
        this._onKey = (e) => {
            if (!this.el) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.stop(); return; }
            if (e.key !== 'Tab') return;
            const items = [...this.el.querySelectorAll('button:not([hidden])')]
                .filter(b => b.offsetParent !== null && !b.disabled);
            if (!items.length) return;
            const first = items[0], last = items[items.length - 1];
            if (!this.el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
            else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', this._onKey, true);
        try { el.querySelector('.qr-cancel').focus({ preventScroll: true }); } catch (_) {}

        // The aiming frame grows out of the control that opened it: one FLIP.
        const from = this.fromRect;
        if (from && !reduce && from.width > 0 && from.height > 0) {
            const ret = el.querySelector('.qr-reticle');
            const to = ret.getBoundingClientRect();
            if (to.width > 0) {
                const sx = from.width / to.width, sy = from.height / to.height;
                const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
                const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
                ret.style.transition = 'none';
                ret.style.transformOrigin = '50% 50%';
                ret.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
                void ret.offsetWidth;
                requestAnimationFrame(() => {
                    ret.style.transition = 'transform 240ms cubic-bezier(.2,.8,.2,1)';
                    ret.style.transform = '';
                    setTimeout(() => { ret.style.transition = ''; ret.style.transformOrigin = ''; }, 300);
                });
            }
        }
    }

    _setState(state) {
        if (!this.el) return;
        const el = this.el;
        el.dataset.state = state;
        const L = this.labels;
        const hint = el.querySelector('.qr-hint');
        const panel = el.querySelector('.qr-state');
        const alt = el.querySelector('.qr-alt');
        if (state === 'starting') hint.textContent = L.starting;
        else if (state === 'live') hint.textContent = L.hint;
        else if (state === 'hit') hint.textContent = L.connecting;
        hint.classList.remove('qr-hint--err');
        alt.hidden = !(this.actions.paste && state === 'live');
        panel.hidden = !(state === 'denied' || state === 'nocam' || state === 'error');
    }

    /** Leave the scanner for one of the page's own ways in. */
    _choose(kind) {
        const fn = this.actions[kind];
        this.stop();
        if (typeof fn === 'function') { try { fn(); } catch (_) {} }
    }

    _flash() {
        if (!this.el) return;
        this.el.classList.add('qr-hit');
        this._setState('hit');
    }

    /**
     * A camera that cannot open: show why, on the overlay, with a way forward.
     * The overlay stays until Cancel, Escape or a fallback is chosen.
     */
    _fail(kind, message, detail) {
        this._release();
        if (this.el) {
            const L = this.labels;
            this._setState(kind);
            const panel = this.el.querySelector('.qr-state');
            const title = kind === 'denied' ? L.deniedTitle : kind === 'nocam' ? L.nocamTitle : L.errorTitle;
            const text = kind === 'denied' ? L.deniedText : kind === 'nocam' ? L.nocamText : '';
            panel.querySelector('.qr-state-title').textContent = title;
            const p = panel.querySelector('.qr-state-p');
            p.textContent = text; p.hidden = !text;
            const d = panel.querySelector('.qr-state-detail');
            d.textContent = detail || ''; d.hidden = !detail;
            const box = panel.querySelector('.qr-state-actions');
            box.textContent = '';
            const add = (label, fn, primary) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'qr-btn qr-state-btn' + (primary ? ' qr-primary' : '');
                b.textContent = label;
                b.addEventListener('click', fn);
                box.appendChild(b);
                return b;
            };
            const retry = () => this._open();
            const list = [];
            if (kind !== 'nocam' && QrScanner.supported) list.push([L.retry, retry]);
            if (this.actions.paste) list.push([L.paste, () => this._choose('paste')]);
            if (this.actions.password && kind !== 'error') list.push([L.password, () => this._choose('password')]);
            list.forEach(([label, fn], i) => add(label, fn, i === 0));
            const firstBtn = box.querySelector('button');
            if (firstBtn) { try { firstBtn.focus({ preventScroll: true }); } catch (_) {} }
        }
        // After the panel is drawn: a caller that still stop()s here closes it.
        this.onError(new Error(message));
    }
}

/**
 * Turn a scanned string into something to connect to.
 *
 * The desktop QR encodes the full pairing URL, but people also scan a bare
 * host, a URL with the token in the hash, or a URL to `/` rather than `/m/`.
 * Normalising all of those here means the scanner works with any QR the app
 * has ever generated, including old ones on a second screen.
 */
export function parsePairingPayload(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    let url;
    try {
        url = new URL(text);
    } catch (_) {
        // A bare host (or host:port) is a reasonable thing for a QR to hold.
        if (!/^[\w.-]+(:\d+)?(\/.*)?$/.test(text)) return null;
        try { url = new URL('https://' + text); } catch (_) { return null; }
    }
    if (!/^https?:$/.test(url.protocol)) return null;

    // The token may ride in the query or the hash, under either spelling.
    const hashParams = new URLSearchParams((url.hash || '').replace(/^#/, ''));
    const token = url.searchParams.get('t') || url.searchParams.get('token')
               || hashParams.get('t') || hashParams.get('token') || '';

    // `#alt=` is the second transport the desktop encodes (LAN↔tunnel), and
    // `backend=` appears when the page and the daemon are different origins.
    // Both must survive the scan or the phone loses its failover path and
    // needs another re-pair the next time the network flips.
    const altOrigin = hashParams.get('alt') || url.searchParams.get('alt') || null;
    const backend = (url.searchParams.get('backend') || hashParams.get('backend') || '').replace(/\/+$/, '') || null;

    // A navigable URL is still returned, but only as the last-resort path —
    // connecting in place keeps the PWA from bouncing out to the browser.
    const target = new URL(url.origin + '/m/');
    if (token) target.searchParams.set('t', token);

    return { origin: url.origin, token, altOrigin, backend, url: target.toString() };
}

export { QR_SCAN_INTERVAL_MS };
