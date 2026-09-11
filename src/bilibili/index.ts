// B 站视频导入编排：链接 → 解析（分 P 列表 + 字幕语言）→ 逐个分 P 拉流/拉字幕 → 产出 File + 字幕负载。
//
// 两步走（对应导入对话框的两个阶段）：
//   resolveBiliTarget(raw)   → 标题 + 全部分 P + 默认勾选 + 首个分 P 的字幕语言（便宜）
//   importBiliPages(target)  → 对每个选中分 P：重封装 mp4 + 拉该 P 的字幕，逐个回调
//
// 多 P（合集/系列课）说明：每个分 P 是独立的 cid，播放流与字幕都各拉各的；一门课几十个 P
// （实测 94 P / 57.9 小时），所以「挑哪些 P」由用户在对话框里勾，逐个下载并依次入队。
//
// 出口优先油猴桥（window.__wangkeBiliBridge），否则走 proxy。
// 返回的是普通 File（mp4），后续完全复用本地文件导入路径（probeDuration/saveVideoFile/db）。

import { fetchPlayStreams, fetchVideoView, resolveShortUrl, type BiliApiOptions, type BiliPageInfo } from './api';
import { fetchBiliSubtitleList, fetchSubtitleCues, type BiliSubtitleItem } from './dmview';
import { parseBiliInput, sanitizeFileName } from './parse';
import { pageLabel, pageVideoTitle, defaultPagesFor, resolveSelectedPages } from './pages';
import { remuxBiliToStream } from './remux';
import { buildBundle, pickPrimary, type SubtitleBundle } from './subtitle';
import type { StreamTargetChunk } from 'mediabunny';

/** 解析结果：一次解析后，勾分 P / 勾语言 / 真正下载都基于它 */
export interface BiliTarget {
  bvid: string;
  aid: number;
  /** 视频总标题（不含分 P 名） */
  title: string;
  pages: BiliPageInfo[];
  /** 解析时默认勾选的分 P（策略见 pages.ts） */
  defaultPages: number[];
  /** 首个选中分 P 上可用的自带字幕（切分 P 时用 fetchPageSubtitles 刷新） */
  subtitles: BiliSubtitleItem[];
}

/**
 * 解析输入（含 b23.tv 短链二次跳转），拿到目标 BV 分 P。
 */
export async function resolveInput(opts: BiliApiOptions, raw: string): Promise<{ bvid: string; page: number }> {
  const parsed = parseBiliInput(raw);
  if (!parsed.isShort) return { bvid: parsed.bvid, page: parsed.page };
  const bvid = await resolveShortUrl(opts, parsed.shortUrl!);
  return { bvid, page: parsed.page };
}

/** 该 P 的字幕语言列表；接口失败（代理白名单没放行、接口改版等）返回空，不打断导入 */
export async function fetchPageSubtitles(
  opts: BiliApiOptions,
  target: BiliTarget,
  page: number,
): Promise<BiliSubtitleItem[]> {
  const info = target.pages.find((p) => p.page === page);
  if (!info) return [];
  try {
    return await fetchBiliSubtitleList(opts, target.aid, info.cid);
  } catch {
    return [];
  }
}

/**
 * 第一阶段：解析链接 + 取全部分 P + 首个选中 P 的字幕语言列表。
 */
export async function resolveBiliTarget(opts: BiliApiOptions, raw: string): Promise<BiliTarget> {
  const explicitPage = /[?&]p=\d+/.test(raw) ? parseBiliInput(raw).page : null;
  const { bvid } = await resolveInput(opts, raw);
  const view = await fetchVideoView(opts, bvid);
  const defaultPages = defaultPagesFor(view.pages, explicitPage);
  const target: BiliTarget = {
    bvid,
    aid: view.aid,
    title: view.title,
    pages: view.pages,
    defaultPages,
    subtitles: [],
  };
  target.subtitles = await fetchPageSubtitles(opts, target, defaultPages[0]);
  return target;
}

/** 一个分 P 的导入产物 */
export interface BiliImportItem {
  page: number;
  info: BiliPageInfo;
  file: File;
  /** 主语言 + 全部已选语言；该 P 没有字幕时为 { primary: null, tracks: [] } */
  subtitles: SubtitleBundle;
}

export interface ImportBiliOptions extends BiliApiOptions {
  /** 要下载的字幕语言（B 站 lan key）；空数组 = 不要字幕 */
  langs?: string[];
  /** 要导入的分 P 序号；不传 = 用 target.defaultPages */
  pages?: number[];
}

