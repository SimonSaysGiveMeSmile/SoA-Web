// soa-display — read and change the Mac's main display resolution.
//
// Used by soa-desktop-remote so a paired phone or tablet can pick the Mac's
// "looks like" size. Needs no privacy permission (display modes are public).
//
//   soa-display list        every usable mode of the main display, as JSON
//   soa-display current     the mode in use now, as JSON
//   soa-display set <id>    switch to that mode for this login session only
//                           (macOS reverts it at logout); prints the new current
//
// A mode is one "looks like" size (width x height in points) drawn at one
// pixel size: HiDPI modes draw 2x (or more) pixels per point, low-resolution
// ones 1:1. Modes that differ only in refresh rate are folded into one entry
// (its `refreshRates` lists them); the entry's own refresh is the current one
// when that size is in use, else the highest available. An id names the exact
// mode: "<w>x<h>@<pixelW>x<pixelH>@<hz>" (hz rounded to 2 decimals, 0 = not
// reported). `set` also accepts the size without the refresh part, and then
// keeps the current refresh rate if that size offers it.
//
// SOA_DISPLAY_DRY=1: `set` validates the id and prints what it would apply,
// changing nothing. Exit codes: 0 ok, 2 bad id / bad usage, 3 the change failed.
import Foundation
import CoreGraphics

setvbuf(stdout, nil, _IOLBF, 0)
let dry = ProcessInfo.processInfo.environment["SOA_DISPLAY_DRY"] == "1"
let display = CGMainDisplayID()

// IOKit's mode flags (IOGraphicsTypes.h); not exported to Swift by name.
let kNativeFlag: UInt32 = 0x0200_0000
let kDefaultFlag: UInt32 = 0x0000_0004

func hz(_ m: CGDisplayMode) -> Double { (m.refreshRate * 100).rounded() / 100 }
func fmtHz(_ v: Double) -> String { v == v.rounded() ? String(Int(v)) : String(format: "%.2f", v) }
// JSONSerialization prints a Double in full (59.939999...): a decimal keeps "59.94".
func dec(_ v: Double) -> NSDecimalNumber { NSDecimalNumber(string: fmtHz(v)) }
func sizeKey(_ m: CGDisplayMode) -> String { "\(m.width)x\(m.height)@\(m.pixelWidth)x\(m.pixelHeight)" }
func modeId(_ m: CGDisplayMode) -> String { sizeKey(m) + "@" + fmtHz(hz(m)) }

func allModes() -> [CGDisplayMode] {
    // Without this option the HiDPI ("Retina") variants are hidden.
    let opts = [kCGDisplayShowDuplicateLowResolutionModes: kCFBooleanTrue] as CFDictionary
    let list = (CGDisplayCopyAllDisplayModes(display, opts) as? [CGDisplayMode]) ?? []
    return list.filter { $0.isUsableForDesktopGUI() && $0.width > 0 && $0.height > 0 }
}
let current = CGDisplayCopyDisplayMode(display)

func json(_ m: CGDisplayMode, rates: [Double]? = nil, id: String? = nil) -> [String: Any] {
    let flags = m.ioFlags
    let scale = Double(m.pixelWidth) / Double(m.width)
    var o: [String: Any] = [
        "id": id ?? modeId(m),
        "width": m.width, "height": m.height,              // points ("looks like")
        "pixelWidth": m.pixelWidth, "pixelHeight": m.pixelHeight,
        "scale": (scale * 100).rounded() / 100,
        "hidpi": m.pixelWidth > m.width,
        "refresh": dec(hz(m)),
        "ioModeId": Int(m.ioDisplayModeID),
        "native": flags & kNativeFlag != 0,
        "default": flags & kDefaultFlag != 0,
        "current": current.map { sizeKey($0) == sizeKey(m) } ?? false,
    ]
    if let r = rates { o["refreshRates"] = r.map(dec) }
    return o
}

