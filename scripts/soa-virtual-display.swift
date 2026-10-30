// soa-virtual-display — a virtual display shaped like the viewer's screen.
//
// Used by soa-desktop-remote for "Fit the Mac to this screen": it creates a
// virtual display whose pixel size matches the area a phone or tablet has for
// the picture, makes the built-in display MIRROR it (so the virtual display is
// the master: menu bar, Dock and windows lay out at the viewer's shape), and
// undoes all of it when told to, when stdin closes, or on any catchable
// signal. The display exists exactly as long as this process holds the
// CGVirtualDisplay object, so a crash (even kill -9) removes it too and macOS
// falls back to the built-in display on its own.
//
// CGVirtualDisplay is private CoreGraphics API (macOS 14+); it is reached
// through the Objective-C runtime so this file builds with a plain `swiftc`.
//
// stdin, one command per line; every command answers ONE JSON line on stdout:
//   create <pxW> <pxH> <hiDPI 0|1> [name…]   new display; {"ok","id","bounds","mode"}
//   resize <pxW> <pxH> <hiDPI 0|1>          new mode for the same display (no re-create)
//   mirror on|off                           built-in (the original main) mirrors the virtual one
//   extend left|right                       place ONLY the virtual display beside the existing desktop
//   state                                   displays, main id, modes, mirroring
//   destroy                                 unmirror, then remove the display
//   quit                                    destroy and exit
// One-shot options (no display created; each run has a fresh CoreGraphics view):
//   --query <id|0>    one display's mode, bounds and modes as JSON (0 = main)
//   --state <vid> <mirroredFrom>    every display, as the `state` command
//   --set-mode <id> <w> <h> <pixelW> <pixelH>    select that exact mode (.forSession)
//   --restore [id]    unmirror every display that mirrors virtual display <id>
//                     or any display this helper makes (a crashed helper's
//                     leftovers); with no id at all, every mirrored display
// <pxW> x <pxH> is the framebuffer in pixels; with hiDPI=1 the display "looks
// like" half of that in points (2x backing), with 0 it is 1:1.
// SOA_VDISPLAY_DRY=1: never touches the display configuration. Commands are
// parsed, validated and answered with a plausible FAKE display (an id, its
// bounds and mode, a built-in that "mirrors" it), the fake state kept in
// SOA_VDISPLAY_DRY_STATE so the one-shot --query / --restore of a later run
// see it, and every action (and every way out: EOF, a signal, the parent
// gone) appended to SOA_VDISPLAY_DRY_LOG. SOA_VDISPLAY_DRY_CREATE_MS makes a
// create take that long, abortable like a real one. For tests of the service.
import Foundation
import CoreGraphics

setvbuf(stdout, nil, _IOLBF, 0)
setvbuf(stderr, nil, _IONBF, 0)
// fputs, not FileHandle.write: with the service gone (kill -9) stderr is a
// broken pipe, and FileHandle raises on that, which would end this process
// before it restores the Mac. SIGPIPE is ignored, so fputs just fails.
func say(_ s: String) { fputs("virtual-display: " + s + "\n", stderr) }
func emit(_ o: [String: Any]) {
    let d = try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
    print(String(data: d, encoding: .utf8)!)
}
let dry = ProcessInfo.processInfo.environment["SOA_VDISPLAY_DRY"] == "1"
// The service is our parent: re-parenting to launchd means it is gone.
let parent = getppid()
// Set from a signal (on a background queue) or seen through the parent
// check: a long command (a create waiting for its mode) stops waiting, so the
// restore that follows is not held up by it.
var abortFlag = false
func aborting() -> Bool { abortFlag || getppid() != parent }
// Every display this helper makes carries these, so a fresh process can tell
// a fitted screen from a real monitor.
let vdVendor: UInt32 = 0x534F, vdProduct: UInt32 = 0x0001

