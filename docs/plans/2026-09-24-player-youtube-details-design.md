# 播放器 YouTube 化（第二档）：缩略图预览 / 大播放按钮 / 键盘步长

- 状态：**已实现并回归**（`probe-yt-player` 新增，`e2e-player-enhance` / `e2e-controls-hover` / `e2e-resume` / `e2e-mobile` / `e2e-comments` 全绿）
- 日期：2026-09-24
- 需求：上一轮（`2026-09-16-youtube-style-ui-design.md`）只把控制栏的「观感」拉近 YouTube；
  这一轮补 UI 与 UX 上仍然明显不像的地方
- 不变量：**不加 YouTube 红**（强调色一律 `rgb(var(--mdui-color-primary))`）；**功能只增不减**；
  已有的 `data-testid` 与双击 ±10s 涟漪等契约不动

## 1. 这一轮补了什么，为什么是这几件

| 改前 | YouTube 的做法 | 本轮做法 |
| --- | --- | --- |
| 进度条 hover 只弹一个时间小方块 | 弹「视频帧缩略图 + 压在图上的时间胶囊」 | 自己组合 `TimeSlider`，用主视频同一个 blob URL 取帧 |
| 首帧是整个画面 + 底部一排按钮，没地方可点 | 中央一个半透明圆形播放键，播过就撤 | `PlayerBigPlayButton`（挂在 `.vds-controls` 之外） |
| ←/→ 与 j/l 都是 10s | ←/→ **5s**、j/l **10s** | `keyShortcuts` 拆成两组，分别 5 / 10 |
| 没有 Home/End、没有逐帧 | Home/End 跳两端、`,`/`.` 暂停时逐帧 | 补上 |
| 投屏按钮在但点了没反应；时间数字会左右抖；图标压在浅色画面上糊 | 无投屏按钮；数字等宽；图标带淡投影 | 摘按钮 + `tabular-nums` + `text-shadow` / `drop-shadow` |

## 2. 进度条缩略图预览

### 2.1 为什么不用官方的 `<TimeSlider.Video>`

vidstack 官方给的两条路都不合用：

- **`<DefaultVideoLayout thumbnails="thumbs.vtt">`（雪碧图）**：要给任意本地视频预生成一整条
  缩略图轨 —— 全片解码一遍 + 额外存储。而 blob URL 本来就在内存里，直接 seek 取帧是零成本的。
- **`<TimeSlider.Video src>`**：语义上正是「同一段视频的预览元素」，但它自己维护就绪状态，
  未就绪时给元素打 `data-hidden`，默认样式对 `[data-hidden]` 是 `display: none; width: 0`。
  **实测在本地 blob 源上它一直停在 `data-hidden`** —— 元素其实已经 `readyState=4` 解好码了，
  只是它那套判定没通过。缩略图根本出不来。

所以自己在槽位里组合 `<TimeSlider.Preview>` + 自己的 `<video>`。顺带拿到两个官方实现没有的好处：
**节流**（官方是指针一动就写一次 `currentTime`，指针每动 1px 就给解码器排一次队）与
**稳定的卡片尺寸**（元数据没到之前不会高度为 0）。

### 2.2 取帧时间：`pointerRate`，不是 `pointerValue`

`SliderState.pointerValue` 名字看着就是「指针处的时间」，**实测在这个滑块上给的是百分比量纲**
（鼠标在 25% / 50% / 75% 处分别得到 25 / 50 / 75）。当秒用会取错帧 ——
在 40s 的样片上表现为「不管指哪儿都停在 39.95s」。

正解是 vidstack 自己在 `SliderThumbnail.getTime()` 里用的公式：

```ts
const target = Math.min(pointerRate * duration, duration - 0.05);
```

`- 0.05` 是别正好停在时长上：那一帧在多数编码里是空的（只剩音频尾帧）。
再用 `MIN_FRAME_DELTA = 0.5s` 节流。

### 2.3 尺寸与外观

- 卡片按素材宽高比走（横屏按 160 宽封顶、竖屏按 160 高封顶）。
  本项目的素材有手机竖录的课，一律 16:9 会把竖屏视频挤成一条缝。
- 时间胶囊**绝对定位叠在卡片内部底端**（YouTube 的做法）。默认布局是「图下方另起一行」，
  所以要把 `.vds-slider-value` 从文档流里拿出来、并去掉它那 2px 顶距。
- 预览帧首帧解出来之前 `opacity: 0`，避免先闪一下纯黑。

### 2.4 代价：页面上多了一个 `<video>`

