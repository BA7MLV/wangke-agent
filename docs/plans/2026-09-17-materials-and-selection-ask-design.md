# 阅读材料（PDF / Word）与选区提问 设计

- 状态：**已实现**（2026-09-17）。新增依赖 `pdfjs-dist@4.10.38`；库版本 `db.version(9)`；
  新增节点单测 4 个、e2e 1 个；实施中与本文档的偏差见 §12。
- 日期：2026-09-17
- 需求：① 课程库支持 PDF、Word 等阅读材料（不只是视频）；② 在内容上**拖选文字**或**框选区域**后直接提问
- 已定决策（用户确认）：材料要进 AI 问答检索索引、**与字幕同等对待**

---

## 0. 一句话方案

把「课程」从「视频」泛化为**课程资源**：同一张 `videos` 表加 `kind` 字段区分 `video | material`，
材料文件同样进 OPFS，新增「解析 → 分块 → 向量化」流水线产出一份**带页码/段落定位**的文本索引；
阅读器（PDF 用 pdf.js，Word 复用已有的 docx-preview）占据原视频区，右侧 5 面板机制不变；
全局新增一个**选区提问浮层**，把选区文本 / 框选裁图作为「引用条」喂给现有的 `ChatPanel.send`。

**最大化复用的判断**：现有表几乎全部以字符串 `videoId` 为外键（`chats` / `chatSessions` / `embeddings` /
`cards` / `handouts` / `frames` / `segments`）。只要**材料与视频共用同一个 id 空间**，
会话、题卡、导出、面板保活、批量删除等全部零改动适用。因此**不新建 `materials` 独立表**（论证见 §3.1）。

---

## 1. 不变量（实现过程中必须守住）

1. **视频链路零回归**：`segments` / `embeddings` / `searchTranscript` / 转写流水线一行不改。
   材料用的是**平行的** `materialBlocks` / `materialEmbeddings` / `searchMaterial`。
2. **既有 e2e 契约不破**（新功能只增不改）。关键契约：
   - 资料库：`video-item` / `drag-handle` / `btn-play` / `btn-rename|btn-move|btn-delete` / `btn-more` /
     `menu-*` / `video-job` / `group-header`
   - 播放页：`panel-tab-*` / `panel-slot-*` / `[role="tabpanel"]` / `player-file-missing`
   - 问答：`chat-msg-ai|user` / `chat-composer` / `confirm-dialog(-danger)`
   - 导航：`nav-rail-*` / `nav-bottom-*` / `nav-back`
3. **不引入第二套配色/组件体系**：UI 一律走 mdui 的 MD3 令牌（`--mdui-color-*` /
   `--mdui-shape-corner-*`）与 `src/ui/` 原语（`Panel*` / `PageShell` / `SectionCard` / `EmptyState`）。
4. **不加后端**：解析、渲染、索引全部在浏览器内完成（守住「零后端 PWA」这条产品底线）。
5. **不抢既有手势**：`HandoutDocView` 的触摸左滑（`touchmove` + 方向锁 `|dx|>8 && |dx|>|dy|*1.2`）、
   播放器双击 ±10s、`SwipeDeck` 的 Tinder 滑动都不能被新交互干扰。
6. **iPad Safari 是主力验证平台**，新依赖必须按「老 iPad 也能用」选型（见 §2.1）。

---

## 2. 实测结论（决定选型的事实）

### 2.1 pdf.js 版本：先看浏览器地板，再谈功能

pdf.js 新版大量使用「无守卫」的新 API，**在旧 Safari 上会直接 `TypeError` 而不是优雅降级**。
实测方法：下载各版本 `build/pdf.mjs`，grep 这些标识符并检查是否带 `typeof` 守卫/polyfill：

```bash
curl -sL https://cdn.jsdelivr.net/npm/pdfjs-dist@<ver>/build/pdf.mjs -o pdf.mjs
grep -n 'Promise\.try\|Promise\.withResolvers\|Math\.sumPrecise\|Uint8Array\.fromBase64' pdf.mjs
```

实测结果：

| 版本 | `Promise.withResolvers` | `Promise.try` | `Math.sumPrecise` | `Uint8Array.fromBase64` | 浏览器地板 |
|---|---|---|---|---|---|
| **4.10.38** | 无守卫 ❗ | **有 polyfill** ✅ | 未使用 | **有 typeof 守卫** ✅ | **Safari 17.4** |
| 5.4.624 | 无守卫 ❗ | 无守卫（第 8293 行直接调）❗ | 有 polyfill ✅ | 无守卫 ❗（签名校验路径） | Safari 18.2 |
| 6.3.289 | 无守卫 ❗ | 无守卫 ❗ | **无守卫** ❗ | 无守卫 ❗ | **iOS 26.2** |

落地时间（用于换算地板）：`Promise.withResolvers` → Safari 17.4；`Uint8Array.fromBase64` → Safari 18.2；
**`Math.sumPrecise` → Safari 26.2 / iOS 26.2（2025-11 才发）**。

**结论：pin `pdfjs-dist@4.10.38`。**
v6 的硬地板是 iOS 26.2——对装到主屏幕的 PWA 来说，用户不升级 iOS 就永久打不开材料，
这不是「功能少一点」而是「直接崩」。v4 是唯一自带 polyfill/守卫的版本。

> 备选路线（若将来要用 v6 的新特性）：在 `main.tsx` 顶部注入 4 个 polyfill
> （`Promise.withResolvers` / `Promise.try` / `Math.sumPrecise` / `Uint8Array.fromBase64`），
> 前三个是十几行的实现；`fromBase64` 只在数字签名校验路径用，可以接受。
> 但这是**有测试成本的负债**，一期不做。

⚠️ 另注：`pdfjs-dist@6` 的 `engines` 要求 `node >= 22.13.0 || >= 24`，本机 managed runtime 是 22.22.2，
勉强满足；但这属于「为了跑工具链而升环境」的额外耦合，也是选 v4 的一个次要理由。

### 2.2 `TextLayer` 是官方 API，不要自己造文本层

划线选字必须把「透明文字层」精确叠在 canvas 上。这件事**不需要手写**——pdf.js 从 v4 起把
`TextLayer` 类导出了（`types/src/pdf.d.ts:45` 确认 `import { TextLayer } from "./display/text_layer.js"`）。
官方用法（摘自 `web/text_layer_builder.js`）：

```ts
const layer = new TextLayer({
  textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
  container: div,          // div.className = 'textLayer'，绝对定位叠在 canvas 上
  viewport,
});
await layer.render();
```

配套 CSS 必须抄：`.textLayer` / `.textLayer :is(span,br)` / `.textLayer .endOfContent` /
`.textLayer.selecting`（`web/pdf_viewer.css:583-710`）。**不整份引入** `pdf_viewer.css`（100KB，
绝大部分是 viewer 的工具栏/侧栏 chrome，我们用不到）——把这 4 组规则**逐字抄进** `pdf-reader.css`
并在注释里注明来源（pdf.js 为 Apache-2.0）。

