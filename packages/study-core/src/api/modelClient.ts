import type { ModelTarget } from './modelTypes.ts';
import { createDsmlRecoverer, recoverDsmlText, type DsmlPart } from './dsml.ts';
import { assertRequestSafe, describeMessage, messageDefects, sanitizeMessages } from './messageHygiene.ts';
import { getModelMeta } from './modelMeta.ts';
import { parseDiscoveredModel, type DiscoveredModel } from './modelDiscoveryData.ts';
import type { ModelListConnection } from './modelTypes.ts';
import { modelUsage, usageCollector, type ModelUsage, type ModelRequestRecord } from './usage.ts';
import { applyPromptCache, stableTools } from './promptCache.ts';
import { groupToolResults } from './toolMessages.ts';
export type { ModelUsage } from './usage.ts';

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
  s: Pick<ModelTarget, 'apiKey' | 'baseUrl'> & Partial<Pick<ModelTarget, 'protocol'>>,
  path: string,
  init: RequestInit = {},
  /** 出错时用来定位的消息历史（只有对话请求才有） */
  sent?: readonly ChatMessage[],
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const res = await fetcher(`${s.baseUrl}${path}`, {
    ...init,
    headers: {
      // apiKey 为空时**不发** Authorization 头：发一个空 Bearer 会让「忘了填 key」
      // 表现为 401 认证失败，而不是「你没填 key」—— 两件事的排查方向完全不同。
      ...(s.apiKey && s.protocol === 'anthropic-messages' ? { 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01' } : {}),
      ...(s.protocol === 'anthropic-messages' ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
      ...(s.apiKey && s.protocol !== 'anthropic-messages' ? { Authorization: `Bearer ${s.apiKey}` } : {}),
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
export async function listModelDetails(
  s: ModelListConnection,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const connection = { ...s, baseUrl: s.baseUrl.trim().replace(/\/+$/, ''), apiKey: s.apiKey.trim() };
  const found = new Map<string, DiscoveredModel>();
  const cursors = new Set<string>();
  let path = '/models';
  for (let page = 0; page < 100; page++) {
    const res = await request(connection, path, { method: 'GET', signal, cache: 'no-store', credentials: s.credentials ?? 'omit', redirect: 'error' });
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object') throw new Error('模型列表响应格式无效');
    const body = data as { data?: unknown; models?: unknown; has_more?: unknown; last_id?: unknown };
    const models = Array.isArray(data) ? data : body.data ?? body.models;
    if (!Array.isArray(models)) throw new Error('接口未返回模型列表，可手动添加模型');
    for (const model of models) {
      const parsed = parseDiscoveredModel(model);
      if (!parsed) throw new Error('模型列表条目缺少有效 ID');
      if (!found.has(parsed.id)) found.set(parsed.id, parsed);
    }
    if (body.has_more === undefined || body.has_more === false) return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (body.has_more !== true || typeof body.last_id !== 'string' || !body.last_id || cursors.has(body.last_id)) {
      throw new Error('模型列表分页信息无效');
    }
    cursors.add(body.last_id);
    path = `/models?after_id=${encodeURIComponent(body.last_id)}`;
  }
  throw new Error('模型列表分页超出安全上限');
}

/** 兼容仅消费 ID 的调用方。 */
export async function listModels(
  s: ModelListConnection,
  signal?: AbortSignal,
): Promise<string[]> {
  return (await listModelDetails(s, signal)).map((m) => m.id);
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
  if (s.protocol === 'anthropic-messages') {
    throw new Error('Anthropic Messages 协议不提供 OpenAI 兼容的音频转写接口，请为语音识别槽位选择 OpenAI Chat 供应商');
  }
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
  usage?: ModelUsage;
  /** Exact provider blocks, including signed/encrypted reasoning. Only replay
   * to the same connection/model/protocol; UI text is a separate projection. */
  providerState?: { providerId: string; baseUrl: string; model: string; protocol: ModelTarget['protocol']; items: Record<string, any>[] };
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'aborted' | 'error';

/** Keep provider-specific finish values from leaking into the agent protocol. */
function normalizeFinishReason(value: unknown): FinishReason | undefined {
  if (value == null || value === '') return undefined;
  switch (String(value)) {
    case 'stop':
    case 'completed':
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
    case 'incomplete':
      return 'length';
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool_calls';
    case 'content_filter':
    case 'refusal':
      return 'content_filter';
    case 'aborted':
    case 'cancelled':
      return 'aborted';
    case 'error':
    case 'failed':
      return 'error';
    default:
      return undefined;
  }
}

function streamErrorOf(chunk: any): string | undefined {
  const error = chunk?.error ?? (chunk?.type === 'error' ? chunk : undefined);
  if (!error) return undefined;
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message) return error.message;
  if (typeof error.error?.message === 'string' && error.error.message) return error.error.message;
  try { return JSON.stringify(error); } catch { return '模型服务返回了未知流式错误'; }
}

/** Responses status takes precedence over the presence of function calls. */
function responseFinishReason(data: any, hasCalls: boolean): FinishReason {
  if (data.status === 'incomplete') {
    const reason = data.incomplete_details?.reason;
    return reason === 'content_filter' ? 'content_filter'
      : reason === 'steered' ? 'aborted'
      : reason == null || reason === 'max_output_tokens' ? 'length' : 'error';
  }
  const reason = normalizeFinishReason(data.status);
  return reason && reason !== 'stop' ? reason : hasCalls ? 'tool_calls' : reason ?? 'stop';
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A progressively assembled function call, useful for rendering large tool arguments. */
export interface ToolCallDelta {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/** 提取 assistant 消息的纯文本（多模态数组时拼接 text 部分） */
export function textOf(msg: ChatMessage | null | undefined): string {
  if (!msg || msg.content == null) return '';
  if (typeof msg.content === 'string') return msg.content;
  return msg.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
}

/**
 * 思考深度档位。**刻度对齐 OpenAI 的 `reasoning_effort`**：minimal / low / medium / high / xhigh。
 *
 * 少一个 `none` —— 那是滑块第一档「不思考」，由 `enable_thinking: false` 表达，见 `ThinkingLevel`。
 * 为什么不让 `none` 混进来：硅基流动文档里 `reasoning_effort` 的 enum 只有 `high` / `max`
 * （见 modelCaps 的 DOC_EFFORT_MODELS），发 `'none'` 会被拒或被静默忽略；关掉思考走的是
 * **另一个字段** `enable_thinking`。两个字段不能混成一张枚举，否则「关掉」会变成一个发不出去的档位。
 *
 * 旧的 `'max'` 并入了 `'xhigh'`（`max` 是 Kimi / GLM 那边的叫法，语义同为「最高」）：
 * 落库的旧值由 settings 的归一化映射过来，**请求侧仍按模型自己声明的名字发**（见 toEffortValue）。
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** 滑块上的 6 档 = 5 档深度 + 第一档「不思考」 */
export type ThinkingLevel = 'none' | ReasoningEffort;

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
  return clean.map(({ finish_reason: _f, usage: _u, ...m }) => m);
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
  cacheKey?: string;
  tool_choice?: 'auto' | 'none';
  onRequest?: (record: ModelRequestRecord) => void | Promise<void>;
}

function chatPath(t: ModelTarget): string {
  return t.protocol === 'anthropic-messages' ? '/messages' : t.protocol === 'openai-responses' ? '/responses' : '/chat/completions';
}

function gatewayCacheHeaders(t: ModelTarget, key?: string): Record<string, string> | undefined {
  return key && /\/api\/v1\/cloud\/models\/[^/]+$/.test(t.baseUrl) ? { 'x-wangke-cache-key': key } : undefined;
}

function anthropicContent(content: ChatMessage['content']): unknown {
  if (!Array.isArray(content)) return content ?? '';
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    const url = part.image_url.url;
    const data = url.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
    return data
      ? { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } }
      : { type: 'image', source: { type: 'url', url } };
  });
}

function responsesContent(content: ChatMessage['content']): unknown {
  if (!Array.isArray(content)) return content ?? '';
  return content.map((part) => part.type === 'text'
    ? { type: 'input_text', text: part.text }
    : { type: 'input_image', image_url: part.image_url.url });
}

export function requestBody(t: ModelTarget, opts: ChatOptions, messages: ChatMessage[], stream: boolean): Record<string, unknown> {
  return applyPromptCache(serializeBody(t, { ...opts, tools: opts.tools ? stableTools(opts.tools) : undefined }, messages, stream), t, opts.cacheKey);
}

function nativeItems(t: ModelTarget, message: ChatMessage) {
  const state = message.providerState;
  return state?.protocol === t.protocol && state.model === t.model && state.providerId === t.providerId && state.baseUrl === t.baseUrl ? state.items : undefined;
}

function serializeBody(t: ModelTarget, opts: ChatOptions, messages: ChatMessage[], stream: boolean): Record<string, unknown> {
  const meta = getModelMeta(t.catalogId, t.model, t.capabilities);
  if (opts.tools?.length && meta?.declaredToolCall === false) {
    throw new Error('此模型已声明不支持工具调用；请切换支持工具的模型，或在模型编辑器中确认工具调用能力');
  }
  if (meta?.declaredOutput != null && meta.declaredOutput > 0) {
    opts = { ...opts, max_tokens: Math.min(opts.max_tokens ?? 4096, meta.declaredOutput) };
  }
  if (t.protocol === 'anthropic-messages') {
    const system = messages.filter((m) => m.role === 'system').map((m) => ({ type: 'text', text: typeof m.content === 'string' ? m.content : '' }));
    const turns = messages.filter((m) => m.role !== 'system').map((m) => {
      if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : '' }] };
      const native = nativeItems(t, m);
      if (m.role === 'assistant' && native?.length) return { role: 'assistant', content: native };
      if (m.role === 'assistant' && m.tool_calls?.length) return { role: 'assistant', content: [
        ...(typeof m.content === 'string' && m.content ? [{ type: 'text', text: m.content }] : []),
        ...m.tool_calls.map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) })),
      ] };
      return { role: m.role, content: anthropicContent(m.content) };
    });
    return {
      model: t.model, messages: groupToolResults(turns), ...(system.length ? { system } : {}), max_tokens: opts.max_tokens ?? 4096,
      ...(opts.temperature == null ? {} : { temperature: opts.temperature }),
      ...(opts.tools?.length ? { tools: opts.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })) } : {}),
      ...(opts.tool_choice ? { tool_choice: { type: opts.tool_choice } } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }
  if (t.protocol === 'openai-responses') {
    const input = messages.map((m) => {
      if (m.role === 'tool') return { type: 'function_call_output', call_id: m.tool_call_id, output: typeof m.content === 'string' ? m.content : '' };
      const native = nativeItems(t, m);
      if (m.role === 'assistant' && native?.length) return native;
      if (m.role === 'assistant' && m.tool_calls?.length) return [
        ...(m.content ? [{ role: 'assistant', content: m.content }] : []),
        ...m.tool_calls.map((tc) => ({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments })),
      ];
      return { role: m.role, content: responsesContent(m.content) };
    }).flat();
    return {
      model: t.model, input, store: false, include: ['reasoning.encrypted_content'], ...(opts.max_tokens == null ? {} : { max_output_tokens: opts.max_tokens }),
      ...(opts.temperature == null ? {} : { temperature: opts.temperature }),
      ...(opts.tools?.length ? { tools: opts.tools.map((tool) => ({ type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters, strict: false })) } : {}),
      ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }
  return { model: t.model, messages: messages.map(({ providerState: _p, usage: _u, finish_reason: _f, reasoning_content: _r, ...m }) => m), tools: opts.tools, tool_choice: opts.tool_choice, temperature: opts.temperature, max_tokens: opts.max_tokens,
    enable_thinking: opts.enable_thinking, reasoning_effort: opts.reasoning_effort, thinking_budget: opts.thinking_budget, stream };
}

