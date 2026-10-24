# iOS 壳层

原生 SwiftUI App，只做两件事：**登录**和**把后端的数据渲染出来**。所有数据（线程、消息、审批）都来自后端 API，App 本身不存业务数据，也不直连模型服务。

## 目录

```
apps/
├── apple/WangkeKit/          # iOS 与 macOS 共用的 Swift 包
│   ├── Sources/WangkeKit/    # 纯 Foundation：API 客户端、数据模型、事件流解析、消息分组、钥匙串
│   ├── Sources/WangkeUI/     # SwiftUI：登录页、线程列表、iMessage 式对话、输入栏
│   └── Tests/                # 单元测试 + 对真实后端的联调测试
└── ios/
    ├── project.yml           # XcodeGen 工程描述
    └── WangkeAgent/          # App 入口（十几行）和资源
```

以后加 macOS 壳层：新建 `apps/macos/`，同样依赖 `WangkeKit` 和 `WangkeUI`，入口里把 `ThreadListView` 换成 `NavigationSplitView` 即可，登录、网络、气泡、输入栏全部复用。`WangkeUI` 里平台相关的地方已经用 `#if os(iOS)` 分好了。

## 跑起来

需要 Xcode 15 或更新（iOS 17 SDK）。

```bash
brew install xcodegen
cd apps/ios
xcodegen            # 生成 WangkeAgent.xcodeproj（不进仓库）
open WangkeAgent.xcodeproj
```

选一个模拟器运行。登录页填：

- 服务器地址：比如 `https://agent.example.com`，或者局域网里的 `http://192.168.1.10:3000`（只放行了局域网 http，公网必须 https）；
- 用户名 / 密码：网页端初始化时创建的管理员。

后端需要包含「前后端分离」那个 PR 里的 `POST /api/v1/auth/token`。连到旧版本服务端时，登录页会提示先升级服务端。

## 鉴权

- 登录调 `POST /api/v1/auth/token`，拿到的 Bearer token 连同服务器地址一起存进钥匙串（`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`，不随 iCloud 同步）。
- 之后每个请求带 `Authorization: Bearer`，不用 Cookie，也不需要后端开 CORS。
- 退出登录会调 `POST /api/v1/auth/logout` 吊销 token；任何请求返回 401 时 App 清掉本地凭据回到登录页。

## 界面

按 iOS Messages 的规则：

- 自己的消息靠右、系统强调色；Bot 靠左、系统灰（`systemGray5`，深浅色自动适配）。
- 同一方 2 分钟内的连续消息算一组，组间 10pt、组内 2pt，只有每组最后一条带尾巴；相隔 15 分钟以上才插一行时间。规则和网页端 `src/pages/botMessages.ts` 一致，`MessageGrouping` 有单测。
- 进度消息显示成「正在输入」三个点；审批消息里直接是「拒绝 / 批准」；附件显示文件名和大小；双击 Bot 的气泡点赞。
- 输入栏是胶囊形，`TextField(axis: .vertical)` 自动增高到 8 行后内部滚动；有字时发送键弹出。中文输入法组字由系统处理，不会误发。
- 消息列表是 `LazyVStack`，长线程只创建可见的行；默认停在底部，新消息到达时滚到最新。
- 没有副标题和说明文字。

## 测试

`WangkeKit` 不依赖 UIKit / SwiftUI，在 macOS 和 Linux 上都能跑：

```bash
cd apps/apple/WangkeKit
swift test                                   # 单元测试（分组、解码、SSE 解析、请求构造）

# 对真实后端联调：登录 → 建线程 → 发消息 → 事件流收到 → 退出后 token 失效
WANGKE_E2E_URL=http://127.0.0.1:3000 WANGKE_E2E_PASSWORD='管理员密码' swift test --filter LiveServerTests
```

## 现状说明

- `WangkeKit`（网络、模型、鉴权、分组）在 Linux 上用 Swift 6.0.3 编译通过，8 个单元测试和对本地后端的联调测试都通过。
- `WangkeUI` 和 App 入口依赖 SwiftUI，只能在 Apple 平台编译，**还没有在 Xcode 里编译和运行过**。首次打开可能需要修一些小的编译问题。
- 附件上传、Passkey 登录、扫码配对还没做，按需求只实现了登录和渲染。
