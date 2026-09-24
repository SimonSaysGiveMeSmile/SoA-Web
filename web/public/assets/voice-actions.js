/**
 * The app-control registry — every dashboard control voice can reach.
 *
 * Voice used to be able to talk to the *terminal* only: read it, type into it,
 * interrupt it. Everything the mouse can do — switch to the fleet view, open
 * Time Machine, hide the sidebar, flip the theme, mute the sound — was off
 * limits. This table closes that gap, and it is a table rather than a switch
 * statement for three reasons:
 *
 *   - It is the SPOKEN VOCABULARY. Each entry carries the phrasings a person
 *     actually uses ("fleet view", "show me the fleet", "manager view"), so the
 *     zero-latency local matcher can hit them without a model round-trip.
 *   - It is the LIST THE USER READS. The widget renders these as the "what can
 *     I say" panel, so the feature is discoverable instead of guessed at.
 *   - It is the MODEL'S MENU. The ids and labels are handed to the headless
 *     interpreter, so free speech ("get me out of this view") resolves to a
 *     real action id rather than a hallucinated one.
 *
 * Actions prefer clicking the real control over calling a Shell method. A
 * button click goes through the app's own handler — audio cue, persisted
 * state, aria sync — so voice and mouse can never drift apart. Shell methods
 * are the fallback for things with no button.
 */

