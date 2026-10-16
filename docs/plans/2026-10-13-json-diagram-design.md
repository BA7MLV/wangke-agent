# ```diagram 围栏：JSON 中间层重构设计

- 状态：**已实现**（Node 单测全绿；浏览器探针与 e2e 待收尾跑分，见 §5）
- 日期：2026-10-13
- 需求：模型**直出 SVG** 这条路（`2026-09-18-svg-fence-design.md`）在真实使用里暴露出
  「AI 端到端画图」的固有缺陷 —— 坐标与路径手算错了就画歪、同一道题两次画得不一样
  （没法 diff、没法版本化）、SVG 语法本身烧掉大量 token、复杂图直接布局失控。
  2026-10-12 前后 X 上围绕 @geekbb「编码智能体写 30–150 行 JSON、由确定性工具渲染」
  的讨论给出了被反复验证的方向：**AI 定义结构 + 确定性工具渲染**。
  本次重构把「模型手写几何」换成「模型写 JSON、渲染器算几何」，
  且**svg 围栏的流式落画能力必须保留**（`2026-10-04-svg-streaming-draw-design.md` 的观感不能退步）。

---

## 0. 一句话方案

新增第三种围栏 ` ```diagram `：模型只输出一段 JSON（`{"type":"graph"|"plot", …}`），
由新的确定性渲染器 `diagramRender.ts` 算出全部几何（布局 / 连线路由 / 坐标 / 采样 / 刻度），
再落成 SVG。流式期间 `diagramStream.ts` 从**半截 JSON** 里切出「已经写完整的数组项」，
按 key 追加到画布上（`DiagramCanvas`）—— 边生成边画的能力原样保留，且收敛到
「最后一拍 === 闭合后的完整渲染」。提示词与「讲解配图」技能改为只教 `mermaid` 与 `diagram`；
`svg` 围栏**不退场**，降级为历史数据兼容（2026-10-13 之前存入 IndexedDB 的问答/题卡里可能有它）。

## 1. 改动清单

| 位置 | 改动 |
|---|---|
| `src/components/mermaid/expr.ts` | **新增**：安全的数学表达式求值器（手写词法 + 优先级爬升，无 `eval`）。白名单函数 + 常量 + 隐式乘法，报错带字符位置 |
| `src/components/mermaid/diagramSchema.ts` | **新增**：`GraphDoc` / `PlotDoc` 类型、`LIMITS`、`validateDiagram`（完整校验，报错带 `nodes[2].label` 式位置）、`pickValid*`（流式预览用的轻量单项校验，共用同一批 `check*`） |
| `src/components/mermaid/diagramRender.ts` | **新增**：确定性渲染器。`renderDiagram(doc, {tolerant})` → `{width, height, viewBox, shapes, svg}`；graph 自动布局（最长路径分层 + 边界求交贝塞尔边）、plot 固定绘图区 + nice 刻度 + 渐近线断路 + 自动 y 范围 |
| `src/components/mermaid/diagramStream.ts` | **新增**：`peekDiagramProgress` —— 括号配平 + 字符串感知的浅扫描（不对半截内容做 `JSON.parse`），宽容渲染，预览尽力而为 |
| `src/components/mermaid/drawMark.ts` | **新增**：从 `LiveSvg` 抽出的落画打标规则（`markShapes` / `prefersReducedMotion`），两条链路共用 |
| `src/components/mermaid/DiagramCanvas.tsx` | **新增**：按 key 只追加不重建的流式画布；已存在的 key 静默更新（不打 class，不重播动画） |
| `src/components/mermaid/JsonDiagramBlock.tsx` | **新增**：`diagram` 围栏的块组件（流式走 `peekDiagramProgress`，闭合走完整校验 + 完整渲染） |
| `src/components/mermaid/fence.ts` | `DiagramKind` 加 `'diagram'`；`LANG_RULES` 加词首匹配；头部写清三种围栏的分工（svg = 历史兼容） |
| `src/components/mermaid/markdown.tsx` | `MarkdownCode` 按 kind 分发到 `JsonDiagramBlock` |
| `src/components/mermaid/DiagramBlock.tsx` | `DiagramStream` 联合类型加 `{kind:'diagram'; viewBox; shapes}` 分支，drawing 相位按 kind 选画布 |
| `src/components/mermaid/LiveSvg.tsx` | 改用 `drawMark.ts` 的共享打标（行为不变） |
| `src/components/mermaid/svgRender.ts` | `sanitizePiece` 改名导出为 `sanitizeSvgFragment`（svg 流式与 diagram 渲染器产出物共用） |
| `src/harness/prompts.ts` | `DIAGRAM_RULE` 重写：教 `mermaid` 优先 + `diagram` 兜底的分工，强调「**你不要手算坐标**」；两条出题规则的围栏同步换 |
| `src/skills/builtin/diagramming/SKILL.md` | 重写为 JSON schema 参考（plot / graph 两个完整示例 + fn 支持范围 + 上限 + 常见错误） |
| `src/harness/widget.ts` | `WidgetFormat` 加 `'diagram'`；`widgetRejectedText` 加 14 类 diagram 归因分支（**必须整体排在 svg/mermaid 之前**，见 §2.7） |
| `src/harness/tools.ts` | `show_widget` 加 diagram 分支（JSON.parse + 校验 + 试渲染，回原样 JSON）；工具描述同步 |
| `scripts/test-json-diagram.mjs` | **新增**：34 条 Node 单测（围栏契约 / schema 锁字段 / 表达式 19 例 / 确定性 / 布局 / 采样 / 流式收敛） |
| `scripts/probe-json-diagram.mjs` | **新增**：真浏览器探针（白名单纵深防御 / 流式每拍净化 / show_widget 同源 / 恶意标签不执行） |
| `scripts/e2e-diagram-stream.mjs` | **新增**：流式落画 e2e（相位 / key 增长 / 描边进度 / 终态 === 权威产物 / 坏 fn） |
| `scripts/e2e-diagram-fence.mjs` | **新增**：题卡解析 e2e（出图 / 报错回退 / 三种围栏共存 / 围栏保护） |
| `scripts/test-widget.mjs` 等 4 个 | 既有断言从 svg 切换到 diagram；`test-diagram-export` 补渲染器产物的导出用例 |
| `scripts/e2e-all.mjs` | 四个新脚本登记进 META（漏登记 = 一键跑分里的静默盲区） |

## 2. 关键决策

### 2.1 「AI 定义结构，确定性工具渲染」—— 分工线划在几何上

模型只回答「有什么、怎么连、函数与范围」；坐标、列宽、层号、连线路由、采样点、
刻度步长全部由渲染器算。schema 里**没有绝对坐标字段**，提示词里写死「你不要手算坐标」——
不写这一句，模型会习惯性地在 JSON 里塞坐标，白费一轮。

这条分工直接换来讨论里被反复提到的几个性质：同一份 JSON 渲染结果**逐字节一致**
（无时钟、无随机，`fmt()` 统一数字格式），于是可 diff、可版本化、可回归测试；
渲染器要换风格（配色 / 字体 / 动画）只改一处；同一份 JSON 未来可以导出 PNG/GIF/MP4。

### 2.2 schema 是锁死的，未知字段必须**报错**而不是忽略

模型把 `colour` / `vertexs` 当字段名写，静默忽略会让它以为写对了，下一轮还这么写。
所以 `validateDiagram` 对每个对象逐 key 检查白名单，报错直接列出可用字段
（`nodes[0]有不认识的字段「colour」。可用字段：id / label / shape`）。
所有报错都带**精确位置**（`nodes[2].label`、`curves[0].fn`、`表达式第 7 字符附近`）——
模型唯一的纠错依据就是这些话，写成「渲染失败」它没法照着改。

### 2.3 流式增量单位是**逻辑图元**，不是字符

半截 JSON 每多写完一个数组项（一个节点、一条曲线），就多一个稳定 key
（`node:a` / `edge:0` / `curve:1` / `axes` / `point:0`…）。相比 svg 链路的「元素」，
这里不会出现画到一半的路径 —— 因为渲染器每次拿**完整数据**重算，
半截数据只是「图元少几个」，不是「图元残几个」。

代价是**布局依赖全量数据**：后到的宽节点会把列宽撑开，先落位的节点因此可能挪位。
所以 `DiagramCanvas` 允许对已存在的 key **静默更新**（整块替换、不打 class）——
没有动画重播，也没有把预览画错。

### 2.4 收敛不变量：最后一拍 === 闭合后的完整渲染

`peekDiagramProgress` 内部就是**同一个** `renderDiagram`（`tolerant: true`），
只是喂给它的是半截数据。于是围栏闭合那一刻，最后一拍的 shapes 与完整渲染
**逐字节一致**（key 集合、顺序、viewBox 全同）—— 闭合只多出工具条，画面不变。
这条不变量有单测（graph / plot 各一条 ★）和探针（真 sanitize 路径下复验）双重看守。

宽容模式只做两件事：单项坏数据跳过（`pickValid*`），编译一半的表达式让整张图等一拍。
**绝不**为了画出来而猜坐标。

### 2.5 表达式求值手写，不碰 `eval` / `new Function`

`fn: "x^2"` 必须求值，而围栏内容间接来自课程字幕、用户提问、PDF/Word 材料
（全是被第三方写入的文本）。所以求值器是手写 tokenizer + 优先级爬升解析器：
白名单函数（sin/cos/… / pow / min / max）、常量（pi/e/tau）、隐式乘法（`2x`、`2sin(x)`）、
右结合 `^` 且比一元负号绑得紧（`-x² = -(x²)`）。报错带字符位置与 snippet。

### 2.6 安全：渲染器产出物过**同一道**白名单

产出 SVG 的是我们自己的渲染器（文本已 `esc()` 转义），但每个 shape 仍逐个过
`sanitizeSvgFragment`（与 `sanitizeSvg` 同一份 `ALLOWED_TAGS` / `ALLOWED_ATTR` / `assertSafe`）。
这是纵深防御：渲染器哪天多吐一个白名单外的东西，在这里现形，而不是直接进 DOM。
闭合后的完整渲染走 `sanitizeSvg`。两条路与模型直出 SVG 的安全口径**完全一致**。

### 2.7 show_widget 归因顺序：diagram 分支必须整体排在 svg/mermaid 之前

diagram 的 `type` 报错文案里含着「```mermaid」字样（提示模型换图种），
排后会被 mermaid 分支截胡，给出「改用 flowchart」这种文不对题的改法。
而 diagram 的 schema 报错与 svg 的净化报错文本完全不重叠，排前不会误伤。
这条顺序有单测看守（`失败回执：diagram 的 type 报错不被 mermaid 分支截胡`）。

