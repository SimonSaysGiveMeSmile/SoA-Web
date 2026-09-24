/**
 * Voice intent executor — turns a parsed intent into terminal action.
 *
 * VoiceControl decides WHAT was asked; this decides what that means against
 * the live Shell. It is deliberately the only file that knows about tabs,
 * the WebSocket bridge and the daemon's HTTP API, so the parser stays testable
 * and the widget stays presentational.
 *
 * Two things here are less obvious than they look:
 *
 *  - SUBMIT IS TWO WRITES. Claude Code's TUI treats a CR glued to the text as a
 *    pasted newline, not a submit. Every place that types a line therefore
 *    writes the text, waits ~160ms, then writes '\r' — the same split the
 *    server's submitToTab does for the manager CLI.
 *
 *  - PROJECT MATCHING IS FUZZY ON PURPOSE. "go to the iPlan project" arrives as
 *    "eye plan", "i plan", "iplan" depending on the browser. We score against
 *    both the tab title and the cwd basename, compare de-spaced, and accept a
 *    substring hit — a wrong tab is recoverable, a silent no-op is not.
 */

const VOICE_MODELS = {
  opus: 'opus', sonnet: 'sonnet', haiku: 'haiku', fable: 'fable',
};

class VoiceCommands {
  /**
   * @param {object} o
   * @param {VoiceControl} o.voice
   * @param {function(string):string} o.api  path → absolute URL (adds token)
   */
  constructor({ voice, api }) {
    this.voice = voice;
    this.api = api;
    this._tabsCache = { at: 0, tabs: [] };
    this._projectsCache = { at: 0, projects: [] };
    this.onLog = null;    // (line) => void, for the widget's transcript area
  }

  // ── environment ───────────────────────────────────────────────────────
  get shell() { return (window.__SOA_WEB__ || {})._shell || null; }
  get bridge() { return (window.__SOA_WEB__ || {})._bridge || null; }

  get activeId() {
    const sh = this.shell;
    return sh ? sh.activeId : null;
  }

  activeRuntime() {
    const sh = this.shell;
    if (!sh || sh.activeId == null) return null;
    return sh.tabs.get(sh.activeId) || null;
  }

  _say(text) {
    if (this.onLog) this.onLog(text);
    this.voice.speak(text);
  }

  _write(text, { id = null, submit = false } = {}) {
    const bridge = this.bridge;
    const tabId = id == null ? this.activeId : id;
    if (!bridge || tabId == null) return false;
    bridge.input('term-keys', { id: tabId, text });
    if (submit) setTimeout(() => bridge.input('term-keys', { id: tabId, text: '\r' }), 160);
    return true;
  }

  async _json(path, init) {
    const r = await fetch(this.api(path), { credentials: 'include', ...init });
    if (!r.ok) throw new Error(path + ' → ' + r.status);
    return r.json();
  }

  /** Tab list with cwds — the Shell only knows titles, /api/tabs knows paths. */
  async tabs(maxAgeMs = 4000) {
    if (Date.now() - this._tabsCache.at < maxAgeMs) return this._tabsCache.tabs;
    try {
      const j = await this._json('/api/tabs');
      const list = (j.tabs || j || []).map(t => ({
        id: t.id, title: t.title || '', cwd: t.cwd || '',
      }));
      this._tabsCache = { at: Date.now(), tabs: list };
      return list;
    } catch (_) {
      // Fall back to what the Shell has locally — titles only, but enough to
      // switch tabs when the API is briefly unreachable.
      const sh = this.shell;
      if (!sh) return [];
      return sh.order.map(id => ({ id, title: (sh.tabs.get(id) || {}).title || '', cwd: '' }));
    }
  }

  async projects() {
    if (Date.now() - this._projectsCache.at < 60000) return this._projectsCache.projects;
    try {
      const j = await this._json('/api/voice/projects');
      this._projectsCache = { at: Date.now(), projects: j.projects || [] };
      return this._projectsCache.projects;
    } catch (_) { return []; }
  }