const VOICE_ACTIONS = [
  // ── views ─────────────────────────────────────────────────────────────
  {
    id: 'view_terminal', label: 'Terminal view', group: 'View',
    phrases: ['terminal view', 'show the terminal', 'back to the terminal', 'normal view', 'tab view'],
    click: '#view-terminal', say: 'Terminal view.',
  },
  {
    id: 'view_tiles', label: 'Tiles view', group: 'View',
    phrases: ['tiles', 'tile view', 'tiles view', 'show all agents', 'grid view', 'dashboard view'],
    click: '#view-tiles', say: 'Tiles.',
  },
  {
    id: 'view_fleet', label: 'Fleet manager view', group: 'View',
    phrases: ['fleet view', 'fleet', 'manager view', 'show the fleet', 'show me the fleet'],
    click: '#view-manager', say: 'Fleet view.',
  },
  {
    id: 'view_chat', label: 'Chat view', group: 'View',
    phrases: ['chat view', 'open chat', 'show chat', 'messages'],
    click: '#view-chat', say: 'Chat.',
  },
  {
    id: 'view_monitor', label: 'Monitor view', group: 'View',
    phrases: ['monitor view', 'monitor', 'show the browsers', 'preview view'],
    click: '#view-monitor', say: 'Monitor.',
  },

  // ── chrome ────────────────────────────────────────────────────────────
  {
    id: 'toggle_sidebar', label: 'Show/hide sidebar', group: 'Layout',
    phrases: ['toggle the sidebar', 'hide the sidebar', 'show the sidebar', 'sidebar'],
    click: '#toggle-sidebar', say: 'Sidebar.',
  },
  {
    id: 'toggle_toolbar', label: 'Show/hide toolbar', group: 'Layout',
    phrases: ['toggle the toolbar', 'hide the toolbar', 'show the toolbar'],
    click: '#toggle-actions', say: 'Toolbar.',
  },
  {
    id: 'toggle_theme', label: 'Light / dark theme', group: 'Layout',
    phrases: ['toggle the theme', 'switch the theme', 'dark mode', 'light mode', 'flip the theme'],
    click: '#toggle-theme', say: 'Theme switched.',
  },
  {
    id: 'open_settings', label: 'Settings', group: 'Layout',
    phrases: ['open settings', 'settings', 'preferences', 'open preferences'],
    click: '#user-chip', say: 'Settings.',
  },
  {
    id: 'fullscreen', label: 'Full screen', group: 'Layout',
    phrases: ['full screen', 'fullscreen', 'go full screen', 'exit full screen'],
    say: 'Full screen.',
    run: () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    },
  },

  // ── tabs ──────────────────────────────────────────────────────────────
  {
    id: 'new_tab', label: 'New tab', group: 'Tabs',
    phrases: ['new tab', 'open a new tab', 'new terminal', 'another terminal'],
    click: '#new-tab', say: 'Pick a folder.',
  },
  {
    id: 'close_tab', label: 'Close this tab', group: 'Tabs',
    phrases: ['close this tab', 'close the tab', 'close this terminal'],
    say: 'Closing.',
    run: (shell) => { if (shell && shell.activeId != null) shell._requestCloseTab(shell.activeId); },
  },
  {
    id: 'restore_tab', label: 'Reopen closed tab', group: 'Tabs',
    phrases: ['reopen the tab', 'restore the tab', 'undo close', 'bring that tab back'],
    say: 'Reopening.',
    run: (shell) => { if (shell) shell._restoreClosedTab(); },
  },
  {
    id: 'first_tab', label: 'First tab', group: 'Tabs',
    phrases: ['first tab', 'go to the first tab', 'back to the first tab'],
    say: 'First tab.',
    run: (shell) => { if (shell && shell.order.length) shell._activate(shell.order[0]); },
  },
  {
    id: 'last_tab', label: 'Last tab', group: 'Tabs',
    phrases: ['last tab', 'go to the last tab', 'the final tab'],
    say: 'Last tab.',
    run: (shell) => { if (shell && shell.order.length) shell._activate(shell.order[shell.order.length - 1]); },
  },

  // ── fleet ─────────────────────────────────────────────────────────────
  {
    id: 'broadcast', label: 'Broadcast to terminals', group: 'Fleet',
    phrases: ['broadcast', 'send to everyone', 'send to all terminals', 'open broadcast'],
    click: '#broadcast', say: 'Broadcast.',
  },
  {
    id: 'time_machine', label: 'Time Machine', group: 'Fleet',
    phrases: ['time machine', 'open time machine', 'restore a snapshot'],
    click: '#timemachine', say: 'Time machine.',
  },
  {
    id: 'restore_fleet', label: 'Restore the fleet', group: 'Fleet',
    phrases: ['restore the fleet', 'bring the tabs back', 'recover my terminals', 'restore my sessions'],
    say: 'Restoring the fleet.',
    // The one action here that changes real state on its own, so it reports
    // what it actually did rather than assuming.
    run: async (shell, ctx) => {
      const r = await fetch(ctx.api('/api/fleet/restore'), {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const j = await r.json().catch(() => ({}));
      const n = (j.opened && j.opened.length) || j.restored || 0;
      return n ? `Restored ${n} tabs.` : 'Nothing to restore.';
    },
  },

  // ── audio ─────────────────────────────────────────────────────────────
  {
    id: 'toggle_sound', label: 'Mute / unmute sound FX', group: 'Audio',
    phrases: ['mute the sound', 'unmute the sound', 'mute sound effects', 'toggle sound'],
    click: '#toggle-audio', say: 'Sound toggled.',
  },
  {
    id: 'toggle_tts', label: 'Speak replies aloud', group: 'Audio',
    phrases: ['read replies aloud', 'speak replies', 'stop speaking replies', 'toggle speech'],
    click: '#toggle-tts', say: 'Speech toggled.',
  },
  {
    id: 'shut_up', label: 'Stop talking', group: 'Audio',
    phrases: ['be quiet', 'shut up', 'stop talking', 'quiet', 'stop reading'],
    say: null,            // silence is the confirmation
    run: (shell, ctx) => { ctx.voice.stopSpeaking(); },
  },

  // ── terminal view ─────────────────────────────────────────────────────
  {
    id: 'scroll_bottom', label: 'Jump to the latest output', group: 'Terminal',
    phrases: ['scroll to the bottom', 'jump to the bottom', 'go to the latest', 'follow the output'],
    say: 'Bottom.',
    run: (shell) => { const rt = shell && shell.tabs.get(shell.activeId); if (rt && rt.term) rt.term.scrollToBottom(); },
  },
  {
    id: 'scroll_top', label: 'Jump to the top', group: 'Terminal',
    phrases: ['scroll to the top', 'jump to the top', 'go to the beginning'],
    say: 'Top.',
    run: (shell) => { const rt = shell && shell.tabs.get(shell.activeId); if (rt && rt.term) rt.term.scrollToTop(); },
  },
  {
    id: 'bigger_text', label: 'Bigger text', group: 'Terminal',
    phrases: ['bigger text', 'increase the font', 'make it bigger', 'zoom in'],
    say: 'Bigger.',
    run: (shell) => VOICE_ACTIONS_font(shell, +1),
  },
  // ── settings the mouse could reach but voice could not ────────────────
  {
    id: 'volume_up', label: 'Volume up', group: 'Settings',
    phrases: ['volume up', 'louder', 'turn it up', 'turn the volume up', 'increase the volume'],
    run: () => VOICE_ACTIONS_volume(+0.1),
  },
  {
    id: 'volume_down', label: 'Volume down', group: 'Settings',
    phrases: ['volume down', 'quieter', 'turn it down', 'turn the volume down', 'lower the volume'],
    run: () => VOICE_ACTIONS_volume(-0.1),
  },
  {
    id: 'skin_tron', label: 'Terminal-classic skin', group: 'Settings',
    phrases: ['tron skin', 'classic skin', 'terminal skin', 'switch to tron'],
    run: () => VOICE_ACTIONS_skin('tron'),
  },
  {
    id: 'skin_minimal', label: 'Minimal skin', group: 'Settings',
    phrases: ['minimal skin', 'switch to minimal', 'porcelain skin'],
    run: () => VOICE_ACTIONS_skin('minimal'),
  },
  {
    id: 'skin_liquid', label: 'Liquid-glass skin', group: 'Settings',
    phrases: ['liquid skin', 'liquid glass', 'switch to liquid', 'glass skin'],
    run: () => VOICE_ACTIONS_skin('liquid'),
  },
  {
    id: 'smaller_text', label: 'Smaller text', group: 'Terminal',
    phrases: ['smaller text', 'decrease the font', 'make it smaller', 'zoom out'],
    say: 'Smaller.',
    run: (shell) => VOICE_ACTIONS_font(shell, -1),
  },
];

// Settings that voice can change go through the app's own saveSettings, reached
// via the window bridge settings.js publishes. That path normalizes (clamps the
// volume, coerces the skin enum), re-applies the cursor/ui attributes and fires
// `soa:settings`, which is what makes the change land live AND survive a reload.
// Writing localStorage directly would skip all three.
function VOICE_ACTIONS_settings() {
  try { return (typeof window !== 'undefined' && window.__soaSettings) || null; } catch (_) { return null; }
}

// Pure so it can be tested without a DOM. Volume is 0..1; a tenth per step is
// one comfortable press, and clamping here means "louder" at max is a no-op
// rather than an out-of-range write normalize() would have to catch.
function VOICE_ACTIONS_volumeStep(current, delta) {
  const n = Number(current);
  const base = Number.isFinite(n) ? n : 1;
  return Math.max(0, Math.min(1, Math.round((base + delta) * 100) / 100));
}

function VOICE_ACTIONS_volume(delta) {
  const api = VOICE_ACTIONS_settings();
  if (!api) return 'Settings are not available.';
  const next = VOICE_ACTIONS_volumeStep(api.getSettings().audioVolume, delta);
  api.saveSettings({ audioVolume: next });
  return next === 0 ? 'Volume off.' : 'Volume ' + Math.round(next * 100) + ' percent.';
}

function VOICE_ACTIONS_skin(skin) {
  const api = VOICE_ACTIONS_settings();
  if (!api) return 'Settings are not available.';
  api.saveSettings({ uiLang: skin });
  return skin + ' skin.';
}

// Font size lives in the settings blob and on every live xterm; nudging both
// keeps the change after a reload instead of snapping back.
function VOICE_ACTIONS_font(shell, delta) {
  if (!shell) return;
  try {
    const key = 'soa_web_settings';
    const s = JSON.parse(localStorage.getItem(key) || '{}');
    const next = Math.max(8, Math.min(28, (Number(s.termFontSize) || 13) + delta));
    s.termFontSize = next;
    localStorage.setItem(key, JSON.stringify(s));
    for (const rt of shell.tabs.values()) {
      if (rt.term) { rt.term.options.fontSize = next; try { rt.fit.fit(); } catch (_) {} }
    }
  } catch (_) {}
}

/**
 * Match a spoken phrase against the registry.
 *
 * Exact-ish first (a phrase the user clearly said), then containment, then
 * token overlap. The floor is deliberately high: a wrong app action yanks the
 * user's whole view, which is far more disruptive than "I didn't catch that".
 */
function matchVoiceAction(said) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const t = norm(said);
  if (!t) return null;

  let best = null, bestScore = 0;
  for (const action of VOICE_ACTIONS) {
    for (const phrase of action.phrases) {
      const p = norm(phrase);
      let score = 0;
      if (t === p) score = 1;
      else if (t.startsWith(p) || p.startsWith(t)) score = 0.92;
      else if (t.includes(p)) score = 0.85;
      else {
        const pt = p.split(' ').filter(w => w.length > 2);
        if (!pt.length) continue;
        const hit = pt.filter(w => t.includes(w)).length;
        score = (hit / pt.length) * 0.7;
      }
      if (score > bestScore) { bestScore = score; best = action; }
    }
  }
  return bestScore >= 0.8 ? { action: best, score: bestScore } : null;
}

function voiceActionById(id) {
  return VOICE_ACTIONS.find(a => a.id === id) || null;
}

/** The compact menu handed to the headless interpreter. */
function voiceActionMenu() {
  return VOICE_ACTIONS.map(a => `${a.id}: ${a.label}`);
}

/** Grouped for the widget's "what can I say" panel. */
function voiceActionGroups() {
  const out = new Map();
  for (const a of VOICE_ACTIONS) {
    if (!out.has(a.group)) out.set(a.group, []);
    out.get(a.group).push(a);
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VOICE_ACTIONS, matchVoiceAction, voiceActionById, voiceActionMenu, voiceActionGroups,
    VOICE_ACTIONS_volumeStep };
}
