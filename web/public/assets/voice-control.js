/**
 * Voice Control for Son of Anton
 * Hands-free terminal interaction via speech recognition + TTS
 */

class VoiceControl {
  constructor() {
    this.recognition = null;
    this.synthesis = window.speechSynthesis;
    this.isListening = false;
    this.isEnabled = false;
    this.isSpeaking = false;
    this.verbosity = 'brief'; // 'brief' | 'detailed'
    this.currentUtterance = null;

    // Callbacks
    this.onCommand = null; // (intent, params) => void
    this.onStatusChange = null; // (status) => void
    this.onError = null; // (error) => void

    // Settings
    this.settings = {
      language: 'en-US',
      continuous: true,
      interimResults: true,
      maxAlternatives: 1,
      voice: null, // Auto-select
      rate: 1.0,
      pitch: 1.0,
      volume: 1.0
    };

    this._initRecognition();
    this._loadSettings();
  }

  _initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.error('Speech recognition not supported');
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = this.settings.continuous;
    this.recognition.interimResults = this.settings.interimResults;
    this.recognition.maxAlternatives = this.settings.maxAlternatives;
    this.recognition.lang = this.settings.language;

    this.recognition.onstart = () => {
      this.isListening = true;
      this._notifyStatus({ listening: true });
    };

    this.recognition.onend = () => {
      this.isListening = false;
      this._notifyStatus({ listening: false });

      // Auto-restart if still enabled
      if (this.isEnabled && this.settings.continuous) {
        setTimeout(() => {
          if (this.isEnabled) this.start();
        }, 100);
      }
    };

    this.recognition.onresult = (event) => {
      const results = event.results;
      const lastResult = results[results.length - 1];

      if (lastResult.isFinal) {
        const transcript = lastResult[0].transcript.trim();
        console.log('[Voice] Transcript:', transcript);
        this._processCommand(transcript);
      }
    };

