// 哔哩哔哩公开接口封装：BV→cid→播放地址。所有请求经用户自建的 CORS 代理转发。
//
// 代理协议（见 cloudflare-worker/bili-proxy.js）：
//   GET {proxy}?url={encodeURIComponent(目标地址)}
//   可选头 X-Bili-Cookie：用户自己的 B 站 Cookie（含 SESSDATA 时解锁高清），
//   由代理透传为对 bilibili 域名的 Cookie 与 Referer。
//
// 不登录时 B 站只给 360P（qn=32 已登录普通清晰度需 Cookie；此处未登录仅 16/32 视接口而定），
// 登录 Cookie 由用户自愿提供，清晰度上限取决于其账号权限（本工具不破解任何限制）。

export interface BiliApiOptions {
  /** 自建代理地址，例如 https://bili-proxy.yourname.workers.dev */
  proxy: string;
  /** 可选：用户自己的 Cookie 串（SESSDATA=...; bili_jct=...）。不提供则匿名。 */
  cookie?: string;
}

/** 一个可用的播放流（DASH 一路视频 + 一路音频） */
export interface BiliStreams {
  /** 视频标题（用作导入文件名） */
  title: string;
  /** 视频流地址（m4s，DASH） */
  videoUrl: string;
  /** 音频流地址（m4s，DASH）；可能为 null（部分老视频/纯音频场景） */
  audioUrl: string | null;
  /** 清晰度描述，如 "高清 1080P" */
  qualityLabel: string;
  /** 视频时长（秒） */
  duration: number;
}

interface ViewPage {
  cid: number;
  part: string;
  page: number;
}
interface ViewData {
  title: string;
  duration: number;
  pages: ViewPage[];
}
interface DashStream {
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[];
  backup_url?: string[];
}
interface PlayUrlDash {
  duration: number;
  video: (DashStream & { id: number; width?: number; height?: number })[];
  audio: DashStream[] | null;
}

class BiliHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BiliHttpError';
  }
}

function joinUrl(proxy: string, target: string): string {
  const sep = proxy.includes('?') ? '&' : '?';
  return `${proxy}${sep}url=${encodeURIComponent(target)}`;
}

async function apiGet<T>(opts: BiliApiOptions, target: string): Promise<T> {
  if (!opts.proxy) throw new BiliHttpError('未配置哔哩哔哩代理地址，请先在「设置」页填写');
  const headers: Record<string, string> = {};
  if (opts.cookie) headers['X-Bili-Cookie'] = opts.cookie;
  let resp: Response;
  try {
    resp = await fetch(joinUrl(opts.proxy, target), { headers });
  } catch (e) {
    throw new BiliHttpError(`网络请求失败（代理不可达？）：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!resp.ok) throw new BiliHttpError(`接口请求失败 HTTP ${resp.status}`, resp.status);
  const json = (await resp.json()) as { code: number; message?: string; data?: T };
  if (json.code !== 0) {
    throw new BiliHttpError(`哔哩哔哩接口返回错误（code=${json.code}）：${json.message ?? '未知'}`);
  }
  if (json.data == null) throw new BiliHttpError('哔哩哔哩接口返回空数据');
  return json.data;
}

/** 取视频基本信息（标题/时长/分 P 列表），并选中目标分 P 的 cid */
export async function fetchVideoInfo(
  opts: BiliApiOptions,
  bvid: string,
  page: number,
): Promise<{ title: string; duration: number; cid: number }> {
  const data = await apiGet<ViewData>(
    opts,
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
  );
  const pages = data.pages ?? [];
  const target = pages.find((p) => p.page === page) ?? pages[0];
  if (!target) throw new BiliHttpError('未找到可用分 P');
  // 多分 P 时标题带上分 P 名，避免同名覆盖
  const title = pages.length > 1 && target.part ? `${data.title} P${target.page} ${target.part}` : data.title;
  return { title, duration: data.duration ?? 0, cid: target.cid };
}

/** 取播放地址（DASH 音视频分离），选可得的最高清晰度 */
export async function fetchPlayStreams(
  opts: BiliApiOptions,
  bvid: string,
  cid: number,
): Promise<BiliStreams> {
  // fnval=16 请求 DASH；qn 给最高（127=8K），接口会按账号权限返回实际可得清晰度
  const target =
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}` +
    `&cid=${cid}&fnval=16&qn=127&fourk=1`;
  const data = await apiGet<{ dash?: PlayUrlDash }>(opts, target);
  const dash = data.dash;
  if (!dash || !Array.isArray(dash.video) || dash.video.length === 0) {
    throw new BiliHttpError('未获取到 DASH 流（该视频可能为付费/地区限制/需登录）');
  }
  // 选最高分辨率的一路视频流（接口一般已按清晰度排序，稳妥起见再按高度挑）
  const video = [...dash.video].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  const videoUrl = pickUrl(video);
  const audio = dash.audio && dash.audio.length > 0 ? dash.audio[0] : null;
  const audioUrl = audio ? pickUrl(audio) : null;
  const qualityLabel = video.height ? `${video.height}P` : '标清';
  return {
    title: '',
    videoUrl,
    audioUrl,
    qualityLabel,
    duration: dash.duration ?? 0,
  };
}

function pickUrl(s: DashStream): string {
  const url = s.baseUrl ?? s.base_url ?? s.backupUrl?.[0] ?? s.backup_url?.[0];
  if (!url) throw new BiliHttpError('流地址为空');
  return url;
}

/** 经代理解析 b23.tv 短链 → 最终落地页里的 BV 号 */
export async function resolveShortUrl(opts: BiliApiOptions, shortUrl: string): Promise<string> {
  if (!opts.proxy) throw new BiliHttpError('未配置哔哩哔哩代理地址');
  const headers: Record<string, string> = {};
  if (opts.cookie) headers['X-Bili-Cookie'] = opts.cookie;
  let resp: Response;
  try {
    resp = await fetch(joinUrl(opts.proxy, shortUrl), { headers });
  } catch (e) {
    throw new BiliHttpError(`短链请求失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!resp.ok) throw new BiliHttpError(`短链解析失败 HTTP ${resp.status}`, resp.status);
  const text = await resp.text();
  const { parseBvFromResolved } = await import('./parse');
  return parseBvFromResolved(text);
}
