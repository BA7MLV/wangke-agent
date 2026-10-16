import type { JevSettings } from '../store/settings';

/** 留足默认 32k 单问题 / 64k 请求窗口余量；UTF-8 字节数是保守的输入上界。 */
export const JEV_REQUEST_BYTES = 30_000;
export const JEV_MAX_QUESTIONS = 64;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface JevRequest {
  state: unknown;
  questions: Record<string, NoulQuestion>;
}

export function jevRequestBody(config: JevSettings, request: JevRequest): string {
  return JSON.stringify({ model: config.model.trim(), ...request });
}

export function fitsJevRequest(config: JevSettings, request: JevRequest): boolean {
  const count = Object.keys(request.questions).length;
  return count > 0 && count <= JEV_MAX_QUESTIONS &&
    new TextEncoder().encode(jevRequestBody(config, request)).length <= JEV_REQUEST_BYTES;
}

/** Jev 是独立决策端点，不走 Chat Completions，也不带 temperature / tools。 */
export async function evaluateNouls(
  config: JevSettings,
  request: JevRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Record<string, number>> {
  if (!config.apiKey.trim() || !config.model.trim()) throw new Error('请先填写 Jev API Key 和模型 ID');
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  const url = new URL(`${baseUrl}/systemone`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Jev API 地址必须使用 HTTPS（本机调试除外）');
  }
  if (!fitsJevRequest(config, request)) throw new Error('Jev 决策输入过长或问题数量超限');
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.throwIfAborted();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Jev 请求超时')), options.timeoutMs ?? 8000);
  try {
    const response = await fetch(url.href, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${config.apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: jevRequestBody(config, request),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Jev 请求失败（HTTP ${response.status}）`);
    const data = await response.json();
    const answers: Record<string, number> = {};
    // 不能把缺失 / 畸形响应当成「否」：那会让压缩误删消息，或路由误关技能。
    for (const id of Object.keys(request.questions)) {
      const value: unknown = data?.answers?.[id]?.noul;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error('Jev 返回了无效的判断概率');
      }
      answers[id] = value;
    }
    return answers;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
