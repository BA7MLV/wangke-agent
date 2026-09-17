# 题卡解析出图（Markdown + Mermaid）设计

- 状态：**已实现**
- 日期：2026-09-17
- 需求：题目解析（explanation）与概念讲解「画个图更好懂」——让解析能出图，而不是只有一行纯文字

---

## 0. 一句话方案

题卡解析不再自绘一串纯文本 + 手动 linkify，改成**与问答正文完全同一条渲染链路**：
`linkifyTimestamps(explanation)` → `XMarkdown` → 复用 `components/mermaid/MarkdownCode|MarkdownPre`
（于是 ```mermaid 围栏自动出图、markdown 粗体/列表照常）；提示词侧补一条「讲不清就画图」的规则。

**为什么不自造一套轻量解析**：围栏判定、`<pre>` 外壳剥离、未闭合围栏挂起、渲染失败回退源码、
中文标签换行、SVG 安全闸门这一串坑，问答正文已经踩平并写了 e2e（见 `2026-09-10-chat-mermaid-design.md`）。
在题卡里重写一遍等于把这些坑再踩一遍。复用是零风险的路径。

## 1. 改动清单

| 位置 | 改动 |
|---|---|
| `src/components/QuizCard.tsx` | 解析走 `XMarkdown`；新增 `a` 组件把 `#seek-秒` 渲染成可点跳转；新增 `seekable` 属性 |
| `src/components/ChatPanel.tsx` | 传 `seekable={!isMaterial}`（材料没有播放器，不 linkify 时间戳） |
| `src/cards.css` | `.quiz-explain__md` 容器 + 覆写 XMarkdown 的边距变量 + 图块间距 |
| `src/harness/prompts.ts` | 新增共用常量 `DIAGRAM_RULE`；`qaSystem` / `qaSystemMaterial` 各注入一条；两处出题规则补「解析支持 markdown 与 mermaid 围栏」 |
| `src/harness/tools.ts` | `present_quiz` 的 `explanation` 字段说明补上 markdown / mermaid 能力 |
| `src/harness/quiz.ts` | `explanation` 的类型注释写清渲染契约（不改逻辑，校验层仍逐字保留） |
| `scripts/test-quiz.mjs` | 解析围栏保留 + 时间戳链接化 + SSR 容器契约（含浏览器专用模块的替身，见 §3） |
| `scripts/test-chat-frames.mjs` | `qaSystem` 规则编号顺延（新增一条无条件规则）+ 出图规则断言 |
| `scripts/e2e-quiz-mermaid.mjs` | **新增**：真浏览器里验解析出图（自播种，不调真实 API） |

## 2. 关键决策

### 2.1 解析正文独占一行，不再接在判定语后面

原来是「回答正确 · 解析文字」同行。解析现在可能是「一段话 + 一张图 + 一个列表」，
硬接在行内会让图块与判定语抢同一行。改为判定语一行、解析正文一块（`.quiz-explain__md`）。

### 2.2 `seekable`：材料模式必须关掉时间戳跳转

与 `linkify.ts` 里「材料场景只跑 `linkifyUnits`、不跑 `linkifyTimestamps`」是同一条理由：
材料没有播放器，`#seek-` 会变成一个点了没反应的死链。默认 `true`，`ChatPanel` 按 `isMaterial` 传。
题干右上角那个 `[mm:ss]` 考点标记同受这个开关管（同一类死链，顺手一起关掉）。

> 没走「让 ChatPanel 把 linkify 函数传进来」那条路：材料引用是 `#unit-N`，要跳阅读器就得把
> `readerRef` 也透传进 QuizCard，接口一下子变重。而材料模式下的解析本来只有「跳 / 不跳」两种可能，
> 一个布尔就够。等材料链路的题卡真的需要跳页时再升级。

### 2.3 CSS 只改变量，不拼权重

`.x-markdown` 自带的段落/列表边距全部走 CSS 变量（`--margin-block` / `--margin-ul-ol` / `--margin-li`
/ `--margin-pre` / `--table-margin`），而它的元素级规则带
`:not(.x-md-disable-all):not(.x-md-disable-p)` 这类前缀。所以：

```css
.quiz-explain__md .x-markdown { --margin-block: 0 0 0.6em 0; --margin-ul-ol: 0 0 0.6em 1.2em; ... }
```

不用去和它拼选择器权重。题卡比问答气泡窄得多，图块宽度交给 `.xmd-mermaid-canvas` 自己的
`overflow-x: auto`，这里只把上下留白收到 6px。

### 2.4 题卡没有「流式半截图」这个中间态

题卡数据只在 `present_quiz` 的参数**完整收到并通过 `validateQuiz` 后**才上屏
（`ChatPanel` 的 `onQuiz` 回调挂在工具执行器里）。所以渲染时解析一定是完整的，
`MermaidBlock` 的 `waiting`（未闭合围栏挂起）分支在题卡场景不会被触发 —— 不需要额外处理。

### 2.5 提示词必须点名 ```mermaid，并给上限

