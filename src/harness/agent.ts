import { chatStream, type ChatMessage, type ReasoningEffort, type ToolDef } from '../api/siliconflow';
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

  // 轮次耗尽但模型仍要调工具（工具结果已在 out 末尾）：追加一轮无 tools 的强制收尾，确保给出最终回答
  // 注：未提供 tools 时模型结构上无法再产出 tool_calls；若异常返回，残留 tool_calls 也不会被执行（无调用方读取 out 的尾部工具调用）
  cb.onRoundStart?.(maxRounds);
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
  out.push(finalMsg);
  return out;
}