// ── DRY mode: a fake display, nothing configured ────────────────────────
let env = ProcessInfo.processInfo.environment
let dryStatePath = env["SOA_VDISPLAY_DRY_STATE"] ?? (NSTemporaryDirectory() + "soa-vdisplay-dry.json")
let dryLogPath = env["SOA_VDISPLAY_DRY_LOG"]
let dryBuiltin: CGDirectDisplayID = 1
let dryBuiltinMode: [String: Any] = ["width": 1728, "height": 1117, "pixelWidth": 3456, "pixelHeight": 2234, "refresh": 120, "ioModeId": 54]
func dryLog(_ s: String) {
    guard let p = dryLogPath, let d = "\(ISO8601DateFormatter().string(from: Date())) pid=\(getpid()) \(s)\n".data(using: .utf8) else { return }
    if let h = FileHandle(forWritingAtPath: p) { h.seekToEndOfFile(); h.write(d); h.closeFile() }
    else { FileManager.default.createFile(atPath: p, contents: d) }
}
func dryRead() -> [String: Any] {
    guard let d = FileManager.default.contents(atPath: dryStatePath),
          let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [:] }
    return j
}
func dryWrite(_ o: [String: Any]?) {
    if let o = o, let d = try? JSONSerialization.data(withJSONObject: o) { FileManager.default.createFile(atPath: dryStatePath, contents: d) }
    else { try? FileManager.default.removeItem(atPath: dryStatePath) }
}
// What a fresh process would read about one display (0 = the main one).
func dryQuery(_ asked: CGDirectDisplayID) -> [String: Any] {
    let s = dryRead()
    let v = CGDirectDisplayID((s["vid"] as? Int) ?? 0), mirrored = ((s["mirroredFrom"] as? Int) ?? 0) != 0
    let main = v != 0 && mirrored ? v : dryBuiltin
    let id = asked == 0 ? main : asked
    let pxW = (s["pxW"] as? Int) ?? 0, pxH = (s["pxH"] as? Int) ?? 0, hidpi = (s["hidpi"] as? Bool) ?? false
    let w = hidpi ? pxW / 2 : pxW, h = hidpi ? pxH / 2 : pxH
    var mode: [String: Any] = [:], bounds: [String: Any] = [:], modes: [[Int]] = []
    if id == dryBuiltin {
        mode = dryBuiltinMode
        bounds = ["x": 0, "y": 0, "width": main == dryBuiltin ? 1728 : w, "height": main == dryBuiltin ? 1117 : h]
    } else if v != 0 && id == v {
        mode = ["width": w, "height": h, "pixelWidth": pxW, "pixelHeight": pxH, "refresh": 60, "ioModeId": 1]
        bounds = ["x": main == v ? 0 : ((s["side"] as? String) == "left" ? -w : 1728), "y": 0, "width": w, "height": h]
        modes = [[w, h, pxW, pxH, 1]]
    }
    return ["id": Int(id), "online": id == dryBuiltin || (v != 0 && id == v), "main": Int(main), "mirrorOf": id == dryBuiltin && mirrored ? Int(v) : 0, "mode": mode, "bounds": bounds, "modes": modes, "dry": true]
}

// ── private API through the runtime ─────────────────────────────────────
typealias ModeInit = @convention(c) (AnyObject, Selector, UInt32, UInt32, Double) -> Unmanaged<AnyObject>?
typealias ObjInit = @convention(c) (AnyObject, Selector, AnyObject) -> Unmanaged<AnyObject>?
typealias Alloc = @convention(c) (AnyClass, Selector) -> Unmanaged<AnyObject>
typealias BoolArg = @convention(c) (AnyObject, Selector, AnyObject) -> Bool

func cls(_ n: String) -> AnyClass? { NSClassFromString(n) }
func imp<T>(_ c: AnyClass, _ sel: Selector, meta: Bool = false, as: T.Type) -> T? {
    let target: AnyClass = meta ? object_getClass(c)! : c
    guard let m = class_getInstanceMethod(target, sel) else { return nil }
    return unsafeBitCast(method_getImplementation(m), to: T.self)
}
// +alloc then an -init…: the result is owned (+1) by the caller.
func alloc(_ c: AnyClass) -> Unmanaged<AnyObject> {
    imp(c, NSSelectorFromString("alloc"), meta: true, as: Alloc.self)!(c, NSSelectorFromString("alloc"))
}
func makeMode(_ w: Int, _ h: Int, _ hz: Double) -> AnyObject? {
    guard let c = cls("CGVirtualDisplayMode") else { return nil }
    let sel = NSSelectorFromString("initWithWidth:height:refreshRate:")
    guard let f = imp(c, sel, as: ModeInit.self) else { return nil }
    return f(alloc(c).takeUnretainedValue(), sel, UInt32(w), UInt32(h), hz)?.takeRetainedValue()
}
func apply(_ display: AnyObject, _ settings: AnyObject) -> Bool {
    let sel = NSSelectorFromString("applySettings:")
    guard let f = imp(type(of: display), sel, as: BoolArg.self) else { return false }
    return f(display, sel, settings)
}

// ── state ───────────────────────────────────────────────────────────────
var vdisplay: AnyObject?          // the CGVirtualDisplay: the display lives while this is set
var vid: CGDirectDisplayID = 0
var mirroredFrom: CGDirectDisplayID = 0   // the display that mirrors the virtual one
var maxPx = (w: 0, h: 0)
var destroying = false            // our own release: its termination callback is expected
let originalMain = dry ? dryBuiltin : CGMainDisplayID()