/** 下载一路分 P 并重封装成 mp4 File */
async function remuxPageToFile(
  streams: { videoUrl: string; audioUrl: string | null; title: string },
  opts: BiliApiOptions,
  onProgress?: (ratio: number) => void,
): Promise<File> {
  // 说明：StreamTarget 写下来的是 { type:'write', data, position } 分片，且 fastStart:'reserve'
  // 会在收尾时回填靠前的 moov 区域，所以这里必须按 position 做「覆盖写」的落位，
  // 不能简单地把分片顺序拼起来（那样 moov 补写会被早先写入的占位字节盖掉）。
  // 若后续要支持超大视频，把这里换成直接写 OPFS 句柄即可（remux.ts 已支持 StreamTarget）。
  const parts: StreamTargetChunk[] = [];
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      parts.push({ type: 'write', data: chunk.data, position: chunk.position });
    },
  });

  await remuxBiliToStream({
    proxy: opts.proxy,
    cookie: opts.cookie,
    videoUrl: streams.videoUrl,
    audioUrl: streams.audioUrl,
    writable,
    onProgress,
  });

  let totalBytes = 0;
  for (const part of parts) {
    totalBytes = Math.max(totalBytes, part.position + part.data.byteLength);
  }
  const buffer = new Uint8Array(totalBytes);
  for (const part of parts) {
    buffer.set(part.data, part.position); // 后写的分片覆盖先写的，保证 moov 回填生效
  }

  const blob = new Blob([buffer], { type: 'video/mp4' });
  return new File([blob], `${sanitizeFileName(streams.title)}.mp4`, { type: 'video/mp4' });
}

/** 拉某个分 P 的字幕（按用户勾选的 lan 交集；某语言在这 P 上没有就跳过） */
async function loadPageSubtitles(
  opts: BiliApiOptions,
  target: BiliTarget,
  page: BiliPageInfo,
  langs: string[],
  onProgress?: (ratio: number) => void,
): Promise<SubtitleBundle> {
  if (langs.length === 0) return { primary: null, tracks: [] };
  let available: BiliSubtitleItem[] = [];
  try {
    available = await fetchBiliSubtitleList(opts, target.aid, page.cid);
  } catch {
    return { primary: null, tracks: [] };
  }
  const picked = available.filter((s) => langs.includes(s.lan));
  const fetched: { item: BiliSubtitleItem; cues: Awaited<ReturnType<typeof fetchSubtitleCues>> }[] = [];
  for (let i = 0; i < picked.length; i++) {
    try {
      // 直链的 auth_key 有效期很短，拿到就立刻拉
      fetched.push({ item: picked[i], cues: await fetchSubtitleCues(opts, picked[i].url) });
    } catch {
      // 单路字幕失败（链接过期等）不影响其它路与视频本体
    }
    onProgress?.((i + 1) / Math.max(1, picked.length));
  }
  return buildBundle(fetched, pickPrimary(fetched.map((f) => f.item)));
}

/**
 * 第二阶段：逐个分 P 下载（视频占该 P 的 0..0.9，字幕占 0.9..1），每完成一个 P 立即回调，
 * 调用方可以马上入队写盘 —— 下一个 P 的下载与上一个 P 的 OPFS 写入并行。
 */
export async function importBiliPages(
  target: BiliTarget,
  opts: ImportBiliOptions,
  onItem: (item: BiliImportItem) => void,
  onProgress?: (ratio: number, label: string) => void,
): Promise<void> {
  const { langs = [], pages: wanted, ...apiOpts } = opts;
  const selected = resolveSelectedPages(target.pages, wanted && wanted.length > 0 ? wanted : target.defaultPages);
  if (selected.length === 0) throw new Error('没有选中任何分 P');

  for (let i = 0; i < selected.length; i++) {
    const info = selected[i];
    const label = `${pageLabel(info)} · ${i + 1}/${selected.length}`;
    onProgress?.(i / selected.length, label);

    const streams = await fetchPlayStreams(apiOpts, target.bvid, info.cid);
    streams.title = pageVideoTitle(target.title, target.pages, info.page);
    const file = await remuxPageToFile(streams, apiOpts, (r) =>
      onProgress?.((i + r * 0.9) / selected.length, label),
    );

    const subtitles = await loadPageSubtitles(apiOpts, target, info, langs, (r) =>
      onProgress?.((i + 0.9 + r * 0.1) / selected.length, label),
    );

    onItem({ page: info.page, info, file, subtitles });
    onProgress?.((i + 1) / selected.length, label);
  }
}

export { parseBiliInput, sanitizeFileName, fetchBiliSubtitleList };
export type { BiliSubtitleItem, BiliPageInfo };