预览元素是真的 `<video>`，所以 `document.querySelector('video')` 之外，
**`page.locator('video')` 会命中两个元素、Playwright 严格模式直接报错**。

排查后只有两处裸标签选择器：`e2e-player-enhance.mjs` 与 `probe-controls-hover.mjs` 各两处
（都改成 `[data-media-provider] video`）。其余脚本走 `document.querySelector('video')`
或 `waitForSelector('video')`，主视频在 DOM 里排在预览之前，不受影响。

## 3. 中央大播放按钮

### 3.1 为什么不能复用官方的 `loadButton`

默认布局的「加载布局」里有一个大播放按钮，但它只在 `isLoadLayout = load === 'play' && !canLoad`
时渲染。本项目是本地文件、`load="visible"`，改 `load` 会让「时长未知 / 断点续播读不到进度」
并打断全部视频 e2e（那些用例都先等 `readyState >= 2 && duration > 0` 再操作），代价太大。

### 3.2 挂在 `.vds-controls` 之外

这样它**不随控制栏 hover 显隐** —— YouTube 也是：没播过的画面上，控制栏可以收起来，
播放键一直在。反过来如果塞进 `centerControlsGroupCenter` 槽位，鼠标一移开它就跟着消失了。

位置在 `<MediaProvider>` 之后、`<SeekFeedback>` 之前，所以：

- 手势层是在 `[data-media-provider]` 上监听 pointerup 的，**不会**收到这个按钮上的点击
  （两条不同的子树，事件不冒泡过去），单击不会连带把视频暂停、双击也不会连带触发全屏。
- 层级 14：压在字幕（10）之上、弹幕（15）之下。

### 3.3 点完必须把焦点交给播放器

vidstack 的 `keyTarget` 默认是 `'player'`，**快捷键只在「播放器持有焦点」时生效**。
而这个按钮点完（开始播放）就会卸载 —— 卸载引发的 `focusout` 会让 `$active` 翻成 false，
快捷键一起被关掉，用户点完播放再按空格就没反应。所以在 `onClick` 里显式
`player.el.focus()` 再 `play()`（实测：不加这一句按 `k` 无效）。

## 4. 键盘步长

### 4.1 `keyShortcuts` 是整体替换

`MediaPlayer` 的 `keyShortcuts` prop 默认值就是 `MEDIA_KEY_SHORTCUTS` 那张表，
传自定义对象会**整体替换**（不是深合并），所以默认项必须一条条照抄回来。

### 4.2 为什么 ←/→ 与 j/l 只能走回调

vidstack 内部这两条路最终都把步长落到同一个 `seekStep` 上：

- 方向键 → `#seeking()` 往时间滑块转发一个合成 keydown，滑块按 `keyStep`（= 布局的 `seekStep`）走；
- j/l → 同一条路。

一个值拆不出 5 和 10，所以这两组都改成 `onKeyDown` / `onKeyUp` 回调自己做：

- **按下**只发 `remote.seeking(target)`（"正在拖动"），**松开**才 `remote.seek(target)` ——
  与 vidstack 自己那套累加逻辑同款；
- **累加窗口 700ms**：窗口内以上一次的**目标时间**为基准，否则「按 5 次只前进一点点」
  （每次 seek 落地都有延迟，下一次按键若以「当前时间」为基准，基准其实还停在原地）。

代价：这两组键不再写 `lastKeyboardAction`，因此不触发中央的按键反馈动画
（播放 / 音量 / 全屏 / 字幕那几档仍走默认方法，动画照旧）。

### 4.3 基准要读媒体元素，不能读 store

`player.currentTime` 读的是 vidstack 的 store，**在「刚跳转完」那一小段时间里可能还是旧值**。
实测路径：`End` 跳到末尾 → `Home` 回到 0 → 立刻按 `→`，会一次冲到末尾（store 还停在 40）。
改成优先读 `player.el.querySelector('video').currentTime`（seek 请求发出的当下就变了，是唯一真相），
并让 Home/End 把跳转目标也写成累加基准。修完实测：连按 3 次 `→` = 15s。

### 4.4 `keyTarget` 保持默认的 `'player'`（**这是个刻意的取舍**）

YouTube 的快捷键是全局的（不用先点一下视频）。这里**没有**跟着改成 `'document'`，因为：

1. vidstack 的 `IGNORE_SELECTORS` 靠 `document.activeElement.matches('input, textarea, …')`
   判断「正在打字」。而本项目的聊天输入框是 `mdui-text-field` 自定义元素 ——
   焦点被影子 DOM 重定向到**宿主**，宿主不匹配那些选择器，于是打字时按 `k` 会去暂停视频。
