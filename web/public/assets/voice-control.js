/**
 * Voice Control for Son of Anton — recognition, wake word, intent parsing.
 *
 * Three layers, cheapest first, because latency is the whole product here:
 *
 *   1. WAKE. In wake mode nothing is executed until the wake phrase lands.
 *      This is not a nicety — continuous recognition on a live mic in a room
 *      with a terminal reading output aloud will otherwise "hear" a command in
 *      its own speech. The phrase is matched fuzzily (see _matchWake): browser
 *      ASR renders "hey anton" as "hey antoine", "hay anton", "hey anthon" and a
 *      dozen other things, and rejecting those makes the feature feel broken.
 *
 *   2. LOCAL PARSE. A regex table covers the hot commands — read output,
 *      interrupt, next tab, change model, usage. Zero latency, works offline,
 *      and it is the only path that can be trusted to stop a runaway process.
 *
 *   3. MODEL. Anything the table can't place goes to /api/voice/interpret,
 *      where a headless haiku turns "hop over to the iPlan repo and help me
 *      finish the migration" into {intent:'switch_project'} + a follow-up goal.
 *      Network + model latency, so it is the fallback, never the first try.
 *
 * Audio device selection is deliberately NOT here: neither SpeechRecognition
 * nor speechSynthesis accepts a device, so routing to a Bluetooth headset is a
 * system-level change. See voice-audio.js and /api/voice/audio.
 */

const VOICE_DEFAULTS = {
  language: 'en-US',
  continuous: true,
  interimResults: true,
  maxAlternatives: 3,
  voiceURI: null,
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  wakeWord: 'hey anton',
  wakeMode: 'wake',        // 'wake' | 'always'
  awakeMs: 15000,          // follow-up window after a wake, ms
  useModel: true,          // allow the /api/voice/interpret fallback
  verbosity: 'brief',      // 'brief' | 'detailed'
  duckWhileSpeaking: true, // ignore transcripts while TTS is talking
};

class VoiceControl {
  constructor(opts = {}) {
    this.recognition = null;
    this.synthesis = window.speechSynthesis;
    this.isListening = false;
    this.isEnabled = false;
    this.isSpeaking = false;
    this.currentUtterance = null;

    // Wake state
    this.awake = false;
    this._awakeTimer = null;
    this._lastSpokenAt = 0;

    // Callbacks
    this.onCommand = null;      // (intent, params, meta) => void
    this.onStatusChange = null; // (status) => void
    this.onError = null;        // (error) => void
    this.onTranscript = null;   // (text, {final, wake}) => void

    this.settings = { ...VOICE_DEFAULTS, ...opts };
    this._loadSettings();
    // Back-compat: widgets read voice.verbosity directly.
    this.verbosity = this.settings.verbosity;

    this._initRecognition();
  }

