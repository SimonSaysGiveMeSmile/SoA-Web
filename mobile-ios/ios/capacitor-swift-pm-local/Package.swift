// swift-tools-version:5.9
import PackageDescription

// Local vendored copy of ionic-team/capacitor-swift-pm 8.4.1 — the binary
// XCFrameworks are checked in beside this manifest so no network download is
// needed (xcodebuild's SPM artifact fetch stalls in this environment).
let package = Package(
    name: "capacitor-swift-pm",
    products: [
        .library(name: "Capacitor", targets: ["Capacitor"]),
        .library(name: "Cordova", targets: ["Cordova"])
    ],
    dependencies: [],
    targets: [
        .binaryTarget(name: "Capacitor", path: "Capacitor.xcframework"),
        .binaryTarget(name: "Cordova", path: "Cordova.xcframework")
    ]
)
