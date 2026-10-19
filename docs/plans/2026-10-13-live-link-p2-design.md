# 实时链路 P2（来宾交互写回）设计

日期：2026-10-13
状态：已确认，待实现
前置：`docs/plans/2026-10-09-live-link-design.md`（P1，已实现并部署）。本文件**修订**其中三处，并定义 P2 范围。

## 背景与目标

P1 已交付并部署：host 浏览器作为数据源，经 Cloudflare Worker+DO 中继，向 guest（其他设备浏览器）实时提供索引 / 封面 / 字幕 / 视频流。**guest 只读**——看得到、听得到、拖得动进度条，但它的操作一律留在本机。

P2 要补上「交互」：来宾在 iPad 上做的动作（提问、制卡审核、播放进度、学习时长）落到**主机的库**里，于是 Mac 上打开应用看到的和来宾那边一致。

**修订 P1 设计的三处**（理由见下）：

1. **问答在主机跑**（P1 原文：来宾本地 BM25 + 来宾自己的 Key）
2. **凭据不过链路的不变量**从「Key 不参与问答」收紧为「Key 永不出主机浏览器」——主机用自己的 Key 发起调用，Key 本身一个字节都不上线（原文的不变量按字面仍成立，但表述必须改，否则下一个人会以为 QA 需要来宾也配 Key）
3. **op 集**从 P1 设计的四张表修订为：进度 / 学习时长 / 制卡审核 / 停止生成；**问答不再走 op**（主机直接落库，比走 op 更少一层）

**非目标**：

- **不做课程助手（跨课程问答）上链路**。它有两张**阻塞式**卡片（`ask_user` 等用户点选、工具 promise 挂起等 resolve），要把「主机阻塞等来宾点选」这条反向通道也做出来，P2 收益不抵复杂度。单课程问答（与播放页问答面板同构）才上链路。
- 不做划词/框选提问、不做截图提问上链路（P1 的 guest 镜像页没有选区与截图入口）
- 不做视频上传到 guest（guest 只看不存，不变量 9 不变）
- 不做 guest 端离线攒着「待发的提问」（离线时该明确提示「主机不在线」，不是排队）

## 不变量

1. **凭据永不上线**。host 端 `qaRunner` 用 `getSettings()` 里的 Key 调模型 API；Key、`providers` 表、`bilibiliCookie` 一律不进任何链路帧（沿用 P1 的字段白名单机制，见 `src/livelink/host.ts` 文件头）
2. **host 是唯一权威**。所有写 op 在 host 侧单队列串行应用；每条带 `clientOpId`，重复到达直接回 ack 不重放
3. **不幂等的写必须去重**：`study.add` 是累加语义（`src/store/studyTime.ts` 的 `flush()` 做 `seconds += delta`），重放必然双倍——去重表是这条 op 的**准入条件**，不是优化
4. **断链不丢写**：guest 侧未 ack 的 op 进 localStorage outbox，重连按序补发
5. **卡不阻塞**：题卡/图卡随流推送但不等用户（只有课程助手的 ask/folderPlan 才阻塞，那不在 P2）
6. **版本不匹配必须显式失败**。P1→P2 增加了新帧类型，老 guest 会**静默丢弃**它不认识的帧（`decodeFrame` 版本不符返 null），表现为「点了没反应」。因此 bump `PROTOCOL_VERSION`，并在 `hello`/`welcome` 握手里带版本，不匹配直接给用户一句明说
7. **多来宾隔离**：host 出向帧带 `to`（目标 guest 的 hello id）或 `'*'`；guest 只认发给自己的帧——两台设备同时连着时不能互相看见对方的问答流

## 设计

### 3.1 协议增量（`src/livelink/protocol.ts`）

`PROTOCOL_VERSION` 1 → 2。新增帧类型（`Frame` 是开放信封，无需改类型定义）：

| 帧 | 方向 | 载荷 | 说明 |
|---|---|---|---|
| `op` | guest→host | `{ opId: clientOpId, op: 'position.set'\|'study.add'\|'card.decide'\|'chat.stop', ...args }` | 写操作 |
| `ack` | host→guest | `{ opId, ok: 1\|0, reason?, rowId? }` | 幂等回执 |
| `chat.req` | guest→host | `{ to, turnId, videoId, text, images? }` | 提问 |
| `chat.ev` | host→guest | `{ to, turnId, kind: 'reasoning'\|'delta'\|'round'\|'tool'\|'stop', text?, round? }` | 流事件（对应 `AgentCallbacks` 七个回调） |
| `chat.card` | host→guest | `{ to, turnId, kind: 'quiz'\|'widget', payload }` | 题卡 / 图卡（工具回执旁路，见 §3.3） |
| `chat.done` | host→guest | `{ to, turnId, content, reasoning?, reasoningMs?, quiz?, widget? }` | 一轮结束 |
| `chat.err` | host→guest | `{ to, turnId, message }` | 失败（网络/模型/护栏），也要能落库成一条 assistant |
| `version.err` | host→guest | `{ host: 2, you: 1 }` | 版本不匹配，来宾据此显示明确错误 |