  // ── fuzzy matching ────────────────────────────────────────────────────
  static score(query, candidate) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const q = norm(query), c = norm(candidate);
    if (!q || !c) return 0;
    if (q === c) return 1;
    if (c.startsWith(q) || q.startsWith(c)) return 0.9;
    if (c.includes(q)) return 0.8;
    if (q.includes(c)) return 0.7;
    // Token overlap: "summer twenty twenty six" vs "Summer-2026".
    const qt = String(query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const hit = qt.filter(w => w.length > 2 && c.includes(w)).length;
    return qt.length ? (hit / qt.length) * 0.6 : 0;
  }

  static bestMatch(query, items, keys) {
    let best = null, bestScore = 0;
    for (const it of items) {
      for (const k of keys) {
        const v = k === 'basename'
          ? String(it.cwd || it.path || '').split('/').filter(Boolean).pop()
          : it[k];
        const s = VoiceCommands.score(query, v);
        if (s > bestScore) { bestScore = s; best = it; }
      }
    }
    return bestScore >= 0.5 ? { item: best, score: bestScore } : null;
  }

  // ── terminal reading ──────────────────────────────────────────────────
  readTerminal(lines = 20) {
    const rt = this.activeRuntime();
    if (!rt || !rt.term) return '';
    try {
      const buf = rt.term.buffer.active;
      const end = buf.baseY + buf.cursorY;
      const start = Math.max(0, end - lines);
      let out = '';
      for (let i = start; i <= end; i++) {
        const line = buf.getLine(i);
        if (line) out += line.translateToString(true) + '\n';
      }
      return out;
    } catch (_) { return ''; }
  }

  // ── dispatch ──────────────────────────────────────────────────────────
  async handle(intent, params = {}, meta = {}) {
    try {
      const fn = this['do_' + intent];
      if (typeof fn !== 'function') {
        this._say("I don't know how to do that yet.");
        return;
      }
      await fn.call(this, params, meta);
    } catch (e) {
      console.error('[Voice] intent failed', intent, e);
      this._say('That failed. ' + (e.message || ''));
    }
  }

  // ── intents: reading ──────────────────────────────────────────────────
  async do_read_output(params) {
    const out = this.readTerminal(params.lines || 20);
    if (!out.trim()) return this._say('The terminal is empty.');
    const text = (typeof SpeechUtils !== 'undefined')
      ? SpeechUtils.formatForSpeech(out, this.voice.verbosity)
      : out.split('\n').slice(-3).join('. ');
    this._say(text);
  }

  async do_check_status() {
    const out = this.readTerminal(14);
    if (!out.trim()) return this._say('Nothing on screen.');
    if (/error|failed|fatal|exception|traceback/i.test(out)) return this._say('There are errors on screen.');
    if (/\besc to interrupt\b|·\s*\d+s|running|building|installing/i.test(out)) return this._say('It is working.');
    if (/\?\s*$|\(y\/n\)|❯|\[1\]/im.test(out.trim().split('\n').slice(-3).join('\n'))) {
      return this._say('It is waiting on you.');
    }
    this._say('Idle, waiting for input.');
  }

  async do_check_progress() {
    const out = this.readTerminal(8);
    const pct = out.match(/(\d{1,3})\s?%/);
    if (pct) return this._say('About ' + pct[1] + ' percent.');
    if (/done|complete|finished|✓/i.test(out)) return this._say('Looks done.');
    const secs = out.match(/(\d+)s\b/);
    if (secs) return this._say('Still working, ' + secs[1] + ' seconds in.');
    this._say('Still working on it.');
  }

  // ── intents: navigation ───────────────────────────────────────────────
  async do_switch_tab(params) {
    const sh = this.shell;
    const id = Number(params.tabId);
    if (!sh || !sh.tabs.has(id)) return this._say('No tab ' + id + '.');
    sh._activate(id);
    const rt = sh.tabs.get(id);
    this._say('Tab ' + id + ', ' + ((rt && rt.title) || ''));
  }

  async do_next_tab() {
    const sh = this.shell;
    if (!sh || !sh.order.length) return this._say('No tabs.');
    const i = sh.order.indexOf(sh.activeId);
    const next = sh.order[(i + 1) % sh.order.length];
    sh._activate(next);
    this._say(((sh.tabs.get(next) || {}).title) || ('Tab ' + next));
  }