### 2.3 Word 渲染零新增依赖

`docx-preview@0.4.0` **已在依赖里**，且已被 `HandoutPanel.tsx:2` 用于旧版讲义预览：

```ts
import { renderAsync } from 'docx-preview';
await renderAsync(blob, bodyContainer, styleContainer, options);
```

输出是一棵真实的 DOM（`<section class="docx"><p>…`）→ **原生可选中**，划词免费拿到。
`e2e-preview-fonts.mjs` 已经在断言它的渲染结果（`.docx-preview-container section.docx`）。

### 2.4 PWA 与 pdf worker：显而易见的修法是错的（实测）

pdf.js 的 worker 产物是 `.mjs`，而 `globPatterns` 原本是 `['**/*.{js,css,svg,wasm}']` —— 不含 `mjs`。

**直觉修法「把 mjs 加进 globPatterns」有两个坑，实测都踩到了：**

| 修法 | 实测结果 |
|---|---|
| `**/*.mjs` | ✅ worker 被预缓存，但把 `public/ort/` 下的 onnxruntime 预打包也拖了进来 —— `precache 88 entries (20817.85 KiB)`，**首次安装体积从约 1MB 涨到 20MB**，而点开 PDF 才需要 worker |
| `**/pdf.worker*.mjs` | ❌ workbox 的 `globPatterns` 是「**必须有匹配**」语义：产物没写全时直接报 `One of the glob patterns doesn't match any files` 并**中断构建**。worker 的文件名带内容哈希、打包期才确定，配置期无法保证它一定匹配 |
| **`/\.pdf\.worker[^/]*\.mjs$/` 运行时 CacheFirst**（采用） | ✅ 正则匹配不到只是不缓存，**绝不会让构建挂掉**；且只在真正打开过 PDF 之后才付体积 |

所以最终做法是**不改 globPatterns，改用运行时 CacheFirst**（与 cmaps 同一套路）。
代价：worker 不进预缓存，离线打开 PDF 需要「先在线打开过一次」。可以接受 ——
换取的是构建不会因为一个模式的匹配情况而失败。

> 这也是本项目里 `serveOrt` / 讲义字体分包那一类「不讲就会踩」的坑，
> 区别是这次连「看起来对的文档说法」都是错的，只能实测。

### 2.5 扫描版 PDF 不能靠抽文本

`getTextContent()` 对扫描件返回空。一期不做 OCR，且**要在导入时就告诉用户**：
解析后若「文本块总字数 / 页数 < 50」，判定为扫描件，提示「这份 PDF 没有文本层，只能划词/框选提问，
不能参与检索」。**这条提示必须存在**——否则用户会以为问答坏了。

---

## 3. 数据模型

### 3.1 为什么给 `videos` 加 `kind`，而不是新建 `materials` 表

| 方案 | 灵活性 | 代价 |
|---|---|---|
| 新建 `materials` 表 | 字段干净 | 库页分组/文件夹/拖拽/⋯菜单**全部重写一遍**；`chats`/`cards`/`chatSessions` 的外键要多一套；删除/迁移/存储统计双份逻辑 |
| **`videos` 加 `kind`** | 字段略有冗余（材料不用 `duration`） | 现有 7 张外键表、库页全部机制、面板机制**零改动复用** |

选后者。代价是 `videos` 这个名字变得不准（实际语义已是「课程资源行」）——
**不为改名付出 30+ 文件 churn 的代价**，只在 `db.ts` 加注释说明。

### 3.2 表结构变更

**`VideoRow` 加字段（都是非索引字段 → 不需要升版本）**，沿用本项目既有先例
（`SegmentRow.cues` / `ChatRow.images` / `HandoutRow.sectionsJson` 都是这么加的）：

```ts
export interface VideoRow {
  // …既有字段不变…
  /** 资源类型；不设视为 'video'（老数据零迁移）。非索引字段 */
  kind?: 'video' | 'material';
  /** 材料专属：文件格式，决定用哪个阅读器 */
  materialFormat?: 'pdf' | 'docx';
  /** 材料专属：PDF 总页数 / Word 段落数，用于阅读器导航与引用校验 */
  unitCount?: number;
  /** 材料专属：上次阅读到的页/段（断点续读）。非索引字段 */
  lastUnit?: number;
}
```

**新增两张表（v9）**：

```ts
/** 材料的可检索文本块：PDF 一页一块（过长再切），Word 一段一块 */
export interface MaterialBlockRow {
  id?: number;
  materialId: string;   // 即 videos.id
  idx: number;          // 文档内线性顺序，0 起（给排序）
  unit: number;         // 定位单元：PDF=页码(1 起)，Word=段落序号(1 起)
  unitLabel: string;    // 展示用：「第 3 页」/「§2.1 段落 4」
  text: string;         // 归一化纯文本
  kind: 'body' | 'title' | 'table' | 'caption';  // 供检索加权与下游裁剪
}

export interface MaterialEmbeddingRow {
  id?: number;
  materialId: string;
  blockId: number;      // materialBlocks.id
  vector: ArrayBuffer;  // Float32Array
}
```

```ts
this.version(9).stores({
  materialBlocks: '++id, materialId, idx',
  materialEmbeddings: '++id, materialId, blockId',
});
```

> 为什么不复用 `segments` / `embeddings`？`segments` 的 `start`/`end` 是**秒**，
> `get_transcript_range` 按秒检索、字幕面板按时间轴跳转——把页码塞进秒字段会让两套语义互相污染，
> 后面每个读这张表的地方都要先判断 `kind`。**平行表 + 平行的检索函数**更安全，
> 也让 §1 的「视频链路零回归」自动成立。

### 3.3 `ChatImage` 扩展（非索引，不升版本）

截图与框选共用一条多模态通道，但「锚点」语义不同：

```ts
export interface ChatImage {
  ts: number;            // 视频=秒；材料=页码（沿用字段，语义由 kind 决定）
  thumb: string;         // 320px dataURL
  /** 非索引字段：材料截图带定位标签，如「第 3 页选区」；不设=视频截图 */
  label?: string;
  kind?: 'video' | 'page-selection';
}
```

### 3.4 OPFS 目录

`src/store/fileStore.ts` 目前固定 `DIR_NAME = 'videos'`。材料文件复用同一套分块写入逻辑，
但**换一个目录**（避免与视频 id 混在一起，也让「清空视频」的维护操作有明确边界）：

- 把 `saveVideoFile` / `getVideoFile` / `deleteVideoFile` 泛化为 `saveCourseFile(id, blob, onProgress, dir)` 一族，
  保留原函数名做薄封装（**调用点不动**，减少回归面）；
