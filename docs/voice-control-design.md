# Voice control

Hands-free control of Son of Anton: the terminal, the fleet, and the dashboard
itself — plus an in-app camera for pairing and for showing an agent what you
are looking at.

The design question that shaped everything below was **what needs a key, and
what can we do without one**. The answer: nothing here needs a new API key.

| Layer | Implementation | Key | Runs |
|---|---|---|---|
| Speech → text | Web Speech API (`SpeechRecognition`) | none | browser (Chrome routes audio via Google; Safari uses Apple dictation) |
| Text → speech | `speechSynthesis`, system voices | none | fully on-device |
| Phrase → intent | regex table in `voice-control.js` | none | on-device, zero latency |
| Free speech → intent | `claude -p --model haiku` | **existing Claude Code login** | this machine |
| QR decoding | `BarcodeDetector`, else vendored jsQR | none | on-device |

Only the fourth row costs anything, and it costs Claude quota rather than a new
credential. It is the **fallback**, not the first try: the regex table answers
every common command with no model call at all, and the whole path is one
checkbox away from off.

## The three layers, cheapest first

Latency is the product here. A voice command that takes two seconds to land is
worse than reaching for the keyboard, so the pipeline is ordered by cost.

### 1. Wake word

In wake mode nothing executes until the wake phrase lands. That is not polish —
continuous recognition on a live mic in a room where the terminal is reading
output aloud will otherwise hear a command in its own speech. (Echo suppression
is belt and braces: anything arriving while speaking, or within 600 ms of
finishing, is dropped.)

The phrase is matched **fuzzily**, by edit distance over the first few words.
Browser ASR renders "hey anton" as *hey antoine*, *hay anton*, *hey anthon*,
*a anton* and a dozen other things; rejecting those makes the feature feel
broken about a third of the time. The distance budget scales with the phrase
length, so a custom wake word gets the same tolerance without matching
unrelated speech.

Both forms work:

- **"Hey Anton."** → a chime and "Yes?", then a 15-second window where
  follow-ups need no phrase. Each command refreshes the window.
- **"Hey Anton, go to the iPlan project."** → executed immediately, no "Yes?".

"Go to sleep", "never mind" and "stop listening" close the window at once.

### 2. The local phrase table

Regex, in `_parseCommand`. Zero latency, works offline, and — critically — it
is the only path that can be relied on to **stop a runaway process**, which is
why `stop` / `interrupt` / `cancel` are matched before anything else in the
cascade.

The cascade order is load-bearing and tested, because a regex cascade fails
*silently* when it is wrong:

1. sleep, interrupt
2. read output / status / progress
3. usage, fleet status
4. model switching
5. tab navigation
6. **app controls** (the registry, below)
7. project switching — greedy `open|go to <anything>`, so it must come after 6
8. typing, keys, screen, capture, verbosity, help

Two real bugs this ordering fixed: "open settings" was parsed as a project
called *settings*, and "restore the fleet" was answered with a fleet status
report instead of restoring anything.

### 3. The model

Anything the table can't place goes to `POST /api/voice/interpret`, where a
headless `claude -p --model haiku` turns the sentence into one intent. The
request carries the open tabs, the known projects, and the control registry, so
"hop over to the iPlan repo and help me finish the migration" resolves to a
real tab id and a real action id rather than something invented.

Output is one line of JSON, extracted with a brace-balancing scanner rather
than `JSON.parse` — the model answers with a fence or a trailing sentence often
enough that a naive parse loses real commands. Anything unparseable, any
timeout (9 s), any missing binary returns `{intent:'unknown'}` so the client
falls back instead of hanging.

## Controlling the whole app

Voice originally reached the terminal only — read it, type into it, interrupt
it. Everything the mouse could do was off limits. `voice-actions.js` closes
that with a registry of every dashboard control, and it is a table rather than
a switch statement because it has three jobs at once:

- **The spoken vocabulary** for the zero-latency matcher.
- **The list the user reads** — rendered as the widget's *What can I say* panel,
  so the feature is discoverable instead of guessed at. Each row is also a
  button, for when the room is too loud to talk.
- **The model's menu** — ids and labels ride along with every interpret call.

Actions prefer **clicking the real control** over calling a Shell method, so
voice goes through the app's own handler: the sound cue, the persisted state
and the aria attributes all stay correct, and voice can't drift from mouse.

| Group | Controls |
|---|---|
| View | terminal, tiles, fleet, chat, monitor |
| Layout | sidebar, toolbar, theme, settings, full screen |
| Tabs | new, close, reopen, first, last |
| Fleet | broadcast, time machine, restore the fleet |
| Audio | sound FX, speak replies, "be quiet" |
| Terminal | scroll top/bottom, bigger/smaller text |

## Audio routing — why the headset switch is server-side

**Neither Web Speech API takes a device.** `SpeechRecognition` has no
`deviceId`; `speechSynthesis` has no `sinkId`. Both follow the macOS *default*
input and output, and no web API changes their mind. A purely client-side
headset picker would be a lie — it could list devices and change nothing.

So the panel splits along the line of what is actually possible:

- **Read** — `system_profiler SPAudioDataType` and `SPBluetoothDataType`, both
  always present. Paired devices, connection state, battery, transport.
- **Write** — `blueutil --connect` and `SwitchAudioSource -t output -s`, both
  optional Homebrew tools. Missing, the panel is read-only and shows one
  copyable `brew install blueutil switchaudio-osx`; it never claims a switch
  that did not happen (`501 TOOL_MISSING` with the hint).
- **Identify** — the one per-device thing a browser genuinely owns: a test tone
  through a chosen sink via `setSinkId`, so you can tell which "Beats" in the
  list is the one on your head.

