import { chatStream, textOf, type ChatMessage, type ReasoningEffort, type ToolDef } from '../api/siliconflow';
import { thinkingParams } from '../api/modelCaps';
import { getSettings } from '../store/settings';

/**
 * 最小 agent 循环（参考 pi-mono）：消息列表 + 工具注册表 + tool-calling 循环 + 流式事件。
 * 每一轮都流式调 LLM：若模型返回 tool_calls 则依次执行工具、把结果追加为 tool 消息后继续；
 * 否则该轮的正文增量即最终回答（通过 onDelta 流式透出）。
 * 若轮次耗尽时模型仍要调工具，追加一轮无 tools 的强制收尾，保证一定给出最终回答。
 */

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
   * 轮次用尽后的收尾结果。
   *
   * **为什么必须通报**：不给 `tools` 时模型**仍然可能**返回「空正文 + tool_calls」
   * （它想调工具，但结构上已经没有工具可调了）。那种情况下正文是 `null`，
   * 调用方若只看 `onDelta` 就会得到「什么都没说」——实测表现是界面上只留下一句
   * 「（未获得回答）」，用户既不知道它干了什么、也不知道该做什么。
   *
   * - `requestedTools`：收尾那一轮里模型还想调的���具名（没执行）
   * - `granted`：最后一次收尾是否真的说到了话
   */
  onBudgetExhausted?: (info: { requestedTools: string[]; granted: boolean }) => void;
  signal?: AbortSignal;
}

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

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
  /** 最后一个「还在要工具」的消息：轮次用尽时用它来解释模型想干什么 */
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

    // 记下「最后一轮仍要调什么」，收尾时用来给用户解释（见 onBudgetExhausted）
    msg0 = msg;
    for (const call of msg.tool_calls) {
      cb.onToolStart?.(call.function.name, call.function.arguments);
      let result: string;
      try {
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        result = await executeTool(call.function.name, args);
      } catch (e) {
        result = `工具执行失败：${e instanceof Error ? e.message : String(e)}`;
      }
      cb.onToolEnd?.(call.function.name, result);
      out.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: result,
      });
    }
  }

  // ── 轮次耗尽后的收尾 ──────────────────────────────────────────────────────
  //
  // 「一次无 tools 的调用就能收工」这个假设是错的：不给 tools 时模型仍可能返回
  // 「空正文 + tool_calls」（实测：整理课程库目录这种要连查多门的任务，最后一轮
  // 只想调 propose_folder_plan，于是正文一个字都没有 → 界面上只剩「（未获得回答）」）。
  //
  // 所以给一次**有界宽限**：收尾轮不吭声就明确要求它「不许调工具，用中文总结」再试一次。
  // 只宽限一次（成本可控），仍不吭声才由调用层出兜底文案。
  let pending = msg0?.tool_calls?.map((c) => c.function.name) ?? [];
  cb.onRoundStart?.(maxRounds);
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
      cb.onBudgetExhausted?.({ requestedTools: pending, granted: true });
      return out;
    }
    pending = finalMsg.tool_calls?.map((c) => c.function.name) ?? pending;
    if (attempt === 0) {
      // 不把这条不吭声的消息塞回历史：它带着**没人应答**的 tool_calls，
      // 下一轮请求里 assistant(tool_calls) 没有配对的 tool 消息，严格实现会直接 400。
      out.push({ role: 'user', content: WRAP_UP_NUDGE });
    }
  }
  cb.onBudgetExhausted?.({ requestedTools: pending, granted: false });
  return out;
}

/** 宽限那一轮的指令：把「不许调工具、必须说人话」讲死，否则模型会再要一次工具 */
const WRAP_UP_NUDGE =
  '（系统提示：这一轮的工具调用次数已经用完，不能再调用任何工具。请**只用中文文字**回答：' +
  '你已经查到了什么、结论是什么、用户接下来该做什么。不要再请求工具。';

export interface NoAnswerContext {
  /** 轮次上限（设置里的「问答 agent 检索轮次上限」） */
  rounds: number;
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
 * 三条要求：**说清发生了什么**（轮次用尽、它还想调什么）、**说清已经做了什么**
 * （旁白 / 最后在查什么）、**给出下一步**（发一句「继续」，或去设置调大轮次）。
 * 只丢一句「（未获得回答）」等于把一次跑了六轮的工具调用变成用户眼里的「没反应」。
 */
export function noAnswerNotice(ctx: NoAnswerContext): string {
  const wanted = ctx.requestedTools.length > 0 ? `、${ctx.requestedTools.join('、')}` : '';
  const lines = [
    `这一轮用完了 ${ctx.rounds} 次工具调用${wanted ? `，助手最后还想调用「${ctx.requestedTools.join('」「')}」` : ''}，但已经到轮次上限，所以没能给出回答。`,
  ];
  const progress = ctx.narration?.trim() || ctx.hint?.trim();
  if (progress) lines.push('', `它最后说到：${progress}`);
  lines.push('', '再说一句「继续」，我会接着上次的进度往下做；也可以到设置里把「问答 agent 检索轮次上限」调大。');
  return lines.join('\n');
}
