// soa-window-at — which process owns the window under a screen point.
//
// Reads "x y" lines (global display points) on stdin and prints the owning
// pid of the topmost normal window at that point, or 0 when nothing is there
// (desktop, menu bar). Needs no privacy permission: window bounds and owner
// pids are public, only window titles are gated. Used by soa-desktop-remote
// so a remote click is delivered to the app that is actually under it.
import Foundation
import CoreGraphics

setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine() {
    let p = line.split(separator: " ").compactMap { Double($0) }
    guard p.count == 2 else { print(0); continue }
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var found = 0
    for w in list {            // front to back
        guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
              let b = w[kCGWindowBounds as String] as? [String: Any],
              let x = b["X"] as? Double, let y = b["Y"] as? Double,
              let wd = b["Width"] as? Double, let h = b["Height"] as? Double,
              let pid = w[kCGWindowOwnerPID as String] as? Int else { continue }
        if p[0] >= x && p[0] < x + wd && p[1] >= y && p[1] < y + h { found = pid; break }
    }
    print(found)
}
