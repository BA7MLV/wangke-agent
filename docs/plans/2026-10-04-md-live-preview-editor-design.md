# .md 所见即所得编辑 + Agent 共编辑

日期：2026-10-04
状态：已实现（一层 19 + 34 条、二层 `e2e-md-editor` 全绿；实现期被实测推翻的初稿推断见「实测推翻的设计」）

## 背景与目标

### 现状

`.md` 导入后走的是**纯只读**链路：

```
文件 → OPFS blob → extractMdUnits → chunkUnits → materialBlocks → MdReader（XMarkdown 渲染）
```

`MdReader.tsx` 里没有任何编辑入口；`materials/parse.ts` 只在导入时跑一次。
用户能读、能划词提问、能检索，唯独不能改。

而项目里已经有一套成熟的「AI 改写」先例 —— `pipelines/handoutEdit.ts`
（讲义块级 AI 改写 → 预览 → 接受 → 重建 DOCX 落盘）。它证明两件事：
① 用户愿意接受 agent 改内容；② 但讲义那套「IR 节点 + 重建产物」的链路**太重**，
不适合直接套到 markdown 上（markdown 的产物就是文本本身，不需要重建）。

### 要解决什么

1. `.md` 能编辑，且**编辑时就是渲染后的样子**（看不到 `#`、`**`、```` ``` ````），
   改完存下去，再打开阅读视图与编辑态一致。
2. agent 能改同一份文档，与用户**共同编辑**：agent 落笔时用户看得见，
   能一键撤销这一次改动，不需要点任何确认按钮。

### 明确不做（非目标）

- **不做多人实时协同**（CRDT / Yjs / 多人光标）。场景是「一个人 + 一个 agent」，
  撤销（undo）已经能覆盖「agent 改错了」这个真实痛点，引入 CRDT 的复杂度不划算。
- **不做 PDF / Word / HTML 的可编辑**。这三种格式的产物都是二进制或带结构的富文本，
  「所见即所得」要重写渲染器；先把 markdown 这条路走通。
- **不做所见即所得的富文本编辑**（图片上传、可视化表格增删行列）。
  编辑器只提供「语法隐藏 + 样式化」，不新增任何文档语法。
- **不替换现有 XMarkdown 阅读视图**。阅读视图是分块渲染 + 段号定位 + 划词提问的载体，
  编辑是一层新皮，两者并存。

## 不变量

写错就会坏掉的硬约束：

1. **文档永远是纯 markdown 文本。** CodeMirror 的 `doc` 就是落库的那份内容，
   不存在「富文本中间态」。一旦允许中间态被保存，agent 的精确字符串替换立刻失效，
   共编辑就退化成「整篇重写」。
2. **语法符号的隐藏是纯装饰。** 靠 `Decoration.replace` 实现（不带 widget 的直接抹掉，
   带 widget 的折成零高度行），不进文档。任何时候切「源码」视图都能看到原文，一个字符都不差。
3. **一次 agent 工具调用 = 一个撤销单元。** 用 `isolateHistory` 注解隔离，
   用户按一次 Ctrl+Z 就能把这次调用里的所有改动一起退掉，不多退也不少退。
4. **编辑后必须重新分块入库。** 只存 blob 不重建 `materialBlocks`，
   问答检索到的还是旧内容 —— 这比「不能编辑」更坏（看起来生效了，其实没有）。
5. **保存失败必须留痕。** blob 写成功但重新分块失败时，UI 要显式提示，
   不能只弹一下 toast 就消失。

## 设计

### 为什么是 CodeMirror 6 + Decoration 隐藏语法

Obsidian 实时预览 / Typora 的原理：**文档模型是纯文本，渲染层靠装饰把语法符号藏起来**。
CodeMirror 6 天然具备这个结构：

- `syntaxTree(state)` 从 `@lezer/markdown` 拿到语法树，节点名稳定
  （已核实：`ATXHeading1..6` / `SetextHeading1..2` / `EmphasisMark` / `CodeMark` /
  `ListMark` / `QuoteMark` / `HeaderMark` / `LinkMark` / `FencedCode` / `CodeInfo` …）
- `Decoration.replace({})` 无 widget 时即为「隐藏这段」
- `Decoration.mark({class})` 负责加样式（标题字号、引用块背景、行内代码底色）
- `Decoration.replace({widget, block:true})` 负责折叠围栏的 ``` 首尾两行**整行** ——
  实测只抹掉那三个字符、保留行高的话，围栏等于没折（见 ①）