### 2.8 svg 围栏降级为历史兼容，但不删

2026-10-13 之前存入 IndexedDB 的问答/题卡里可能有 ` ```svg ` 围栏，
删掉判定规则它们会渲染成一坨源码。所以 `LANG_RULES` 保留 svg，
`SvgBlock` / `LiveSvg` / `peekSvgProgress` 整条链路原样保留；
提示词与技能**不再教**它（有单测看守「提示词不该再教 svg」）。

## 3. 坑（都真的会浪费一轮）

1. **半截内容不能 `JSON.parse`**。要的恰恰是「parse 不了的时候已经能画多少」，
   所以 `diagramStream` 是括号配平 + 字符串感知的浅扫描：只收**完整**的顶层字段与
   **完整**的数组元素。停在输入末尾的字面量一律算没写完（`-1` 下一个字符可能是 `2`）。
2. **`x` / `y` 范围是「数组当标量用」的字段**。它们是二元组不是列表，
   按元素拆开就丢了「这是同一个二元组」的信息（第一版就漏了：显式 `x:[-6,6]` 被忽略，
   画出来的是几何外延算出的自动范围）。所以 `scanTop` 对这两个 key 整体 `JSON.parse` 一份。
3. **Node 的 type-stripping 模块解析要求相对导入带 `.ts` 扩展名**（`prompts.ts` 的老规矩）：
   `diagramRender.ts` / `diagramStream.ts` 里的 `./diagramSchema` 不带扩展名会
   `ERR_MODULE_NOT_FOUND`。
4. **表达式解析器有两个反直觉点**：`x(x-1)` 是**隐式乘法**不是函数调用
   （`parsePrimary` 先查变量/常量，再查函数名）；`^` 右结合且比一元负号绑得紧
   （`-x^2 = -(x^2)`，`2^-3` 合法）。precedence 表里 `^` 给 0 会让 `sin(x)+2x^2` 直接报错。
5. **`getComputedStyle().strokeDashoffset` 带单位**且随 viewBox 缩放而变，
   不能拿「1」当阈值；收笔判据用 `max` 不用 `min`（见 svg 流式那篇 §3.3）。
6. **`.mjs` 测试文件里不能写 TS 语法**（`as const` 会直接 SyntaxError）——
   这些脚本是裸 Node 跑的，只有 `src/` 里的 `.ts` 才享受 type-stripping。
7. **`toStandaloneSvg` 对渲染器产物同样要小心**：渲染器根节点只带 `viewBox` 不带 `width`，
   而图例底板是 `<rect width="…">` —— 正是「全串替换第一个 width」会打歪的那种子元素。
   `test-diagram-export` 补了两个渲染器产物的用例守这条。

## 4. 已知限制

- **graph 布局是分层的，不是力导向**：环安全靠迭代上限兜底（不死循环），
  但布局结果对「跨层回边」不优化。适合链路 / 层级，不适合网状关系图。
- **plot 的 y 范围自动推断是百分位 + 几何外延的并集**，对陡升曲线（`e^x`、`tan`）
  可能把主体压扁；这种图应该显式给 `y`（技能里写了「建议显式给」）。
- **标签按纯文本处理**：不支持 `tspan` 富文本、不上标下标（公式写在正文里）。
  渲染器会转义，写 HTML 标签只会原样显示成文字。
- **diagram 围栏的流式预览不给工具条**（与 svg 链路同一口径）：预览期内容还不是最终结果。
- **表达式不支持分段函数 / 自定义变量 / 求和极限**：分段曲线写多条 curve 各自给 domain。
- **svg 围栏的净化契约仍只能跑浏览器**（DOMPurify 要 window）；
  diagram 的 schema / 表达式 / 渲染确定性在 Node 全覆盖，但「HTML 解析器吃掉 viewBox 大小写」
  这类问题只有真浏览器能作证（`probe-json-diagram` 守）。

## 5. 验收

### 5.1 本次重构相关的测试（全部实跑通过）

- `node scripts/test-json-diagram.mjs` — **35 passed**（纯 Node）
  - 围栏契约（认 mermaid/diagram/svg，不吃 diagrams / svgb / json）；
  - schema 锁字段与 15 类可执行报错（含 `nodes[2].label` 式位置、上限、自环、domain、color…）；
  - 表达式 19 例（隐式乘法 / `^` 结合性 / 白名单函数 / 报错字符位置）；
  - 渲染确定性：同一 JSON 两次渲染**逐字节一致**；
  - graph 布局：最长路径分层、行序稳定（流式增长不重排）、环不死循环、LR 转置；
  - plot：采样密度、渐近线断路、自动 y 范围（轴位 267.38）、nice 刻度、椭圆圆、图例、`axes:false`；
  - 转义（`<script>&"'`）、diff 友好性（等宽标签不挪位）；
  - ★ 流式收敛：逐字符喂入时 key 单调只增，**最后一拍与完整渲染逐字节一致**（plot / graph 各一条）。
