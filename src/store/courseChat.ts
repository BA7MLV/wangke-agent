import { create } from 'zustand';
import { useChatNotifications } from './chatNotifications';
import { readChatPage } from './chatHistory';
import { framePatch } from '../utils/framePatch';
import type { ProcessPhase } from '../utils/responseProcess';
import { catalogOf, getSettings, modelOverridesOf } from './settings';
import { db, type AskUserState, type ChatRow, type ChatSessionRow, type ChatToolCall, type FolderPlanState, type TurnResume } from './db';
import { estimateTokens, fitHistoryToBudget } from '../harness/context';
import { prepareSessionHistory } from './contextCompression';
import { runAgentLoop, noAnswerNotice, type AgentStopInfo } from '../harness/agent';
import { resolveMaxRounds } from '../harness/loopGuard';
import { createResourceExecutor, libraryResourceTools } from '../harness/resources';
import {
  type CourseContextItem,
  folderPlanToolResult,
  LIBRARY_ASSISTANT_ID,
  libraryAssistantSystemPrompt,
} from '../harness/libraryAssistant';
import { applyFolderPlan, type AppliedPlanResult } from '../pipelines/folderPlan';
import { loadSessionSkillMeta, skillMetaBlock } from '../skills/store';
import { supportsThinking } from '../api/modelCaps';
import type { ChatMessage } from '../api/siliconflow';
import { askUserToolResult, askAnswerText, validateAskAnswer, type AskUserData, type AskUserAnswer } from '../harness/askUser';
import type { FolderPlan } from '../harness/folderPlan';
import { isToolFailure, summarizeToolResult, toolDetail, toolHint } from '../utils/toolTrace';
import { readPartialWidgetArguments } from '../utils/streamingHtml';
import type { WidgetPayload } from '../harness/widgetRuntime';
import { attachmentText, type ChatAttachment } from '../chat/attachments';
import { attachmentsForModel, messageForModel } from '../chat/attachmentModel';
import { removeAttachmentFile } from '../chat/prepareAttachment';
import { useChatAttachments } from './chatAttachments';
import { normalizeCourseContextIds } from '../harness/courseContext';

/**
 * 课程助手的全局会话状态。
 *
 * ## 为什么状态必须离开页面组件
 *
 * 原来这套逻辑全在 `pages/CourseChat.tsx` 里，于是「切到别的页面再回来」= 重新加载：
 * agent 循环的 `setMessages` 全打在已卸载的组件上，助手消息又因为还没流完而没落库，
 * 用户回来看到的是一句没头没尾的用户提问。**这不是体验问题，是数据丢失。**
 *
 * 搬到这里之后循环与页面解耦：路由卸载只卸载视图，回调照常写 store，回来时消息就在那。
 *
 * ## 会话是**懒创建**的：`activeId == null` 是合法状态（草稿态）
 *
 * 库里只存「写过消息的会话」。用户点「新建会话」不会落库 —— 它只是把视图切到草稿态，
 * 真正的 `chatSessions` 行在**首条消息发出时**才建（`send` 里那一处，也是唯一一处）。
 *
 * 于是「Recent 里出现一个点进去一个字都没有的空壳」在**数据层**就不可能发生，
 * 而不是靠「新建之前先判断当前会话空不空」那种判据绕开 —— 那种判据管不到
 * 「建了不用、切回去、再建一条」这条路径（见
 * docs/plans/2026-10-15-懒创建会话-design.md §1）。
 *
 * ⚠️ **`activeId === null` 只有这一个含义**：用户面前有一个「还没开始的会话」，
 * 库里没有它。别拿它表示「正在加载」或「出错」—— 那两件事分别有 `loaded` 与 `error`。
 *
 * ## 流式期间的输入：排队与插入
 *
 * 生成中**输入框不再禁用**，发送键也不再被停止键顶掉（这一版之前是
 * `disabled={loading && pendingAsk == null}` + 「发送键变成停止键」两颗按钮二选一）。
 * 那套做法把两件不相干的事绑成了一件：**想补一句话，只能先按停止** —— 而停止会把这轮
 * 已经写了一半的回答作废。用户真正的意图往往只是「等它答完，接着问下一句」。
 *
 * 现在输入永远可用，投递方式分两条（对齐 Codex CLI 的 steer/queue 与 Claude Code 的
 * 排队 + 「Esc 之后说话」）：
 *
 * | 模式 | 语义 | 代价 |
 * |---|---|---|
 * | `queue` **排队**（默认） | 挂到队尾，**这一轮答完自动接着发** | 不用等、不打断；代价是这话要到下一轮才生效 |
 * | `steer` **插入** | 立刻 abort 当前这一轮，把它当成新一轮的提问 | 立刻改口；代价是当前这轮到此为止（**已写出的部分留着**） |
 *
 * 三条不变量：
 *
 * 1. **消息永远不会静默丢失。** 插入投不进去时（abort 之后发现新一轮已经跑起来了）
 *    一律降级成排队（`steer` 末尾那条）；队列本身也可以逐条编辑 / 删除 / 立即发送。
 * 2. **`pendingAsk` 优先于两种模式。** 提问卡悬着时用户打的字是**对那张卡的回答**
 *    （那时循环在等用户，不是「正在生成一份回答」），所以排队与插入都让位。
 * 3. **队列只活在内存里，不落库。** 它是「还没交出去的话」，不是历史 ——
 *    真正的持久化发生在它被 `send` 出去那一刻（那一刻起它就是一条普通的 user 消息）。
 *
 * ## 生成期间的会话切换：一轮属于它自己的会话（真并发）
 *
 * 这一版之前，生成中切会话是**硬禁的**（`loadSession` 一进门就 `if (loading) return`），
 * 根因是下面这组状态是**单例**：`messages` / `loading` / `queued` / `pendingAsk` 全是
 * store 顶层一条，`inflight` 更是模块级的一个变量。于是「切走再回来」= 从库里重读，
 * 而正在流的那条回答还没落库 —— 内容整段消失；更要命的是循环的 `setMessages` 会写进
 * **当前在看的那条会话**，两条会话的内容互相串。
 *
 * 现在把它按会话分桶：
 *
 * | 概念 | 落点 |
 * |---|---|
 * | 活动会话的视图 | store 顶层（`messages` / `loading` / `queued` / …，形状不变） |
 * | 后台会话的视图 | 模块级 `parked: Map<id, SessionView>` |
 * | 正在跑的轮次 | `inflight: Map<id, InflightTurn>`（不再是一个单例） |
 * | 哪些会话在生成 | `runningIds`（Recent 行尾动作据此只禁那条在跑的） |
 *
 * 切会话 = `park` 当前 + `restore` 目标（有缓存秒切，没有才读库）。所有**跨会话存活**的
 * 写入都过 `writeView(sessionId, patch)`：活动会话就是原来的 `set`，后台会话只动 `parked`。
 * 于是「切到 B 也能提问」成立：两条会话各自带着自己的 key 起一轮，谁的流写谁那份。
 *
 * 三条不变量（与上面那三条并列）：
 *
 * 4. **正在跑的一轮永远写回它自己的会话**，无论用户此刻在看哪条 —— 这是不丢、不串的根。
 * 5. **只有「针对正在跑的那条会话」的动作才被拦**（分支 / 归档 / 删除），
 *    空闲会话在别的会话生成期间照常可操作。
 *
 * ## 刻意不做的事
 *
 * - **不 persist**。这里只有「正在跑的会话」的内存态，历史真源永远是 `chats` 表。
 *   持久化一份会立刻引入「两份真源」（刷新时以哪份为准？），而收益只是省一次读库。
 * - **不做「刷新后续跑」**。刷新会杀掉整个 JS 上下文，要续跑得把工具调用栈重建一遍，
 *   代价远大于收益。刷新后未作答的提问卡会退化成只读（见 CourseChat 里的说明文案）。
 * - **草稿仍是全局的**（`draft` 不进会话视图）：切会话时输入框里打了一半的字跟着走，
 *   与既有行为一致。
 */

/** 视图用的一条消息（比 `ChatRow` 多的是流式中间态） */
export interface CourseChatMessage {
  processPhase?: ProcessPhase;
  key: string;
  /** 落库后的行 id：需要就地更新（提问作答、方案落库）时用它 */
  rowId?: number;
  role: 'user' | 'ai';
  content: string;
  attachments?: ChatAttachment[];
  createdAt?: number;
  reasoning?: string;
  /** 思考耗时（毫秒）：首个思考 token → 末个。落库，历史消息也显示 */
  reasoningMs?: number;
  /**
   * 首个思考 token 的时刻（毫秒时间戳）。
   *
   * **不落库**：它只服务「思考中」那几秒的实时计时（`ReasoningChain` 的 `since`），
   * 历史消息用的是终值 `reasoningMs`。存在这里而不是组件里，是因为消息本身活在 store 中
   * —— 切走页面再回来组件会重挂，自己计时就会从 0 重新数。
   */
  reasoningStartedAt?: number;
  /** 流式过程中的工具提示（ThinkLine），结束即清 */
  hint?: string;
  /** 这一轮调过的工具（含正在跑的那次）。落库，历史消息也回放（见 components/ToolTrace） */
  tools?: ChatToolCall[];
  streaming?: boolean;
  error?: boolean;
  /**
   * 这条回答**没写完**（流式中途失败）。
   *
   * 与 `error` 不是一回事：`error` 是「一个字都没流出来，这条不算回答」；
   * `interrupted` 是「已经写了半截，只是没写完」—— 它有内容、能续写、要落库。
   * 界面据它渲染提示条 + 「继续」按钮。
   */
  interrupted?: boolean;
  /** 中断原因（提示条上显示） */
  interruptReason?: string;
  /** 助手向用户提问的选项卡 */
  ask?: AskUserState;
  /** 目录整理方案卡 */
  folderPlan?: FolderPlanState;
  /** 沙箱图形卡（show_widget 的 html 形态产出） */
  widget?: WidgetPayload;
  widgets?: WidgetPayload[];
  /** show_widget 参数尚未完整到达时的静态安全预览（不落库） */
  widgetPreview?: { html: string };
}

/**
 * 恢复态卡片带来的续跑种子（存进 `pendingAsk.resume` / `pendingPlan.resume`）。
 *
 * 与活着的那一轮不同：这里**没有内存 promise**，`resolve` 走的是「拼好消息、重进循环」。
 */
export interface ResumeSeed {
  sessionId: number;
  /** 挂起的那条助手消息（卡片所在行） */
  rowId: number;
  toolName: 'ask_user' | 'propose_folder_plan';
  toolCallId: string;
  /** 回合内已累积的消息（见 `TurnResume`），续跑时原样拼回 */
  midTurn: ChatMessage[];
}

/** 交给 `send` 的续跑请求：种子 + 这次要给模型的结果 */
export interface ResumeRequest extends ResumeSeed {
  askAnswer?: AskUserAnswer;
  /** 喂回模型的工具结果文本 */
  toolResult: string;
  /** 提问卡作答有（落一条 user 行）；方案确认没有 */
  userContent?: string;
  /** 方案落库结果（写回卡片的 `applied`）：1=已执行 2=取消 */
  planApplied?: 0 | 1 | 2;
}

/** 悬着的「等用户回答」：UI 点击时调 resolve，agent 循环靠它继续往下走 */
export interface PendingAsk {
  messageKey: string;
  resolve: (picked: AskUserAnswer | string) => void;
  /** 从库里的挂起点恢复（刷新后）—— 仅用于 UI 显示「会话已恢复」 */
  restored?: boolean;
  /** 恢复态的续跑种子；活着的那一轮没有它 */
  resume?: ResumeSeed;
}

/** 悬着的「等用户确认」 */
export interface PendingPlan {
  messageKey: string;
  resolve: (answer: { ok: boolean; result: AppliedPlanResult | null }) => void;
  restored?: boolean;
  resume?: ResumeSeed;
}

/**
 * 生成中发一条消息的**投递方式**（界面上的「排队 / 插入」就是它）。
 *
 * - `queue`（排队）：挂到队尾，这一轮答完再发。保守、随时能撤，是默认值；
 * - `steer`（插入）：立刻打断这一轮，把这句当成新一轮的提问。
 *
 * 名字同时是 `sendMode` 的取值与 `send(text, mode)` 的第二参 —— 别在别处再造一套叫法。
 */
export type SendMode = 'queue' | 'steer';

/** 排队中的一条消息（还没交给模型的话） */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: ChatAttachment[];
}

export interface CourseChatStore {
  ready: boolean;
  /**
   * **未归档**的会话，按 `createdAt` 升序（旧 → 新）。
   *
   * ⚠️ 顺序是 load-bearing：`bootstrap` 与 `deleteSessionById` 都拿
   * `sessions[sessions.length - 1]` 当「最新的那条会话」。置顶排序因此**只在展示层做**
   * （pages/CourseChat.tsx 的 `recentSessions`），绝不能在这里换序 ——
   * 一换，「默认选中的会话」就会跳到一条旧的或置顶的。见
   * docs/plans/2026-10-15-recent-会话操作菜单-design.md §4。
   *
   * 懒创建之后**它可以是空的**（全新用户，或全部归档之后）。空列表 = 用户看到的是草稿态，
   * 不是「出错了」。任何「至少有一条」的假设都是上一版留下的，别再写回来。
   */
  sessions: ChatSessionRow[];
  /**
   * 当前会话 id；`null` = **草稿态**（会话还没落库，见文件头）。
   *
   * 草稿态下 `send` 会在首条消息处落库并把这里换成真实 id，所以下游读它的人
   * （`answerAsk` / `setSkillIds` / 页面 effect）不需要各自处理 null —— 只有
   * `send` 与「切到草稿态」那几个动作需要。
   */
  activeId: number | null;
  /**
   * 当前视图的消息**已就绪**（false 时禁发：否则会基于空历史发第一轮）。
   *
   * 懒创建之后语义从「本会话消息已从库里读完」放宽成「已就绪」：草稿态没有东西要读，
   * 所以它天然是 `true` —— 否则草稿态的输入框会永久禁用，用户连第一条都发不出去。
   */
  loaded: boolean;
  messages: CourseChatMessage[];
  hasOlder: boolean;
  loadingOlder: boolean;
  historyError: string | null;
  loadOlder: () => Promise<void>;
  /**
   * 当前视图对应的那条会话**正在生成**。
   *
   * ⚠️ 它只回答「我在看的这条会话」。别的会话在后台跑不出来 —— 那由 `runningIds` 管。
   * 生成中切会话之所以能放开，正是因为这一条不再被当成「全局有个东西在跑」。
   */
  loading: boolean;
  /**
   * **正在生成**的会话 id（可能不止一条：切到 B 也能提问 = 真并发）。
   *
   * 侧栏 Recent 的行尾动作（分支 / 归档 / 删除）据此**只禁那条在跑的**，而不是一有生成
   * 就整列变灰 —— 删/分支要读库，而正在流的那条还没落库，复制/删除会缺一截。
   */
  runningIds: number[];
  /**
   * **正等着用户作答**的会话 id（提问卡 / 目录方案确认悬着的那些）。
   *
   * 与 `runningIds` 是两件事：跑得动 ≠ 卡住了。卡住的会话不一定在「生成中」—— 从断点恢复的
   * 那张卡背后根本没有循环在跑，却照样等着人（见 `pendingAsk.restored`）。
   *
   * 这是**全局通知**的数据源：Recent 行上的「等你选」徽标、标签页标题上的「●」、
   * 挂起瞬间那条可点的 toast 都读它 —— 见 `components/AskAlerts.tsx`。
   * 之所以要**跨会话存活**（而不是只看当前这条）：用户完全可能在别的会话、甚至别的页面，
   * 后台那条卡住了也没人知道。
   */
  awaitingIds: number[];
  /** 输入框草稿：切页面不该吃掉用户打了一半的字 */
  draft: string;
  /**
   * 排队中的消息（生成期间按「排队」投递的那些）。
   *
   * ⚠️ **只活在内存里**，与 `messages` 不同：它是「还没交出去的话」，不是历史数据。
   * 刷新、切会话都会丢掉它 —— 真正的持久化发生在它被 `send` 出去那一刻。
   */
  queued: QueuedMessage[];
  /**
   * 生成期间回车默认走哪条路（`draft` 非空时的投递方式）。
   *
   * 流式期间工具行上的「排队 / 插入」切换的就是它，**同一次生成内记住**：
   * 用户选了插入就是连着要插入，不该每发一条都再选一次。
   */
  sendMode: SendMode;
  courseCount: number | null;
  skillIds: number[] | undefined;
  contextCourses: CourseContextItem[];
  pendingAsk: PendingAsk | null;
  pendingPlan: PendingPlan | null;
  /**
   * 方案正在落库。
   *
   * 刻意与 `loading` 分开：循环「等用户确认」期间 `loading` 一直是 true，拿它当 busy 的话
   * 「确认执行」按钮会一直显示成 loading 且点不动 —— 循环在等用户，用户却在等按钮解锁。
   */
  planApplying: boolean;

