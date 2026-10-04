# .md 所见即所得编辑 + Agent 共编辑

状态：进行中（设计已定，实现未开始）

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
2. **语法符号的隐藏是纯装饰。** 靠 `Decoration.replace({})`（无 widget）实现，
   不进文档。任何时候切「源码」视图都能看到原文，一个字符都不差。
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
- `Decoration.widget({widget, block:true})` 负责整块替换（围栏代码块）
- `EditorView.atomicRanges` 让被 widget 替换掉的区域表现得像一块整体

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

### 重新分块这条路上的坑

`materials/parse.ts` **静态 import 了 `./pdf.ts`**（pdfjs-dist）。
从编辑器里动态 import 它会把 pdfjs 拖进这条链路 —— 而材料阅读器那边
是刻意让 pdfjs 保持懒加载的。所以要走一条 md 专用的重建路径，
不顺手把 pdfjs 的 import 改成动态（那是另一个话题，不在本次范围）。

段号会漂移：编辑后「第 12 段」可能指向别的内容。
`videos.lastUnit` 记的阅读位置在重建后语义已变，重建时一并清掉。

## 涉及文件

**新增**

| 文件 | 作用 |
|---|---|
| `src/md-editor/hideRanges.ts` | **纯函数**：语法树 + 光标区间 → 要隐藏/要加样式的区间表。无 DOM 依赖，node 可测 |
| `src/md-editor/livePreview.ts` | 装饰层：把 `hideRanges` 的结果包成 `Decoration`，含 ViewPlugin / facet / atomicRanges |
| `src/md-editor/theme.ts` | 编辑态样式（走 MD3 令牌，不自造颜色） |
| `src/md-editor/MdEditor.tsx` | React 外壳：挂载 / 卸载 / 保存状态 / 工具条 |
| `src/md-editor/bridge.ts` | `materialId ↔ controller` 注册表 + `applyAgentEdits` / `undoAgentBatch` |
| `src/md-editor/save.ts` | debounce 保存 + 重新分块（md 专用路径） |
| `src/materials/reindexMd.ts` | md 重新分块（不牵 pdfjs） |
| `scripts/test-md-live-preview.mjs` | 一层单测：隐藏区间计算 |
| `scripts/test-md-edit-tool.mjs` | 一层单测：`old_string` 匹配与 ChangeSet 构造 |
| `scripts/e2e-md-editor.mjs` | 二层 e2e：编辑 → 落盘 → 重新分块；agent 改 → diff → 撤销 |
| `docs/plans/2026-10-04-md-live-preview-editor-design.md` | 本文档 |

**改动**

| 文件 | 改什么 |
|---|---|
| `package.json` | 加 `codemirror`、`@codemirror/lang-markdown`、`@codemirror/commands`、`@lezer/markdown` |
| `src/components/MdReader.tsx` | 工具条加「编辑」入口 + 编辑态挂载 `MdEditor` |
| `src/harness/tools.ts` | 新增 `EDIT_MARKDOWN_TOOL` 及其执行分支 |
| `src/harness/prompts.ts` | 告诉模型：当前材料可编辑，以及工具契约 |

## 验证

**一层（`node scripts/test-*.mjs`，无 API Key / 不起服务）**

- `test-md-live-preview.mjs`：`@lezer/markdown` 是纯 JS，可在 node 里解析。
  喂几份 markdown，断言隐藏区间表 —— 重点是**光标落在 `**` 内时它不被隐藏**
  （这是本设计最容易写错、也最影响可用性的一条）
- `test-md-edit-tool.mjs`：`@codemirror/state` 无 DOM 依赖。
  断言未命中 / 多处命中 / 唯一命中的三种诊断文案，以及一批编辑合成**一个** ChangeSet

**二层（`scripts/e2e-*.mjs`，登记进 `e2e-all.mjs` 的 `META`）**

- `service: preview`，无 key：打开 md 材料 → 编辑 → 输入 → 等保存 →
  断言 OPFS blob 内容变了、`materialBlocks` 行数变了、阅读视图里能看到新文字
- agent 链路需要真实 API，登记时 `key: SF_KEY`，
  **必须在 META 里写明 skip 原因**（漏登记的后果是「脚本在，但一键跑分永远不跑它」）

## 变更记录

- 2026-10-04：初稿。编辑器选型定为 CodeMirror 6（用户要求「所见即所得」，
  排除分栏预览与 Editor.md 类整块组件）；agent 落笔方式定为「直接改 + diff 高亮 +
  可撤销」，不做逐条采纳清单。