func online() -> [CGDirectDisplayID] {
    var n: UInt32 = 0
    CGGetOnlineDisplayList(0, nil, &n)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(n))
    CGGetOnlineDisplayList(n, &ids, &n)
    return Array(ids.prefix(Int(n)))
}
func modeJSON(_ id: CGDirectDisplayID) -> [String: Any] {
    guard let m = CGDisplayCopyDisplayMode(id) else { return [:] }
    return ["width": m.width, "height": m.height, "pixelWidth": m.pixelWidth, "pixelHeight": m.pixelHeight,
            "refresh": m.refreshRate, "ioModeId": Int(m.ioDisplayModeID)]
}
func boundsJSON(_ id: CGDirectDisplayID) -> [String: Any] {
    let b = CGDisplayBounds(id)
    return ["x": Int(b.origin.x), "y": Int(b.origin.y), "width": Int(b.width), "height": Int(b.height)]
}
func isOurs(_ id: CGDirectDisplayID) -> Bool { CGDisplayVendorNumber(id) == vdVendor && CGDisplayModelNumber(id) == vdProduct && CGDisplayIsBuiltin(id) == 0 }
func displayJSON(_ id: CGDirectDisplayID) -> [String: Any] {
    ["id": Int(id), "builtin": CGDisplayIsBuiltin(id) != 0, "main": CGDisplayIsMain(id) != 0,
     "active": CGDisplayIsActive(id) != 0, "virtual": (id == vid && vid != 0) || isOurs(id),
     "mirrorOf": Int(CGDisplayMirrorsDisplay(id)), "inMirrorSet": CGDisplayIsInMirrorSet(id) != 0,
     "bounds": boundsJSON(id), "mode": modeJSON(id), "modes": id == vid ? modesJSON(id) as Any : NSNull()]
}
// Every mode the window server offers for a display (HiDPI variants included).
func allModes(_ id: CGDirectDisplayID) -> [CGDisplayMode] {
    let opts = [kCGDisplayShowDuplicateLowResolutionModes: kCFBooleanTrue] as CFDictionary
    return (CGDisplayCopyAllDisplayModes(id, opts) as? [CGDisplayMode]) ?? []
}
func modesJSON(_ id: CGDirectDisplayID) -> [String] {
    allModes(id).map { "\($0.width)x\($0.height)@\($0.pixelWidth)x\($0.pixelHeight)\($0.isUsableForDesktopGUI() ? "" : " (not GUI)")" }
}
func stateJSON() -> [String: Any] {
    if dry { return ["main": dryQuery(0)["main"] ?? 1, "virtual": Int(vid), "mirroredFrom": Int(mirroredFrom), "dry": true,
                     "displays": [dryQuery(dryBuiltin)] + (vid != 0 ? [dryQuery(vid)] : [])] }
    return ["main": Int(CGMainDisplayID()), "virtual": Int(vid), "mirroredFrom": Int(mirroredFrom), "displays": online().map(displayJSON)]
}

func sub(_ args: [String]) -> [String: Any] {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    p.arguments = args
    let pipe = Pipe(); p.standardOutput = pipe
    do { try p.run() } catch { return [:] }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}
// Fresh view of one display: {"online","main","mode","bounds","modes":[[w,h,pw,ph,gui]]}
func fresh(_ id: CGDirectDisplayID) -> [String: Any] { sub(["--query", String(id)]) }
func freshIsAt(_ id: CGDirectDisplayID, _ pxW: Int, _ pxH: Int, _ hidpi: Bool) -> Bool {
    guard let m = fresh(id)["mode"] as? [String: Any] else { return false }
    return (m["pixelWidth"] as? Int) == pxW && (m["pixelHeight"] as? Int) == pxH && (m["width"] as? Int) == (hidpi ? pxW / 2 : pxW)
}
func freshSelect(_ id: CGDirectDisplayID, _ pxW: Int, _ pxH: Int, _ hidpi: Bool) -> Bool {
    let w = hidpi ? pxW / 2 : pxW, h = hidpi ? pxH / 2 : pxH
    return (sub(["--set-mode", String(id), String(w), String(h), String(pxW), String(pxH)])["ok"] as? Bool) == true
}
// Bring the display to exactly pxW x pxH at the asked scale: macOS picks the
// display's initial mode itself (often 1x), so select ours when it did not.
func settle(_ id: CGDirectDisplayID, _ pxW: Int, _ pxH: Int, _ hidpi: Bool) -> Bool {
    // The mode list takes a moment to be published after create/applySettings.
    if waitFor({ freshIsAt(id, pxW, pxH, hidpi) }, 0.4) { return true }
    let w = hidpi ? pxW / 2 : pxW, h = hidpi ? pxH / 2 : pxH
    for _ in 0..<15 {
        if aborting() { return false }
        // Modes published but ours is not among them, or listed but not
        // usable for a desktop ("not GUI"): the window server refused that
        // scale (it then runs the display at 1x). Do not wait on it.
        let list = (fresh(id)["modes"] as? [[Int]]) ?? []
        let ours = list.first(where: { $0.count >= 5 && $0[0] == w && $0[1] == h && $0[2] == pxW && $0[3] == pxH })
        if !list.isEmpty && (ours == nil || ours![4] == 0) { return false }
        if ours != nil && freshSelect(id, pxW, pxH, hidpi) { return waitFor({ freshIsAt(id, pxW, pxH, hidpi) }, 2) }
        _ = waitFor({ false }, 0.1)
    }
    return false
}

