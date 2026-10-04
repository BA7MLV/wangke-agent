# svg 围栏流式落画（边生成边画）设计

- 状态：**已实现**
- 日期：2026-10-04
- 需求：`2026-09-18-svg-fence-design.md` 留下的那条观感问题 ——
  ```svg 围栏要等整段源码闭合才出图，在流式生成期间只有一句「图形生成中…」。
  用户盯着占位符等三五秒，图「啪」地一下出现。想让它像一笔画出来那样，
  `<svg>` 标签一出现就开始流式输出、边生成边落画。

---

## 0. 一句话方案

给 svg 链路加一个 `drawing` 相位：`svgRender.ts` 新增 `peekSvgProgress` 从**半截**源码里
切出「已经写完整的顶层元素」，`LiveSvg.tsx` 拿一个**只追加不重建**的 `<svg>` 画布把它们
一个个插进去并打上落画 class，描边走一遍、填充与文字淡入。围栏一闭合就**退回**原来的完整
净化路径 —— 预览层不是权威结果。

## 1. 改动清单

| 位置 | 改动 |
|---|---|
| `src/components/mermaid/svgRender.ts` | **新增** `peekSvgProgress` / `SvgProgress` / `findTagEnd` / `closedTopLevel` / `sanitizeRoot` / `sanitizePiece` / `purifySvgChunk`；`assertSafe` 从 `sanitizeSvg` 里抽出来给两条路共用 |
| `src/components/mermaid/LiveSvg.tsx` | **新增**：只追加的流式画布 + 落画 class 的打标规则 |
| `src/components/mermaid/SvgBlock.tsx` | 未闭合时算 `progress` 并进 `drawing` 相位；闭合后仍走 `sanitizeSvg` |
| `src/components/mermaid/DiagramBlock.tsx` | `DiagramPhase` 加 `drawing`；新增 `stream` prop 与该相位的正文分支 |
| `src/components/mermaid/mermaid.css` | 落画动画（`@keyframes xmd-svg-draw` / `xmd-svg-fade`）+ 「生成中」退成一行小字 |
| `src/skills/builtin/diagramming/SKILL.md` | 写法加一条：svg 图元按**绘制顺序**写（顺序即笔顺） |
| `scripts/probe-svg-stream.mjs` | **新增**：`peekSvgProgress` 的增量契约（36 条，真浏览器） |
| `scripts/e2e-svg-stream.mjs` | **新增**：逐 token 流下的相位 / 元素增长 / 描边进度 / 终态一致性（34 条） |
| `scripts/e2e-all.mjs` | 两个新脚本登记进 META（漏登记 = 一键跑分里的静默盲区） |

## 2. 关键决策

### 2.1 「不完整就不画」说的是**最终结果**，不是预览

`sliceSvg` 那条契约（缺 `</svg>` 宁可报错也不画残图）一个字没动 —— 它守的是最终上屏的东西。
流式期间的预览是另一件事，由新函数 `peekSvgProgress` 单独负责，两者刻意不合并：
合并的结果要么是预览被「不完整就不画」卡死（回到今天的占位符），
要么是最终结果的严格性被放宽（半张图也算数）。

**闭合后一律回到 `sanitizeSvg`**。于是预览层出 bug 的最坏后果只是「动画丑一点」，
不可能变成一张画错的图 —— 这也是为什么终态能直接 `dangerouslySetInnerHTML` 换回静态渲染，
一点都不用迁就预览层留下的痕迹。

### 2.2 只发「自己闭合了」的顶层元素

判定只有一条：元素自己闭合了 —— 自闭合 `/>` 到了，或者配对的 `</tag>` 到了。
`d="M 0 0 L 1` 这种半条路径宁可晚几十毫秒，也绝不先画出去：**画歪了收不回来**，
只能等 `</svg>` 整体重来，而整体重来正是我们要避免的那次闪烁。

词法上要处理的坑（每条都有探针用例）：

- 属性值里的 `>` / 引号 → 标签边界必须**引号感知**，且引号状态只在标签内部生效
  （否则 `<text>it's fine</text>` 里的 `'` 会把边界算错）；