- 新增 `DIR_MATERIALS = 'materials'`。

---

## 4. 模块清单

### 新增

| 文件 | 职责 |
|---|---|
| `src/materials/pdf.ts` | pdf.js 封装：`openPdf` / `renderPageToCanvas`（返回**可取消**句柄）/ `renderTextLayer` / `readPdfOutline` / `extractPdfUnits` |
| `src/materials/docx.ts` | Word **纯文本抽取**（`readDocxUnits` / `extractDocxUnitsFromXml`）。刻意与渲染分离，见 §12 |
| `src/materials/parse.ts` | 解析流水线：格式识别 → 抽单元 → 分块 → 落 `materialBlocks`、回填 `unitCount` / `scanned` |
| `src/materials/chunk.ts` | 纯函数（**Node 可测**）：归一化、PDF 行拼接、长单元再切、扫描件判定 |
| `src/materials/units.ts` | 页/段引用：`fmtUnitRef` / `fmtUnitLabel` / `parseUnitRef` / `unitRefRe`（与 `utils/vtt.ts` 的 `fmtTime` 对称） |
| `src/materials/region.ts` | 框选：矩形规范化、误触判定、canvas 裁剪（1280/320 两档，对齐 `captureFrame`）、框内取字、选区清洗 |
| `src/materials/types.ts` | `MaterialReaderHandle`（阅读器命令式契约，单列以避开循环导入） |
| `src/materials/material-reader.css` | 阅读器样式；含**逐条摘录自 pdf.js `web/pdf_viewer.css` 的 `.textLayer` 契约样式**（Apache-2.0，注明出处） |
| `src/components/MaterialReader.tsx` | 薄壳：取文件 / 断点续读写回 / 扫描件提示，按格式分发给下面两个 |
| `src/components/PdfReader.tsx` | PDF：连续滚动 + **视口窗口化渲染（±600px）** + TextLayer + 框选覆盖层 + 工具栏（翻页/跳页/缩放/目录/框选） |
| `src/components/DocxReader.tsx` | Word：docx-preview 渲染 + **段落级 `data-unit` 打标**（定位契约见文件头注释）+ 顶部窄带跟踪当前位置 |
| `src/components/SelectionAsk.tsx` | 全局选区浮层：靠 DOM 属性（`data-askable` 等）反查来源，不穿透组件链 |
| `src/components/selection-ask.css` | 浮层样式（容器 `pointer-events:none`，移动端贴底固定条） |
| `src/store/selectionAsk.ts` | zustand：跨面板投递「选区 → 提问」；`formatCitation` / `EXPLAIN_PROMPT` / `MAX_REFS` |
| `src/harness/searchMaterial.ts` | `searchMaterial` / `materialRange` / 结果格式化，复用 `search.ts` 导出的 `cosine` |
| `src/pipelines/embedMaterial.ts` | `ensureMaterialIndex` / `materialIndexCount`，与 `embedIndex.ts` 形式对称 |
| `src/pipelines/materialJob.ts` | 解析+建索引的任务外壳（进度写 job store，同一份材料并发去重） |
| `scripts/fixtures/make-pdf.py` | 一次性生成**两个**确定性 fixture：`sample-zh.pdf`（3 页 / 未内嵌中文字体 / 带书签）、`sample-scanned.pdf`（2 页 / 无文本层） |
| `scripts/test-material-units.mjs` | 引用标记：格式化/反解/linkify 往返/代码块不动/`g` 正则陷阱 |
| `scripts/test-material-chunk.mjs` | 归一化与分块：中文空格修正/软换行/扫描件判定/长页再切（**页码不漂移**） |
| `scripts/test-material-docx.mjs` | Word 抽取：段落/表格/三种标题写法/section 归属/实体解码/真 zip 与错误分支 |
| `scripts/test-material-region.mjs` | 框选纯逻辑：矩形规范化/误触判定/选区清洗截断 |
| `scripts/e2e-materials.mjs` | 走**真实导入路径**的端到端：见 §8 |
| `scripts/probe-pdf-fixture.mjs` | 探针（保留）：在 Node 里抽 fixture 文本 + 书签，用于排查「是 fixture 问题还是阅读器问题」 |

### 改动

| 文件 | 改动 |
|---|---|
| `src/store/db.ts` | v9 两张表；`VideoRow` 加 4 个非索引字段；`ChatImage` 加 `label`/`kind` |
| `src/store/fileStore.ts` | 泛化目录参数，新增 `materials/` 目录 |
| `src/store/storageStats.ts` | 材料文件按 `kind` 从「视频文件」拆出，新增「阅读材料」分类 |
| `src/pages/Library.tsx` | `isVideoFile` 旁边加 `isReadableFile`（pdf/docx）；导入分支；网格卡片对材料用**文档图标 + 页数**代替封面帧；状态标签对材料走解析进度 |
| `src/pages/Player.tsx` | 按 `video.kind` 分支：材料时左侧渲染 `MaterialReader` 而非 `MediaPlayer`；`PANEL_TABS` 按 kind 过滤；`panels` 里 ChatPanel 可传空 `playerRef` |
| `src/components/ChatPanel.tsx` | `playerRef` 变可选、新增 `readerRef` / `materialKind`；消费 `selectionAsk` store；引用条 UI；`send()` 支持「只有引用没有输入」；材料模式下引用走 `#unit-` 而非 `#seek-` |
| `src/harness/tools.ts` | `createToolExecutor` 增加 `kind` 入参；材料版工具集（`search_material` / `get_material_range`） |
| `src/harness/prompts.ts` | 新增 `qaSystemMaterial(...)`；材料版技能清单复用同一套 |
| `src/utils/linkify.ts` | 新增 `linkifyUnits`（`[第3页]` → `#unit-3`）+ `UNIT_LINK_PREFIX`；材料模式不跑 `linkifyTimestamps` |
| `vite.config.ts` | `globPatterns` 加 `mjs`；`optimizeDeps.include` 加 `pdfjs-dist` |
| `README.md` | 功能/目录结构/测试清单同步 |

---

## 5. 交互设计

### 5.1 选区提问的三个来源

| 来源 | 触发 | 引用块内容 | 可跳转 |
|---|---|---|---|
| **PDF** | 拖选文字（TextLayer 原生选择） | 选中文本 + `第 N 页` | ✅ 跳页 |
| **Word** | 拖选文字（docx-preview 原生选择） | 选中文本 + `§章节 段落 N` | ✅ 跳段 |
| **字幕 / 讲义** | 拖选文字（既有 DOM 文本） | 选中文本 + `[mm:ss]` | ✅ 跳播放位置 |
| **任意** | 框选区域 | 裁图（+ 框内可见文字） | ✅ 跳来源位置 |

**这是一次做成「全局能力」而不是「PDF 专属功能」**——字幕上划词问「这个词什么意思」、
讲义里划词问「这段为什么这么写」，是同一个需求。字幕/讲义这两个来源几乎零成本（只是多两个
`source` 取值），但覆盖面大得多。