// ── operations ──────────────────────────────────────────────────────────
func settingsFor(_ pxW: Int, _ pxH: Int, _ hidpi: Bool) -> AnyObject? {
    guard let sc = cls("CGVirtualDisplaySettings") as? NSObject.Type else { return nil }
    let s = sc.init()
    // Mode sizes are in POINTS; hiDPI=1 makes the window server back each one
    // at 2x (it needs maxPixels >= 2x the mode). The 1x variant of each point
    // size is offered too, so ask only for what we want: one mode.
    let w = hidpi ? pxW / 2 : pxW, h = hidpi ? pxH / 2 : pxH
    guard let mode = makeMode(w, h, 60) else { return nil }
    s.setValue(hidpi ? 1 : 0, forKey: "hiDPI")
    s.setValue([mode], forKey: "modes")
    return s
}
// HiDPI (2x) is only offered as a desktop mode from about 800x600 points:
// at least 480,000 square points AND a long side of at least 800 points
// (measured on macOS 27: 640x821, 1266x525, 585x1266, 800x600, 624x938 pt
// accepted at 2x; 680x706, 585x750, 500x700, 800x500, 960x398 pt refused,
// the display then runs at 1x).
let hidpiMinArea = 480_000, hidpiMinLong = 800
func valid(_ w: Int, _ h: Int, _ hidpi: Bool = false) -> String? {
    if w < 2 || h < 2 || w % 2 != 0 || h % 2 != 0 { return "size must be even and positive" }
    if hidpi && ((w / 2) * (h / 2) < hidpiMinArea || max(w, h) / 2 < hidpiMinLong) {
        return "too small for HiDPI: needs at least \(hidpiMinArea) square points and a long side of \(hidpiMinLong)"
    }
    if max(w, h) > 8192 { return "size too large (max 8192)" }
    return nil
}
// Waits spin the main run loop (the display object's own callbacks and its
// release are serviced there). CoreGraphics in THIS process caches a display's
// modes and bounds and does not see changes made through the virtual-display
// server (create, applySettings), so the truth about the virtual display is
// read by a fresh copy of this binary (`--query`), and its mode is chosen by
// one (`--set-mode`): each starts with an empty cache. ~50 ms per call.
// A wait on the way out (unmirror, removal) is not cut short by `aborting`.
func waitFor(_ cond: () -> Bool, _ seconds: Double, abortable: Bool = true) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
        if cond() { return true }
        if abortable && aborting() { return false }
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
    }
    return cond()
}

