import type { Settings } from '../store/settings';

/** 硅基流动 API 客户端（浏览器直调，OpenAI 兼容协议） */

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

async function request(s: Pick<Settings, 'apiKey' | 'baseUrl'>, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${s.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${s.apiKey}`,
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
    throw new ApiError(res.status, msg, res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : undefined);
  }
  return res;
}

export async function listModels(s: Pick<Settings, 'apiKey' | 'baseUrl'>): Promise<string[]> {
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
  s: Settings,
  model: string,
  audio: Blob,
  filename = 'chunk.wav',
): Promise<TranscriptionResult> {
  const submit = (verbose: boolean) => {
    const form = new FormData();
    form.append('file', audio, filename);
    form.append('model', model);
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

export async function embed(s: Settings, model: string, input: string[]): Promise<number[][]> {
  const res = await request(s, '/embeddings', {
    method: 'POST',
    body: JSON.stringify({ model, input }),
  });
  const data = await res.json();
  return (data.data as { embedding: number[] }[]).map((d) => d.embedding);
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
}

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

export interface ChatOptions {
  model: string;
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

/** 非流式对话（用于工具调用循环中的决策） */
export async function chatOnce(s: Settings, opts: ChatOptions): Promise<ChatMessage> {
  const res = await request(s, '/chat/completions', {
    method: 'POST',
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      // reasoning_content 不回传（避免重复计费，官方亦不建议）
      messages: opts.messages.map(({ reasoning_content: _drop, ...m }) => m),
      tools: opts.tools,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
      enable_thinking: opts.enable_thinking,
      reasoning_effort: opts.reasoning_effort,
      thinking_budget: opts.thinking_budget,
      stream: false,
    }),
  });
  const data = await res.json();
  return data.choices[0].message as ChatMessage;
}

/** 流式对话：onDelta 回调正文增量，onReasoning 回调思考增量，返回完整 assistant 消息（含 tool_calls） */
export async function chatStream(
  s: Settings,
  opts: ChatOptions,
  onDelta?: (content: string) => void,
  onReasoning?: (text: string) => void,
): Promise<ChatMessage> {
  const res = await request(s, '/chat/completions', {
    method: 'POST',
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      // reasoning_content 不回传（避免重复计费，官方亦不建议）
      messages: opts.messages.map(({ reasoning_content: _drop, ...m }) => m),
      tools: opts.tools,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
      enable_thinking: opts.enable_thinking,
      reasoning_effort: opts.reasoning_effort,
      thinking_budget: opts.thinking_budget,
      stream: true,
    }),
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
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
          const delta = chunk.choices?.[0]?.delta;
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
  const calls = Object.values(toolCalls);
  if (calls.length > 0) msg.tool_calls = calls;
  return msg;
}