- 注释 / CDATA / 声明整体跳过，写一半就停；
- 孤立闭标签不能把嵌套深度推成负数 —— 流式期间那个 `</svg>` 就是典型，
  一旦推成 -1，后面所有元素都会被判成「还在嵌套里」，整张图不再落画；
- SVG 命名空间下元素名大小写敏感（`linearGradient`），比对要按 `tagName` 原样来。

### 2.3 每个片段独立过白名单，**外面套一层空 `<svg>`**

增量不是旁路：`sanitizePiece` 与 `sanitizeSvg` 用同一份 `ALLOWED_TAGS` / `ALLOWED_ATTR`
（连同配置一起收进 `purifySvgChunk` 一处），安全判定共用抽出来的 `assertSafe`。

套壳那层 `<svg>` 不是装饰。HTML 解析器**只把 `<svg>` 子树里的元素放进 SVG 命名空间**，
而 DOMPurify 按命名空间决定属性名要不要小写化（SVG 命名空间原样保留，HTML 命名空间一律
lowerCase）。裸喂一个 `<rect …>` 的话 `viewBox` / `gradientUnits` / `clipPathUnits`
这类 camelCase 属性会被打成小写、再被白名单（按 SVG 正确大小写写的）剔掉 —— 图悄悄少一截，
而且**看不出是哪里少了**。套一层根标签等于把命名空间问题交回给解析器。

净化结果按元素原文做 LRU 缓存：流式每一拍都会重新扫到**全部**已完成的元素，
而每个元素的净化结果恒定，缓存之后整条流只净化「真正新到的那几个」。

### 2.4 只追加，不重建 —— 否则动画会对整张图重播

每拍都 `dangerouslySetInnerHTML` 重画一遍的话，新内容一到，所有节点被换掉，
落画动画于是**对整张图**重播一遍：用户看到的是画面反复闪着重画，而不是笔在往前走。

`LiveSvg` 保留同一个根 `<svg>`，只 `insertAdjacentHTML('beforeend', …)` 追加新元素，
于是每个元素的动画恰好跑一次。代价是打标只能在**插入之后**做（此刻才是真节点，
`getAttribute` / `classList` 都可用，不必用正则改字符串 —— `d="…"` 里有 `>`、
属性值里有引号，正则改标记迟早出事）。

### 2.5 根 `<svg>` 在 `useLayoutEffect` 里建，且只建一次

根标签一闭合，属性就定死了，之后不会再变 —— 所以画布只需建一次。

必须用 **`useLayoutEffect`**：根 `<svg>` 带着 `viewBox`，也就是画布的宽高比。
放 `useEffect` 的话第一帧画出来是个空 div（整块塌成一行提示的高度），下一帧才补出画布，
图形会先抖一下再落位。e2e 里那条「drawing 从第一拍起就带 viewBox」守的就是它
（实测：改之前首帧 `viewBox=null`、画布 24px；改之后全程 164px）。

这也是「空画布先出现」是**刻意**的：根标签一到就把「纸」铺好，高度从此固定，
后面内容怎么长都不会让整块图形跳动。

### 2.6 「一笔画」怎么实现：`pathLength=1` 而不是 `getTotalLength()`

落画就是 `stroke-dashoffset` 从全长走到 0。全长可以问 `getTotalLength()`，
但那要求路径已经在文档里、且 `d` 合法 —— 流式期间刚插进去的图元未必满足，抛了就没画。

改用 `pathLength="1"`：让「全长」等于 1 个用户单位，于是 `stroke-dasharray: 1` /
`stroke-dashoffset: 1` 全是常数，一行 JS 都不用算。两个让路条件：

- 元素自带 `stroke-dasharray` → 不走描边（那是虚线图案，一笔抹掉就毁了），只淡入；
- 元素自带 `pathLength` → 不走描边（它对虚线间距有意义，不能覆盖成 1），只淡入。

### 2.7 三个 class 共用**同一条** `animation` 声明

