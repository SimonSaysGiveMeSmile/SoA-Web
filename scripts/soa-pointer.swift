// SoA Pointer — the direct input path for soa-desktop-remote.
//
// Every remote input (move, click, scroll, key, text, drag) is posted here
// as a CGEvent, in-process: no CLI spawned per event, no window lookup, no
// other app that has to be running. Posting needs Accessibility, and macOS
// charges that permission to the app that launched a process, so this runs
// as its own background app bundle (built by soa-desktop-remote and launched
// through LaunchServices): the grant covers this one tool, not node or a
// terminal. Until it is granted the service uses its slower fallback.
//
// It listens on a unix socket (path in argv[1], or SOA_POINTER_SOCK), one
// client at a time, and reads one command per line (many lines per write are
// fine). Points are global display points; <mods> is a comma list of
// cmd,shift,alt,ctrl,fn (aliases: command, meta, option, opt, control), or
// "-" for none.
//
//     move   <x> <y>                         mouse moved (dragged while a button is held)
//     click  <x> <y> [left|right|middle] [count 1-3] [mods]
//     down   <x> <y> [left|right|middle] [mods]   press and hold
//     drag   <x> <y>                         move with the held button
//     up     <x> <y>                         release the held button
//     scroll <dx> <dy> [pixel|line] [<x> <y>]     +dy shows what is below, +dx what is right;
//                                            with a point the cursor goes there first
//     key    <name|char|kc:N> [mods]         one key press (modifiers pressed around it)
//     text   <percent-encoded UTF-8 | b64:...>    typed as Unicode, one grapheme per event
//     modset <mods>                          hold exactly these modifiers ("-" releases all)
//     status                                 "ready <0|1>" (+ " dry" in dry mode)
//     where                                  "at <x> <y>" (the cursor, read only)
//     ping                                   "pong"
//
// Each line is answered, in order, with "ok", "err <reason>" or the reply
// named above; 1 means macOS lets this app post events. Nothing is posted
// without that permission. Replies are written without blocking: a client
// that stops reading never delays the events behind it.
//
// SOA_POINTER_DRY=1: post nothing, ask for nothing — print each event that
// would have been posted ("dry <event> ...") and answer as if permitted.
//
// Never leaks a held button or modifier: both are released when the client
// goes away, and a press of a different button releases the held one.
import Foundation
import CoreGraphics
import Carbon

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)   // a reply to a vanished peer must fail with EPIPE, not kill us before the button is released
let env = ProcessInfo.processInfo.environment
let DRY = env["SOA_POINTER_DRY"] == "1"
let args = CommandLine.arguments
let sockPath = args.count > 1 ? args[1]
    : (env["SOA_POINTER_SOCK"] ?? (NSHomeDirectory() + "/.soa-web-local/desktop-remote/pointer.sock"))

if !DRY && !CGPreflightPostEventAccess() { _ = CGRequestPostEventAccess() }   // shows the system prompt once

// The permission is checked at most once a second: a batch of lines costs one check.
var permCache = (at: 0.0, ok: false)
func permitted() -> Bool {
    if DRY { return true }
    let now = Date().timeIntervalSince1970
    if now - permCache.at > 1 { permCache = (now, CGPreflightPostEventAccess()) }
    return permCache.ok
}

let src = CGEventSource(stateID: .hidSystemState)
// Remote events must not lock out the person at the Mac's own mouse and keyboard.
src?.localEventsSuppressionInterval = 0
var held: CGMouseButton? = nil
var heldMods: CGEventFlags = []

// ── posting ─────────────────────────────────────────────────────────────
func typeName(_ t: CGEventType) -> String {
    switch t {
    case .mouseMoved: return "mouseMoved"
    case .leftMouseDown: return "leftMouseDown"; case .leftMouseUp: return "leftMouseUp"; case .leftMouseDragged: return "leftMouseDragged"
    case .rightMouseDown: return "rightMouseDown"; case .rightMouseUp: return "rightMouseUp"; case .rightMouseDragged: return "rightMouseDragged"
    case .otherMouseDown: return "otherMouseDown"; case .otherMouseUp: return "otherMouseUp"; case .otherMouseDragged: return "otherMouseDragged"
    case .keyDown: return "keyDown"; case .keyUp: return "keyUp"; case .flagsChanged: return "flagsChanged"
    case .scrollWheel: return "scrollWheel"
    default: return "type\(t.rawValue)"
    }
}
func flagNames(_ f: CGEventFlags) -> String {
    var n = [String]()
    if f.contains(.maskCommand) { n.append("cmd") }
    if f.contains(.maskShift) { n.append("shift") }
    if f.contains(.maskAlternate) { n.append("alt") }
    if f.contains(.maskControl) { n.append("ctrl") }
    if f.contains(.maskSecondaryFn) { n.append("fn") }
    if f.contains(.maskNumericPad) { n.append("numpad") }
    return n.isEmpty ? "-" : n.joined(separator: ",")
}
func emit(_ e: CGEvent, _ detail: String) {
    if DRY { print("dry \(typeName(e.type)) \(detail) flags=\(flagNames(e.flags))"); return }
    e.post(tap: .cghidEventTap)
}