定稿时划掉的两条初稿设想：`atomicRanges` 没有用上（折起来的两行是零高度 widget 而不是
被替换掉的区域，不需要「表现得像一块整体」的语义），围栏也**不是**整块替换 ——
代码正文照常显示、可编辑，只把首尾两行折掉。整块替换会让「点开看代码」变成一次额外的交互。

**取舍**：这套东西没有官方「一键开启」的开关，`basicSetup` 不含它，
装饰规则要自己写。代价是几百行胶水代码和逐个调边界情况。
换来的是文档模型干净 —— 这是 agent 能精确改的前提，也是唯一能让「共编辑」成立的形态。

被否掉的两个方案：

- **Milkdown / Tiptap（ProseMirror）**：所见即所得做得更彻底，但文档模型是
  ProseMirror JSON。agent 要做一次字符串替换，得先解析成节点树、算位置映射、
  再序列化回去；`old_string` 匹配失败时无法给出「这里有 3 处相似文本」的可靠诊断。
  往返序列化还有丢格式风险（自定义属性、边缘语法）。共编辑这条路上它更差。
- **Editor.md / Vditor**：开箱即用、双栏预览，但它们是「整块 DOM 组件」，
  agent 想插入文本只能模拟键盘事件或直接改 `textarea.value`，
  拿不到事务与文档坐标，diff 高亮和撤销合并都无从谈起。

### 光标所在处必须露出语法

这是「所见即所得」和「只读美化」的分界线：装饰规则要判断
「光标 / 选区是否与该语法符号的区间相交」，相交就不隐藏。

没有这条，用户在粗体里打字时看不到 `**` 在哪，编辑器会立刻变得难用。
实现上把「哪些区间要露出来」作为纯函数的入参，装饰层只负责调用。

### 落笔路径

```
MdReader（阅读视图，XMarkdown，不动）
   └── 「编辑」→ 动态 import('./MdEditor')   ← CodeMirror 不进主包
                    ├── CodeMirror 6 + markdown() + livePreview() 装饰
                    ├── 顶部条：保存状态 / 撤销本次 agent 改动 / 看源码 / 段号
                    └── 保存：debounce → OPFS blob → 重新分块

ChatPanel（问答）→ agent 调 edit_markdown
                     └── 经 md-editor/bridge 找到当前打开的 editor controller
                          └── 合成一个 ChangeSpec → 单次 dispatch（isolateHistory）
                               └── 改动区间挂 diff 装饰（绿），顶部浮「撤销本次」
```

**为什么 agent 不走 React 上下文**：`harness/tools.ts` 是纯 TS，不该认识 React。
用一个模块级注册表 `materialId → controller`（`md-editor/bridge.ts`）连接两侧，
工具层只依赖一个 `applyAgentEdits(materialId, edits): Result` 函数。
注册表在阅读器卸载时注销，避免拿到已销毁的 view。

**工具契约用精确字符串匹配，不用行号**：
`edit_markdown({ edits: [{ old_string, new_string }] })`。
行号对 LLM 来说极易过期（它看到的行号是上一次检索时的），而 `old_string`
自带定位信息。匹配失败或命中多处时，返回**可操作的诊断**（"未找到" /
"找到 3 处，请补充上下文"），让模型改完重试，而不是白烧一轮。

**只在编辑器打开时注册该工具**：与 `LIST_FRAMES_TOOL` 只在有抽帧时注册同一思路 ——
按课程实际具备的能力给工具，注册一个当前不可用的工具只会诱发无效调用。

### 实测推翻的设计（实现期）

初稿里有九处推断，实现时被浏览器实测证明是**反的**，或换了一种才成立的写法。
全记在这里，因为它们都「看起来显然」，下一个人很可能再推错一遍。

#### 装饰机制

