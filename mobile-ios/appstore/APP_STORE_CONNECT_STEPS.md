# App Store submission — steps that need YOU

Everything code-side is ready to archive. The steps below require **your Apple
account / App Store Connect login** and a few decisions only you can make. I
(the agent) cannot do these because they need your authenticated session and
legal/billing consent.

## 0. Prerequisite decision — paid membership ⚠️
Submitting to the App Store requires a **paid Apple Developer Program membership
($99/yr)**. The Mac has "Apple Development" signing certs (which a *free* Apple ID
also gets), but a free account can only run the app on your own devices — it
**cannot** publish to the App Store. 
→ **Confirm you have (or will enroll in) the paid Developer Program** at
https://developer.apple.com/programs/ (Team ID `3UVU9962N7`, tianjiahe11@gmail.com).

## 1. Register the App ID (needs your login)
developer.apple.com → Certificates, IDs & Profiles → Identifiers → +:
- Bundle ID: `com.soaweb.mobile` (Explicit)
- Capabilities: none required (no push/iCloud/etc.)

## 2. Create the app record in App Store Connect (needs your login)
appstoreconnect.apple.com → Apps → +:
- Platform: iOS · Name: **Son of Anton — Terminal** · Primary language: English (U.S.)
- Bundle ID: `com.soaweb.mobile` · SKU: `soa-mobile-ios-001`
- Fill metadata from `appstore/METADATA.md`; upload `appstore/screenshots/*`;
  set the privacy policy URL (host `appstore/PRIVACY.md`).

## 3. App Privacy questionnaire (needs your login)
In the app's "App Privacy" section, answer: **"Data Not Collected"** (the app
collects nothing). This matches `appstore/PRIVACY.md`.

## 4. Provide a way for Apple to test it (review-risk — decide) ⚠️
The app needs a **backend to connect to**, or the reviewer sees only a connect
screen and rejects under Guideline 2.1 (incomplete) / 4.2. Options — pick one:
- **(Recommended)** Stand up a demo SoA backend on a stable public `https` tunnel,
  put its URL as the app's default backend (rebuild), and/or add it to the review
  notes with any token. Keep it up through review.
- Add clear **Review Notes** with the demo URL + a short "what this app is" note:
  "Client for a self-hosted terminal server; demo backend at <url> is pre-filled."
This is the single most likely rejection cause — worth getting right.

## 5. Archive & upload the build (needs your signing session)
In Xcode (`npm run open`): set the run destination to *Any iOS Device (arm64)*,
Product → Archive, then Distribute App → App Store Connect → Upload. Automatic
signing will use Team `3UVU9962N7`. (First device/App-Store build will prompt you
to create a Distribution certificate + provisioning profile — that needs your login.)
- Before archiving, set a **stable production backend** (not the throwaway
  `*.trycloudflare.com`): `SOA_BACKEND="https://your-host" npm run build`.

## 6. Submit for review (needs your login)
Attach the uploaded build to the version, confirm export-compliance (uses standard
HTTPS/WSS encryption → usually "no" to proprietary encryption, "yes" it uses
encryption but is exempt), and Submit.

## What's already done (agent side)
- ✅ Capacitor app builds & runs (iOS 18.6 sim), signed with Team `3UVU9962N7`
- ✅ App icon (1024, no alpha) + black splash + native status bar / safe-area
- ✅ Bundled offline web client; `CapacitorHttp` + server `ALLOWED_ORIGINS` fix
- ✅ Draft metadata (`METADATA.md`), privacy policy (`PRIVACY.md`)
- ✅ Reliability verified on iOS 18.6 sim, 2026-07-02 — full matrix:
  connect, live PTY streaming, on-screen-keyboard→Enter (command executes,
  input clears), tab-switch, offline-shell resilience (survives a backend drop
  with chrome + scrollback intact), and clean reconnect recovery.
- ✅ Mobile↔desktop parity (FLEET view) verified against the live 25-session
  fleet: SESSIONS list w/ status dots + context bars + ⋯ actions,
  MONITOR/TO-DO segments, CAST broadcast.
- ✅ Terminal readability fix (font floor 5→12px) so text is legible on a
  phone — shipped to `main`, verified on-device (line pitch ~doubled).
- ✅ Hero screenshot recaptured at true 6.9" (1320×2868, iPhone 16 Pro Max):
  `screenshots/01-terminal-chrome.png`
- ✅ View deep-linking (`/m/?view=chat|dash|browser|system`) shipped to `main`
  so each view opens directly — no tapping needed. This makes the remaining
  6.9" screenshots a tap-free capture: point the sim's browser at the view URL
  with `xcrun simctl openurl <udid> "<backend>/m/?view=chat&t=<token>"` then
  `xcrun simctl io <udid> screenshot`, once a demo backend is up (step 4).
- ⏳ Extra 6.9" screenshots (CHAT / DASH-fleet / BROWSER): all three views are
  functionally verified (soa-browser); the native 6.9" capture is best done at
  submission time against the reviewer demo backend (step 4) using the tap-free
  deep-link method above.