前端只认 `/^mermaid\b/i` 这个语言标记。模型写成 ` ```svg ` / ` ```dot ` / ` ```plantuml `
只会落回普通代码块 —— 用户看到一坨源码，比不画更糟。所以规则里把围栏名写死，并同时给三条约束：

1. **图种随内容选**（flowchart / sequenceDiagram / stateDiagram-v2 / mindmap / pie）；
2. **节点文字 ≤ 10 字、整图 ≤ 10 个节点** —— 不封顶模型会画出三十个节点的图，手机上横向滚到看不清；
3. **一句话能说清的就别画** —— 图比文字更费上下文与渲染开销，防滥用。

问答正文与材料问答共用同一个 `DIAGRAM_RULE` 常量，避免两处话术漂移。

## 3. 坑（都真的会浪费一轮）

1. **`pre` 拿到的 children 是未渲染的 React 元素**：老坑，`mermaid/markdown.tsx` 已处理，题卡复用即继承
   （不要试图在题卡里用 `type === MermaidBlock` 判定）。
2. **模板字符串里的三反引号会截断字符串**：`qaSystemMaterial` 的出题规则是模板字符串（要插 `${noun}`），
   里面直接写 ` ```mermaid ` 会让 TS 当场报 `Expected ',', got 'mermaid'`。必须写 ` \`\`\`mermaid `。
   （`qaSystem` 那条是单引号字符串，不用转义 —— 两处写法不同是有原因的，别"顺手统一"。）
3. **XMarkdown 在 Node 下既不能 import 也不产出内容**：
   - 它的 CJS 构建（`lib/`）顶层 `require('./DebugPanel.css')`，Node 拿 CSS 当 JS 解析直接 SyntaxError；
   - 就算绕开，它的 `processHtml` 依赖 DOMPurify + window，无 window 时 `sanitize` 不是函数，
     走的是「SSR 先不渲染、交给客户端 hydrate」分支 —— 也就是 **SSR 下它本来就不产出内容**。
4. **`components/mermaid` 会把 mdui 的自定义元素链拉进来**，那套模块在 Node 里连 import 都过不去
   （`window is not defined` / `customElements` 未注册）。
   → 于是 `test-quiz.mjs` 的 SSR 段给 XMarkdown 与 mermaid 套件各放一个替身，**只守 QuizCard 自己的契约**：
   解析容器的出现时机、交给渲染器的文本是否已 linkify、材料模式是否关掉跳转。
   **真实渲染（真 DOMPurify + 真 mermaid）由浏览器 e2e 守** —— 那是唯一跑得起来的地方。
   替身里的 `XMarkdown` 会把 content 原样吐出来，所以「linkify 发生在交给渲染器之前」这条仍然测得准。
5. **围栏保护的回归位**：解析里出现 `A[00:30]` 时，`linkifyTimestamps` 的围栏扫描必须挡住它，
   否则图源码当场损坏。`test-quiz.mjs` 用字符串断言、e2e 再点开「查看源码」读 `<pre>` 断言一次
   （两层都留，因为这个 bug 一旦出现就是"图随机变乱"这种难排查的形态）。
6. **新增无条件规则会让既有编号断言失效**：`test-chat-frames.mjs` 里有两处断言写死了
   「6. = present_quiz / 7. = 技能 / 8. = list_frames」与「9. = list_frames」。
   在时间戳规则后插入出图规则后，编号要顺延（→ 7 / 8 / 9 与 10）。这是**契约更新**，不是测试写错。

## 4. 已知限制

- **解析里的 `[第N页]`（材料）不会变成跳转**：材料模式下 `seekable=false`，解析里的页/段引用按纯文本渲染。
  材料题卡要跳页得先把阅读器引用接进 QuizCard（见 §2.2）。
- **SSR/单测覆盖不到解析内容**：原因见 §3.3/§3.4，解析的渲染契约完全由浏览器 e2e 承担。
- **图块在窄卡片里会横向滚动**：与问答正文一致（`.xmd-mermaid-canvas` 的既定行为），不额外做缩放。

## 5. 验收

- `node scripts/test-quiz.mjs`（无需 API key / 无需起服务）
  - 解析含 ```mermaid 围栏时逐字保留（换行与反引号不丢 —— 校验层不做任何 markdown 解析）；
  - 解析里的时间戳：围栏外转成 `#seek-`、围栏内原样；
  - SSR：未作答不出现解析容器、作答后容器出现；交给渲染器的文本已 linkify；`seekable=false` 时不产生 `#seek-`。
- `node scripts/test-chat-frames.mjs`
  - 出图规则注入到 `qaSystem` 与 `qaSystemMaterial`（含围栏名、节点上限、防滥画三要素）；
  - 材料提示词里不引入时间戳口径；出题规则点明解析支持 markdown 与 mermaid 围栏。
- `node scripts/e2e-quiz-mermaid.mjs`（真浏览器，自播种题卡，不调真实 API）
  - 3 道题的解析都展开；只对 mermaid 围栏建块（合法 1 + 失败 1，普通代码块不建）；
  - 合法围栏 → SVG + 工具条齐全；markdown 列表/粗体渲染且无残留 `**`；
  - 解析里的 `[00:10]` 渲染成 1 个可点链接，点一下播放器跳到 10s；
  - 非法语法 → 错误提示 + 源码 + 重试；普通代码块内容原样、块内时间戳不被 linkify；
  - 展开图块源码，`A[00:30] --> B[结束]` 逐字保留（围栏保护回归位）。