**① 装饰必须走 `StateField`，不能走 `ViewPlugin`。**
CodeMirror 禁止「由插件提供的装饰」携带 block 语义：插件的 decorations 回调
被包成 `decorations.of(view => ...)`（函数形式装饰源），而 `TileUpdate.emit` 里
`disallowBlockEffectsFor` 标记的正是所有函数形式的源，于是打开含围栏代码块的
文档就抛 `RangeError: Block decorations may not be specified via plugins`。
围栏折叠又**必须**是 block 的（内联 widget 只抹掉 ``` 而保留行高，实测 8 行 → 8 行、
高度 154 → 154，等于没折）。唯一出路是 `StateField` + `EditorView.decorations.from(field)`。

**② 「IME 组合期间不重算」这条守卫，恰恰制造了它要防的症状。**
初稿的直觉是：组合期间文档与选区处于不一致中间态，跳过重算可避免装饰错位。
实测（Chromium + CDP `Input.imeSetComposition` 逐步喂 n/ni/nih/nihao）结论相反：

| | 组合过程中的 DOM |
|---|---|
| 带守卫 | `和 \`cod\`。` → `和 \`coe\`。` → `和 \`cde\`。` → `和 code\`。` |
| 不带守卫 | 全程 `和 code。`，稳定 |

原因是 CodeMirror 在组合期间每次按键都派发带 `docChanged` 的事务，文档**逐步真实增长**
（实测 docLength 27→28→29）。跳过重算后装饰停在旧长度上，只能靠「插入点在哪」把旧装饰
映射到新文档，落在结构化区间（行内代码、强调）内部时就错位。
初稿那句「组合结束时必然会补上」也不成立 —— 错位在组合**过程中**就已画在屏幕上了。
结论：始终按当前 state 重算，整段逻辑因此能保持成纯函数 `state → 装饰`。

**③ lezer 解析是异步的，所以「语法树对象变了」也得算一次重算。**
补完语法树时 CodeMirror 派发的是只带 `Language.setState` effect 的事务 —— 既非 `docChanged`
也非 `selectionSet`。只认前两个标志，重算就会永远等不到那一次。5.6 万字符文档上实测：
只认前两个标志时树已完整而装饰只有 624 条，加上「树对象变了」后是 10499 条。

#### 隐藏范围与重叠

**④ 「露出的判定范围」应是标记所属的结构，不是标记自身。**
初稿写的是「标记与光标区间相交就不隐藏」。实测两种取法都不对：

- 行内标记按**自身**判定 → 光标落在 `**粗体**` 中间那个字上时，`**` 不露出，
  用户看不到自己在哪一段强调里，一进去就得先盲找；
- 换成「最近的外层节点」也不行 —— `ListItem` 在嵌套列表里罩住整个子树，
  光标落内层会把外层的 `-` 一起露出来，等于整篇列表符号全现。

定稿：**块级标记（`HeaderMark` / `QuoteMark` / `ListMark`）取所在行，行内标记取外层行内容器
（`Emphasis` / `StrongEmphasis` / `InlineCode`）**。找不到行内容器时退回标记自身 ——
宁可不露，也不凭空把一大段判成「在编辑」。

**⑤ 重叠不能靠「丢弃后来者」解决，要让外层给内层挖洞。**
`RangeSetBuilder` 要求严格有序且不重叠，初稿打算冲突时丢掉后来的一条。实测那样丢的
往往是**整行样式**：标题里的行内代码区间同时被「标题整行样式」和「行内代码底色」覆盖，
按「from 小的胜」扔掉的恰好是行内样式，渲染出来是一个**没有底色的普通标题文字** ——
不报错、不崩，只是样式悄悄没了。
定稿：**先定叶子、再让容器**。行内样式先算，它只让开语法符号；整行样式随后算，它让开
语法符号**和全部行内样式**（`subtract`）。末尾仍留一层「丢弃后来者」的兜底，
但那只是不让将来的疏忽变成 `RangeSetBuilder` 的运行时异常，**别指望它兜住正确性**。

**⑥ 隐藏标记要连带吃掉其后的水平空白，但绝不能往前扩。**
只藏标记本身时，那些空白仍在文档里照常占位 —— 每个标题、每个列表项都向右偏一格，
整篇看着像没对齐。空白是分隔符的一部分，不是内容，所以要一起藏。
但**只往后扩**：`- 乙` 缩进两格时 `-` 在第 2 列，它**前面**的空白是列表层级、是信息；
往前扩到行首会把嵌套列表整个塌成一级。只吃 `[ \t]`，跨行的空白不归它管。

#### 打包与撤销

**⑦ `tools.ts` 必须动态 import bridge。**
初稿把 `import { getMdEditor } from '../md-editor/bridge'` 写成静态的。bridge 静态依赖
`@codemirror/view`，而 `harness/tools.ts` 在**每门课的首屏**都加载 —— 实测普通 import 让
主 chunk **+252 kB（gzip +84 kB）**。改成 `await import(...)` 后为零：bridge 真正被用到
的那一刻，编辑面早就加载完了，模块直接从缓存解析。文件里只留 `import type`
（类型擦除，不产生运行时依赖），两条路径共用同一个类型引用点，避免两边漂移。

