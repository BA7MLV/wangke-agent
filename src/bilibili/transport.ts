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
  fetch: (url: string, init?: BiliBridgeRequestInit) => Promise<BiliBridgeResponse>;
  /**
   * 读浏览器里 .bilibili.com 的 Cookie。
   * 返回 cookie 串（空串 = 能读但本机没有）；`null` = 这个浏览器/扩展给不了（如 Safari 的 Userscripts 没有 GM_cookie）。
   * 旧版脚本（2.0 及更早）没有这个方法。
   */
  getCookie?: () => Promise<string | null>;
}

/** 给桥的请求参数（旧版脚本只认 cookie，其余字段会被忽略） */
export interface BiliBridgeRequestInit {
  cookie?: string;
  method?: 'GET' | 'POST';
  /** POST 请求体（gRPC 帧等二进制） */
  body?: Uint8Array;
  headers?: Record<string, string>;
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

export async function biliRequest(
  opts: BiliTransportOpts,
  target: string,
  init: BiliRequestInit = {},
): Promise<Response> {
  const bridge = resolveBridge(opts.bridge);
  if (bridge) {
    const r = await bridge.fetch(target, {
      cookie: opts.cookie,
      method: init.method,
      body: init.body,
      headers: init.headers,
    });
    return wrapBridgeResponse(r);
  }
  const proxy = opts.proxy?.trim();
  if (proxy) {
    // 用普通对象而不是 Headers：Worker 侧只认这几个头，也方便单测断言
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (opts.cookie) headers['X-Bili-Cookie'] = opts.cookie;
    return fetch(buildProxiedUrl(proxy, target), {
      method: init.method ?? 'GET',
      headers,
      body: init.body as BodyInit | undefined,
    });
  }
  throw new Error(NO_TRANSPORT);
}

/** 额外请求参数：字幕接口的 gRPC POST 需要用到 */
export interface BiliRequestInit {
  method?: 'GET' | 'POST';
  body?: Uint8Array;
  headers?: Record<string, string>;
}

/** 当前油猴桥的版本号；没装脚本返回 null */
export function getBiliBridgeVersion(): string | null {
  return getWindowBridge()?.version ?? null;
}

/** 桥是否支持 POST（2.1 起支持，B 站自带字幕接口要用） */
export function isBridgePostCapable(): boolean {
  const v = getBiliBridgeVersion();
  if (!v) return false;
  const [major = 0, minor = 0] = v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return major > 2 || (major === 2 && minor >= 1);
}

/** 读 Cookie 的结果：分开「没装桥 / 脚本太旧 / 扩展不给读 / 没登录 / 成功」，好给出对症的提示 */
export type BiliCookieRead =
  | { status: 'ok'; cookie: string }
  /** 没装桥（或脚本没注入到本页） */
  | { status: 'no-bridge' }
  /** 桥在，但版本太旧没有 getCookie（2.0 及更早装在浏览器里的副本不会自动更新） */
  | { status: 'old-bridge'; version: string }
  /** 桥在且支持，但浏览器/扩展不允许读 Cookie（Safari 的 Userscripts、GM_cookie 未授权） */
  | { status: 'unsupported' }
  /** 能读，但本机没有 bilibili.com 的 Cookie（没登录 / 无痕 / 容器标签页隔离） */
  | { status: 'empty' };

/**
 * 经油猴桥读本机 .bilibili.com 的 Cookie（含 SESSDATA）。
 * 注意：填不填这里的 Cookie 都不影响导入 —— 装了桥时浏览器的 Cookie 本来就会自动带上，
 * 这个字段主要是给「代理回退路径」（X-Bili-Cookie）和「状态可见」用的。
 */
export async function readBiliCookie(): Promise<BiliCookieRead> {
  const bridge = getWindowBridge();
  if (!bridge) return { status: 'no-bridge' };
  if (!bridge.getCookie) return { status: 'old-bridge', version: bridge.version };
  try {
    const raw = await bridge.getCookie();
    if (raw == null) return { status: 'unsupported' };
    const cookie = raw.trim();
    return cookie ? { status: 'ok', cookie } : { status: 'empty' };
  } catch {
    return { status: 'unsupported' };
  }
}
