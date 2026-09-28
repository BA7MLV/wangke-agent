# 课程助手：生成式提问、目录整理技能、跨页续跑、讲义阅读位置

- 状态：**已实现**
- 日期：2026-09-28
- 需求（四件事，同一批落地）：
  1. 讲义文档记住上一次的阅读位置；
  2. 课程助手加「生成式提问 UI」（助手给方案、用户点选）；
  3. 加一个「把文件归到目录」的技能，让 LLM 优化课程库目录；
  4. 课程助手切到别的页面后**仍然继续**（后台流式输出，回来接着看）。

## 1. 现状与问题定位

| 需求 | 现状 | 结论 |
|---|---|---|
| ① 阅读位置 | 材料（PDF/Word/MD/HTML）**已有**断点续读：`videos.lastUnit` + `MaterialReader.onUnitChange` 写回，`e2e-materials` 有 6 条断言守着；**讲义没有** —— `HandoutDocView` 的 `.hd-scroll` 每次打开都在顶部 | 只补讲义，材料不动 |
| ② 生成式提问 | 助手工具全是只读（`libraryAssistantSystemPrompt` 第 8 条明写「当前能力是只读查询」），没有「反问用户」的动作 | 新增 `ask_user` 阻塞式工具 |
| ③ 目录整理 | `folders` 表 + `videos.folderId` 已存在，库页能建/改名/删/移动；助手**看不到也改不了** | 新增 `list_folders` / `propose_folder_plan` + 内置技能 |
| ④ 跨页续跑 | `CourseChat` 是路由级组件：离开即卸载，agent 循环的 `setMessages` 全部作废；助手消息**只在流结束才落库**，中途离开 → 半个回答也没了 | 会话与在跑的循环一起提到全局 store |

## 2. 不变量

1. **播放页问答（`ChatPanel`）零回归。** `createToolExecutor` 签名与行为一格不改；`ask_user` / `propose_folder_plan` 只注册进课程助手那条工具表。播放页没有「跨课程上下文」，问「你是想学 A 还是 B」对它没有意义。
2. **助手不能凭空改用户数据。** 唯一的写入路径是 `propose_folder_plan`，而它**不落库**，只渲染一张待确认的方案卡；落库只发生在用户点「确认执行」时。取消与失败都不写。
3. **位置记忆只记「读到哪里」，不记「怎么读的」。** 讲义记 `{锚点, 偏移}`（与 `lastUnit` 同属位置，进云同步）；缩放/夜间模式这类阅读姿势不落库。
4. **课程助手的「继续」只跨路由，不跨刷新。** 循环活在一个模块级 store 里（内存），刷新页面进程就没了 —— 本次不做「刷新后续跑」，那要重建工具调用栈，代价远大于收益。刷新后的降级行为见 §6.4。
5. **`agentRounds` 预算仍由设置控制。** `ask_user` 占掉一整轮是刻意的：它是「真的在等用户」，不是工具空转。

## 3. 讲义阅读位置（需求 ①）

### 3.1 存什么

`HandoutRow` 加**非索引字段**（沿用 `sectionsJson` / `usedSkills` 先例，不升数据库版本）：

```ts
/** 上次阅读位置：锚点 + 该锚点相对容器顶部的额外滚动量（px） */
readPos?: { anchor: string; offset: number };
```

**为什么是「锚点 + 偏移」而不是 `scrollTop`**：讲义高度随视口宽度、图片解码、字体加载而变，同一份讲义在手机和桌面上 `scrollTop` 差几百像素很正常，纯像素偏移会让「回到原处」变成「回到附近的某处」。锚点（`sum` / `h3` / `s2b17`）复用 `HandoutDocView` 里 `keyOf(target)` 的既有形状，位置变了宁可落空（回顶部）也不要落错地方。

### 3.2 怎么落回去

`HandoutDocView` 挂载后按锚点找回元素，落位公式（`handout/readingPos.ts`）：