func mouseTypes(_ b: CGMouseButton) -> (down: CGEventType, up: CGEventType, drag: CGEventType) {
    switch b {
    case .left: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
    case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
    default: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
    }
}
func mouse(_ type: CGEventType, _ p: CGPoint, _ b: CGMouseButton, clicks: Int64 = 1, flags: CGEventFlags = []) -> Bool {
    guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: b) else { return false }
    if type != .mouseMoved { e.setIntegerValueField(.mouseEventClickState, value: clicks) }
    if b == .center { e.setIntegerValueField(.mouseEventButtonNumber, value: 2) }
    e.flags = flags.union(heldMods)
    emit(e, "x=\(Int(p.x)) y=\(Int(p.y))" + (type == .mouseMoved ? "" : " button=\(b.rawValue) clicks=\(clicks)"))
    return true
}
func cursorAt() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }
// Move there first (dragged while held) so hover state and the window under
// the point are right before anything else lands; skipped when already there.
func moveTo(_ p: CGPoint) {
    let c = cursorAt()
    if abs(c.x - p.x) < 0.5 && abs(c.y - p.y) < 0.5 { return }
    if let b = held { _ = mouse(mouseTypes(b).drag, p, b) } else { _ = mouse(.mouseMoved, p, .left) }
}
func releaseHeld(_ p: CGPoint) {
    guard let b = held else { return }
    held = nil
    _ = mouse(mouseTypes(b).up, p, b)
}

// ── keyboard ────────────────────────────────────────────────────────────
let MOD_KEYS: [(CGKeyCode, CGEventFlags)] = [(59, .maskControl), (58, .maskAlternate), (56, .maskShift), (55, .maskCommand), (63, .maskSecondaryFn)]
func parseMods(_ s: String?) -> CGEventFlags? {
    guard let s = s, !s.isEmpty, s != "-", s != "none" else { return [] }
    var f: CGEventFlags = []
    for t in s.lowercased().split(whereSeparator: { $0 == "," || $0 == "+" }) {
        switch t {
        case "cmd", "command", "meta": f.insert(.maskCommand)
        case "shift": f.insert(.maskShift)
        case "alt", "option", "opt": f.insert(.maskAlternate)
        case "ctrl", "control": f.insert(.maskControl)
        case "fn": f.insert(.maskSecondaryFn)
        default: return nil
        }
    }
    return f
}
func keyEvent(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags, flagsChanged: Bool = false, unicode: [UniChar] = []) -> Bool {
    guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { return false }
    if flagsChanged { e.type = .flagsChanged }
    e.flags = flags
    if !unicode.isEmpty { e.keyboardSetUnicodeString(stringLength: unicode.count, unicodeString: unicode) }
    let u = unicode.isEmpty ? "" : " text=" + (String(utf16CodeUnits: unicode, count: unicode.count).addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "?")
    emit(e, "key=\(code)\(flagsChanged ? (down ? " down" : " up") : "")\(u)")
    return true
}
// Press the modifiers in `want` that are not held yet, run `body` with the
// combined flags, release them again (in reverse) — never left pressed.
func withMods(_ want: CGEventFlags, _ body: (CGEventFlags) -> Bool) -> Bool {
    var cur = heldMods
    var pressed = [(CGKeyCode, CGEventFlags)]()
    for (kc, m) in MOD_KEYS where want.contains(m) && !cur.contains(m) {
        cur.insert(m); _ = keyEvent(kc, true, cur, flagsChanged: true); pressed.append((kc, m))
    }
    let ok = body(cur)
    for (kc, m) in pressed.reversed() { cur.remove(m); _ = keyEvent(kc, false, cur, flagsChanged: true) }
    return ok
}
func setHeldMods(_ want: CGEventFlags) {
    for (kc, m) in MOD_KEYS where want.contains(m) && !heldMods.contains(m) { heldMods.insert(m); _ = keyEvent(kc, true, heldMods, flagsChanged: true) }
    for (kc, m) in MOD_KEYS.reversed() where !want.contains(m) && heldMods.contains(m) { heldMods.remove(m); _ = keyEvent(kc, false, heldMods, flagsChanged: true) }
}

