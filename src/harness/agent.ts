import { chatStream, textOf, type ChatMessage, type ReasoningEffort, type ToolDef } from '../api/siliconflow';
import { thinkingParams } from '../api/modelCaps';
import { getSettings } from '../store/settings';
import { CallLedger, resolveMaxRounds } from './loopGuard';
import { estimateTokens } from './context';

/**
 * 最小 agent 循环（参考 pi-mono）：消息列表 + 工具注册表 + tool-calling 循环 + 流式事件。
 * 每一轮都流式调 LLM：若模型返回 tool_calls 则依次执行工具、把结果追加为 tool 消息后继续；
 * 否则该轮的正文增量即最终回答（通过 onDelta 流式透出）。
 *
 * ## 循环什么时候停
 *
 * **不是「数够 N 轮就停」**。轮数只是成本闸，真正会出事的是另外两件事，各有各的护栏：
 *
 * | 停因 | 触发条件 | 为什么必须有 |
 * |---|---|---|
 * | `rounds` | 轮数到上限（`maxRounds` 可传 `Infinity` = 设置里选「不限」） | 成本与延迟；用户显式要的那道闸 |
 * | `loop` | 同一工具 + **同一参数**在本轮里第二次出现 | 模型没有内在的「够了」判断，检索不满意会换说法再查；而完全相同的一遍拿到的结果必然一模一样，循环不会自己结束 |
 * | `tokens` | 工具结果累积 token 超预算 | `out` 只增不减（历史裁剪只在**每轮对话开始时**做一次），不设闸就会撞上下文窗口报 400 |
 * | `aborted` | 调用方 abort（停止生成按钮） | 用户必须有刹车；不经这里，调用方的 `signal` 直接抛 AbortError |
 *
 * 三种非人为停止都会先走**强制收尾**（无 tools 的一轮 + 一次有界宽限），保证不留空气泡。
 */

/** 循环为什么停（`aborted` 由调用方的 signal 自行处理，不走这里） */
export type StopReason = 'rounds' | 'loop' | 'tokens';

export interface AgentStopInfo {
  reason: StopReason;
  /** 实际跑了多少轮 */
  rounds: number;
  /** `loop`：被判重复的那个工具名；`tokens`：超预算时的累积 token 数 */
  detail?: string;
  /** 收尾那一轮里模型还想调、但没执行成的工具名 */
  requestedTools: string[];
  /** 收尾是否真的说到了话（false 时调用方要出兜底文案） */
  granted: boolean;
}

export interface AgentCallbacks {
  /** 正文流式增量 */
  onDelta?: (text: string) => void;
  /** 思考过程流式增量（reasoning_content） */
  onReasoningDelta?: (text: string) => void;
  /** 思考深度档位；undefined = 不开启思考。内部经 thinkingParams() 映射为 API 参数 */
  thinkingEffort?: ReasoningEffort;
  /** 新一轮 LLM 调用开始（round 从 0 起）；此前轮次流出的正文只是检索旁白，调用方可据此清空 */
  onRoundStart?: (round: number) => void;
  /** 工具调用开始/结束（用于 UI 状态提示） */
  onToolStart?: (name: string, argsJson: string) => void;
  onToolEnd?: (name: string, result: string) => void;
  /**
   * 循环被护栏停下（轮次 / 循环 / token）。
   *
   * **为什么必须通报**：不给 `tools` 时模型**仍然可能**返回「空正文 + tool_calls」
   * （它想调工具，但结构上已经没有工具可调了）。那种情况下正文是 `null`，
   * 调用方若只看 `onDelta` 就会得到「什么都没说」——实测表现是界面上只留下一句
   * 「（未获得回答）」，用户既不知道它干了什么、也不知道该做什么。
   */
  onStop?: (info: AgentStopInfo) => void;
  signal?: AbortSignal;
}

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

/** 输出预留（tokens）：与提问/出题两条链路沿用同一个值 */
const OUTPUT_RESERVE = 4096;