function parseArgs(value: string): Record<string, unknown> {
  try { return JSON.parse(value); } catch { return {}; }
}

function normalizeResponse(data: any, protocol: ModelTarget['protocol']): ChatMessage {
  const error = streamErrorOf(data);
  if (error) throw new Error(`模型服务返回错误：${error}`);
  if (protocol === 'anthropic-messages') {
    if (!Array.isArray(data.content)) throw new Error('模型接口未返回有效消息，请重试或检查模型配置');
    const blocks = data.content;
    const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    const calls = blocks.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    return { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}), finish_reason: normalizeFinishReason(data.stop_reason) ?? (calls.length ? 'tool_calls' : 'stop') };
  }
  if (protocol === 'openai-responses') {
    if (!Array.isArray(data.output)) throw new Error('模型接口未返回有效消息，请重试或检查模型配置');
    const output = data.output;
    const text = output.flatMap((item: any) => item.content ?? []).filter((b: any) => b.type === 'output_text').map((b: any) => b.text).join('');
    const calls = output.filter((item: any) => item.type === 'function_call').map((item: any) => ({ id: item.call_id ?? item.id, type: 'function' as const, function: { name: item.name, arguments: item.arguments ?? '{}' } }));
    const finish_reason = responseFinishReason(data, calls.length > 0);
    return { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}), finish_reason };
  }
  const choice = data.choices?.[0];
  if (!choice?.message) throw new Error('模型接口未返回有效消息，请重试或检查模型配置');
  const { finish_reason: messageFinishReason, ...message } = choice.message;
  const finish_reason = normalizeFinishReason(choice.finish_reason ?? messageFinishReason);
  return { ...message, ...(finish_reason ? { finish_reason } : {}) } as ChatMessage;
}