// Named keys: virtual keycode + the flags real hardware sets on that key.
let NAMED: [String: (CGKeyCode, CGEventFlags)] = {
    let nav: CGEventFlags = [.maskSecondaryFn], arrow: CGEventFlags = [.maskSecondaryFn, .maskNumericPad]
    var m: [String: (CGKeyCode, CGEventFlags)] = [
        "return": (36, []), "enter": (36, []), "kpenter": (76, [.maskNumericPad]), "tab": (48, []), "space": (49, []),
        "escape": (53, []), "esc": (53, []), "delete": (51, []), "backspace": (51, []),
        "forwarddelete": (117, nav), "forward_delete": (117, nav), "del": (117, nav),
        "home": (115, nav), "end": (119, nav), "pageup": (116, nav), "page_up": (116, nav), "pagedown": (121, nav), "page_down": (121, nav),
        "left": (123, arrow), "right": (124, arrow), "down": (125, arrow), "up": (126, arrow),
        "arrowleft": (123, arrow), "arrowright": (124, arrow), "arrowdown": (125, arrow), "arrowup": (126, arrow),
        "help": (114, nav), "capslock": (57, []),
    ]
    let f: [CGKeyCode] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]
    for (i, kc) in f.enumerated() { m["f\(i + 1)"] = (kc, nav) }
    return m
}()
// US ANSI positions: the fallback when the current layout cannot be read.
let US: [Character: (CGKeyCode, Bool)] = {
    var m = [Character: (CGKeyCode, Bool)]()
    let plain: [(String, CGKeyCode)] = [("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7), ("c", 8), ("v", 9), ("b", 11), ("q", 12),
        ("w", 13), ("e", 14), ("r", 15), ("y", 16), ("t", 17), ("1", 18), ("2", 19), ("3", 20), ("4", 21), ("6", 22), ("5", 23), ("=", 24), ("9", 25),
        ("7", 26), ("-", 27), ("8", 28), ("0", 29), ("]", 30), ("o", 31), ("u", 32), ("[", 33), ("i", 34), ("p", 35), ("l", 37), ("j", 38), ("'", 39),
        ("k", 40), (";", 41), ("\\", 42), (",", 43), ("/", 44), ("n", 45), ("m", 46), (".", 47), ("`", 50), (" ", 49)]
    for (s, kc) in plain { m[Character(s)] = (kc, false) }
    for ch in "abcdefghijklmnopqrstuvwxyz" { if let v = m[ch] { m[Character(ch.uppercased())] = (v.0, true) } }
    let shifted: [(String, String)] = [("!", "1"), ("@", "2"), ("#", "3"), ("$", "4"), ("%", "5"), ("^", "6"), ("&", "7"), ("*", "8"), ("(", "9"), (")", "0"),
        ("_", "-"), ("+", "="), ("{", "["), ("}", "]"), ("|", "\\"), (":", ";"), ("\"", "'"), ("<", ","), (">", "."), ("?", "/"), ("~", "`")]
    for (s, base) in shifted { if let v = m[Character(base)] { m[Character(s)] = (v.0, true) } }
    return m
}()
// The current keyboard layout's characters → (keycode, needs shift), so a
// shortcut like ⌘Z presses the key that types "z" on THIS Mac's layout.
// Read at start and re-read only while idle (no input for 2 s, at most every
// 10 s), never in the path of an event: a read costs ~20 ms. TIS is called on
// this, the main, thread.
let KEYPAD: Set<Int> = [65, 67, 69, 71, 75, 76, 78, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92]
var layoutMap = [Character: (CGKeyCode, Bool)](), layoutAt = 0.0
func currentLayout() -> [Character: (CGKeyCode, Bool)] { layoutAt == 0 ? readLayout() : layoutMap }
func readLayout() -> [Character: (CGKeyCode, Bool)] {
    layoutAt = Date().timeIntervalSince1970
    var map = [Character: (CGKeyCode, Bool)]()
    guard let tis = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
          let raw = TISGetInputSourceProperty(tis, kTISPropertyUnicodeKeyLayoutData) else { layoutMap = [:]; return layoutMap }
    let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
    data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
        guard let layout = buf.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
        for shift in [false, true] {
            for kc in 0..<128 where !KEYPAD.contains(kc) {
                var dead: UInt32 = 0, len = 0
                var chars = [UniChar](repeating: 0, count: 4)
                let mod: UInt32 = shift ? UInt32((shiftKey >> 8) & 0xff) : 0
                let st = UCKeyTranslate(layout, UInt16(kc), UInt16(kUCKeyActionDown), mod, UInt32(LMGetKbdType()),
                                        OptionBits(1 << kUCKeyTranslateNoDeadKeysBit), &dead, 4, &len, &chars)
                guard st == noErr, len > 0 else { continue }
                let s = String(utf16CodeUnits: chars, count: len)
                guard s.count == 1, let ch = s.first, let sc = s.unicodeScalars.first, sc.value >= 0x20, sc.value != 0x7f else { continue }
                if map[ch] == nil { map[ch] = (CGKeyCode(kc), shift) }
            }
        }
    }
    layoutMap = map
    return map
}
func charKey(_ ch: Character) -> (CGKeyCode, Bool)? { currentLayout()[ch] ?? (layoutMap.isEmpty ? US[ch] : nil) }