**⑧ 撤销必须按 `from` 降序派发，且撤销前要校验。**
`ChangeSet.of` 按升序逐条应用，后一条的坐标会被前一条的插入顶走，于是刚还原回去的内容
又被下一次撤销吃掉。实测同一份数据：升序得到 `AAACCCCCC`、降序得到 `AAABBBCCC`。
另外坐标是**改动后**的文档坐标，用户在 agent 改完之后又动了那几段（或在它们**前面**插了字），
坐标就失效了 —— 这时必须**什么都不做**并给一句原因，否则会静默吃掉用户后来写的字。
回执因此不返回 boolean：`撤不掉` 有「没有可撤的 / 编辑面已关 / 与你的改动冲突」三种，
对用户是三件完全不同的事（bridge.ts 的 `UndoResult`）。

**⑨ `agentDiff()` 必须挂顶层 extension，不能放进「预览 ⇄ 源码」的 Compartment。**
实现时真的漏挂过一次，症状是**高亮永远画不出来而毫无异样**：不报错、不警告，只是没有绿色。
原因是 Compartment 一旦被 `reconfigure`，里面的 `StateField` 是被移除再重建的
（重建走 `create()`，即 `Decoration.none`）——「点一下源码」这个动作顺手就把高亮清空了，
而 field 的值只存在于 state 里，扩展被摘掉那一刻就没了。field 的值随事务平移这件事
也只能写在 `StateField.update` 里（`value.map(tr.changes)` 一行），这是它用 StateField 的
真正理由 —— 与 ① 不同，别照抄那段话。

### 重新分块这条路上的坑

`materials/parse.ts` **静态 import 了 `./pdf.ts`**（pdfjs-dist）。
从编辑器里动态 import 它会把 pdfjs 拖进这条链路 —— 而材料阅读器那边
是刻意让 pdfjs 保持懒加载的。所以把 `parseMaterial` 尾巴那段
（`chunkUnits` → `judgeMaterialText` → 事务重建块）**整段拆进 DOM 无关的
`materials/reindex.ts`**，两条路径共用它，而不是另写一份 md 专用重建。

段号会漂移：编辑后「第 12 段」可能指向别的内容。
`videos.lastUnit` 记的阅读位置在重建后语义已变，重建时一并清掉。

### 已知限制 / v1 不做

1. **frontmatter 在编辑面顶部照常显示**（开头那几行 `---` / `title:`）。
   它不在 markdown 语法树里 —— lezer 把开头的 `---` 解析成水平线或 setext 下划线、
   `title: xxx` 就是普通段落，没有任何节点标出「这段是元数据不是正文」。要藏只能靠
   文本层启发式（首行是 `---` 且全文能配对），而猜错的代价是把正文里的水平线整条藏掉。
   宁可多显示几行，也不让用户以为内容没了。导入侧本来就剥掉它
   （`materials/md.ts` 的 `stripFrontmatter`），所以**阅读视图看不到、只有编辑面露出来**。
2. **有序列表的序号不藏**。`ListMark` 只在父节点是 `BulletList` 时才隐藏：
   序号是信息 —— 用户靠它说「第 3 条不对」，藏掉之后 agent 报「第 3 项已改」也对不上屏幕。
   无序列表的 `-` / `*` 是纯装饰，藏。
3. **链接的 `[]()` 不藏**。`[文字](地址)` 整体保留：地址是信息；而且剩下的文字与真正的
   正文无法区分（同一句话可能既是链接文字又是普通段落），藏了 `[]()` 反而看不出哪句能点。
4. **表格与图片按源码显示**。表格的 `| --- |` 对齐线是编辑时唯一的结构参照；
   图片的 `src` 往往是相对路径，藏了就不知道它指向哪。要看渲染效果切回「阅读」视图。
5. **没有多人协同**。文档模型是纯文本 + 单条 undo 栈，做不了 CRDT。
   v1 的假设是「一个人 + 一个 agent」，agent 的改动能一键撤销就够。
   真要多人同时打字得换文档模型（Yjs / Automerge），那会让 agent 的精确字符串替换失效
   —— 等于把本设计的地基抽掉。

## 涉及文件

**新增**