```
记 o = 容器顶 - 锚点顶 = pos.offset（锚点在容器顶之上 o 像素，恒 ≥ 0）
    D = 锚点相对内容顶端的位移
    P = scrollTop
锚点顶 = 容器顶 + D - P  ⇒  o = P - D  ⇒  P = D + o
```

⚠️ **offset 是加不是减**。记成减号的后果非常隐蔽：落位只差 `2×offset`，块高 114px / offset 40px 时正好偏**一个段落**，表现为「读到第五节、打开停在第四节中段」，而且每次都一样地错，看着像随机。这条是 `e2e-handout-position` 第 3 条断言抓出来的（期望 `s1b3@40`、实际 `s1b2@74`）。

**必须处理两件与落位抢跑的事**：

1. **锚点上方的东西后加载**：插图是 `objectURL` 的 blob，标题字体要 `ensureHandoutPreviewFonts()` 异步装，晚到一次落位就偏。做法是落位后挂 `ResizeObserver` 观察 `.hd-doc`，在布局仍在变的窗口内**持续纠正**（上限 2s / 24 次），并额外在 `document.fonts.ready` 后再纠正一次（字体一次性改整篇行高，可能已经把次数预算用完）。
2. **浏览器自己的滚动恢复**：它在内容渲染完之后才生效、时机不由我们控制，会把刚落好的位置顶掉（实测偏 80px）。`main.tsx` 里统一 `history.scrollRestoration = 'manual'` —— 安全的理由：本应用没有任何一处依赖原生恢复，各视图要么自己落位、要么每次从顶部开始。

**纠正不能压过用户**：一旦判定是用户自己滚的（`performance.now() - 上次落位 > 80ms` 的那次 scroll），立刻停止纠正。

写入侧用节流（400ms）+ 「锚点变了或偏移动了 >120px 才写」，并在卸载时补一次 —— 离开播放页正是「位置需要被记住」的时刻。

这条实现抽在 `handout/useReadingPos.ts`（hook），`HandoutDocView` 只负责传两个 ref。

旧版讲义（`sectionsJson` 为空、走 docx-preview 的那条路）**不记位置** —— 它没有块级锚点，硬塞一个 `scrollTop` 反而会让「老讲义也在记位置」这件事看起来时灵时不灵。

## 4. 生成式提问（需求 ②）

### 4.1 工具

`harness/askUser.ts`：`AskUserData = { question, options[], allowCustom }` + `validateAskUser()`（照抄 `harness/quiz.ts` 的校验风格：选项 2~5 条、每条非空且去重后不超 60 字）。工具名 `ask_user`，注册进 `LIBRARY_ASSISTANT_TOOLS`。

**它是「阻塞式」工具**：executor 不立即返回，而是 `await` 一个由 UI resolve 的 promise，用户点完才把结果喂回 agent 循环（`工具结果 = 用户选择了「…」`）。这与 `present_quiz` 的「立即返回、卡片另存」不同 —— 题卡是展示，选项卡是**答案的来源**，不等它就等于让模型自己编一个答案。

### 4.2 状态与渲染

`ChatRow` 加非索引字段 `ask?: { question; options; picked?; allowCustom? }`（与 `quiz` 同款：`picks` 存在即已作答）。

- 点选项 → 写回 `ask.picked`、追加一条 **user** 消息（内容就是被选中的那句）、resolve promise。
- 「我自己说」→ 聚焦输入框；此时按发送**不再起新一轮 agent 循环**，而是当作对这次提问的回答（resolve 掉它）。否则会出现两个循环同时往同一个会话写消息。
- 提问卡落在这条助手消息**内部**（`QuizCard` 的位置），读起来是「助手发问 → 用户作答 → 助手继续」。

**在用户作答处把消息轮换一次**（`rotateAi`）：卡片那条当场落库封口、另起一条接第 2 轮的正文。不轮换的话「卡片 + 回答」挤在同一条里，因果是反的（先看到结论、再看到问题，而用户点的那句话还落在回答之后）。轮换顺带让卡片**中途也不丢** —— 否则助手消息要等整轮结束才写，「问完就关掉浏览器」= 卡片与选择一起消失。

