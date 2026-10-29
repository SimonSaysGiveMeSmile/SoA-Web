// soa-screen-stream — the Mac display as a low-latency H.264 stream.
//
// ScreenCaptureKit captures one display (the main one unless told otherwise),
// already scaled to the output
// size by the window server, and VideoToolbox encodes it in its low-latency
// rate-control mode (no B-frames, no frame delay, a keyframe at least every
// 2 s). Used by soa-desktop-remote; ffmpeg's AVFoundation screen input tops
// out near 12 fps on current macOS, this path keeps up with 30-60.
//
//   soa-screen-stream <width> <height> <fps> <bitrate-bps> [display-id]
//   soa-screen-stream --info [display-id]   a display's size + scale as JSON
//
// display-id is a CGDirectDisplayID (0 or absent = the main display). A
// display that ScreenCaptureKit does not list yet (one created a moment ago)
// is waited for briefly; one that never shows up falls back to the main
// display, and stderr says so.
//
// stdout, one record per encoded frame (access unit):
//   u32 BE  payload length
//   u8      flags (bit 0 = keyframe)
//   f64 BE  capture wall-clock time, ms since the epoch
//   ...     the access unit, Annex B (SPS + PPS lead every keyframe)
// stdin, one command per line:
//   idr               the next frame is a keyframe (re-encodes the last frame if the screen is idle)
//   bitrate <bps>     new target bitrate, applied live
//   size <w> <h>      new output size (the encoder restarts with a keyframe)
// stderr: diagnostics. Exit 2 = capture could not start (permission, no display).
import Foundation
import ScreenCaptureKit
import VideoToolbox
import CoreMedia

setvbuf(stderr, nil, _IONBF, 0)
func say(_ s: String) { FileHandle.standardError.write(("screen-stream: " + s + "\n").data(using: .utf8)!) }

let argv = CommandLine.arguments
// --info: the main display's size in points and its backing scale, as JSON
// (no capture, no permission) — the service's fallback when Sarea is down.
if argv.count > 1 && argv[1] == "--info" {
    let asked = argv.count > 2 ? UInt32(argv[2]) ?? 0 : 0
    let id = asked != 0 ? CGDirectDisplayID(asked) : CGMainDisplayID(), b = CGDisplayBounds(id)
    var scale = 1.0
    if let m = CGDisplayCopyDisplayMode(id), m.width > 0 { scale = Double(m.pixelWidth) / Double(m.width) }
    print("{\"width\":\(Int(b.width)),\"height\":\(Int(b.height)),\"scale_factor\":\(scale)}")
    exit(0)
}
var outW = argv.count > 1 ? Int(argv[1]) ?? 1920 : 1920
var outH = argv.count > 2 ? Int(argv[2]) ?? 1200 : 1200
let fps = max(5, min(60, argv.count > 3 ? Int(argv[3]) ?? 30 : 30))
var bitrate = max(500_000, argv.count > 4 ? Int(argv[4]) ?? 6_000_000 : 6_000_000)
let wantDisplay = CGDirectDisplayID(argv.count > 5 ? UInt32(argv[5]) ?? 0 : 0)

let encQ = DispatchQueue(label: "encode")      // owns every encoder variable below
let outQ = DispatchQueue(label: "stdout")
var session: VTCompressionSession?
var sessW = 0, sessH = 0
var forceKey = true
var lastBuffer: CVPixelBuffer?
var lastEncodeAt = 0.0
let out = FileHandle.standardOutput
let startCode: [UInt8] = [0, 0, 0, 1]

func setProp(_ s: VTCompressionSession, _ k: CFString, _ v: CFTypeRef) {
    let st = VTSessionSetProperty(s, key: k, value: v)
    if st != noErr { say("property \(k) not applied (\(st))") }
}
func applyBitrate(_ s: VTCompressionSession) {
    setProp(s, kVTCompressionPropertyKey_AverageBitRate, bitrate as CFNumber)
    // VBV-style cap: no half second may carry more than 1.25x its share, so a
    // burst (a keyframe, a full-screen change) cannot flood the link.
    let bytes = Double(bitrate) / 8.0 * 1.25 * 0.5
    setProp(s, kVTCompressionPropertyKey_DataRateLimits, [bytes, 0.5] as CFArray)
}