func create(_ pxW: Int, _ pxH: Int, _ hidpi: Bool, _ name: String) -> [String: Any] {
    if vdisplay != nil { return ["ok": false, "error": "already created", "id": Int(vid)] }
    if let e = valid(pxW, pxH, hidpi) { return ["ok": false, "error": e] }
    if dry {
        let ms = max(0, Int(env["SOA_VDISPLAY_DRY_CREATE_MS"] ?? "") ?? 300)
        dryLog("create \(pxW)x\(pxH) hiDPI=\(hidpi ? 1 : 0) (dry: no display is created)")
        _ = waitFor({ false }, Double(ms) / 1000)
        if aborting() { dryLog("create aborted"); return ["ok": false, "dry": true, "error": "aborted"] }
        vid = 0x5000 + (UInt32(getpid()) & 0xFFF)
        vdisplay = NSObject()
        maxPx = (max(pxW, 3840), max(pxH, 3840))
        dryWrite(["vid": Int(vid), "pxW": pxW, "pxH": pxH, "hidpi": hidpi, "mirroredFrom": 0, "pid": Int(getpid())])
        let q = dryQuery(vid)
        return ["ok": true, "dry": true, "id": Int(vid), "bounds": q["bounds"] ?? [:], "mode": q["mode"] ?? [:], "ms": ms]
    }
    guard let dc = cls("CGVirtualDisplayDescriptor") as? NSObject.Type, let vc = cls("CGVirtualDisplay") else {
        return ["ok": false, "error": "CGVirtualDisplay not available on this macOS"]
    }
    let t0 = Date()
    let d = dc.init()
    d.setValue(DispatchQueue(label: "vdisplay"), forKey: "queue")
    d.setValue(name, forKey: "name")
    // Room for a later `resize` to any shape up to 4K on either side.
    maxPx = (max(pxW, 3840), max(pxH, 3840))
    d.setValue(maxPx.w, forKey: "maxPixelsWide")
    d.setValue(maxPx.h, forKey: "maxPixelsHigh")
    // ~110 dpi at 1x / ~220 at 2x: only affects what System Settings shows.
    let mmPerPx = hidpi ? 25.4 / 220 : 25.4 / 110
    d.setValue(NSValue(size: NSSize(width: Double(pxW) * mmPerPx, height: Double(pxH) * mmPerPx)), forKey: "sizeInMillimeters")
    d.setValue(vdVendor, forKey: "vendorID")           // arbitrary, stable: lets macOS remember the arrangement
    d.setValue(vdProduct, forKey: "productID")
    d.setValue(UInt32(getpid()) & 0xFFFF, forKey: "serialNumber")
    // macOS dropped the display on its own (a WindowServer restart, a wake,
    // System Settings): exit, so the service sees the helper go and puts the
    // Mac back on its own screen instead of streaming a display that is gone.
    let term: @convention(block) (AnyObject?, AnyObject?) -> Void = { _, _ in
        if destroying { return }
        say("display terminated by the system")
        abortFlag = true
        DispatchQueue.main.async { shutdown("display terminated") }
    }
    d.setValue(term, forKey: "terminationHandler")
    let sel = NSSelectorFromString("initWithDescriptor:")
    guard let f = imp(vc, sel, as: ObjInit.self), let obj = f(alloc(vc).takeUnretainedValue(), sel, d)?.takeRetainedValue() else {
        return ["ok": false, "error": "initWithDescriptor failed"]
    }
    let id = (obj.value(forKey: "displayID") as? NSNumber)?.uint32Value ?? 0
    guard id != 0 else { return ["ok": false, "error": "no display id"] }
    guard let s = settingsFor(pxW, pxH, hidpi), apply(obj, s) else { return ["ok": false, "error": "applySettings refused \(pxW)x\(pxH) hiDPI=\(hidpi)"] }
    vdisplay = obj; vid = id
    let up = settle(id, pxW, pxH, hidpi)
    let q = fresh(id)
    return ["ok": up, "id": Int(id), "bounds": q["bounds"] ?? [:], "mode": q["mode"] ?? [:], "ms": Int(Date().timeIntervalSince(t0) * 1000),
            "error": up ? NSNull() : "display did not come up at the requested size" as Any]
}

func resize(_ pxW: Int, _ pxH: Int, _ hidpi: Bool) -> [String: Any] {
    guard let obj = vdisplay else { return ["ok": false, "error": "no display"] }
    if let e = valid(pxW, pxH, hidpi) { return ["ok": false, "error": e] }
    if pxW > maxPx.w || pxH > maxPx.h { return ["ok": false, "error": "larger than the display's maximum; destroy and create"] }
    if dry {
        dryLog("resize \(pxW)x\(pxH) hiDPI=\(hidpi ? 1 : 0) (dry)")
        var st = dryRead(); st["pxW"] = pxW; st["pxH"] = pxH; st["hidpi"] = hidpi; dryWrite(st)
        let f = dryQuery(vid)
        return ["ok": true, "dry": true, "id": Int(vid), "main": f["main"] ?? 0, "bounds": f["bounds"] ?? [:], "mode": f["mode"] ?? [:], "ms": 0]
    }
    let t0 = Date()
    guard let s = settingsFor(pxW, pxH, hidpi), apply(obj, s) else { return ["ok": false, "error": "applySettings refused"] }
    let id = vid
    let up = settle(id, pxW, pxH, hidpi)
    let f = fresh(id)
    return ["ok": up, "id": Int(vid), "main": f["main"] ?? 0, "bounds": f["bounds"] ?? [:], "mode": f["mode"] ?? [:], "ms": Int(Date().timeIntervalSince(t0) * 1000)]
}