func resolveKey(_ tokIn: String) -> (CGKeyCode, CGEventFlags)? {
    var tok = tokIn
    if tok.count > 1, tok.contains("%"), let d = tok.removingPercentEncoding { tok = d }
    if let n = NAMED[tok.lowercased()] { return n }
    if tok.lowercased().hasPrefix("kc:"), let n = Int(tok.dropFirst(3)), n >= 0, n < 128 { return (CGKeyCode(n), []) }
    guard tok.count == 1, let ch = tok.first else { return nil }
    if ch == " " { return NAMED["space"] }
    if let (kc, shift) = charKey(ch) { return (kc, shift ? [.maskShift] : []) }
    return nil
}
// `mods` are pressed as keys around the press; `intrinsic` (the fn/numpad
// flags hardware sets on arrows and nav keys) only marks the key's own events.
func pressKey(_ code: CGKeyCode, _ mods: CGEventFlags, intrinsic: CGEventFlags = []) -> Bool {
    return withMods(mods) { cur in
        keyEvent(code, true, cur.union(intrinsic)) && keyEvent(code, false, cur.union(intrinsic))
    }
}
// One key event pair per grapheme (an emoji or a combined accent stays one
// event), carried as a Unicode string; a character this layout types with
// one key also carries that key, so apps that read key codes see the right
// one. Newline and tab are their keys. SOA_POINTER_TEXT_CHUNK > 1 packs up to
// that many UTF-16 units per event (max 20) for apps that accept it.
let TEXT_CHUNK = max(1, min(20, Int(env["SOA_POINTER_TEXT_CHUNK"] ?? "1") ?? 1))
func typeText(_ s: String) -> Bool {
    var chunk = [UniChar](), posted = 0
    func flush() {
        guard !chunk.isEmpty else { return }
        let k: (CGKeyCode, Bool)? = TEXT_CHUNK == 1 ? String(utf16CodeUnits: chunk, count: chunk.count).first.flatMap(charKey) : nil
        let code = k?.0 ?? 0, f: CGEventFlags = (k?.1 ?? false) ? [.maskShift] : []
        _ = keyEvent(code, true, f, unicode: chunk); _ = keyEvent(code, false, f, unicode: chunk)
        chunk = []
        posted += 1
        if posted % 64 == 0 && !DRY { usleep(1000) }   // let the target app breathe on long pastes
    }
    for ch in s {
        if ch == "\n" || ch == "\r\n" || ch == "\r" { flush(); _ = pressKey(36, []); continue }
        if ch == "\t" { flush(); _ = pressKey(48, []); continue }
        let u = Array(String(ch).utf16)
        if !chunk.isEmpty && (TEXT_CHUNK == 1 || chunk.count + u.count > TEXT_CHUNK) { flush() }
        chunk += u
        if TEXT_CHUNK == 1 || chunk.count >= TEXT_CHUNK { flush() }
    }
    flush()
    return true
}
func decodeText(_ s: String) -> String? {
    if s.hasPrefix("b64:") { return Data(base64Encoded: String(s.dropFirst(4))).flatMap { String(data: $0, encoding: .utf8) } }
    return s.removingPercentEncoding
}