  async do_prev_tab() {
    const sh = this.shell;
    if (!sh || !sh.order.length) return this._say('No tabs.');
    const i = sh.order.indexOf(sh.activeId);
    const prev = sh.order[(i - 1 + sh.order.length) % sh.order.length];
    sh._activate(prev);
    this._say(((sh.tabs.get(prev) || {}).title) || ('Tab ' + prev));
  }

  async do_switch_project(params, meta = {}) {
    const query = String(params.query || '').trim();
    if (!query) return this._say('Which project?');
    const tabs = await this.tabs();
    const hit = VoiceCommands.bestMatch(query, tabs, ['title', 'basename']);
    if (hit) {
      const sh = this.shell;
      if (sh && sh.tabs.has(hit.item.id)) sh._activate(hit.item.id);
      this._say(hit.item.title || ('Tab ' + hit.item.id));
      return;
    }
    // Not open — fall through to opening it, which is what the user meant.
    return this.do_open_project(params, meta);
  }

  async do_open_project(params) {
    const query = String(params.query || '').trim();
    if (!query) return this._say('Which project?');
    const projects = await this.projects();
    const hit = VoiceCommands.bestMatch(query, projects, ['name', 'basename']);
    if (!hit) return this._say("I couldn't find a project called " + query + '.');
    const bridge = this.bridge;
    const rt = this.activeRuntime();
    if (!bridge) return this._say('Not connected.');
    bridge.input('new-tab', {
      cwd: hit.item.path,
      cols: (rt && rt.term && rt.term.cols) || 120,
      rows: (rt && rt.term && rt.term.rows) || 30,
    });
    this._say('Opening ' + hit.item.name + '.');
  }

  async do_scroll(params) {
    const rt = this.activeRuntime();
    if (!rt || !rt.term) return;
    const amount = params.amount || 10;
    rt.term.scrollLines(params.direction === 'up' ? -amount : amount);
  }

  // ── intents: input ────────────────────────────────────────────────────
  async do_type_text(params) {
    if (!this._write(String(params.text || ''))) return this._say('No terminal.');
    this._say('Typed.');
  }

  async do_run_command(params) {
    const cmd = String(params.command || '').trim();
    if (!cmd) return this._say('Run what?');
    if (!this._write(cmd, { submit: true })) return this._say('No terminal.');
    this._say('Running ' + cmd + '.');
  }

  async do_new_goal(params) {
    const text = String(params.text || '').trim();
    if (!text) return this._say('What should it work on?');
    // /goal is the Claude Code slash command the fleet uses for "here is your
    // objective"; a plain prompt would work too but loses the framing.
    if (!this._write('/goal ' + text, { submit: true })) return this._say('No terminal.');
    this._say('Sent the goal.');
  }

  async do_send_key(params) {
    const map = { enter: '\r', return: '\r', tab: '\t', escape: '\x1b', esc: '\x1b', up: '\x1b[A', down: '\x1b[B' };
    const key = map[String(params.key || '').toLowerCase()];
    if (!key) return this._say('Which key?');
    this._write(key);
  }

  async do_interrupt() {
    if (!this._write('\x03')) return this._say('No terminal.');
    this._say('Interrupted.');
  }

  async do_clear_screen() {
    this._write('clear', { submit: true });
    this._say('Cleared.');
  }

  async do_continue_session() {
    this._write('continue', { submit: true });
    this._say('Continuing.');
  }

  async do_change_model(params) {
    const m = VOICE_MODELS[String(params.model || '').toLowerCase()];
    if (!m) return this._say('Which model? Opus, Sonnet, Haiku or Fable.');
    this._write('/model ' + m, { submit: true });
    this._say('Switched to ' + m + '.');
  }