`welcome` 帧补 `hostVersion` 字段；guest 侧握手失败不再显示「主机已离线」这种误导文案。

### 3.2 host 侧（`src/livelink/ops.ts` 新增 + `host.ts` 接线）

**op 串行队列**：`src/livelink/ops.ts` 导出一个 `OpQueue`，单链串行（与 `studyTime.ts` 的 `flushChain` 同构——那是被实战验证过的写法）。每个 op 的 apply 函数**与本地写库走同一个函数**（P1 设计 §3.3 的原话，继续遵守）：`applyPosition` / `applyStudyAdd` / `applyCardDecide` 三个纯函数，被玩家面板、来宾 op、迁移包共用同一实现。

| op | apply | 幂等 |
|---|---|---|
| `position.set` | `{videoId, position, finished}` → `db.videos.update`（赋值） | 天然幂等 |
| `study.add` | `{date, seconds}` → **先查去重表**（`Set<clientOpId>`，LRU 上限 512）→ 未见过才累加 | 靠去重表 |
| `card.decide` | `{videoId, cardId, status}` → 校验 `cardId` 存在；不存在回 `ack ok:0 reason:'gone'`（重新生成换过 id），**不重试** | 赋值幂等 |
| `chat.stop` | `{turnId}` → abort 该轮的 `AbortController` | 幂等（abort 两次无副作用） |

去重表的边界要写进注释：**只在内存**（宿主重启即失忆）。残余风险是「host 重启 + guest 恰好重放一条未 ack 的 study.add」会双倍累加一次；真实概率低（两者要同时在线才可能发生），且代价是几分钟时长。要更严就得把去重表持久化——按 YAGNI 先不做，但把这条风险写进注释，下一个人需要时知道从哪接。

**节流**：进度 op 由 guest 侧节流（播放中每 5s 一条 + pause/stop 时补一条）。host 侧不再节流——它只管串行应用。

### 3.3 问答：主机跑 agent loop（`src/harness/qaRunner.ts` 新增）

**从 `ChatPanel.tsx` 的 `send()` 里抽出 `qaRunner`**，ChatPanel 与链路 host 共用同一个实现：

```
qaRunner.run({ videoId, sessionId, text, images?, refsText?, skillIds? }, sink) → { rowId, content, ... }
  sink: { onReasoning, onDelta, onRoundStart, onToolStart, onToolEnd, onStop, onCard, signal }
```

抽而不是复制，理由是仓库自己的规矩（「两套并存必然漂移，而漂移的表现是数据静默错乱」）：问答链路上有系统提示词、检索工具、技能白名单三处必须同步的地方，复制一份等于给「提示词改了、host 那份没改」埋雷。风险是动到播放页问答面板（P1 的 QA 主路径），由既有 e2e 守。

`qaRunner` 内部按现有接线照搬，不改语义：历史从 `db.chats` 取并 `fitHistoryToBudget`；工具白名单按材料/抽帧/md 三个开关组装（`QA_TOOLS` / `MATERIAL_QA_TOOLS` / `+LIST_FRAMES_TOOL`）；用户消息先落库再进循环；助手消息循环结束后落库（带 `reasoning`/`reasoningMs`/`quiz`/`widget`）；abort 时保留已流出内容并追加 `_（已停止生成）_` 后照常落库。

**已知的不一致照实搬，不顺手修**：单课程面板构造 executor 时没传 `allowedSkillIds`（只有课程助手传了），即「技能白名单只作用于提示词、不作用于工具执行」。qaRunner 沿用面板的行为（传 `allowedSkillIds`，让 host 侧与面板一致）还是照搬漏洞？我选**补上**——qaRunner 是新函数，让它把 `skillIds` 一路传到 `createToolExecutor`，面板改为调用 qaRunner 后两边同时变正确。这是「新建函数时把漏洞留在原地」还是「顺手修正」的问题，选后者并在提交里写明。