func makeSession(_ w: Int, _ h: Int) -> VTCompressionSession? {
    var s: VTCompressionSession?
    let spec: [CFString: Any] = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true]
    let st = VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h), codecType: kCMVideoCodecType_H264,
                                        encoderSpecification: spec as CFDictionary, imageBufferAttributes: nil,
                                        compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &s)
    guard st == noErr, let s = s else { say("encoder create failed (\(st))"); return nil }
    setProp(s, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
    setProp(s, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel)
    setProp(s, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
    setProp(s, kVTCompressionPropertyKey_MaxKeyFrameInterval, (fps * 2) as CFNumber)
    setProp(s, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 2.0 as CFNumber)
    setProp(s, kVTCompressionPropertyKey_ExpectedFrameRate, fps as CFNumber)
    setProp(s, kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2)
    setProp(s, kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2)
    setProp(s, kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2)
    applyBitrate(s)
    VTCompressionSessionPrepareToEncodeFrames(s)
    say("encoder \(w)x\(h) @\(fps) \(bitrate / 1000) kb/s")
    return s
}

func emit(_ sb: CMSampleBuffer, wallMs: Double) {
    var key = true
    if let att = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]],
       let first = att.first, let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool, notSync { key = false }
    guard let bb = CMSampleBufferGetDataBuffer(sb) else { return }
    var total = 0
    var ptr: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &total, dataPointerOut: &ptr) == noErr, let p = ptr else { return }
    var au = Data(capacity: total + 128)
    if key, let fd = CMSampleBufferGetFormatDescription(sb) {
        var count = 0
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fd, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
        for i in 0..<count {
            var ps: UnsafePointer<UInt8>?
            var n = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fd, parameterSetIndex: i, parameterSetPointerOut: &ps, parameterSetSizeOut: &n, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let ps = ps {
                au.append(contentsOf: startCode); au.append(ps, count: n)
            }
        }
    }
    // AVCC (4-byte lengths) → Annex B (start codes)
    let raw = UnsafeRawPointer(p)
    var off = 0
    while off + 4 <= total {
        let len = Int(raw.load(fromByteOffset: off, as: UInt32.self).bigEndian)
        off += 4
        if len <= 0 || off + len > total { break }
        au.append(contentsOf: startCode)
        au.append(raw.advanced(by: off).assumingMemoryBound(to: UInt8.self), count: len)
        off += len
    }
    var hdr = Data(count: 13)
    hdr.withUnsafeMutableBytes { (b: UnsafeMutableRawBufferPointer) in
        b.storeBytes(of: UInt32(au.count).bigEndian, toByteOffset: 0, as: UInt32.self)
        b.storeBytes(of: UInt8(key ? 1 : 0), toByteOffset: 4, as: UInt8.self)
        b.storeBytes(of: wallMs.bitPattern.bigEndian, toByteOffset: 5, as: UInt64.self)
    }
    outQ.async {
        do { try out.write(contentsOf: hdr + au) } catch { exit(0) }   // the service went away
    }
}

// Runs on encQ.
func encode(_ pb: CVPixelBuffer, wallMs: Double) {
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    if session == nil || w != sessW || h != sessH {
        if let old = session { VTCompressionSessionCompleteFrames(old, untilPresentationTimeStamp: .invalid); VTCompressionSessionInvalidate(old) }
        session = makeSession(w, h); sessW = w; sessH = h; forceKey = true
    }
    guard let s = session else { return }
    let pts = CMClockGetTime(CMClockGetHostTimeClock())
    var props: CFDictionary?
    if forceKey { props = [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary; forceKey = false }
    lastEncodeAt = Date().timeIntervalSince1970
    VTCompressionSessionEncodeFrame(s, imageBuffer: pb, presentationTimeStamp: pts, duration: CMTime(value: 1, timescale: CMTimeScale(fps)),
                                    frameProperties: props, infoFlagsOut: nil) { status, _, sb in
        if status == noErr, let sb = sb { emit(sb, wallMs: wallMs) }
        else if status != noErr { say("encode failed (\(status))") }
    }
}

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    var stream: SCStream?
    func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid,
              let att = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = att.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let wall = Date().timeIntervalSince1970 * 1000
        encQ.async { lastBuffer = pb; encode(pb, wallMs: wall) }
    }
    func stream(_ s: SCStream, didStopWithError error: Error) { say("capture stopped: \(error.localizedDescription)"); exit(3) }
}
let capture = Capture()

func config(_ w: Int, _ h: Int) -> SCStreamConfiguration {
    let c = SCStreamConfiguration()
    c.width = w; c.height = h
    c.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    c.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    c.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
    c.colorSpaceName = CGColorSpace.sRGB
    c.showsCursor = true
    c.queueDepth = 4
    return c
}

Task {
    do {
        var content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        if wantDisplay != 0 {
            // A display that was just created or reconfigured can take a moment to be listed.
            for _ in 0..<15 where !content.displays.contains(where: { $0.displayID == wantDisplay }) {
                try await Task.sleep(nanoseconds: 200_000_000)
                content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            }
            if !content.displays.contains(where: { $0.displayID == wantDisplay }) { say("display \(wantDisplay) not available — capturing the main display") }
        }
        let mainID = CGMainDisplayID()
        guard let display = content.displays.first(where: { wantDisplay != 0 && $0.displayID == wantDisplay })
            ?? content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else { say("no display"); exit(2) }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let s = SCStream(filter: filter, configuration: config(outW, outH), delegate: capture)
        try s.addStreamOutput(capture, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture"))
        try await s.startCapture()
        capture.stream = s
        say("capturing display \(display.displayID) \(display.width)x\(display.height) → \(outW)x\(outH)")
    } catch {
        say("error: \(error.localizedDescription)")
        exit(2)
    }
}

// Commands from the service.
Thread {
    while let line = readLine() {
        let p = line.split(separator: " ")
        guard let cmd = p.first else { continue }
        switch cmd {
        case "idr":
            encQ.async {
                forceKey = true
                // An idle screen produces no frames, so a viewer waiting for a
                // keyframe would wait forever: re-encode the last one.
                encQ.asyncAfter(deadline: .now() + 0.06) {
                    if forceKey, let pb = lastBuffer { encode(pb, wallMs: Date().timeIntervalSince1970 * 1000) }
                }
            }
        case "bitrate":
            if p.count > 1, let b = Int(p[1]) {
                encQ.async { bitrate = max(500_000, b); if let s = session { applyBitrate(s) } }
            }
        case "size":
            if p.count > 2, let w = Int(p[1]), let h = Int(p[2]), w > 0, h > 0 {
                outW = w; outH = h
                if let s = capture.stream {
                    s.updateConfiguration(config(w, h)) { err in if let err = err { say("resize failed: \(err.localizedDescription)") } }
                }
            }
        default: break
        }
    }
    exit(0)                                   // stdin closed: the service is gone
}.start()

RunLoop.main.run()
