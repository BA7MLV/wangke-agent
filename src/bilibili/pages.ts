// 多分 P（合集 / 系列课）的纯逻辑：默认勾选策略、命名、时长合计。不碰网络，便于 Node 单测。
//
// 背景：一门课常有几十个分 P（实测 BV1h7pteyEww《线性代数》94 P / 57.9 小时），
// 而每个分 P 是**独立的 cid**，播放流与字幕都各拉各的，「全下」显然不行。

import type { BiliPageInfo } from './api';

/** 默认勾选策略：URL 显式带 p= → 只勾它；分 P 少（≤3）→ 全勾；否则只勾第一 P */
export function defaultPagesFor(pages: BiliPageInfo[], explicitPage: number | null): number[] {
  if (pages.length === 0) return [];
  if (explicitPage != null && pages.some((p) => p.page === explicitPage)) return [explicitPage];
  if (pages.length <= 3) return pages.map((p) => p.page);
  return [pages[0].page];
}

/**
 * 视频名：多分 P 时带「P{n} 分P名」，避免同一个合集导出的多个文件互相覆盖。
 * 单 P 视频原样返回（与改造前的行为一致）。
 */
export function pageVideoTitle(baseTitle: string, pages: BiliPageInfo[], page: number): string {
  if (pages.length <= 1) return baseTitle;
  const part = pages.find((p) => p.page === page)?.part?.trim();
  return part ? `${baseTitle} P${page} ${part}` : `${baseTitle} P${page}`;
}

/** 分 P 条目标签：`P2 1.1 二三阶行列式` */
export function pageLabel(page: BiliPageInfo): string {
  return page.part?.trim() ? `P${page.page} ${page.part.trim()}` : `P${page.page}`;
}

/** 已选分 P 的时长合计（秒） */
export function selectedDuration(pages: BiliPageInfo[], selected: number[]): number {
  const set = new Set(selected);
  return pages.reduce((sum, p) => sum + (set.has(p.page) ? p.duration : 0), 0);
}

/** 已选分 P，按序号升序（拿不到的都丢掉） */
export function resolveSelectedPages(pages: BiliPageInfo[], selected: number[]): BiliPageInfo[] {
  const set = new Set(selected);
  return pages.filter((p) => set.has(p.page));
}

/** 人类可读的时长合计：`3 分 21 秒` / `1.5 小时` */
export function formatTotalDuration(seconds: number): string {
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
  }
  return `${(seconds / 3600).toFixed(1)} 小时`;
}
