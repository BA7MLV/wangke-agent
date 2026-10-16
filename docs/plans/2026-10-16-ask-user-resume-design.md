# 提问卡：断点续跑（挂起点落库）+ 卡片 UI/UX

- 状态：**已实现**
- 日期：2026-10-16
- 前置：`2026-09-28-course-chat-generative-ui-design.md`（提问卡与方案卡的初版）

## 1. 问题

`ask_user` / `propose_folder_plan` 是**阻塞式**工具：executor `await` 一个由 UI resolve 的
promise，用户点完才把结果喂回 agent 循环。这个阻塞**只活在内存里**：

- 未作答的卡片**根本没落库**。`patchAi({ask})` 只改内存，卡片要等 `rotateAi`（用户作答那一刻）
  才写 `db.chats`。所以刷新后不是「一张点不动的死卡」，而是**整张卡连题目一起消失**，
  只剩用户那句提问。
- 循环攒在 `out` 里的中间消息（assistant `tool_calls` + 各轮工具结果）也从不落库，
  只有最终正文与 user 消息进库。刷新 = 这轮跑过的检索全部作废。

旧设计文档 §6.4 说刷新后卡片退化成只读死卡 —— 与代码不符，本文一并更正。

## 2. 决策：语义上阻塞，实现上「挂起 + 恢复」

业界（OpenAI Assistants 的 `requires_action`、MCP 的 `elicitation`、LangGraph 的
`interrupt()` + checkpoint）一致的做法是：**这一轮阻塞**（模型不能绕过用户回答继续编），
但把**挂起点持久化**，进程重启后能恢复。差别只在「挂起」是内存态还是可落库。

我们取可落库：刷新后卡片重新可答，答题后循环**从断点续跑**，已跑过的工具不重跑。

## 3. 要活过刷新的三样东西

1. **题目**：卡本身（`ChatRow.ask` / `folderPlan`）。
2. **回合内已累积的 `out`**：模型这轮的 assistant `tool_calls` + 此前各轮的工具结果。
   有了它，续跑**一次旧工具都不重跑** —— 结果本来就在里面。
3. **「这轮挂起中」的标记**：告诉加载逻辑这张卡是活的、可续跑。

## 4. 落库位置

`ChatRow` 新增非索引字段（沿用 `ask` / `folderPlan` 的先例，**不升 DB 版本**）：

```ts
resume?: {
  toolName: 'ask_user' | 'propose_folder_plan';
  toolCallId: string;
  midTurn: ChatMessage[];   // out 去掉 system+history 之后的部分（含此前所有工具结果）
};
```

选行内字段而不是新表：这行只在 `loadSession` 单会话读，不像 `videos` 那样整表扫
（与 `covers` 拆表同一条理由的反面）。回合正常结束就删掉 `resume`。

**挂起时就把助手消息落库**（而不是等作答）：这样题目进历史、刷新可见；作答时改用它
（`update`）而不是新写一行。`rotateAi` 因此要按「这条消息有没有 `rowId`」分流 add/update。

## 5. 数据流

### 5.1 挂起（`send` 里）

- `runAgentLoop` 新增可选回调 `onCheckpoint?(out)`，在每次 `executeTool` **之前** fire
  （`harness/agent.ts`）。播放页 `ChatPanel` 不传它 → 零回归。
- store 在回调里存下 `out`；`holdAsk` / `holdPlan` 触发时算出 `midTurn = out.slice(baseLen)`，
  在**设置 `pendingAsk` 之前**把卡片行 + `resume` 落库（`suspendWrite` 的 promise 由 resolve 等待，
  避免「写还没落、用户已经点了」的竞态）。

### 5.2 恢复（`loadSession` 里）

读到末条助手行带 `resume` 且未作答 → 把 `pendingAsk` / `pendingPlan` 重新装上：

```ts
{ messageKey: `stored-${row.id}`, restored: true, resume: {…}, resolve: (picked) => resumeSuspendedTurn(…) }
```

`restored` 只用于 UI（显示「会话已恢复」）。**它没有内存 promise** —— `resolve` 走续跑。

### 5.3 续跑（复用 `send`）

`send` 增加第 4 个可选参数 `resume`。带上它时：

- 不懒创建会话、不写「新一轮」的用户消息（答案行由 `answerAsk` 决定，方案确认不写）；
- `base` = system + 该会话历史**切到卡片行之前**（不含卡片行，避免与 `midTurn` 重复）；
- `out` = `[system, ...base, ...midTurn, { role:'tool', tool_call_id, content: toolResult }]`；
- 开跑前把卡片行改掉：删 `resume`、写 `ask.picked` / `folderPlan.applied`。

`answerAsk` / `confirmPlan` / `cancelPlan` 按「有没有 `pendingAsk.resume`」分流：

- 活着的循环（正常路径）→ 走原逻辑（写答案行 + resolve 内存 promise）；
- 恢复态 → 装载 `resume` 请求后交给 `send`。

## 6. 边界

- **非阻塞回合的残留 checkpoint**（崩在普通回合中途）：不自动续跑。加载时若末条
  `resume` 对应的卡已作答或不是阻塞工具，直接丢弃 `resume`。旧数据没有 `resume` → 保持
  「死卡 / 无卡」降级，零迁移。
- **护栏状态不续**：`ledger` / `toolTokens` 在续跑时重置。已知取舍：极端情况下同一次
  重复调用能多溜一轮，token 闸下一轮即重新兜住。
- **设置漂移**：续跑用**当前**模型/服务商，与挂起时可能不同。可接受。
- **`releasePending` 不再 resolve 恢复态的卡**：否则会把「（用户已离开该会话）」当成用户
  的选择喂给续跑。恢复态只清引用。

## 7. UI / UX

| 项 | 做法 |
|---|---|
| 卡内联作答 | 「我自己说」在卡内展开输入框，回车即答（不再把视线甩到下面的输入框；收起那条隐式路径保留为兜底） |
| 数字键快选 | 选项前缀 1–5 序号，按数字键直接选 |
| 「已恢复」提示 | 从 checkpoint 恢复的卡顶部一行小字，让用户明白它为什么又能点 |
| 入场动效 | 卡片淡入 + 轻微上移，尊重 `prefers-reduced-motion` |
| 状态语义 | 等待中明写「等你定一下」；已答锁死 + 勾选；循环真死了（中断 / 旧数据）才显示「本次会话已结束」 |
| 无障碍 | `role="radiogroup"` / `aria-checked`，方向键切换、回车确认 |

## 8. 验证

- `scripts/test-course-chat-tools.mjs`：`askUserToolResult` 的措辞（选中原文进引号、空白剪掉、
  空作答退化成「没回答」）—— 它是续跑时 store 自己拼的那句话，与执行器共用同一份。
- `scripts/e2e-course-chat-cards.mjs` 新增两条：
  - 第 6 节（提问卡）：出卡 → **刷新** → 卡片仍可答且带「会话已恢复」→ 点选 →
    断言续跑请求里同时带着**断点前的 `list_courses` 调用与结果**、挂起的 `ask_user` 调用与结果
    （重开一轮的话这些中间消息一个都不会出现）；
  - 第 7 节（方案卡）：出卡 → 刷新 → 仍可确认 → 执行落库并从断点续跑。
- 既有断言（点选继续、方案确认落库、取消不动数据）保持通过。
- 说明：`folderPlanToolResult` 依赖 `formatPlanForModel`（会拖进 Dexie），不做纯单测，
  由第 7 节 e2e 覆盖。
