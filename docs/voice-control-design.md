# Voice Control Feature Design

## Overview
Enable hands-free terminal interaction via voice commands with Bluetooth headset support, allowing users to interact with Son of Anton terminals without a display.

## Use Cases
1. **On the go**: User walking/driving, needs to check terminal status or give simple commands
2. **Hands-free multitasking**: User doing other work, monitors terminal via audio
3. **Accessibility**: Vision-impaired users or screen-free environments
4. **Smart glasses**: Future integration with wearable displays

## Core Components

### 1. Voice Input (Speech Recognition)
- **Web Speech API** (`webkitSpeechRecognition` / `SpeechRecognition`)
  - Continuous recognition mode
  - Language: English (en-US)
  - Interim results for responsiveness
  - Auto-restart on silence/error

- **Wake word detection** (optional future enhancement)
  - "Hey Anton" or "Okay Anton" to activate
  - Prevents accidental command triggers

### 2. Command Parser
- **Lightweight NLU** (on-device, no network)
  - Pattern matching for terminal commands
  - Intent classification: status check, navigation, input, control
  
- **Command categories**:
  ```
  Status:     "read output", "what's happening", "any errors"
  Navigation: "switch to tab 5", "go to terminal 2"
  Input:      "type hello world", "send enter", "run ls"
  Control:    "interrupt", "clear screen", "scroll up/down"
  Session:    "continue", "start new task"
  ```

### 3. Voice Output (Text-to-Speech)
- **Web Speech API** (`speechSynthesis`)
  - Summarize terminal output (not read raw dumps)
  - Status updates: "Working on it", "Task complete", "Needs your input"
  - Error notifications
  - Configurable verbosity (brief/detailed)

- **Output filtering**:
  - Extract meaningful content (last command result, error messages, prompts)
  - Skip ANSI codes, progress bars, repetitive logs
  - Smart truncation for long output

### 4. Bluetooth Headset Integration
- **Web Bluetooth API** (where supported)
  - Connect to paired headsets
  - Route audio I/O through connected device
  - Handle connect/disconnect events
  
- **Fallback**: Use device's default audio routing
  - iOS/Android automatically route to connected Bluetooth audio
  - No explicit pairing needed in most cases

### 5. Background Mode
- **Service Worker** enhancement
  - Keep audio pipeline alive when app is backgrounded
  - Wake lock for continuous listening
  - Battery optimization (pause when idle)

- **iOS limitations**:
  - PWA backgrounding is restrictive
  - May need audio playback trick (silent audio) to stay alive
  - Alternative: Use wake word + manual activation

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Voice Control UI                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Mic Status   │  │ BT Headset   │  │ Voice Mode   │  │
│  │ 🎤 Listening │  │ 🎧 Connected │  │ [ Brief  ▼ ] │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│              Speech Recognition (Web API)                 │
│  • Continuous listening with auto-restart                 │
│  • Transcript: "read the last output"                     │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                   Command Parser                          │
│  Intent: STATUS_CHECK                                     │
│  Action: read_terminal_output                             │
│  Params: { scope: "last", lines: 20 }                     │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│               Terminal State Manager                      │
│  • Get active terminal's scrollback                       │
│  • Extract meaningful content (filter ANSI, trim)         │
│  • Format for speech: "Last command output: ..."          │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│             Text-to-Speech (Web API)                      │
│  Speak: "The build completed successfully. 249 tests     │
│         passed. The daemon is now serving version 156."   │
└─────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Core Voice I/O
1. Add voice control toggle to dashboard sidebar
2. Implement continuous speech recognition
3. Basic command parser (hardcoded patterns)
4. TTS for status checks and output summaries
5. Test with device microphone + speakers

**Deliverable**: "Read output" command works, speaks last terminal lines

### Phase 2: Command Expansion
1. Navigation commands (switch tabs, scroll)
2. Input commands (type text, send keys)
3. Control commands (interrupt, continue, clear)
4. Session management (resume, start new)

**Deliverable**: Hands-free terminal control for common tasks

### Phase 3: Bluetooth Integration
1. Web Bluetooth API integration (where supported)
2. Headset pairing UI
3. Audio routing to connected device
4. Connection status indicators

**Deliverable**: Works with AirPods, other BT headsets

### Phase 4: Background & Polish
1. Service worker for background listening
2. Wake lock / audio trick for iOS PWA
3. Voice feedback customization (speed, verbosity)
4. Tutorial/onboarding for voice commands

**Deliverable**: Production-ready voice control

### Phase 5: Smart Integration (Future)
1. Wake word detection ("Hey Anton")
2. Context-aware commands (understand current state)
3. Smart glasses support (visual + audio)
4. Me frames camera integration

## Technical Considerations

### Browser Compatibility
- **Chrome/Edge**: Full Web Speech API support
- **Safari/iOS**: Partial support, may need workarounds
- **Firefox**: Limited speech recognition support

### Privacy & Security
- All voice processing **on-device** (no cloud)
- No audio recording/storage unless explicitly saved
- Bluetooth pairing requires user consent
- Clear indicators when listening (mic icon, LED)

### Performance
- Minimal CPU overhead (native speech APIs)
- Battery impact: moderate (continuous mic access)
- Network: zero (no external APIs)

### iOS PWA Challenges
1. **Background execution**: Very limited
   - Solution: Keep audio playing (silent track) or require foreground
2. **Bluetooth API**: Not supported in Safari
   - Solution: Rely on OS-level audio routing
3. **Wake lock**: Not supported
   - Solution: Manual activation, no continuous listening

## User Settings
```javascript
{
  voiceControl: {
    enabled: false,
    mode: "manual" | "continuous",
    verbosity: "brief" | "detailed",
    voice: "default" | "en-US-Male-1" | ...,
    speed: 1.0,  // 0.5 - 2.0
    bluetooth: {
      enabled: true,
      preferredDevice: null,
      autoConnect: true
    },
    commands: {
      wakeWord: "hey anton",  // future
      customMappings: {}
    }
  }
}
```

## Files to Create/Modify
1. `web/public/assets/voice-control.js` - Core voice control logic
2. `web/public/assets/command-parser.js` - NLU/pattern matching
3. `web/public/assets/speech-utils.js` - TTS helpers, output formatting
4. `web/public/index.html` - Add voice control UI + script
5. `web/public/m/index.html` - Mobile version with BT settings
6. `server/src/voiceCommandHandler.js` - Server-side command execution (if needed)
7. `docs/voice-commands.md` - User-facing command reference

## Success Metrics
- Command recognition accuracy > 90%
- Response latency < 1s (recognition → speech)
- Battery life impact < 20% over 1hr continuous use
- User can complete common tasks without touching screen

## Open Questions
1. Should we use a lightweight ML model (TensorFlow.js) for better intent parsing?
2. Wake word detection: worth the complexity/battery cost?
3. How to handle multi-tab scenarios? (voice switches active tab?)
4. Should TTS interrupt or queue when terminal updates mid-speech?

## Next Steps
1. Prototype basic speech recognition + TTS in a test page
2. Test Web Bluetooth API with AirPods/common headsets
3. Evaluate iOS PWA limitations (background, bluetooth, wake lock)
4. Build command parser with initial pattern set
5. Integrate with existing SoA terminal state management
