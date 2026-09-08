// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "XingqiaoDesktop",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "XingqiaoDesktop", targets: ["XingqiaoDesktop"])],
    targets: [
        .executableTarget(
            name: "XingqiaoDesktop",
            path: "Sources/XingqiaoDesktop",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("QuickLookUI"),
                .linkedFramework("WebKit"),
            ]
        ),
    ]
)
