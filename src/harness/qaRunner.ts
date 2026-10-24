import { runAgentLoop, noAnswerNotice, type AgentStopInfo } from './agent';
import { remoteTasks } from '../cloud/state';
import { runCloudTask } from '../cloud/tasks';
import { resolveMaxRounds } from './loopGuard';
import { mdEditorOpen } from './tools';
import { courseResourceTools, createResourceExecutor } from './resources';
import { PROMPTS } from './prompts';
import { estimateTokens, fitHistoryToBudget } from './context';
import { loadSessionSkillMeta, skillMetaBlock } from '../skills/store';
import { db, type ChatImage, type QuizState } from '../store/db';
import { catalogOf, getSettings, modelOverridesOf, type ModelTarget } from '../store/settings';
import { supportsThinking } from '../api/modelCaps';
import type { ChatMessage, ContentPart } from '../api/siliconflow';
import type { WidgetPayload } from './widgetRuntime';
import type { UnitKind } from '../materials/units.ts';
import { nextVisualRound } from '../utils/streamingHtml';
import { quizHistoryContent } from './quiz';

/**
 * 单课程问答的**唯一执行体**：从「用户文本」到「助手行落库」，中间那整段（提示词拼装、
 * 工具白名单、历史预算、agent 循环、卡片旁路、落库、兜底文案）都在这里。
 *
 * ## 为什么是抽出来而不是复制一份
 *
 * 问答链上有三处必须同步：系统提示词（`PROMPTS.qaSystem*`）、工具白名单（按材料/抽帧/md
 * 三个开关组装）、技能白名单（同时管提示词清单与工具放行）。复制一份的代价不是多几百行代码，
 * 而是**下一次改其中一处时，另一处会静默留在旧版**：提示词改了 host 那份没改，来宾拿到的
 * 答案就与本机不一样；工具白名单漏改一项，来宾那边模型调得到、本机调不到 —— 两种漂移都
 * 不会报错，只会表现为「数据不对」。仓库自己的规矩就是：两套并存必然漂移。
 *
 * 所以 `components/ChatPanel.tsx` 的 `send()` 只留 UI 职责（气泡、滚动、乐观插入、
 * 截图降级链），这一层整段换成 `runQa(...)`；链路 host 侧将来调的是同一个函数、同一份提示词。
 *
 * ## 语义照搬，不顺手改行为
 *
 * 下面每条都注明是从 ChatPanel 的 `send()` 哪一段搬的：
 *
 * 1. **用户消息先落库**，再进循环 —— 搬自「用户消息立即落库：tier 2 描述可能耗时数秒…」。
 * 2. **历史末条即刚落库的当前问题**，所以历史要 `slice(0, -1)`；工具往返消息**不落库**
 *    （既有设计，这次不动它）。
 * 3. **`onRoundStart` 只清检索旁白**：已交付的 HTML / 图卡及后续讲解保留，
 *    同时留一份 `lastNarration` 给兜底文案。
 * 4. **abort 不走 `onStop`**：`runAgentLoop` 让 `AbortError` 抛给调用方，这里 catch 住 ——
 *    保留已流出内容 + 追加 `_（已停止生成）_` + **照常落库**（否则刷新就没了）。
 * 5. **空回答兜底只 patch 不落库**：出 `noAnswerNotice` 兜底文案，`rowId` 为空 ——
 *    不写库是为了不把一段「模型没答上来」的话存成正式回答。
 */

export interface QaRunInput {
  videoId: string;
  /** 现有会话 id（会话本身由调用方管理，这里只往里写两行消息） */
  sessionId: number;
  /** 已拼好引用前缀的用户文本 = 真正发给模型的那条 */
  text: string;
  /** 多模态（tier 1：模型直接看图）；无则纯文本。历史重放仍是纯文本，截图不重复发送 */
  images?: ContentPart[];
  /** 会话技能范围：同时作用于提示词清单与工具白名单（见下方 `allowedSkillIds`） */
  skillIds?: number[];
  /** 覆盖默认的 chat 槽位（链路端将来按会话指定模型时用；不传 = `targetOfSlot('chat')`） */
  modelTarget?: ModelTarget;