function responseMetadata(msg: ChatMessage, data: any, target: ModelTarget): ChatMessage {
  const items = target.protocol === 'anthropic-messages' ? data.content : target.protocol === 'openai-responses' ? data.output : undefined;
  const usage = modelUsage(data);
  return { ...msg, ...(usage ? { usage } : {}), ...(Array.isArray(items) && items.length ? {
    providerState: { providerId: target.providerId, baseUrl: target.baseUrl, model: target.model, protocol: target.protocol, items },
  } : {}) };
}

/**
 * 非流式对话（用于工具调用循环中的决策）。
 *
 * `target` 同时给出端点与模型 id —— 两者不再分开传，调用方无法把它们配错。
 */
async function observeRequest(t: ModelTarget, opts: ChatOptions, operation: (capture: (usage?: ModelUsage) => void) => Promise<ChatMessage>): Promise<ChatMessage> {
  const startedAt = Date.now(), id = crypto.randomUUID();
  let message: ChatMessage | undefined;
  let usage: ModelUsage | undefined;
  try { message = await operation(value => { if (value) usage = value; }); return message; }
  finally {
    await opts.onRequest?.({ id, providerId: t.providerId, model: t.model, protocol: t.protocol,
      startedAt, endedAt: Date.now(), status: opts.signal?.aborted || message?.finish_reason === 'aborted' ? 'cancelled'
        : !message || message.finish_reason === 'error' ? 'failed' : 'completed',
      ...(message?.usage || usage ? { usage: message?.usage ?? usage } : {}) });
  }
}

