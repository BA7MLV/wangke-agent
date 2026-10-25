# 顶部染色与渐进模糊

## 平台区别

- **Android Chrome（浏览器 / 独立 PWA）**：`meta[name="theme-color"]` 提供当前页面的浏览器 UI 建议色，优先于 manifest 的 `theme_color`。manifest 同时提供安装 / 启动的静态兜底色。建议用不透明 sRGB，而不是透明色或尚未解析的 CSS 变量。系统、浏览器深色模式及厂商实现仍可能调整最终显示。
- **旧版 Safari**：支持 `theme-color` 的版本可以使用它染色，但 Safari 仍可能按可读性调整某些颜色。
- **Safari 26**：不能假定只修改 `theme-color` 就会染色。根背景及视口边缘的 fixed / sticky 元素可能影响浏览器 UI 取色。贴边元素的 `background-color`、透明度、滤镜及弹层都需要考虑。这是版本相关的浏览器行为，不是可以跨平台保证的 Web 标准 API。
- **iOS 主屏幕 Web App**：还受 `apple-mobile-web-app-status-bar-style` 影响。`default` 与 `black-translucent` 不是两种颜色值，后者会改变内容与状态栏的覆盖关系。当前保留 `default`，不为了染色盲目切换到透明状态栏；`viewport-fit=cover` 本身不保证所有模式下页面都能绘制到状态栏后面。

普通浏览器、主屏幕 Web App、应用内 WebView 不是同一种运行环境，不能仅凭 User-Agent 判断最终效果。

## 原实现的问题

1. HTML 和 manifest 固定使用强调蓝 `#1677ff`，普通页面 / 深浅主题切换不更新。
2. 只有封面动态配色 hook 修改 meta，并在退出时还原旧快照，容易恢复成与当前主题无关的颜色。
3. 根背景使用 `--background`，应用画布使用 `--background-secondary`；顶栏又以 68% 的半透明色叠加滚动内容，三个位置的实际颜色不同。
4. 播放页顶部用 fixed 渐变伪元素衔接，但其 `background-color` 是透明的，不是可靠的 Safari 实色取色源。
5. 动态边缘色固定来自浅色表面，深色模式不成立；全局 auto 主题原先没有订阅系统模式的实时变化。

## 当前约定

- `PageShell` 定义 `--app-edge-color: var(--dyn-edge, var(--background-secondary))`。
- `.page-shell__top-edge` 提供贴顶、全视口宽、不透明的 `background-color`。高度为 `max(env(safe-area-inset-top), 4px)`，无交互、无滚动监听。
- 顶栏遮罩从相同实色开始，安全区之后向下衰减至透明；四层渐进模糊继续采样滚到栏后的实际内容。顶部不再从 68% 的透明混色开始。
- `ui/browserChrome.ts` 读取边缘元素的计算背景色，经 1×1 canvas 转成不透明 sRGB hex，同步 meta 和根背景变量。canvas 只做颜色格式转换，**不截屏、不采样滚动中的内容**。
- 同步只监听主题和当前页面根元素的配色属性；不对每一帧或每次滚动运行 JS。离页恢复当前画布色，不恢复历史 meta 快照。
- 封面边缘色以当前画布为主，混入少量封面色，深浅主题都成立。局部 `useDynamicColor` 不再直接改写全局 meta。
- 无模糊 / mask 支持，或用户要求减少透明度时，回退也使用同一边缘实色。
- HTML / manifest 使用当前浅色画布的 `#ebebeb` 作静态兜底；启动后以实际 CSS 计算结果为准。manifest 启动底色是静态的，不能保证与每个用户的深色偏好一致。

## 验证

运行：`node scripts/e2e-browser-chrome.mjs`（需要 Vite 开发服务及 Playwright Chromium / WebKit）。可用 `BASE_URL` 和 `SHOTS_DIR` 指定服务与截图目录。

已覆盖 Chromium / WebKit 的 390×844、844×390、1280×900：

- 浅色、深色、auto 与运行时系统偏好切换；
- 封面异步解码、动态配色启停、离开播放页后清理；
- 边缘色、根背景变量、meta 的一致性，以及截图顶部真实像素的一致性；
- 滚动内容进入渐进模糊区域；
- 模拟较高实色安全区带的布局。

本机 Playwright WebKit 无法将 Blob 写入 IndexedDB，因此 Chromium 走完整的 Player / frames 数据路径，WebKit 使用 data URL 测试相同的 `useDynamicColor` hook 和真实 PageShell。**没有将该替代路径当作 WebKit 的视频数据链路验收。**

### 必须真机补验

- iPhone / iPad：Safari 26 与可用的旧 Safari；分别验证浏览器打开和添加到主屏幕后打开。
- Android Chrome：浏览器与已安装 PWA；至少验证浅 / 深模式、滚动、横屏及重新启动。
- 检查地址栏展开 / 收起、刘海 / 灵动岛区域、状态栏字色、系统网站染色开关，以及设置 / 图片预览 / 抽屉弹层打开与关闭。
- 主屏幕模式若仍出现独立色带，先记录系统版本、状态栏样式及实际 safe-area 值，再决定是否需要改变覆盖模式，不能只继续叠加滤镜。

Headless WebKit 并不包含 Safari 的原生地址栏 / 状态栏，也不模拟真实刘海。页面侧回归通过不等于真机系统 UI 已验收。

## 参考

- [MDN：theme_color 与 meta 的优先级、非透明色建议](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/theme_color)
- [Apple：状态栏样式与内容覆盖关系](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html)
- [Safari 26 顶部 / 底部染色的社区实测与复现](https://jahir.dev/blog/safari-toolbar)（贴边采样是经验行为，不将文中的尺寸阈值或 CSS 特性检测视为版本保证）