### 5.2 浮层与手势冲突（关键设计点）

**冲突**：PDF 上「拖动」既要能拖选文字，又要能框选区域，二者都吃 `pointerdown/move/up`。

**解法：显式工具态切换**（真实 PDF 阅读器的做法）。阅读器工具栏上一个「框选」开关：

- 默认 **选字**：`.textLayer` 正常吃指针事件，框选层 `pointer-events: none`；
- 点「框选」→ 进入框选态：`.textLayer { pointer-events: none; user-select: none }`，
  框选层接管指针；**框完一次自动退出**（避免用户忘了自己在框选态，发现「选不了字」而困惑）；
- 框选态下给整页加一层浅色描边提示（`outline: 2px dashed primary`）。

**不与既有手势打架**：

- `HandoutDocView` 的左滑靠 `touchmove` 的**方向锁**（横向才认）；
  我们的浮层只在 `selectionchange` 且**选区非空**时出现，且 `pointerdown` 在浮层按钮之外会先收起浮层 ——
  两条路径互不命中。
- 浮层容器本身 `pointer-events: none`，只有按钮 `pointer-events: auto`，
  这样它覆盖在正文上时**不影响继续滚动和继续拖选**（否则会出现「浮层把我的手指吃了」）。
- 浮层只在「选区落在允许的容器内」（`[data-askable]` 标记的容器内）时才弹出 ——
  避免在输入框、AI 回答代码块、设置页里乱弹。

### 5.3 引用块格式（喂给模型的样子）

```text
> [选自《线性代数讲义》第 3 页]
> 设 A 为 n 阶方阵，若存在可逆矩阵 P 使 P⁻¹AP 为对角阵，则称 A 可对角化……

用户的问题
```

- 超长选区截断到 **1200 字**并在末尾标注「（已截断）」——防止一次划了整个目录把上下文吃满；
- 纯空白/超短（< 2 字）选区忽略，不弹浮层；
- 引用块以**独立的「引用条」**呈现（composer 上方可堆叠、可单条 × 删除、最多 3 条），
  而不是塞进 textarea 文本里 —— 用户能看清自己引了什么，也能一键撤掉。

### 5.4 跨面板投递机制

`send()` 在 `ChatPanel` 内部，但选区来自阅读器（`Player` 的另一棵子树）。
不把它提升重写（`ChatPanel` 940 行，动它的风险最大），而是**新增一个极小的 zustand store 做投递**：

```ts
// src/store/selectionAsk.ts
interface Citation {
  text: string;
  source: 'pdf' | 'docx' | 'handout' | 'subtitle';
  unitLabel?: string;   // 「第 3 页」/「§2.1 段落 4」/「03:25」
  page?: number;
  time?: number;
  image?: { dataUrl: string; thumb: string };
}
interface SelectionAskStore {
  pending: { cite: Citation; mode: 'explain' | 'compose' } | null;
  ask: (cite: Citation, mode: 'explain' | 'compose') => void;
  take: () => void;     // ChatPanel 消费后清空
}
```

- 浮层 → `ask(cite, mode)`
- `Player` 订阅 `pending` → `setActiveTab('chat')`（移动端浮层点完必须能看到问答面板）
- `ChatPanel` 订阅 `pending` → 把 `cite` 压入引用条；`mode==='explain'` 直接发送（默认提示词
  「请解释这段内容的含义」），`mode==='compose'` 只填入并聚焦输入框等人打字

用 store 而不是 ref/自定义事件的必要性：桌面端 `mdui-tab-panel` 与移动端 `panel-slot` 都用
`hidden`/`display:none` **保活**（`Player.tsx:396-411`），所以 ChatPanel 一定挂着、能收到状态；
反过来如果走 DOM 事件，面板被隐藏时的时序会很脆。

### 5.5 框选裁图：PDF 能做，Word 只取文字（有意的取舍）

- **PDF / 视频画面**：有真实 canvas / video → 框选裁图精确。裁图规格**对齐 `captureFrame`**
  （最长边 1280 / JPEG 0.85，缩略图 320 / 0.7），这样能直接复用 `ChatPanel.send` 里
  **现成的三级多模态降级链**（多模态直读 → 视觉模型描述成文字 → 不支持则拦截引导）。
- **Word / 讲义**：docx-preview 输出的是**流式 HTML**，没有可信的 canvas 快照。
  用 `foreignObject` 序列化 SVG 的路线会丢系统仿宋/楷体字体（本项目讲义预览正是靠 `local()` 链命中
  系统公文字体，见 README 讲义一节）并让体积极大，**得不偿失**。
  → Word 的框选**降级为「取框内文字」**，浮层文案明确写「已选 128 字」而不是假装截了图。

**框选额外收益**：框选时顺手把落在矩形内的 TextLayer span 文本一起取出，
作为图片的**文字旁证**同时发给模型（图 + 字双通道），对公式、表格这类 OCR/识别易错的场景更稳。

---

## 6. 检索与 Agent

### 6.1 材料分块规则（`chunk.ts`，纯函数）

| 来源 | 单元 | 切分 |
|---|---|---|
| PDF | 页 | 一页一块；超过 **800 字**按句号/换行再切成多块，**同页的块保留相同 `unit`（页码）** |
| Word | 段落 | 一段一块；样式为标题的段落 `kind: 'title'`；表格整表一块 `kind: 'table'` |

- 归一化：折叠连续空白、去零宽字符、PDF 的**软换行拼接**（行尾无标点则与下一行合并——不然一句话被切成两半，语义检索命中率掉得厉害）；
- 页码来源：`textContent.items[].hasEOL` + 调用方传入的 `pageNumber`（**不猜页码**）；
- 扫描件判定：`总字数 / unitCount < 50` → 标记 `scanned`，跳过索引并提示（§2.5）。

### 6.2 工具集（条件注册，沿用 `LIST_FRAMES_TOOL` 的既有范式）

```ts
// 材料版
search_material      { query }            → 语义检索，返回「[第N页] 文本」
get_material_range   { from, to }         → 按页码/段落范围取原文
// 复用：use_skill / read_skill_reference / present_quiz
```

`createToolExecutor(videoId, onQuiz)` 的签名改为
`createToolExecutor(courseId, { kind, onQuiz })` —— 唯一的既有调用点在 `ChatPanel`。
`search_transcript` 在材料下**不注册**（材料没有字幕，注册了只会诱发无效工具调用）。

### 6.3 提示词

新增 `PROMPTS.qaSystemMaterial(materialName, skillMetaList?)`，与 `qaSystem` 同构，只换规则：

- 「先用 `search_material` 检索」/「用 `get_material_range` 看指定页码范围」；
- 引用规则从 `[mm:ss]` 换成 **`[第N页]`**（Word 用 `[段落N]`）；
- 材料没有画面 → **不注入 `list_frames` 规则**。

