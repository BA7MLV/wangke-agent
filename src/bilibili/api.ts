// 哔哩哔哩公开接口封装：BV→cid→播放地址。
// 出口见 transport.ts：油猴桥优先（本机直连），否则走自建代理。

import { biliRequest, type BiliBridge } from './transport';

export interface BiliApiOptions {
  /** 自建代理地址（油猴桥不可用时的回退） */
  proxy?: string;
  /** 可选：用户自己的 Cookie 串（SESSDATA=...; bili_jct=...）。不提供则匿名。 */
  cookie?: string;
  /** 测试注入油猴桥；生产读 window.__wangkeBiliBridge */
  bridge?: BiliBridge | null;
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

async function apiGet<T>(opts: BiliApiOptions, target: string): Promise<T> {
  let resp: Response;
  try {
    resp = await biliRequest(opts, target);
  } catch (e) {
    throw e instanceof Error ? e : new BiliHttpError(String(e));
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

function isStableCdn(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.bilivideo.com') && host.includes('upos-');
  } catch {
    return false;
  }
}

function pickUrl(s: DashStream): string {
  const candidates = [s.baseUrl, s.base_url, ...(s.backupUrl ?? []), ...(s.backup_url ?? [])].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  );
  if (!candidates.length) throw new BiliHttpError('流地址为空');
  return candidates.find(isStableCdn) ?? candidates[0];
}

/** 经代理解析 b23.tv 短链 → 最终落地页里的 BV 号 */
export async function resolveShortUrl(opts: BiliApiOptions, shortUrl: string): Promise<string> {
  let resp: Response;
  try {
    resp = await biliRequest(opts, shortUrl);
  } catch (e) {
    throw e instanceof Error ? e : new BiliHttpError(String(e));
  }
  if (!resp.ok) throw new BiliHttpError(`短链解析失败 HTTP ${resp.status}`, resp.status);
  const text = await resp.text();
  const { parseBvFromResolved } = await import('./parse');
  return parseBvFromResolved(text);
}