func configure(_ body: (CGDisplayConfigRef) -> CGError) -> CGError {
    var cfg: CGDisplayConfigRef?
    guard CGBeginDisplayConfiguration(&cfg) == .success, let c = cfg else { return .failure }
    let e = body(c)
    if e != .success { CGCancelDisplayConfiguration(c); return e }
    // .forSession: whatever happens, macOS forgets it at logout.
    return CGCompleteDisplayConfiguration(c, .forSession)
}

func mirror(_ on: Bool) -> [String: Any] {
    let t0 = Date()
    if dry {
        if on && vid == 0 { return ["ok": false, "error": "no display"] }
        if on == (mirroredFrom != 0) { return ["ok": true, "already": true, "dry": true] }
        mirroredFrom = on ? dryBuiltin : 0
        dryLog(on ? "mirror on (dry: the built-in would mirror display \(vid))" : "mirror off (dry: the built-in would stop mirroring)")
        var st = dryRead(); st["mirroredFrom"] = Int(mirroredFrom); if vid != 0 { dryWrite(st) }
        return ["ok": true, "dry": true, "main": Int(on ? vid : dryBuiltin), "ms": 0]
    }
    if on {
        guard vid != 0 else { return ["ok": false, "error": "no display"] }
        if mirroredFrom != 0 { return ["ok": true, "already": true, "state": stateJSON()] }
        // The display everything sits on now (the built-in, normally).
        let src = online().first(where: { $0 != vid && CGDisplayIsMain($0) != 0 }) ?? online().first(where: { CGDisplayIsBuiltin($0) != 0 }) ?? 0
        guard src != 0 else { return ["ok": false, "error": "no display to mirror"] }
        let e = configure { CGConfigureDisplayMirrorOfDisplay($0, src, vid) }
        guard e == .success else { return ["ok": false, "error": "mirror failed (\(e.rawValue))"] }
        mirroredFrom = src
        _ = waitFor({ CGMainDisplayID() == vid }, 3)
    } else {
        guard mirroredFrom != 0 else { return ["ok": true, "already": true, "state": stateJSON()] }
        let src = mirroredFrom
        let e = configure { CGConfigureDisplayMirrorOfDisplay($0, src, kCGNullDirectDisplay) }
        guard e == .success else { return ["ok": false, "error": "unmirror failed (\(e.rawValue))"] }
        mirroredFrom = 0
        _ = waitFor({ CGDisplayMirrorsDisplay(src) == kCGNullDirectDisplay }, 3, abortable: false)
    }
    return ["ok": true, "main": Int(CGMainDisplayID()), "ms": Int(Date().timeIntervalSince(t0) * 1000), "state": stateJSON()]
}

// A second display uses its own global origin. Configure only that display:
// no physical display changes its mode, mirror set, origin or primary role.
func extend(_ side: String) -> [String: Any] {
    guard vid != 0, mirroredFrom == 0, side == "left" || side == "right" else {
        return ["ok": false, "error": "extend needs an independent display and left|right"]
    }
    if dry {
        var st = dryRead(); st["side"] = side; dryWrite(st)
        dryLog("extend \(side) (dry: only virtual display moves; built-in stays main)")
        return ["ok": true, "dry": true, "id": Int(vid)]
    }
    let q = fresh(vid)
    guard (q["main"] as? Int) == Int(originalMain), (q["mirrorOf"] as? Int) == 0 else {
        return ["ok": false, "error": "the main display or mirroring changed"]
    }
    let state = sub(["--state", String(vid), "0"])
    let displays = (state["displays"] as? [[String: Any]]) ?? []
    let rects = displays.filter { ($0["id"] as? Int) != Int(vid) && ($0["active"] as? Bool) == true }
        .compactMap { $0["bounds"] as? [String: Int] }
    guard !rects.isEmpty, let b = q["bounds"] as? [String: Int], let width = b["width"] else {
        return ["ok": false, "error": "display arrangement unavailable"]
    }
    // Attach to the outermost edge, even with several real monitors or a
    // monitor already to the left. Keep the new display connected to it.
    let edge = side == "left" ? rects.min { ($0["x"] ?? 0) < ($1["x"] ?? 0) }!
        : rects.max { ($0["x"] ?? 0) + ($0["width"] ?? 0) < ($1["x"] ?? 0) + ($1["width"] ?? 0) }!
    let x = side == "left" ? (edge["x"] ?? 0) - width : (edge["x"] ?? 0) + (edge["width"] ?? 0)
    let y = edge["y"] ?? 0
    let e = configure { CGConfigureDisplayOrigin($0, vid, Int32(x), Int32(y)) }
    guard e == .success else { return ["ok": false, "error": "arrangement failed (\(e.rawValue))"] }
    let settled = waitFor({
        let f = fresh(vid), bounds = f["bounds"] as? [String: Int]
        return (f["main"] as? Int) == Int(originalMain) && bounds?["x"] == x && bounds?["y"] == y
    }, 3)
    return ["ok": settled, "id": Int(vid), "error": settled ? NSNull() : "display did not settle beside the desktop" as Any]
}