- `node scripts/test-widget.mjs` — 15 passed（diagram 三种 format / 回执围栏 / 归因 / 截胡顺序）
- `node scripts/test-chat-frames.mjs` — 30 passed（提示词教 diagram 不教 svg / diagramKindOf 三围栏）
- `node scripts/test-builtin-skills.mjs` — 12 passed；`node scripts/test-diagram-export.mjs` — 9 passed（含渲染器产物导出）
- 浏览器档：
  - `node scripts/probe-json-diagram.mjs`（dev）— **30 passed**：白名单纵深防御、流式每拍净化、
    末拍收敛、show_widget 同源 round-trip、恶意标签插 DOM 不执行；
  - `node scripts/e2e-diagram-stream.mjs`（dev）— **全部通过**：waiting→drawing→ok、
    key 数 `1→3→4→5` 逐步增长、落画顺序 `axes,curve:0,legend,point:0,label:0`、
    描边 dashoffset 1.00→0.00、终态 === `sanitizeSvg(renderDiagram(validateDiagram(src)))`、
    坏 fn 时坐标轴先画、曲线从未上画布、闭合后报错回退源码且无重试按钮；
  - `node scripts/e2e-diagram-fence.mjs`（preview 亦可）— **全部通过**：合法 diagram 出图 + 工具条、
    坏 JSON / 坏 schema 报错回退、三种围栏共存各建各的块、围栏内 `[00:30]` 不被 linkify。

