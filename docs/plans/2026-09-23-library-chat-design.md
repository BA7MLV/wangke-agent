# 课程库问答（跨课程只读检索）设计

- 状态：**设计待评审**（未实现）
- 日期：2026-09-23
- ⚠️ **2026-09-24 前提变更**：稠密向量检索已整体移除（改词法 BM25，见 `2026-09-23-context-engineering-design.md` §9）。本文中所有关于「向量索引 / 全库向量扫描 / 分数可比性 / 建索引计费」的内容**已失效**，逐处标注；实测结论是**改动后这个功能反而更简单了** —— 词法检索不需要索引、不花 API 钱、也不存在索引过期。
- 需求：课程库加一个独立的 chat 栏，能跨课程检索全库字幕与阅读材料原文，回答里的引用可点回源到具体课程
- 已确认的两个方向：**只读原文**（不读讲义 / 卡片 / 评论 / 学习统计）；窄屏走**独立路由页面**

## 1. 背景与目标

播放页问答（`components/ChatPanel.tsx`）是**严格绑死单门课**的，绑定点有四：

| 位置 | 绑定方式 |
|---|---|
| `harness/tools.ts:219` | `createToolExecutor(courseId, opts)` —— 所有工具闭包在 `courseId` 上；`search_transcript` 走 `where('videoId')`，`search_material` 走 `where('materialId')` |
| `harness/search.ts` / `searchMaterial.ts` | 都是「先按外键取**本科全部**向量，再本地算余弦」，没有跨课入口 |
| `harness/prompts.ts:205/258` | `qaSystem` / `qaSystemMaterial` 把课程名写进系统提示词，引用规则写死 `[mm:ss]` / `[第N页]` |
| `utils/linkify.ts` | 产出 `#seek-秒` / `#unit-N`，靠 `ChatPanel` 里**唯一的** `playerRef` / `readerRef` 解析 —— 跨课时系统不知道是哪个课的 `03:25` |

所以「访问整个系统的数据」不是「有没有数据」的问题，是**取数范围**的问题：数据全在同一个 IndexedDB 里，缺的是不限课程的执行器与能回源的引用格式。

目标：课程库一个常驻 chat 栏，可以问「我这几门课里哪些讲到了 X」「X 这个概念在哪门课讲得更细」，回答带来源课程、点击跳到对应课程的对应位置。

**非目标（明确不做）：**

1. **不读生成物与统计**：讲义（`handouts`）、Anki 卡片（`cards`）、评论 / 弹幕、学习时长与观看进度都不进检索范围。这些不是语义检索能答好的，需要另一套「精确查询」工具；且「把三门课的讲义合成复习提纲」是**写作任务**（要读生成物 + 产文件），值得单开一份设计。
2. **不注册 `present_quiz`**。题卡的引用链路是播放页专属（`QuizCard` 的 `onSeek` → `playerRef`，见 `components/QuizCard.tsx:43`），跨课题卡里的 `[《课名》 mm:ss]` 会渲染成死链。要支持得先让 `QuizCard` 认第三套前缀，二期再说。
3. **不改播放页问答的任何既有行为**。零回归是硬指标，见不变量 1。
4. **不做云端 / 跨设备检索**。仍是本地库（云端同步是另一份设计，见 `2026-09-23-cloud-sync-design.md`）。
5. **不自动为课程建索引**。库级入口只检索**已建好**的向量；没建的课程在 `list_courses` 里标出来让用户回播放页处理，理由见不变量 4。

## 2. 不变量

1. **`createToolExecutor(courseId, opts)` 的签名与行为一格不改。** 跨课执行器（`createLibraryToolExecutor`）是**并列新增**。播放页那条路径已经过 `e2e-chat` / `e2e-chat-skill-scope` / `e2e-material-you` 三轮回归，为一个新功能去参数化它是本末倒置。
2. **回答里不允许出现裸 `[03:25]`。** 库级渲染只跑 `#goto-` 一套前缀，提示词里明确禁止裸时间戳 —— 裸时间戳在库级上下文里要么是死链，要么（若误跑 `linkifyTimestamps`）指向一个不存在的播放器。两端都要堵。
3. **不新增表、不改既有索引。** 会话归属靠保留值 + 非索引字段（§3.2）。改 `chatSessions.videoId` 的索引要升 v13 并重建索引，收益为零。
4. ~~**检索是只读的，且不隐式触发昂贵的写入。**~~ **（已失效，2026-09-24）** 词法检索不打 API、不建索引，这条约束自动消失。
5. ~~**全库向量扫描必须分批。**~~ **（已失效，2026-09-24）** 没有向量表了。词法扫描全库正文是纯内存操作，见 §3.3 的新内容。
6. **引用回源匹配不到课程名时，退化为纯文本，不生成链接。** 宁可不可点，不可点错课（§3.4）。
7. 单轮检索预算沿用 `settings.agentRounds`，与播放页一致。

