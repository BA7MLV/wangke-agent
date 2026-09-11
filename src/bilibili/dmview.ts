// B 站「自带字幕」接口：App 的 gRPC DmView。
//
// 为什么不用网页接口：`x/player/v2` 与 `x/web-interface/view` 匿名时
// `need_login_subtitle: true` / `is_lock: true`，subtitle_url 直接被抠成空串（实测），
// 必须登录 SESSDATA；而 App 的 DmView **未登录就能拿到带签名的字幕直链**（实测）。
//
// 协议（实测）：
//   POST https://app.biliapi.net/bilibili.community.service.dm.v1.DM/DmView
//   Content-Type: application/grpc
//   body = [1 字节压缩标记=0][4 字节大端长度][DmViewReq]
//   DmViewReq = { 1: pid(aid), 2: oid(cid), 3: type=1, 4: spmid }
//   响应 = 同款帧（标记可能为 1=gzip）
//   DmViewReply.3(subtitle) → .3(subtitles)[] = {
//     1: id, 2: id_str, 3: lan, 4: lan_doc, 5: subtitle_url, 6: author, 7/9/10: AI 标记, 8: 简化语言名 }
//
// 字幕直链形如 http://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/xxx.json?auth_key=...
// 该 auth_key 有效期很短（实测 70s 仍可下），所以拿到就立刻拉，不要缓存 URL。

import { biliRequest } from './transport';
import type { BiliApiOptions } from './api';
import type { Cue } from '../utils/vtt';
import { decodeFields, encodeMessage, fieldBytes, fieldVarint, getBytes, getBytesFirst, getNumber, getString, utf8 } from './wire';

const DM_VIEW_URL = 'https://app.biliapi.net/bilibili.community.service.dm.v1.DM/DmView';
const SPMID = 'main.ugc-video-detail.0.0';

/** 一路可选字幕 */
export interface BiliSubtitleItem {
  /** id_str（id 是 64 位，超过 2^53 会失真，以字符串为准） */
  id: string;
  /** 语言 key，如 ai-zh / ai-en / zh-Hans / en-US */
  lan: string;
  /** 展示名，如「中文（自动生成）」「英语（自动翻译）」 */
  lanDoc: string;
  /** 简化语言名，如「中文」「英语」；偶发缺失 */
  langSimple: string;
  /** 带 auth_key 的字幕 JSON 直链，需尽快下载 */
  url: string;
  /** AI 相关标记（7 = AI 生成/翻译，10 = 类型），非 AI 字幕可能没有 */
  aiMark: number | null;
  /** AI 翻译的来源语言标记（9），非翻译字幕没有 */
  aiFrom: number | null;
}

/** 组装 DmViewRequest（含 gRPC 帧头） */
export function buildDmViewRequest(aid: number, cid: number): Uint8Array {
  const message = encodeMessage([
    fieldVarint(1, aid),
    fieldVarint(2, cid),
    fieldVarint(3, 1),
    fieldBytes(4, utf8(SPMID)),
  ]);
  const framed = new Uint8Array(5 + message.byteLength);
  framed[0] = 0; // 0 = 不压缩；B 站两种都能收
  new DataView(framed.buffer).setUint32(1, message.byteLength, false);
  framed.set(message, 5);
  return framed;
}

/** 拆 gRPC 帧，返回压缩标记与消息体 */
export function unframeGrpc(data: Uint8Array): { compressed: boolean; message: Uint8Array } {
  if (data.byteLength < 5) throw new Error('gRPC 响应过短');
  const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, false);
  const end = 5 + size <= data.byteLength ? 5 + size : data.byteLength;
  return { compressed: data[0] === 1, message: data.subarray(5, end) };
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持 gzip 解压，无法解析字幕接口响应');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 解析 DmViewReply，取出字幕语言列表（保持接口返回顺序） */
export function parseSubtitleList(message: Uint8Array): BiliSubtitleItem[] {
  const out: BiliSubtitleItem[] = [];
  for (const wrapper of getBytes(decodeFields(message), 3)) {
    for (const raw of getBytes(decodeFields(wrapper), 3)) {
      const item = decodeFields(raw);
      const url = getString(item, 5);
      const lan = getString(item, 3);
      if (!url || !lan) continue;
      out.push({
        id: getString(item, 2) ?? String(getNumber(item, 1) ?? ''),
        lan,
        lanDoc: getString(item, 4) ?? lan,
        langSimple: getString(item, 8) ?? '',
        url: url.startsWith('//') ? `https:${url}` : url,
        aiMark: getNumber(item, 7) ?? null,
        aiFrom: getNumber(item, 9) ?? null,
      });
    }
  }
  return out;
}

/**
 * 拉取某分 P 的字幕语言列表。走与播放流同一条出口（油猴桥优先，代理回退）。
 * 注意：番剧/课程（ep / cheese）不能只靠 aid+cid，调用方自行处理。
 */
export async function fetchBiliSubtitleList(
  opts: BiliApiOptions,
  aid: number,
  cid: number,
): Promise<BiliSubtitleItem[]> {
  const resp = await biliRequest(opts, DM_VIEW_URL, {
    method: 'POST',
    body: buildDmViewRequest(aid, cid),
    headers: { 'Content-Type': 'application/grpc', 'grpc-accept-encoding': 'identity,gzip' },
  });
  if (!resp.ok) throw new Error(`字幕列表接口失败 HTTP ${resp.status}`);
  const { compressed, message } = unframeGrpc(new Uint8Array(await resp.arrayBuffer()));
  return parseSubtitleList(compressed ? await gunzip(message) : message);
}

/** B 站字幕 JSON 的一行 */
interface SubtitleBodyLine {
  from?: number;
  to?: number;
  content?: string;
}

/**
 * 字幕 JSON → 时间轴 cue。
 * 直链本身不需要 Referer/Cookie，但走桥/代理可以避开 CORS，故沿用同一出口。
 */
export function cuesFromSubtitleJson(json: unknown): Cue[] {
  const body = (json as { body?: SubtitleBodyLine[] } | null)?.body;
  if (!Array.isArray(body)) return [];
  const cues: Cue[] = [];
  for (const line of body) {
    const text = (line?.content ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = typeof line.from === 'number' && Number.isFinite(line.from) ? Math.max(0, line.from) : 0;
    const rawEnd = typeof line.to === 'number' && Number.isFinite(line.to) ? line.to : 0;
    const end = rawEnd > start ? rawEnd : start + 1;
    cues.push({ start: round3(start), end: round3(end), text });
  }
  // B 站字幕 JSON 本身按时间序，这里再排一次是为了让「对照语言」的两路归并配对
  // （mergeBilingual 要求输入升序）在接口偶发乱序时仍然正确。
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/** 下载并解析一路字幕 */
export async function fetchSubtitleCues(opts: BiliApiOptions, url: string): Promise<Cue[]> {
  const resp = await biliRequest(opts, url);
  if (!resp.ok) throw new Error(`字幕文件下载失败 HTTP ${resp.status}（链接可能已过期）`);
  return cuesFromSubtitleJson(await resp.json());
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