export function chatOnce(t: ModelTarget, opts: ChatOptions, fetcher?: typeof fetch): Promise<ChatMessage> {
  return observeRequest(t, opts, () => chatOnceInner(t, opts, fetcher));
}
async function chatOnceInner(t: ModelTarget, opts: ChatOptions, fetcher?: typeof fetch): Promise<ChatMessage> {
  const messages = wire(opts.messages);
  const res = await request(t, chatPath(t), {
    method: 'POST',
    signal: opts.signal,
    body: JSON.stringify(requestBody(t, opts, messages, false)),
    headers: gatewayCacheHeaders(t, opts.cacheKey),
  }, messages, fetcher);
  const body = await res.text();
  opts.signal?.throwIfAborted();
  if (!body.trim()) throw new Error('模型接口返回为空，请重试或检查模型服务');
  let data: unknown;
  try { data = JSON.parse(body); } catch {
    throw new Error('模型接口返回的数据不完整或不是有效 JSON，请重试或检查模型服务');
  }
  if (!data || typeof data !== 'object') throw new Error('模型接口未返回有效消息，请重试或检查模型配置');
  const msg = responseMetadata(normalizeResponse(data, t.protocol), data, t);
  // 只有声明了工具才需要 DSML 兜底：没给工具时模型没有理由吐 DSML 标记，
  // 那时的尖括号更可能是正文（讲义片段、HTML），吞掉就是毁内容。
  if (!opts.tools?.length || typeof msg.content !== 'string') return msg;
  return applyRecoveredDsml(msg, msg.content as string);
}