## 3. 设计

### 3.1 检索层：三个新工具

新文件 `src/harness/libraryTools.ts`（与 `tools.ts` 平级）：

| 工具 | 参数 | 返回 |
|---|---|---|
| `list_courses` | 无 | 课程清单：名称 / 类型（视频 or 材料）/ 时长或页数 / **有无可检索正文**（有字幕或已解析出材料块）/ 上次看到哪 |
| `search_all` | `{ query, kinds?, courseIds?, topK? }` | 全库命中的片段，**每条前缀来源**：视频 `[《课名》 03:25]`，材料 `[《课名》 第3页]` |
| `get_source_range` | `{ courseId, from, to, unit: 'sec' \| 'page' \| 'para' }` | 指定范围原文。`unit` 决定走 `segments` 还是 `materialBlocks` |

`list_courses` 是**第一步必调**的工具（提示词里写死）：它既给模型课程清单（让它知道有哪些课、该不该限定 `courseIds`），也是**引用回源用的课程名→id 映射的来源**。没有它，模型会凭历史消息里的印象编课程名。

`search_all` 的 `courseIds` 是**可选收窄**，不传即全库。这一条对应播放页 `tools.ts:177` 的既有理念 —— 按实际能力给工具；这里是按实际意图给范围：用户问「这门课」时模型先 `list_courses` 再收窄，问「我所有课」时才全库。

**打分复用**（2026-09-24 更新）：`cosine` 已随稠密检索删除。现在三处共用的是 `harness/lexical.ts` 的 `lexicalSearch(docs, textOf, query, topK, opts)` —— 它已经是「算分 → 取 topK」的通用实现，`searchTranscript` / `searchMaterial` 都只是「取数 + 映射字段」的薄壳，`search_all` 照做即可。**不要另写一套打分**：BM25 的 `k1` / `b` / 覆盖率加成必须在三处一致，否则同一句话在不同入口的排序会不一样。

### 3.2 会话归属

不新增表。`ChatSessionRow` 加非索引字段 `scope?: 'course' | 'library'`（老数据 `undefined` 视同 `'course'`，沿用 `ChatRow.images` / `SegmentRow.cues` 的先例，**不需升版本**）：

```ts
/** 库级会话的保留 videoId。用保留值而不是把字段改可选：见下方理由 */
export const LIBRARY_SCOPE_ID = '__library__';
```

- `chatSessions.videoId` 与 `chats.videoId` 都写 `LIBRARY_SCOPE_ID`，保持「`ChatRow.videoId` 恒等于其 session 的 `videoId`」这条既有不变式（`ChatPanel` 落库时两处都写 `videoId`，见 `ChatPanel.tsx:693` / `:900`）。
- **为什么用保留值而不是新表**：`where('videoId').equals(LIBRARY_SCOPE_ID)` 天然走索引，O(1)；新表要多一套导出/导入/级联清理路径。
- **为什么不会撞车**：课程 id 是 `uuid()`（`Library.tsx:76`），不可能等于 `__library__`。
- **删除课程天然安全**：`Library.tsx` 的级联是 `equals(该课程 id)`，不会命中保留值。

**⚠️ 必须一并修的既有 bug**：`store/migration.ts:364` 与 `:375` 都有 `if (!newVideoIds.has(row.videoId)) continue`。库级会话的 `videoId` 不在 `videos` 表里，**导入时会被静默丢弃** —— 用户导一次数据，库级问答记录全没了，且没有任何提示。两处都要放行 `LIBRARY_SCOPE_ID`。这是本次改动里唯一会碰到迁移路径的地方。

### 3.3 全库扫描的内存与耗时（已按词法检索重写）

**原内容（向量版）已作废**：它讨论的是「分批扫全库向量、只留 topK」，前提是每行 4KB 的 `ArrayBuffer`。向量表已被 `version(13)` 删除。

现在要做的是对**正文**做词法扫描（`harness/lexical.ts` 的 `lexicalSearch`）。量级完全不同：