2. `0-9` 跳百分比是 vidstack 在回调分支**之前**内部处理的，用 `keyShortcuts` 的回调**兜不住**，
   也就是「在输入框里打数字会跳进度」这条没法拦。

两条叠加就是「聊天时随便打几个字，视频自己乱跳」。收益（省一次点击）远小于风险，故不动。
实际使用上问题不大：进播放页的第一个动作（点大播放键、点画面、点任一控制按钮）都会把
焦点交给播放器，之后快捷键就生效了。

### 4.5 双击中央 = 全屏（本来就有）

默认布局的 `DefaultVideoGestures` 里已经有一条 `dblpointerup → toggle:fullscreen`
铺满整宽，左右各 20% 的 `seek:∓10` 叠在它上面。所以双击中央是切全屏、双击两侧是 ±10s，
**不需要额外写代码** —— 这也解释了为什么 `e2e-player-enhance` 的双击用例要打在 0.1 / 0.9 处。

## 5. 控制栏细节

- **摘掉投屏按钮**：`slots` 里的 `slot(slots, name, default)` 用 `isUndefined(slot) ? 默认值 : slot`
  判断，所以传 `googleCastButton: null` 正好**替换**成空，而不是「禁用」。本项目没接 Google Cast 框架，
  那颗按钮点了没有任何反应。
- **时间数字等宽**（`tabular-nums`）+ 13px + 去内边距：不然「当前时间」每秒重排，
  右侧的「/ 总长」会跟着左右抖。
- **分隔斜杠压暗**到 0.55：默认 `#e0e0e0` 和数字同亮，看起来像两个计时器。
- **控制层遮罩顶部提到 0.55**：顶栏放的是自研按钮（倍速档位 / 弹幕 / 字号），
  压在浅色课件录制、白底 PPT 上会整片发白（实测 `2x/3x/4x` 在彩条上几乎看不见）。
  同时把 `--video-border-radius` 对齐成 12px（默认 6px，和控制层底色在角上会错开）。
- **图标 + 文字加淡投影**：`text-shadow` 挂在 `.vds-controls` 上一次覆盖所有文本；
  SVG 图标不吃 `text-shadow`，单独补 `filter: drop-shadow(...)`。

## 6. 验证

- 新增探针 `scripts/probe-yt-player.mjs`（已登记进 `e2e-all` 的 META，`service: preview`），
  四组断言：大播放按钮（不随控制栏显隐 / 播放后移除 / 点完焦点交接）· 键盘步长与连按累加 ·
  预览卡片（尺寸、解码状态、时间胶囊压在卡片内部）· 控制栏细节（投屏已摘、时间 13px 等宽）。
  失效方式多为「看着还在但取错帧 / 焦点丢了」，所以是量而不是截图。
- 回归（全部通过）：

  | 脚本 | 覆盖到的风险点 |
  | --- | --- |
  | `probe-yt-player` | 本轮新增契约 |
  | `probe-controls-hover` | 控制栏 hover 显隐三态没被改坏 |
  | `e2e-player-enhance` | 倍速 / 双击 ±10s 涟漪 / 字号 / 窄屏折叠 / 设置页自定义倍速 |
  | `e2e-resume` | 断点续播（`MediaStorage`）不受影响 |
  | `e2e-mobile` | 竖屏底部导航、横屏左视频右侧栏、多尺寸横屏 |
  | `e2e-comments` | 播放页时间戳跳转、矮视口高度预算、深色模式 |

- 截图：`e2e-shots/youtube-ui/2{0,1}-player-*.png`（探针产出）、
  `2{5,6}-player-*-{bigplay,controls,preview,page}.png`（浅色 / 深色各一组）。

## 7. 已知未做 / 取舍

- **滚轮调音量**没做。YouTube 有，但本项目播放页是可滚动的长页（下方还有讨论区与面板），
  鼠标停在播放器上滚页面会变成调音量，误伤概率高于收益。
- **右键菜单**（复制当前时间 / 循环播放 / 画中画）没做，属于下一档。
- **章节**：没有章节轨数据，进度条上的分段与章节名走的是 vidstack 默认的「单段」行为。
- **雪碧图缩略图轨**：见 §2.1，对任意本地导入的视频不划算，未考虑。
- **`keyTarget: 'document'`**：见 §4.4，因打字误触风险未采用。