/**
 * 把一次性还原的结果并回 assistant 消息（非流式路径）。
 *
 * 有一条不能省的兜底：**还原后正文与调用都空了，就原样返回**。
 * 否则会得到「正文空 + 无 tool_calls」—— 那正是 `messageHygiene` 要拦的非法消息，
 * 下一轮请求直接 400；显示几行脏字符比整个会话卡死好得多。
 */
function applyRecoveredDsml(msg: ChatMessage, raw: string): ChatMessage {
  const { text, calls } = recoverDsmlText(raw);
  if (calls.length === 0 && !text.trim()) return msg;
  return {
    ...msg,
    content: text || null,
    ...(calls.length
      ? {
          tool_calls: [
            ...(msg.tool_calls ?? []),
            ...calls.map((c) => ({
              id: `dsml_${crypto.randomUUID()}`,
              type: 'function' as const,
              function: { name: c.name, arguments: c.arguments },
            })),
          ],
        }
      : {}),
  };
}

/**
 * 少数网关会把未解析的工具调用压成字段名串并塞进正文，例如
 * `show_widgetformatsvgcode`。它不是用户内容，也不是合法的 DSML；即使
 * 无法安全还原调用，也不能把这段内部协议泄漏到聊天气泡里。
 *
 * 这里只移除明确的工具调用前缀，不做宽泛的 XML/HTML 清洗，避免误伤 SVG
 * 或讲义正文。真正的结构化调用仍由 DSML recoverer 负责。
 */
function stripLeakedToolPreamble(text: string): string {
  return text.replace(
    /(?:^|\s)(?:show_widget|writeFile|write)\s*(?:format|filePath|path)\s*(?:svg|mermaid|diagram|html|\/tmp\/[^\s]+)?\s*(?:code|content)?(?=\s|<|$)/gi,
    (match) => match.startsWith(' ') ? ' ' : '',
  );
}

