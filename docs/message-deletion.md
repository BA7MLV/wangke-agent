# 聊天消息删除：Telegram Android 源码移植

## 固定源码版本

仓库：[DrKLO/Telegram](https://github.com/DrKLO/Telegram)。固定 commit：
[`68c6775ac373f4bdb30ae9986282dd5ec0407756`](https://github.com/DrKLO/Telegram/tree/68c6775ac373f4bdb30ae9986282dd5ec0407756)。

- [ThanosEffect.java](https://github.com/DrKLO/Telegram/blob/68c6775ac373f4bdb30ae9986282dd5ec0407756/TMessagesProj/src/main/java/org/telegram/ui/Components/ThanosEffect.java)：网格、缓冲、纹理和帧驱动。
- [thanos_vertex.glsl](https://github.com/DrKLO/Telegram/blob/68c6775ac373f4bdb30ae9986282dd5ec0407756/TMessagesProj/src/main/res/raw/thanos_vertex.glsl)：粒子状态更新、随机数、速度、寿命及点大小。
- [thanos_fragment.glsl](https://github.com/DrKLO/Telegram/blob/68c6775ac373f4bdb30ae9986282dd5ec0407756/TMessagesProj/src/main/res/raw/thanos_fragment.glsl)：原纹理采样和 alpha。

也检索了 Telegram Web A / Web K；Web A 的 `SnapEffectContainer.tsx` 使用 SVG turbulence/displacement，并非 Android 的粒子着色器。本实现明确对齐 **Android 消息删除的 ThanosEffect（非照片编辑器模式）**，而非混合不同客户端的效果。

## 与原版的代码对应

两份 GLSL 原样纳入 `src/third-party/telegram-thanos/`，仅增加文件末尾换行；测试验证去掉该换行后的 Git blob SHA-1 与上述源码完全一致。

| 原生代码 | 浏览器移植 |
| --- | --- |
| `calcParticlesGrid(part=1)`，Java 1110–1144 行 | `telegramParticleGrid`；默认 high=120000 上限，也保留 average=60000 / low=30000 档位 |
| `max(density*.4, 1)`，按宽高比取整并补足网格 | 原公式；不是旧版 7000 个粗方块 |
| 两份缓冲，每粒子 28 字节 | 两份 WebGLBuffer，交错 UV2 + position2 + velocity2 + lifetime1 |
| GLES Transform Feedback + GL_POINTS | WebGL2 Transform Feedback + POINTS，GPU 每帧更新并回写粒子状态 |
| `timeScale=1.15`、`uvOffset=.6`、`scale=1` | 原参数；Java float 的时间累积用 `Math.fround` 对齐 |
| 原 shader 中 260、19、-65、1.2、.55 等公式 | 不修改，不改成 CSS easing、统一飞行方向、缩小方块或整块淡出 |
| GL_LINEAR / CLAMP_TO_EDGE，禁用 BLEND | 相同设置；DOM Canvas 上传为 premultiplied RGBA，对应 Android Bitmap |
| `isDead: time > 1.5 + .9` | 原判断，非旧版固定 1150ms 截断 |

## 浏览器适配与不能保证的部分

- Android Bitmap 输入替换为 `html-to-image` 的真实消息 DOM 截图。CSS px 对应 dp，`devicePixelRatio` 对应 Android density，不再强制 1 倍截图。
- 只截图聊天滚动区域中可见的内容；操作行、iframe/video 不参与截图。Android 自身也有视图截取逻辑，但这里不声称重现其所有原生布局细节。
- 纹理外增加透明画布空间，避免飘散被原消息矩形裁掉；这是浏览器容器适配，不修改粒子物理。
- 单消息使用原版 high 档预算与 part=1；不是多条同时删除时的面积分摊，也不是照片编辑器参数或任意 durationMultiplier。
- 字体栅格化、浏览器 DOM 截图、GPU 的 `sin` 精度、DPR 和帧率影响实际画面。**代码一致不等于已验证与 Android 实机截图逐像素一致。**
- 当前对照实验固定同一输入纹理、seed、density、时间步，比较「独立翻译的原生驱动 + 原版 GLSL」与正式移植的输出。同一浏览器 GPU 的 RGBA 字节对照，不冒充跨设备原生截图验证。

## 删除与资源生命周期

主页和课程侧栏均接入。桌面消息操作行删除，手机长按用户消息菜单删除；确认后只删除选中 `db.chats` 行，不连带删除后续消息或共用附件文件，生成中禁用。

持久化前完成截图、shader 编译和首帧初始化；失败时仍可正常删除，但不会退回旧的 Canvas 近似动画冒充原版。截图超时 1500ms 自动取消。减少动态效果时跳过截图/动效。

切换会话、组件卸载、滚轮/触屏滚动、隐藏标签页、尺寸变化、系统改为减少动态效果、WebGL context lost 均清理动画与 GPU 资源。未提交删除或删除失败也释放已准备的 GPU 对象。

## 验证

使用全新启动的 Vite 端口，避免旧 HMR 带时间戳模块导致测试导入另一份 store：

```sh
npx tsc -b
BASE_URL=http://localhost:5173 node scripts/test-telegram-thanos.mjs
BASE_URL=http://localhost:5173 node scripts/e2e-message-deletion.mjs
```

`test-telegram-thanos.mjs` 验证两份上游 blob hash，并使用独立参考驱动，在 density=1/2、60/120fps、0/100/300/600/1000/1500/2100ms 的 28 个帧检查逐字节 RGBA 差异。首帧另有非空检查，防止两个空画布假通过。固定 600ms 左右对照图：`e2e-shots/telegram-thanos-compare.png`。

## 许可证（已获用户同意）

这次改为直接移植 GPL-2.0 源码，不再是上一版独立 MIT 近似实现。具体文件归属、源版本、修改说明见 `src/third-party/telegram-thanos/NOTICE.md`。完整许可与发布声明放在 `public/licenses/`，构建时随站点发布。

根目录既有 `LICENSE` 保留原 MIT 作者声明；不将 Telegram 文件重新标为 MIT。组合应用的 package license 已标为 GPL-2.0-only。对外分发前，需按 GPL 为组合应用提供完整对应源码、构建脚本及相关声明；只附 Telegram 链接或许可文本并不足以履行源码提供义务。