`animation` 是**简写属性、整体覆盖**。「有描边又有填充」的图元（带边框的矩形）两个 class 都在，
于是只会跑到最后声明的那条动画，另一个的初值留在原地 —— 丢的正好是 `dashoffset=1`，
于是**描边直接看不见**。

所以三个 class 共用同一条 `animation: var(--xmd-anim-draw, none), var(--xmd-anim-fade, none)`，
各自只定义自己的 `--xmd-anim-*`。两条规则算出来是同一个值，谁最后生效都一样。
e2e 里「fixture 里存在同时带 fill 与 stroke 的图元」+「收笔时它的描边走完、填充淡入到底」
守的就是这条（第一版 fixture 里全是 fill-only 或 stroke-only 的图元，这条 bug 直接漏过去）。

> 这条 bug 是被新加的断言逼出来的，而新加它是因为「用 `min` 判收笔」这个更早的写法
> 太弱：只要还有一条描边卡在 1，用 `min` 就被「别的元素已经走完」掩盖过去了。收笔判据必须用 `max`。

### 2.8 动效参数一律读令牌

时长 / 缓动 / 错开步长全部取 `transitions.css` 的动效令牌
（`--duration-slow` / `--duration-quick` / `--ease-smooth-out` / `--ease-out` /
`--duration-stagger` / `--duration-very-slow`），全局档位能一处改完。
步长在 CSS 里算：`--xmd-draw-delay: min(calc(var(--xmd-draw-order) * var(--duration-stagger)), …)`，
`LiveSvg` 只往顶层节点写一个**序数**。同一个 `<g>` 里的图元共用一个延迟，
一起动比逐个错开更连贯。

`prefers-reduced-motion: reduce` 时不打任何 class（`matchMedia` 判在 JS 里，
不在 CSS 里减时长）—— 那种情况下最该做的是不画过程，而不是把过程压到 0.01ms。

### 2.9 技能里写死「顺序即笔顺」

落画顺序 = 模型书写顺序。先画曲线再补坐标轴，用户会看到一根没有坐标系的曲线凭空长出来。
所以「讲解配图」技能的写法里加了第 7 条：先 `<defs>` 与背景，再坐标轴与辅助线，
然后曲线与关键点，最后文字标签。这是渲染层的新能力**反过来约束模型输出**的一例。

## 3. 坑（都真的会浪费一轮）

1. **`rootAttrs` 不能靠「套壳再取 inner」拿到**。那样取出来的是**内层那个 `<svg …></svg>` 整段**，
   去掉 `<svg` 前缀后尾巴还带着一个 `</svg>`，属性串变成
   `viewBox="…" xmlns="…"></svg`，画布直接不渲染。属性段只能从**序列化结果的最外层**切。
   （我第一版就是这么写的，症状是画布空白。）
2. **丢了 `@keyframes` 定义，`animation-name` 仍然照算**。值里写了 `xmd-svg-draw`，
   计算样式就显示这个名字，但没有对应的 `@keyframes` 规则 → **不生成动画** →
   属性保持声明值（`stroke-dashoffset: 1`）→ 描边永远画不出来，
   而所有「计算样式」看起来都正常。改 CSS 时整块替换很容易把 `@keyframes` 顺手吃掉。
3. **`getComputedStyle().strokeDashoffset` 带单位**，而且换算到 CSS px 后随 viewBox 缩放而变，
   不能拿「1」当阈值判「走完了」。要么 `parseFloat` 后按**相对起点**比，要么比 `max`。
4. **`useEffect` 建根节点会抖一帧**（见 §2.5），`useLayoutEffect` 才对。
5. **`hasFill` 别只看 `fill` 属性**：`line` / `polyline` 压根不能被填充，
   缺省 `fill` 对它们无意义，判成「有填充」会给它们白挂一个淡入动画。
   反过来，实心图元缺省 `fill` 是**黑**（不是 `none`），没写 `fill` 也要淡入。
