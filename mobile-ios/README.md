# Son of Anton — iOS (Capacitor)

Native iOS shell for the **Son of Anton** mobile terminal. It **bundles** the
dependency-free web client from `~/.soa-web/web/public/m/` inside the app (offline
shell — loads with no network) and connects the live terminal stream (WebSocket)
+ discovery/API to a configured SoA backend. This is deliberately **not** a thin
remote-URL webview (that risks App Store guideline 4.2 rejection).

- **appId:** `com.soaweb.mobile`  ·  **name:** Son of Anton
- **Capacitor:** 8.4.1 (Swift Package Manager)  ·  **min iOS:** 15.0
- **Signing team:** `3UVU9962N7` (Apple Development: tianjiahe11@gmail.com)

## Build & run (simulator)

```bash
cd ~/soa-mobile-ios
npm run build          # sync web assets -> www, cap copy into ios
# open in Xcode:
npm run open
# …or headless build+run on the iOS 18.6 sim (stable — see notes):
cd ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'id=<iPhone-16-Pro-18.6-UDID>' \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch booted com.soaweb.mobile
```

## Backend configuration

The bundled client has no same-origin backend (page origin is
`capacitor://localhost`), so the backend URL is supplied at runtime, in order:

1. **User override** — `localStorage['soa.native.backend']` (in-app setting).
2. **Build default** — `window.__SOA_BACKEND__`, baked by `scripts/sync-web.js`.
   Set it at sync time:

   ```bash
   SOA_BACKEND="https://your-soa-host" npm run build
   ```

Release builds should point at a **stable** origin (a named tunnel or your own
domain), not an ephemeral `*.trycloudflare.com` quick-tunnel.

### Required server-side allowance

The SoA backend must trust the native app's WS/CORS origin. `~/.soa-web`'s
`server/src/index.js` now includes `capacitor://localhost` (+ `ionic://localhost`,
`http://localhost`) in `DEFAULT_ALLOWED_ORIGINS` — **takes effect on the backend's
next restart**. Without it the `/ws` upgrade returns 403 and the app sits on the
RECONNECTING screen. The `CapacitorHttp` plugin (enabled in `capacitor.config.json`)
routes `fetch`/`XHR` through native networking so discovery/API isn't CORS-blocked.

## Layout

```
capacitor.config.json          app config (StatusBar overlay, black splash, CapacitorHttp)
scripts/sync-web.js            bundles web/public/m -> www, injects soa-native.js
resources/icon-1024.svg        source app icon (diamond mark)  -> AppIcon 1024
resources/splash-2732.svg      source splash (black + mark)    -> Splash imageset
www/                           bundled web client (generated — do not edit by hand)
ios/App/                       Xcode project (App target)
ios/capacitor-swift-pm-local/  vendored Capacitor XCFrameworks (see below)
```

## Build note — vendored Capacitor XCFrameworks

`xcodebuild` in this environment stalls indefinitely on "Resolve Package Graph"
while SPM fetches Capacitor's binary XCFrameworks from GitHub releases (plain
`curl` fetches them fine). Workaround: the frameworks are vendored at
`ios/capacitor-swift-pm-local/` and `ios/App/CapApp-SPM/Package.swift` plus the
two plugin `node_modules/@capacitor/*/Package.swift` manifests point at that local
path instead of the git URL. If you re-run `npx cap sync ios`, it regenerates
`CapApp-SPM/Package.swift` (repoint it) — prefer `npx cap copy ios` for web-only
updates. After repointing, delete
`ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