  get supported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  // ── recognition ───────────────────────────────────────────────────────
  _initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      console.warn('[Voice] SpeechRecognition unavailable in this browser');
      return;
    }

    const rec = new SR();
    rec.continuous = this.settings.continuous;
    rec.interimResults = this.settings.interimResults;
    rec.maxAlternatives = this.settings.maxAlternatives;
    rec.lang = this.settings.language;

    rec.onstart = () => {
      this.isListening = true;
      this._notifyStatus({ listening: true });
    };

    rec.onend = () => {
      this.isListening = false;
      this._notifyStatus({ listening: false });
      // Chrome ends the stream every ~60s of silence and after every result in
      // some versions. Continuous listening therefore means restarting, not
      // trusting `continuous`.
      if (this.isEnabled) {
        clearTimeout(this._restartTimer);
        // Back off on repeated errors: a mic that keeps failing ('audio-capture',
        // 'network') used to be restarted every 250ms forever, which on a page
        // left open overnight is a hot loop. Doubling from 250ms to 15s, and
        // giving up after a run of failures, keeps the "Chrome ended the stream"
        // case instant while making a broken mic go quiet.
        const n = this._errStreak || 0;
        const delay = n ? Math.min(250 * Math.pow(2, n), 15000) : 250;
        this._restartTimer = setTimeout(() => { if (this.isEnabled) this._startRaw(); }, delay);
      }
    };

    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        // Consider every alternative: ASR's top pick garbles the wake word
        // more often than its second.
        const alts = [];
        for (let a = 0; a < result.length; a++) alts.push(result[a].transcript.trim());
        const text = alts[0] || '';
        if (!text) continue;

        this._errStreak = 0;   // a result means the mic works — reset the backoff
        if (!result.isFinal) {
          if (this.onTranscript) this.onTranscript(text, { final: false });
          continue;
        }
        if (this.onTranscript) this.onTranscript(text, { final: true });
        this._handleFinal(alts);
      }
    };

    rec.onerror = (event) => {
      const err = event.error;
      // 'no-speech' and 'aborted' are normal in continuous mode — surfacing
      // them as errors makes the widget look broken while it works fine.
      // 'no-speech' is the service's own ~7s idle timeout — normal, and
      // self-throttling. 'aborted' is immediate (a start/stop race, a mic
      // grabbed by another app) and used to restart at 250ms forever; it
      // counts toward the backoff streak but is not surfaced as an error.
      if (err === 'no-speech') return;
      if (err === 'aborted') {
        this._errStreak = (this._errStreak || 0) + 1;
        if (this._errStreak < 8) return;
      }
      console.warn('[Voice] recognition error:', err);
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        this.isEnabled = false;
        this._notifyError('Microphone permission denied. Allow mic access for this site.');
        return;
      }
      if (err !== 'aborted') this._errStreak = (this._errStreak || 0) + 1;
      if (this._errStreak >= 8) {
        // Eight failures in a row with no result in between: stop rather than
        // retry forever. The user re-enables with one tap once the mic is back.
        this.isEnabled = false;
        clearTimeout(this._restartTimer);
        this._notifyStatus({ listening: false });
        this._notifyError('Microphone keeps failing (' + err + ') — voice paused. Tap Listen to retry.');
        return;
      }
      this._notifyError('Recognition error: ' + err);
    };

    this.recognition = rec;
  }

  _startRaw() {
    if (!this.recognition || this.isListening) return;
    try { this.recognition.start(); }
    catch (_) { /* already starting — onend will retry */ }
  }

  start() {
    this._errStreak = 0;   // a deliberate (re)start begins the backoff ladder afresh
    if (!this.recognition) {
      this._notifyError('Speech recognition is not supported in this browser. Chrome or Edge works; iOS Safari does not.');
      return false;
    }
    this.isEnabled = true;
    this.awake = this.settings.wakeMode === 'always';
    this._startRaw();
    this._notifyStatus({ enabled: true });
    return true;
  }

  stop() {
    this.isEnabled = false;
    this.awake = false;
    clearTimeout(this._restartTimer);
    clearTimeout(this._awakeTimer);
    if (this.recognition && this.isListening) {
      try { this.recognition.stop(); } catch (_) {}
    }
    this.stopSpeaking();
    this._notifyStatus({ enabled: false, listening: false });
  }

  // ── wake word ─────────────────────────────────────────────────────────
  /**
   * Fuzzy wake match. Returns the remainder of the utterance after the wake
   * phrase (possibly ''), or null when the phrase isn't there.
   *
   * Browser ASR is unreliable on a two-syllable name: "anton" comes back as
   * "antoine", "anthon", "antone" (and sometimes split in two — "and on",
   * "auntie on" — which we deliberately no longer accept; see below). An
   * exact match would make the wake word feel broken a third of the time, so
   * the name is compared by edit distance, with structural guards.
   */
  _matchWake(text) {
    const wake = (this.settings.wakeWord || 'hey anton').toLowerCase().trim();
    const wakeWords = wake.split(/\s+/);
    const norm = String(text || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!norm) return null;
    const words = norm.split(' ');

    // Consume the wake phrase from the front, word for word. The name may not
    // span two words: that path let every cheap two-word neighbour of "anton"
    // wake the terminal ("a ton of tests", "an ton", "at on"), and one false
    // wake opens a window in which a bare "stop" is a Ctrl-C. The price is
    // that the two-word mangles ("and on", "auntie on") no longer wake —
    // recall lost, spurious interrupts gone.
    const take = wakeWords.length;
    if (take <= words.length && this._wakeMatches(words.slice(0, take), wakeWords)) {
      return words.slice(take).join(' ');
    }
    // Also accept ONE leading filler ("okay hey anton", "so hey anton") — from
    // a fixed list, not any word: with a one-word wake phrase, "any leading
    // word" would make "my computer crashed" a wake.
    if (take < words.length && VoiceControl.WAKE_FILLERS.has(words[0])
        && this._wakeMatches(words.slice(1, take + 1), wakeWords)) {
      return words.slice(take + 1).join(' ');
    }
    return null;
  }

  /**
   * A candidate head matches the wake phrase when its FIRST word is the wake
   * phrase's first word (one edit allowed: "hay") AND the rest is close to the
   * name. Scoring the whole phrase in one edit budget let "hey anyone" and
   * "hey a ton of tests…" wake the terminal — each is within two edits of
   * "anton" — and one false wake opens a 15s window where "stop" is a Ctrl-C.
   * Splitting the budget keeps every real ASR mangle of the name ("antoine",
   * "anthon", "antone") while refusing ordinary English that merely starts
   * with "hey".
   */
  _wakeMatches(headWords, wakeWords) {
    if (headWords.length !== wakeWords.length) return false;
    // A one-word wake phrase has no leading word to pin, so it must match
    // exactly — fuzzing it would let "my computer crashed" wake "computer".
    if (wakeWords.length === 1) return headWords[0] === wakeWords[0];
    if (this._levenshtein(headWords[0], wakeWords[0]) > 1) return false;
    const name = headWords.slice(1).join(' ');
    const wakeName = wakeWords.slice(1).join(' ');
    if (name === wakeName) return true;
    // Fuzzy path, structural before fuzzy. ASR mangles a name by adding or
    // swapping sounds ("antoine", "anthon", "antone") — never by clipping it
    // to a shorter real word. So: never shorter than the name; same first two
    // letters; and an equal-length candidate gets ONE edit, not two, which is
    // what separates a mangle from the ordinary words that sit two edits away
    // ("anti", "ante", "antic", "antra", "ant", "ann").
    if (name.length < wakeName.length) return false;
    if (name.slice(0, 2) !== wakeName.slice(0, 2)) return false;
    if (VoiceControl.WAKE_DENY.has(name)) return false;
    if (name.length === wakeName.length) return this._levenshtein(name, wakeName) <= 1;
    return this._closeEnough(name, wakeName);
  }

  _closeEnough(a, b) {
    if (a === b) return true;
    // Distance budget scales with length: 2 edits on "anton" (5 chars) is
    // enough for "antoine"/"anthon"/"antone" once the leading word is pinned.
    const budget = Math.max(2, Math.floor(b.length * 0.28));
    return this._levenshtein(a, b) <= budget;
  }

  _levenshtein(a, b) {
    if (Math.abs(a.length - b.length) > 8) return 99;
    const m = a.length, n = b.length;
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      prev = cur;
    }
    return prev[n];
  }

  _wakeUp(silent) {
    this.awake = true;
    clearTimeout(this._awakeTimer);
    this._awakeTimer = setTimeout(() => {
      this.awake = this.settings.wakeMode === 'always';
      this._notifyStatus({ awake: this.awake });
    }, this.settings.awakeMs);
    this._notifyStatus({ awake: true });
    if (!silent) this.speak('Yes?', { rate: this.settings.rate * 1.1 });
  }

  sleep() {
    this.awake = false;
    clearTimeout(this._awakeTimer);
    this._notifyStatus({ awake: false });
  }

  // ── dispatch ──────────────────────────────────────────────────────────
  _handleFinal(alts) {
    // Echo suppression: the mic hears our own TTS. Anything arriving while
    // speaking (or within a beat of finishing) is almost certainly us.
    if (this.settings.duckWhileSpeaking &&
        (this.isSpeaking || Date.now() - this._lastSpokenAt < 600)) {
      return;
    }

    let phrase = alts[0];
    let viaWake = false;

    if (this.settings.wakeMode === 'wake' && !this.awake) {
      // Check every alternative for the wake phrase, take the first that has it.
      let rest = null;
      for (const alt of alts) {
        const r = this._matchWake(alt);
        if (r !== null) { rest = r; break; }
      }
      if (rest === null) return;   // not addressed to us — stay quiet
      viaWake = true;
      if (!rest) {                  // bare "hey anton"
        this._wakeUp(false);
        return;
      }
      this._wakeUp(true);           // "hey anton, <command>" — no "Yes?"
      phrase = rest;
    } else {
      // Already awake: a wake phrase may still prefix the command; strip it.
      const rest = this._matchWake(phrase);
      if (rest !== null) { phrase = rest || phrase; viaWake = true; }
      if (this.settings.wakeMode === 'wake') this._wakeUp(true); // refresh window
    }

    this._processCommand(phrase, { alts, viaWake });
  }

  async _processCommand(transcript, meta = {}) {
    const normalized = String(transcript || '').toLowerCase().trim();
    if (!normalized) return;

    const local = this._parseCommand(normalized);
    if (local.intent !== 'unknown') {
      this._emit(local.intent, local.params, { ...meta, transcript, source: 'local' });
      return;
    }

    if (!this.settings.useModel) {
      this.speak("I didn't catch a command.");
      return;
    }

    this._notifyStatus({ thinking: true });
    try {
      const remote = await this.interpretRemote(transcript);
      this._notifyStatus({ thinking: false });
      if (remote && remote.intent && remote.intent !== 'unknown') {
        this._emit(remote.intent, remote.params || {}, { ...meta, transcript, source: 'model', say: remote.say });
        return;
      }
    } catch (e) {
      this._notifyStatus({ thinking: false });
      console.warn('[Voice] interpret failed:', e);
    }
    this.speak("I didn't understand that.");
  }

  _emit(intent, params, meta) {
    console.log('[Voice]', meta.source, intent, params);
    if (this.onCommand) this.onCommand(intent, params || {}, meta);
  }

  /**
   * Ask the daemon's headless model to turn free speech into an intent.
   * Hooked up by the widget (which knows the backend URL + tab list) via
   * `voice.interpretRemote = fn`; the default is a no-op so a standalone
   * VoiceControl still works offline.
   */
  async interpretRemote(_transcript) { return null; }

  // ── local intent table ────────────────────────────────────────────────
  _parseCommand(text) {
    const t = text.replace(/[.?!,]+$/, '').trim();

    // Sleep / cancel the wake window first — it must never be shadowed.
    if (/^(go to sleep|sleep|never ?mind|stop listening|forget it|cancel that)$/.test(t)) {
      return { intent: 'sleep', params: {} };
    }

    // Silence requests first: these begin with "stop" too, and the registry
    // advertises them ("stop talking", "stop reading"). Matched here so they
    // can never fall through to the interrupt below and Ctrl-C a live agent.
    // "stop speaking replies" is the TTS toggle's own advertised phrase —
    // it turns narration OFF, not just this sentence.
    if (/^stop speaking replies$/.test(t)) {
      return { intent: 'app_action', params: { actionId: 'toggle_tts' } };
    }
    if (/^(be quiet|shut up|quiet|stop (talking|reading|speaking|narrating|the voice)(\b.*)?)$/.test(t)) {
      return { intent: 'app_action', params: { actionId: 'shut_up' } };
    }

    // Control — checked early so "stop" can always stop a runaway process.
    // Anchored: a bare "stop" (or "stop it/that/the agent/…") interrupts; any
    // longer sentence starting with "stop" is not an interrupt and falls
    // through to the phrase registry / interpreter.
    if (/^(stop|interrupt|cancel|abort|control c|ctrl c)( (it|that|this|him|her|them|the (process|agent|command|run|build|job)))?$/.test(t)) {
      return { intent: 'interrupt', params: {} };
    }

    // Output / status
    if (/\b(read|say|speak|what'?s|what is|show|tell me).*(output|screen|terminal|last|happening|going on)\b/.test(t)
        || /^(read|read it|read that|read out)$/.test(t)) {
      const m = t.match(/last (\d+) lines?/);
      return { intent: 'read_output', params: { lines: m ? Number(m[1]) : 20 } };
    }
    if (/\b(any errors?|is it broken|what'?s wrong|status)\b/.test(t)) {
      return { intent: 'check_status', params: {} };
    }
    if (/\b(is it done|are we done|how far|progress|finished yet)\b/.test(t)) {
      return { intent: 'check_progress', params: {} };
    }

    // Usage / fleet — the terminal-specific asks the user called out.
    if (/\b(usage|spend|spent|cost|tokens?|burn|limit|quota|budget)\b/.test(t)) {
      const scope = /week/.test(t) ? 'week' : /today|day/.test(t) ? 'today' : 'block';
      return { intent: 'usage_report', params: { scope } };
    }
    // "fleet" alone is a STATUS question; "restore the fleet" is an action the
    // control registry owns. Without this guard the status read wins and the
    // user's recovery command silently does nothing.
    if (/\b(fleet|all (the )?(agents|tabs|sessions)|how are (the )?agents)\b/.test(t)
        && !/\b(restore|recover|bring|reopen|rebuild|fix)\b/.test(t)) {
      return { intent: 'fleet_status', params: {} };
    }

    // Model switching
    const model = t.match(/\b(?:switch|change|set|use)\b.*\bmodel\b.*?\b(opus|sonnet|haiku|fable)\b/)
               || t.match(/\bmodel\b.*?\b(opus|sonnet|haiku|fable)\b/)
               || t.match(/\b(?:switch|change) to (opus|sonnet|haiku|fable)\b/);
    if (model) return { intent: 'change_model', params: { model: model[1] } };
    if (/\b(change|switch|what) (the )?model\b/.test(t)) {
      return { intent: 'change_model', params: {} };   // no target → ask/report
    }

    // Navigation
    const tabNum = t.match(/\b(?:go to|switch to|open|show)\s+(?:tab|terminal|session)\s+(\d+)\b/)
                || t.match(/\btab\s+(\d+)\b/);
    if (tabNum) return { intent: 'switch_tab', params: { tabId: Number(tabNum[1]) } };
    if (/\bnext tab\b/.test(t)) return { intent: 'next_tab', params: {} };
    // "last tab" is deliberately NOT here: it reads as the FINAL tab, and the
    // control registry owns that. This is previous-tab only.
    if (/\b(previous|prev) tab\b/.test(t) || /\bgo back a tab\b/.test(t)) {
      return { intent: 'prev_tab', params: {} };
    }

    // App controls go here — after every specific terminal intent, but BEFORE
    // the project matcher below, whose "open|go to <anything>" is greedy
    // enough to read "open settings" as a project called "settings".
    if (typeof matchVoiceAction === 'function') {
      const hit = matchVoiceAction(t);
      if (hit) return { intent: 'app_action', params: { actionId: hit.action.id } };
    }

    const proj = t.match(/\b(?:go to|switch to|jump to|open|take me to)\s+(?:the\s+)?(.+?)\s*(?:project|repo|repository|folder|directory)?$/);
    if (proj && proj[1] && proj[1].length > 1 && !/tab|terminal/.test(proj[1])) {
      return { intent: 'switch_project', params: { query: proj[1].trim() } };
    }

    if (/^scroll up/.test(t)) return { intent: 'scroll', params: { direction: 'up', amount: 10 } };
    if (/^scroll down/.test(t)) return { intent: 'scroll', params: { direction: 'down', amount: 10 } };

    // Input
    const typeM = t.match(/^(?:type|write|enter)\s+(.+)$/);
    if (typeM) return { intent: 'type_text', params: { text: typeM[1] } };
    const runM = t.match(/^(?:run|execute)\s+(.+)$/);
    if (runM) return { intent: 'run_command', params: { command: runM[1] } };
    if (/^(press|send|hit) (enter|return)$/.test(t)) return { intent: 'send_key', params: { key: 'enter' } };
    if (/^(press|send|hit) escape$/.test(t)) return { intent: 'send_key', params: { key: 'escape' } };
    if (/^(press|send|hit) tab$/.test(t)) return { intent: 'send_key', params: { key: 'tab' } };
    if (/^(yes|yep|approve|confirm|do it|go ahead)$/.test(t)) return { intent: 'send_key', params: { key: 'enter' } };

    if (/^(clear|clean)( the)? screen$/.test(t)) return { intent: 'clear_screen', params: {} };
    if (/^(continue|keep going|carry on|proceed)$/.test(t)) return { intent: 'continue_session', params: {} };

    // Vision
    if (/\b(take|capture|grab|snap)\s+(a\s+)?(picture|photo|shot|image|screenshot)\b/.test(t)
        || /\b(look at (this|that)|what do you see|see this)\b/.test(t)) {
      return { intent: 'capture_image', params: { source: /glasses|frames|meta/.test(t) ? 'glasses' : 'camera' } };
    }

    // Verbosity
    if (/\b(be )?(brief|short|concise)\b/.test(t)) return { intent: 'set_verbosity', params: { level: 'brief' } };
    if (/\b(be )?(detailed|verbose|more detail)\b/.test(t)) return { intent: 'set_verbosity', params: { level: 'detailed' } };

    if (/^(help|what can you do|commands|what can i say)$/.test(t)) return { intent: 'help', params: {} };

    return { intent: 'unknown', params: {} };
  }

  // ── speech synthesis ──────────────────────────────────────────────────
  speak(text, options = {}) {
    if (!this.synthesis || !text) return false;
    if (this.isSpeaking) this.synthesis.cancel();

    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = this.settings.language;
    u.rate = options.rate || this.settings.rate;
    u.pitch = options.pitch || this.settings.pitch;
    u.volume = options.volume != null ? options.volume : this.settings.volume;

    const voice = this._resolveVoice();
    if (voice) u.voice = voice;

    u.onstart = () => { this.isSpeaking = true; this.currentUtterance = u; this._notifyStatus({ speaking: true }); };
    u.onend = () => {
      this.isSpeaking = false; this.currentUtterance = null;
      this._lastSpokenAt = Date.now();
      this._notifyStatus({ speaking: false });
    };
    u.onerror = () => {
      this.isSpeaking = false; this.currentUtterance = null;
      this._lastSpokenAt = Date.now();
      this._notifyStatus({ speaking: false });
    };

    this.synthesis.speak(u);
    return true;
  }

  stopSpeaking() {
    if (this.synthesis && this.isSpeaking) {
      this.synthesis.cancel();
      this.isSpeaking = false;
      this.currentUtterance = null;
      this._lastSpokenAt = Date.now();
      this._notifyStatus({ speaking: false });
    }
  }

  _resolveVoice() {
    if (!this.settings.voiceURI) return null;
    const voices = this.getAvailableVoices();
    return voices.find(v => v.voiceURI === this.settings.voiceURI) || null;
  }

  getAvailableVoices() {
    try { return this.synthesis ? this.synthesis.getVoices() : []; } catch (_) { return []; }
  }

  // ── settings ──────────────────────────────────────────────────────────
  _loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('soa-voice-settings') || 'null');
      if (saved && typeof saved === 'object') Object.assign(this.settings, saved);
    } catch (_) {}
  }

  saveSettings() {
    this.settings.verbosity = this.verbosity;
    try { localStorage.setItem('soa-voice-settings', JSON.stringify(this.settings)); } catch (_) {}
  }

  set(key, value) {
    this.settings[key] = value;
    if (key === 'verbosity') this.verbosity = value;
    if (key === 'language' && this.recognition) this.recognition.lang = value;
    if (key === 'wakeMode') this.awake = value === 'always' && this.isEnabled;
    this.saveSettings();
    this._notifyStatus({});
  }

  setVerbosity(level) { this.set('verbosity', level); }
  setRate(rate) { this.set('rate', Math.max(0.5, Math.min(2.0, Number(rate) || 1))); }
  setVoice(voiceURI) { this.set('voiceURI', voiceURI || null); }
  setWakeWord(word) { this.set('wakeWord', String(word || '').toLowerCase().trim() || 'hey anton'); }

  // ── notifications ─────────────────────────────────────────────────────
  _notifyStatus(extra) {
    if (!this.onStatusChange) return;
    this.onStatusChange({
      listening: this.isListening,
      speaking: this.isSpeaking,
      enabled: this.isEnabled,
      awake: this.awake,
      wakeMode: this.settings.wakeMode,
      wakeWord: this.settings.wakeWord,
      ...extra,
    });
  }

  _notifyError(message) {
    console.warn('[Voice]', message);
    if (this.onError) this.onError({ type: 'general', message });
  }
}

// Ordinary words that are within two edits of a short wake name. Kept small
// and English-only on purpose: the wake phrase is user-configurable, and this
// only guards the fuzzy path (an exact name always matches).
// The only words allowed to precede the wake phrase.
VoiceControl.WAKE_FILLERS = new Set(['okay', 'ok', 'so', 'um', 'uh', 'well', 'alright', 'hey', 'yo', 'and']);

VoiceControl.WAKE_DENY = new Set([
  'anyone', 'anything', 'anybody', 'anon', 'annoy', 'antler', 'antsy', 'anyhow',
  'anno', 'annum', 'anion', 'anent',
  // Real names two edits from the default wake name.
  'anthony', 'antonio', 'antonia', 'antony', 'antoni',
]);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VoiceControl, VOICE_DEFAULTS };
}