  bootstrap: () => Promise<void>;
  /**
   * 重新统计课程数。
   *
   * 页面每次挂载都要调一次：`courseCount` 是 bootstrap 时的快照，而用户很可能
   * 「去课程库导入 → 切回对话页」，此时快照还是 0，页面会一直显示「先去导入课程」。
   */
  refreshCourseCount: () => Promise<void>;
  loadSession: (id: number) => Promise<void>;
  /**
   * 新开一条会话 —— **不落库**，只是把视图切到草稿态。
   *
   * 已经是草稿态时什么都不做（幂等）：这正是「当前会话是空的就别再建一条」那条规则的
   * 落地，而它在这里是**免费**的 —— 草稿态天然可复用，不需要任何判据。
   */
  createSession: () => Promise<void>;
  /**
   * 删掉**指定**会话。返回 false = 被拒（正在生成）。
   *
   * 侧栏 Recent 的删除按钮要对任意一行生效，而不只是当前那条，所以这条按 id 走；
   * `deleteSession` 是它的「删当前」特例。
   *
   * 删掉当前会话之后落到**剩下的最后一条**；一条都不剩就切到草稿态（不新建空会话）。
   */
  deleteSessionById: (id: number) => Promise<boolean>;
  /** 删掉当前会话并切到剩下的最后一个；返回 false = 被拒（正在生成） */
  deleteSession: () => Promise<boolean>;
  /**
   * 改会话标题。空串 / 纯空白按原样忽略（调用方负责提示）。
   *
   * 生成中**允许**：标题不参与消息读写，与 `delete` 不同。
   */
  renameSession: (id: number, title: string) => Promise<void>;
  /** 置顶 / 取消置顶。生成中允许（只影响排序位） */
  setPinned: (id: number, pinned: boolean) => Promise<void>;
  /**
   * 归档 / 取消归档。返回 false = 被拒（正在生成）。
   *
   * 归档当前会话会顺带切走 —— 归档的语义就是「我不想再看它了」，
   * 而留在原地会让顶栏标题掉回默认、消息区对不上 Recent 的高亮。
   * 一条都不剩时切到草稿态（不新建空会话，与删除同一条规矩）。
   */
  setArchived: (id: number, archived: boolean) => Promise<boolean>;
  /**
   * 已归档的会话（设置 → 数据 → 「已归档会话」那张卡读它）。
   *
   * 刻意不放进 `bootstrap`：绝大多数用户从不归档，首页就为一条空列表查一次库不划算。
   */
  archivedSessions: ChatSessionRow[];
  /** 重新读一遍已归档列表（那张卡挂载时调） */
  refreshArchived: () => Promise<void>;
  setDraft: (text: string) => void;
  /**
   * 发一轮提问。
   *
   * 生成中调用**不会**被吞掉，而是按 `mode ?? sendMode` 分流成排队或插入（见文件头）。
   * `mode` 是**这一次按键**的覆盖：Ctrl/Cmd+回车用另一种投递方式（UI 侧的约定），
   * 不改默认值 —— 与 Codex CLI 的 Enter/Tab 同构：两者都是「这一次怎么发」。
   *
   * `target` 是**目标会话**（不传 = 当前活动会话，UI 永远走这条）。只有一条内部路径会带它：
   * 某条**后台会话**这一轮结束后 `drainQueue(sessionId)` 把它的队首送出去 —— 那时目标不是
   * 「我现在在看的会话」，而是刚跑完的那条。带 `target` 的调用**不碰全局草稿**。
   *
   * `resume` 是**刷新后的断点续跑**：带着挂起点攒下的 `midTurn` 从断点重进循环。
   * 提问卡作答 / 方案确认的**恢复态**用它（活着的循环不走这条，它们 resolve 内存 promise）。
   * 见 docs/plans/2026-10-16-ask-user-resume-design.md。
   */
  send: (text: string, mode?: SendMode, target?: number, resume?: ResumeRequest, attachments?: ChatAttachment[]) => Promise<void>;
  /**
   * 改当前会话的技能范围。
   *
   * 草稿态（`activeId == null`）下**只写内存**：那条会话还没落库，没有行可改；
   * 内存里这份会在首条消息落库时一并写进去（见 `send`）。静默丢弃是不行的 ——
   * 那会让用户点了技能范围、界面看着生效了、发第一条消息时没了。
   */
  setSkillIds: (ids: number[] | undefined) => void;
  /** 恢复自动选课程。草稿态同样只写内存，理由见 `setSkillIds` */
  clearCourseContext: () => void;
  setCourseContext: (ids: string[]) => Promise<void>;
  /** 提问卡作答（同时把选择落成一条 user 消息） */
  answerAsk: (option: AskUserAnswer | string) => Promise<void>;
  /** 停止生成：中断当前的 LLM 请求与 agent 循环（已流出的内容保留） */
  stop: () => void;
  // ── 流式期间的输入（排队 / 插入）─────────────────────────────────────────
  /** 切换生成期间的默认投递方式（工具行上那两颗「排队 / 插入」） */
  setSendMode: (mode: SendMode) => void;
  /** 排队：把话挂到队尾。生成中投不出去的插入也会落到这里（见 `steer`） */
  enqueue: (text: string, attachments?: ChatAttachment[]) => void;
  removeQueued: (id: string) => void;
  /** 改一条排队消息的文字。**改成空白 = 删掉它**（留一条永远发不出去的空气泡没有意义） */
  updateQueued: (id: string, text: string) => void;
  /** 清空队列（停止生成之后想彻底收手时用） */
  clearQueue: () => void;
  /** 把队列里某一条**立刻**插进去：出队 + `steer`。队列因此不需要拖拽排序 —— 想提前就说一声 */
  sendQueuedNow: (id: string) => Promise<void>;
  /**
   * 插入：打断当前这一轮，把这句当成新一轮的提问。
   *
   * 没有正在跑的一轮时退化成普通发送；等收尾期间新一轮已经跑起来时降级成排队。
   * 两条兜底都是为了同一件事：**这句话不会丢**。
   */
  steer: (text: string, attachments?: ChatAttachment[]) => Promise<void>;
  /**
   * 重试一条消息。按这条消息的状态分流：
   *
   * - `interrupted`（有半截内容）→ **续写**：把已写部分当 assistant 前缀，让模型从断点接着写，
   *   新内容**追加到同一条消息**上（不新开气泡，也不重发那句 user 提问）；
   * - 完整回答，且是**最后一条消息** → **重新生成**：删掉这条回答行，用它前面那条 user 提问重跑；
   * - **用户提问**（它的回答就是最后一条）→ **重新回答这句话**：删掉这一问一答再重发同一句，
   *   结果与「重试那条回答」相同，只是入口落在提问上 —— 用户想换一次回答时，视线多半
   *   还停在自己刚打完的那句上；
   * - 完整回答但不是最后一条 → 什么都不做。要从历史中间改一步，正确动作是 `forkSession`
   *   （那是一次不可见的批量删除，用户会看到一条会话凭空少了一段）。
   */
  retryMessage: (key: string) => Promise<void>;
  /** Delete only the selected persisted message, never its following turns. */
  deleteMessage: (key: string, sessionId: number | null) => Promise<boolean>;
  /**
   * 从某条消息处 fork 出一条新会话，返回新会话 id（失败/被拒返回 null）。
   *
   * - 传 `uptoRowId` = 复制到该行为止（含），对话里的「分支」走这条；
   * - 不传 = 复制整条会话，侧栏 Recent 的「分支」走这条（等价于从最后一条分叉）。
   *
   * **原会话完全不动**：这是它和「重新生成」的分界 —— 分支的意义就是「留着原来那条比着看」。
   */
  forkSession: (sessionId: number, uptoRowId?: number) => Promise<number | null>;
  /** 确认执行目录整理方案 */
  confirmPlan: () => Promise<{ ok: boolean; error?: string }>;
  /** 放弃目录整理方案（不落库） */
  cancelPlan: () => Promise<void>;
}

/**
 * 切到草稿态时要一起重置的字段。
 *
 * 抽成常量而不是在三处各写一遍：这几个字段是「会话级状态」的**完整清单**，
 * 漏一个的后果是新会话带着上一个会话的残留（技能范围、课程上下文、消息），
 * 而且只在特定操作顺序下才看得出来 —— 这类漏项不该靠人肉记。
 *
 * `skillIds: undefined` 是**不限定**（不是「一个都不给」），别改成 `[]`，
 * 见 `ChatSessionRow.skillIds` 的三态说明。
 */
const DRAFT_STATE: Partial<CourseChatStore> = {
  activeId: null,
  loaded: true,
  messages: [],
  loading: false,
  skillIds: undefined,
  contextCourses: [],
  // 队列属于「正在跑的那一轮」：切到草稿态时，上一条会话没说完的话留在它自己的视图里
  // （park），不会被带进这份全新的空草稿。
  queued: [],
  pendingAsk: null,
  pendingPlan: null,
  planApplying: false,
};

/**
 * 课程工具是**按轮次动态**组装的，不是一个模块级常量。
 *
 * 空课程库时整套课程工具都不注册（见 `libraryAssistantTools`），技能工具始终并入。
 */
const toolsForLibrary = libraryResourceTools;

let keySeq = 0;
const nextKey = () => `course-chat-${Date.now()}-${keySeq++}`;
let queuedSeq = 0;
const nextQueuedId = () => `queued-${Date.now()}-${queuedSeq++}`;

/** 队列里的附件已经离开草稿区；删掉队列时也要释放本机 / 服务端文件。 */
function disposeQueuedAttachments(items: QueuedMessage[]): void {
  const files = new Map<string, ChatAttachment>();
  for (const item of items) for (const file of item.attachments ?? []) files.set(file.id, file);
  void Promise.allSettled([...files.values()].map((file) => removeAttachmentFile(file)));
}

/**
 * 用户中止这一轮时到底**想要什么**。
 *
 * 两个值 abort 的是同一个 `AbortController`（断请求的手段只有一种），但留下的痕迹
 * 必须不同 —— 这是「插入」与「停止」在数据层的唯一区别：
 *
 * - `stop`（按了停止键）：正文里补一句「（已停止生成）」并落库，**一个字节都没流出来时
 *   也留一条气泡** —— 用户明确要求到此为止，界面必须给个回执（既有行为，有 e2e 断言）；
 * - `steer`（插入新消息）：留住已经写出来的半截（标成 `interrupted`，还能续写），
 *   而**什么都没写出来时把这条气泡整个摘掉** —— 插入的语义是「换个方向」，
 *   在用户那句新话上面挂一条「（已停止生成）」的白板，读起来像这一轮失败了。
 */
type AbortIntent = 'stop' | 'steer';

interface InflightTurn {
  abort: AbortController;
  intent: AbortIntent;
  /** 放行在等这一轮收尾的人（`steer`）。由 `beginInflight` 填上 */
  settle?: () => void;
}

/**
 * 正在跑的那些轮，**按会话分桶**（`send` 与 `continueInterrupted` 都会登记）。
 *
 * 放**模块级**而不是 store：它要在 React 渲染之外被 `stop()` / `steer()` 读到，
 * 塞进 state 只会平白多几次渲染（「我在看的这条在不在跑」看顶层 `loading` 就够）。
 *
 * ⚠️ **不是一个单例了**（2026-10-16 生成中切会话）：切到 B 后 B 也能提问，于是同一时刻
 * 可能有好几条会话各跑各的循环。`stop()` / `steer()` 按 `activeKey()` 在这张表里找对象，
 * 所以它们只作用于**当前在看的那条**，不会误伤后台在跑的另一条。
 *
 * 草稿态用 `0` 当 key（那时还没有真实会话 id）；懒创建出 id 后由 `rekeyInflight` 挪过去。
 */
const inflight = new Map<number, InflightTurn>();

/**
 * 「这一轮彻底收尾」的信号（落库写完、`loading` 已置回），按会话分桶。
 *
 * `steer` **必须等它**：abort 之后立刻调 `send` 的话，`loading` 还开着，
 * 那句新话会被自己的分发逻辑当成「生成中」再排一次队 —— 实测症状是
 * 「点了插入，消息进了队列，当前回答也没被改口」。
 */
const inflightDone = new Map<number, Promise<void>>();

function beginInflight(sessionId: number, abort: AbortController): InflightTurn {
  const record: InflightTurn = { abort, intent: 'stop' };
  inflight.set(sessionId, record);
  inflightDone.set(
    sessionId,
    new Promise<void>((resolve) => {
      record.settle = resolve;
    }),
  );
  return record;
}

/** 收尾：注销这轮记录 + 放行在等它的人。**必须在 `finally` 里调**，否则 `steer` 会一直挂着 */
function endInflight(sessionId: number, record: InflightTurn): void {
  if (inflight.get(sessionId) === record) inflight.delete(sessionId);
  record.settle?.();
  inflightDone.delete(sessionId);
}

/** 草稿态懒创建出真实 id 之后，把这一轮的登记从 `0` 挪到新 id */
function rekeyInflight(from: number, to: number): void {
  const record = inflight.get(from);
  if (record) {
    inflight.delete(from);
    inflight.set(to, record);
  }
  const done = inflightDone.get(from);
  if (done) {
    inflightDone.delete(from);
    inflightDone.set(to, done);
  }
}

/**
 * 一条会话的**完整视图**。
 *
 * 这一版之前，下面这组字段全是 store 顶层的**单例**：切会话就整条换掉，于是正在流的那条
 * 回答（还没落库）会丢。现在按会话分桶 ——「正在跑的一轮」属于它自己的会话，谁的流写谁那份。
 *
 * 活动会话的这份视图就摊在 store 顶层（字段名与形状不变，UI 与既有单测照读），
 * 后台会话的进 `parked`。切会话 = park 当前 + restore 目标（见 `loadSession`）。
 */