export async function runAgentLoop(
  messages: ChatMessage[],
  tools: ToolDef[],
  executeTool: ToolExecutor,
  cb: AgentCallbacks = {},
  maxRounds = 6,
): Promise<ChatMessage[]> {
  const settings = getSettings();
  const out = [...messages];
  const thinking = cb.thinkingEffort ? thinkingParams(settings.llmModel, cb.thinkingEffort) : {};
  /** 护栏 1：循环检测的账本（同一工具 + 同一参数本轮只能出现一次） */
  const ledger = new CallLedger();
  /**
   * 护栏 2：工具结果的 token 预算。`out` 只增不减，所以**真正防 400 的是这道闸**，
   * 轮数不是 ——「不限轮次」时它依然是硬闸（没有它，无限轮次迟早撞上下文窗口）。
   */
  const tokenBudget = Math.max(
    2000,
    settings.contextWindow -
      messages.reduce((n, m) => n + estimateTokens(textOf(m)), 0) -
      OUTPUT_RESERVE,
  );
  let toolTokens = 0;
  /** 停止原因（不含「用户按停」：那由 signal 抛 AbortError，调用方自己处理） */
  let stopped: { reason: StopReason; rounds: number; detail?: string } | null = null;
  /** 最后一个「还在要工具」的消息：收尾时用它来解释模型想干什么 */
  let msg0: ChatMessage | null = null;

  for (let round = 0; round < maxRounds; round++) {
    cb.onRoundStart?.(round);
    const msg = await chatStream(
      settings,
      {
        model: settings.llmModel,
        messages: out,
        tools,
        temperature: 0.3,
        max_tokens: 2048,
        signal: cb.signal,
        ...thinking,
      },
      cb.onDelta,
      // 回调累计值含所有轮次思维链；返回消息的 reasoning_content 只有最后一轮——持久化用回调累计值
      cb.onReasoningDelta,
    );
    out.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) return out;

    // 记下「最后一轮仍要调什么」，收尾时用来给用户解释（见 onStop）
    msg0 = msg;
    for (const call of msg.tool_calls) {
      // 原地打转：同样的工具 + 同样的参数。再查一遍拿到的结果必然一模一样，
      // 与其等它自己撞上限，不如停下来说清楚它在重复什么
      if (ledger.record(call.function.name, call.function.arguments)) {
        stopped = { reason: 'loop', rounds: round + 1, detail: call.function.name };
        break;
      }
      cb.onToolStart?.(call.function.name, call.function.arguments);
      let result: string;
      try {
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        result = await executeTool(call.function.name, args);
      } catch (e) {
        result = `工具执行失败：${e instanceof Error ? e.message : String(e)}`;
      }
      cb.onToolEnd?.(call.function.name, result);
      toolTokens += estimateTokens(result);
      out.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: result,
      });
      // 累积 token 超预算：停下来让模型用已经查到的材料收尾，
      // 再往下堆就会撞上下文窗口，而报出来的 400 对用户毫无意义
      if (toolTokens >= tokenBudget) {
        stopped = { reason: 'tokens', rounds: round + 1, detail: String(Math.round(toolTokens)) };
        break;
      }
    }
    if (stopped) break;
  }
  // 轮次用完但没人触发别的护栏 → 这是「轮次」这条闸（maxRounds = Infinity 时永远进不来）
  if (!stopped) stopped = { reason: 'rounds', rounds: maxRounds };

  // ── 护栏触发后的强制收尾 ──────────────────────────────────────────────────
  //
  // 「一次无 tools 的调用就能收工」这个假设是错的：不给 tools 时模型仍可能返回
  // 「空正文 + tool_calls」（实测：整理课程库目录这种要连查多门的任务，最后一轮
  // 只想调 propose_folder_plan，于是正文一个字都没有 → 界面上只剩「（未获得回答）」）。
  //
  // 所以给一次**有界宽限**：收尾轮不吭声就明确要求它「不许调工具，用中文总结」再试一次。
  // 只宽限一次（成本可控），仍不吭声才由调用层出兜底文案。
  const stop = stopped as { reason: StopReason; rounds: number; detail?: string };
  let pending = msg0?.tool_calls?.map((c) => c.function.name) ?? [];
  cb.onRoundStart?.(stop.rounds);
  for (let attempt = 0; attempt < 2; attempt++) {
    const finalMsg = await chatStream(
      settings,
      {
        model: settings.llmModel,
        messages: out,
        temperature: 0.3,
        max_tokens: 2048,
        signal: cb.signal,
        ...thinking,
      },
      cb.onDelta,
      cb.onReasoningDelta,
    );
    if (textOf(finalMsg).trim()) {
      out.push(finalMsg);
      cb.onStop?.({
        reason: stop.reason,
        rounds: stop.rounds,
        ...(stop.detail ? { detail: stop.detail } : {}),
        requestedTools: pending,
        granted: true,
      });
      return out;
    }
    pending = finalMsg.tool_calls?.map((c) => c.function.name) ?? pending;
    if (attempt === 0) {
      // 不把这条不吭声的消息塞回历史：它带着**没人应答**的 tool_calls，
      // 下一轮请求里 assistant(tool_calls) 没有配对的 tool 消息，严格实现会直接 400。
      out.push({ role: 'user', content: wrapUpNudge(stop.reason) });
    }
  }
  cb.onStop?.({
    reason: stop.reason,
    rounds: stop.rounds,
    ...(stop.detail ? { detail: stop.detail } : {}),
    requestedTools: pending,
    granted: false,
  });
  return out;
}

