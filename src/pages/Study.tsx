import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Banner, PageShell, SectionCard, useMduiEvent } from '../ui';
import { useAppNav } from '../components/appNav';
import { loadStudyDays, useStudyTime } from '../store/studyTime';
import { useSettings } from '../store/settings';
import {
  buildHeatmap,
  computeStats,
  dateKey,
  formatDayLabel,
  formatStudyDuration,
  heatLevel,
  HEAT_LEGEND,
  mergeSeconds,
  relativeDayLabel,
  shiftDays,
  toSecondsMap,
  type HeatCell,
  type StudyDay,
} from '../utils/studyLog';
import '../study.css';

/** 时间跨度档位：列数 = 周数（最后一列是本周） */
const RANGES = [
  { key: '3m', label: '近 3 个月', weeks: 14 },
  { key: '6m', label: '近半年', weeks: 27 },
  { key: '1y', label: '近一年', weeks: 53 },
] as const;

type RangeKey = (typeof RANGES)[number]['key'];

/** 星期标签只标周一 / 周三 / 周五（与 GitHub 一致：7 行全标会挤成一团） */
const WEEKDAY_LABELS = ['', '一', '', '三', '', '五', ''];

export default function Study() {
  const nav = useAppNav('study');
  const [days, setDays] = useState<StudyDay[]>([]);
  const [range, setRange] = useState<RangeKey>('1y');
  const [today, setToday] = useState(() => dateKey(Date.now()));
  const [tip, setTip] = useState<{ cell: HeatCell; x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pending = useStudyTime((s) => s.pending);
  const flushCount = useStudyTime((s) => s.flushCount);
  const counting = useStudyTime((s) => s.counting);
  const enabled = useSettings((s) => s.studyTrackingEnabled);
  const idleMinutes = useSettings((s) => s.studyIdleMinutes);

  const reload = useCallback(async () => {
    setDays(await loadStudyDays());
  }, []);

  // 落库后重读（flushCount 每次落库 +1；未落库的部分由 pending 叠加上去）
  useEffect(() => {
    void reload();
  }, [reload, flushCount]);

  // 跨零点时「今天」要跟着换：不换的话热力图的最后一列与「今日」会停在昨天。
  // 计时中 pending 每 15 秒推一次、天然会重渲染；空闲时没有推送，所以这里自己挂个分钟级心跳。
  useEffect(() => {
    const t = window.setInterval(() => setToday(dateKey(Date.now())), 60_000);
    return () => window.clearInterval(t);
  }, []);

  /** 库里的记录 + 内存里未落库的部分（这样「今日」是活的，而不是滞后一分钟） */
  const live = useMemo(() => {
    const map = toSecondsMap(days);
    mergeSeconds(
      map,
      Object.entries(pending).map(([date, seconds]) => ({ date, seconds })),
    );
    return map;
  }, [days, pending]);

  const stats = useMemo(
    () => computeStats([...live].map(([date, seconds]) => ({ date, seconds })), today),
    [live, today],
  );

  const weeks = RANGES.find((r) => r.key === range)?.weeks ?? 53;
  const heatmap = useMemo(
    () => buildHeatmap({ today, weeks, seconds: live }),
    [today, weeks, live],
  );

  /**
   * 默认停在最右（本周）：窄屏上首屏就该看见最近这几天，而不是半年前。
   *
   * ⚠️ 依赖只能是 `range`，**不能带 heatmap / live** —— 那两样每 15 秒（心跳）就换一次身份，
   * 会让「用户手动滚到左边看几个月前的数据」被定时弹回最右。
   */
  const scrolledRange = useRef<RangeKey | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrolledRange.current === range) return;
    scrolledRange.current = range;
    el.scrollLeft = el.scrollWidth;
  }, [range]);

  const rangeRef = useMduiEvent('mdui-segmented-button-group', 'change', (_e, el) =>
    setRange(el.value as RangeKey),
  );

  /**
   * 悬浮 / 点击某一格 → 提示条。
   *
   * 用容器上的事件委托而不是给 371 个格子各挂一个处理器：格子的数量随档位变，
   * 每次切换都要重建几百个闭包，没必要。坐标按「格子相对滚动容器」算，
   * 提示条作为滚动容器的绝对定位子元素，横向滚动时会跟着走。
   */
  const showTip = (target: EventTarget | null) => {
    const cellEl = (target as HTMLElement | null)?.closest?.('[data-date]') as HTMLElement | null;
    const wrap = scrollRef.current;
    if (!cellEl || !wrap) return;
    const date = cellEl.dataset.date ?? '';
    if (!date || cellEl.dataset.future === '1') return;
    const cellRect = cellEl.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const center = cellRect.left - wrapRect.left + wrap.scrollLeft + cellRect.width / 2;
    setTip({
      cell: {
        date,
        seconds: Number(cellEl.dataset.seconds ?? 0),
        level: Number(cellEl.dataset.level ?? 0) as HeatCell['level'],
        future: false,
      },
      x: Math.min(Math.max(center, 72), Math.max(72, wrap.scrollWidth - 72)),
      y: cellRect.top - wrapRect.top + wrap.scrollTop - 6,
    });
  };

  const tiles: { label: string; value: string; sub: ReactNode; testId: string }[] = [
    {
      label: '累计学习',
      value: formatStudyDuration(stats.totalSeconds),
      // 日均是全期口径，所以跟着「累计」走，不跟「近 7 天」走。
      // 拆成两个 span：窄屏放不下时在分隔符处断成两行，而不是把「1 小时 05 分」从中间掰开
      // （之前 390px 下会折出末尾孤零零一个「分」字）。
      sub: (
        <span className="study-tile__pair">
          <span>活跃 {stats.activeDays} 天</span>
          <span aria-hidden className="study-tile__pair-sep">
            ·
          </span>
          <span>日均 {formatStudyDuration(stats.averageSeconds)}</span>
        </span>
      ),
      testId: 'tile-total',
    },
    {
      label: '今日',
      value: formatStudyDuration(stats.todaySeconds),
      sub: enabled ? (
        <span className="study-live">
          {counting && <span className="study-live__dot" aria-hidden />}
          {counting ? '记录中' : '未在计时'}
        </span>
      ) : (
        '记录已关闭'
      ),
      testId: 'tile-today',
    },
    {
      label: '近 7 天',
      value: formatStudyDuration(stats.weekSeconds),
      // 分母必须是窗口内的活跃天数；写全期 averageSeconds 会与标题口径错位
      sub: `活跃 ${stats.weekActiveDays} 天`,
      testId: 'tile-week',
    },
    {
      label: '连续天数',
      value: `${stats.currentStreak} 天`,
      sub: `最长 ${stats.longestStreak} 天`,
      testId: 'tile-streak',
    },
  ];

  return (
    <PageShell
      title="学习"
      wide
      rootClassName="page-study"
      rail={nav.rail}
      bottomNav={nav.bottom}
    >
      <div className="study-stats" data-testid="study-stats">
        {tiles.map((t) => (
          <div className="study-tile" key={t.testId} data-testid={t.testId}>
            <div className="study-tile__label">{t.label}</div>
            <div className="study-tile__value">{t.value}</div>
            <div className="study-tile__sub">{t.sub}</div>
          </div>
        ))}
      </div>

      {stats.totalSeconds === 0 && (
        <Banner
          variant="info"
          testId="study-empty-hint"
          icon={<mdui-sym-calendar-month />}
          title="还没有学习记录"
          description="打开课程或阅读材料就会自动开始计时（页面在前台、且没长时间离开时才算）。看完一门课回来，这里会长出你的一整年。"
        />
      )}

      <SectionCard
        title="学习热力图"
        testId="card-heatmap"
        subtitle={`每格一天，颜色越深学得越久；只统计「页面在前台且没离开」的时间${
          stats.best ? `。单日最高：${formatStudyDuration(stats.best.seconds)}（${formatDayLabel(stats.best.date)}）` : ''
        }`}
        actions={
          <mdui-segmented-button-group
            ref={rangeRef}
            data-testid="study-range"
            selects="single"
            value={range}
          >
            {RANGES.map((r) => (
              <mdui-segmented-button key={r.key} value={r.key} data-testid={`study-range-${r.key}`}>
                {r.label}
              </mdui-segmented-button>
            ))}
          </mdui-segmented-button-group>
        }
      >
        <div
          className="heat-scroll"
          ref={scrollRef}
          data-testid="heat-scroll"
          onMouseOver={(e) => showTip(e.target)}
          onMouseLeave={() => setTip(null)}
          onClick={(e) => showTip(e.target)}
        >
          <div className="heat-inner">
            <div className="heat-months">
              {heatmap.months.map((m) => (
                <span
                  key={`${m.index}-${m.label}`}
                  className="heat-month"
                  style={{ left: `calc(${m.index} * var(--heat-pitch))` }}
                >
                  {m.label}
                </span>
              ))}
            </div>
            <div className="heat-body">
              <div className="heat-weekdays" aria-hidden>
                {WEEKDAY_LABELS.map((w, i) => (
                  <span key={i}>{w}</span>
                ))}
              </div>
              <div className="heat-cells" data-testid="heat-cells">
                {heatmap.weeks.map((col, ci) => (
                  <div className="heat-col" key={ci}>
                    {col.map((cell) => (
                      <div
                        key={cell.date}
                        className={
                          cell.future
                            ? 'heat-cell heat-cell--future'
                            : cell.date === today
                              ? 'heat-cell heat-cell--today'
                              : 'heat-cell'
                        }
                        data-level={cell.level}
                        data-date={cell.date}
                        data-seconds={cell.seconds}
                        data-future={cell.future ? '1' : '0'}
                        data-testid="heat-cell"
                        role="img"
                        aria-label={`${cell.date} ${cell.seconds > 0 ? formatStudyDuration(cell.seconds) : '无记录'}`}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
          {tip && (
            <div className="heat-tip" data-testid="heat-tip" style={{ left: tip.x, top: tip.y }}>
              <strong>{formatStudyDuration(tip.cell.seconds)}</strong>
              <span>
                {relativeDayLabel(tip.cell.date, today)} · {tip.cell.date}
              </span>
            </div>
          )}
        </div>

        <div className="heat-legend" data-testid="heat-legend">
          <span className="text-secondary">少</span>
          {HEAT_LEGEND.map((l) => (
            <span
              key={l.level}
              className="heat-cell heat-cell--legend"
              data-level={l.level}
              title={l.label}
              aria-label={l.label}
            />
          ))}
          <span className="text-secondary">多</span>
          <span className="heat-legend__text text-secondary">
            {HEAT_LEGEND.slice(1)
              .map((l) => l.label)
              .join(' / ')}
          </span>
        </div>

        <div className="text-secondary heat-note">
          只在本机记录：页面切到后台、锁屏或超过 {idleMinutes} 分钟没有操作时不计时；
          正在播放视频时不判空闲（看课本来就不需要一直操作）。想改判定时长或清空记录，见
          「设置 → 学习时长」。
        </div>
      </SectionCard>

      <SectionCard title="最近 30 天" testId="card-recent" subtitle="按天倒序，方便核对热力图上的颜色">
        <div className="study-recent" data-testid="study-recent">
          {recentRows(live, today).map((r) => (
            <div className="study-recent__row" key={r.date} data-testid="study-recent-row">
              {/* 明细列窄，用不带年份的短标签；完整日期挂 title，鼠标停一下就能看全 */}
              <span className="study-recent__date" title={formatDayLabel(r.date)}>
                {relativeDayLabel(r.date, today)}
              </span>
              <span className="study-recent__bar">
                <span
                  className="study-recent__fill"
                  data-level={r.level}
                  style={{ width: `${r.percent}%` }}
                />
              </span>
              <span className="study-recent__value">
                {r.seconds > 0 ? formatStudyDuration(r.seconds) : '—'}
              </span>
            </div>
          ))}
        </div>
      </SectionCard>
    </PageShell>
  );
}

/** 最近 30 天（含今日）的倒序明细；条形长度按这 30 天里的最大值归一，颜色仍用热力档位 */
function recentRows(
  live: Map<string, number>,
  today: string,
): { date: string; seconds: number; level: number; percent: number }[] {
  const out: { date: string; seconds: number; level: number; percent: number }[] = [];
  for (let i = 0; i < 30; i++) {
    const date = shiftDays(today, -i);
    const seconds = live.get(date) ?? 0;
    out.push({ date, seconds, level: heatLevel(seconds), percent: 0 });
  }
  const max = Math.max(...out.map((r) => r.seconds), 1);
  for (const r of out) r.percent = r.seconds > 0 ? Math.max(4, (r.seconds / max) * 100) : 0;
  return out;
}