**卡片旁路**：`onQuiz` / `onWidget` 是 `createToolExecutor` 的闭包回调，不在流里——qaRunner 把它们转成 `chat.card` 帧推给 guest，guest 用现成的 `QuizCard` / `WidgetBlock` 渲染（`src/components/` 里已有，来宾页直接 import 复用）。`ask` / `folderPlan` 两张阻塞卡 P2 不做（§非目标）。

**落库只在主机**：来宾提问 → 主机 `db.chats` 落 user + assistant 两行 → 流式推给来宾渲染。来宾侧按不变量 9 只进内存镜像（不写自己的 IndexedDB）。

### 3.4 guest 侧（`src/livelink/outbox.ts` 新增 + `guest.ts` 接线 + 镜像页）

**outbox**（`src/livelink/outbox.ts`，零依赖纯函数 + Node 可测）：

```
enqueue(op)            // 入 localStorage（key: wangke-livelink-outbox），带 clientOpId
flush(send, acked)     // 按入队序逐条发送；收到 ack 后移除
pendingCount()
```

每条记录 `{ clientOpId, op, args, enqueuedAt }`。重连（`host-link-up` 或离线轮询恢复）后自动 flush。**进度 op 不进 outbox**：它在下一条到达时覆盖前一条即可，为它攒队列只会让「停止 5 秒后关页面」丢失最后一条进度——改为 guest 内存里保留一条 pending position，`pagehide` 时尽力发一次。

**来宾镜像页**（`src/pages/LiveGuest.tsx` 扩）：

- **问答面板**：复用 `ChatPanel` 的渲染件（`XMarkdown` + `linkifyTimestamps` + `SeekLink` + `ReasoningChain` + `ThinkLine` + `QuizCard` + `WidgetBlock`），新写一个精简壳 `LiveChatPanel.tsx`——不复制 ChatPanel 的发送逻辑，只消费流事件
- **引用可点**：来宾页有播放器，`#seek-` 链接跳得来宾自己的播放器（数据本来就在来宾这边流着）
- **制卡审核**：`SwipeDeck` 直接复用，来宾左滑丢弃/右滑保留 → `card.decide` op；候选卡列表随 `unit.req video:<id>:cards` 拿（P1 未实现该单元，P2 补）
- **进度/时长自动**：`position.set` 由播放器事件驱动（节流 5s）；`study.add` 由来宾页的可见性 + 活动事件驱动，口径与主机一致（`studyLog.ts` 的 `shouldCount` 同一套纯函数复用）

### 3.5 验证

- **单测**（纯 Node）：outbox 的入队/去重/按序补发/落盘恢复；op 的三个 apply 函数（幂等性、`study.add` 去重、`card.decide` 的 gone 分支）；`qaRunner` 的消息组装（用假模型，断言「每轮请求合法」——沿用 `test-agent-loop.mjs` 的假网关写法）
- **e2e**（`e2e-livelink.mjs` 扩一组 P2 用例）：stub 中继 + 两个 context，验证 ① op 往返后 host 的 DexDB 里真落库 ② 断链时 op 进 outbox、重连后补发且**不重复**（`study.add` 连发三次只累加一次）③ 问答流：guest 提问 → 桩网关返回固定流 → guest 收到 delta 并渲染，host 库里 chats 两行 ④ guest 停生成 → host abort 并落库「已停止生成」
- **手动验收**：iPad 上真问一轮、真滑几张卡、真拖进度条，回来在 Mac 上看数据在不在

## 涉及文件

新增：`src/livelink/ops.ts`、`src/livelink/outbox.ts`、`src/harness/qaRunner.ts`、`src/components/LiveChatPanel.tsx`、`scripts/test-livelink-ops.mjs`、`scripts/test-livelink-outbox.mjs`
改动：`src/livelink/protocol.ts`（版本 + 帧类型）、`host.ts`（op 队列 + 问答接线）、`guest.ts`（op 发送 + 流事件路由 + ack 路由）、`payloads.ts`（cards 单元）、`src/components/ChatPanel.tsx`（改调 qaRunner）、`src/pages/LiveGuest.tsx`、`src/pages/Player.tsx`（写库走共享 apply 函数）、`src/store/studyTime.ts`（导出一个可被外部调用的累加入口）、`scripts/e2e-livelink.mjs`、`scripts/e2e-all.mjs`、README + 本文件变更记录

## 变更记录

- 2026-10-13：定稿。相对 P1 设计修订三处（问答执行位置、凭据不变量的表述、op 集），新增 host→guest 定向推送与版本握手，抽出 `qaRunner` 供面板与链路共用