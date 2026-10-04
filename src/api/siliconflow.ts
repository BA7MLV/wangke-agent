import type { ModelTarget } from '../store/settings';
import { assertRequestSafe, describeMessage, messageDefects, sanitizeMessages } from './messageHygiene';

/**
 * OpenAI 兼容 API 客户端（浏览器直调）。
 *
 * 过去这里接的是整个 `Settings`（只有一个全局 apiKey/baseUrl 时那样最省事）；
 * 现在接的是 `ModelTarget` —— **端点与模型绑定成一个整体**（见 settings.ts 的说明）。
 * 这样「拿文本模型的连接去打别家供应商的视觉模型」这类错配在类型上就写不出来，
 * 而多供应商下它会变成真的把请求发到错误的地址。
 */

export class ApiError extends Error {
  status: number;
  /** 429 时服务端要求的等待毫秒数（来自 Retry-After 响应头） */
  retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retry-After 头：秒数或 HTTP 日期，返回毫秒；无法解析返回 undefined */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * 网关的消息校验类报错。
 *
 * 这些 400 有一个共同点：**它们说的东西和用户看到的现象毫无关系**。
 * 界面上是「点了没反应 / 回答失败」，报出来却是 `Invalid assistant message:
 * content or tool_calls must be set` 加一个 request_id —— 不看请求体根本无从下手。
 * 所以命中这些模式时要把**我们送出去的历史形状**一并附上（见 `diagnose400`）。
 */
const MESSAGE_REJECTION_RE =
  /content or tool_calls must be set|must be followed by tool messages|invalid\s+\w*\s*message|must be one of/i;

/**
 * 把「消息不合法」这类 400 翻成人能直接定位的话：把请求里每条消息的形状列出来。
 *
 * 只在网关明确抱怨消息结构时才说话（`MESSAGE_REJECTION_RE` 命中才返回非 null）——
 * 否则返回一个与真实原因无关的猜测，只会把人带偏。
 */
export function diagnose400(serverMessage: string, messages: readonly ChatMessage[]): string | null {
  if (!MESSAGE_REJECTION_RE.test(serverMessage)) return null;
  const lines = [
    `网关拒绝了这次请求，说的是消息结构不合法：${serverMessage}`,
    `本次共送出 ${messages.length} 条消息，形状如下：`,
    ...messages.map((m, i) => `  ${describeMessage(m, i)}`),
  ];
  const defects = messageDefects(messages);
  if (defects.length > 0) {
    // 走到这里说明收口点漏了：把漏在哪写明，比让用户去猜强得多
    lines.push(`本地复查也发现 ${defects.length} 处可疑：`, ...defects.map((d) => `  ! ${d}`));
  } else {
    lines.push('本地复查没有发现不合法的消息 —— 那多半是网关对某种形态比我们更严格（例如空正文、纯图片段、或超长上下文）。');
  }
  return lines.join('\n');
}

async function request(
  s: Pick<ModelTarget, 'apiKey' | 'baseUrl'>,
  path: string,
  init: RequestInit = {},
  /** 出错时用来定位的消息历史（只有对话请求才有） */
  sent?: readonly ChatMessage[],
): Promise<Response> {
  const res = await fetch(`${s.baseUrl}${path}`, {
    ...init,
    headers: {
      // apiKey 为空时**不发** Authorization 头：发一个空 Bearer 会让「忘了填 key」
      // 表现为 401 认证失败，而不是「你没填 key」—— 两件事的排查方向完全不同。
      ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}),
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = data?.message || data?.error?.message || JSON.stringify(data);
    } catch {
      msg = await res.text().catch(() => msg);
    }
    const explained = sent ? diagnose400(msg, sent) : null;
    throw new ApiError(
      res.status,
      explained ?? msg,
      res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : undefined,
    );
  }
  return res;
}

/** 拉某家供应商在架的模型 id 列表（用于设置页的候选与「检查模型可用性」） */
export async function listModels(s: Pick<ModelTarget, 'apiKey' | 'baseUrl'>): Promise<string[]> {
  const res = await request(s, '/models');
  const data = await res.json();
  return (data.data as { id: string }[]).map((m) => m.id);
}

export interface TranscriptionSegment {
  /** 段内相对时间，秒 */
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  duration?: number;
  /** 句级时间戳（verbose_json，模型支持时才有；时间为音频内相对秒数） */
  segments?: TranscriptionSegment[];
}

/** 防御性解析 verbose_json 的句级 segments；任一项无效或整体缺失则返回 undefined */
function parseSegments(data: unknown): TranscriptionSegment[] | undefined {
  const list = (data as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(list)) return undefined;
  const out: TranscriptionSegment[] = [];
  for (const x of list as { start?: unknown; end?: unknown; text?: unknown }[]) {
    if (typeof x?.start !== 'number' || typeof x?.end !== 'number' || typeof x?.text !== 'string') continue;
    const text = x.text.trim();
    if (x.end > x.start && text) out.push({ start: x.start, end: x.end, text });
  }
  return out.length > 0 ? out : undefined;
}