⚠️ **必须同时改的地方**：`linkifyTimestamps` 仍会对回答跑一遍。若模型在材料场景输出了
`[03:25]`，会生成一个指向不存在播放器的 `#seek-` 链接。材料模式下**不跑 `linkifyTimestamps`**，
只跑 `linkifyUnits`；`SeekLink` 组件对 `#unit-N` 的分支在材料下滚动阅读器并高亮 0.8s。

### 6.4 成本量级

300 页 PDF ≈ 300 块 × 约 600 字 → 按 `embedIndex.ts` 既有的 `BATCH = 16` 是 19 次 embedding 调用；
断点续做（跳过已向量化的 `blockId`、清孤儿向量）**直接照抄** `ensureEmbeddingIndex` 的结构。

---

## 7. 库页与存储

- **导入**：`isReadableFile`（`pdf` / `docx`）与 `isVideoFile` 并列；**不接受 `.doc`**
  （旧二进制格式，解析要另写一套 OLE 复合文档读取，性价比极低）→ 明确报错提示「请另存为 .docx」。
- **卡片**：材料卡片走「文档图标 + 页数/段落数 + 大小 + 日期」，封面帧逻辑（`useCover` 读 `db.frames`）对材料不适用
  —— 保持网格版式（YouTube 式 16:9 缩略图位）但用文档底图占位，**避免网格错位**。
- **状态标签**：材料的解析/索引进度复用 `useJobStore`（新增 `phase: 'parse' | 'index'`），
  `libraryJobCopy` 对材料返回「解析中 / 建立索引中」，与视频的「转写中」并列。
- **存储统计**：`storageStats.ts` 的 `videos` 累加处按 `kind` 分流（材料 → 新的「阅读材料」分类），
  否则材料的体积会被算进「视频文件」，用户看着会莫名其妙。
- **删除**：`handleDelete` 的级联删除要加 `materialBlocks` / `materialEmbeddings`。

---

## 8. 测试计划（已落地）

### 单元（Node 直跑，无需 API key / 无需起服务）

```bash
node scripts/test-material-units.mjs    # 引用标记：格式化/反解/linkify 往返/代码块不动/`g` 正则陷阱
node scripts/test-material-chunk.mjs    # 归一化与分块：中文空格修正/软换行/扫描件判定/长页再切（页码不漂移）
node scripts/test-material-docx.mjs     # Word 抽取：段落/表格/三种标题写法/section 归属/实体解码/真 zip 与错误分支
node scripts/test-material-region.mjs   # 框选纯逻辑：矩形规范化/误触判定/选区清洗截断
node scripts/probe-pdf-fixture.mjs      # 探针：在 Node 里抽 fixture 文本与书签（排查用，非断言）
```

> `utils/linkify.ts` 是被 Node 脚本直接 import 的（type stripping），
> **新 util 的相对导入必须带 `.ts` 扩展名**（该文件顶部已有此注释约定）。
> `chunk.ts` / `units.ts` / `docx.ts` 必须**不依赖 DOM**，才能进这一档测试 ——
> 这也是 §12.1 把 Word 渲染拆出去的原因。

### Browser e2e

```bash
npm run preview &                  # 4173（走构建产物，连带验证 worker 与 cmaps 的产物形态）
node scripts/e2e-materials.mjs     # 无需 API key
# 或者走编排器（已登记，preview 档）：
node scripts/e2e-all.mjs --only=e2e-materials
```

> ⚠️ 这一档**必须走 preview（真 dist）**才算数。跑在 vite dev 上时 dev 直接编译源码、
> 永远最新，对「构建产物形态」零信息量 —— 而且构建被宿主审批拦住时它会假装全绿
> （§12.14 就是踩了这个：dev 档全绿、preview 档第 9 节全红）。

| 断言 | 说明 |
|---|---|
| 导入后在库列表出现，并标记「已解析 3 页」 | 走**真实导入路径**（`setInputFiles`），覆盖 `isImportable → saveMaterialFile → videos.put → startMaterialJob` |
| `reader-page-indicator` = `1 / 3` | 解析出的页数与文件一致 |
| **文本层渲染出「线性代数讲义」** | ⭐ 这一条同时是 **`/pdfjs/cmaps/` 链路的验收**（fixture 刻意用未内嵌字体的 STSong-Light） |
| canvas 与 `.textLayer` 尺寸差 < 2px | 错位就会「选到错的字」，且这种 bug 肉眼看不出 |
| 缩放 → `80%` / 下一页 → `2 / 3` / 跳页输入 3 → `3 / 3` | 工具栏三件套 |
| 书签目录含「第二章 矩阵的秩」 | `readPdfOutline` 生效 |
| `ask-float` 出现且 `.ask-float__where` = 「第 1 页」 | 划词入口 + 定位正确 |
| `ask-compose` → `chat-ref-chip` 内容含「第 1 页」，浮层收起 | 引用条落位 |
| `ref-chip-remove` → 引用条消失 | 单条可删 |
| 框选 → `ask-float` → `chat-ref-chip img.chat-ref__img` 存在 | 框选裁图进引用条 |
| 框选完成后 `reader-area-hint` 消失 | 框完自动退出，不让人困惑于「选不了字」 |
| 框选态下 `.textLayer` 的 `pointer-events` = `none` | 两者不抢手势 |
| 点回答里的 `[第2页]` → 指示器变 `2 / 3` | 页码引用可跳转（用**播种历史会话**实现，不需要 API key） |
| 页面上没有 `a[href^="#seek-"]` | 材料模式没跑 `linkifyTimestamps`，不会出现点了没反应的死链 |
| 扫描件：列表标「扫描件」+ 打开后 `material-scan-hint` 含「无法参与问答检索」+ 仍渲染出 2 页 | 无文本层这条分支被显式覆盖 |
| **Word 一节**：`sample.docx` 标「已解析 10 段」（**不是**「扫描件」）、`docx-preview` 渲染出 `data-unit`、划词 → 引用条带段标、点 `[第5段]` → 滚动到第 5 段 | §12.11 的回归锁：段均 25 字不许被当成扫描件。**只有第一条依赖标签**，dist 陈旧时红的也只有它（§12.14） |
| **空文档一节**：`sample-empty.docx` 标「无正文·不可检索」+ `material-empty-hint` 出现 + 问答面板按「没有正文」解释，且**页面不许出现「扫描件」字样** | `empty` 与 `scanned` 两条分支必须互斥、话术不许串（§12.11）；这一节**三条全依赖标签/文案**，dist 陈旧时会整节红（§12.14） |

定位库行一律用「导入前后 id 集合的差」，**不要按文件名找**（§12.12）。