interface SessionView {
  messages: CourseChatMessage[];
  hasOlder: boolean;
  loadingOlder: boolean;
  historyError: string | null;
  loaded: boolean;
  loading: boolean;
  queued: QueuedMessage[];
  pendingAsk: PendingAsk | null;
  pendingPlan: PendingPlan | null;
  planApplying: boolean;
  skillIds: number[] | undefined;
  contextCourses: CourseContextItem[];
}

/** 会话视图的 key：真实会话 id，或 `0` = 草稿态 */
type ViewKey = number;

const EMPTY_VIEW: SessionView = {
  messages: [],
  hasOlder: false,
  loadingOlder: false,
  historyError: null,
  loaded: false,
  loading: false,
  queued: [],
  pendingAsk: null,
  pendingPlan: null,
  planApplying: false,
  skillIds: undefined,
  contextCourses: [],
};

/** 后台会话的视图（不在 store 顶层、写它不触发渲染）。活动会话永远摊在顶层，不进这里 */
const parked = new Map<number, SessionView>();

/**
 * 「正等着用户作答」的会话 id 集合 —— 是 `awaitingIds` 那格 state 的**真身**。
 *
 * 住在模块级而不是 state 里：它要能回答「任何一条会话」是否卡住，而 state 只摊着当前这条的视图。
 * 每次成员有变才把 `[...awaiting]` 写回 state（token 级的高频 `writeView` 大多是无变化的 no-op）。
 */
const awaiting = new Set<number>();


/**
 * 把 store 顶层那组字段读成一份会话视图。**只读**，不 clone 数组（写入一律换成新数组）。
 */
function topLevelView(s: CourseChatStore): SessionView {
  return {
    messages: s.messages,
    hasOlder: s.hasOlder,
    loadingOlder: s.loadingOlder,
    historyError: s.historyError,
    loaded: s.loaded,
    loading: s.loading,
    queued: s.queued,
    pendingAsk: s.pendingAsk,
    pendingPlan: s.pendingPlan,
    planApplying: s.planApplying,
    skillIds: s.skillIds,
    contextCourses: s.contextCourses,
  };
}

/** 当前活动会话的 key（草稿态 = `0`） */
function activeKey(): ViewKey {
  return useCourseChat.getState().activeId ?? 0;
}

/**
 * 读一条会话的视图：活动会话读顶层，后台会话读 `parked`。
 *
 * 这是「正在跑的一轮」与「用户在看哪条」解耦的关键 —— 循环拿着自己的 `sessionId` 调它，
 * 无论用户此刻切到了哪里，读到的都是自己那份。
 */
function readView(key: ViewKey): SessionView {
  if (key === activeKey()) return topLevelView(useCourseChat.getState());
  return parked.get(key) ?? EMPTY_VIEW;
}

/**
 * 写一条会话的视图。
 *
 * - 活动会话：直接 `set` —— 就是这一版之前的路径，单会话行为**零变化**，既有单测照跑；
 * - 后台会话：并进 `parked`，不触发任何渲染（用户没在看它，渲染是浪费）。
 *
 * ⚠️ 所有会**跨会话存活的写入**（`send` / `continueInterrupted` 里的每一处 `patchAi`、
 * `set({ loading })`、`rotateAi` 等）都必须过它；只用 `set` 的话，用户切走后那一轮会把
 * 内容写进**当前在看的那条会话**的视图里 —— 正是这次要修的那个串台。
 */
function writeView(key: ViewKey, patch: Partial<SessionView>): void {
  if (key === activeKey()) {
    useCourseChat.setState(patch);
    syncAwaiting(key, topLevelView(useCourseChat.getState()));
    return;
  }
  const next = { ...readView(key), ...patch };
  parked.set(key, next);
  syncAwaiting(key, next);
}

/** Reflect a committed block edit in its own session, even after switching tabs. */
export function reflectArtifactEdit(row: ChatRow): void {
  const view = readView(row.sessionId);
  writeView(row.sessionId, { messages: view.messages.map((message) => message.rowId === row.id
    ? { ...message, content: row.content, widget: row.widget, widgets: row.widgets } : message) });
}

/** 把当前顶层的活动视图存回它那条会话（切走前调）。草稿态不 park：它每次由「新会话」重开 */
function parkActive(): void {
  const state = useCourseChat.getState();
  if (state.activeId == null) return;
  parked.set(state.activeId, topLevelView(state));
}

/** 维护「哪些会话在生成」的列表（Recent 行尾动作据此只禁那条在跑的） */
function markRunning(sessionId: number, running: boolean): void {
  useCourseChat.setState((s) => {
    const has = s.runningIds.includes(sessionId);
    if (running && !has) return { runningIds: [...s.runningIds, sessionId] };
    if (!running && has) return { runningIds: s.runningIds.filter((id) => id !== sessionId) };
    return s;
  });
}

/**
 * 按一条会话视图里有没有悬着的卡，把它在「等用户作答」列表里增删。
 *
 * 只在**成员真变了**时才写 state：`writeView` 每个 token 都调一次，无变化却 `set` 会白白惊动
 * 所有订阅者。key 为 `0`（草稿态）直接略过 —— 草稿态不可能有卡片。
 */
function syncAwaiting(sessionId: number, view: SessionView): void {
  if (sessionId === 0) return;
  const should = view.pendingAsk != null || view.pendingPlan != null;
  if (should === awaiting.has(sessionId)) return;
  if (should) awaiting.add(sessionId);
  else awaiting.delete(sessionId);
  useCourseChat.setState({ awaitingIds: [...awaiting] });
}

/**
 * 把一条会话从「等用户作答」列表里摘掉 —— 删 / 归档时用。
 *
 * 漏掉这一步的症状很怪：那条会话已经从 Recent 里没了，可标题上的「●」永远亮着
 * （`awaiting` 里还留着它的 id），用户找遍所有会话都不知道到底谁在等他。
 */
function forgetAwaiting(sessionId: number): void {
  if (!awaiting.delete(sessionId)) return;
  useCourseChat.setState({ awaitingIds: [...awaiting] });
}