6. **`opacity` 动画带 `fill-mode: forwards` 会压掉内联 `opacity="0.4"`**，
   把半透明图元变成全不透明。所以元素自带 `opacity`（或 `style` 里含 opacity）时不接管它的淡入。
   这类「顺手加的动效改坏了原图」的坑，只有在真的去改属性时才会显形。
7. **别把 mermaid 那条链路一起改了**：mermaid 必须等整段源码到齐才能 `parse`，
   它在流式期间只能停在 `waiting`。这次只给 `DiagramBlock` 加了第五个相位，mermaid 不会进去。

## 4. 已知限制

- **半截期间不给工具条**（大图 / 下载 / 复制都没有，只有源码）：预览期的内容还不是最终结果，
  导出半张图没有意义。围栏一闭合工具条就齐了。
- **预览层不做二次几何校验**：元素是「闭合了」就算数，不查它引用的 `url(#id)` 目标是否存在。
  所以半截期间可能出现「先画了个引用还没到的渐变的矩形，颜色不对」，下一拍自己就正了。
  最终态仍然由 `sanitizeSvg` 全量过一遍，不受这条影响。
- **命中安全闸门时预览直接退回等待态**：外部 `url(...)` 一出现就不再落画，
  等闭合后统一报错。不试图「先把安全的画完」—— 那样状态机会多出一套
  「画了一半 + 报错」的组合，而它对用户没有额外价值。
- **元素在一拍里挤完时靠 stagger 找节奏**：错开上限 `--duration-very-slow`（500ms）。
  一张 30 个图元的图整体涌进来时，后排的图元仍会有明显延迟，这是有意的（否则像「炸开」）。
- **svg 的净化契约仍然只能跑浏览器**（DOMPurify 要 window），Node 侧只覆盖导出那条纯函数。

## 5. 验收

- `node scripts/probe-svg-stream.mjs` — 36 passed（真浏览器，dev 档）
  - 逐字符喂入时「已上屏集合」始终是最终集合的**前缀**，元素数只增不减；
  - 根属性每一拍都带 viewBox；xmlns / camelCase 属性（`clipPathUnits` / `textLength` /
    `lengthAdjust` / `pathLength`）不被小写化后剔掉；
  - 10 个词法坑（属性值里的 `>` / 单引号、正文里的尖括号、注释、CDATA、嵌套 `<g>`、
    写一半的注释与 `<g>`、多元素、收尾 `</svg>` 之后的正文）；
  - `<script>` / `onclick` / `<image href>` 按净化器语义**被剔除**（不抛错），
    外部 `url()` 才**拒绝** —— 与 `probe-svg-sanitize` §2 同一条口径；
  - ★ 增量拼回去（根 + 元素 + 闭标签）**逐字符 === `sanitizeSvg` 的完整产物**；
  - 拿不到几何信息时返回 `null`；完整源码路径的报错语义一字未变。
- `node scripts/e2e-svg-stream.mjs` — 34 passed（真浏览器，dev 档，页内假 SSE 流）
  - 相位真的走 `waiting → drawing → ok`；
  - 画布元素数单调不减 `0→1→…→8`，是**逐步**长出来的；
  - drawing 从第一拍起就带 viewBox，画布高度全程不变（164px，不随内容增长跳动）；
  - 描边 dashoffset 从 1.00 一路降到 0.00，同一拍里既有走完的也有在走的；
  - fill+stroke 的图元两条动画都跑（描边走完 + 填充淡入到底）；
  - 落笔之后不回退成空画布（append-only 的意义）；
  - 终态画布内容 === `sanitizeSvg` 的完整产物，且不留 class / `pathLength` 残留；
  - 带外部资源引用的 SVG 在**预览期从未进过 drawing 态**，闭合后照旧报错回退源码。
- 回归：`e2e-svg-fence`（26）、`e2e-chat-mermaid`、`e2e-quiz-mermaid`、
  `probe-svg-sanitize`、`test-chat-frames`（29）、`test-diagram-export`（7）、
  `test-builtin-skills`（12）全绿；`npm run build`（含 tsc）通过。