export async function transcribe(
  s: ModelTarget,
  audio: Blob,
  filename = 'chunk.wav',
): Promise<TranscriptionResult> {
  const submit = (verbose: boolean) => {
    const form = new FormData();
    form.append('file', audio, filename);
    form.append('model', s.model);
    if (verbose) form.append('response_format', 'verbose_json');
    return request(s, '/audio/transcriptions', { method: 'POST', body: form });
  };
  let res: Response;
  try {
    // 优先请求 verbose_json 以拿句级时间戳（字幕按真实句子边界对齐）
    res = await submit(true);
  } catch (e) {
    // 模型/服务端不支持 verbose_json：退回默认 json 格式
    if ((e as ApiError).status === 400) res = await submit(false);
    else throw e;
  }
  const data = await res.json();
  return {
    text: typeof data?.text === 'string' ? data.text : '',
    duration: typeof data?.duration === 'number' ? data.duration : undefined,
    segments: parseSegments(data),
  };
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** 思考过程（推理模型返回的非标准字段） */
  reasoning_content?: string;
  /**
   * 网关回的 `finish_reason`（= pi 内部的 `stopReason`）。判断这一轮是否完整只看它：
   * `length` = 输出撞了 `max_tokens` 上限（tool 参数可能已被截断），`error`/`aborted` = 残缺轮次。
   * **不回传**：它是这一轮的元数据，不是对话内容（与 `reasoning_content` 同理）。
   */
  finish_reason?: FinishReason;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'aborted' | 'error';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 提取 assistant 消息的纯文本（多模态数组时拼接 text 部分） */
export function textOf(msg: ChatMessage | null | undefined): string {
  if (!msg || msg.content == null) return '';
  if (typeof msg.content === 'string') return msg.content;
  return msg.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
}

export type ReasoningEffort = 'low' | 'high' | 'max';

/**
 * 剥掉只属于「这一轮」的两个字段，得到**能发出去**的消息：
 *
 * - `reasoning_content`：回传会重复计费，官方亦不建议
 * - `finish_reason`：这一轮的元数据，不是对话内容
 *
 * 顺带在这里过 `sanitizeMessages` —— 它是发请求前的唯一收口点，所有调用方
 * （agent 循环 / 讲义 / 卡片 / 弹幕 / 评论…）都走这两个函数，所以脏历史只有一处能被修。
 */
function wire(messages: readonly ChatMessage[]): ChatMessage[] {
  const clean = sanitizeMessages(messages);
  // 发送前的最后一道闸。收口点已经让这条断言恒真（`test-message-hygiene.mjs` 守着），
  // 所以它触发只可能是「收口点有漏」—— 那时**宁可自己抛一条说清哪条消息不对的错**，
  // 也不要让网关回一句和界面现象毫无关系的 400，让用户只能对着 request_id 发呆。
  assertRequestSafe(clean);
  return clean.map(({ reasoning_content: _r, finish_reason: _f, ...m }) => m);
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  max_tokens?: number;
  signal?: AbortSignal;
  /** 开启思考（仅支持的模型） */
  enable_thinking?: boolean;
  /** 思考深度档位（仅 DeepSeek-V4 系 / GLM-5.2 生效） */
  reasoning_effort?: ReasoningEffort;
  /** 思考预算 tokens（多数推理模型生效），128~32768 */
  thinking_budget?: number;
}

/**
 * 非流式对话（用于工具调用循环中的决策）。
 *
 * `target` 同时给出端点与模型 id —— 两者不再分开传，调用方无法把它们配错。
 */
export async function chatOnce(t: ModelTarget, opts: ChatOptions): Promise<ChatMessage> {
  const messages = wire(opts.messages);
  const res = await request(t, '/chat/completions', {
    method: 'POST',
    signal: opts.signal,
    body: JSON.stringify({
      model: t.model,
      messages,
      tools: opts.tools,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
      enable_thinking: opts.enable_thinking,
      reasoning_effort: opts.reasoning_effort,
      thinking_budget: opts.thinking_budget,
      stream: false,
    }),
  }, messages);
  const data = await res.json();
  return data.choices[0].message as ChatMessage;
}

/** 流式对话：onDelta 回调正文增量，onReasoning 回调思考增量，返回完整 assistant 消息（含 tool_calls） */
export async function chatStream(
  t: ModelTarget,
  opts: ChatOptions,
  onDelta?: (content: string) => void,
  onReasoning?: (text: string) => void,
): Promise<ChatMessage> {
  const messages = wire(opts.messages);
  const res = await request(t, '/chat/completions', {
    method: 'POST',
    signal: opts.signal,
    body: JSON.stringify({
      model: t.model,
      messages,
      tools: opts.tools,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
      enable_thinking: opts.enable_thinking,
      reasoning_effort: opts.reasoning_effort,
      thinking_budget: opts.thinking_budget,
      stream: true,
    }),
  }, messages);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finish: FinishReason | undefined;
  const toolCalls: Record<number, ToolCall> = {};

  for (;;) {
    const { done, value } = await reader.read();
    if (!done) buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    // 流结束时缓冲区残留视为最后一个事件（末尾事件可能没有 \n\n 终止符）
    buffer = done ? '' : (events.pop() ?? '');
    for (const evt of events) {
      for (const line of evt.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          const choice = chunk.choices?.[0];
          // finish_reason 只在最后一个 chunk 上出现一次：判断这一轮是否完整全靠它
          if (choice?.finish_reason) finish = choice.finish_reason as FinishReason;
          const delta = choice?.delta;
          if (!delta) continue;
          if (delta.content) {
            content += delta.content;
            onDelta?.(delta.content);
          }
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content as string;
            onReasoning?.(delta.reasoning_content as string);
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              if (!toolCalls[i]) {
                toolCalls[i] = { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCalls[i].id = tc.id;
              if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
            }
          }
        } catch {
          // 忽略不完整的 JSON 块
        }
      }
    }
    if (done) break;
  }

  const msg: ChatMessage = { role: 'assistant', content: content || null };
  if (reasoning) msg.reasoning_content = reasoning;
  // 缺省按「完整」处理：网关没给 finish_reason 时不该把正常回复误判成残缺轮次
  if (finish) msg.finish_reason = finish;
  const calls = Object.values(toolCalls);
  if (calls.length > 0) msg.tool_calls = calls;
  return msg;
}
