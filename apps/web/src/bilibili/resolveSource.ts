import { fetchVideoView, resolveShortUrl, type BiliApiOptions } from './api';
import { parseBiliInput } from './parse';
import { biliVideoSource, type BiliVideoSource } from './source';

/** 旧导入/本地文件没有来源标识时，只解析稿件与分 P，不下载视频。 */
export async function resolveBiliVideoSource(opts: BiliApiOptions, raw: string): Promise<BiliVideoSource> {
  const parsed = parseBiliInput(raw);
  const bvid = parsed.isShort ? await resolveShortUrl(opts, parsed.shortUrl!) : parsed.bvid;
  const view = await fetchVideoView(opts, bvid);
  const page = view.pages.find(item => item.page === parsed.page);
  if (!page) throw new Error(`该视频不存在 P${parsed.page}，请检查链接中的分 P 序号`);
  return biliVideoSource({ bvid, aid: view.aid }, page);
}
