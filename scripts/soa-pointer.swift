// SoA Pointer — press, drag and release the mouse for soa-desktop-remote.
//
// The computeruse CLI can click but cannot hold a button down, so a drag
// (moving a window, selecting text, a slider) needs real mouse-down /
// mouse-dragged / mouse-up events. Posting those needs Accessibility, and
// macOS charges that permission to the app that launched a process, so this
// runs as its own background app bundle (built by soa-desktop-remote and
// launched through LaunchServices): the grant covers this one tool, not node
// or a terminal.
//
// It listens on a unix socket (path in argv[1], or SOA_POINTER_SOCK) and
// reads one command per line:
//
//     down <x> <y> [left|right]     press at a point (global display points)
//     drag <x> <y>                  move with the button held
//     up   <x> <y>                  release
//     status                        "ready <0|1>"
//
// answering "ok" / "err <reason>" / "ready <0|1>" per line; 1 means macOS
// lets this app post events. Nothing is posted without that permission.
import Foundation
import CoreGraphics

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)   // a reply to a vanished peer must fail with EPIPE, not kill us before the button is released
let args = CommandLine.arguments
let sockPath = args.count > 1 ? args[1]
    : (ProcessInfo.processInfo.environment["SOA_POINTER_SOCK"]
       ?? (NSHomeDirectory() + "/.soa-web-local/desktop-remote/pointer.sock"))

if !CGPreflightPostEventAccess() { _ = CGRequestPostEventAccess() }   // shows the system prompt once

let src = CGEventSource(stateID: .hidSystemState)
var held: CGMouseButton? = nil

func post(_ type: CGEventType, _ p: CGPoint, _ b: CGMouseButton) -> Bool {
    guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: b) else { return false }
    e.setIntegerValueField(.mouseEventClickState, value: 1)
    e.post(tap: .cghidEventTap)
    return true
}

func handle(_ line: String) -> String {
    let f = line.split(separator: " ").map(String.init)
    guard let cmd = f.first else { return "err empty" }
    if cmd == "status" { return "ready \(CGPreflightPostEventAccess() ? 1 : 0)" }
    guard f.count >= 3, let x = Double(f[1]), let y = Double(f[2]) else { return "err bad command" }
    if !CGPreflightPostEventAccess() { return "err not permitted" }
    let p = CGPoint(x: x, y: y)
    switch cmd {
    case "down":
        let b: CGMouseButton = (f.count > 3 && f[3] == "right") ? .right : .left
        if let h = held, h != b { _ = post(h == .right ? .rightMouseUp : .leftMouseUp, p, h) }   // never leak a different held button
        held = b
        return post(b == .right ? .rightMouseDown : .leftMouseDown, p, b) ? "ok" : "err event"
    case "drag":
        guard let b = held else { return "err not held" }      // no press, no synthetic button
        return post(b == .right ? .rightMouseDragged : .leftMouseDragged, p, b) ? "ok" : "err event"
    case "up":
        guard let b = held else { return "err not held" }
        held = nil
        return post(b == .right ? .rightMouseUp : .leftMouseUp, p, b) ? "ok" : "err event"
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
print("listening \(sockPath) ready \(CGPreflightPostEventAccess() ? 1 : 0)")

while true {
    let c = accept(fd, nil, nil)
    if c < 0 { continue }
    var pending = [UInt8]()
    var buf = [UInt8](repeating: 0, count: 4096)
    while true {
        let n = read(c, &buf, buf.count)
        if n <= 0 { break }
        pending.append(contentsOf: buf[0..<n])
        while let nl = pending.firstIndex(of: 10) {
            let line = String(decoding: pending[0..<nl], as: UTF8.self)
            pending.removeSubrange(0...nl)
            let reply = Array((handle(line) + "\n").utf8)
            _ = reply.withUnsafeBytes { write(c, $0.baseAddress, reply.count) }
        }
    }
    // a viewer that vanished mid-drag must not leave the button held down
    if let b = held { _ = post(b == .right ? .rightMouseUp : .leftMouseUp, CGEvent(source: nil)?.location ?? .zero, b); held = nil }
    close(c)
}
