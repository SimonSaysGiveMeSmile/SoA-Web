/**
 * Audio routing panel — "connect my Bluetooth headset" from the dashboard.
 *
 * The honest constraint this file is built around: the Web Speech API takes no
 * device. `SpeechRecognition` has no deviceId, `speechSynthesis` has no
 * sinkId — both follow the macOS *default* input/output and there is no web
 * API that changes their mind. So a purely client-side "headset picker" would
 * be a lie: it could list devices and change nothing.
 *
 * What actually works, and what this does: the daemon runs on the same Mac, so
 * it can connect the headset (`blueutil`) and make it the system default
 * (`SwitchAudioSource`). Once the system default moves, recognition and
 * synthesis move with it. The browser half stays responsible for the one thing
 * it genuinely owns — playing a test tone out of a chosen sink via setSinkId,
 * so the user can confirm which "Beats" in the list is the one on their head.
 *
 * Both CLI helpers are optional. Without them the panel is read-only and shows
 * the one-line brew install; it never pretends the switch happened.
 */

const BT_POLL_MS = 15000;

class VoiceAudio {
  constructor({ api, onStatus } = {}) {
    this.api = api || ((p) => p);
    this.onStatus = onStatus || (() => {});
    this.state = { devices: [], bluetooth: [], tools: {}, defaults: {}, loading: false, error: null };
    this._el = null;
    this._poll = null;
    this._testEl = null;
  }

