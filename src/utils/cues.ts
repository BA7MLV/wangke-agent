import type { Cue } from './vtt';

/** 单条字幕上限：中文一行约 20 字（网课字幕阅读习惯） */
export const MAX_CUE_CHARS = 20;
/** 单条字幕最长停留 6s（行业标准 1~7s） */
export const MAX_CUE_DURATION = 6;
/** 短于此值视为「一闪而过」，尝试并入相邻条 */
const MIN_CUE_DURATION = 0.8;

/** 句读边界：中文/英文句末与分句标点（顿号、逗号不断词组，故不含、） */
const UNIT_RE = /[^，。！？；：,.!?;:\n]+[，。！？；：,.!?;:]*/g;

/** 超长句硬切：均匀分成 n 段（避免前满后残的孤儿尾巴），优先在空格（英文词界）断 */
function hardSplit(s: string): string[] {
  if (s.length <= MAX_CUE_CHARS) return [s];
  const size = Math.ceil(s.length / Math.ceil(s.length / MAX_CUE_CHARS));
  const out: string[] = [];
  let rest = s;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(' ', size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** 组内拼接：两侧都是 ASCII 字母/数字时补回硬切丢掉的空格（英文词间），中文/标点直连 */
function joinUnits(units: string[]): string {
  let out = units[0] ?? '';
  for (let i = 1; i < units.length; i++) {
    const needSpace = /[a-zA-Z0-9]$/.test(out) && /^[a-zA-Z0-9]/.test(units[i]);
    out += (needSpace ? ' ' : '') + units[i];
  }
  return out;
}

const charsOf = (units: string[]) => units.reduce((n, u) => n + u.length, 0);
const round3 = (t: number) => Math.round(t * 1000) / 1000;

/**
 * 由内容算出的稳定 cue 标识（FNV-1a 32 位）。
 * 播放器字幕轨按 id 幂等灌 cue：内容没变 → id 相同 → 重复灌入是空操作；重新转写后内容变了 →
 * id 变了 → 会作为新 cue 加入，同时旧的被推离时间轴失效。这样整轨不需要重建。
 */
export function cueKey(start: number, end: number, text: string): string {
  const s = `${start}|${end}|${text}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * 把一条过长的字幕按阅读节奏切成多条 cue：
 * 按标点切成完整句子（语意不断），再按字数占比在 [start, end] 内线性分配时间。
 * 讲课语速近似均匀，估算误差通常 <1s；本身已合规的条目原样返回。
 */
export function splitIntoCues(start: number, end: number, text: string): Cue[] {
  const clean = text.trim();
  if (!clean) return [];
  const dur = end - start;
  if (clean.length <= MAX_CUE_CHARS && dur <= MAX_CUE_DURATION) return [{ start, end, text: clean }];

  const units = (clean.match(UNIT_RE) ?? [clean]).flatMap(hardSplit);
  const totalChars = charsOf(units);
  if (totalChars === 0) return [{ start, end, text: clean }];

  // 贪心打包：当前条非空且再加入会超字数/时长上限 → 另起一条
  const groups: string[][] = [];
  let cur: string[] = [];
  for (const u of units) {
    const wouldChars = charsOf(cur) + u.length;
    const wouldDur = (wouldChars / totalChars) * dur;
    if (cur.length > 0 && (wouldChars > MAX_CUE_CHARS || wouldDur > MAX_CUE_DURATION)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(u);
  }
  if (cur.length > 0) groups.push(cur);

  // 末尾太短的尾巴并回前一条（字数放宽 1.5 倍），避免一闪而过
  if (groups.length > 1) {
    const tailChars = charsOf(groups[groups.length - 1]);
    if ((tailChars / totalChars) * dur < MIN_CUE_DURATION) {
      const prev = groups[groups.length - 2];
      if (charsOf(prev) + tailChars <= MAX_CUE_CHARS * 1.5) {
        prev.push(...groups.pop()!);
      }
    }
  }

  // 按字数占比分配时间：严格单调、无缝衔接，末条终点对齐段尾
  const cues: Cue[] = [];
  let acc = 0;
  for (let i = 0; i < groups.length; i++) {
    const s = start + (acc / totalChars) * dur;
    acc += charsOf(groups[i]);
    const e = i === groups.length - 1 ? end : start + (acc / totalChars) * dur;
    cues.push({ start: round3(s), end: round3(e), text: joinUnits(groups[i]).trim() });
  }
  return cues;
}
