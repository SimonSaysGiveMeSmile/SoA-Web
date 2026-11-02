// soa-thermal — one-shot thermal probe for scripts/soa-health.
//
// Prints ONE line of JSON and exits:
//   {"thermalState":"nominal|fair|serious|critical","thermalCode":0-3,
//    "sensors":[{"name":"PMU tdie1","c":41.2},…],"cpuC":41.2|null,"maxC":55.0|null,
//    "source":"hid"|"none","frontmost":{"pid":123,"name":"Safari","bundlePath":"/Applications/Safari.app"}|null}
//
// thermalState is ProcessInfo.thermalState (public API). Temperatures come from
// the IOHIDEventSystemClient temperature services (usage page 0xff00, usage 5),
// the technique open-source Mac monitors use; the symbols are resolved with
// dlsym at run time so a macOS that drops them degrades to thermal state only
// ("source":"none") instead of failing to launch. No sudo, no entitlement, no
// TCC permission is involved. The frontmost app comes from NSWorkspace (also
// permission-free) so the caller can protect it.
//
//   soa-thermal --paths <pid>… prints {"<pid>":"/real/executable/path",…}
//   (proc_pidpath: argv[0], which ps shows as "comm", can be bare or renamed).
//
// Build: swiftc -O -o <state>/health/soa-thermal scripts/soa-thermal.swift
import Foundation
import AppKit

if CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "--paths" {
    var m: [String: String] = [:]
    for a in CommandLine.arguments.dropFirst(2) {
        guard let pid = Int32(a), pid > 0 else { continue }
        var buf = [CChar](repeating: 0, count: 4096)   // PROC_PIDPATHINFO_MAXSIZE
        if proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 { m[a] = String(cString: buf) }
    }
    let d = try! JSONSerialization.data(withJSONObject: m, options: [])
    FileHandle.standardOutput.write(d)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(0)
}

typealias CreateFn = @convention(c) (CFAllocator?) -> UnsafeMutableRawPointer?
typealias SetMatchingFn = @convention(c) (UnsafeMutableRawPointer, CFDictionary) -> Int32
typealias CopyServicesFn = @convention(c) (UnsafeMutableRawPointer) -> Unmanaged<CFArray>?
typealias CopyPropFn = @convention(c) (UnsafeRawPointer, CFString) -> Unmanaged<CFTypeRef>?
typealias CopyEventFn = @convention(c) (UnsafeRawPointer, Int64, Int32, Int64) -> UnsafeMutableRawPointer?
typealias GetFloatFn = @convention(c) (UnsafeMutableRawPointer, Int32) -> Double

let kTempEventType: Int64 = 15 // kIOHIDEventTypeTemperature

func readSensors() -> [(String, Double)] {
    guard let h = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW) else { return [] }
    func sym<T>(_ n: String, _ t: T.Type) -> T? {
        guard let p = dlsym(h, n) else { return nil }
        return unsafeBitCast(p, to: t)
    }
    guard let create = sym("IOHIDEventSystemClientCreate", CreateFn.self),
          let setMatching = sym("IOHIDEventSystemClientSetMatching", SetMatchingFn.self),
          let copyServices = sym("IOHIDEventSystemClientCopyServices", CopyServicesFn.self),
          let copyProp = sym("IOHIDServiceClientCopyProperty", CopyPropFn.self),
          let copyEvent = sym("IOHIDServiceClientCopyEvent", CopyEventFn.self),
          let getFloat = sym("IOHIDEventGetFloatValue", GetFloatFn.self) else { return [] }
    guard let client = create(kCFAllocatorDefault) else { return [] }
    let match: [String: Any] = ["PrimaryUsagePage": 0xff00, "PrimaryUsage": 5]
    _ = setMatching(client, match as CFDictionary)
    guard let services = copyServices(client)?.takeRetainedValue() else { return [] }
    var out: [(String, Double)] = []
    let n = CFArrayGetCount(services)
    for i in 0..<n {
        guard let svc = CFArrayGetValueAtIndex(services, i) else { continue }
        var name = "sensor\(i)"
        if let p = copyProp(svc, "Product" as CFString)?.takeRetainedValue(), let s = p as? String { name = s }
        guard let ev = copyEvent(svc, kTempEventType, 0, 0) else { continue }
        let v = getFloat(ev, Int32(kTempEventType << 16))
        Unmanaged<CFTypeRef>.fromOpaque(ev).release()
        if v.isFinite && v > -20 && v < 150 { out.append((name, (v * 10).rounded() / 10)) }
    }
    return out
}

let ts = ProcessInfo.processInfo.thermalState
let states = ["nominal", "fair", "serious", "critical"]
let code: Int
switch ts {
case .nominal: code = 0
case .fair: code = 1
case .serious: code = 2
case .critical: code = 3
@unknown default: code = 0
}

let sensors = readSensors()
// CPU-die sensors on Apple Silicon ("PMU tdie*", "pACC/eACC MTR Temp Sensor*")
// and Intel ("CPU …"); battery/NAND/ambient sensors are excluded from cpuC.
let cpuVals = sensors.filter { s in
    let l = s.0.lowercased()
    return l.contains("tdie") || l.contains("acc mtr") || l.hasPrefix("cpu") || l.contains("soc mtr")
}.map { $0.1 }
let all = sensors.map { $0.1 }
func r1(_ d: Double) -> Double { (d * 10).rounded() / 10 }
let cpuC: Double? = cpuVals.isEmpty ? (all.isEmpty ? nil : r1(all.reduce(0, +) / Double(all.count))) : r1(cpuVals.reduce(0, +) / Double(cpuVals.count))
let maxC: Double? = all.max()

var front: [String: Any]? = nil
if let app = NSWorkspace.shared.frontmostApplication {
    front = ["pid": Int(app.processIdentifier), "name": app.localizedName ?? "", "bundlePath": app.bundleURL?.path ?? ""]
}

var obj: [String: Any] = [
    "thermalState": states[code], "thermalCode": code,
    "sensors": sensors.sorted { $0.0 < $1.0 }.map { ["name": $0.0, "c": $0.1] },
    "cpuC": cpuC as Any, "maxC": maxC as Any,
    "cpuSensors": cpuVals.count,
    "source": sensors.isEmpty ? "none" : "hid",
    "frontmost": front as Any,
]
if obj["cpuC"] is NSNull || cpuC == nil { obj["cpuC"] = NSNull() }
if maxC == nil { obj["maxC"] = NSNull() }
if front == nil { obj["frontmost"] = NSNull() }
let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
