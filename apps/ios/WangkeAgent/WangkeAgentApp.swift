import SwiftUI
import WangkeKit
import WangkeUI

/// iOS 壳层只负责两件事：登录、把后端的数据渲染出来。界面和网络都在共享包 WangkeKit / WangkeUI 里。
@main
struct WangkeAgentApp: App {
    @State private var model = AppModel(store: KeychainTokenStore())

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}