func destroy() -> [String: Any] {
    let t0 = Date()
    var out: [String: Any] = ["ok": true]
    if dry {
        if mirroredFrom != 0 { out["unmirror"] = mirror(false)["ok"] }
        if vdisplay != nil { dryLog("remove display \(vid) (dry)"); vdisplay = nil; vid = 0; out["deallocated"] = true; out["gone"] = true }
        dryWrite(nil)
        out["dry"] = true; out["ms"] = 0; out["main"] = Int(dryBuiltin); out["mainMode"] = dryBuiltinMode
        return out
    }
    if mirroredFrom != 0 { out["unmirror"] = mirror(false)["ok"] }
    if vdisplay != nil {
        let id = vid
        weak let probe = vdisplay
        destroying = true
        vdisplay = nil                    // releasing the object removes the display
        out["deallocated"] = probe == nil
        out["gone"] = waitFor({ !((fresh(id)["online"] as? Bool) ?? true) }, 5, abortable: false)
        vid = 0
        destroying = false
    }
    out["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
    let m = fresh(0)
    out["main"] = m["main"] ?? 0
    out["mainMode"] = m["mode"] ?? [:]
    return out
}

// ── one-shot subcommands (a fresh CoreGraphics cache each run) ──────────
let argv = CommandLine.arguments
if dry && argv.count > 1 && argv[1].hasPrefix("--") {
    switch argv[1] {
    case "--query":
        emit(dryQuery(CGDirectDisplayID(argv.count > 2 ? UInt32(argv[2]) ?? 0 : 0)))
    case "--state":
        vid = CGDirectDisplayID(argv.count > 2 ? UInt32(argv[2]) ?? 0 : 0)
        mirroredFrom = CGDirectDisplayID(argv.count > 3 ? UInt32(argv[3]) ?? 0 : 0)
        emit(stateJSON())
    case "--set-mode":
        dryLog("set-mode \(argv.dropFirst(2).joined(separator: " ")) (dry)")
        emit(["ok": true, "gui": true, "dry": true])
    case "--restore":
        let only = argv.count > 2 ? Int(argv[2]) ?? 0 : -1
        var st = dryRead()
        let v = (st["vid"] as? Int) ?? 0, m = ((st["mirroredFrom"] as? Int) ?? 0) != 0
        let hit = m && (only == -1 || only == 0 || only == v)
        if hit { st["mirroredFrom"] = 0; dryWrite(st) }
        dryLog("restore \(only == -1 ? "all" : String(only)) (dry): \(hit ? "would unmirror the built-in" : "nothing mirrored")")
        emit(["ok": true, "dry": true, "unmirrored": hit ? [Int(dryBuiltin)] : [Int](), "main": Int(dryBuiltin)])
    default:
        emit(["ok": false, "error": "unknown option"]); exit(2)
    }
    exit(0)
}
if argv.count > 1 && argv[1].hasPrefix("--") {
    switch argv[1] {
    case "--query":       // --query <id>  (0 = the main display)
        var id = CGDirectDisplayID(argv.count > 2 ? UInt32(argv[2]) ?? 0 : 0)
        if id == 0 { id = CGMainDisplayID() }
        var seen = Set<[Int]>()
        let list = allModes(id).map { [$0.width, $0.height, $0.pixelWidth, $0.pixelHeight, $0.isUsableForDesktopGUI() ? 1 : 0] }.filter { seen.insert($0).inserted }
        emit(["id": Int(id), "online": online().contains(id), "main": Int(CGMainDisplayID()), "mirrorOf": Int(CGDisplayMirrorsDisplay(id)), "mode": modeJSON(id), "bounds": boundsJSON(id), "modes": list])
    case "--state":       // --state <virtualId> <mirroredFrom>
        vid = CGDirectDisplayID(argv.count > 2 ? UInt32(argv[2]) ?? 0 : 0)
        mirroredFrom = CGDirectDisplayID(argv.count > 3 ? UInt32(argv[3]) ?? 0 : 0)
        emit(stateJSON())
    case "--set-mode":    // --set-mode <id> <w> <h> <pixelW> <pixelH>
        let n = argv.dropFirst(2).compactMap { Int($0) }
        guard n.count == 5 else { emit(["ok": false, "error": "usage"]); exit(2) }
        let id = CGDirectDisplayID(n[0])
        guard let m = allModes(id).first(where: { $0.width == n[1] && $0.height == n[2] && $0.pixelWidth == n[3] && $0.pixelHeight == n[4] }) else {
            emit(["ok": false, "error": "no such mode"]); exit(3)
        }
        let e = configure { CGConfigureDisplayWithDisplayMode($0, id, m, nil) }
        emit(["ok": e == .success, "gui": m.isUsableForDesktopGUI(), "error": e == .success ? NSNull() : "set mode failed (\(e.rawValue))" as Any])
    case "--restore":     // undo mirroring left behind by a crashed helper
        // With an id: only displays mirroring that (virtual) display, so a
        // mirror the user set up (a TV) is left alone. Without: every one.
        let only = CGDirectDisplayID(argv.count > 2 ? UInt32(argv[2]) ?? 0 : 0)
        let mirrored = online().filter { CGDisplayMirrorsDisplay($0) != kCGNullDirectDisplay && (argv.count <= 2 || (only != 0 && CGDisplayMirrorsDisplay($0) == only) || isOurs(CGDisplayMirrorsDisplay($0))) }
        var e = CGError.success
        if !mirrored.isEmpty { e = configure { c in for d in mirrored { CGConfigureDisplayMirrorOfDisplay(c, d, kCGNullDirectDisplay) }; return .success } }
        emit(["ok": e == .success, "unmirrored": mirrored.map(Int.init), "main": Int(CGMainDisplayID())])
    default:
        emit(["ok": false, "error": "unknown option"]); exit(2)
    }
    exit(0)
}

// ── lifetime: any way out restores the Mac ──────────────────────────────
// Every command runs on the main thread, one at a time (the reader waits for
// each). A signal that lands mid-command is honoured right after it.
var busy = false, exitPending: String? = nil
func shutdown(_ why: String) {
    if busy { exitPending = why; return }
    busy = true
    if dry { dryLog("shutdown: \(why)\(vdisplay != nil || mirroredFrom != 0 ? " — restoring" : "")") }
    autoreleasepool { if vdisplay != nil || mirroredFrom != 0 { say("\(why): restoring"); let r = destroy(); say("restored \(r)") } }
    exit(0)
}
var sigSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGPIPE] {
    signal(sig, SIG_IGN)
    // Delivered off the main thread, so a command in progress sees abortFlag.
    let s = DispatchSource.makeSignalSource(signal: sig, queue: .global())
    s.setEventHandler { abortFlag = true; DispatchQueue.main.async { shutdown("signal \(sig)") } }
    s.resume(); sigSources.append(s)
}
// Re-parenting to launchd means the service is gone even if stdin somehow
// stayed open.
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in if getppid() != parent { shutdown("parent gone") } }