The panel also says the thing that surprises everyone: macOS drops a Bluetooth
headset to call quality (HFP/SCO) whenever the mic is live.

## Vision — glasses, cameras, phones

**Meta Ray-Bans have no camera API.** No public SDK, no web-reachable channel;
they pair as an audio device plus a proprietary companion-app link. Anyone
offering "connect your Meta glasses" from a browser is describing something
that does not exist.

Three routes that do work, degrading in that order:

1. **Watch folder** — works with Meta Ray-Bans *today*. Captures sync to the
   phone's Meta AI app; with iCloud Photos or a Finder sync they land in a
   folder on this Mac. The daemon watches it and types each new image's path
   into the agent's tab — exactly how Claude Code loads an image, the same
   trick `pasteImage.js` uses. Anything that drops a file in a folder works:
   AirDrop, a Shortcut, a capture script. The watcher seeds on existing files
   so enabling it doesn't replay your photo library into a terminal.
2. **UVC camera** — plenty of non-Meta camera glasses enumerate as a plain USB
   video device. Those appear in the camera list (flagged 👓) and capture
   directly.
3. **Phone camera** — a file input with `capture="environment"`, which works on
   iOS where `getUserMedia` in a home-screen PWA does not.

All three end the same way: bytes to `POST /api/voice/vision`, saved on the
machine running the shell, path typed into a tab.

## Mobile: pairing by camera, in-app

The phone loses its session more than anything else here — the tunnel rotates,
the token ages out, the PWA cold-starts with storage the browser evicted. The
old answer was "re-scan the QR on the desktop", which meant leaving the app for
the system camera. On iOS that hands the URL to **Safari** — a different
storage context from the home-screen PWA — so the token landed where the app
could never read it.

Now the no-token screen is a welcome screen, not a dead end:

- **Scan QR code** opens the camera *inside* the app.
- **Open the camera automatically** is a one-time opt-in: land on the welcome
  screen, camera already up. It deliberately does not re-arm after an error,
  or the camera reopens in a loop with no way out.
- **Paste a pairing link** for when the camera is denied.
- A **Re-pair** tile in the overflow sheet does the same mid-session.

On a successful scan the app **connects in place** — no navigation. Navigating
would reload the document, and from a home-screen PWA a cross-origin URL opens
the system browser, which is the exact jump-out this feature removes.
`BridgeSocket` already accepts an arbitrary origin, so the token is persisted
the way `readToken()` would and the socket is booted directly.

The parser accepts every QR shape the app has ever produced: token in the query
or hash, `#alt=` failover origin, separate `backend=`, a URL pointing at `/`
rather than `/m/`, and a bare `host:port`. Losing `alt` or `backend` on a scan
would strand the phone the next time the network flips, so both survive.

Decoding takes the native path where it exists (`BarcodeDetector` — Chrome on
Android) and falls back to **jsQR, vendored locally** rather than CDN-loaded.
iOS Safari still has no `BarcodeDetector` and iOS is the main PWA target, so
that fallback is the common path, not the exotic one. It is precached by the
service worker: the scanner's whole job is recovering a phone whose session is
dead, and a lazy fetch at that moment is one more thing that can fail.

## Files

| File | Role |
|---|---|
| `server/src/voice.js` | audio devices, Bluetooth, interpret, vision ingest, watch folder |
| `web/public/assets/voice-control.js` | recognition, wake word, phrase table |
| `web/public/assets/voice-actions.js` | the app control registry |
| `web/public/assets/voice-commands.js` | intent → terminal/app action |
| `web/public/assets/voice-audio.js` | headset & routing panel |
| `web/public/assets/voice-vision.js` | camera capture, watch-folder config |
| `web/public/assets/speech-utils.js` | terminal output → speakable text |
| `web/public/m/qrscan.js` | in-app QR scanner + pairing payload parser |
| `web/public/m/vendor/jsQR.min.js` | vendored decoder (Apache-2.0) |
| `server/test/voice.test.js` | 30 tests over the parts that fail silently |

## Endpoints

```
GET  /api/voice/config          wake word, mode, model toggle, vision config
POST /api/voice/config          update the above; applies the watch immediately
GET  /api/voice/audio           CoreAudio devices + paired Bluetooth + tooling
POST /api/voice/audio/default   set the macOS default input/output
POST /api/voice/bluetooth       connect/disconnect a paired device
POST /api/voice/interpret       free speech → intent (headless haiku)
GET  /api/voice/projects        known project directories, for "go to X"
POST /api/voice/vision          image bytes in, path out, optionally typed into a tab
GET  /api/voice/vision/status   watch state + suggested sync folders
```

## Browser support

| | Recognition | Synthesis | QR scan |
|---|---|---|---|
| Chrome / Edge desktop | ✅ | ✅ | ✅ native |
| Chrome Android | ✅ | ✅ | ✅ native |
| Safari desktop | ✅ | ✅ | jsQR |
| **iOS Safari / PWA** | ❌ | ✅ | jsQR |

iOS has no `SpeechRecognition`, so the phone gets speech *output*, the camera,
and QR pairing — not voice commands. The widget says so rather than failing
silently. Driving the fleet by voice from an iPhone would need on-device
Whisper (`transformers.js`/`whisper.cpp` via wasm, a few hundred KB to a few
MB) — no key either, but a real download, so it is a deliberate next step
rather than a default.

## Next

- On-device Whisper as an optional recognizer, closing the iOS gap.
- Per-tab voice profiles: a wake word that addresses one agent directly.
- Speaking `soa-msg` notifications through the same TTS path.