/** 宽限那一轮的指令：把「不许调工具、必须说人话」讲死，否则模型会再要一次工具 */
function wrapUpNudge(reason: StopReason): string {
  const why =
    reason === 'loop'
      ? '你刚才在重复同一个调用（同样的工具、一样的参数），再调也不会有新结果。'
      : reason === 'tokens'
        ? '你这一轮已经读到的材料接近模型能接受的上下文长度了。'
        : '这一轮的工具调用次数已经用完。';
  return `（系统提示：${why}现在不能再调用任何工具。请**只用中文文字**回答：你已经查到了什么、结论是什么、` +
    '用户接下来该做什么。不要再请求工具。';
}

export interface NoAnswerContext {
  /** 护栏停下的原因（决定文案怎么写） */
  reason: StopReason;
  /** 实际跑了多少轮 */
  rounds: number;
  /** `loop` / `tokens` 的细节（工具名 / 累积 token） */
  detail?: string;
  /** 收尾时模型还想调、但没执行成的工具名 */
  requestedTools: string[];
  /** 最后一轮流过的旁白（会随新一轮清空，这里留着做兜底） */
  narration?: string;
  /** 最后一次工具提示，兜底时告诉用户「它最后在干什么」 */
  hint?: string;
}

/**
 * 「模型一个字都没说」的兜底文案。
 *
 * 三条要求：**说清是哪道闸停下��**（轮次用完 / 在重复调用 / 材料读太多）、**说清已经做了什么**
 * （旁白 / 最后在查什么）、**给出下一步**（换个问法、说「继续」，或去设置调那道闸）。
 * 只丢一句「（未获得回答）」等于把跑了十几轮的工具调用变成用户眼里的「没反应」。
 */
export function noAnswerNotice(ctx: NoAnswerContext): string {
  const wanted = ctx.requestedTools.length > 0 ? `，助手最后还想调用「${ctx.requestedTools.join('」「')}」` : '';
  const head =
    ctx.reason === 'loop'
      ? `助手在第 ${ctx.rounds} 轮开始重复调用「${ctx.detail ?? '同一个工具'}」（同样的参数），再查一遍结果也不会变，所以我先把它停下来${wanted}，但它没能说出一句总结。`
      : ctx.reason === 'tokens'
        ? `这一轮已经读了约 ${ctx.detail ?? '很多'} tokens 的材料，接近模型能接受的上下文长度，我先让它收尾${wanted}，但它没能说出一句总结。`
        : `这一轮用完了 ${ctx.rounds} 次工具调用${wanted}，已经到轮次上限，所以没能给出回答。`;
  const lines = [head];
  const progress = ctx.narration?.trim() || ctx.hint?.trim();
  if (progress) lines.push('', `它最后说到：${progress}`);
  lines.push(
    '',
    ctx.reason === 'loop'
      ? '换个说法或把问题说具体一点，通常就能让它继续查下去；也可以到设置里调大「问答 agent 检索轮次上限」。'
      : '再说一句「继续」，我会接着上次的进度往下做；也可以到设置里调大「问答 agent 检索轮次上限」。',
  );
  return lines.join('\n');
}
