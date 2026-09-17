# 原生 SVG 围栏 + 讲解配图技能 设计

- 状态：**已实现**
- 日期：2026-09-18
- 需求：接着 `2026-09-17-quiz-explanation-diagram-design.md` 留下的两项 ——
  ① 渲染层只有 ```mermaid 一条围栏分支，模型写 ```svg 会落回普通代码块；
  ② 技能体系里没有任何出图规范，画什么、怎么画全靠模型自发。

---

## 0. 一句话方案

渲染层加第二条围栏分支 ```svg（模型直出、**必须净化**），并把它与 mermaid 的**公共外壳**
（标签 / 工具条 / 四态机 / 大图弹层）抽成 `DiagramBlock`；技能层加一个内置技能「讲解配图」，
把「该不该画、选哪种图、节点上限、两种围栏怎么分工」写成正文。

## 1. 改动清单

| 位置 | 改动 |
|---|---|
| `src/components/mermaid/fence.ts` | **新增**：围栏语言判定（纯模块，`diagramKindOf`） |
| `src/components/mermaid/svgRender.ts` | **新增**：模型直出 SVG 的白名单净化器（`sanitizeSvg`） |
| `src/components/mermaid/SvgBlock.tsx` | **新增**：```svg 围栏的图表块 |
| `src/components/mermaid/DiagramBlock.tsx` | **新增**：两种图表块共用的外壳（head / 工具条 / 四态正文 / 源码 / 大图弹层） |
| `src/components/mermaid/MermaidBlock.tsx` | 收敛成「只负责源码 → SVG」，外壳交给 `DiagramBlock` |
| `src/components/mermaid/markdown.tsx` | 围栏判定改用 `fence.ts`；`code` 按类型分发到 Mermaid / Svg 块；`pre` 同步剥离两种围栏 |
| `src/components/mermaid/mermaidRender.ts` | `toStandaloneSvg` 只改**根标签**（原来全串替换，会删掉子元素的 width） |
| `src/skills/builtin/diagramming/SKILL.md` | **新增**：讲解配图技能 |
| `src/skills/builtin.ts` | 注册第 7 个内置技能 |
| `src/harness/prompts.ts` | `DIAGRAM_RULE` 补 svg 口径与「mermaid 优先」分工；两处出题规则同步；`routeSkills` 排除出图类技能 |
| `src/harness/tools.ts` | `present_quiz` 的 `explanation` 字段说明补 svg |
| `package.json` | `dompurify` 从传递依赖升为显式依赖（净化器直接 import 它） |
| `scripts/test-chat-frames.mjs` | 出图规则 svg 口径 + `diagramKindOf` 契约（6 条）+ 路由排除 |
| `scripts/test-builtin-skills.mjs` | 「恰好 6 个」→ 7；新增讲解配图的两条内容断言 |
| `scripts/test-diagram-export.mjs` | **新增**：导出只改根标签的回归位 |
| `scripts/probe-svg-sanitize.mjs` | **新增**：净化器在真浏览器里的契约（24 条） |
| `scripts/e2e-svg-fence.mjs` | **新增**：题卡解析里 ```svg 的渲染 / 安全 / 共存链路（26 条） |
| `scripts/e2e-all.mjs` | 把上面三个新脚本 + 漏登记的 `e2e-quiz-mermaid` 纳入编排 |

## 2. 关键决策

### 2.1 两条链路的安全结论**方向相反**，绝不能互相套用

这是本次最容易踩错的一处，两边都写在代码注释里了：

- **mermaid 产出的 SVG：不做二次 DOMPurify。** 它的 `securityLevel:'strict'` 已经清过一遍；
  再净化无论怎么配都会把 `foreignObject` 里的标签文字整段删掉（流程图节点变空框）。
  那边只做「危险特征检测」，命中就抛错、**绝不重写** SVG。
- **模型直出的裸 SVG：必须净化。** 这段内容来自 LLM，而 LLM 的输入里混着课程字幕、
  用户提问、PDF/Word 材料 —— 全是第三方可写入的文本。不净化就等于把一段可控 HTML
  直接塞进 `dangerouslySetInnerHTML`。

所以 `svgRender.ts` 的文件头第一句就是「与 mermaidRender.ts 的安全结论方向相反」。

### 2.2 白名单，而不是黑名单

`ALLOWED_TAGS` / `ALLOWED_ATTR` 是显式清单，而不是「先全放行再拉黑几个」。两个理由：

1. 上游 DOMPurify 哪天放宽默认值，黑名单会被动挨打，白名单不会；
2. 清单本身就是文档 —— 看一眼就知道「支持哪些图元」。

**外部引用面直接从结构上砍掉**：`href` / `xlink:href` / `src` 一个都不进白名单。
否则一句提示词注入就能让模型画出 `<image href="https://evil/x.png">`，用户的 IP 与 UA
就这么漏出去。`url(...)` 是唯一还能表达引用的地方，所以另做同文档校验：
只允许 `url(#id)`，其余（外部 URL、`data:`）一律拒绝渲染。

`foreignObject` / `style` 也排除：前者把 HTML 面整个引进来，后者能外链 CSS。
`use` / `a` 排除：它们的价值几乎全靠 `href`，留着也是空壳。

### 2.3 净化失败是**报错回退源码**，不是静默降级

与 mermaid 链路同一条原则「绝不吞信息」：外部引用被拦时，用户看到的是
「图形无法渲染，已回退为源码」+ 错误原因 + 围栏原文，而不是一张空图或者半张图。

### 2.4 svg 块**不给重试按钮**

`DiagramBlock` 的 `onRetry` 是可选的，不传就不渲染按钮。mermaid 那边留着重试（管线里
有 parse 与渲染队列，重试是有意义的），而 svg 的净化是纯函数 —— 同样的输入必然同样的
结果，摆一个按不出变化的按钮只会让用户以为「再点一下就好了」。

### 2.5 为什么把外壳抽成 `DiagramBlock`

两条链路真正的差别只有「源码怎么变成 SVG」这一步；而外壳里的坑是共通的：
`<pre>` 外壳剥离、源码折叠的激活态、下载补 xml 头、大图弹层的缩放档位、
以及**弹层里必须拦下播放器快捷键**（vidstack 监听的是 document）。
两套各写一遍就是把这些坑各踩一遍。

`testid` 用前缀参数化（`mermaid-*` / `svg-*`），既有 e2e 的断言一字未改。

### 2.6 围栏判定抽成纯模块 `fence.ts`

`diagramKindOf` 是「提示词 ↔ 渲染层」之间的**硬契约**：提示词里写死围栏名，前端只认
这里放行的语言标记，两边对不上模型就白画。而 `markdown.tsx` 依赖 mdui 自定义元素链，
Node 里连 import 都过不去 —— 抽成纯模块后，这条契约才能在 Node 单测里守住。

### 2.7 技能必须自己说清「不用于讲义」

讲义走公文 IR 渲染（`HandoutDocView`），**不解析图表围栏** —— 模型在讲义里画图只会
变成一坨源码。而技能是通过 `loadEnabledSkillMeta()` 全量进路由的，出图技能天然会被
讲义路由看见。所以两处一起收口：

1. 技能 `description` 点明「仅用于问答讲解与题目解析，讲义正文不渲染图表」（路由靠它判断）；
2. `routeSkills` 加一条排除规则，把「讲义不解析图表围栏」这条约束写进路由提示词。

### 2.8 `toStandaloneSvg` 只改根标签

旧实现是全串 `.replace(/\swidth="[^"]*"/, '')`。mermaid 的产出根节点必然带 width，
所以恰好命中的就是它 —— **但模型手写的 SVG 经常只给 viewBox、根节点不写 width**，
此时全串替换会打到某个子元素上（`<rect width="100">` 直接被删），导出文件里的图形就变形了。
改成只在根标签内部替换，并顺带补 `xmlns`（独立打开的文件不能靠 HTML 解析器兜底）。

## 3. 坑（都真的会浪费一轮）

1. **`viewBox` 的大小写不用自己修**：HTML 解析器有「adjust SVG attributes」规范表，
   `viewbox` 会被自动校正回 `viewBox`（`preserveAspectRatio` / `gradientUnits` 同理）。
   所以白名单里按 SVG 的正确大小写写就行，不要自作聪明加映射。
2. **`ALLOWED_TAGS` 一旦给了就会整体替换 DOMPurify 的默认集**，不是「在默认基础上加」。
   漏掉 `svg` 这个标签，净化结果直接为空。
3. **净化放在 `useMemo` 而不是 `useEffect`**：它是同步纯计算，放 effect 会先渲染一帧
   空态再跳成 ok，出现没必要的闪烁。
4. **`diagramKindOf` 的 `\b` 不能省**：没有它 `svgb` / `mermaids` 会被当成图表围栏。
5. **不要把 svg 分支塞进 `e2e-quiz-mermaid.mjs`**：那个脚本断言了「只建 2 个块」，
   混进新用例就得改它的计数，读起来也分不清在验什么。新开一个脚本，各守各的。
6. **`routeSkills` 新增规则会让输出契约那条编号顺延**：那条断言的是
   「严格输出 JSON：{"skills": [」，不依赖编号，但仍然补了一条断言守着它没被挤掉。

## 4. 已知限制

- **净化会丢样式表**：模型用 `<style>` + class 写的样式会被剥掉，只剩元素上的
  呈现属性与 `style="…"` 内联样式。技能正文里已提示「只画线与图形」。
- **不支持滤镜与动画**：`filter` / `fe*` / `animate*` 都不在白名单里。教学图基本用不上，
  而它们带来的属性面很大。
- **未闭合围栏的等待态只有 mermaid 那条 e2e 覆盖到**：题卡数据是「完整收到才上屏」，
  触发不到 `waiting`；svg 的 `waiting` 分支与 mermaid 共用同一段外壳代码。
- **svg 的净化契约只能跑浏览器**：DOMPurify 要 window，Node 侧只覆盖了导出这条纯函数。

## 5. 验收

- `node scripts/test-chat-frames.mjs` — 29 passed
  - 出图规则注入 svg 口径，且写死「mermaid 画不出的才用 svg」；
  - `diagramKindOf`：只认 mermaid / svg、容忍参数与前导空白、不吃 `svgb`/`mermaids`、
    不认 `dot`/`plantuml`/`js`、不认行内 code 与缺 lang；
  - `routeSkills` 含「不解析图表围栏」的排除规则，JSON 输出契约仍在。
- `node scripts/test-builtin-skills.mjs` — 11 passed
  - 内置技能 7 个；讲解配图写死两种围栏名、五类图种、节点上限、svg 安全约束、不用于讲义。
- `node scripts/test-diagram-export.mjs` — 7 passed
  - ★ 根节点没有 width 时，子元素的 width 不被删（旧实现会删）。
- `node scripts/probe-svg-sanitize.mjs` — 24 passed（真浏览器）
  - 正常图元 / viewBox 大小写 / 中文标签 / 同文档 `url(#id)` 全部保留；
  - `onload` / `onclick` / `<script>` / `javascript:` / `<image>` / `foreignObject` / `<style>` 全部剥离；
  - 外部 `url(https://…)` 直接拒绝；缺 `<svg>` 外壳、未闭合、空内容分别报错；
  - 净化结果插入 DOM 后有非零尺寸且文字有实际宽度。
- `node scripts/e2e-svg-fence.mjs` — 26 passed（真浏览器，自播种题卡）
  - 合法 svg → 出图 + 工具条齐全 + viewBox 未被改写 + 中文标签保留；
  - 围栏内 `[00:30]` 不被 linkify，围栏外 `[00:10]` 正常成链接；
  - 外部引用 → error + 原因 + 源码；
  - mermaid 与 svg 在同一解析里共存，各建各的块；
  - 大图弹层打开、缩放初始 100%；源码折叠展开的是**围栏原文**而不是净化后的串。
- 回归：`e2e-quiz-mermaid.mjs`（20 条）与 `e2e-chat-mermaid.mjs`（含下载导出那条）全绿 ——
  确认 `MermaidBlock` 重构与 `toStandaloneSvg` 改动没有破坏既有链路。
