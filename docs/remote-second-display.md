# Use a phone or tablet as a second Mac display

Open **WEB → CONTROL** in the paired mobile client. Tap the resolution button
in the remote viewer, then **Extend** under **Desktop**. Choose **Left** or
**Right** and move a window past that edge of the Mac desktop. The existing
fullscreen button, keyboard, trackpad, touch controls and stream quality
settings work on the second display. **Mirror** ends it and returns this viewer
to the Mac's screen.

The second display belongs to one device at a time. Other remote viewers
continue to see the Mac's main screen. A reconnect or refresh within 30 seconds
reclaims the same display; after the owning viewer leaves for 30 seconds, the
virtual display is removed, even if other viewers remain. No physical monitor's
resolution or mirroring is changed by Extend. Existing **Fit the Mac to this
screen** is a separate mode; turn it off before using Extend.

Extend requires the Mac virtual-display helper and H.264/WebCodecs support in
the viewer. It uses the existing paired `/preview/6081/` route and tunnel, with
the same HTTP authentication and short-lived WebSocket tokens. No new public
port or tunnel is needed. If the second display or its video fails, that viewer
pauses and offers Retry Extend / Mirror; it never falls back to capturing or
controlling an unrelated display.

## Implementation and validation

`scripts/lib/remoteExtension.cjs` owns the helper lifecycle, lease, resize
debounce and display geometry. `soa-virtual-display.swift` creates the display
with the existing private CGVirtualDisplay API, then uses CoreGraphics to
place only that display. `soa-screen-stream.swift --strict-display` captures
the selected ScreenCaptureKit display and refuses a fallback to the main one.
Input carries the displayed ID and geometry revision, then maps local points
into global Mac coordinates, including negative origins. Queued input from an
old display revision is discarded. Disconnects release held buttons and keys.

The existing virtual-display API is private, so availability depends on macOS;
failure is reported without substituting a different display. Display placement
and coordinate mapping follow Apple's
[CGConfigureDisplayOrigin](https://developer.apple.com/documentation/coregraphics/cgconfiguredisplayorigin(_:_:_:_:))
and [CGDisplayBounds](https://developer.apple.com/documentation/coregraphics/cgdisplaybounds(_:))
contracts. Capture uses a selected
[SCDisplay](https://developer.apple.com/documentation/screencapturekit/scdisplay).

Run `node --test server/test/remoteExtension.test.js server/test/remoteDesktopExtend.test.js`.
The integration tests launch the actual remote service with fake capture,
display, app-launch and input helpers. They never manipulate the host's display
configuration or inject real input. `server/test/fixtures/remote/desktop.h264`
is a generated solid-color video frame, not a captured screen.

On macOS, compile both Swift helpers to a temporary directory. The virtual
helper can be exercised with `SOA_VDISPLAY_DRY=1` and isolated
`SOA_VDISPLAY_DRY_STATE` / `SOA_VDISPLAY_DRY_LOG` paths. Automated tests cover
create, left/right placement, rotation, reconnect, ownership, cleanup, stale
input, capture failure and Fit exclusion. Real display activation requires
the user to choose **Extend**; dry tests do not establish hardware support.

## Installation

Install the remote service, viewer, `scripts/lib/remoteExtension.cjs` and both
Swift helper sources together. Precompile the virtual-display and screen-stream
binaries into the existing `desktop-remote` state directory. Restart only the
`com.soa-web.desktop-remote` LaunchAgent when no remote viewer or borrowed
display is active. Leave the main SoA daemon, tunnel and SoA Pointer app alone.
The viewer is served by the Mac through the tunnel, so no Vercel UI release is
needed. Keep an exact copy of the previous source and helper binaries for
rollback.