// Fold refresh-rate variants into one entry per (points, pixels) size.
func folded() -> [(CGDisplayMode, [Double])] {
    var groups: [String: [CGDisplayMode]] = [:]
    var order: [String] = []
    for m in allModes() {
        let k = sizeKey(m)
        if groups[k] == nil { order.append(k); groups[k] = [] }
        groups[k]!.append(m)
    }
    var out: [(CGDisplayMode, [Double])] = []
    for k in order {
        let g = groups[k]!
        let rates = Array(Set(g.map(hz))).sorted(by: >)
        let pick = g.first(where: { current != nil && $0.ioDisplayModeID == current!.ioDisplayModeID })
            ?? g.first(where: { current != nil && hz($0) == hz(current!) })
            ?? g.max(by: { hz($0) < hz($1) })!
        out.append((pick, rates))
    }
    // Largest "looks like" first; at one size, HiDPI before low resolution.
    out.sort { a, b in
        if a.0.width != b.0.width { return a.0.width > b.0.width }
        if a.0.height != b.0.height { return a.0.height > b.0.height }
        return a.0.pixelWidth > b.0.pixelWidth
    }
    return out
}

func emit(_ o: Any) {
    let d = try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
    print(String(data: d, encoding: .utf8)!)
}
func fail(_ code: Int32, _ why: String) -> Never {
    emit(["error": why]); exit(code)
}

// The mode an id names. Exact first; a size-only id (or an unknown refresh)
// keeps the current refresh when that size has it, else the highest.
func resolve(_ id: String) -> CGDisplayMode? {
    let modes = allModes()
    if let m = modes.first(where: { modeId($0) == id }) { return m }
    if let n = Int32(id), let m = modes.first(where: { $0.ioDisplayModeID == n }) { return m }
    let parts = id.split(separator: "@")
    guard parts.count >= 2 else { return nil }
    let key = parts[0] + "@" + parts[1]
    let same = modes.filter { sizeKey($0) == key }
    if same.isEmpty { return nil }
    if let c = current, let m = same.first(where: { hz($0) == hz(c) }) { return m }
    return same.max(by: { hz($0) < hz($1) })
}

let args = CommandLine.arguments
let cmd = args.count > 1 ? args[1] : "list"
switch cmd {
case "list":
    emit(["display": Int(display), "dry": dry, "modes": folded().map { json($0.0, rates: $0.1) }])
case "current":
    guard let c = current else { fail(3, "no current mode") }
    emit(["display": Int(display), "mode": json(c)])
case "set":
    guard args.count > 2 else { fail(2, "usage: soa-display set <id>") }
    let id = args[2]
    // Ids are short and plain; anything else is refused before lookup.
    guard id.count <= 64, id.allSatisfy({ $0.isASCII && ($0.isNumber || "x@.".contains($0)) }) else { fail(2, "bad id") }
    guard let m = resolve(id) else { fail(2, "no such mode: \(id)") }
    if let c = current, c.ioDisplayModeID == m.ioDisplayModeID {
        emit(["display": Int(display), "changed": false, "dry": dry, "mode": json(m)]); exit(0)
    }
    if dry {
        emit(["display": Int(display), "changed": false, "dry": true, "wouldSet": json(m)]); exit(0)
    }
    var cfg: CGDisplayConfigRef?
    guard CGBeginDisplayConfiguration(&cfg) == .success, let config = cfg else { fail(3, "begin configuration failed") }
    let st = CGConfigureDisplayWithDisplayMode(config, display, m, nil)
    guard st == .success else { CGCancelDisplayConfiguration(config); fail(3, "configure failed (\(st.rawValue))") }
    // .forSession: macOS restores the user's own setting at logout, so a
    // change made remotely can never outlive the login session.
    let done = CGCompleteDisplayConfiguration(config, .forSession)
    guard done == .success else { fail(3, "apply failed (\(done.rawValue))") }
    let now = CGDisplayCopyDisplayMode(display)
    emit(["display": Int(display), "changed": true, "dry": false, "mode": now.map { json($0) } ?? json(m)])
default:
    fail(2, "usage: soa-display list | current | set <id>")
}
