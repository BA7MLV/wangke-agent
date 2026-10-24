// swift-tools-version: 5.9
import PackageDescription

// iOS 与 macOS 壳层共用的 Swift 包。
// - WangkeKit：纯 Foundation，网络、模型、鉴权、消息分组。Linux 上也能编译和测试。
// - WangkeUI：SwiftUI 界面（登录、线程列表、iMessage 式对话），两个平台共用。
let package = Package(
    name: "WangkeKit",
    defaultLocalization: "zh-Hans",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "WangkeKit", targets: ["WangkeKit"]),
        .library(name: "WangkeUI", targets: ["WangkeUI"]),
    ],
    targets: [
        .target(name: "WangkeKit"),
        .target(name: "WangkeUI", dependencies: ["WangkeKit"]),
        .testTarget(name: "WangkeKitTests", dependencies: ["WangkeKit"]),
    ]
)