## 5. 目录整理技能（需求 ③）

### 5.1 两个工具 + 一张卡

| 工具 | 参数 | 作用 |
|---|---|---|
| `list_folders` | 无 | 现有文件夹 + 每类课程数 + 未分类数（模型整理前必须先看现状，否则会造重复分类） |
| `propose_folder_plan` | `{ summary, folders: [{ name, courseIds }] }` | **不落库**：渲染方案卡并阻塞，等确认/取消 |

`courseIds` 里的课程 id 必须在 `videos` 表里存在；不在的（模型编的）会在确认时被丢弃并在结果里点名告诉模型。文件夹按**名字**去重复用（库里已有同名就并进去），避免「数学」和「数学（2）」这种重复分类。

落库在 `harness/folderPlan.ts::applyFolderPlan`，一个 `rw` 事务里建目录 + 改 `folderId`；`courseIds` 为空的分类项等价于「移回未分类」。

### 5.2 内置技能 `library-organizer`

`src/skills/builtin/library-organizer/SKILL.md`，讲清**怎么分类**（先看全库 → 3~8 个互斥分类、粒度一致、以学科/考试/用途为主轴 → 逐门给出归属与理由），并写明「必须先出方案、用户确认后才算整理完成」。技能只提供**方法**，写入仍由工具的确认闸门把关 —— 这是不变量 2。

### 5.3 库页刷新

方案落库后课程卡片要立刻归位。做法是一个极小的 `useLibraryRevision()`（`zustand`，只存一个计数器）：`applyFolderPlan` 成功后 `bump()`，`Library` 订阅并在变化时重跑既有 `load()`。不引 Dexie `liveQuery` —— 那会让整页所有查询都变成活的，与这个一次性写操作不匹配。

## 6. 跨页继续（需求 ④）

### 6.1 状态搬家

新增 `store/courseChat.ts`（zustand，**不 persist**）：会话列表、当前会话、消息、`loading`、草稿输入框、课程上下文、技能白名单、待答的 `ask_user` / 待确认的方案，**以及那个悬着的 promise resolver**。`CourseChat.tsx` 退化成纯视图：订阅 store、渲染、发事件。

`runAgentLoop` 的回调（`onDelta` / `onReasoningDelta` / `onToolStart`…）写 store 而不是组件 state —— 组件卸载后回调照常跑，回来时消息已经在那儿了。

### 6.2 并发闸门

`ensureSessions` 走模块级 in-flight promise（照抄 `skills/store.ts` 的 `builtinInflight`）。React StrictMode 在 dev 下 effect 跑两次，原实现两次都查空、都插入，于是凭空多出一个「新会话」。

### 6.3 阻塞工具的悬空处理

用户答完 / 确认完之前 store 里的 `pendingAsk` 一直在。若此时用户删掉会话或切换会话，悬着的 promise 会被 `resolve('（用户已离开该会话）')` 收掉，循环正常收尾，绝不永久挂起。

### 6.4 刷新后的降级

刷新会杀掉循环（不变量 4）。落库的最后一条助手消息是**完整回答**，所以历史读起来是自洽的；只有「提问卡还没答」这种中间态会变成一张不可点的卡片（文案明说「本次会话已结束」），不给用户一个点了没反应的按钮。

## 7. 验证

| 层 | 脚本 | 覆盖 |
|---|---|---|
| 纯逻辑 | `scripts/test-course-chat-tools.mjs` | `validateAskUser` / `validateFolderPlan` 的边界（选项数、重复项、分类合并、错误文案是否点名到第几个） |
| 浏览器 e2e | `scripts/e2e-course-chat-cards.mjs` | **不依赖 API key**：`addInitScript` 把 `window.fetch` 换成脚本化 SSE 发生器。覆盖 —— 提问卡点选后继续回答、选择与那条 user 消息都落库、回答流到一半切到库页再回来内容不丢且落库、方案卡确认后 folders/folderId 真落库且库页立刻归位、取消方案一行数据都不动且模型收到的是「用户没执行」 |
| 浏览器 e2e | `scripts/e2e-handout-position.mjs` | **不依赖 API key**（自播种讲义行）。覆盖 —— 首次打开在顶部、滚动写回 `readPos`、刷新落回**同一个锚点**、锚点失效安静回顶部 |