  // ── 以下几项对应 ChatPanel 的 props / 本轮输入，是「拼提示词」必需的原料 ──────────

  /** 课程名（进系统提示词）。不传时按 videoId 现查库，再退化成 id */
  videoName?: string;
  /** 阅读材料的定位单元（`'page'` PDF / `'para'` Word）；**不传 = 视频课程** */
  materialKind?: UnitKind;
  /** 材料原始格式（视频课不传）；**只有 `'md'` 有编辑面**，`edit_markdown` 与提示词都据此开关 */
  materialFormat?: 'pdf' | 'docx' | 'md' | 'html';
  /** 本轮划词/框选引用了几段（>0 时提示词注入「引用优先」规则） */
  refsCount?: number;
  /** 本轮附带几张截图（>0 时提示词注入「以图为准」规则；也是图片 token 估算的依据） */
  shotCount?: number;
  /**
   * 落库 / 上屏那条用户消息的文本，默认 = `text`。
   *
   * 两者为什么不同（照搬自 ChatPanel 的 `displayContent` vs `currentText`）：
   * 落库那条带 `[截图@mm:ss]` 标记与引用块（用户回看历史时要看得见自己引了什么），
   * 发给模型那条把标记换成「以图为准」的引导段、并挂上视觉模型的逐字转述。
   * ⚠️ 引用块要**同时**进两处：只进落库那条，模型只能看到「这段」而不知道指什么。
   */
  displayText?: string;
  /** 用户消息的截图元数据（缩略图与时刻）：只落库，不发给模型 */
  chatImages?: ChatImage[];
}

/** 工具闭包旁路产出的卡片：题卡 / 图形卡（不在 agent 循环的消息序列里） */
export type QaCard =
  | { kind: 'quiz'; quiz: QuizState }
  | { kind: 'widget'; widget: WidgetPayload };

export interface QaSink {
  onReasoning?: (text: string) => void;
  onDelta?: (text: string) => void;
  /** 新一轮开始（round 从 0 起，见 `AgentCallbacks`）；此前轮次流出的正文只是检索旁白 */
  onRoundStart?: (round: number) => void;
  onToolStart?: (name: string, argsJson: string) => void;
  onToolEnd?: (name: string, result: string) => void;
  onStop?: (info: AgentStopInfo) => void;
  /** 题卡 / 图卡：走闭包旁路，不在流里 */
  onCard?: (card: QaCard) => void;
  signal?: AbortSignal;
}

export interface QaRunResult {
  /** 助手行落库后的 id；**空回答兜底那条不落库，所以没有 id** */
  rowId?: number;
  /** 最终正文（空回答时是兜底文案，被中断时是「已流出内容 + （已停止生成）」） */
  content: string;
  reasoning?: string;
  /** 从首条思考增量到首条正文的时长；模型没思考时为 undefined */
  reasoningMs?: number;
  quiz?: QuizState;
  widget?: WidgetPayload;
  widgets?: WidgetPayload[];
  /** 护栏停下时的停因（正常收工没有） */
  stopped?: AgentStopInfo;
}

