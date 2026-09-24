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
    constructor({ onResult, onError } = {}) {
        this.onResult = onResult || (() => {});
        this.onError = onError || (() => {});
        this.stream = null;
        this.el = null;
        this.video = null;
        this.canvas = null;
        this.timer = null;
        this.detector = null;
        this._jsQR = null;
        this._stopped = false;
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
            s.onerror = () => reject(new Error('QR decoder failed to load'));
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
        if (!QrScanner.supported) {
            this.onError(new Error('This browser has no camera access.'));
            return false;
        }
        this._stopped = false;
        this._mount();

        try {
            await this._initDecoder();
        } catch (e) {
            this._fail(e.message);
            return false;
        }

        // Labels are blank before a grant, so take a permissive stream first,
        // then re-open on the lens we actually want.
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' } }, audio: false,
            });
            const deviceId = await this._pickCamera();
            if (deviceId) {
                const better = await navigator.mediaDevices.getUserMedia({
                    video: { deviceId: { exact: deviceId } }, audio: false,
                }).catch(() => null);
                if (better) {
                    this.stream.getTracks().forEach(t => t.stop());
                    this.stream = better;
                }
            }
        } catch (e) {
            // Distinguish "said no" from "no camera" — the fixes are different.
            this._fail(e && e.name === 'NotAllowedError'
                ? 'Camera permission denied. Allow camera access for this site, then try again.'
                : 'Could not open the camera: ' + (e && e.message || e));
            return false;
        }

        this.video.srcObject = this.stream;
        try { await this.video.play(); } catch (_) {}
        this._armTorch();
        this.timer = setInterval(() => this._tick(), QR_SCAN_INTERVAL_MS);
        return true;
    }

    stop() {
        this._stopped = true;
        clearInterval(this.timer);
        this.timer = null;
        if (this.stream) this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
        if (this.el) { this.el.remove(); this.el = null; }
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

            if (value) {
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
        if (!caps || !caps.torch) return;
        const btn = this.el.querySelector('.qr-torch');
        if (!btn) return;
        btn.hidden = false;
        let on = false;
        btn.addEventListener('click', async () => {
            on = !on;
            try { await track.applyConstraints({ advanced: [{ torch: on }] }); btn.classList.toggle('on', on); }
            catch (_) {}
        });
    }

    // ── UI ────────────────────────────────────────────────────────────────
    _mount() {
        const el = document.createElement('div');
        el.className = 'qr-overlay';
        el.innerHTML = `
            <video class="qr-video" playsinline muted autoplay></video>
            <div class="qr-mask">
                <div class="qr-reticle"><i></i><i></i><i></i><i></i></div>
            </div>
            <div class="qr-bar">
                <button class="qr-btn qr-cancel" type="button">Cancel</button>
                <div class="qr-hint">Point at the QR code on the desktop</div>
                <button class="qr-btn qr-torch" type="button" hidden>Light</button>
            </div>`;
        document.body.appendChild(el);
        this.el = el;
        this.video = el.querySelector('.qr-video');
        el.querySelector('.qr-cancel').addEventListener('click', () => this.stop());
    }

    _flash() {
        if (!this.el) return;
        this.el.classList.add('qr-hit');
        setTimeout(() => this.el && this.el.classList.remove('qr-hit'), 220);
    }

    _fail(message) {
        this.onError(new Error(message));
        if (this.el) {
            const hint = this.el.querySelector('.qr-hint');
            if (hint) { hint.textContent = message; hint.classList.add('qr-hint--err'); }
        }
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
