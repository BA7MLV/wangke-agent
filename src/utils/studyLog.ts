/**
 * 学习时长的**纯逻辑**（不碰 DB、不碰 DOM，Node 里可直接跑，见 scripts/test-study-log.mjs）。
 *
 * 为什么单独拆出来：这一段最容易出错的地方全在「日期」上 ——
 * 跨零点的那次心跳该记到哪一天、时区怎么算、热力图的格子怎么排。
 * 这些都能用纯函数表达清楚并单测，而计时器/落库那部分（store/studyTime.ts）只负责
 * 「什么时候调这些函数」，两层互不污染。
 */

/** 一天的秒数（热力图与统计里当常量用；跨天切分本身按本地零点算，不依赖它） */
export const DAY_SECONDS = 86400;

export interface StudyDay {
  /** 本地日期 `YYYY-MM-DD` */
  date: string;
  /** 当日累计秒数 */
  seconds: number;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 时间戳 → 本地日期键 `YYYY-MM-DD`。
 *
 * ⚠️ **不能用 `toISOString().slice(0, 10)`**：那是 UTC 日期，东八区在本地 00:00~08:00
 * 之间会把记录算到**前一天**（凌晨学习的人会看到「今天没记上、昨天莫名多了一截」）。
 * 这里全程走 `Date` 的本地 getter，跨时区/夏令时都由运行时处理。
 */
export function dateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 日期键 → 当天**本地零点**的时间戳（`new Date('2026-09-18')` 会被当成 UTC，不能用） */
export function dateKeyToTs(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
}

/** 日期键加减天数（走本地零点，跨月/跨年/夏令时都不会漂） */
export function shiftDays(key: string, delta: number): string {
  const d = new Date(dateKeyToTs(key));
  d.setDate(d.getDate() + delta);
  return dateKey(d.getTime());
}

/** 该日期所在周的周日（GitHub 的日历是周日打头的 7 行） */
export function weekStart(key: string): string {
  const d = new Date(dateKeyToTs(key));
  d.setDate(d.getDate() - d.getDay()); // getDay()：0=周日
  return dateKey(d.getTime());
}

/**
 * 把 `[fromMs, toMs)` 这段时长按**本地零点**切成若干天。
 *
 * 存在的唯一理由就是跨零点的那一次心跳：23:59:50 → 00:00:05 的 15 秒，
 * 12 秒该记在今天、3 秒该记在明天。整段按结束时刻的日期记账看着更省事，
 * 但那会让「熬夜学习」把凌晨的时间全部塞进前一天（或反之），
 * 而热力图是按天看的，这种错账一眼就能看出来。
 */
export function splitByDay(fromMs: number, toMs: number): StudyDay[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const out: StudyDay[] = [];
  let cursor = fromMs;
  let guard = 0;
  // guard 只是防御：正常输入最多跨 1 天（心跳 15s），真有异常也不会死循环
  while (cursor < toMs && guard++ < 8) {
    const dayEnd = new Date(cursor);
    dayEnd.setHours(24, 0, 0, 0); // 本地次日零点
    const stop = Math.min(toMs, dayEnd.getTime());
    const seconds = (stop - cursor) / 1000;
    if (seconds > 0) out.push({ date: dateKey(cursor), seconds: round1(seconds) });
    cursor = stop;
  }
  return out;
}

/** 秒数保留 1 位小数：心跳是 15s 的整数倍，小数只来自跨天切分与限流后的补记 */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 把若干段「某天 N 秒」合并成一张日期 → 秒数的表（同一天累加） */
export function mergeSeconds(into: Map<string, number>, add: StudyDay[]): void {
  for (const d of add) into.set(d.date, round1((into.get(d.date) ?? 0) + d.seconds));
}

/** 行数组 → 日期 → 秒数的表（列表页/统计页的公共入口） */
export function toSecondsMap(rows: StudyDay[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.date, (map.get(r.date) ?? 0) + r.seconds);
  return map;
}

// ─────────────────────────── 热力档位 ───────────────────────────

/**
 * 档位阈值（**分钟**，升序）：>0 → 1 档，≥15 分 → 2 档，≥45 分 → 3 档，≥90 分 → 4 档。
 *
 * 为什么用固定阈值、而不是 GitHub 那种「按本人历史取四分位」：四分位会把**任何**数据
 * 染成满格 —— 一个每天学 5 分钟的人，5 分钟那天也是最深的一档，看着像天天学满 8 小时。
 * 这里的图是给自己看进度的，绝对刻度（15 分 / 45 分 / 90 分）比相对刻度诚实。
 * 图例里会把这三档写出来，不让颜色变成猜谜。
 */
export const HEAT_STEPS_MINUTES = [15, 45, 90] as const;

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/** 秒数 → 0~4 档（0 = 没有记录） */
export function heatLevel(seconds: number): HeatLevel {
  if (!(seconds > 0)) return 0;
  const minutes = seconds / 60;
  if (minutes >= HEAT_STEPS_MINUTES[2]) return 4;
  if (minutes >= HEAT_STEPS_MINUTES[1]) return 3;
  if (minutes >= HEAT_STEPS_MINUTES[0]) return 2;
  return 1;
}

/** 档位 → 图例文案（与 HEAT_STEPS_MINUTES 同源，改阈值时图例自动跟上） */
export const HEAT_LEGEND: { level: HeatLevel; label: string }[] = [
  { level: 0, label: '无记录' },
  { level: 1, label: `不到 ${HEAT_STEPS_MINUTES[0]} 分` },
  { level: 2, label: `${HEAT_STEPS_MINUTES[0]}–${HEAT_STEPS_MINUTES[1]} 分` },
  { level: 3, label: `${HEAT_STEPS_MINUTES[1]}–${HEAT_STEPS_MINUTES[2]} 分` },
  { level: 4, label: `${HEAT_STEPS_MINUTES[2]} 分以上` },
];

// ─────────────────────────── 热力图网格 ───────────────────────────

export interface HeatCell {
  /** 本地日期键 */
  date: string;
  seconds: number;
  level: HeatLevel;
  /** 晚于今天：只是为了让网格成矩形，画成空白、也不响应悬浮 */
  future: boolean;
}

export interface HeatmapMonth {
  /** 落在第几列（0 起） */
  index: number;
  /** 如「9月」 */
  label: string;
}

export interface Heatmap {
  /** 列 = 周（周日打头），行 = 周日…周六 */
  weeks: HeatCell[][];
  /** 列顶部的月份标签 */
  months: HeatmapMonth[];
}

/**
 * 生成 GitHub 提交图那样的网格。
 *
 * 几何规则（与 GitHub 一致，这样用户不用重新学怎么读）：
 *   - 最后一列是**本周**（可能只画到今天就断了，后面的格子是 future）；
 *   - 每列 7 行，第 0 行是周日；
 *   - 第一列是「今天所在周往前推 weeks-1 周」的那个周日，所以总列数恒为 weeks。
 *
 * 月份标签的落点：**哪一列里出现了「1 号」就把那个月标在那列上**（GitHub 就是这么标的）。
 * 首列若离第一个标签太远（前 3 列内没有 1 号），补一个首列所属月份的标签，
 * 否则图的最左边会出现一大段没有月份可参照的空白。
 */
export function buildHeatmap(opts: { today: string; weeks: number; seconds: Map<string, number> }): Heatmap {
  const { today, weeks, seconds } = opts;
  const lastColStart = weekStart(today);
  const firstColStart = shiftDays(lastColStart, -(Math.max(1, weeks) - 1) * 7);

  const cols: HeatCell[][] = [];
  const months: HeatmapMonth[] = [];
  for (let c = 0; c < weeks; c++) {
    const colStart = shiftDays(firstColStart, c * 7);
    const cells: HeatCell[] = [];
    for (let r = 0; r < 7; r++) {
      const date = shiftDays(colStart, r);
      const future = date > today; // 日期键是定长补零的，字符串比较即时间先后
      const sec = future ? 0 : (seconds.get(date) ?? 0);
      cells.push({ date, seconds: sec, level: future ? 0 : heatLevel(sec), future });
      if (!future && date.slice(-2) === '01') {
        months.push({ index: c, label: `${Number(date.slice(5, 7))}月` });
      }
    }
    cols.push(cells);
  }

  if (months.length === 0 || months[0].index > 1) {
    const firstMonth = Number(firstColStart.slice(5, 7));
    months.unshift({ index: 0, label: `${firstMonth}月` });
  }
  return { weeks: cols, months };
}

// ─────────────────────────── 统计 ───────────────────────────

export interface StudyStats {
  /** 全部历史累计秒数 */
  totalSeconds: number;
  /** 有记录的天数 */
  activeDays: number;
  /** 今日秒数（含尚未落库的部分） */
  todaySeconds: number;
  /** 近 7 天（含今日）秒数 */
  weekSeconds: number;
  /**
   * 近 7 天（含今日）内有记录的天数。
   *
   * 与 `weekSeconds` 配对使用：「近 7 天」这张卡要报日均的话，分母只能是**窗口内**
   * 的活跃天数或固定 7 天；拿全期的 `averageSeconds` 去配它会让口径与标题错位
   * （标题说 7 天，数字却是全期平均）——所以这里显式给出窗口内的分母。
   */
  weekActiveDays: number;
  /**
   * 当前连续天数。
   *
   * 定义按「还活着」算：今天有记录就从今天往回数；今天还没开始、但昨天有，
   * 就从昨天往回数（今天才刚开始学的人不该看到连续天数先归零再涨回来）。
   * 昨天也没有才算断。
   */
  currentStreak: number;
  /** 历史最长连续天数 */
  longestStreak: number;
  /** 单日最高记录 */
  best: StudyDay | null;
  /**
   * **全期**活跃日均秒数（totalSeconds / activeDays）。
   *
   * ⚠️ 只属于「累计学习」这张卡。它跟 `weekSeconds` 不是一套口径，
   * 放到「近 7 天」卡下面会变成「标题说 7 天、数字是全期」的错位文案。
   */
  averageSeconds: number;
}

/** 统计全部历史（含今天）。传入的应是**已合并未落库部分**的完整数据。 */
export function computeStats(rows: StudyDay[], today: string): StudyStats {
  const map = toSecondsMap(rows);
  const dates = [...map.keys()].filter((d) => (map.get(d) ?? 0) > 0).sort();

  let totalSeconds = 0;
  let best: StudyDay | null = null;
  for (const d of dates) {
    const sec = map.get(d) ?? 0;
    totalSeconds += sec;
    if (!best || sec > best.seconds) best = { date: d, seconds: sec };
  }

  // 连续天数：日期键有序，逐日 +1 判断即可
  let longestStreak = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of dates) {
    run = prev && shiftDays(prev, 1) === d ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = d;
  }