/** 跑完一轮单课程问答；只有「网络/模型/护栏真出错」才会抛（抛给调用方渲染错误） */
export async function runQa(input: QaRunInput, sink: QaSink = {}): Promise<QaRunResult> {
  if (remoteTasks()) {
    let content = '', reasoning = '';
    return runCloudTask('qa', `session:${input.sessionId}`, { ...input, modelTarget: undefined, modelRef: input.modelTarget ? { providerId: input.modelTarget.providerId, model: input.modelTarget.model } : getSettings().llmModel }, p => {
      if (typeof p.content === 'string') {
        if (!p.content.startsWith(content)) { sink.onRoundStart?.(0); content = ''; }
        sink.onDelta?.(p.content.slice(content.length)); content = p.content;
      }
      if (typeof p.reasoning === 'string') { sink.onReasoning?.(p.reasoning.slice(reasoning.length)); reasoning = p.reasoning; }
    }, sink.signal);
  }
  const settings = getSettings();
  const { videoId, sessionId, text, skillIds } = input;
  /** 阅读材料 = 有定位单元；视频课程走字幕检索 + 时间戳引用 */
  const isMaterial = input.materialKind !== undefined;
  const materialKind = input.materialKind;
  const shotCount = input.shotCount ?? 0;
  const refsCount = input.refsCount ?? 0;

  // ── 用户消息先落库（照搬 ChatPanel）────────────────────────────────────────
  // tier 2 的视觉描述可能耗时数秒，先落库避免期间关页丢失已上屏的消息。
  // 链路 host 侧同样只调这一处：来宾那边的提问最终要落到**主机**的库里。
  await db.chats.add({
    videoId,
    sessionId,
    role: 'user',
    content: input.displayText ?? text,
    createdAt: Date.now(),
    ...(input.chatImages?.length ? { images: input.chatImages } : {}),
  });
  const history = await db.chats.where('sessionId').equals(sessionId).sortBy('createdAt');

  // ── 上下文原料：技能清单 / 画面元数据 / 编辑面（照搬 ChatPanel 的三段探测）───
  // Level 1：技能元数据清单进系统提示词，agent 按需用 use_skill 加载正文。
  // 走 loadSessionSkillMeta：会话限定了范围时，清单只列范围内的技能（未限定则等价于全量）。
  const skillMetas = await loadSessionSkillMeta(skillIds);
  // 每次发送前现查帧元数据（讲义可能在本面板挂载后生成）：有帧才注册 list_frames 工具并注入引用规则。
  // 材料没有画面可引用，直接跳过这次查询。
  const frames = isMaterial
    ? []
    : await db.frames.where('videoId').equals(videoId).filter((r) => r.kind === 'slide').sortBy('ts');
  const hasFrames = frames.length > 0;
  /**
   * 这份材料此刻能不能被直接改：**格式是 md，且编辑面确实开着**。
   *
   * 第二个条件依赖「用户此刻点开了编辑」——注册一个当下不可用的工具只会诱发无效调用
   * （模型会先调一次、拿到「没有打开编辑面」、再白烧一轮），与 list_frames 只在有抽帧时
   * 注册是同一个思路：按课程**实际具备的能力**给工具。
   * 代价是中途关掉编辑会退化：那一轮仍会调它、回执会引导用户重新点开「编辑」。
   *
   * ⚠️ `&&` 短路不是可有可无的写法优化：mdEditorOpen 会动态 import md-editor/bridge，
   * 那条链上挂着 CodeMirror。让它只在**确实可能是 md 材料**时才走，
   * 视频课与 PDF / Word / HTML 材料就完全不会去碰那个 chunk（理由见 harness/tools.ts 里那段）。
   */
  const canEditMd = input.materialFormat === 'md' && (await mdEditorOpen(videoId));

  const videoName = input.videoName ?? (await db.videos.get(videoId))?.name ?? videoId;
  const skillBlock = skillMetas.length > 0 ? skillMetaBlock(skillMetas) : undefined;
  // ⚠️ 工具与提示词必须用**同一个** canEditMd：只注册工具不给提示词，模型多半想不到去用它；
  // 只给提示词不给工具，它会写一段「我已修改」而其实什么都没发生 —— 比不给更糟。
  const systemPrompt = isMaterial
    ? PROMPTS.qaSystemMaterial(videoName, materialKind!, skillBlock, shotCount, refsCount, canEditMd, settings.agentInstructions)
    : PROMPTS.qaSystem(videoName, skillBlock, hasFrames, shotCount, refsCount, settings.agentInstructions);

  // ── 历史按 token 预算截取（工具往返消息不进库，所以库里只有一问一答）────────
  const budget =
    settings.contextWindow -
    estimateTokens(systemPrompt) -
    estimateTokens(text) -
    (input.images ? shotCount * 1200 : 0) - // 多模态图片每张约 1.2k tokens
    4096; // 输出预留
  // 末条即刚落库的当前问题（历史保持纯文本，截图不重复发送）
  const recent = fitHistoryToBudget(history.slice(0, -1).map((row) => ({ ...row, content: quizHistoryContent(row) })), Math.max(2000, budget));
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...recent.map((r) => ({ role: r.role, content: r.content }) as ChatMessage),
  ];
  if (input.images) {
    messages.push({
      role: 'user',
      content: [...input.images, { type: 'text', text }],
    });
  } else {
    messages.push({ role: 'user', content: text });
  }

  // ── 卡片旁路 + 工具执行器（照搬 ChatPanel）─────────────────────────────────
  // present_quiz 校验通过后回调：题卡数据上屏（初始全部未作答）
  let quizState: QuizState | undefined;
  // Every validated visual is retained; Markdown references determine its inline position.
  const widgets: WidgetPayload[] = [];
  let widgetState: WidgetPayload | undefined;
  const executeTool = createResourceExecutor({
    courseId: videoId,
    editable: canEditMd,
    hasFrames,
    // 材料：kind 决定走 search_material；视频：undefined 走 search_transcript
    kind: materialKind,
    /**
     * 会话技能白名单**同时**管住提示词清单与工具执行。
     *
     * ⚠️ 这是相对 ChatPanel 的一处**行为修正**，不是搬运：面板原来构造 executor 时漏了这个
     * 参数，于是「技能范围」只收窄了提示词里的清单，`use_skill` 却照样放行 —— 用户把范围
     * 收到一个技能，模型仍能凭历史印象调另一个，白名单形同虚设（课程助手那条路径一直是传对的，
     * 单课程面板是漏的）。两侧现在共用 `runQa`，白名单只有一处判定（`skills/scope.ts`）。
     */
    allowedSkillIds: skillIds,
    onQuiz: (data) => {
      quizState = { data, picks: data.questions.map(() => -1) };
      sink.onCard?.({ kind: 'quiz', quiz: quizState });
    },
    onWidget: (w) => {
      widgetState = w;
      widgets.push(w);
      sink.onCard?.({ kind: 'widget', widget: w });
    },
  });
  /**
   * 本轮工具集：只给**当下真的能用**的能力。
   * 材料没有字幕、没有画面（工具集本身就少两样），md 且编辑面开着才多一个 edit_markdown。
   */
  const tools = courseResourceTools(canEditMd);

  // ── 跑循环（照搬 ChatPanel 的四个局部计数器）────────────────────────────────
  let answer = '';
  let reasoning = '';
  /**
   * 最后一轮旁白 + 最后一次工具提示。
   *
   * `onRoundStart` 会清空检索旁白（保留已交付的可视内容），轮次用尽时模型可能一个字都不说
   * （不给 tools 时它仍会返回「空正文 + tool_calls」）。存一份是为了让兜底文案能说清
   * 「它干了什么、你想做什么」，而不是只留一句「（未获得回答）」。见 harness/agent.ts。
   */
  let lastNarration = '';
  let lastHint = '';
  /** 实际跑过的轮数（`onRoundStart` 记的）：兜底文案只能印真实值，不能拿设置里的上限顶 */
  let roundsRan = 0;
  /** 护栏停下的情况。用数组而不是 `let`：赋值在回调里，TS 在读它的地方仍会当成 `null` */
  const stopped: AgentStopInfo[] = [];
  /** 思考耗时：首条 reasoning → 首条正文。模型没思考时不记（不拿 0 冒充「想了 0 毫秒」） */
  let reasoningStartAt = 0;
  let reasoningMs: number | undefined;
  const markReasoningStart = () => {
    if (reasoningStartAt === 0) reasoningStartAt = Date.now();
  };
  const markAnswerStart = () => {
    if (reasoningStartAt > 0 && reasoningMs === undefined) reasoningMs = Date.now() - reasoningStartAt;
  };

  try {
    await runAgentLoop(
      messages,
      tools,
      executeTool,
      {
        // 覆盖模型槽位：不传就是老行为（settings 的 chat 槽位，面板与课程助手都走这条）
        target: input.modelTarget,
        // 开着思考就把档位传下去：thinkingParams 按模型声明决定发哪个字段 ——
        // 只有开关的模型拿不到深度参数，但 `enable_thinking` 照发
        thinkingEffort:
          settings.thinkingEnabled &&
          supportsThinking(
            input.modelTarget?.catalogId ?? catalogOf(settings, settings.llmModel.providerId),
            input.modelTarget?.model ?? settings.llmModel.model,
            input.modelTarget ? input.modelTarget.capabilities : modelOverridesOf(settings, settings.llmModel),
          )
            ? settings.thinkingEffort
            : undefined,
        onReasoningDelta: (text) => {
          reasoning += text;
          markReasoningStart();
          sink.onReasoning?.(text);
        },
        onDelta: (text) => {
          answer += text;
          markAnswerStart();
          sink.onDelta?.(text);
        },
        onRoundStart: (round) => {
          // 已输出的可视内容不能因后续工具调用而消失。
          if (answer.trim()) lastNarration = answer.trim();
          const previous = answer;
          answer = nextVisualRound(answer, widgets.length > 0);
          roundsRan++;
          sink.onRoundStart?.(round);
          // Round-aware sinks reset their buffer; append-only sinks need only the separator.
          if (answer) sink.onDelta?.(sink.onRoundStart ? answer : answer.slice(previous.length));
        },
        onToolStart: (name, argsJson) => {
          lastHint = qaToolHint(name, argsJson, isMaterial);
          sink.onToolStart?.(name, argsJson);
        },
        onToolEnd: (name, result) => sink.onToolEnd?.(name, result),
        onStop: (info) => {
          stopped.push(info);
          sink.onStop?.(info);
        },
        signal: sink.signal,
      },
      // 检索轮次上限来自设置（默认 6，选「不限」则为 Infinity；另有循环检测与 token 预算兜着）
      resolveMaxRounds(settings.agentRounds),
    );
  } catch (e) {
    // 用户按了停止：不是错误。保留已流出的内容，只补一句「已停止」，并且**落库**
    // （否则刷新就没了，「停止」等于白生成一轮）。
    //
    // 判定照搬面板的老写法：**看 signal 而不是看错误类型** —— 中止是调用方的意图，
    // 而中途恰好撞上窗口关闭等别的错误时，也不该把它报成「回答失败」盖掉已流出的内容。
    if (sink.signal?.aborted) {
      const partial = answer.trim() || lastNarration.trim();
      const content = partial ? `${partial}\n\n_（已停止生成）_` : '_（已停止生成）_';
      const rowId = (await db.chats.add({
        videoId,
        sessionId,
        role: 'assistant',
        content,
        createdAt: Date.now(),
        reasoning: reasoning || undefined,
        ...(widgetState ? { widget: widgetState } : {}),
        ...(widgets.length ? { widgets } : {}),
      })) as number;
      return { rowId, content, reasoning: reasoning || undefined, reasoningMs,
        ...(widgetState ? { widget: widgetState } : {}), ...(widgets.length ? { widgets } : {}),
        ...(stopped[0] ? { stopped: stopped[0] } : {}) };
    }
    // 真错误原样抛给调用方：让它渲染错误气泡、决定要不要再提示一次。
    // （链路 host 侧据此发 chat.err —— 设计 §3.1 说失败也要落库成一条 assistant，
    //   但那是 host 的 UI 责任，不该由这一层替它决定文案。）
    throw e;
  }

  // ── 收尾（照搬 ChatPanel）──────────────────────────────────────────────────
  markAnswerStart();
  const closeOut = stopped[stopped.length - 1];
  const finalAnswer = answer.trim();
  if (finalAnswer || quizState || widgetState) {
    const rowId = (await db.chats.add({
      videoId,
      sessionId,
      role: 'assistant',
      content: finalAnswer,
      createdAt: Date.now(),
      reasoning: reasoning || undefined,
      ...(quizState ? { quiz: quizState } : {}),
      ...(widgetState ? { widget: widgetState } : {}),
      ...(widgets.length ? { widgets } : {}),
    })) as number;
    return {
      rowId,
      content: finalAnswer,
      ...(reasoning ? { reasoning } : {}),
      ...(reasoningMs !== undefined ? { reasoningMs } : {}),
      ...(quizState ? { quiz: quizState } : {}),
      ...(widgetState ? { widget: widgetState } : {}),
      ...(widgets.length ? { widgets } : {}),
      ...(closeOut ? { stopped: closeOut } : {}),
    };
  }
  // 空回答兜底，避免留下永久空气泡。**要说清是哪道闸停下的**：只写「（未获得回答）」的话，
  // 用户看到的就是「点了没反应」，既不知道它查了多少轮，也不知道自己该做什么。
  // ⚠️ 只返回、不落库：这一段是「模型没答上来」，存成正式回答会污染历史。
  return {
    content: noAnswerNotice({
      // 没有 closeOut 只可能是「循环正常结束却一个字没说」——那正是 `empty` 这条闸管的事，
      // 猜成 `rounds` 会印出「已到轮次上限」这种从未发生过的原因（实测文案：0 次工具调用）
      reason: closeOut?.reason ?? 'empty',
      rounds: closeOut?.rounds ?? roundsRan,
      ...(closeOut?.detail ? { detail: closeOut.detail } : {}),
      requestedTools: closeOut?.requestedTools ?? [],
      narration: lastNarration,
      hint: lastHint,
    }),
    reasoning: reasoning || undefined,
    ...(reasoningMs !== undefined ? { reasoningMs } : {}),
    ...(closeOut ? { stopped: closeOut } : {}),
  };
}