// ── commands ────────────────────────────────────────────────────────────
func button(_ s: String?) -> CGMouseButton? {
    switch s ?? "left" { case "left": return .left; case "right": return .right; case "middle", "center": return .center; default: return nil }
}
func point(_ f: [String], _ i: Int) -> CGPoint? {
    guard f.count > i + 1, let x = Double(f[i]), let y = Double(f[i + 1]), x.isFinite, y.isFinite,
          abs(x) < 100000, abs(y) < 100000 else { return nil }
    return CGPoint(x: x, y: y)
}

func handle(_ raw: String) -> String {
    let line = raw.hasSuffix("\r") ? String(raw.dropLast()) : raw
    let f = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
    guard let cmd = f.first else { return "err empty" }
    switch cmd {
    case "status": return "ready \(permitted() ? 1 : 0)" + (DRY ? " dry" : "")
    case "ping": return "pong"
    case "where": let c = cursorAt(); return "at \(Int(c.x)) \(Int(c.y))"
    default: break
    }
    let known: Set<String> = ["move", "click", "down", "drag", "up", "scroll", "key", "text", "modset"]
    guard known.contains(cmd) else { return "err unknown \(cmd)" }
    if !permitted() { return "err not permitted" }
    switch cmd {
    case "move":
        guard let p = point(f, 1) else { return "err bad command" }
        if let b = held { return mouse(mouseTypes(b).drag, p, b) ? "ok" : "err event" }
        return mouse(.mouseMoved, p, .left) ? "ok" : "err event"
    case "click":
        guard let p = point(f, 1), let b = button(f.count > 3 ? f[3] : nil) else { return "err bad command" }
        let count = max(1, min(3, f.count > 4 ? Int(f[4]) ?? 1 : 1))
        guard let mods = parseMods(f.count > 5 ? f[5] : nil) else { return "err bad mods" }
        releaseHeld(p)                                          // a click is never folded into a held press
        moveTo(p)
        let t = mouseTypes(b)
        let ok = withMods(mods) { cur in
            var ok = true
            // A double click is press-release with clickState 1, then 2 (then 3).
            for n in 1...count { ok = mouse(t.down, p, b, clicks: Int64(n), flags: cur) && mouse(t.up, p, b, clicks: Int64(n), flags: cur) && ok }
            return ok
        }
        return ok ? "ok" : "err event"
    case "down":
        guard let p = point(f, 1), let b = button(f.count > 3 ? f[3] : nil) else { return "err bad command" }
        guard let mods = parseMods(f.count > 4 ? f[4] : nil) else { return "err bad mods" }
        if let h = held, h != b { releaseHeld(p) }             // never leak a different held button
        held = b
        return mouse(mouseTypes(b).down, p, b, flags: mods) ? "ok" : "err event"
    case "drag":
        guard let p = point(f, 1) else { return "err bad command" }
        guard let b = held else { return "err not held" }      // no press, no synthetic button
        return mouse(mouseTypes(b).drag, p, b) ? "ok" : "err event"
    case "up":
        guard let p = point(f, 1) else { return "err bad command" }
        guard let b = held else { return "err not held" }
        held = nil
        return mouse(mouseTypes(b).up, p, b) ? "ok" : "err event"
    case "scroll":
        guard f.count >= 3, let dx = Double(f[1]), let dy = Double(f[2]), dx.isFinite, dy.isFinite else { return "err bad command" }
        let unitName = f.count > 3 ? f[3] : "pixel"
        guard unitName == "pixel" || unitName == "line" else { return "err bad unit" }
        var at: CGPoint? = nil
        if f.count > 4 { guard let p = point(f, 4) else { return "err bad command" }; at = p }
        if let p = at { moveTo(p) }
        let lim = unitName == "pixel" ? 10000.0 : 100.0
        let w1 = Int32(max(-lim, min(lim, -dy)).rounded()), w2 = Int32(max(-lim, min(lim, -dx)).rounded())
        if w1 == 0 && w2 == 0 { return "ok" }
        guard let e = CGEvent(scrollWheelEvent2Source: src, units: unitName == "pixel" ? .pixel : .line, wheelCount: 2, wheel1: w1, wheel2: w2, wheel3: 0) else { return "err event" }
        if unitName == "pixel" { e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1) }
        if let p = at { e.location = p }
        e.flags = heldMods
        emit(e, "dx=\(Int(dx)) dy=\(Int(dy)) unit=\(unitName)" + (at.map { " x=\(Int($0.x)) y=\(Int($0.y))" } ?? ""))
        return "ok"
    case "key":
        guard f.count >= 2, let (code, intrinsic) = resolveKey(f[1]) else { return "err bad key" }
        guard let mods = parseMods(f.count > 2 ? f[2] : nil) else { return "err bad mods" }
        // A layout character that needs shift ("$") presses shift; fn/numpad only mark the key.
        let shift = intrinsic.intersection([.maskShift])
        return pressKey(code, mods.union(shift), intrinsic: intrinsic.subtracting(shift)) ? "ok" : "err event"
    case "text":
        guard f.count >= 2, let s = decodeText(f[1]) else { return "err bad text" }
        return typeText(s) ? "ok" : "err event"
    case "modset":
        guard let mods = parseMods(f.count > 1 ? f[1] : nil) else { return "err bad mods" }
        setHeldMods(mods)
        return "ok"
    default:
        return "err unknown \(cmd)"
    }
}

