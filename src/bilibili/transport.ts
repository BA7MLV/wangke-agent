// B 站请求出口：油猴桥优先（本机 IP + 可改 Referer），代理回退（Worker / 自建）。

export interface BiliBridgeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
  headers?: Record<string, string>;
}

export interface BiliBridge {
  version: string;
  fetch: (url: string, init?: { cookie?: string }) => Promise<BiliBridgeResponse>;
}

export interface BiliTransportOpts {
  /** 自建代理（Cloudflare Worker 等），油猴桥不可用时才走 */
  proxy?: string;
  cookie?: string;
  /**
   * 测试注入。`undefined` = 读 window；`null` = 强制不用桥。
   */
  bridge?: BiliBridge | null;
}

export type TransportKind = 'bridge' | 'proxy' | 'none';

export interface TransportDesc {
  kind: TransportKind;
  hint: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __wangkeBiliBridge: BiliBridge | undefined;
}

export function getWindowBridge(): BiliBridge | null {
  const b = globalThis.__wangkeBiliBridge;
  if (b && typeof b.fetch === 'function') return b;
  return null;
}

export function isBiliBridgeAvailable(): boolean {
  return getWindowBridge() !== null;
}

function resolveBridge(explicit?: BiliBridge | null): BiliBridge | null {
  if (explicit === null) return null;
  if (explicit) return explicit;
  return getWindowBridge();
}

export function describeTransport(opts: { proxy?: string; bridge?: BiliBridge | null }): TransportDesc {
  if (resolveBridge(opts.bridge)) {
    return { kind: 'bridge', hint: '已连接油猴脚本，将从本机直连 B 站（不经过 Cloudflare）' };
  }
  if (opts.proxy?.trim()) {
    return { kind: 'proxy', hint: '将经填写的代理地址转发（Cloudflare Worker 可能被 B 站拒绝）' };
  }
  return {
    kind: 'none',
    hint: '请先安装油猴脚本（推荐），或在设置里填写代理地址',
  };
}

export function buildProxiedUrl(proxy: string, target: string): string {
  const sep = proxy.includes('?') ? '&' : '?';
  return `${proxy}${sep}url=${encodeURIComponent(target)}`;
}

const NO_TRANSPORT =
  '未检测到油猴脚本，且未配置哔哩哔哩代理地址。请先安装 Tampermonkey 脚本（推荐），或在设置里填写代理。';

function wrapBridgeResponse(r: BiliBridgeResponse): Response {
  let bufPromise: Promise<ArrayBuffer> | null = null;
  const getBuf = () => {
    bufPromise ??= r.arrayBuffer();
    return bufPromise;
  };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const buf = await getBuf();
      if (buf.byteLength) controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
  const headerMap = r.headers ?? {};
  const headers = new Headers();
  for (const [k, v] of Object.entries(headerMap)) headers.set(k, v);
  const resp = new Response(body, { status: r.status || (r.ok ? 200 : 500), headers });
  // 保留桥自己的 json/text（测试与 GM 解码一致），不走 Response 再解一遍
  return Object.assign(resp, {
    json: () => r.json(),
    text: () => r.text(),
    arrayBuffer: getBuf,
  });
}

export async function biliRequest(opts: BiliTransportOpts, target: string): Promise<Response> {
  const bridge = resolveBridge(opts.bridge);
  if (bridge) {
    const r = await bridge.fetch(target, { cookie: opts.cookie });
    return wrapBridgeResponse(r);
  }
  const proxy = opts.proxy?.trim();
  if (proxy) {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers['X-Bili-Cookie'] = opts.cookie;
    return fetch(buildProxiedUrl(proxy, target), { headers });
  }
  throw new Error(NO_TRANSPORT);
}