func handle(_ line: String) {
    let p = line.split(separator: " ").map(String.init)
    guard let cmd = p.first else { return }
    let int = { (i: Int) -> Int in i < p.count ? Int(p[i]) ?? 0 : 0 }
    var r: [String: Any] = [:]
    busy = true
    autoreleasepool {
        switch cmd {
        case "create": r = create(int(1), int(2), int(3) != 0, p.count > 4 ? p[4...].joined(separator: " ") : "SoA Remote")
        case "resize": r = resize(int(1), int(2), int(3) != 0)
        case "mirror": r = (p.count > 1 && (p[1] == "on" || p[1] == "off")) ? mirror(p[1] == "on") : ["ok": false, "error": "usage: mirror on|off"]
        case "extend": r = p.count == 2 ? extend(p[1]) : ["ok": false, "error": "usage: extend left|right"]
        case "state": r = ["ok": true, "state": sub(["--state", String(vid), String(mirroredFrom)])]
        case "destroy", "quit": r = destroy()
        default: r = ["ok": false, "error": "unknown command"]
        }
    }
    busy = false
    r["cmd"] = cmd
    if dry && cmd != "create" && cmd != "resize" && cmd != "mirror" { dryLog("\(cmd) → ok=\((r["ok"] as? Bool) ?? false)") }
    emit(r)
    if cmd == "quit" { exit(0) }
    if let why = exitPending { shutdown(why) }
}

Thread {
    while let line = readLine() {
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { handle(line); done.signal() }
        done.wait()
    }
    DispatchQueue.main.async { shutdown("stdin closed") }
}.start()

RunLoop.main.run()
