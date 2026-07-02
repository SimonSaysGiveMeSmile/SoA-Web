# App Store metadata — Son of Anton

Draft copy for App Store Connect. Review before submitting.

## Names & subtitle
- **App name (30 char max):** `Son of Anton — Terminal`
- **Subtitle (30 char max):** `Your terminal, on your phone`
- **Bundle ID:** `com.soaweb.mobile`
- **SKU:** `soa-mobile-ios-001`

## Primary category / secondary
- **Primary:** Developer Tools
- **Secondary:** Productivity

## Promotional text (170 char max — editable without review)
> Watch and drive your dev sessions from anywhere. Real terminals, live over a
> secure link, with a fast on-screen keyboard and multi-tab switching.

## Description (4000 char max)
Son of Anton is a mobile companion for your **self-hosted Son of Anton (SoA)
terminal server**. It streams real PTY terminal sessions from your machine to
your phone over a secure WebSocket, so you can watch long-running jobs, check on
coding agents, and type commands from anywhere.

Not a toy shell — it renders full-screen, cursor-addressed TUI programs (editors,
agent CLIs, dashboards) with ANSI color, and keeps every tab live so you never
lose output.

FEATURES
• Live terminal streaming — real PTYs from your server, rendered on a mobile grid
• Multi-tab — switch between sessions; tabs are color-coded by activity
• Fast on-screen keyboard — arrows, Esc, Tab, Ctrl chords, and a reliable Enter
• Reconnects automatically — survives backgrounding, network drops, and Wi-Fi
  captive portals
• Offline shell — the app UI is bundled and launches instantly without a network
• Voice, camera & photos (optional) — send input to your sessions, only when you tap
• Dark, focused, TRON-inspired design built for reading a terminal on a phone

REQUIRES YOUR OWN SERVER
Son of Anton connects to a Son of Anton backend that you run (on your Mac, a
server, or via a secure tunnel). Point the app at your server's URL in Settings.
The app is a client — it does not host sessions itself.

PRIVACY
No accounts, no analytics, no tracking. The app talks only to the backend you
configure. Microphone, camera, and photo access are used solely to send input to
your own sessions, and only when you explicitly tap those controls.

## Keywords (100 char max, comma-separated, no spaces)
terminal,ssh,shell,tmux,pty,devops,console,remote,cli,server,agent,tunnel

## URLs
- **Support URL:** https://s0a.app/support  (TODO: confirm/create)
- **Marketing URL:** https://s0a.app          (TODO: confirm)
- **Privacy Policy URL:** https://s0a.app/privacy  (host appstore/PRIVACY.md there)

## Age rating
- 4+ (no objectionable content). Note: it's a terminal — users can run anything on
  THEIR server, but the app itself has no mature content.

## Copyright
`© 2026 <your name / entity>`  (TODO: confirm legal name)

## Version
- Marketing version: 1.0.0  ·  Build: 1