    this.recognition.onerror = (event) => {
      console.error('[Voice] Recognition error:', event.error);
      if (this.onError) {
        this.onError({ type: 'recognition', error: event.error });
      }

      // Auto-restart on network errors, but not on no-speech
      if (event.error !== 'no-speech' && this.isEnabled) {
        setTimeout(() => {
          if (this.isEnabled) this.start();
        }, 1000);
      }
    };
  }

  _loadSettings() {
    try {
      const saved = localStorage.getItem('soa-voice-settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        Object.assign(this.settings, parsed);
        this.verbosity = parsed.verbosity || 'brief';
      }
    } catch (e) {
      console.warn('[Voice] Failed to load settings:', e);
    }
  }

  saveSettings() {
    try {
      localStorage.setItem('soa-voice-settings', JSON.stringify({
        ...this.settings,
        verbosity: this.verbosity
      }));
    } catch (e) {
      console.warn('[Voice] Failed to save settings:', e);
    }
  }

  start() {
    if (!this.recognition) {
      this._notifyError('Speech recognition not available');
      return false;
    }

    if (this.isListening) return true;

    try {
      this.isEnabled = true;
      this.recognition.start();
      return true;
    } catch (e) {
      console.error('[Voice] Failed to start recognition:', e);
      this._notifyError('Failed to start listening: ' + e.message);
      return false;
    }
  }

  stop() {
    this.isEnabled = false;
    if (this.recognition && this.isListening) {
      this.recognition.stop();
    }
    this.stopSpeaking();
  }

  speak(text, options = {}) {
    if (!this.synthesis) {
      console.warn('[Voice] Speech synthesis not available');
      return false;
    }

    // Stop any current speech
    if (this.isSpeaking) {
      this.synthesis.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = this.settings.language;
    utterance.rate = options.rate || this.settings.rate;
    utterance.pitch = options.pitch || this.settings.pitch;
    utterance.volume = options.volume || this.settings.volume;

    if (this.settings.voice) {
      utterance.voice = this.settings.voice;
    }

    utterance.onstart = () => {
      this.isSpeaking = true;
      this.currentUtterance = utterance;
      this._notifyStatus({ speaking: true });
    };

    utterance.onend = () => {
      this.isSpeaking = false;
      this.currentUtterance = null;
      this._notifyStatus({ speaking: false });
    };

    utterance.onerror = (event) => {
      console.error('[Voice] Speech error:', event);
      this.isSpeaking = false;
      this.currentUtterance = null;
      this._notifyStatus({ speaking: false });
    };

    this.synthesis.speak(utterance);
    return true;
  }

  stopSpeaking() {
    if (this.synthesis && this.isSpeaking) {
      this.synthesis.cancel();
      this.isSpeaking = false;
      this.currentUtterance = null;
      this._notifyStatus({ speaking: false });
    }
  }

  _processCommand(transcript) {
    const normalized = transcript.toLowerCase().trim();

    // Parse intent and parameters
    const parsed = this._parseCommand(normalized);

    if (parsed.intent === 'unknown') {
      this.speak("I didn't understand that command.");
      return;
    }

    console.log('[Voice] Parsed:', parsed);

    // Notify handler
    if (this.onCommand) {
      this.onCommand(parsed.intent, parsed.params);
    }
  }

  _parseCommand(text) {
    // Status checks
    if (/^(read|what's|what is|show|tell me).*output/.test(text) ||
        /^(read|what's|show).*last/.test(text)) {
      return { intent: 'read_output', params: { scope: 'last', lines: 20 } };
    }

    if (/^(what's|what is|status|check).*happening/.test(text) ||
        /^(any|what).*error/.test(text)) {
      return { intent: 'check_status', params: {} };
    }

    if (/^(is it|are we).*done/.test(text) || /^(check|tell me).*progress/.test(text)) {
      return { intent: 'check_progress', params: {} };
    }

    // Navigation
    const tabMatch = text.match(/^(go to|switch to|open).*(?:tab|terminal)\s+(\d+)/);
    if (tabMatch) {
      return { intent: 'switch_tab', params: { tabId: parseInt(tabMatch[2], 10) } };
    }

    if (/^(next|switch).*tab/.test(text)) {
      return { intent: 'next_tab', params: {} };
    }

    if (/^(previous|back).*tab/.test(text)) {
      return { intent: 'prev_tab', params: {} };
    }

    if (/^scroll up/.test(text)) {
      return { intent: 'scroll', params: { direction: 'up', amount: 10 } };
    }

    if (/^scroll down/.test(text)) {
      return { intent: 'scroll', params: { direction: 'down', amount: 10 } };
    }

    // Input commands
    const typeMatch = text.match(/^type\s+(.+)$/);
    if (typeMatch) {
      return { intent: 'type_text', params: { text: typeMatch[1] } };
    }

    const runMatch = text.match(/^run\s+(.+)$/);
    if (runMatch) {
      return { intent: 'run_command', params: { command: runMatch[1] } };
    }

    if (/^(press|send|hit).*enter/.test(text)) {
      return { intent: 'send_key', params: { key: 'enter' } };
    }

    // Control
    if (/^(stop|interrupt|cancel)/.test(text)) {
      return { intent: 'interrupt', params: {} };
    }

    if (/^(clear|clean).*screen/.test(text)) {
      return { intent: 'clear_screen', params: {} };
    }

    if (/^continue/.test(text) || /^keep going/.test(text)) {
      return { intent: 'continue_session', params: {} };
    }

    if (/^(start|begin).*new/.test(text)) {
      return { intent: 'new_session', params: {} };
    }

    // Help
    if (/^(help|what can|commands)/.test(text)) {
      return { intent: 'help', params: {} };
    }

    return { intent: 'unknown', params: {} };
  }

  _notifyStatus(status) {
    if (this.onStatusChange) {
      this.onStatusChange({
        listening: this.isListening,
        speaking: this.isSpeaking,
        enabled: this.isEnabled,
        ...status
      });
    }
  }

  _notifyError(message) {
    if (this.onError) {
      this.onError({ type: 'general', message });
    }
  }

  getAvailableVoices() {
    return this.synthesis ? this.synthesis.getVoices() : [];
  }

  setVoice(voiceURI) {
    const voices = this.getAvailableVoices();
    const voice = voices.find(v => v.voiceURI === voiceURI);
    if (voice) {
      this.settings.voice = voice;
      this.saveSettings();
    }
  }

  setVerbosity(level) {
    this.verbosity = level;
    this.saveSettings();
  }

  setRate(rate) {
    this.settings.rate = Math.max(0.5, Math.min(2.0, rate));
    this.saveSettings();
  }
}

// Export for use in main app
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VoiceControl;
}