/**
 * 工具开始时的状态提示（照搬 ChatPanel 的 onToolStart 内联文案）。
 *
 * 导出而不是内联进 `runQa`：它是**展示层**的东西（面板当 ThinkLine 显示，链路 host 塞进
 * `chat.ev` 的 text 字段），而 `QaSink.onToolStart` 的签名是 `(name, argsJson)`——
 * 原始参数对链路端更有用（host 可以自己决定要不要显示工具名）。文案本身只此一份，
 * 免得来宾那边显示的进度提示与本机不是同一套措辞。
 *
 * 工具名对不上就退回通用文案（真正的错误由 executor 返回给模型）。
 */
export function qaToolHint(name: string, argsJson: string, isMaterial: boolean): string {
  let hint = isMaterial ? '正在检索材料…' : '正在检索字幕…';
  try {
    const args = JSON.parse(argsJson || '{}') as { query?: string; name?: string };
    if ((name === 'search_transcript' || name === 'grep') && args.query) hint = `正在检索：${args.query}`;
    if (name === 'search_material' && args.query) hint = `正在检索材料：${args.query}`;
    if (name === 'get_transcript_range') hint = '正在查看字幕原文…';
    if (name === 'get_material_range') hint = '正在查看材料原文…';
    if (name === 'list_frames') hint = '正在查看课程画面…';
    if (name === 'present_quiz') hint = '正在出题…';
    if (name === 'show_widget') hint = '正在预检图形…';
    if (name === 'edit_markdown') hint = '正在修改材料正文…';
    if (name === 'use_skill') hint = `正在加载技能：${args.name ?? ''}`;
    if (name === 'read_skill_reference') hint = '正在查阅参考文档…';
  } catch {
    /* 参数不是合法 JSON：用通用文案，真正的错误由 executor 返回给模型 */
  }
  return hint;
}