  async _json(path, init) {
    const r = await fetch(this.api(path), { credentials: 'include', ...init });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || (path + ' → ' + r.status)), j);
    return j;
  }

  async refresh() {
    this.state.loading = true;
    this._render();
    try {
      const j = await this._json('/api/voice/audio');
      this.state.devices = j.devices || [];
      this.state.bluetooth = j.bluetooth || [];
      this.state.tools = j.tools || {};
      this.state.defaults = j.defaults || {};
      this.state.error = null;
    } catch (e) {
      this.state.error = e.message;
    }
    this.state.loading = false;
    this._render();
  }

  /**
   * Browser device labels are empty until the page holds a mic permission.
   * Asking here (rather than at first "start listening") means the picker is
   * useful before the user has ever spoken.
   */
  async grantMicPermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      return true;
    } catch (_) { return false; }
  }

  async browserOutputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'audiooutput');
  }

  /**
   * Play a short tone through a specific sink. This is the ONLY per-device
   * audio control a web page has, and it exists so the user can identify a
   * device before making it the system default.
   */
  async testTone(sinkId) {
    try {
      if (!this._testEl) {
        this._testEl = new Audio();
        this._testEl.volume = 0.35;
      }
      const el = this._testEl;
      // 0.6s 660Hz sine as a data URI — no network, no asset to ship.
      el.src = VoiceAudio.toneDataURI(660, 0.6);
      if (sinkId && typeof el.setSinkId === 'function') {
        await el.setSinkId(sinkId);
      }
      await el.play();
      return true;
    } catch (e) {
      this.onStatus('Test tone failed: ' + e.message);
      return false;
    }
  }

  /** Minimal 8-bit mono WAV as a data URI. */
  static toneDataURI(freq = 660, seconds = 0.5, sampleRate = 8000) {
    const n = Math.floor(sampleRate * seconds);
    const bytes = new Uint8Array(44 + n);
    const dv = new DataView(bytes.buffer);
    const ascii = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    ascii(0, 'RIFF'); dv.setUint32(4, 36 + n, true); ascii(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate, true);
    dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
    ascii(36, 'data'); dv.setUint32(40, n, true);
    for (let i = 0; i < n; i++) {
      // Fade in/out so it doesn't click.
      const env = Math.min(1, i / 200, (n - i) / 200);
      bytes[44 + i] = 128 + Math.round(90 * env * Math.sin(2 * Math.PI * freq * (i / sampleRate)));
    }
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return 'data:audio/wav;base64,' + btoa(bin);
  }

  async connectBluetooth(address, action = 'connect') {
    this.onStatus(action === 'connect' ? 'Connecting…' : 'Disconnecting…');
    try {
      const j = await this._json('/api/voice/bluetooth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, action }),
      });
      if (j.devices) this.state.devices = j.devices;
      this.onStatus(action === 'connect' ? 'Connected.' : 'Disconnected.');
      await this.refresh();
      return true;
    } catch (e) {
      // A missing CLI is a setup problem, not a failure — say which and how.
      if (e.code === 'TOOL_MISSING') this.onStatus(e.tool + ' not installed — run: ' + e.hint);
      else this.onStatus('Failed: ' + e.message);
      return false;
    }
  }

  async setDefault(name, kind) {
    this.onStatus('Switching ' + kind + '…');
    try {
      await this._json('/api/voice/audio/default', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, kind }),
      });
      this.onStatus(kind === 'input' ? 'Mic set to ' + name : 'Output set to ' + name);
      await this.refresh();
      return true;
    } catch (e) {
      if (e.code === 'TOOL_MISSING') this.onStatus('Needs SwitchAudioSource — run: ' + e.hint);
      else this.onStatus('Failed: ' + e.message);
      return false;
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────
  mount(el) {
    this._el = el;
    this._render();
    this.refresh();
    clearInterval(this._poll);
    this._poll = setInterval(() => { if (this._el && this._el.isConnected) this.refresh(); }, BT_POLL_MS);
    return this;
  }

  destroy() {
    clearInterval(this._poll);
    this._el = null;
    if (this._testEl) { try { this._testEl.pause(); } catch (_) {} }
  }

  _render() {
    const el = this._el;
    if (!el) return;
    const s = this.state;

    if (s.loading && !s.devices.length) { el.innerHTML = '<div class="voice-hint">Reading audio devices…</div>'; return; }
    if (s.error) { el.innerHTML = '<div class="voice-hint voice-hint--warn">' + _vesc(s.error) + '</div>'; return; }

    const headsets = s.bluetooth.filter(d => d.audio);
    const outputs = s.devices.filter(d => d.canOutput);
    const inputs = s.devices.filter(d => d.canInput);

    const rows = [];

    rows.push('<div class="voice-sec-title">Bluetooth</div>');
    if (!headsets.length) {
      rows.push('<div class="voice-hint">No paired audio devices found. Pair the headset in macOS Bluetooth settings first.</div>');
    } else {
      for (const d of headsets) {
        rows.push(
          '<div class="voice-dev' + (d.connected ? ' is-on' : '') + '">' +
            '<span class="voice-dev-dot"></span>' +
            '<span class="voice-dev-name" title="' + _vesc(d.kind) + '">' + _vesc(d.name) + '</span>' +
            (d.battery ? '<span class="voice-dev-batt">' + _vesc(d.battery) + '</span>' : '') +
            '<button class="voice-mini" data-bt="' + _vesc(d.address) + '" data-act="' +
              (d.connected ? 'disconnect' : 'connect') + '">' +
              (d.connected ? 'Disconnect' : 'Connect') + '</button>' +
          '</div>'
        );
      }
    }

    rows.push('<div class="voice-sec-title">System output</div>');
    rows.push(select('out', outputs, s.defaults.output));
    rows.push('<div class="voice-sec-title">System mic</div>');
    rows.push(select('in', inputs, s.defaults.input));
    rows.push('<div class="voice-row"><button class="voice-mini" data-test="1">Test tone</button>' +
              '<button class="voice-mini" data-refresh="1">Refresh</button></div>');

    if (!s.tools.switchaudio || !s.tools.blueutil) {
      rows.push('<div class="voice-hint voice-hint--warn">Switching devices needs helper tools. Run:<br>' +
                '<code class="voice-code">' + _vesc(s.tools.installHint || 'brew install blueutil switchaudio-osx') + '</code></div>');
    }
    // The thing that surprises everyone the first time.
    rows.push('<div class="voice-hint">Speech in and out follow the <em>system</em> default device — ' +
              'that is why switching happens here and not in the browser. ' +
              'macOS drops a Bluetooth headset to call quality while the mic is live.</div>');

    el.innerHTML = rows.join('');
    this._wire(el);

    function select(kind, list, current) {
      if (!list.length) return '<div class="voice-hint">none</div>';
      const opts = list.map(d =>
        '<option value="' + _vesc(d.name) + '"' + (d.name === current ? ' selected' : '') + '>' +
        _vesc(d.name) + (d.bluetooth ? ' ⟨BT⟩' : '') + '</option>').join('');
      return '<select class="voice-select" data-kind="' + kind + '">' + opts + '</select>';
    }
  }

  _wire(el) {
    el.querySelectorAll('[data-bt]').forEach(btn => {
      btn.addEventListener('click', () => this.connectBluetooth(btn.dataset.bt, btn.dataset.act));
    });
    el.querySelectorAll('select[data-kind]').forEach(sel => {
      sel.addEventListener('change', () => {
        this.setDefault(sel.value, sel.dataset.kind === 'in' ? 'input' : 'output');
      });
    });
    const test = el.querySelector('[data-test]');
    if (test) test.addEventListener('click', () => this.testTone(null));
    const refresh = el.querySelector('[data-refresh]');
    if (refresh) refresh.addEventListener('click', () => this.refresh());
  }
}

function _vesc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VoiceAudio };
}
