import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SectionCard, Field, confirmDialog, toast, useMduiEvent } from '../ui';
import { useSettings } from '../store/settings';
import { clearStudyDays, loadStudyDays, useStudyTime } from '../store/studyTime';
import { computeStats, dateKey, formatStudyDuration } from '../utils/studyLog';

/** 空闲判定的候选档位（分钟）：播放视频时不做空闲判定，所以这几档只影响「没在播放」的时候 */
const IDLE_OPTIONS = [2, 5, 10, 15];

/** 设置页「学习时长」卡片：开关 / 空闲判定 / 清空记录 + 一眼看得到的总账 */
export default function StudyTimeCard() {
  const navigate = useNavigate();
  const settings = useSettings();
  const flushCount = useStudyTime((s) => s.flushCount);
  const [summary, setSummary] = useState<{ days: number; total: number } | null>(null);

  const reload = useCallback(async () => {
    const days = await loadStudyDays();
    const stats = computeStats(days, dateKey(Date.now()));
    setSummary({ days: stats.activeDays, total: stats.totalSeconds });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, flushCount]);

  const enabledRef = useMduiEvent('mdui-switch', 'change', (_e, el) =>
    settings.update({ studyTrackingEnabled: el.checked }),
  );
  const idleRef = useMduiEvent('mdui-segmented-button-group', 'change', (_e, el) =>
    settings.update({ studyIdleMinutes: Number(el.value) || 5 }),
  );

  const askClear = () => {
    void confirmDialog({
      headline: '清空学习时长记录？',
      description: '每日热力图数据会全部删除，不可恢复（课程、字幕、讲义等其它数据不受影响）',
      confirmText: '清空',
      danger: true,
    }).then(async (ok) => {
      if (!ok) return;
      await clearStudyDays();
      await reload();
      toast.success('学习时长记录已清空');
    });
  };

  return (
    <SectionCard
      title="学习时长"
      testId="card-study-time"
      subtitle="打开应用就会自动计时：只算「页面在前台」且「没长时间离开」的时间；正在播放视频时不判空闲"
      actions={
        <mdui-button variant="tonal" data-testid="study-open-page" onClick={() => navigate('/study')}>
          <mdui-sym-calendar-month slot="icon" />
          查看热力图
        </mdui-button>
      }
    >
      <Field
        label="自动记录"
        hint="关掉后不再累计新时长，已有记录保留"
        testId="field-study-tracking"
      >
        <mdui-switch
          ref={enabledRef}
          data-testid="study-tracking"
          checked={settings.studyTrackingEnabled}
        />
      </Field>

      <Field
        label="多久没操作算离开"
        hint="播放视频时这条不生效（看课本来就不需要一直操作）"
        testId="field-study-idle"
      >
        <mdui-segmented-button-group
          ref={idleRef}
          data-testid="study-idle"
          selects="single"
          value={String(settings.studyIdleMinutes)}
        >
          {IDLE_OPTIONS.map((m) => (
            <mdui-segmented-button key={m} value={String(m)}>
              {m} 分钟
            </mdui-segmented-button>
          ))}
        </mdui-segmented-button-group>
      </Field>

      <Field label="已有记录" testId="field-study-summary">
        <div className="row row--between" style={{ width: '100%' }}>
          <span className="text-secondary" data-testid="study-summary">
            {summary
              ? `活跃 ${summary.days} 天 · 累计 ${formatStudyDuration(summary.total)}`
              : '读取中…'}
          </span>
          <mdui-button
            variant="text"
            data-testid="study-clear"
            disabled={!summary || summary.days === 0}
            onClick={askClear}
          >
            清空记录
          </mdui-button>
        </div>
      </Field>
    </SectionCard>
  );
}