  // ── intents: telemetry ────────────────────────────────────────────────
  async do_usage_report(params) {
    let data;
    try { data = (await this._json('/api/claude-usage')).data; }
    catch (_) { return this._say('Usage data is unavailable.'); }
    if (!data || !data.hasData) return this._say('No usage recorded yet.');

    const money = (n) => '$' + (Number(n) || 0).toFixed(2);
    const scope = params.scope || 'block';

    if (scope === 'week') {
      return this._say('This week: ' + money(data.week.cost) + '.');
    }
    if (scope === 'today') {
      return this._say('Today: ' + money(data.today.cost) + ' across ' + (data.today.requests || 0) + ' requests.');
    }
    const b = data.block || {};
    if (!b.active) return this._say('No active block. Today is ' + money(data.today.cost) + '.');
    const mins = Math.round((b.remainingMs || 0) / 60000);
    const parts = ['This block: ' + money(b.cost)];
    if (b.burnRatePerMin) {
      // burnRatePerMin is tokens/min; cost velocity is the number that matters.
      const costPerMin = b.tokens && b.tokens.total ? (b.cost / b.tokens.total) * b.burnRatePerMin : 0;
      if (costPerMin > 0.01) parts.push('burning ' + money(costPerMin) + ' a minute');
    }
    parts.push(mins + ' minutes left in the window');
    const top = (data.sessions || [])[0];
    if (top && top.project) parts.push('heaviest is ' + top.project);
    this._say(parts.join(', ') + '.');
  }

  async do_fleet_status() {
    const tabs = await this.tabs(0);
    const sh = this.shell;
    if (!tabs.length) return this._say('No sessions.');
    // The Shell already classifies each tab for the tab strip; reuse it rather
    // than re-deriving status from scrollback.
    const counts = { working: 0, attention: 0, done: 0, idle: 0 };
    if (sh && sh._agentStatus) {
      for (const [, st] of sh._agentStatus) if (counts[st] !== undefined) counts[st]++;
    }
    const parts = [tabs.length + ' sessions'];
    if (counts.working) parts.push(counts.working + ' working');
    if (counts.attention) parts.push(counts.attention + ' need input');
    if (counts.done) parts.push(counts.done + ' done');
    this._say(parts.join(', ') + '.');
  }

  // ── intents: vision ───────────────────────────────────────────────────
  async do_capture_image(params) {
    if (typeof VoiceVision === 'undefined') return this._say('Vision is not loaded.');
    if (!this._vision) this._vision = new VoiceVision({ api: this.api });
    this._say('Capturing.');
    try {
      const shot = await this._vision.capture({ source: params.source || 'camera' });
      if (!shot) return this._say('No camera available.');
      const id = this.activeId;
      await this._vision.sendToTab(shot.blob, id, params.prompt || '');
      this._say('Sent the image to the agent.');
    } catch (e) {
      this._say('Capture failed. ' + (e.message || ''));
    }
  }

  // ── intents: the whole app ────────────────────────────────────────────
  /**
   * Run a registry action. Clicking the real control is preferred over calling
   * a Shell method so voice goes through the app's own handler — the sound
   * cue, the persisted state and the aria attributes all stay correct, and a
   * later refactor of that handler can't silently strand the voice path.
   */
  async do_app_action(params) {
    if (typeof voiceActionById !== 'function') return this._say('App controls are not loaded.');
    const action = voiceActionById(params.actionId);
    if (!action) return this._say("I don't have a control called that.");

    let spoken = action.say;
    if (action.click) {
      const el = document.querySelector(action.click);
      if (!el) return this._say('That control is not on screen.');
      el.click();
    } else if (typeof action.run === 'function') {
      const r = await action.run(this.shell, { api: this.api, voice: this.voice });
      if (typeof r === 'string') spoken = r;   // the action reported its own result
    }
    if (spoken) this._say(spoken);
    else if (this.onLog) this.onLog('▸ ' + action.label);
  }

  // ── intents: meta ─────────────────────────────────────────────────────
  async do_set_verbosity(params) {
    const level = params.level === 'detailed' ? 'detailed' : 'brief';
    this.voice.setVerbosity(level);
    this._say(level === 'brief' ? 'Keeping it brief.' : 'Reading in detail.');
  }

  async do_sleep() {
    this.voice.sleep();
    if (this.onLog) this.onLog('Sleeping — say the wake word.');
  }

  async do_help() {
    this._say(
      'Say the wake word, then a command. Terminal: read output, what is happening, run npm test, ' +
      'change model to opus, how is my usage, stop. Navigation: go to the iPlan project, next tab, fleet view. ' +
      'The app: hide the sidebar, dark mode, open settings, time machine. ' +
      'Open the commands list in the voice widget to see all of them.'
    );
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VoiceCommands, VOICE_MODELS };
}