- 30 门课约 100 万字，单次查询是「扫一遍正文 + 用查询词算分」。查询只有 2~6 个词项，第二遍只统计这些词项的出现次数，**不遍历全部词项**。
- 所以耗时是**几十毫秒量级**、峰值内存是「正文本身」（本来就在 IndexedDB 里按需读，不进常驻内存）。
- 仍然要避免一次性把全库正文 `toArray()` 拉进内存 —— 但理由从「向量太大」变成「正文加起来也有几十 MB」，做法同样是**按课程分批**：先取课程列表，逐门课取该课的段/块并累积 topK。

**一个必须注意的差异**：词法的分数是**词项无关的可加量**吗 —— 不是。BM25 的 idf 依赖 **df**，而 df 是「候选集合里有多少篇文档含该词」。所以：
- 逐门课分别算分再合并，与「把全库当一个集合算分」得到的**分数不可比**（df 不同、avgdl 不同）。
- 结论：**要么把全库装进一个候选集算**（推荐，词法扫描扛得住），**要么就不要跨课比较分数**、只做「每门课取自己的 topK 再交给模型」。不要混着来 —— 那会让排序看起来有道理但实际是乱的。
- 这条与 §4.2 的课程目录层是同一件事的两面：目录层先把候选缩到 1~3 门课，df 的计算范围随之变成「候选课内部」，跨课比较的问题自然消失。

### 3.4 引用回源（最大改造点）

`utils/linkify.ts` 加第三套前缀，与 `#seek-`（跳播放器时间）、`#unit-`（滚材料单元）并列：

```ts
export const GOTO_LINK_PREFIX = '#goto-';

/** [《课程名》 03:25] / [《课程名》 第3页] → 反查课程 id 后变成 #goto-<id>-<sec|unit-N> 链接 */
export function linkifyCourseRefs(text: string, courses: { id: string; name: string }[]): string
```

正则形如 `/\[《([^》]{1,40})》\s*(\d{1,3}:\d{2}(?::\d{2})?|第\s*\d+\s*[页段])\]/g`，匹配后用**课程名反查 id**（去空白 + 精确匹配，匹配不到 → 保留原文、不生成链接）。这样模型抄错课程名时最坏结果是不可点，而不是跳到错的课 —— 这就是不变量 6。

同时库级渲染**只跑这一个函数**，不跑 `linkifyTimestamps` / `linkifyFrames` / `linkifyUnits`：那三个都假设「当前只有一门课、只有一个播放器」。这与 `linkify.ts:87` 里材料模式「只跑 `linkifyUnits`、不跑 `linkifyTimestamps`」是同一条理由，只是这次的理由从「没有播放器」换成了「有多个播放器，不知道是哪个」。

**点击行为需要播放页配合**：`Player.tsx` 目前只有 `useParams` 取 `:id`（`Player.tsx:86`），**没有任何 URL 入参定位**。所以 `#goto-` 点击后只能跳到该课的开头或断点续播位置 —— 引用「可点但不能定位」等于没做成。要给 `Player.tsx` 加入参支持：

- 视频：`/player/<id>?t=<秒>`。与断点续播的优先级要写清楚：入参存在时**覆盖** `resumeStorage.getTime()` 的返回值（`Player.tsx:206` 的 `row.lastPosition ?? null`）。注意别落到 `Player.tsx:200` 那个「读进度失败 → 归零」的分支里，那条会把用户的真实进度清零。
- 材料：`/player/<id>?unit=<N>`，覆盖 `lastUnit`。

两者都要**消费后从 URL 里清掉参数**（`replace` 而非 `push`），否则刷新会一直回到那个位置、且后退键行为会很怪。

### 3.5 提示词

`PROMPTS.qaSystemLibrary(courseCount, skillMetaList?)`，骨架照 `qaSystem`，差异是四条硬规则：

1. **第一步必须 `list_courses`**，之后再决定检索范围。用户说「这门课 / 那节课」而清单里有多门时，先问清是哪一门 —— 不许猜。
2. **引用只能写 `[《课程名》 mm:ss]`（视频）或 `[《课程名》 第N页]`（材料）**，课程名与位置都必须从工具返回结果里原样复制。**禁止裸 `[mm:ss]`**。
3. **反串课（本功能最大的质量风险）**：多门课讲同一个概念时，模型很容易把 A 课的说法安到 B 课上。规则要写死：一条结论只归给它实际来源的那一门课；跨课归纳时必须逐条标来源；某概念只有一门课讲到时，明确说出是哪一门。
4. 检索预算与播放页一致（1~3 次检索，禁止连续多轮只检索不作答）。