e2e 拦 LLM 而不是调真模型，是因为这四条要验的是**我们自己写的状态机**（卡片 ↔ 工具 promise ↔ db 写回），模型说什么与结论无关；真模型反而会让断言不稳定，还多一份账单。

### 7.1 实现期被 e2e / 截图抓出来的问题

留档，因为它们都是「看着对、其实错」的那一类：

1. **`applyHandoutReadPos` 的符号错**（见 §3.2）。只差一个段落，肉眼与单测都看不出来，是位置往返断言抓到的。
2. **方案卡的 busy 态取错了字段**：拿 `loading`（循环在等用户时恒为 true）当 busy，「确认执行」按钮永远显示成 loading 且点不动 —— 循环在等用户，用户在等按钮解锁。拆出 `planApplying`。
3. **提问的选择没落库**：`send` 用闭包里的 `askState` 副本写库，而作答只改了 store 里的那条消息，于是历史回放看到一张没作答的卡。改成落库时从 store 读**当前消息的当前状态**。
4. **用户的选择只落库、不进内存列表**：当前这一屏看不到「你回答了什么」，要刷新才冒出来 —— 与 3 一起逼出消息轮换（§4.2）。
5. **因果顺序反了**（截图才发现）：卡片与它的回答挤在同一条消息里，读起来是「先给结论、下面才是问题」，而用户点的那句话还落在回答之后。→ 消息轮换 + 卡片渲染在正文之前。

## 8. 上线后修：轮次用尽时的「（未获得回答）」

真实使用（整理一整个「南方日报」分类）撞出来的，与卡片无关、但被这个功能放大：`harness/agent.ts` 里「轮次耗尽 → 追加一轮无 tools 的强制收尾」这个假设**不成立**。

- **现象**：7 次 LLM 调用（6 轮「旁白 + 调工具」+ 1 次收尾），界面只留下一句「（未获得回答）」，方案卡没出来，六轮的工作痕迹一点不剩。
- **根因**：不给 `tools` 时模型**仍会**返回「空正文 + tool_calls」（它想调 `propose_folder_plan`）。`chatStream` 照样把这些 `tool_calls` 解析出来，而收尾路径不执行它们 → `onDelta` 一次没触发 → 正文为空。
- 叠加另两个问题：每轮流出的旁白被 `onRoundStart` 清空（于是全丢），`hint` 也被清掉（用户连「它刚才在查什么」都看不到）。

修法（三处）：

1. **有界宽限**：收尾轮不吭声就追加一条明确指令（「不能再调用任何工具，只用中文文字总结」）再试**一次**；只宽限一次，成本可控。
2. **不把不吭声的消息塞回历史**：它带着没人应答的 `tool_calls`，留在 `messages` 里下一轮请求会被严格实现判 400。
3. **兜底文案由 `noAnswerNotice()` 统一生成**（`courseChat` 与 `ChatPanel` 共用）：说清「用完了 N 轮 / 它最后还想调 X / 它最后说过什么 / 你可以发一句『继续』或调大轮次上限」。

另加一条提示词约束（`libraryAssistantSystemPrompt` 第 10 条 + 技能正文）：**整理目录时不要逐门 `get_course_details`** —— 课程名与类型在 `list_courses` 里已经够用，逐门查详情正是这次把轮次用光的直接原因。回归由 `e2e-course-chat-cards.mjs` 第 5 节守着（宽限成功 / 双双沉默两条结局 + 「历史里不留悬空 tool_calls」）。
