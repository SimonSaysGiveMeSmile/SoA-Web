/**
 * Window control — let the mobile client resize/position the desktop SoA window.
 *
 * A web page can't move or resize its own browser window, and can't enter
 * fullscreen without a user gesture. So we do it from the server with AppleScript:
 * find the Google Chrome window showing the SoA desktop tab and set its bounds
 * (or toggle native macOS fullscreen via the Accessibility API).
 *
 * Requires macOS Accessibility permission for whatever process runs the daemon
 * (System Settings → Privacy & Security → Accessibility). Without it, osascript
 * returns an error which we surface to the phone as a notice.
 */

const { execFile } = require('child_process');

const TAB_MATCH = 'Son of Anton';   // desktop tab title to target
const PRESETS = new Set(['left-half', 'right-half', 'maximized', 'windowed', 'fullscreen']);

function osascript(script) {
    return new Promise((resolve, reject) => {
        execFile('osascript', ['-e', script], { timeout: 10000 }, (err, stdout, stderr) => {
            if (err) {
                const msg = (stderr || err.message || 'osascript failed').toString().trim();
                return reject(new Error(msg.replace(/^\d+:\d+: execution error: /, '')));
            }
            resolve((stdout || '').trim());
        });
    });
}

function buildScript(preset) {
    // preset is validated against PRESETS before we get here, so it's safe to
    // interpolate into the AppleScript source.
    return `
set tabMatch to "${TAB_MATCH}"
set thePreset to "${preset}"

-- Locate the Chrome window holding the SoA desktop tab, focus it, bring forward.
tell application "Google Chrome"
  set targetWinId to missing value
  set targetTabIdx to 0
  repeat with w in windows
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
      if title of t contains tabMatch then
        set targetWinId to id of w
        set targetTabIdx to ti
        exit repeat
      end if
    end repeat
    if targetWinId is not missing value then exit repeat
  end repeat
  if targetWinId is missing value then error "SoA desktop tab not found in Chrome — open it in Chrome first."
  set targetWin to (first window whose id is targetWinId)
  set active tab index of targetWin to targetTabIdx
  set index of targetWin to 1
  activate
end tell

delay 0.2

-- Read current fullscreen state of the now-front Chrome window.
set isFull to false
try
  tell application "System Events" to tell process "Google Chrome"
    set isFull to value of attribute "AXFullScreen" of front window
  end tell
end try

if thePreset is "fullscreen" then
  tell application "System Events" to tell process "Google Chrome"
    set value of attribute "AXFullScreen" of front window to (not isFull)
  end tell
  return "ok:fullscreen:" & (not isFull)
end if

-- Resize presets need the window OUT of native fullscreen first.
if isFull then
  tell application "System Events" to tell process "Google Chrome"
    set value of attribute "AXFullScreen" of front window to false
  end tell
  delay 0.6
end if

-- Compute the usable screen frame.
tell application "Finder" to set sb to bounds of window of desktop
set screenW to item 3 of sb
set screenH to item 4 of sb
set menuBar to 25
try
  tell application "System Events" to set menuBar to height of menu bar 1
end try
set halfW to (screenW / 2) as integer

if thePreset is "left-half" then
  set b to {0, menuBar, halfW, screenH}
else if thePreset is "right-half" then
  set b to {halfW, menuBar, screenW, screenH}
else if thePreset is "maximized" then
  set b to {0, menuBar, screenW, screenH}
else
  set mW to (screenW * 0.14) as integer
  set mH to ((screenH - menuBar) * 0.09) as integer
  set b to {mW, menuBar + mH, screenW - mW, screenH - mH}
end if

tell application "Google Chrome"
  set bounds of (first window whose id is targetWinId) to b
end tell
return "ok:" & thePreset
`;
}

async function applyPreset(preset) {
    if (!PRESETS.has(preset)) throw new Error('unknown window preset: ' + preset);
    if (process.platform !== 'darwin') throw new Error('window control is macOS-only');
    return osascript(buildScript(preset));
}

module.exports = { applyPreset, PRESETS };