| 文件 | 作用 |
|---|---|
| `src/md-editor/hideRanges.ts` | **纯函数**：语法树 + 光标区间 → 要隐藏/要加样式的区间表。无 DOM 依赖，node 可测 |
| `src/md-editor/livePreview.ts` | 装饰层：把 `hideRanges` 的结果包成 `Decoration`。薄适配层，`StateField` + `EditorView.decorations.from`（**不是** ViewPlugin，见 ①），含折叠围栏首尾行的零高度 block widget |
| `src/md-editor/theme.ts` | 编辑态样式（走 MD3 令牌，不自造颜色） |
| `src/md-editor/MdEditor.tsx` | React 外壳：挂载 / 卸载 / 「预览 ⇄ 源码」的 Compartment 重配 / 顶栏 / 注册进 agent 桥 |
| `src/md-editor/edits.ts` | **纯函数**：`{ old_string, new_string }` → 改动坐标 + 高亮区间 + 失败诊断。不碰 CodeMirror |
| `src/md-editor/agentDiff.ts` | agent 改动高亮的 `StateField`（顶层挂，见 ⑨）+ `applyDiff` / `clearDiff` |
| `src/md-editor/bridge.ts` | `materialId ↔ controller` 注册表 + `applyAgentEdits` / `undoAgentBatch`。工具层与编辑面之间**唯一**的耦合点 |
| `src/md-editor/save.ts` | debounce 落盘（1.2s）+ 写 OPFS blob + 触发重新分块 + 分阶段报错 |
| `src/materials/reindex.ts` | **从 `parse.ts` 拆出**的「块重建」尾巴（DOM 无关、不牵 pdfjs），`parse.ts` 与编辑落盘共用，不是另写一条平行路径 |
| `scripts/test-md-live-preview.mjs` | 一层单测：隐藏区间计算 |
| `scripts/test-md-edit-tool.mjs` | 一层单测：`old_string` 匹配与 ChangeSet 构造 |
| `scripts/e2e-md-editor.mjs` | 二层 e2e：编辑 → 落盘 → 重新分块；agent 改 → diff → 撤销 |
| `docs/plans/2026-10-04-md-live-preview-editor-design.md` | 本文档 |

**改动**

| 文件 | 改什么 |
|---|---|
| `package.json`（+ `package-lock.json`） | 加 `codemirror`、`@codemirror/lang-markdown`、`@codemirror/commands`、`@lezer/markdown` |
| `src/components/MdReader.tsx` | 工具条加「编辑 / 完成」两态入口 + 编辑态 `lazy` 挂载 `MdEditor`（编辑期间另有一份草稿接着，退出时接回阅读态） |
| `src/materials/material-reader.css` | 编辑态的布局与顶栏样式 |
| `src/harness/tools.ts` | 新增 `EDIT_MARKDOWN_TOOL` 及其执行分支；bridge 走**动态** import（见 ⑦） |
| `src/materials/parse.ts` | 把「块重建」尾巴搬进 `reindex.ts`，自身改为调用（对外 API 不变） |
| `src/components/ChatPanel.tsx` | 多接一个 `materialFormat` prop，据此决定是否注册 `edit_markdown` |
| `src/pages/Player.tsx` | 把 `video.materialFormat` 传给 `ChatPanel` |
| `src/harness/prompts.ts` | 告诉模型：当前材料可编辑，以及工具契约 |
| `scripts/e2e-all.mjs` | 登记 `test-md-live-preview` 与 `e2e-md-editor`（否则一键跑分永远不跑它们） |

## 验证

**一层（`node scripts/test-*.mjs`，无 API Key / 不起服务）**

- `test-md-live-preview.mjs`（19/19）：`@lezer/markdown` 是纯 JS，可在 node 里解析。
  喂几份 markdown，断言隐藏区间表 —— 重点是**光标落在 `**` 内时它不被隐藏**
  （这是本设计最容易写错、也最影响可用性的一条）。另含围栏折叠、藏标记时连带吃掉
  其后的水平空白、行内样式给整行样式挖洞这几条契约。
- `test-md-edit-tool.mjs`（34/34）：`@codemirror/state` 无 DOM 依赖。
  断言未命中 / 多处命中 / 唯一命中的三种诊断文案，以及一批编辑合成**一个** ChangeSet

**二层（`scripts/e2e-md-editor.mjs`，16 项全绿，`service: dev`）**