**回归红线**（必须全绿）：`e2e-library` / `e2e-mobile` / `e2e-chat` / `e2e-chat-image` /
`e2e-chat-frames` / `e2e-chat-mermaid` / `e2e-handout-edit` / `e2e-storage-card` /
`e2e-materials` / `e2e-covers` / `e2e-all`。

> `e2e-all` 的脚本清单（`META`）是**手工维护**的，漏登记 = **静默跳过**：脚本在磁盘上、
> 报告里也不报错，看起来全绿其实没跑。材料这一批就这样漏过一整轮（4 个单测 + `e2e-materials`
> + `e2e-covers` + `test-library-job-copy`），直到人工比对才发现。
> 现在启动时会按前缀点名未登记的脚本，并写进汇总行、`e2e-report.json` 的
> `unregisteredScripts` 与报告开头 —— 新增脚本时请一并补 `META`。

主要回归风险点：`videos` 表加字段、`PANEL_TABS` 按 kind 过滤、`ChatPanel` 的 `playerRef` 变可选、
`CueRow` 多了 `ask` 属性、存储统计多了一个分类。

### fixture

中文 PDF 的文本层不能用「手写最小 PDF」造（手写只能塞 WinAnsi 字符，中文要嵌字体）。
用 Python `reportlab` **一次性生成**并提交，生成脚本 `make-pdf.py` 一并提交以保证可复现：

```bash
python3 scripts/fixtures/make-pdf.py
```

- `sample-zh.pdf`（约 5KB）：3 页、**未内嵌** CJK 字体（STSong-Light）、带书签；
- `sample-scanned.pdf`（约 2KB）：2 页、只有图形**没有任何文字**（真实扫描件就是这样：
  `getTextContent()` 返回空而不是报错）。

两个都是确定性产物（`canvas(invariant=1)` 固定了创建时间），重复生成字节一致。

---

## 9. 分阶段实施

| 阶段 | 内容 | 出口 |
|---|---|---|
| **1. 数据层与解析** | `db.ts` v9、`fileStore` 泛化、`chunk.ts`/`units.ts`/`docx.ts`/`parse.ts` | 三个 Node 单测绿 |
| **2. 阅读器** | `PdfReader` / `DocxReader` / `MaterialReader`；库页导入与卡片；存储统计 | `e2e-materials` 渲染部分绿 |
| **3. 检索与问答** | `embedMaterial.ts` / `searchMaterial.ts` / 工具集 / 提示词 / `linkifyUnits` / 页码引用跳转 | 材料问答能引用到页并跳页 |
| **4. 选区提问** | `selectionAsk` store / `SelectionAsk` 浮层 / 划词（PDF·Word·字幕·讲义）/ 框选 / 引用条 / `ChatPanel` 接线 | `e2e-materials` 全绿 |
| **5. 回归与文档** | 跑 §8 全部红线；`README.md` 同步 | `e2e-all` 绿 |

依赖关系：2 依赖 1；3 依赖 1（可与 2 并行）；4 依赖 2 与 3。**建议按 1 → 2 → 3 → 4 → 5 顺序**，
每阶段独立可验证，不留半成品。

---

## 10. 非目标（一期明确不做）

1. **扫描版 PDF 的 OCR**：需要引入 OCR 引擎（体积/算力都不合适），只做「明确告知不支持检索」。
2. **EPUB / PPT / `.doc`**：结构差异大，PDF + Word 已覆盖「讲义 / 教材 / 论文」主场景。
3. **材料生成公文讲义**：现有 `handout` 流水线的封面/抽帧/章节语义都绑定视频，材料版是另一件事，
   一期用材料问答（「帮我总结第 1-20 页」）覆盖。
4. **材料制卡（Anki）/ 出题**：id 空间已兼容，技术上很便宜，但一期不扩面板，留待后续。
5. **Word 的框选视觉截图**：理由见 §5.5，降级为「取框内文字」。
6. **多材料合并检索**：一期只检索「当前打开的这份」。跨材料检索需要引入「课程」这一层归组，
   是独立话题。

---

## 11. 已知风险

| 风险 | 影响 | 处置 |
|---|---|---|
| pdf.js worker 在 Vite dev/build 下的产物形态（`.mjs?url` vs `new Worker(new URL(...))`） | 开发能跑、构建后 404 或离线失效 | 阶段 2 第一步就**先**打通 worker（含 `mjs` 预缓存），跑一次 `e2e-preview-fonts` 式的「构建产物断言」再往下做 |
| 大 PDF（>500 页）窗口化渲染的内存与滚动流畅度 | 卡顿 / 崩溃 | 视口外 ±600px 才渲染 + 卸载时 `cancel()` 渲染任务与文本层流；在 iPad 上实测 300 页文件作为验收项 |
| 面板按 kind 过滤后，`mdui-tabs` 的 `value` 与 `activeTab` 初值不一致 | 材料页打开时白屏/无面板 | 初值按 kind 推：材料默认 `'chat'`，视频仍是 `'subs'`；`PANEL_KEYS` 也按 kind 派生 |
| 选区浮层在 iPad Safari 上被原生选择菜单遮挡 | 浮层看不见 | 浮层定位留出上方安全距离；必要时改为**贴底固定条**（移动端）而不是跟随选区 |
| 中文 PDF 的文本层存在大量空格/乱序（PDF 是排版格式，无「词」概念） | 划词文本可以，但检索质量差 | 归一化里做 CJK 相邻字符去空格；接受「检索质量不如字幕」并在此记录预期 |

---

## 12. 实施记录：与本文档的偏差

实施过程中的实际决定，**保留在此是为了后人不再重复踩**。

1. **Word 的文本抽取与渲染拆成两处**（原计划都放 `materials/docx.ts`）。
   原因：`docx-preview` 依赖 DOM，一旦在同一模块里 import 它，`materials/docx.ts` 就不能再被
   Node 单测直接 import（`test-material-docx.mjs` 要跑在无浏览器环境）。
   现在 `materials/docx.ts` 是纯字符串处理（Node 可测），渲染在 `DocxReader.tsx` 里动态 import。
   与 `anki/apkgCore.ts`（Node 可测核心）+ `anki/apkg.ts`（浏览器封装）的分工一致。

2. **PDF 的「标题/章节」不再靠字号启发式，改用 PDF 书签**（原计划 §6.1 提过字号启发式）。
   实现中途删掉了字号那段：PDF 没有段落/样式语义，字号在封面页、页眉、公式上误判率太高，
   而书签是作者显式标注的真目录，还能顺带做成阅读器的目录导航。
   没有书签的 PDF 就不标 `section`，不猜。

3. **`#page-N` 改成统一的 `#unit-N`**：材料页天然知道自己是 PDF 还是 Word，
   一个前缀就够了，ChatPanel 的分支也少一条（`UNIT_LINK_PREFIX` 常量由渲染层与测试共用）。