export const useCourseChat = create<CourseChatStore>()((set, get) => ({
  ready: false,
  sessions: [],
  activeId: null,
  loaded: false,
  messages: [],
  hasOlder: false,
  loadingOlder: false,
  historyError: null,
  loading: false,
  runningIds: [],
  awaitingIds: [],
  draft: '',
  queued: [],
  sendMode: 'queue',
  courseCount: null,
  skillIds: undefined,
  contextCourses: [],
  pendingAsk: null,
  pendingPlan: null,
  planApplying: false,

  // ── 启动 / 会话装载 ────────────────────────────────────────────────────────
  bootstrap: async () => {
    if (get().ready) return;
    const [sessions, count] = await Promise.all([unarchivedSessions(), db.videos.count()]);
    const current = get().activeId;
    const keepCurrent = current != null && sessions.some((row) => row.id === current);
    const activeId = keepCurrent ? current : (sessions[sessions.length - 1]?.id ?? null);
    set({ sessions, ready: true, courseCount: count, activeId });
    /**
     * 一条会话都没有就**不建**（`activeId` 留 `null` = 草稿态），同时把 `loaded` 置 true。
     *
     * 漏掉 `loaded` 这一步的话输入框会**永久禁用**：`loaded` 的初值是 false，
     * 而没有 `activeId` 也就没有任何地方会去把它置 true（页面 effect 的条件是
     * `activeId != null`）。症状是全新用户进来一片死寂 —— 打字打不进去。
     */
    if (activeId == null) set({ loaded: true });
  },

  refreshCourseCount: async () => {
    set({ courseCount: await db.videos.count() });
  },

  loadOlder: async () => {
    const id = get().activeId;
    if (id == null) return;
    const view = readView(id);
    const first = view.messages[0];
    if (!view.hasOlder || view.loadingOlder || first?.rowId == null || first.createdAt == null) return;
    writeView(id, { loadingOlder: true, historyError: null });
    try {
      const page = await readChatPage(id, { id: first.rowId, createdAt: first.createdAt });
      const latest = readView(id);
      if (latest.messages[0]?.key !== first.key) return;
      const keys = new Set(latest.messages.map((message) => message.rowId));
      writeView(id, {
        messages: [...page.rows.filter((row) => !keys.has(row.id)).map(toMessage), ...latest.messages],
        hasOlder: page.hasOlder,
        loadingOlder: false,
      });
    } catch {
      if (readView(id).messages[0]?.key === first.key) {
        writeView(id, { loadingOlder: false, historyError: '历史消息加载失败，点击重试' });
      }
    }
  },

  loadSession: async (id) => {
    /**
     * 生成中**可以**切会话（2026-10-16）：正在跑的那一轮绑在它自己的会话上，切走 = `park`
     * 它的视图，循环照旧往 `parked[id]` 写；切回来再 `restore`，所以那条流式回答不会丢。
     * 旧实现是一进门 `if (loading) return`，于是「想边等边去看另一条」直接点不动。
     */
    const current = get();
    // 已经就是它、且视图已就绪：幂等。`loaded == false` 那条（bootstrap 刚把 activeId 指过来）
    // 要继续走下面的读库。
    if (current.activeId === id && current.loaded) return;
    // 切走前把当前这条的视图存回它自己的会话；目标有缓存就地恢复、**不读库**（秒切）
    if (current.activeId != null && current.activeId !== id) parkActive();
    const cached = parked.get(id);
    if (cached) {
      parked.delete(id);
      set({ activeId: id, ...cached });
      return;
    }
    // 没有缓存：先把视图置成「读取中」，再读库
    set({ activeId: id, ...EMPTY_VIEW, loaded: false });
    const [session, page] = await Promise.all([
      db.chatSessions.get(id),
      readChatPage(id),
    ]);
    const rows = page.rows;
    const contextIds = session?.contextCourseIds ?? [];
    const contextRows = contextIds.length > 0
      ? await db.videos.where('id').anyOf(contextIds).toArray()
      : [];
    const byId = new Map(contextRows.map((course) => [course.id, course.name]));
    const view: SessionView = {
      messages: rows.map(toMessage),
      hasOlder: page.hasOlder,
      loadingOlder: false,
      historyError: null,
      loaded: true,
      loading: false,
      queued: [],
      pendingAsk: null,
      pendingPlan: null,
      planApplying: false,
      skillIds: session?.skillIds,
      contextCourses: contextIds
        .filter((cid) => byId.has(cid))
        .map((cid) => ({ id: cid, name: byId.get(cid)! })),
    };

    /**
     * 断点恢复：末条助手行带 `resume` 且卡未作答 → 把卡片重新武装成「可答」。
     *
     * 这里**没有内存 promise** —— 作答由 `answerAsk` / `confirmPlan` / `cancelPlan` 分流到
     * `send` 的续跑路径（见 docs/plans/2026-10-16-ask-user-resume-design.md）。
     * 卡片已作答 / 不是阻塞工具的残留检查点直接丢弃，不自动续跑。
     */
    const lastRow = rows[rows.length - 1];
    if (lastRow?.id != null && lastRow.resume) {
      const seed: ResumeSeed = {
        sessionId: id,
        rowId: lastRow.id,
        toolName: lastRow.resume.toolName,
        toolCallId: lastRow.resume.toolCallId,
        midTurn: lastRow.resume.midTurn,
      };
      const messageKey = `stored-${lastRow.id}`;
      if (lastRow.resume.toolName === 'ask_user' && lastRow.ask && lastRow.ask.picked == null) {
        view.pendingAsk = {
          messageKey,
          restored: true,
          resume: seed,
          // 恢复态的作答走 answerAsk（它会读 pendingAsk.resume 再交给 send），这里只是占位
          resolve: () => {},
        };
      } else if (
        lastRow.resume.toolName === 'propose_folder_plan' &&
        lastRow.folderPlan &&
        (lastRow.folderPlan.applied ?? 0) === 0
      ) {
        view.pendingPlan = {
          messageKey,
          restored: true,
          resume: seed,
          // 同上：恢复态的确认 / 取消走 confirmPlan / cancelPlan
          resolve: () => {},
        };
      } else {
        void db.chats.where('id').equals(lastRow.id).modify((row) => {
          delete row.resume;
        });
      }
    }
    // 读库期间用户可能又切走了：那就把结果存进它的会话，别覆盖当前视图
    if (get().activeId === id) set(view);
    else parked.set(id, view);
    // 恢复出来的卡（上一步 `view.pendingAsk/Plan`）要一并登进「等用户作答」列表 ——
    // 否则刷新后标题上的「●」不会亮，用户以为没人在等他
    syncAwaiting(id, view);
  },

  createSession: async () => {
    /**
     * 已经是草稿态就直接返回 —— 这就是用户要的那条「新会话」，不需要任何动作，
     * 也就不会留下第二条空会话。「当前会话是空的就别再建一条」这条规则在这里
     * 之所以是**免费**的，正是因为草稿态天然可复用。
     */
    if (get().activeId == null) return;
    // 生成中也允许：当前这条（可能正在跑）被 park 进它自己的会话，循环照旧在后台写
    parkActive();
    set(DRAFT_STATE);
  },

  deleteSessionById: async (id) => {
    const state = get();
    /**
     * 只拦**目标会话在跑**：删一个正在流的会话会让它的循环继续往一张已经不在的行里写。
     * 别的会话在跑不影响删这条空闲的（旧实现是「一有生成就全拦」）。
     */
    if (state.runningIds.includes(id)) return false;
    /**
     * 只有删掉的正是当前会话时才收 pending —— 那张提问卡 / 确认卡属于当前这轮，
     * 删别的会话不该把用户正在答的题作废掉。
    */
    const wasActive = state.activeId === id;
    if (wasActive) releasePending(id);
    disposeQueuedAttachments(readView(id).queued);
    void useChatAttachments.getState().discard(id);

    await db.transaction('rw', db.chats, db.chatSessions, async () => {
      await db.chats.where('sessionId').equals(id).delete();
      await db.chatSessions.delete(id);
    });
    parked.delete(id);
    useChatNotifications.getState().dismiss(id);
    const sessions = await unarchivedSessions();
    set({ sessions });
    // 删的是别人的会话就别动当前这条 —— 用户没要求切会话
    if (wasActive) {
      // 先把活动视图摘干净：否则 `loadSession` 会把这条**已删**的会话 park 回来
      set({ activeId: null, ...EMPTY_VIEW });
      // 落到剩下的最后一条；**一条都不剩就切草稿态**，不再现开一个空会话顶上
      const next = sessions[sessions.length - 1];
      if (next) await get().loadSession(next.id!);
      else set(DRAFT_STATE);
    }
    return true;
  },

  deleteSession: async () => {
    const id = get().activeId;
    if (id == null) return false;
    return get().deleteSessionById(id);
  },

  // ── 会话属性：标题 / 置顶 / 归档 ─────────────────────────────────────────
  /**
   * 改一条会话的布尔/字符串属性，落库 + 同步内存列表。
   *
   * 三条动作（rename / setPinned / setArchived）共用这一个壳：它们对库的操作
   * 都是一次 `modify`，对内存的操作都是 map 出新数组，差别只在允许生成的语义。
   */
  renameSession: async (id, title) => {
    const next = title.trim();
    if (!next) return;
    await patchSession(id, (row) => {
      row.title = next;
    });
  },

  setPinned: async (id, pinned) => {
    await patchSession(id, (row) => {
      if (pinned) row.pinned = true;
      else delete row.pinned;
    });
  },

  setArchived: async (id, archived) => {
    // 归档与删除同源（都会让这条会话从 Recent 消失），所以同样只拦**目标会话在跑**
    if (get().runningIds.includes(id)) return false;
    const wasActive = get().activeId === id;
    // 只有「归档掉正在看的那条」才作废提问卡；恢复时那条会话根本不在 Recent 里，谈不上悬着
    if (archived && wasActive) releasePending(id);
    if (archived) void useChatAttachments.getState().discard(id);
    await patchSession(id, (row) => {
      if (archived) row.archived = true;
      else delete row.archived;
    });
    if (archived) {
      parked.delete(id);
      useChatNotifications.getState().dismiss(id);
    }

    /**
     * 两个方向都要重读整张 Recent 列表：
     * - 归档：那条要从列表里**退出**；
     * - 恢复：那条要从列表里**进来** —— 而 `patchSession` 只能就地替换已存在的行，
     *   它压根不在 `sessions` 里，map 一遍什么也不会发生（实测：恢复后 Recent 里没回来）。
     */
    const sessions = await unarchivedSessions();
    set({ sessions });

    /**
     * 归档完要把当前会话挪走 —— 归档的语义就是「我不想再看它了」。
     * 留在原地的话它已经不在 `sessions` 里了，顶栏标题会掉回默认、
     * 消息区还亮着，而 Recent 里没有一条是选中的。
     *
     * ⚠️ **一个都不剩时切草稿态**（`set(DRAFT_STATE)`），不再现开一个空会话顶上。
     * 上一版是「现开一条」，理由写的是「与删除同款规矩」—— 而懒创建之后那条规矩本身
     * 就变了：删/归档到一条不剩的落脚点是**草稿态**，不是一个新落库的空会话。
     * 这里正是 Recent 里那些「新会话」空壳的来源之一。
     *
     * 只在**归档**时切：恢复是从设置里触发的，用户人还在设置面板上，
     * 替他切走当前会话纯属多余。
     */
    if (archived && wasActive) {
      // 先把活动视图摘干净：否则 `loadSession` 会把这条**刚归档**的会话 park 回来
      set({ activeId: null, ...EMPTY_VIEW });
      const next = sessions[sessions.length - 1];
      if (next) await get().loadSession(next.id!);
      else set(DRAFT_STATE);
    }
    return true;
  },

  archivedSessions: [],
  refreshArchived: async () => {
    const rows = await db.chatSessions.where('videoId').equals(LIBRARY_ASSISTANT_ID).sortBy('createdAt');
    set({ archivedSessions: rows.filter((row) => row.archived) });
  },

  // ── 设置类 ────────────────────────────────────────────────────────────────
  setDraft: (text) => set({ draft: text }),

  setSkillIds: (ids) => {
    const id = get().activeId;
    set({ skillIds: ids });
    // 草稿态：只写内存。那条会话还没落库、没有行可改，这份值会在首条消息落库时
    // 随行一起写进去（见 send）。**不能直接 return 丢掉** —— 那会让用户点了技能范围、
    // 界面看着生效了、发第一条消息时却没了。
    if (id == null) return;
    void db.chatSessions.where('id').equals(id).modify((row) => {
      if (ids === undefined) delete row.skillIds;
      else row.skillIds = ids;
    });
  },

  clearCourseContext: () => {
    const id = get().activeId;
    if (get().contextCourses.length === 0) return;
    set({ contextCourses: [] });
    // 草稿态：只写内存，理由同 setSkillIds
    if (id == null) return;
    void db.chatSessions.where('id').equals(id).modify((row) => {
      delete row.contextCourseIds;
    });
  },

  setCourseContext: async (ids) => {
    const key = activeKey();
    const normalized = normalizeCourseContextIds(ids) ?? [];
    const courses = (await db.videos.bulkGet(normalized)).filter((row) => row != null).map((row) => ({ id: row.id, name: row.name }));
    if (key !== 0) await db.chatSessions.update(key, { contextCourseIds: courses.map((course) => course.id) });
    writeView(key, { contextCourses: courses });
  },

  // ── 发一轮 ────────────────────────────────────────────────────────────────
  send: async (rawText, mode, target, resume, suppliedAttachments) => {
    const state = get();
    /**
     * 目标会话：不传 = 当前活动会话（UI 永远走这条）；只有后台会话的队列续发会带 `target`。
     * 下面所有「读一份视图 / 写一份视图」都以它为准 —— 这就是「切到 B 也能提问」的落点：
     * 两条会话各自带着自己的 key 起一轮，谁的流写谁那份。
     *
     * 续跑（`resume`）直接用它自己的会话 id：那一轮本来就是从这条会话的断点接着跑。
     */
    const key: ViewKey = resume ? resume.sessionId : (target ?? state.activeId ?? 0);
    const view = readView(key);
    const isActive = key === activeKey();
    const fromComposer = suppliedAttachments === undefined && target === undefined && !resume && !view.pendingAsk;
    const pendingFiles = fromComposer ? useChatAttachments.getState().items : [];
    if (pendingFiles.some((item) => !item.value)) {
      useChatAttachments.setState({ error: '请等待附件就绪，或重试 / 移除失败的附件后发送' });
      return;
    }
    let attachments = suppliedAttachments ?? pendingFiles.flatMap((item) => item.value ? [item.value] : []);
    const text = rawText.trim() || (attachments.length ? '请分析这些附件。' : '');
    const consumeAttachments = () => { if (fromComposer) useChatAttachments.getState().consume(attachments.map((file) => file.id)); };
    /**
     * 两道闸。**`loading` 不在其中**：生成期间输入框照常可用（见文件头「流式期间的输入」），
     * 那句话在下面被分流成「排队」或「插入」，而不是被静默吞掉 ——
     * 旧实现就是在这里 `return`，于是用户打了字、按了回车、什么都没发生。
     *
     * `activeId == null`（草稿态）同样不是禁发条件：它正是懒创建要处理的那个状态，
     * 会话行在下面才落库。真正的闸只有 `loaded`（历史没就绪就别发）。
     *
     * 续跑时 `text` 可能为空（方案确认没有用户输入），所以空串那道闸对它放行。
     */
    if (!view.loaded) return;
    if (!resume && !text) return;

    /**
     * 有提问卡悬着时，输入框里的文字是**对这次提问的回答**，不是新一轮提问。
     * 这条**优先于**排队与插入：那时循环在等用户答，不是「正在生成一份回答」，
     * 也就谈不上打断不打断。另起一轮会有两个循环同时往同一个会话写消息，助手与用户消息会交错。
     *
     * 续跑本身就是「对提问的作答」的下游动作，不再往这里拐。
     */
    if (view.pendingAsk && !resume) {
      await get().answerAsk(text);
      return;
    }

    /**
     * 生成中：按投递方式分流（`mode` 是这一次按键的覆盖，不传则用当前默认）。
     *
     * 草稿先清空：话已经交出去了，不管它进的是队列还是新一轮 —— 不清的话队列里多一条、
     * 输入框里还留着原文，用户会以为没生效而再打一遍。**只有活动会话才清草稿**：
     * 后台续发走不了这条（`drainQueue` 已判过非 loading），而且不能把用户当前打了一半的字吃掉。
     */
    if (view.loading) {
      if (isActive && fromComposer) set({ draft: '' });
      consumeAttachments();
      if ((mode ?? state.sendMode) === 'steer') await get().steer(text, attachments);
      else get().enqueue(text, attachments);
      return;
    }

    const userKey = nextKey();
    const aiKey = nextKey();
    let currentKey = aiKey;
    let answer = '';
    let reasoning = '';
    /**
     * 思考用时的首末时刻（首个思考 token → 末个）。中间的停顿是 agent 在调工具，
     * 那几秒不算思考 —— 理由同 ChatPanel 的同名变量。
     */
    let reasoningFrom = 0;
    let reasoningTo = 0;
    /**
     * 最后一轮流出的旁白 + 最后一次工具提示。
     *
     * 留着它们是因为 `onRoundStart` 会把当轮正文清空（旁白不是答案），而**轮次用尽时
     * 模型可能一个字都不说** —— 那时若只有 `answer`，用户看到的就是一片空白，
     * 六轮工具调用等于白跑（实测：只剩一句「（未获得回答）」）。
     */
    let lastNarration = '';
    let lastHint = '';
    /**
     * 这一轮的工具链 + 正在跑的那个工具的开始时刻。
     *
     * 与 `lastHint` 的分工：hint 是**当前那一步**（下一个 delta 来了就清），
     * 工具链是**流水账**，会落库、能回看。工具在 agent 循环里顺序执行，一个时刻变量够用。
     */
    const toolCalls: ChatToolCall[] = [];
    let toolStartedAt = 0;
    /** show_widget 的 HTML 参数流预览；只放静态净化预览，不落库、不执行脚本。 */
    let widgetPreview: { html: string } | undefined;
    /** 实际跑过的轮数（`onRoundStart` 记的）。兜底文案只能印真实值，不能拿设置里的上限顶 */
    let roundsRan = 0;
    /**
     * 护栏停下的情况（见 agent.ts 的 onStop）。
     *
     * 用数组而不是 `let x: T | null`：赋值发生在回调里，TS 的控制流分析在读它的地方
     * 仍然认为它是 `null`（于是 `x?.granted` 报「property does not exist on never」）。
     * 数组取下标不做这种收窄，是这里最省事又不会骗过编译器的写法。
     */
    const stopped: AgentStopInfo[] = [];
    const abort = new AbortController();
    const record = beginInflight(key, abort);
    /**
     * 立刻把这一轮登记成「生成中」，再去做可能 `await` 的懒创建 —— 否则两次极快的发送
     * 会在 `await newSessionRow` 的缝里各建一条会话。**草稿先不动**：懒创建失败时要把用户
     * 打的那句话原样留在输入框里（见下面 `catch`）。
     */
    writeView(key, { loading: true });

    /**
     * 懒创建：草稿态（`activeId == null`）在**这一轮真的开始写**的时候才落库。
     * 这是全仓唯一一处 `newSessionRow()` —— 别在别处再补一个兜底，
     * 那正是 Recent 里那些空壳会话的来源。
     *
     * ⚠️ **顺序是关键：先落库，再往视图里塞消息。** 反过来的话（先乐观 `set` 用户消息、
     * 再落库），落库失败会在界面上留下「一条提问 + 一条报错」却没有对应的会话行 ——
     * 刷新后整段消失，而用户以为自己问过了。失败时草稿**原样留在输入框**里，重试一次就行。
     *
     * `justCreated` 参与下面的标题判定：刚落库的行标题一定是默认值。
     */
    let sessionId = resume ? resume.sessionId : (key === 0 ? null : key);
    let justCreated = false;
    if (sessionId == null) {
      try {
        // 草稿态里用户可能已经选过技能范围（那时只写内存，见 setSkillIds），随行一起落库
        const row = await newSessionRow(view.skillIds, view.contextCourses.map((course) => course.id));
        sessionId = row.id!;
        justCreated = true;
        // 草稿那一轮的登记（key 0）挪到真实 id 上：`stop` / `steer` 按 activeId 找它
        rekeyInflight(0, sessionId);
        set((s) => ({ sessions: [...s.sessions, row], activeId: sessionId }));
      } catch (error) {
        // 这一轮从未开始：把登记与 loading 都收回，别让 `stop()` 去 abort 一个已经作废的控制器，
        // 也别让在等这一轮的 `steer` 一直挂着
        endInflight(0, record);
        set((s) => ({
          loading: false,
          messages: [
            ...s.messages,
            {
              key: aiKey,
              role: 'ai',
              error: true,
              content: `会话创建失败：${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        }));
        return;
      }
    }
    /** 这一轮的会话 id（懒创建之后才确定）。下面所有读写都认它，不再认 `key` */
    const turnKey = sessionId;
    markRunning(turnKey, true);
    // 话已经交出去了：清草稿。放在懒创建**之后** —— 创建失败时草稿要原样留着（见 catch）。
    // 续跑走的是卡片作答（answerAsk 已经把选择写进卡片），与草稿无关，别顺手吃掉用户打了一半的字。
    if (isActive && fromComposer) set({ draft: '' });

    /**
     * 续跑：先把挂起的那条卡片行「结掉」——删检查点、写回选择 / 落库结果。
     *
     * 必须在读历史**之前**：下面按 `resume.rowId` 把历史切到卡片行之前，读到的得是结完的。
     * 只有续跑走这里；活着的循环那条路由 `rotateAi` 落库。
     */
    if (resume) {
      await db.chats.where('id').equals(resume.rowId).modify((row) => {
        delete row.resume;
        row.tools = row.tools?.map((call) => call.status === 'running' && call.name === resume.toolName
          ? { ...call, status: 'done', result: '已收到你的回应' }
          : call);
        if (resume.toolName === 'ask_user' && row.ask && resume.userContent != null) {
          row.ask.picked = resume.userContent;
          row.ask.answer = resume.askAnswer;
        }
        if (resume.toolName === 'propose_folder_plan' && row.folderPlan && resume.planApplied != null) {
          row.folderPlan.applied = resume.planApplied;
        }
      });
      const resumedTools = (await db.chats.get(resume.rowId))?.tools;
      writeView(turnKey, { messages: readView(turnKey).messages.map((message) => message.rowId === resume.rowId
        ? { ...message, tools: resumedTools }
        : message) });
    }

    /**
     * 改**这一条会话**视图里正在流的那条消息。
     *
     * ⚠️ 走 `writeView(turnKey, …)` 而不是 `set`：用户切走后这一轮还在跑，`set` 会把内容
     * 写进「当前在看的那条会话」的视图里 —— 那正是这次要修的串台。
     */
    const updates = framePatch<CourseChatMessage>((patch) => {
      writeView(turnKey, {
        messages: readView(turnKey).messages.map((m) =>
          m.key === currentKey ? { ...m, ...patch } : m,
        ),
      });
    });
    const patchAi = updates.write;
    /**
     * 标题按首条消息生成，判据是「这条会话还没有标题」。
     *
     * 不能只看 `messages.length === 0`：草稿态若落库失败过一轮，视图里已经有那条报错消息，
     * 于是标题永远生成不出来（会话在 Recent 里一直叫「新会话」）。
     */
    const firstMessage = justCreated || readView(turnKey).messages.length === 0;

    /**
     * 回合内累积的消息（`runAgentLoop` 的 `out` 去掉初始 `[system, ...history]` 之后的部分）。
     *
     * `onCheckpoint` 在每次工具执行前刷新它；挂起时截出来存进 `ChatRow.resume`，
     * 刷新后据此从断点续跑，已跑过的工具一次都不重跑（结果本来就在里面）。
     */
    let latestOut: ChatMessage[] | null = null;
    /** 初始消息条数（system + history + 末条）；`midTurn = out.slice(baseLen)` */
    let baseLen = 0;
    /** 挂起点的落库 promise。作答时先等它 —— 否则可能「库里还没这条行、用户已经点了」 */
    let suspendWrite: Promise<void> = Promise.resolve();

    /**
     * 把「挂起中的提问 / 确认」落库：卡片行 + 续跑检查点。
     *
     * 为什么在**挂起时**就落库（而不是等作答）：不落的话刷新时整张卡连题目一起消失；
     * 落了之后答题时改用它（`rotateAi` 走 update），不会多出一条重复行。
     */
    const persistSuspension = async (toolName: 'ask_user' | 'propose_folder_plan') => {
      const message = readView(turnKey).messages.find((m) => m.key === currentKey);
      // 已经落过库就不再写（同一轮不该挂起两次）
      if (!message || message.rowId != null) return;
      const midTurn = latestOut ? latestOut.slice(baseLen) : [];
      const last = midTurn[midTurn.length - 1];
      const call = last?.tool_calls?.find((c) => c.function.name === toolName) ?? last?.tool_calls?.[0];
      const rowId = (await db.chats.add({
        videoId: LIBRARY_ASSISTANT_ID,
        sessionId: turnKey,
        role: 'assistant',
        content: message.content,
        createdAt: Date.now(),
        reasoning: message.reasoning,
        ...(message.tools ? { tools: message.tools } : {}),
        ...(message.widget ? { widget: message.widget } : {}),
        ...(message.widgets ? { widgets: message.widgets } : {}),
        ...(message.ask ? { ask: message.ask } : {}),
        ...(message.folderPlan ? { folderPlan: message.folderPlan } : {}),
        resume: { toolName, toolCallId: call?.id ?? '', midTurn },
      })) as number;
      patchAi({ rowId });
    };

    /**
     * 在「用户回应」处把消息**封口并另起一条**。
     *
     * 为什么要拆：提问卡（第 1 轮）与它的回答（第 2 轮）本来是两条消息的内容，挤在同一条里
     * 读起来是「先给结论、下面才是问题」，而用户点选的那句话还会落在回答之后 —— 因果全反。
     * 拆开后 transcript 是「卡片 → 用户的选择 → 回答」，与真实顺序一致。
     *
     * 顺带的好处：卡片那条**当场落库**（挂起时已写，这里改为 update），
     * 「问完就关掉浏览器」也不会把卡弄丢。
     */
    const rotateAi = async () => {
      updates.flush();
      const message = readView(turnKey).messages.find((m) => m.key === currentKey);
      if (!message) return;
      // 用户回应后，这张卡的确认步骤已结束。过程记录留在原消息，不重复到下一条回答。
      const closedTools = message.tools?.map((call): ChatToolCall =>
        call.status === 'running' && (call.name === 'ask_user' || call.name === 'propose_folder_plan')
          ? { ...call, status: 'done', result: '已收到你的回应' }
          : call);
      let rowId = message.rowId;
      if (rowId != null) {
        // 挂起时已落过库：改成 update，并把检查点结掉（这一轮不再可续跑）
        await db.chats.where('id').equals(rowId).modify((row) => {
          row.content = message.content;
          if (message.reasoning) row.reasoning = message.reasoning;
          else delete row.reasoning;
          if (closedTools) row.tools = closedTools;
          if (message.widget) row.widget = message.widget;
          else delete row.widget;
          if (message.widgets) row.widgets = message.widgets;
          else delete row.widgets;
          if (message.ask) row.ask = message.ask;
          else delete row.ask;
          if (message.folderPlan) row.folderPlan = message.folderPlan;
          else delete row.folderPlan;
          delete row.resume;
        });
      } else {
        rowId = (await db.chats.add({
          videoId: LIBRARY_ASSISTANT_ID,
          sessionId: turnKey,
          role: 'assistant',
          content: message.content,
          createdAt: Date.now(),
          reasoning: message.reasoning,
          ...(closedTools ? { tools: closedTools } : {}),
          ...(message.widget ? { widget: message.widget } : {}),
          ...(message.widgets ? { widgets: message.widgets } : {}),
          ...(message.ask ? { ask: message.ask } : {}),
          ...(message.folderPlan ? { folderPlan: message.folderPlan } : {}),
        })) as number;
      }
      const fresh = nextKey();
      writeView(turnKey, {
        messages: [
          ...readView(turnKey).messages.map((m) =>
            m.key === currentKey ? { ...m, rowId, tools: closedTools, streaming: false, hint: undefined } : m,
          ),
          { key: fresh, role: 'ai', content: '', streaming: true },
        ],
      });
      currentKey = fresh;
      answer = '';
      reasoning = '';
      reasoningFrom = 0;
      reasoningTo = 0;
      toolCalls.length = 0;
      toolStartedAt = 0;
      lastNarration = '';
      lastHint = '';
    };

    const holdAsk = (ask: AskUserData) =>
      new Promise<AskUserAnswer | string>((resolve) => {
        patchAi({ ask: { ...ask } });
        writeView(turnKey, {
          pendingAsk: {
            messageKey: currentKey,
            resolve: async (picked) => {
              // 先等挂起点的落库完成：否则 rotateAi 认不出这条行、会另写一条重复的
              await suspendWrite;
              await rotateAi();
              resolve(picked);
            },
          },
        });
        // 落库失败不能让这一轮永远挂着：`resolve` 里要 `await suspendWrite`，
        // 未捕获的拒绝会顺带吞掉 `resolve(picked)`。失败就退化成「这次不落检查点」，
        // 卡片照常能作答（与旧行为一致），只是刷新后恢复不了。
        suspendWrite = persistSuspension('ask_user').catch(() => {});
      });
    const holdPlan = (plan: FolderPlan) =>
      new Promise<{ ok: boolean; result: AppliedPlanResult | null }>((resolve) => {
        patchAi({ folderPlan: { ...plan, applied: 0 } });
        writeView(turnKey, {
          pendingPlan: {
            messageKey: currentKey,
            resolve: async (verdict) => {
              await suspendWrite;
              await rotateAi();
              resolve(verdict);
            },
          },
        });
        suspendWrite = persistSuspension('propose_folder_plan').catch(() => {});
      });

    const userCreatedAt = Date.now();
    writeView(turnKey, {
      messages: [
        ...readView(turnKey).messages,
        // 续跑：用户那句「回答」由 resume.userContent 给出（方案确认没有）；
        // 普通一轮：就是这次发的 text。
        ...(resume == null
          ? [{ key: userKey, role: 'user' as const, content: text, attachments, createdAt: userCreatedAt }]
          : resume.userContent != null
            ? [{ key: userKey, role: 'user' as const, content: resume.userContent, createdAt: userCreatedAt }]
            : []),
        { key: aiKey, role: 'ai', content: '', streaming: true },
      ],
    });

    try {
      /**
       * 落一条 user 行。
       *
       * 续跑时它就是「对提问卡的作答」（方案确认没有 → `undefined`，不落）；普通一轮是这次发的 text。
       */
      const userRowContent = resume ? resume.userContent : text;
      if (userRowContent != null) {
        const userRowId = await db.chats.add({
          videoId: LIBRARY_ASSISTANT_ID,
          sessionId: turnKey,
          role: 'user',
          content: userRowContent,
          ...(attachments.length ? { attachments } : {}),
          createdAt: userCreatedAt,
        });
        consumeAttachments();
        writeView(turnKey, { messages: readView(turnKey).messages.map((message) => message.key === userKey ? { ...message, rowId: userRowId as number } : message) });
        if (attachments.some((file) => file.dataUrl)) {
          patchAi({ hint: '正在读取图片…' });
          attachments = await attachmentsForModel(attachments, text, abort.signal);
          await db.chats.update(userRowId, { attachments });
          writeView(turnKey, { messages: readView(turnKey).messages.map((message) => message.key === userKey ? { ...message, attachments } : message) });
        }
      }

      if (firstMessage) {
        const title = text.length > 18 ? `${text.slice(0, 18)}…` : text;
        await db.chatSessions.update(turnKey, { title });
        set((s) => ({ sessions: s.sessions.map((row) => (row.id === turnKey ? { ...row, title } : row)) }));
      }

      const settings = getSettings();
      /**
       * 课程数**每轮现查**，不用 store 里那个 `courseCount`。
       *
       * 用户很可能在课程库导入完就切回对话页 —— 那个计数是 bootstrap 时读的快照，
       * 拿它判断「有没有课」会让刚导入完的第一轮仍按空库模式回答。
       */
      const courseCount = await db.videos.count();
      const hasCourses = courseCount > 0;
      set({ courseCount });
      /**
       * 空库时必须把上下文课程清空，不能只靠提示词绕开。
       *
       * 场景：用户先导入课程 → 助手把上下文设成某门课 → 用户回课程库把它删了 →
       * 回到对话页继续问。这时 `contextCourses` 里还挂着那个已不存在的 courseId，
       * 提示词会宣称「当前课程上下文：《已删除的课》」—— 那是在对着幽灵上课。
       */
      let contextCourses = view.contextCourses;
      if (!hasCourses && contextCourses.length > 0) {
        contextCourses = [];
        writeView(turnKey, { contextCourses });
        await db.chatSessions.where('id').equals(turnKey).modify((row) => {
          delete row.contextCourseIds;
        });
      }
      const [history, skillMetas] = await Promise.all([
        db.chats.where('sessionId').equals(turnKey).sortBy('createdAt'),
        loadSessionSkillMeta(view.skillIds),
      ]);
      const skillBlock = skillMetas.length > 0 ? skillMetaBlock(skillMetas) : undefined;
      const systemPrompt = libraryAssistantSystemPrompt(skillBlock, contextCourses, hasCourses);
      /**
       * 续跑要用的是「这一轮开始前」的历史：
       * - 普通一轮：刚写的 user 行之前（`slice(0, -1)`）；
       * - 续跑：**卡片行之前**（卡片行由 `midTurn` 里的等价消息补回，留在这里就会重复一份）。
       *
       * 找不到卡片行（不该发生）时退回整段历史，宁可多带一点也别把上下文切没了。
       */
      const cut = resume ? history.findIndex((row) => row.id === resume.rowId) : history.length - 1;
      const baseRows = history.slice(0, cut < 0 ? history.length : cut).map((row) => ({ ...row, originalContent: row.content, content: attachmentText(row.content, row.attachments) }));
      const tail: ChatMessage = resume
        ? { role: 'tool', tool_call_id: resume.toolCallId, name: resume.toolName, content: resume.toolResult }
        : messageForModel({ role: 'user', content: text, attachments });
      const tailText = resume ? resume.toolResult : attachmentText(text, attachments);
      const imageBudget = attachments.filter((file) => file.dataUrl).length * 1600;
      const budget = settings.contextWindow - estimateTokens(systemPrompt) - estimateTokens(tailText) - imageBudget - 4096;
      if (budget < 0) throw new Error('附件正文超过当前模型的上下文预算，请减少附件、改用更大上下文模型，或将文件导入课程库后检索');
      // 挂起续跑保持原有历史与工具链，不重新做语义筛选。
      const recent = resume
        ? fitHistoryToBudget(baseRows, Math.max(2000, budget))
        : await prepareSessionHistory(turnKey, baseRows, Math.max(2000, budget), text, settings.jev, {
            signal: abort.signal,
            onStart: () => patchAi({ hint: 'Jev 正在筛选历史上下文…' }),
            onCompressed: (turns) => patchAi({ hint: `已省略 ${turns} 个旧轮次，原始记录保留` }),
          });
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...await historyMessagesWithAttachments(recent, abort.signal),
        // 续跑：把挂起点之前攒下的 assistant tool_calls 与工具结果原样拼回，
        // 于是旧工具一次都不用重跑 —— 结果本来就在里面。
        ...(resume ? resume.midTurn : []),
        tail,
      ];
      // 记录初始长度，供 onCheckpoint 截出「本回合新增的部分」（midTurn）
      baseLen = chatMessages.length;

      const executeTool = createResourceExecutor({
        allowedSkillIds: view.skillIds,
        onWidget: (w) => {
          // 校验与文档预检通过后才切换到真正的隔离 iframe。流式中间帧
          // 始终由 StreamingHtmlPreview 以静态白名单方式显示。
          widgetPreview = undefined;
          updates.flush();
          const current = readView(turnKey).messages.find((message) => message.key === currentKey);
          const widgets = current?.widgets ?? (current?.widget ? [current.widget] : []);
          patchAi({ widget: w, widgets: [...widgets, w], widgetPreview: undefined });
        },
        library: {
          contextCourseIds: contextCourses.map((course) => course.id),
          onContextChange: async (courses) => {
            writeView(turnKey, { contextCourses: courses });
            await db.chatSessions.where('id').equals(turnKey).modify((row) => {
              if (courses.length === 0) delete row.contextCourseIds;
              else row.contextCourseIds = courses.map((course) => course.id);
            });
          },
          onAskUser: holdAsk,
          onPlanFolders: holdPlan,
        },
      });

      await runAgentLoop(
        chatMessages,
        toolsForLibrary(hasCourses),
        executeTool,
        {
          // 档位一律传下去，关着思考就传 'none'：thinkingParams 会按模型声明决定发哪个字段 ——
          // 只有开关的模型（Qwen3.5 系、部分 DeepSeek）拿不到深度参数，但 `enable_thinking` 照发，
          // 所以这里用 supportsThinking 而不是 hasThinkingDepth（后者只管 UI 显示）。
          // 「关着」传 'none' 而不是不传：不传等于连 `enable_thinking: false` 都不发，
          // 混合思考模型（默认开着的那种）压根没被关掉。
          thinkingEffort: supportsThinking(catalogOf(settings, settings.llmModel.providerId), settings.llmModel.model, modelOverridesOf(settings, settings.llmModel))
            ? settings.thinkingEnabled
              ? settings.thinkingEffort
              : 'none'
            : undefined,
          onReasoningDelta: (delta) => {
            reasoning += delta;
            const now = Date.now();
            const first = !reasoningFrom;
            if (first) reasoningFrom = now;
            reasoningTo = now;
            // 起点随首个 token 一起上屏：思考中那行「已用时 x 秒」按它算（不落库，见字段注释）
            updates.stream({ reasoning, processPhase: 'thinking', ...(first ? { reasoningStartedAt: now } : {}) });
          },
          onDelta: (delta) => {
            answer += delta;
            updates.stream({ content: answer, hint: undefined, processPhase: 'answering' });
          },
          onRoundStart: () => {
            // 上一轮流出的只是检索旁白，答案要等后面的轮次 —— 但**存一份**：
            // 轮次用尽而模型不吭声时，它是用户唯一能看到「它干了什么」的线索
            if (answer.trim()) lastNarration = answer.trim();
            answer = '';
            roundsRan++;
            widgetPreview = undefined;
            patchAi({ content: '', hint: undefined, widgetPreview: undefined, processPhase: 'preparing' });
          },
          onToolStart: (name, argsJson) => {
            lastHint = toolHint(name, argsJson, '正在读取资料…');
            toolStartedAt = Date.now();
            toolCalls.push({ name, detail: toolDetail(name, argsJson), status: 'running', reasoningOffset: reasoning.length });
            patchAi({ hint: lastHint, tools: [...toolCalls], processPhase: 'tool' });
          },
          onToolCallDelta: (call) => {
            updates.stream({ processPhase: 'preparing' });
            if (call.name !== 'show_widget') return;
            const partial = readPartialWidgetArguments(call.arguments);
            if (partial.format !== 'html' || !partial.code) return;
            widgetPreview = { html: partial.code.slice(0, 60_000) };
            patchAi({ widgetPreview, hint: '正在生成交互图形…' });
          },
          onToolEnd: (name, result) => {
            // 顺序执行 ⇒ 正在跑的那条就是末尾那条（同一个工具可能被连调多次，不能按名字反查）
            const current = toolCalls[toolCalls.length - 1];
            if (current && current.name === name && current.status === 'running') {
              const ms = toolStartedAt ? Date.now() - toolStartedAt : undefined;
              toolCalls[toolCalls.length - 1] = {
                ...current,
                status: isToolFailure(result) ? 'error' : 'done',
                result: summarizeToolResult(result),
                ...(ms != null ? { ms } : {}),
              };
              patchAi({ tools: [...toolCalls], processPhase: 'preparing', hint: undefined });
            }
            // 参数校验 / 安全预检失败，或参数因 token 截断而未执行，
            // 都不能把半成品留在最终回答里。
            if (name === 'show_widget') {
              widgetPreview = undefined;
              patchAi({ widgetPreview: undefined });
            }
            toolStartedAt = 0;
          },
          /**
           * 挂起点落库用：每次工具执行前把当前 `out` 交出来。`holdAsk` / `holdPlan`
           * 触发时截出 `midTurn` 存进 `ChatRow.resume`（见 persistSuspension）。
           */
          onCheckpoint: (out) => {
            latestOut = out;
          },
          onStop: (info) => {
            stopped.push(info);
          },
          signal: abort.signal,
        },
        resolveMaxRounds(settings.agentRounds),
      );
      const closeOut = stopped[stopped.length - 1];
      const finalAnswer = answer.trim() || noAnswerNotice({
        // 没有 closeOut 只可能是「循环正常结束却一个字没说」——那正是 `empty` 这条闸管的事，
        // 猜成 `rounds` 会印出「已到轮次上限」这种从未发生过的原因（实测文案：0 次工具调用）
        reason: closeOut?.reason ?? 'empty',
        rounds: closeOut?.rounds ?? roundsRan,
        ...(closeOut?.detail ? { detail: closeOut.detail } : {}),
        requestedTools: closeOut?.requestedTools ?? [],
        narration: lastNarration,
        hint: lastHint,
      });
      /** 一帧都没来过就别记 0（那会让「已思考用时 0.0 秒」看着像 bug） */
      const reasoningMs = reasoningFrom ? reasoningTo - reasoningFrom : undefined;
      patchAi({ content: finalAnswer, streaming: false, hint: undefined, reasoningMs, widgetPreview: undefined });
      // 落的是**当前这条**（`currentKey` 可能已经因提问/方案而轮换过一次），
      // 卡片状态也从 store 里这条消息读，而不是读闭包里的副本：用户可能在这期间点了选项
      // （ask.picked 变了）或确认了方案（applied 变了），那些更新只落在 store 上。
      const finalMessage = readView(turnKey).messages.find((m) => m.key === currentKey);
      const rowId = (await db.chats.add({
        videoId: LIBRARY_ASSISTANT_ID,
        sessionId: turnKey,
        role: 'assistant',
        content: finalAnswer,
        createdAt: Date.now(),
        reasoning: reasoning || undefined,
        reasoningMs,
        ...(toolCalls.length > 0 ? { tools: toolCalls } : {}),
        ...(finalMessage?.widget ? { widget: finalMessage.widget } : {}),
        ...(finalMessage?.widgets ? { widgets: finalMessage.widgets } : {}),
        ...(finalMessage?.ask ? { ask: finalMessage.ask } : {}),
        ...(finalMessage?.folderPlan ? { folderPlan: finalMessage.folderPlan } : {}),
      })) as number;
      patchAi({ rowId });
    } catch (error) {
      /**
       * 用户中止了请求 —— 但「中止」有两种意图（见 `AbortIntent`），留下的痕迹不同：
       * 按停止键是「到此为止」，插入新消息是「换个方向」。两者都不算错误。
       */
      if (abort.signal.aborted) {
        const partial = answer.trim() || lastNarration.trim();
        const currentWidget = readView(turnKey).messages.find((m) => m.key === currentKey)?.widget;
        const currentWidgets = readView(turnKey).messages.find((m) => m.key === currentKey)?.widgets;
        // 停在思考中途照样计时：那正是用户中止时最想知道的一个数
        const reasoningMs = reasoningFrom ? Date.now() - reasoningFrom : undefined;
        const bySteer = record.intent === 'steer';
        /**
         * 这一轮除了正文之外还留下了什么（工具链 / 半截回答）。
         *
         * 刻意不把「只有思考、没有正文、也没调过工具」算作留下东西：那种状态本来就
         * 没有可展示的内容，留着就是一条空白气泡。
         */
        const hasRemains = !!partial || toolCalls.length > 0;

        if (bySteer && !hasRemains) {
          /**
           * 插入打断，且这一轮**什么都没留下**：把这条气泡整个摘掉。
           *
           * 不能沿用下面「已停止生成」那条：插入的语义是「换个方向」，在用户刚说的
           * 那句话上面挂一条写着「已停止生成」的白板，读起来像这一轮失败了 ——
           * 而用户其实只是改了个口。库里也不落这一行（一条空的 assistant 在历史里没有意义，
           * 发请求时同样会被 messageHygiene 丢掉）。
           */
          writeView(turnKey, {
            messages: readView(turnKey).messages.filter((m) => m.key !== currentKey),
          });
        } else if (bySteer) {
          /**
           * 插入打断，但已经写出了半截（或至少跑过工具）：**留住**。
           *
           * 这是「打断不等于丢弃」那条规则的落点（Claude Code 的插队也是保留已完成的工作）。
           * 标成 `interrupted` 而不是把「已停止生成」嵌进正文：那半截要能当 assistant 前缀
           * 接着写，正文里夹一句系统口吻的说明会污染它（理由与上面非 abort 那条完全相同）。
           */
          patchAi({
            streaming: false,
            hint: undefined,
            content: partial,
            interrupted: true,
            interruptReason: STEER_INTERRUPT_REASON,
            reasoningMs,
            widgetPreview: undefined,
          });
          // 先解锁输入再落库，理由同下面非 abort 那条
          writeView(turnKey, { loading: false });
          const rowId = (await db.chats.add({
            videoId: LIBRARY_ASSISTANT_ID,
            sessionId: turnKey,
            role: 'assistant',
            content: partial,
            createdAt: Date.now(),
            reasoning: reasoning || undefined,
            reasoningMs,
            ...(toolCalls.length > 0 ? { tools: toolCalls } : {}),
            ...(currentWidget ? { widget: currentWidget } : {}),
            ...(currentWidgets ? { widgets: currentWidgets } : {}),
            interrupted: true,
            interruptReason: STEER_INTERRUPT_REASON,
          })) as number;
          patchAi({ rowId });
        } else {
          /**
           * 按了停止键：保留已经流出的内容，只补一句「已停止」——
           * 报成「回答失败：The user aborted a request」只会让人以为出问题了。
           * **必须落库**：停止之后这段内容要留住，否则刷新就没了，等于「停止」= 白生成一轮。
           */
          const content = partial ? `${partial}\n\n_（已停止生成）_` : '_（已停止生成）_';
          patchAi({ streaming: false, hint: undefined, content, reasoningMs, widgetPreview: undefined });
          // 立刻恢复可输入：下面还要落一次库，等它落完才解锁的话，用户按完停止还得干等
          writeView(turnKey, { loading: false });
          const rowId = (await db.chats.add({
            videoId: LIBRARY_ASSISTANT_ID,
            sessionId: turnKey,
            role: 'assistant',
            content,
            createdAt: Date.now(),
            reasoning: reasoning || undefined,
            reasoningMs,
            ...(toolCalls.length > 0 ? { tools: toolCalls } : {}),
            ...(currentWidget ? { widget: currentWidget } : {}),
            ...(currentWidgets ? { widgets: currentWidgets } : {}),
          })) as number;
          patchAi({ rowId });
        }
      } else {
        /**
         * 非 abort 的失败：**已经流出来的内容必须落库**。
         *
         * 旧实现只 `patchAi` 到内存、从不落库，于是刷新页面或切走再回来，那一轮整段消失 ——
         * 用户看到的是「问过了，什么都没有」。这就是「流式一失败就什么都不显示」的成因，
         * 也是本轮要修的那条。
         *
         * 落库时**不把「回答中断：xxx」嵌进正文**（与上面「停止」那条不同）：这段内容要能
         * 当 assistant 前缀发给模型接着写（见 `continueInterrupted`），正文里夹一句系统口吻的
         * 中文说明会污染它 —— 模型很可能接着那句话往下写。中断是这条消息的**元数据**，
         * 走 `interrupted` / `interruptReason` 两个字段。
         */
        const reason = error instanceof Error ? error.message : String(error);
        const partial = answer.trim();
        const currentWidget = readView(turnKey).messages.find((m) => m.key === currentKey)?.widget;
        const currentWidgets = readView(turnKey).messages.find((m) => m.key === currentKey)?.widgets;
        if (!partial) {
          // 一个字都没流出来（多半是请求压根没发出去）：没有可续写的东西，照旧报错。
          // 不落库 —— 一条空的 assistant 在历史里没有意义（发请求时也会被 messageHygiene 丢掉）。
          if (currentWidget) {
            // The widget is already a complete, validated answer even when the
            // follow-up text request failed. Keep it as a resumable assistant
            // row instead of leaving a successful tool result only in memory.
            patchAi({
              streaming: false,
              hint: undefined,
              content: '',
              interrupted: true,
              interruptReason: reason,
              reasoningMs: reasoningFrom ? Date.now() - reasoningFrom : undefined,
              widgetPreview: undefined,
            });
            writeView(turnKey, { loading: false });
            const rowId = (await db.chats.add({
              videoId: LIBRARY_ASSISTANT_ID,
              sessionId: turnKey,
              role: 'assistant',
              content: '',
              createdAt: Date.now(),
              reasoning: reasoning || undefined,
              ...(toolCalls.length > 0 ? { tools: toolCalls } : {}),
              widget: currentWidget,
              widgets: currentWidgets,
              interrupted: true,
              interruptReason: reason,
            })) as number;
            patchAi({ rowId });
          } else {
            // 一个字都没流出来（多半是请求压根没发出去）：没有可续写的东西，照旧报错。
            // 不落库 —— 一条空的 assistant 在历史里没有意义（发请求时也被丢掉）。
            patchAi({ streaming: false, hint: undefined, error: true, content: `回答失败：${reason}` });
          }
        } else {
          // 停在思考中途照样计时：那正是用户最想知道的一个数（与停止那条同款）
          const reasoningMs = reasoningFrom ? Date.now() - reasoningFrom : undefined;
          patchAi({
            streaming: false,
            hint: undefined,
            content: partial,
            interrupted: true,
            interruptReason: reason,
            reasoningMs,
            widgetPreview: undefined,
          });
          // 先解锁输入再落库：落库要一次 IndexedDB 往返，等它落完才解锁会让用户干等
          writeView(turnKey, { loading: false });
          const rowId = (await db.chats.add({
            videoId: LIBRARY_ASSISTANT_ID,
            sessionId: turnKey,
            role: 'assistant',
            content: partial,
            createdAt: Date.now(),
            reasoning: reasoning || undefined,
            reasoningMs,
            ...(toolCalls.length > 0 ? { tools: toolCalls } : {}),
            ...(currentWidget ? { widget: currentWidget } : {}),
            ...(currentWidgets ? { widgets: currentWidgets } : {}),
            interrupted: true,
            interruptReason: reason,
          })) as number;
          patchAi({ rowId });
        }
      }
    } finally {
      // 悬着的提问/确认在这里一定已经有人 resolve 过（正常路径），但异常路径下可能还挂着 ——
      // releasePending 会把没 resolve 的收掉，绝不让某个 promise 永远等下去。
      releasePending(turnKey);
      /**
       * 顺序要紧：先注销这一轮（放行在等收尾的 `steer`），再解锁输入，最后发下一条。
       *
       * `endInflight` 只 resolve 一个 promise，等它的人要等当前这个同步块跑完才轮到 ——
       * 所以 `steer` 醒来时看到的必然已经是 `loading: false` + 队列就位。
       */
      endInflight(turnKey, record);
      writeView(turnKey, { loading: false });
      markRunning(turnKey, false);
      if (!abort.signal.aborted && readView(turnKey).queued.length === 0) {
        useChatNotifications.getState().complete(turnKey);
      }
      /**
       * 这一轮结束了（正常答完 / 出错 / 被停止打断 / 被插入打断），队首那条自动往下走。
       *
       * **被停止打断也发**：这是刻意的，与 Claude Code 一致 ——
       * 「取消一次运行不会把已经排在后面的补充说明一起丢掉，它只是接着跑」。
       * 用户真想让整个队列停下，工具栏那条队列条上有「清空」。
       */
      drainQueue(turnKey);
    }
  },

  // ── 流式期间的输入：排队 / 插入 ─────────────────────────────────────────────
  setSendMode: (mode) => set({ sendMode: mode }),

  enqueue: (text, attachments = []) => {
    const next = text.trim();
    if (!next) return;
    set((s) => ({ queued: [...s.queued, { id: nextQueuedId(), text: next, attachments }] }));
  },

  removeQueued: (id) => {
      const item = get().queued.find((entry) => entry.id === id);
      if (!item) return;
      set((s) => ({ queued: s.queued.filter((entry) => entry.id !== id) }));
      disposeQueuedAttachments([item]);
    },

  updateQueued: (id, text) => {
    const next = text.trim();
    // 改成空白 = 删掉这条：留一条永远发不出去的空气泡，只会让队列看着还在做事
    if (!next && !get().queued.find((item) => item.id === id)?.attachments?.length) return get().removeQueued(id);
    set((s) => ({ queued: s.queued.map((item) => (item.id === id ? { ...item, text: next } : item)) }));
  },

  clearQueue: () => {
    const items = get().queued;
    set({ queued: [] });
    disposeQueuedAttachments(items);
  },

  sendQueuedNow: async (id) => {
    const item = get().queued.find((entry) => entry.id === id);
    if (!item) return;
    // 先出队再插：`steer` 会走 `send`，那条路可能失败 —— 但让它同时留在队里就会出现两条一样的消息
    set((s) => ({ queued: s.queued.filter((entry) => entry.id !== id) }));
    await get().steer(item.text || '请分析这些附件。', item.attachments);
  },

  steer: async (rawText, attachments = []) => {
    const text = rawText.trim();
    if (!text) return;
    // 只打断**当前在看的那条会话**；别的一条在后台跑不关它的事
    const turn = inflight.get(activeKey());
    /**
     * 没有真正在跑的一轮 —— 没什么可打断的，当普通发送。
     *
     * 这条路径真的会走到：`loading` 与「有一条请求在飞」之间隔着建会话、落库几步，
     * 而界面上的插入按钮只看得到 `loading`。
     */
    if (turn == null) {
      await get().send(text, undefined, undefined, undefined, attachments);
      return;
    }
    turn.intent = 'steer';
    turn.abort.abort();
    // 等这一轮收尾（落库写完、loading 置回）。不等的话下面那次 send 会被自己的分发逻辑
    // 当成「生成中」，于是插入变成排队 —— 反了
    const targetKey = activeKey();
    await inflightDone.get(targetKey);
    /**
     * 等收尾的这几百毫秒里可能又有人插了一条（于是新一轮已经在跑）：
     * 那这条**降级成排队**，绝不让它凭空消失。
     */
    if (readView(targetKey).loading) {
      writeView(targetKey, { queued: [...readView(targetKey).queued, { id: nextQueuedId(), text, attachments }] });
      return;
    }
    await get().send(text, undefined, targetKey, undefined, attachments);
  },

  // ── 停止生成 ──────────────────────────────────────────────────────────────
  stop: () => {
    // 只断**当前在看的那条会话**的 LLM 请求与循环；悬着的提问/方案由 releasePending 收掉
    // （`finally` 里统一做）。后台另有一条在跑时，它不受影响 —— 这是「真并发」的应有之义。
    const turn = inflight.get(activeKey());
    if (turn) turn.intent = 'stop';
    turn?.abort.abort();
  },

  // ── 重试 / 分支 ───────────────────────────────────────────────────────────
  deleteMessage: async (key, sessionId) => {
    if (sessionId == null || get().activeId !== sessionId) return false;
    const view = readView(sessionId);
    const message = view.messages.find((item) => item.key === key);
    if (view.loading || !message || message.streaming || message.rowId == null) return false;
    const deleted = await db.transaction('rw', db.chats, async () => {
      if (readView(sessionId).loading) return false;
      const row = await db.chats.get(message.rowId!);
      if (!row || row.sessionId !== sessionId) return false;
      await db.chats.delete(message.rowId!);
      return true;
    });
    if (!deleted) return false;
    writeView(sessionId, { messages: readView(sessionId).messages.filter((item) => item.key !== key) });
    return true;
  },

  retryMessage: async (key) => {
    const state = get();
    if (state.loading) return;
    const message = state.messages.find((m) => m.key === key);
    if (!message) return;
    const sessionId = state.activeId;

    /**
     * 没有正文的失败回答没有 rowId，但仍要能从回答旁边的「继续回答」入口重跑。
     * 普通失败时 user 行已经落库、失败的 assistant 行没有落库；草稿态连会话行都还没有，
     * 此时 send 的文本仍保留在输入框里。
     */
    if (message.error) {
      if (sessionId == null) {
        const retryText = state.draft.trim();
        if (!retryText) return;
        set((s) => ({ messages: s.messages.filter((m) => m.key !== key) }));
        await get().send(retryText);
        return;
      }

      const messageIndex = state.messages.findIndex((m) => m.key === key);
      const user = messageIndex > 0 ? state.messages[messageIndex - 1] : undefined;
      if (!user || user.role !== 'user' || messageIndex !== state.messages.length - 1) return;

      const rows = await db.chats.where('sessionId').equals(sessionId).sortBy('createdAt');
      const userRow = [...rows].reverse().find((row) =>
        row.role === 'user'
        && row.content === user.content
        && row.createdAt === user.createdAt,
      );
      if (userRow?.id == null) return;

      await db.chats.delete(userRow.id);
      set((s) => ({ messages: s.messages.slice(0, messageIndex - 1) }));
      await get().send(user.content, undefined, sessionId, undefined, userRow.attachments ?? []);
      return;
    }

    // 还没落库的消息没有可续写的「断点」，也没有可删的行（正在流的那条就是如此）
    if (sessionId == null || message.rowId == null) return;

    /**
     * 用户提问的重试 = **重新回答这句话**。
     *
     * 与下面助手那条 ② 号分支是同一件事的两个入口：都是「删掉这一问一答、再重发同一句」。
     * 为什么提问也该有入口：用户想「换一次回答」时，视线往往还停在**自己刚打完的那句**上，
     * 而不是下面那条回答的末尾 —— 两处都该点得到（见 CourseChat 的 MessageActions）。
     *
     * 判据同 ②：只在这条提问的答复**就是最后一条**时允许。删掉它后面所有消息是一次
     * 不可见的批量删除，用户会看到会话凭空少一段；要改历史中间那一步，正确动作是「分支」。
     */
    if (message.role === 'user') {
      const idx = state.messages.findIndex((m) => m.key === key);
      // 必须是「提问 + 它的回答」这样的一对，且这一对**就在末尾**
      if (state.messages[idx + 1]?.role !== 'ai' || idx !== state.messages.length - 2) return;
      const rows = await db.chats.where('sessionId').equals(sessionId).sortBy('createdAt');
      const rowIdx = rows.findIndex((row) => row.id === message.rowId);
      if (rowIdx < 0) return;
      /**
       * 这一问之后落库的行整体删掉（正常情况下就是「提问行 + 回答行」两行）。
       * 为什么连提问行也删：`send` 会重新落一条 user 行，留着原来那条会让历史里
       * 出现两条一模一样的提问 —— 与 ② 里删 userRow 的理由相同。
       *
       * 用 `slice(rowIdx)` 而不是「删提问 + 删它后面那条」：回答一个字都没流出来时
       * （`error` 那条路径不落库）这里只有提问一行，写死删两行会删掉下一轮的内容。
       */
      const tail = rows.slice(rowIdx);
      await db.transaction('rw', db.chats, async () => {
        for (const row of tail) if (row.id != null) await db.chats.delete(row.id);
      });
      // 视图同步摘掉这一问一答，剩下的交给 `send` 重新落库并跑完整的一轮
      set((s) => ({ messages: s.messages.slice(0, idx) }));
      await get().send(message.content, undefined, sessionId, undefined, rows[rowIdx].attachments ?? []);
      return;
    }

    // ① 中断过的回答 → **续写**：不碰历史，只把没写完的部分补完
    if (message.interrupted) {
      await continueInterrupted(key, message, sessionId);
      return;
    }

    /**
     * ② 完整回答 → **重新生成**：删掉这条回答**和它前面那条 user 提问**，再交给 `send`
     * 重跑一遍。
     *
     * 为什么连 user 行一起删：`send` 会重新落一条 user 行，留着原来那条的话历史里就有了
     * 两条一模一样的提问（模型会以为用户问了两次）。
     *
     * 为什么只允许「这条是最后一条消息」：删掉它后面所有消息是一次**不可见的批量删除**，
     * 用户会看到一条会话凭空少了一段。要改历史中间的一步，正确动作是「分支」——
     * 原会话完全不动、新会话可对比（见 `forkSession`）。
     */
    const rows = await db.chats.where('sessionId').equals(sessionId).sortBy('createdAt');
    const idx = rows.findIndex((row) => row.id === message.rowId);
    if (idx < 0 || idx !== rows.length - 1) return;
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (rows[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return;
    const userRow = rows[userIdx];

    await db.transaction('rw', db.chats, async () => {
      await db.chats.delete(message.rowId!);
      await db.chats.delete(userRow.id!);
    });
    // 视图同步摘掉这两条，剩下的交给 `send` —— 它会重新落库并跑完整的一轮
    set((s) => ({
      messages: s.messages.filter((m) => m.rowId !== message.rowId && m.rowId !== userRow.id),
    }));
    await get().send(userRow.content, undefined, sessionId, undefined, userRow.attachments ?? []);
  },

  forkSession: async (sessionId, uptoRowId) => {
    // 只拦**目标会话在跑**：库里还没有那条正在流的消息，复制出来的会话会缺一截。
    // 别的会话在后台跑不影响分支一条空闲的会话（旧实现是「一有生成就全拦」）。
    if (get().runningIds.includes(sessionId)) return null;
    const source = await db.chatSessions.get(sessionId);
    if (!source) return null;
    const rows = await db.chats.where('sessionId').equals(sessionId).sortBy('createdAt');
    const cut = uptoRowId == null ? rows.length : rows.findIndex((row) => row.id === uptoRowId) + 1;
    const kept = cut > 0 ? rows.slice(0, cut) : [];
    // 空会话没有分支的意义（新会话里一个字都没有，Recent 又会多一个空壳）
    if (kept.length === 0) return null;

    const newId = await db.transaction('rw', db.chatSessions, db.chats, async () => {
      const sid = (await db.chatSessions.add({
        videoId: LIBRARY_ASSISTANT_ID,
        /**
         * 标题带上来源。不另起一个「新会话」的名字 —— 分支的用处就是「和原来那条比着看」，
         * 标题里没有来源就认不出谁是谁。
         */
        title: `${source.title} · 分支`,
        createdAt: Date.now(),
        // 上下文与技能范围一并继承：分支出来的是「同一场对话的另一个走法」
        ...(source.contextCourseIds ? { contextCourseIds: [...source.contextCourseIds] } : {}),
        ...(source.skillIds !== undefined ? { skillIds: [...source.skillIds] } : {}),
      })) as number;
      for (const row of kept) {
        await db.chats.add({
          videoId: LIBRARY_ASSISTANT_ID,
          sessionId: sid,
          role: row.role,
          content: row.content,
          /**
           * `createdAt` **照抄原值**，不重新计时。
           *
           * `sortBy('createdAt')` 是稳定排序，复制的顺序按新 id 递增，不会乱；
           * 而重打时间戳会让「这条会话是什么时候聊的」变成假数据。
           */
          createdAt: row.createdAt,
          ...(row.images ? { images: row.images } : {}),
          ...(row.attachments ? { attachments: row.attachments } : {}),
          ...(row.reasoning ? { reasoning: row.reasoning } : {}),
          ...(row.reasoningMs != null ? { reasoningMs: row.reasoningMs } : {}),
          ...(row.tools ? { tools: row.tools } : {}),
          ...(row.quiz ? { quiz: row.quiz } : {}),
          ...(row.ask ? { ask: { ...row.ask } } : {}),
          ...(row.folderPlan ? { folderPlan: { ...row.folderPlan } } : {}),
          ...(row.widget ? { widget: row.widget } : {}),
          ...(row.widgets ? { widgets: row.widgets } : {}),
          ...(row.interrupted ? { interrupted: true } : {}),
          ...(row.interruptReason ? { interruptReason: row.interruptReason } : {}),
        });
      }
      return sid;
    });

    const sessions = await unarchivedSessions();
    set({ sessions });
    await get().loadSession(newId);
    return newId;
  },

  // ── 提问卡作答 ────────────────────────────────────────────────────────────
  answerAsk: async (option) => {
    const { pendingAsk, activeId } = get();
    /**
     * `activeId == null`（草稿态）在这里**不可能**发生：提问卡只能由 agent 循环产生，
     * 而循环只能由 `send` 之后发生 —— 那时会话行已经落库了。所以这条是**断言**不是防呆。
     * 留着的唯一作用是「万一真发生了，别往 null 会话里写消息」。
     */
    if (!pendingAsk || activeId == null) return;
    const message = get().messages.find(m => m.key === pendingAsk.messageKey);
    if (!message?.ask || message.ask.picked != null) return;
    const answer = validateAskAnswer(message.ask, option);
    const picked = askAnswerText(answer);
    set((s) => ({
      messages: s.messages.map((m) =>
        m.key === pendingAsk.messageKey && m.ask
          ? { ...m, ask: { ...m.ask, picked, answer } }
          : m,
      ),
    }));
    /**
     * 恢复态：没有活着的循环，`resolve` 也不是内存 promise —— 装载续跑请求交给 `send`，
     * 由它落答案行、并从断点重进循环。见 docs/plans/2026-10-16-ask-user-resume-design.md。
     */
    if (pendingAsk.resume) {
      const seed = pendingAsk.resume;
      set({ pendingAsk: null });
      await get().send(picked, undefined, seed.sessionId, {
        ...seed,
        userContent: picked,
        toolResult: askUserToolResult(answer),
        askAnswer: answer,
      });
      return;
    }
    // 作答也要落成一条 user 消息：历史回放时这条消息旁边就有一张提问卡，
    // 只有卡上那一句选中项而没有对话行，读起来会像凭空冒出来的。
    // 同时要**插进内存里的消息列表**：只落库不插列表的话当前这一屏看不到「你回答了什么」，
    // 要刷新才冒出来 —— 卡片与对话行当场对不上。
    const createdAt = Date.now();
    const rowId = (await db.chats.add({
      videoId: LIBRARY_ASSISTANT_ID,
      sessionId: activeId,
      role: 'user',
      content: picked,
      createdAt,
    })) as number;
    set((s) => ({
      messages: [...s.messages, { key: `stored-${rowId}`, rowId, role: 'user', content: picked, createdAt }],
      pendingAsk: null,
    }));
    pendingAsk.resolve(answer);
  },

  // ── 目录整理方案 ──────────────────────────────────────────────────────────
  confirmPlan: async () => {
    const { pendingPlan } = get();
    if (!pendingPlan) return { ok: false };
    const plan = get().messages.find((m) => m.key === pendingPlan.messageKey)?.folderPlan;
    if (!plan) {
      set({ pendingPlan: null });
      pendingPlan.resolve({ ok: false, result: null });
      return { ok: false };
    }
    /**
     * 恢复态：没有活着的循环。落库之后把「结果文本」交给 `send` 从断点续跑。
     * 落库失败时**保留卡片可点**（不清 `pendingPlan`）—— 没有循环替它收尾，清了就成了死卡。
     */
    if (pendingPlan.resume) {
      const seed = pendingPlan.resume;
      set({ planApplying: true });
      try {
        const result = await applyFolderPlan(plan);
        set((s) => ({
          planApplying: false,
          messages: s.messages.map((m) =>
            m.key === pendingPlan.messageKey && m.folderPlan
              ? { ...m, folderPlan: { ...m.folderPlan, applied: 1 } }
              : m,
          ),
        }));
        set({ pendingPlan: null });
        await get().send('', undefined, seed.sessionId, {
          ...seed,
          planApplied: 1,
          toolResult: folderPlanToolResult(plan, { ok: true, result }),
        });
        return { ok: true };
      } catch (e) {
        set((s) => ({
          planApplying: false,
          messages: s.messages.map((m) =>
            m.key === pendingPlan.messageKey && m.folderPlan
              ? { ...m, folderPlan: { ...m.folderPlan, applied: 0 } }
              : m,
          ),
        }));
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    set({ planApplying: true });
    try {
      const result = await applyFolderPlan(plan);
      set((s) => ({
        planApplying: false,
        messages: s.messages.map((m) =>
          m.key === pendingPlan.messageKey && m.folderPlan
            ? { ...m, folderPlan: { ...m.folderPlan, applied: 1 } }
            : m,
        ),
      }));
      set({ pendingPlan: null });
      pendingPlan.resolve({ ok: true, result });
      return { ok: true };
    } catch (e) {
      // 落库失败要把卡片退回「待确认」：留在「已执行」上会骗用户说整理完成了
      set((s) => ({
        planApplying: false,
        messages: s.messages.map((m) =>
          m.key === pendingPlan.messageKey && m.folderPlan
            ? { ...m, folderPlan: { ...m.folderPlan, applied: 0 } }
            : m,
        ),
      }));
      set({ pendingPlan: null });
      pendingPlan.resolve({ ok: false, result: null });
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  cancelPlan: async () => {
    const { pendingPlan } = get();
    if (!pendingPlan) return;
    set((s) => ({
      messages: s.messages.map((m) =>
        m.key === pendingPlan.messageKey && m.folderPlan
          ? { ...m, folderPlan: { ...m.folderPlan, applied: 2 } }
          : m,
      ),
    }));
    if (pendingPlan.resume) {
      const seed = pendingPlan.resume;
      const plan = get().messages.find((m) => m.key === pendingPlan.messageKey)?.folderPlan;
      set({ pendingPlan: null });
      await get().send('', undefined, seed.sessionId, {
        ...seed,
        planApplied: 2,
        toolResult: plan
          ? folderPlanToolResult(plan, { ok: false, result: null })
          : '用户没有执行这份整理方案，资料库目录保持原样。',
      });
      return;
    }
    set({ pendingPlan: null });
    pendingPlan.resolve({ ok: false, result: null });
  },
}));

/**
 * 续写指令。
 *
 * 为什么说得这么死（「不要重复」「不要重新开头」「不要重新总结」）：模型看到一段
 * 被截断的 assistant 正文，天然倾向是「重写一份完整的」。那样用户等一轮，拿回来的是
 * 一份和上面那半截重复的东西 —— 看起来就像续传根本没生效。
 */
const CONTINUE_INSTRUCTION =
  '（系统提示：上面那条回答在写到一半时被中断了。请**接着它继续写下去**：从断点处直接续上，' +
  '不要重复已经写过的内容，也不要重新开头、不要重新总结。如果它其实已经写完了，就只回一句「已写完」。）';

/**
 * 续写一条**中断过**的助手回答（`retryMessage` 的 ① 号分支走它）。
 *
 * 请求形态：
 * ```
 * [system, ...库里的历史（末尾就是那半截回答）, { role: 'user', content: CONTINUE_INSTRUCTION }]
 * ```
 *
 * 三个取舍：
 * - **不重发那句 user 提问**：它已经在历史里，重发等于让模型把同一个问题看两遍；
 * - **不带 tools**：续写的语义是「把没写完的话写完」，此时再给它检索工具，
 *   它很可能放下笔去查资料 —— 那就不是续传了；
 * - **新内容追加到同一条消息**（`carried + answer`）：断点续传在用户眼里就是
 *   「一句话被接上了」，拆成两条读起来像两轮回答。
 *
 * 落库走 `modify` 而不是 `update`：要把 `interrupted` / `interruptReason` 两个字段
 * **删掉**，而 Dexie 的 `update` 会忽略值为 `undefined` 的键（字段会赖着不走）。
 */
async function continueInterrupted(
  key: string,
  message: CourseChatMessage,
  sessionId: number,
): Promise<void> {
  const rowId = message.rowId;
  if (rowId == null) return;
  const partial = message.content;
  const settings = getSettings();

  const patch = (p: Partial<CourseChatMessage>) =>
    writeView(sessionId, {
      messages: readView(sessionId).messages.map((m) => (m.key === key ? { ...m, ...p } : m)),
    });

  const abort = new AbortController();
  /**
   * 续写同样登记成「正在跑的一轮」：不登记的话，用户在这期间插入的这句话只会
   * 走 `steer` 里「没有正在跑的一轮」那条兜底、当普通发送 —— 而这半截续写的请求
   * 还在飞，两个循环会同时往同一个会话里写。
   */
  const record = beginInflight(sessionId, abort);
  markRunning(sessionId, true);
  writeView(sessionId, { loading: true });
  // 提示条立刻收掉：它已经变成「正在接着写」了（正文末尾会显示流式光标）
  patch({ streaming: true, interrupted: false, interruptReason: undefined, hint: undefined });

  /**
   * 已经确定归属回答的那部分正文。
   *
   * `answer` 是**当前这一轮**的增量，而 `onRoundStart` 每轮都会把它清空 ——
   * 所以上一轮的话必须先并进 `carried`，否则多轮场景下前面写的东西会被擦掉。
   * 续写理论上只有一轮（没给工具），但「模型硬要返回 tool_calls」这条路拦不住，
   * 兜在这里比赌它不会发生便宜。
   */
  let carried = partial;
  let answer = '';
  let reasoning = message.reasoning ?? '';
  let reasoningFrom = 0;
  let reasoningTo = 0;
  const stopped: AgentStopInfo[] = [];

  /** 中断/停止时统一把当前进度写回库（`patch` 只管界面，库里也要跟上） */
  const persist = async (content: string, extra: { interrupted?: boolean; interruptReason?: string }) => {
    const reasoningMs = reasoningFrom ? reasoningTo - reasoningFrom : undefined;
    patch({ content, streaming: false, hint: undefined, reasoningMs, ...extra });
    await db.chats.where('id').equals(rowId).modify((row) => {
      row.content = content;
      if (reasoning) row.reasoning = reasoning;
      else delete row.reasoning;
      if (reasoningMs != null) row.reasoningMs = reasoningMs;
      else delete row.reasoningMs;
      if (extra.interrupted) {
        row.interrupted = true;
        row.interruptReason = extra.interruptReason;
      } else {
        delete row.interrupted;
        delete row.interruptReason;
      }
    });
  };

  try {
    const courseCount = await db.videos.count();
    const hasCourses = courseCount > 0;
    useCourseChat.setState({ courseCount });

    const view = readView(sessionId);
    const rows = await db.chats.where('sessionId').equals(sessionId).sortBy('createdAt');
    const idx = rows.findIndex((row) => row.id === rowId);
    // 历史只取到这条为止：它后面不该有东西，有也不能带进来（那些消息不在这条回答的上下文里）
    const history = idx >= 0 ? rows.slice(0, idx + 1) : rows;

    const skillMetas = await loadSessionSkillMeta(view.skillIds);
    const skillBlock = skillMetas.length > 0 ? skillMetaBlock(skillMetas) : undefined;
    const systemPrompt = libraryAssistantSystemPrompt(skillBlock, view.contextCourses, hasCourses);
    const budget = settings.contextWindow - estimateTokens(systemPrompt) - estimateTokens(CONTINUE_INSTRUCTION) - 4096;
    const recent = fitHistoryToBudget(history.map((row) => ({ ...row, originalContent: row.content, content: attachmentText(row.content, row.attachments) })), Math.max(2000, budget));
    const chatMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...await historyMessagesWithAttachments(recent, abort.signal),
      { role: 'user', content: CONTINUE_INSTRUCTION },
    ];

    await runAgentLoop(
      chatMessages,
      [],
      // 没给工具，这个执行器不会被调用；留一个说得清的返回值而不是抛错
      async () => '（续写中不需要调用工具）',
      {
        // 思考档位与 `send` 同一套口径，理由见那边的注释
        thinkingEffort: supportsThinking(catalogOf(settings, settings.llmModel.providerId), settings.llmModel.model, modelOverridesOf(settings, settings.llmModel))
          ? settings.thinkingEnabled
            ? settings.thinkingEffort
            : 'none'
          : undefined,
        onReasoningDelta: (delta) => {
          reasoning += delta;
          const now = Date.now();
          const first = !reasoningFrom;
          if (first) reasoningFrom = now;
          reasoningTo = now;
          // 续写同样要实时计时（这条回答的中途可能出现「接着想的几秒」）
          patch({ reasoning, processPhase: 'thinking', ...(first ? { reasoningStartedAt: now } : {}) });
        },
        onDelta: (delta) => {
          answer += delta;
          patch({ content: carried + answer, hint: undefined, processPhase: 'answering' });
        },
        onRoundStart: () => {
          if (answer.trim()) carried += answer;
          answer = '';
          patch({ content: carried, hint: undefined, processPhase: 'preparing' });
        },
        onStop: (info) => {
          stopped.push(info);
        },
        signal: abort.signal,
      },
      // 只给一轮 + 收尾：续写是「把话说完」，不是新一轮检索
      2,
    );

    const newText = answer.trim();
    // 直接拼接、不加空行：断点续传的语义就是「接上了」，插一个空行会看着像新起一段
    await persist(newText ? carried + newText : carried, {});
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (abort.signal.aborted) {
      /**
       * 中止也分两种意图（与 `send` 里那套完全同款，理由见那里的注释）：
       * 插入 → 留住半截并标成可续写；停止 → 照旧把「已停止生成」写在正文里。
       */
      if (record.intent === 'steer') {
        await persist(`${carried}${answer}`, { interrupted: true, interruptReason: STEER_INTERRUPT_REASON });
      } else {
        await persist(`${carried}${answer}\n\n_（已停止生成）_`, {});
      }
    } else {
      // 又断了：把新的进度一起留下，`interrupted` 保持为真，还能接着续
      await persist(carried + answer, { interrupted: true, interruptReason: reason });
    }
  } finally {
    endInflight(sessionId, record);
    writeView(sessionId, { loading: false });
    markRunning(sessionId, false);
    if (!abort.signal.aborted && readView(sessionId).queued.length === 0) {
      useChatNotifications.getState().complete(sessionId);
    }
    // 续写也是一轮：它结束时同样要把队首那条送出去（用户可能在这期间排了话）
    drainQueue(sessionId);
  }
}

/**
 * 插入打断一条回答时的中断原因（写进 `interruptReason`，界面上那条提示条会显示它）。
 *
 * 说得具体一点（「插入」是内部叫法）：「你发了一条新消息」比「被新消息打断」更像人话，
 * 而且用户看到它时，那条新消息就在下面 —— 两句话能对上。
 */
const STEER_INTERRUPT_REASON = '你发了一条新消息，这一轮先停下来';

/**
 * 这一轮结束后把队首那条送出去 —— **只捐这条会话自己的队**。
 *
 * 三道前置条件缺一不可：还在跑就别送（`loading`）、历史还没就绪就别送（`loaded`）、
 * **有提问卡悬着就别送**（`pendingAsk` —— 那时用户打的字是对那张卡的回答，
 * 队列要是自己插一脚，就会有两条消息同时挤进同一个会话）。
 *
 * ⚠️ **先出队再 send**：`send` 是异步的，留着那条在队里会让下一轮的 `finally` 再送一次
 * （同一个问题被问两遍）。出队与发送之间没有 `await`，所以这条不会被别的路径插队。
 *
 * ⚠️ 带 `sessionId` 是「真并发」的一半：后台那条会话跑完时，它的队首要发回**它自己**
 * （`send(text, undefined, sessionId)`），而不是用户此刻在看的另一条。
 */
function drainQueue(sessionId: number): void {
  const view = readView(sessionId);
  if (view.loading || !view.loaded || view.pendingAsk || view.queued.length === 0) return;
  const [next, ...rest] = view.queued;
  writeView(sessionId, { queued: rest });
  // `.catch` 是给「发送本身炸了」兜底：这条已经出队了，别让异常冒成 unhandled rejection
  void useCourseChat.getState().send(next.text, undefined, sessionId, undefined, next.attachments ?? []).catch(() => {});
}

/**
 * 新建一条会话行并落库。**唯一的调用点是 `send` 里的懒创建。**
 *
 * `skillIds` 是草稿态里用户已经选好的技能范围（那时只写在内存里，见 `setSkillIds`），
 * 一并写进这一行。注意是**条件展开**而不是直接写 `skillIds: undefined` ——
 * 该字段的 `undefined` 与 `[]` 语义不同（不限定 vs 一个都不给），
 * 老数据里「不限定」的形态就是**字段不存在**。
 */
async function newSessionRow(skillIds?: number[], contextCourseIds: string[] = []): Promise<ChatSessionRow> {
  const now = Date.now();
  const row: ChatSessionRow = {
    videoId: LIBRARY_ASSISTANT_ID,
    title: '新会话',
    createdAt: now,
    ...(skillIds !== undefined ? { skillIds } : {}),
    ...(contextCourseIds.length ? { contextCourseIds } : {}),
  };
  const id = (await db.chatSessions.add(row)) as number;
  return { ...row, id };
}

/**
 * 课程助手的**未归档**会话，按 `createdAt` 升序。
 *
 * 凡是重建 `sessions` 的地方都要走这里（bootstrap / 删除后 / 归档后）。
 * 直接 `where('videoId')…sortBy('createdAt')` 会把归档项一起捞回来 ——
 * `archived` 不是索引字段，Dexie 没法在查询里挡掉，只能读出来再过滤。
 */
async function unarchivedSessions(): Promise<ChatSessionRow[]> {
  const rows = await db.chatSessions.where('videoId').equals(LIBRARY_ASSISTANT_ID).sortBy('createdAt');
  return rows.filter((row) => !row.archived);
}

/**
 * 改一条会话的属性并同步进内存列表。
 *
 * `mutate` 直接改传入的行对象后返回：不必自己造新对象，
 * Dexie 的 `modify` 本来就是拿原行去改的。
 *
 * ⚠️ 同步时**两边都要按 `archived` 重新归位**，不是简单 map 一遍：
 * 设置里那张「已归档会话」卡可能在开着，此时用户在侧栏归档一条 —— 它得**出现**在那张卡里；
 * 反过来在卡上点「恢复」，它得从那张卡里**消失**。
 * 只 map 不 filter 的话，恢复之后那条会话会带着 `archived: undefined` 继续赖在归档列表里
 * （实测：恢复后卡片不刷新，恢复按钮一直在）。
 */
async function patchSession(id: number, mutate: (row: ChatSessionRow) => void): Promise<void> {
  await db.chatSessions.where('id').equals(id).modify(mutate);
  const fresh = await db.chatSessions.get(id);
  if (!fresh) return;
  useCourseChat.setState((state) => {
    /** 该行归档了就退出 Recent，没归档（或刚被恢复）就留在原位 */
    const sessions = state.sessions
      .map((row) => (row.id === id ? fresh : row))
      .filter((row) => !row.archived);
    const archived = new Map(state.archivedSessions.map((row) => [row.id, row]));
    if (fresh.archived) archived.set(id, fresh);
    else archived.delete(id);
    return { sessions, archivedSessions: [...archived.values()] };
  });
}

/**
 * 收掉还悬着的提问 / 确认。
 *
 * 漏掉这一步的后果不是「多占点内存」：那个 promise 永远不 resolve，agent 循环就卡在
 * `await executeTool(...)` 上，`loading` 再也回不到 false，用户连发都发不出去。
 */
function releasePending(sessionId: number) {
  const view = readView(sessionId);
  if (!view.pendingAsk && !view.pendingPlan) return;
  /**
   * 恢复态的卡**没有内存 promise**：`resolve` 走的是续跑，喂「（用户已离开该会话）」
   * 会被当成用户的选择启动一次假续跑。所以只清引用，不调 resolve。
   */
  if (!view.pendingAsk?.restored) view.pendingAsk?.resolve({
    status: 'cancelled', mode: 'text', selectedIds: [], selectedLabels: [], text: '', note: '',
  });
  if (!view.pendingPlan?.restored) view.pendingPlan?.resolve({ ok: false, result: null });
  writeView(sessionId, { pendingAsk: null, pendingPlan: null });
}

async function historyMessagesWithAttachments(rows: (ChatRow & { originalContent: string })[], signal: AbortSignal): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  for (const row of rows) {
    const attachments = await attachmentsForModel(row.attachments ?? [], row.originalContent, signal);
    if (row.id != null && attachments.some((file, i) => file.description !== row.attachments?.[i]?.description)) {
      await db.chats.update(row.id, { attachments });
    }
    messages.push(messageForModel({ ...row, content: row.originalContent, attachments }));
  }
  return messages;
}

function toMessage(row: ChatRow): CourseChatMessage {
  return {
    key: `stored-${row.id}`,
    rowId: row.id!,
    role: row.role === 'assistant' ? 'ai' : 'user',
    content: row.content,
    attachments: row.attachments,
    createdAt: row.createdAt,
    reasoning: row.reasoning,
    reasoningMs: row.reasoningMs,
    tools: row.tools,
    // 中断过的回答在历史回放里也要能「继续」，所以这两个字段必须跟着走
    interrupted: row.interrupted,
    interruptReason: row.interruptReason,
    ask: row.ask,
    folderPlan: row.folderPlan,
    widget: row.widget,
    widgets: row.widgets,
  };
}

/** 工具开始时的状态提示。工具名对不上就退回通用文案（真正的错误由 executor 返回给模型） */
/**
 * 工具调用「人话层」集中在 `utils/toolTrace.ts`（本地那张 switch 表已删除）。
 *
 * 删它的理由不是「代码重复」这种洁癖：这张表与 `ChatPanel` 里那串 if 各写一份，
 * 于是同一个 `search_course_library` 在两个页面说法不同，而新加的工具两边都要改两遍
 * （漏一边就是英文函数名直接上屏）。现在状态行、工具链、历史回放读的是同一张表。
 */