/** 流式对话：onDelta 回调正文增量，onReasoning 回调思考增量，返回完整 assistant 消息（含 tool_calls） */
export function chatStream(
  t: ModelTarget, opts: ChatOptions, onDelta?: (content: string) => void,
  onReasoning?: (text: string) => void, onToolCallDelta?: (call: ToolCallDelta) => void, fetcher: typeof fetch = fetch,
): Promise<ChatMessage> {
  return observeRequest(t, opts, capture => chatStreamInner(t, opts, onDelta, onReasoning, onToolCallDelta, fetcher, capture));
}
async function chatStreamInner(
  t: ModelTarget,
  opts: ChatOptions,
  onDelta?: (content: string) => void,
  onReasoning?: (text: string) => void,
  onToolCallDelta?: (call: ToolCallDelta) => void,
  fetcher: typeof fetch = fetch,
  capture?: (usage?: ModelUsage) => void,
): Promise<ChatMessage> {
  const messages = wire(opts.messages);
  const res = await request(t, chatPath(t), {
    method: 'POST',
    signal: opts.signal,
    body: JSON.stringify(requestBody(t, opts, messages, true)),
    headers: gatewayCacheHeaders(t, opts.cacheKey),
  }, messages, fetcher);

  /**
   * Some OpenAI-compatible gateways ignore `stream=true` and return one JSON
   * response. Treat that as a one-chunk stream instead of trying to parse JSON
   * as SSE (which otherwise looks like an empty answer).
   */
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    const body = await res.text();
    opts.signal?.throwIfAborted();
    if (!body.trim()) throw new Error('模型接口返回为空，请重试或检查模型服务');
    let data: unknown;
    try { data = JSON.parse(body); } catch { throw new Error('模型接口返回的数据不完整或不是有效 JSON，请重试或检查模型服务'); }
    if (!data || typeof data !== 'object') throw new Error('模型接口未返回有效消息，请重试或检查模型配置');
    const raw = responseMetadata(normalizeResponse(data, t.protocol), data, t);
    const msg = !opts.tools?.length || typeof raw.content !== 'string' ? raw : applyRecoveredDsml(raw, raw.content);
    const content = textOf(msg);
    if (content) onDelta?.(content);
    if (msg.reasoning_content) onReasoning?.(msg.reasoning_content);
    msg.tool_calls?.forEach((call, index) => onToolCallDelta?.({
      index, id: call.id, name: call.function.name, arguments: call.function.arguments,
    }));
    return msg;
  }

  if (!res.body) throw new Error('模型接口没有返回可读取的流，请重试或检查模型服务');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finish: FinishReason | undefined;
  let ended = false;
  const toolCalls: Record<number, ToolCall> = {};
  const usage = usageCollector();
  const native: Record<number, Record<string, any>> = {};
  let responseItems: Record<string, any>[] | undefined;
  /**
   * DSML 兜底还原器，**只在真的声明了工具时装**。
   *
   * 没给工具时模型没有理由吐 DSML 标记，那时的尖括号更可能是正文（讲义片段、
   * HTML），还原器会把它们吞掉 —— 那就是拿一个 bug 换另一个 bug。
   */
  const dsml = opts.tools?.length ? createDsmlRecoverer() : null;
  /** 从 DSML 还原出来的调用单独放最后合并：网关给的 index 是连续的，直接往
   *  `toolCalls` 里塞会撞号（网关跳过某个 index 时就会覆盖前一个）。 */
  const recovered: ToolCall[] = [];

  const emitToolCall = (index: number) => {
    const call = toolCalls[index];
    if (!call) return;
    onToolCallDelta?.({
      index,
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  };

  /** 还原器的产出：只有 text 能给界面，toolCall 进 recovered */
  const absorb = (parts: DsmlPart[]) => {
    let text = '';
    for (const p of parts) {
      if (p.kind === 'text') text += p.text;
      else {
        const id = `dsml_${crypto.randomUUID()}`;
        recovered.push({
          id,
          type: 'function',
          function: { name: p.name, arguments: p.arguments },
        });
        onToolCallDelta?.({
          index: Object.keys(toolCalls).length + recovered.length - 1,
          id,
          name: p.name,
          arguments: p.arguments,
        });
      }
    }
    if (text) {
      content += text;
      onDelta?.(text);
    }
  };

  try {
    stream: for (;;) {
      opts.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      opts.signal?.throwIfAborted();
      // Flush TextDecoder on the terminal read so a split UTF-8 code point is not
      // silently lost at the end of an otherwise successful stream.
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      // At EOF the remaining text is itself an event; during streaming retain it
      // until the next blank line arrives.
      buffer = done ? '' : (events.pop() ?? '');
      for (const evt of events) {
        const payload = evt.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n').trim();
        if (!payload) continue;
        if (payload === '[DONE]') { ended = true; break stream; }
        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          // A complete SSE event is not an incomplete JSON fragment. Propagate
          // this as a stream failure instead of returning a misleading empty or
          // partial answer after silently discarding the provider error.
          throw new Error('模型接口返回了无效的流式 JSON，请重试或检查模型服务');
        }
        if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw new Error('模型接口未返回有效的流式消息');
        const streamError = streamErrorOf(/^event:\s*error\s*$/m.test(evt) ? { ...chunk, type: 'error' } : chunk);
        if (streamError) throw new Error(`模型服务返回错误：${streamError}`);
        usage.observe(chunk);
        capture?.(usage.value);
        if (t.protocol === 'anthropic-messages') {
          const delta = chunk.delta;
          if (chunk.type === 'content_block_start') native[chunk.index] = structuredClone(chunk.content_block);
          const block = native[chunk.index];
          if (chunk.type === 'content_block_delta' && block) {
            if (delta?.type === 'text_delta') block.text = (block.text ?? '') + delta.text;
            if (delta?.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + delta.thinking;
            if (delta?.type === 'signature_delta') block.signature = (block.signature ?? '') + delta.signature;
          }
          if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
            const i = chunk.index ?? Object.keys(toolCalls).length;
            toolCalls[i] = { id: chunk.content_block.id, type: 'function', function: { name: chunk.content_block.name, arguments: '' } };
            emitToolCall(i);
          }
          if (chunk.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
            const text = stripLeakedToolPreamble(delta.text);
            if (text) { content += text; onDelta?.(text); }
          }
          if (chunk.type === 'content_block_delta' && delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') { reasoning += delta.thinking; onReasoning?.(delta.thinking); }
          if (chunk.type === 'content_block_delta' && delta?.type === 'input_json_delta' && delta.partial_json) {
            const i = chunk.index ?? 0;
            const call = toolCalls[i];
            if (call) {
              call.function.arguments += delta.partial_json;
              emitToolCall(i);
            }
          }
          if (chunk.type === 'content_block_stop' && block?.type === 'tool_use') block.input = parseArgs(toolCalls[chunk.index]?.function.arguments ?? '{}');
          if (chunk.type === 'message_delta') finish = normalizeFinishReason(chunk.delta?.stop_reason) ?? finish;
          if (chunk.type === 'message_stop') { ended = true; break stream; }
          continue;
        }
        if (t.protocol === 'openai-responses') {
          if (chunk.type === 'response.output_item.done') native[chunk.output_index] = chunk.item;
          if (chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') {
            const text = stripLeakedToolPreamble(chunk.delta);
            if (text) { content += text; onDelta?.(text); }
          }
          if (chunk.type === 'response.reasoning_summary_text.delta' && typeof chunk.delta === 'string') { reasoning += chunk.delta; onReasoning?.(chunk.delta); }
          if (chunk.type === 'response.output_item.added' && chunk.item?.type === 'function_call') {
            const i = chunk.output_index ?? Object.keys(toolCalls).length;
            toolCalls[i] = { id: chunk.item.call_id ?? chunk.item.id, type: 'function', function: { name: chunk.item.name, arguments: '' } };
            emitToolCall(i);
          }
          if (chunk.type === 'response.function_call_arguments.delta') {
            const i = chunk.output_index ?? 0;
            const call = toolCalls[i];
            if (call) {
              call.function.arguments += chunk.delta ?? '';
              emitToolCall(i);
            }
          }
          if (['response.completed', 'response.incomplete', 'response.failed'].includes(chunk.type)) {
            responseItems = chunk.response?.output;
            finish = responseFinishReason({ ...chunk.response, status: chunk.response?.status ?? chunk.type.slice('response.'.length) }, Object.values(toolCalls).length > 0);
            ended = true;
            break stream;
          }
          continue;
        }
        const choice = chunk.choices?.[0];
        // finish_reason 只在最后一个 chunk 上出现一次：判断这一轮是否完整全靠它
        if (choice?.finish_reason) finish = normalizeFinishReason(choice.finish_reason) ?? finish;
        const delta = choice?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) {
          // ⚠️ 这里过去是「原样显示」，正是 DSML 泄漏被看见的地方：
          // 标记进界面、tool_calls 却是空的，于是 agent 以为模型答完了。
          if (dsml) absorb(dsml.push(delta.content));
          else {
            const text = stripLeakedToolPreamble(delta.content);
            if (text) { content += text; onDelta?.(text); }
          }
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onReasoning?.(delta.reasoning_content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolCalls[i]) {
              toolCalls[i] = { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } };
              emitToolCall(i);
            }
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
            if (tc.id || tc.function?.name || tc.function?.arguments) emitToolCall(i);
          }
        }
      }
      if (done) break;
    }
  } finally {
    // Do not retain a live response after [DONE], parser failure or a throwing
    // UI callback. Never let cancellation mask the original error.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  // A clean HTTP EOF does not prove the model finished. Some proxies simply
  // close a broken upstream connection; do not execute its partial tool calls.
  if (!ended && !finish) throw new Error('模型响应流意外结束，未收到完成标记');
  if (dsml) absorb(dsml.flush());
  const msg: ChatMessage = { role: 'assistant', content: content || null };
  if (reasoning) msg.reasoning_content = reasoning;
  // [DONE]/native terminal events are sufficient even without finish_reason.
  if (finish) msg.finish_reason = finish;
  const calls = [...Object.values(toolCalls), ...recovered];
  if (calls.length > 0) msg.tool_calls = calls;
  if (usage.value) msg.usage = usage.value;
  const items = responseItems ?? Object.values(native);
  if (items.length) msg.providerState = { providerId: t.providerId, baseUrl: t.baseUrl, model: t.model, protocol: t.protocol, items };
  return msg;
}
