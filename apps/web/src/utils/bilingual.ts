/**
 * 双语字幕合成（纯函数）：主语言在上、对照语言在下。
 *
 * 两路字幕的时间轴不一定对齐（B 站的自动翻译通常与原文 1:1，UP 上传的 CC 未必），
 * 所以按「时间区间重叠」配对：一条主 cue 可以配到 0 条或多条对照 cue，
 * 配不到就只显示主语言（不丢内容，也不硬塞错位的翻译）。
 */

import type { Cue } from './vtt';

/** 双语 cue 的行分隔符（VTT 与面板展示都按它拆行） */
export const BILINGUAL_SEP = '\n';

/**
 * 把对照字幕并进主字幕。两路都要求按 start 升序（B 站字幕与展示层产物本身就是）。
 */
export function mergeBilingual(primary: Cue[], compare: Cue[]): Cue[] {
  if (compare.length === 0) return primary;
  const out: Cue[] = [];
  let j = 0; // 对照轨游标：两路都升序，全局只前进不回退
  for (const p of primary) {
    while (j < compare.length && compare[j].end <= p.start) j++;
    const texts: string[] = [];
    for (let k = j; k < compare.length && compare[k].start < p.end; k++) {
      const t = compare[k].text.trim();
      if (t) texts.push(t);
    }
    out.push(texts.length > 0 ? { ...p, text: `${p.text}${BILINGUAL_SEP}${texts.join(' ')}` } : p);
  }
  return out;
}

/** 拆双语行（面板里的 CueRow 用 <br/> 渲染，播放器侧由 media-captions 自己按 \n 分行） */
export function splitCueLines(text: string): string[] {
  return text
    .split(BILINGUAL_SEP)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