`DIAGRAM_RULE` 直接复用 —— 库级回答同样需要 mermaid / svg，且这条规则本来就与课程无关。

### 3.6 形态与路由

| 断点 | 形态 | 入口 |
|---|---|---|
| 桌面宽屏 | 课程库页**右侧常驻栏**（可折叠，宽度走 CSS 变量） | 顶栏一个按钮 |
| 窄屏 / 手机 | **独立路由 `/assistant`**，整屏对话 | 课程库顶栏同一个按钮，改为 `navigate('/assistant')` |

- `App.tsx` 加 `<Route path="/assistant" element={<Assistant />} />`。
- `/assistant` 的导航高亮值用 `'home'`（`useAppNav('home')`）—— 与 `Player.tsx` 把播放页当作课程库下级页是同一条先例（`components/appNav.tsx` 顶部注释写了）。**不动 `appNav.tsx` 的三个条目**：加第四项会改导航契约并波及 `e2e-rail-pages` / `e2e-mobile` 那批选择器。
- `Library.tsx` 的桌面右栏：`PageShell` 目前是 `wide` 单列，要在内容区外面套一层两列 grid。窄屏下右栏 `display: none`，**DOM 保活**（与播放页五个面板 `hidden` 保活同一手法）—— 否则切一次断点对话就重置了。

### 3.7 复用边界：新写 `AssistantChat`，不改造 `ChatPanel`

`ChatPanel` 是 1290 行、深度绑定 `videoId`（`chatSessions` 查询、索引就绪检查、`createToolExecutor`、截图 / 划词 / 题卡 / 技能范围全挂在这个 id 上）。给它加一个 `courseId = null` 的模式，等于让播放页那条已回归的路径承担新分支 —— 与不变量 1 直接冲突。

所以**新写 `src/components/AssistantChat.tsx`**，只复用真正无状态的那几块：

| 复用 | 不复用（自带一份精简实现或直接不要） |
|---|---|
| `runAgentLoop`（`harness/agent.ts`） | `ChatPanel` 整体 |
| `Panel` / `PanelBar` / `PanelBody` / `PanelPlaceholder`（`ui/panel.tsx`） | 截图追问（`media/snapshot`）、划词引用（`store/selectionAsk`） |
| `XMarkdown` + `mermaid/markdown.tsx` 的渲染件 | 题卡（`QuizCard`）—— 见非目标 2 |
| `ModelPicker` / `SkillPicker` | `#seek-` / `#unit-` / `#frame-` 三套链接的渲染 |
| `loadSessionSkillMeta` / `skillMetaBlock`（`skills/store.ts`） | — |
| `buildSessionMarkdown` / `exportFileName`（`utils/chatExport.ts`） | — |
| `fitHistoryToBudget`（`harness/context.ts`） | — |

功能范围（第一版）：会话列表（新建 / 切换 / 删除）· 消息流 · 思考过程折叠 · 模型选择 · 技能范围 · 检索进度提示 · **引用点击回源** · 导出 Markdown。

这是一次**有意的代码重复**：多出一个约 400 行的组件，换来播放页问答零回归。与 `2026-09-22-comments-design.md` 里「`withRetry` / `pool` 那两份纯函数拷贝刻意不动，收益不抵风险」是同一条取舍。

## 4. 涉及文件

- `src/harness/libraryTools.ts`：**新增**。`LIBRARY_TOOLS` 工具定义 + `createLibraryToolExecutor()`
- `src/harness/search.ts`：抽出共用的「批量算分取 topK」；`searchTranscript` 改为调它（行为不变）
- `src/harness/searchMaterial.ts`：同上
- `src/harness/searchAll.ts`：**新增**。全库分批扫描（不变量 5 的落点）
- `src/harness/prompts.ts`：新增 `PROMPTS.qaSystemLibrary`
- `src/utils/linkify.ts`：新增 `GOTO_LINK_PREFIX` + `linkifyCourseRefs`
- `src/store/db.ts`：`ChatSessionRow.scope?` + `LIBRARY_SCOPE_ID` 常量 + 注释
- `src/store/migration.ts`：**修 bug** —— `:364` 与 `:375` 放行 `LIBRARY_SCOPE_ID`（§3.2）
- `src/components/AssistantChat.tsx` + `assistant-chat.css`：**新增**
- `src/pages/Assistant.tsx`：**新增**。窄屏整页，复用 `PageShell fill`
- `src/pages/Library.tsx`：桌面右栏 + 顶栏入口按钮
- `src/pages/Player.tsx`：新增 `?t=` / `?unit=` 入参定位 + 消费后清参（§3.4）
- `src/App.tsx`：`/assistant` 路由
- `src/theme.css`：右栏两列 grid 与折叠态两条
- `scripts/test-library-tools.mjs`：**新增**。纯 Node 单测（见 §5）
- `scripts/e2e-assistant.mjs` + `scripts/e2e-all.mjs`：**新增**并登记 `META`
- `README.md`：功能一览 / 实现细节 / 测试命令 / 已知限制

