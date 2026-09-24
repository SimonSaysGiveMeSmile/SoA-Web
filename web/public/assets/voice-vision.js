/**
 * Vision input — hand the agent a picture of what you're looking at.
 *
 * There is no camera API for Meta Ray-Ban frames. None. Meta ships no public
 * SDK, the glasses pair as an audio device (HFP/A2DP) plus a proprietary
 * companion-app channel, and a web page can't reach either. Anyone promising
 * "connect your Meta glasses" from a browser is describing something that does
 * not exist today.
 *
 * What DOES work, three routes, in the order they degrade:
 *
 *  1. WATCH FOLDER (works with Meta Ray-Bans today). Captures sync from the
 *     glasses to the phone's Meta AI app; with iCloud Photos or a Finder sync
 *     that file lands in a folder on this Mac. The daemon watches that folder
 *     and types any new image's path into the agent's tab, which is exactly how
 *     you hand Claude Code an image. Configured here, executed server-side in
 *     voice.js. Anything that drops a file in a folder works the same way —
 *     AirDrop, a Shortcut, a capture script.
 *
 *  2. UVC CAMERA (works with off-brand glasses that enumerate as a webcam).
 *     Plenty of non-Meta camera glasses present as a plain USB video device;
 *     those show up in enumerateDevices and capture() grabs a frame directly.
 *
 *  3. PHONE CAMERA. On the mobile companion a file input with
 *     `capture="environment"` opens the rear camera — the iOS path, since iOS
 *     Safari's getUserMedia is unavailable to a home-screen PWA in some
 *     versions but the file input always works.
 *
 * All three end in the same place: bytes POSTed to /api/voice/vision, saved on
 * the machine running the shell, and the absolute path typed into a tab.
 */

// Glasses that expose a UVC camera usually label it with one of these.
const GLASSES_HINTS = /glass|frame|ray[- ]?ban|meta|xreal|rokid|vuzix|even|halliday|brilliant/i;

class VoiceVision {
  constructor({ api } = {}) {
    this.api = api || ((p) => p);
    this.stream = null;
    this.videoEl = null;
    this.deviceId = null;
  }

  async _json(path, init) {
    const r = await fetch(this.api(path), { credentials: 'include', ...init });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || (path + ' → ' + r.status)), j);
    return j;
  }

  // ── camera enumeration ────────────────────────────────────────────────
  async cameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'videoinput').map(d => ({
      deviceId: d.deviceId,
      label: d.label || 'Camera',
      // Flagged so the UI can default to the glasses when they're plugged in.
      glasses: GLASSES_HINTS.test(d.label || ''),
    }));
  }

  /** Pick the glasses if present, else whatever was chosen, else the default. */
  async pickDevice(source) {
    const cams = await this.cameras();
    if (!cams.length) return null;
    if (source === 'glasses') {
      const g = cams.find(c => c.glasses);
      if (g) return g.deviceId;
    }
    if (this.deviceId && cams.some(c => c.deviceId === this.deviceId)) return this.deviceId;
    return cams[0].deviceId;
  }

  // ── capture ───────────────────────────────────────────────────────────
  /**
   * Grab one frame. Returns {blob, width, height, dataURL} or null.
   * The stream is opened and closed per shot: holding a camera open keeps the
   * recording indicator lit, which is not okay for an always-on assistant.
   */
  async capture({ source = 'camera', quality = 0.82, maxWidth = 1600 } = {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;

    // Labels are blank until a permission exists; a throwaway grant fixes the
    // device list before we choose.
    let deviceId = await this.pickDevice(source);
    if (!deviceId) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        probe.getTracks().forEach(t => t.stop());
      } catch (_) { return null; }
      deviceId = await this.pickDevice(source);
    }

    const constraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' },
      audio: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    try {
      const video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      // First frame can be black; wait for real dimensions.
      await VoiceVision._until(() => video.videoWidth > 0, 3000);
      await new Promise(r => setTimeout(r, 180));

      const scale = Math.min(1, maxWidth / (video.videoWidth || maxWidth));
      const w = Math.round((video.videoWidth || 1280) * scale);
      const h = Math.round((video.videoHeight || 720) * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);

      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
      return { blob, width: w, height: h, dataURL: canvas.toDataURL('image/jpeg', 0.5) };
    } finally {
      stream.getTracks().forEach(t => t.stop());
    }
  }

  /** The iOS / no-getUserMedia path: a native camera picker. */
  captureViaFilePicker() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const f = input.files && input.files[0];
        input.remove();
        resolve(f ? { blob: f, width: 0, height: 0 } : null);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  static _until(fn, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (fn() || Date.now() - t0 > ms) return resolve();
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  // ── delivery ──────────────────────────────────────────────────────────
  /**
   * Upload bytes and (optionally) type the resulting path into a tab, which is
   * how Claude Code loads an image — by absolute path, same as pasteImage.
   */
  async sendToTab(blob, tabId, prompt) {
    const q = new URLSearchParams();
    if (tabId != null) q.set('tab', String(tabId));
    if (prompt) q.set('prompt', prompt);
    const path = '/api/voice/vision' + (q.toString() ? '?' + q.toString() : '?tab=');
    const r = await fetch(this.api(path), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': blob.type || 'image/jpeg' },
      body: blob,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('upload → ' + r.status));
    return j;
  }

  // ── watch folder (the Meta Ray-Ban route) ─────────────────────────────
  async watchStatus() { return this._json('/api/voice/vision/status'); }

  async setWatch({ enabled, watchDir, targetTab, prompt }) {
    return this._json('/api/voice/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vision: { enabled, watchDir, targetTab, prompt } }),
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VoiceVision, GLASSES_HINTS };
}
