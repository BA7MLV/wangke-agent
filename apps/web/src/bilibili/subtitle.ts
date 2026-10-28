// B 站字幕的「选哪路当主语言 / 怎么落库」纯逻辑（不碰网络与数据库，便于 Node 单测）。

import type { BiliSubtitleItem } from './dmview';
import type { Cue } from '../utils/vtt';
import type { SegmentRow } from '../store/db';

/**
 * 语言优先级：越小越优先。
 * 简体（含 AI 自动生成）→ 其它中文 → 英文 → 其余（保持接口返回顺序，稳定排序）。
 *
 * 注意 B 站 AI 那几路的 key 是 `ai-zh` / `ai-en` / `ai-ja` / `ai-es`…（不是 `en-US`），
 * 所以先剥掉 `ai-` 前缀再按基础语言排。
 */
export function langRank(lan: string): number {
  const s = lan.toLowerCase().replace(/^ai[-_]/, '');
  if (s === 'zh' || s === 'zh-cn' || s === 'zh-hans' || s === 'yue') return 0;
  if (s.startsWith('zh') || s.startsWith('yue')) return 1;
  if (s === 'en' || s.startsWith('en-')) return 2;
  return 3;
}

/** 从已选语言里挑主语言（写进 segments 的那一路） */
export function pickPrimary(items: BiliSubtitleItem[]): BiliSubtitleItem | null {
  let best: BiliSubtitleItem | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const rank = langRank(item.lan);
    if (rank < bestRank) {
      best = item;
      bestRank = rank;
    }
  }
  return best;
}

/** 默认勾选：简体中文 + 英文（有就勾），对不上就退回第一路 */
export function defaultSelectedLangs(items: BiliSubtitleItem[]): string[] {
  const zh = items.find((i) => langRank(i.lan) <= 1);
  const en = items.find((i) => langRank(i.lan) === 2);
  const picked = [zh, en].filter((x): x is BiliSubtitleItem => !!x);
  return picked.length > 0 ? picked.map((i) => i.lan) : items.slice(0, 1).map((i) => i.lan);
}

/**
 * 一路字幕 → segments 行。
 * 一条 B 站 cue 落一行（与 ASR 的 VAD 段同构），显示层再按标点/字数细分成 cue 展示。
 */
export function cuesToSegments(cues: Cue[]): Omit<SegmentRow, 'id' | 'videoId'>[] {
  return cues.map((c, i) => ({
    idx: i,
    start: c.start,
    end: c.end,
    text: c.text,
    status: 1 as const,
  }));
}

/** 导入时携带的字幕负载（主语言 + 全部已选语言） */
export interface SubtitleBundle {
  /** 主语言（写进 segments）；没勾任何语言时为 null */
  primary: { lang: string; lanDoc: string; cues: Cue[] } | null;
  /** 全部已选语言（含主语言），只喂显示层对照 */
  tracks: { lang: string; lanDoc: string; primary: 1 | 0; cues: Cue[] }[];
}

/**
 * 把「已选语言 + 各自 cue」组装成落库负载：先按优先级挑主语言，其余按原顺序保留。
 */
export function buildBundle(
  fetched: { item: BiliSubtitleItem; cues: Cue[] }[],
  primary: BiliSubtitleItem | null,
): SubtitleBundle {
  const withCues = fetched.filter((f) => f.cues.length > 0);
  const hit = primary ? withCues.find((f) => f.item.lan === primary.lan) : undefined;
  return {
    primary: hit ? { lang: hit.item.lan, lanDoc: hit.item.lanDoc, cues: hit.cues } : null,
    tracks: withCues.map((f) => ({
      lang: f.item.lan,
      lanDoc: f.item.lanDoc,
      primary: f.item.lan === hit?.item.lan ? 1 : 0,
      cues: f.cues,
    })),
  };
}