### 5.2 过程中被迫修的三处（都不是重构本身）

- **e2e 进不去导入页**：应用改版后默认落在「课程助手」页，导入控件在课程库页，
  `input[type="file"]` 只在点过 `chat-go-import` 之后才在 DOM 里。
  已在 `e2e-diagram-stream` / `e2e-diagram-fence` 里加「没输入框就先去导入页」，
  未改任何既有脚本 —— `e2e-svg-stream` 等老脚本目前同样卡在这一步，属独立问题。
- **`validateDiagram` 报错顺序**：原先先查未知字段再查 `type`，导致
  `{"type":"diagram", "colour":…}` 只报「colour 不认识」，模型不知道自己连类型都写错了。
  已改成先判 `type`（更根本的诊断），再查字段。
- **弹层退场残留吃掉下一次点击**：见 5.3 的 Modal 问题。脚本改成等 backdrop 真的
  退场；退场没结束就如实打警告并摘掉残留节点，让后续断言仍能跑完。

### 5.3 未跑通 / 已知阻塞（与本次重构无关，均源于进行中的 mdui → HeroUI 迁移）

- **`npm run build`（tsc）曾整体失败**：`src/ui/index.ts` 的 barrel 一度少了
  `useMduiEvent` / `useMduiProperty` / `useDynamicColor` 三个 re-export，
  约 15 个文件仍在 import，整个应用在 dev 下白屏。已按最小改动补回（含 `useDynamicColor` 实现），
  并在文件里留了 ⚠️ 标注说明「迁移收尾时连同实现一起删」。
  **迁移现已推进到那批调用点都改完，我补的三行已被移除；`npx tsc --noEmit` 当前 0 error，
  `npm run build` 通过。**
- **`Modal` 退场时 backdrop 残留**：`Modal.Root` 关闭后，backdrop 带着
  `data-exiting="true"` 一直挂在 DOM 上，并拦截后续点击的 pointer event。
  这是 `DiagramBlock` / `SvgBlock` 共用的「查看大图」弹层，
  **`e2e-svg-fence` 等既有脚本因此失败**，与本次重构无关，迁移收尾时需一并修。
- **`node scripts/test-quiz.mjs` 失败**：它用 esbuild 打包 `QuizCard.tsx` 后在 Node 里跑，
  而 `QuizCard` 现在经 `../ui` 引入 `mdui/functions/setLocale.js`，该模块需要真 DOM
  （`document`）。该失败与本次重构无关（`quiz.ts` / `linkify.ts` 未改动）。
- **全量 `node scripts/e2e-all.mjs`：59 通过 / 44 失败**。逐条核对后，
  **失败项全部落在上述迁移遗留问题**（e2e 进不去导入页、弹层残留、依赖 mdui DOM 的打包测试）；
  本次新增/改动的 8 个脚本里 7 个直接通过，第 8 个（`e2e-diagram-fence`）的失败原因
  是上面那条弹层残留，单独跑已全绿。