## 5. 验证

| 层 | 测什么 |
|---|---|
| `node scripts/test-library-tools.mjs`（纯 Node） | `linkifyCourseRefs`：正常匹配 / 课程名含空格 / 课程名含 `》` 截断 / **匹配不到课程名时不产链接**（不变量 6）/ 代码围栏内不替换 / 材料与视频两种位置格式；`list_courses` 输出渲染；`search_all` 结果的来源前缀格式；会话保留值不进课程清单 |
| `node scripts/e2e-assistant.mjs`（preview，自播种两门课） | 窄屏 `/assistant` 可进入且整屏；桌面右栏出现 / 折叠 / 窄屏隐藏但 DOM 保活；发一轮问 → 消息落库到 `__library__` 会话；**点引用后 URL 到 `/player/<id>` 且 `video.currentTime` 真的到位**；**裸 `[03:25]` 渲染成纯文本而非死链**；会话列表新建 / 切换 / 删除；导出 Markdown |
| `node scripts/e2e-chat.mjs` + `e2e-chat-skill-scope` + `e2e-material-you` | **回归**：播放页问答与改动前一致（不变量 1） |
| `node scripts/test-migration.mjs` | **回归**：库级会话能导出并导入回来（§3.2 的 bug 修完必须有用例守住） |
| `npm run build`（含 `tsc -b`） | 类型与产物 |

`e2e-assistant` 刻意自播种、不调 API，与 `e2e-comments` 同一条原则：回答质量是模型的事，这一层守的是「数据 → 渲染 → 跳转」这段我们自己的代码。

## 6. 待确认 / 风险

1. ~~**字幕向量与材料向量的分数可比性**~~ → **已改为 df 范围问题**（§3.3，2026-09-24）。BM25 的分数依赖候选集合内的 df 与 avgdl，所以「逐门课分别算分再合并」与「全库一个集合算分」的分数不可比。要么全库一起算，要么各课各取 topK 不跨课比分数。
2. **全库扫描耗时**。目标万段 < 1.5s。超了要先看是 IndexedDB 分批读慢还是余弦慢，再决定降维 / 粗筛 / Web Worker。
3. **`?t=` 与断点续播的交互**（§3.4）。入参覆盖 `getTime()` 是明确的，但需实测确认不会触发 `Player.tsx:200` 的「清零进度」分支。
4. **课程库右栏与 `PageShell wide` 的宽度预算**。要实测窄屏临界点（哪一档开始必须收右栏），不能凭感觉定断点。
5. **`get_source_range` 的 `unit` 由谁决定**。倾向由模型按 `search_all` 返回的位置格式自动选（`03:25` → `sec`，`第3页` → `page`），但要防它选错；保底是在工具里按课程 `kind` 校验，不匹配就返回错误提示而不是硬查。

## 7. 变更记录

- 2026-09-23 首版：跨课程只读检索 + 课程库独立问答。已确认两条路线：范围选「只读原文」（不读生成物与统计），窄屏形态选「独立路由页面」。
- 2026-09-23 设计期发现 1：`migration.ts:364/375` 会静默丢弃 `videoId` 不在课程表里的会话行 —— 库级会话必须放行，否则跨设备迁移后问答记录全丢且无提示。本次一并修。
- 2026-09-23 设计期发现 2：`Player.tsx` 只有 `useParams` 取 `:id`，无任何 URL 定位入参。引用回源要真的「跳到位」必须给播放页加 `?t=` / `?unit=`，这是本方案的前置依赖。
- 2026-09-23 决策：**不复用 `ChatPanel`、新写 `AssistantChat`**。理由是播放页问答已过三轮 e2e 回归，参数化它的风险高于多写一个组件的成本（同 §3.7）。
- 2026-09-23 决策：第一版**不注册 `present_quiz`**。题卡引用链路（`QuizCard.onSeek` → `playerRef`）是播放页专属，跨课题卡要另外改造，列二期。