  let currentStreak = 0;
  const hasToday = (map.get(today) ?? 0) > 0;
  let cursor = hasToday ? today : shiftDays(today, -1);
  while ((map.get(cursor) ?? 0) > 0) {
    currentStreak++;
    cursor = shiftDays(cursor, -1);
  }

  let weekSeconds = 0;
  let weekActiveDays = 0;
  for (let i = 0; i < 7; i++) {
    const sec = map.get(shiftDays(today, -i)) ?? 0;
    weekSeconds += sec;
    if (sec > 0) weekActiveDays++;
  }

  return {
    totalSeconds,
    activeDays: dates.length,
    todaySeconds: map.get(today) ?? 0,
    weekSeconds,
    weekActiveDays,
    currentStreak,
    longestStreak,
    best,
    // 全期口径：累计秒数 ÷ 全期活跃天数。只配「累计学习」那张卡，别配「近 7 天」。
    averageSeconds: dates.length > 0 ? totalSeconds / dates.length : 0,
  };
}

// ─────────────────────────── 格式化 ───────────────────────────

/**
 * 时长文案：`2 小时 05 分` / `38 分` / `不到 1 分钟`。
 *
 * 与库页那个 `formatDuration`（`1:23:45` 的播放器计时）刻意分开：那个是时间轴，
 * 这个是「学了多久」，后者按小时/分说人话更好读。
 */
export function formatStudyDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return '0 分';
  if (s < 60) return '不到 1 分钟';
  const totalMinutes = Math.floor(s / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} 分`;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${pad2(m)} 分`;
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 日期键 → `2026年9月18日 周五` */
export function formatDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const wd = new Date(dateKeyToTs(key)).getDay();
  return `${y}年${m}月${d}日 ${WEEKDAY_LABELS[wd]}`;
}

/** 日期键 → `9月18日 周五`（去掉年份：明细列表的日期列放不下「2026年」） */
export function shortDayLabel(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  const wd = new Date(dateKeyToTs(key)).getDay();
  return `${m}月${d}日 ${WEEKDAY_LABELS[wd]}`;
}

/** 相对今天的说法（热力图提示条与明细列表里用：今天 / 昨天 / `9月18日 周五`） */
export function relativeDayLabel(key: string, today: string): string {
  if (key === today) return '今天';
  if (key === shiftDays(today, -1)) return '昨天';
  if (key === shiftDays(today, 1)) return '明天';
  return shortDayLabel(key);
}