这个功能的失效形态几乎全是**静默**的：「符号藏过头」和「符号没藏」在截图上一模一样；
只看 blob 就能假通过（问答检索读的 `materialBlocks` 还是旧的）；撤销按钮「灰着」与
「点了没反应」也长得一样。所以断言一律成对出现：隐藏 + 露出、能改 + 能撤、
能存 blob + 能重建块、切视图后高亮仍在。

跑 `dev`（5173）而不是 `preview`：要按模块 URL 取应用自己那份 Dexie 实例与 agent 桥的
`getMdEditor`，生产构建里这两条路都断。

### 覆盖缺口

- **模型链路没验**：「模型会不会真的发出 `edit_markdown` 调用」属于提示词契约，要 SF_KEY。
  e2e 的 C 组直接调 `bridge.applyEdits` —— 那是工具落地之后真正执行的那一段代码，
  diff 高亮 / 撤销 / 纯删除撤销 / 切视图后高亮保持都在里面。缺的是提示词那一环。
- **`test-md-edit-tool.mjs` 尚未登记进 `e2e-all.mjs` 的 `META`**（`test-md-live-preview`
  与 `e2e-md-editor` 已登记）。守门员对未登记脚本只 warn 不 fail，
  后果是「一键跑分」目前不会执行它 —— 补一条 META 即可。

## 变更记录

- 2026-10-04：初稿。编辑器选型定为 CodeMirror 6（用户要求「所见即所得」，
  排除分栏预览与 Editor.md 类整块组件）；agent 落笔方式定为「直接改 + diff 高亮 +
  可撤销」，不做逐条采纳清单。
- 2026-10-04（实现中）：实测推翻初稿两处推断 —— ① 装饰必须走 `StateField`
  而非 `ViewPlugin`（block 装饰被 CodeMirror 禁止从插件提供）；② IME 组合期
  「不重算」的守卫会自己制造错位，正确做法是始终重算。详见「实测推翻的两处初稿设计」。
- 2026-10-04（实现中）：装饰规则落地时修正了初稿的三处推断 ——
  「露出的判定范围」应是标记所属的结构（块级标记取所在行、行内标记取外层行内容器）
  而非标记自身；重叠不能靠丢弃后来者解决（会让整行样式整条丢失，改为外层挖洞让开）；
  围栏的子节点里就有 `CodeMark`（即首尾两行 ```），那里跳过子树是承重的。
- 2026-10-04（实现中）：隐藏规则又补两条 —— 藏标记要连带吃掉**其后的**水平空白
  （否则每个标题、列表项多一个前导空格），但**绝不往前扩**（会吃掉列表缩进，嵌套层级塌平）；
  重算条件还要加上「语法树对象变了」，因为 lezer 解析是异步的。
- 2026-10-04：**已实现**（16 个提交，`b622847` … `66b8a23`；一层 19 + 34 条、二层 16 项全绿）。
  落地上与初稿有实质差异的五处，都不在初稿的推断清单里：
  ① `tools.ts` 必须**动态** import bridge —— 静态 import 把 +252 kB（gzip +84 kB）搬进主 chunk，
     而 `tools.ts` 在每门课首屏都加载；
  ② 撤销必须按 `from` **降序**派发 —— 升序会吃掉刚还原回去的内容（实测升序 `AAACCCCCC`、
     降序 `AAABBBCCC`）；且撤销前要校验，否则会静默吃掉用户后来写的字，
     回执因此不返回 boolean 而是带一句能直接展示的原因；
  ③ `agentDiff()` 必须挂**顶层** extension，不能放进「预览 ⇄ 源码」的 Compartment ——
     Compartment 一旦被重配，里面的 field 是移除再重建的（重建走 `create()`），
     「点一下源码」顺手就把高亮清空；实现时真的漏挂过一次，症状是**高亮永远画不出来而毫无异样**；
  ④ 新增两个初稿没有的文件：`edits.ts`（agent 编辑的匹配与诊断，纯函数）与
     `agentDiff.ts`（改动高亮）；`reindex.ts` 不是「新增一条平行路径」，
     而是把 `parse.ts` 的块重建尾巴整段拆出来、两条路径共用；
  ⑤ v1 的边界写进「已知限制」：frontmatter 显示、有序列表序号不藏、链接 `[]()` 不藏、
     表格与图片按源码、没有多人协同（CRDT）。

  九处被实测推翻的初稿推断全文见「实测推翻的设计」，覆盖缺口见「验证 · 覆盖缺口」。