4. **框选浮层的动作条与划词共用**（`SelectionAsk` 同时渲染本地选区与 store 里的 `bar`），
   而不是让框选直接塞引用条 —— 两个入口的手感才一致。

5. **pdfjs 的 cmaps / standard_fonts 不进 `public/`，改用 vite 插件**（`pdfjsAssets()`）：
   从 node_modules 直出（dev/preview 中间件）+ build 时拷进 `dist`。
   手抄进 `public/` 的副本会在升级 pdfjs 时静默过期，症状是「某些中文 PDF 变空白」，极难定位。
   对应地，SW 对 `/pdfjs/**` 走**运行时 CacheFirst**（2.4MB / 209 个文件不适合预缓存）。

6. **原计划的 `e2e-material-chat.mjs`（需 API key）合并进了 `e2e-materials.mjs`**：
   「回答里的 `[第2页]` 可点击跳页」这条**不需要 API key 也能测** —— 播一条历史会话即可，
   顺带还验证了「材料模式不跑 `linkifyTimestamps`」（断言页面上没有 `#seek-` 链接）。
   留一个需要 key 的用例价值不大，还会让 CI 分叉。

7. **fixture 用未内嵌字体的 `STSong-Light`**（刻意的）：这类 PDF 必须靠 CMap 才能取到文字，
   所以 e2e 里「文本层渲染出中文」这一条**同时就是 `/pdfjs/cmaps/` 链路的验收**
   （vite 插件没生效 → 页面空白 → e2e 立刻失败，而不是等线上用户报「教材打不开」）。

8. **PWA 侧从「改 globPatterns」改成「运行时 CacheFirst」**，理由与实测数据见 §2.4 ——
   原来计划里写的「必须加 mjs」是错的，`**/*.mjs` 会把 ort 的 20MB 一起预缓存，
   而精确模式匹配不到时 workbox 会直接让构建失败。

9. **库页要订阅 job store 在任务终态时重读列表**（计划里没写到）。
   后台解析会回写 `videos.unitCount` / `scanned`，但库页的 `videos` 是导入那一刻的快照，
   结果是一份已解析好的 PDF 一直挂着「待解析」标签 —— e2e 第一版就抓到了这个（两条断言失败）。
   现在任务到 `done`/`error` 时自动 `reload()`。

10. **e2e 的两处稳定性处理**（都是实测「上一次过、这一次挂」才加的）：
    - 框选拖拽前必须**等 smooth 滚动结束**再量 `boundingBox`，并把拖拽范围夹到
      「页面的可视部分」内 —— 否则起点会落到页面外，表现为「框选时灵时不灵」；
    - 划词选区的等待必须等**目标页自己的** `.textLayer span` ——
      窗口化渲染下别的页可能还挂着，等错了页等于没等。

11. **`scanned` 收窄为「仅 PDF」，Word 的「无正文」另立一个 `empty` 字段**（原计划 §2.5 / §6.1
    只描述了 PDF 的扫描件判定，没说 Word 怎么办）。
    实施时 `looksScanned` 被不分格式地用在两种材料上，于是**短段落 Word 被整体误判成扫描件**：
    `scripts/fixtures/sample.docx` 是 250 字 ÷ 10 段 = 段均 25 字，低于「页均 50 字」的阈值。
    后果不止是标签错——`materialJob` 命中 `scanned` 就直接跳过建索引，Word 材料的
    `search_material` 检索全空，与 §0 已定的「材料与字幕同等对待」直接冲突；
    阅读器还会对一份文字好好的 docx 谎称「没有文本层」。
    现在判定统一收在 `chunk.ts` 的 `judgeMaterialText(format, totalChars, contentUnits)`：
    `scanned` 只对 PDF 成立（它的前提是「PDF 是排版格式，可以完全没有文本层」），
    Word 取不到字是另一回事，记作 `empty`（空文档 / 只有图片的 Word），
    库页标签、阅读器横幅、ChatPanel 的索引说明三处话术都按这个区分走。
    `test-material-chunk.mjs` 用 fixture 的真实数值（250 字 / 10 段）钉了回归锁，
    `e2e-materials.mjs` 的 Word 一节（§8 未覆盖，实施时补的）也覆盖了这条；
    另有 `sample-empty.docx`（只有一张图片、一个字都抽不出来）覆盖反向路径，
    断言「判为无正文」且**不许**出现「扫描件」字样（第 9 节）。
    **教训：「页均」里的「页」不是量词，是前提**——换个格式当分母，阈值就换了含义。

12. **`e2e-materials.mjs` 的 `importFile` 改为「按新增 id」而不是「按文件名」定位库行**。
    原实现是 `:has-text("<文件名>")`，而 fixture 的名字互相包含：
    `sample.docx` 的名字是 `sample`，`sample-zh.pdf` 的名字是 `sample-zh`——
    `"sample"` 是 `"sample-zh"` 的子串，于是选择器**同时命中两张卡片**，
    `$eval` 取 DOM 里第一张，返回哪一张取决于 docx 那行有没有来得及渲染。
    实测后果具有极强的误导性：Word 一节 6 条断言全红（库页标签、docx-preview 没渲染、
    `data-unit` 为 0、找不到第 5 段……），每一条都像是「Word 功能坏了」，
    而真实原因只是 `docxId` 拿成了 PDF 的 id。
    现在改为先记录导入前的 id 集合、等**新增的那一行**出现——与文件名、列表排序、
    卡片文案都无关。**凡是「导入 → 拿 id」的 e2e 都该用这个写法**，别按名字找。

13. **§2.4 关于预缓存体积的归因是错的，实测订正**（与实现无关，是文档自己的测量结论有问题）。
    §2.4 把「precache 20MB」记成「加 `**/*.mjs` 把 `public/ort/` 拖了进来」，
    并称改用运行时 CacheFirst 后「首次安装体积约 1MB」。实测（把 `dist/sw.js` 的清单
    逐条对文件大小求和）：**当前配置（globPatterns 里并没有 mjs）是 89 项 / 20.7 MiB**，
    与 §2.4 记为「错误修法」的 88 项 / 20817.85 KiB 几乎一样 ——
    也就是说那 20MB **从来不是 mjs 造成的**，改用运行时 CacheFirst 并没有省掉它。
    真正的大头是**单个文件**：`ort/ort-wasm-simd-threaded.wasm` = **13.32 MiB**，
    由 globPatterns 里本来就有的 `**/*.wasm` 命中（这条不能删，
    `assets/sql-wasm-*.wasm` 要靠它才能离线导出 .apkg）。
    剔除 ort 后仍有约 7.4 MiB（index 2.45 / mermaid 0.62 / cytoscape 0.42 / katex 0.25 …），
    §2.4 的「约 1MB」同样对不上。
    **为什么没有顺手改掉**：`vite.config.ts` 里 `maximumFileSizeToCacheInBytes: 48MB`
    的注释明确写着「ffmpeg.wasm / onnxruntime 的 wasm 文件较大」——
    预缓存 ort 的 wasm 看起来是**有意为之**（离线转写要用），不是漏网。
   真要瘦身应改成 `globIgnores: ['**/ort/**']` + 对 `/ort/*.wasm` 走运行时 CacheFirst
   （与 pdf worker 同一套路），代价是「离线转写需要先在线用过一次」——
   这是产品取舍，不属于本次改动范围，记在这里以免下次又按 §2.4 的错归因去「优化」。