// ── unix socket server, one client at a time ─────────────────────────────
unlink(sockPath)
let fd = socket(AF_UNIX, SOCK_STREAM, 0)
guard fd >= 0 else { print("socket failed"); exit(1) }
var addr = sockaddr_un()
addr.sun_family = sa_family_t(AF_UNIX)
let pathBytes = Array(sockPath.utf8)
guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { print("socket path too long"); exit(1) }
withUnsafeMutableBytes(of: &addr.sun_path) { buf in
    for (i, b) in pathBytes.enumerated() { buf[i] = b }
    buf[pathBytes.count] = 0
}
let bound = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
}
guard bound == 0 else { print("bind failed \(errno)"); exit(1) }
chmod(sockPath, 0o600)
listen(fd, 4)
_ = readLayout()
print("listening \(sockPath) ready \(permitted() ? 1 : 0)\(DRY ? " dry" : "")")

let MAX_OUT = 1 << 20, MAX_LINE = 1 << 20
while true {
    let c = accept(fd, nil, nil)
    if c < 0 { continue }
    _ = fcntl(c, F_SETFL, fcntl(c, F_GETFL) | O_NONBLOCK)
    var one: Int32 = 1
    _ = setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    var pending = [UInt8](), out = [UInt8](), dropped = 0
    var buf = [UInt8](repeating: 0, count: 65536)
    var alive = true
    // Write what the socket takes now; the rest waits for POLLOUT. Never blocks.
    func flushOut() -> Bool {
        while !out.isEmpty {
            let n = out.withUnsafeBytes { write(c, $0.baseAddress, $0.count) }
            if n > 0 { out.removeFirst(n); continue }
            if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { return true }
            if n < 0 && errno == EINTR { continue }
            return false
        }
        return true
    }
    while alive {
        var pfd = pollfd(fd: c, events: Int16(POLLIN) | (out.isEmpty ? 0 : Int16(POLLOUT)), revents: 0)
        let r = poll(&pfd, 1, 2000)
        if r < 0 { if errno == EINTR { continue }; break }
        if r == 0 { if Date().timeIntervalSince1970 - layoutAt > 10 { _ = readLayout() }; continue }   // idle: refresh the layout
        if pfd.revents & Int16(POLLOUT) != 0 && !flushOut() { break }
        if pfd.revents & (Int16(POLLIN) | Int16(POLLHUP) | Int16(POLLERR)) == 0 { continue }
        var eof = false
        while true {
            let n = read(c, &buf, buf.count)
            if n > 0 { pending.append(contentsOf: buf[0..<n]); if n < buf.count { break } else { continue } }
            if n == 0 { eof = true; break }
            if errno == EINTR { continue }
            if errno != EAGAIN && errno != EWOULDBLOCK { eof = true }
            break
        }
        // Every complete line is acted on now, its reply queued behind it.
        var start = 0
        while let nl = pending[start...].firstIndex(of: 10) {
            let reply = handle(String(decoding: pending[start..<nl], as: UTF8.self))
            if out.count < MAX_OUT { out.append(contentsOf: Array((reply + "\n").utf8)) } else { dropped += 1 }
            start = nl + 1
        }
        if start > 0 { pending.removeFirst(start) }
        if pending.count > MAX_LINE { pending.removeAll() }    // no line is that long: drop the garbage
        if !flushOut() { eof = true }
        if eof { alive = false }
    }
    // a viewer that vanished mid-drag must not leave the button held, or a modifier down
    releaseHeld(cursorAt())
    setHeldMods([])
    if dropped > 0 { print("client stopped reading: \(dropped) replies dropped") }
    close(c)
}
