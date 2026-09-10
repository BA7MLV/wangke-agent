// B 站视频导入编排：链接 → 解析 → 拉流 → 重封装 → 产出 File（走 Library 现有导入链）。
//
// 用法：const file = await importBiliVideo(rawInput, { proxy, cookie }, onProgress)
// 出口优先油猴桥（window.__wangkeBiliBridge），否则走 proxy。
// 返回一个普通 File（mp4），后续完全复用本地文件导入路径（probeDuration/saveVideoFile/db）。

import { fetchPlayStreams, fetchVideoInfo, resolveShortUrl, type BiliApiOptions } from './api';
import { parseBiliInput, sanitizeFileName } from './parse';
import { remuxBiliToStream } from './remux';

export interface ImportProgress {
  (ratio: number): void;
}

/**
 * 解析输入（含 b23.tv 短链二次跳转），拿到目标 BV 与分 P。
 */
export async function resolveInput(opts: BiliApiOptions, raw: string): Promise<{ bvid: string; page: number }> {
  const parsed = parseBiliInput(raw);
  if (!parsed.isShort) return { bvid: parsed.bvid, page: parsed.page };
  const bvid = await resolveShortUrl(opts, parsed.shortUrl!);
  return { bvid, page: parsed.page };
}

/**
 * 主导入：把 B 站视频变成一个本地 mp4 File。
 * onProgress 报 0..1（下载+封装）。调用方拿到 File 后按本地导入流程入库。
 */
export async function importBiliVideo(
  raw: string,
  opts: BiliApiOptions,
  onProgress?: ImportProgress,
): Promise<File> {
  const { bvid, page } = await resolveInput(opts, raw);

  // 取视频信息（标题/分 P cid/时长）
  const info = await fetchVideoInfo(opts, bvid, page);

  // 取播放流地址（DASH 音视频分离）
  const streams = await fetchPlayStreams(opts, bvid, info.cid);
  streams.title = info.title;

  // 重封装写入一个临时 File（先在内存 Blob，再由调用方走 OPFS 分块写入）
  // 说明：这里用「内存累积 + 一次性产出 File」是为了无缝复用现有 saveVideoFile 链；
  // 若后续要支持超大视频可再改为直接写 OPFS 句柄（remux.ts 已支持 StreamTarget）。
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  }) as unknown as FileSystemWritableFileStream;

  await remuxBiliToStream({
    proxy: opts.proxy,
    cookie: opts.cookie,
    videoUrl: streams.videoUrl,
    audioUrl: streams.audioUrl,
    writable,
    onProgress,
  });

  const blob = new Blob(chunks as BlobPart[], { type: 'video/mp4' });
  const name = `${sanitizeFileName(streams.title)}.mp4`;
  return new File([blob], name, { type: 'video/mp4' });
}