14. **`e2e-materials` 在 preview 档（真 dist）下 29 条里红 4 条，而 dev 档 29 条全绿 ——
   不是回归，是「生产构建被文件审批拦住」这个缺口的第一个可观测症状**
   （对应 §8「走构建产物」那句）。

   症状：`node scripts/e2e-all.mjs --only=e2e-materials`（preview 档）
   **25 ✅ / 4 ❌**，红的 4 条集中在 §12.11 那条修复所覆盖的两节：

   | 节 | 断言 | 结果 |
   |---|---|---|
   | 7. Word | `sample.docx` 库行标「已解析 10 段」 | ❌ 等 40s 超时 |
   | 7. Word | docx-preview 渲染 / 段数不变式 / 划词 / 引用条 / 跳第 5 段 | ✅ 全过 |
   | 9. 空文档 | 库行标「无正文·不可检索」 | ❌ |
   | 9. 空文档 | `material-empty-hint` 出现 | ❌ |
   | 9. 空文档 | 问答面板按「没有正文」解释 | ❌ 实际文案是「没有文本层（扫描件）…」 |

   注意 Word 一节**只有标签那条红**：渲染、`DOM 段数 === 数据侧 unit 数`、划词、
   引用条、跳段全绿 —— 因为那些都不依赖标签。**别看到「Word 一节有红」就以为 Word 坏了。**

   根因不是代码，是**产物停在修复之前**：`dist/assets/*.js` 全是 **23:54:36** 构建的，
   而功能提交在 **00:53**。从产物里直接挖出证据 —— dist 的库页判定是：

   ```js
   b = h ? t.scanned===1 ? {text:"扫描件·不可检索"}
         : t.unitCount ? {text:`已解析 ${t.unitCount} ${g}`} : {text:"待解析"} : …
   ```

   **既没有格式门禁（`format === 'pdf'`）、也没有 `empty` 分支** ——
   逐串检索也印证：`扫描件·不可检索` / `没有文本层（扫描件）` / `material-scan-hint` 都在，
   `无正文` / `material-empty-hint` **一条都没有**。
   也就是说这份 dist 就是 §12.11 修掉的那一版：Word 的 `scanned` 照旧被写成 1，
   于是段均 25 字的 `sample.docx` 在库页显示「扫描件·不可检索」而不是「已解析 10 段」，
   空 docx 同理。4 条失败逐条都能由它解释，**PDF 路径不受影响所以前 6 节全绿**。

   **为什么此前一直没暴露**：§8 的验收一直是跑在 vite dev（4173）上，而 dev 直接编译源码，
   永远是最新的 —— 所以「dev 全绿」对构建产物形态**零信息量**。
   §12.11 里那句「`e2e-materials` 的 Word 一节也覆盖了这条」同样是 dev 档的结论。

   意义有两层：一是 dev 档全绿**不等于**产物可用，二是 `e2e-materials` 一旦按 §8 的写法
   走 preview 档并登记进 `e2e-all`，它就成了这个缺口的哨兵 —— 构建卡住时它会红，
   而不是像之前那样在 dev 上一直绿着。

   待办：放行宿主对 `node_modules/@mdui/jq/functions/param.js` 的读取审批后
   `npm run build`，再跑 `node scripts/e2e-all.mjs --only=e2e-materials`。
   在此之前，preview 档的 `e2e-materials` 红 4 条是**预期状态**，不要当成回归去改代码。

   附：失败构建会在 `dist/` 留下半成品，但这次没有损坏产物 ——
   校验了 `dist/sw.js` 的 89 条预缓存清单，**磁盘缺失 0 条**（`dist/assets` 未被覆盖，
   清单里的文件名与磁盘一致，因为自上次成功构建以来 `src/` 没有改动）。
   也就是说 preview 档的其它脚本仍跑在一致产物上，可以正常参考。

   附二：**同一个根因还有第二种症状 —— 无限挂起，不是报错。**
   `probe-pdf-fixture` 第 4 行 `await import('pdfjs-dist/legacy/build/pdf.mjs')`，
   而这个文件与 `@mdui/jq/functions/param.js` 一样被审批拦着。
   在**非交互**子进程里没人应答审批，于是它不抛错、不退出，就是一直等着：
   实测直接跑 20s **零输出、进程仍活着**；放进编排器就是白烧满 120s 超时再报红。
   这种红与「探针真查出问题」完全无法区分，会把人训练成忽略红色，
   所以 `META` 里给它加了 `skip` 并写明原因（**审批放行后要记得去掉**）。
   两种症状对照着看很有教育意义：**同一个「读不到文件」，在同步的构建里表现为报错，
   在异步的 import 里表现为静默挂起。**

15. **选区提问浮层的滚动处理被修正**（2026-09-18，详见
   `docs/plans/2026-09-18-selection-ask-scroll-design.md`）。

   本文档 §5.2 写的「滚动后锚点失效 → 直接收起（选区本身还在，重选成本很低）」
   **只在鼠标端成立，触摸端是错的**：浮层只在 `selectionchange` 时重算，而滚动之后
   不会再有该事件（选区没变），于是浮层**永久消失**。iOS 长按划词本身就会带动滚动，
   连「重新划一次」这个退路也被堵死 —— 用户看到的就是「只有第一页能划词」
   （第 1 页在容器顶部，无处可滚，压根不产生 `scroll` 事件）。
   现已改为「滚动中收起 + 停止后重算」，`readSelection()` 每次重取
   `getBoundingClientRect()`，位置天然跟着更新。

   ⚠️ **§8 的 e2e 契约表当时漏了这一类**：划词用例只测第 1 页，而且用 Selection API
   模拟选区、**本身不产生任何滚动** —— 所以这个 bug 从一期上线起就不可能被那套用例发现。
   现在补了三条（第 2 页划词 / 滚动后浮层跟随重算 / 框选浮层滚动后收起）。

   顺带订正 §12.14 一条：**审批拦的不止 `@mdui/jq/functions/param.js`**，
   `pdfjs-dist/build/pdf.mjs` 同样会被拦。`npm run build` 连试三次 ——
   前两次报 `pdf.mjs`、第三次报 `param.js`。
   **rollup 撞到第一个未授权的文件就中止，所以报错文件会随构建顺序变化，
   别以为换了文件名就是换了问题。**
