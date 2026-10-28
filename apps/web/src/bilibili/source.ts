import type { BiliPageInfo } from './api';

/** 只保存稳定标识，不保存 Cookie 或会过期的播放/字幕直链。 */
export interface BiliVideoSource {
  bvid: string;
  aid: number;
  cid: number;
  page: number;
}

export function biliVideoSource(target: { bvid: string; aid: number }, page: BiliPageInfo): BiliVideoSource {
  return {
    bvid: page.bvid ?? target.bvid,
    aid: page.aid ?? target.aid,
    cid: page.cid,
    page: page.sourcePage ?? page.page,
  };
}
