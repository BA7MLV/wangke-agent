import { useCallback, useEffect, useState } from 'react';
import { SectionCard } from '../ui';
import { getStorageStats, type StorageStats } from '../store/storageStats';
import { formatSize } from '../utils/format';

/** 设置页「存储占用」卡片：浏览器配额总览 + 应用内分类明细 */
export default function StorageCard() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await getStorageStats());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const percent = stats && stats.quota > 0 ? Math.min(100, (stats.usage / stats.quota) * 100) : 0;

  return (
    <SectionCard
      title="存储占用"
      testId="card-storage"
      actions={
        <mdui-button
          variant="tonal"
          loading={loading}
          data-testid="storage-refresh"
          onClick={() => void reload()}
        >
          <mdui-sym-refresh slot="icon" />
          刷新
        </mdui-button>
      }
    >
      {stats && (
        <>
          <mdui-linear-progress
            value={percent}
            max={100}
            data-testid="storage-progress"
          />
          <div className="storage-progress-text">
            {stats.quota > 0
              ? `已用 ${formatSize(stats.usage)} / 配额 ${formatSize(stats.quota)}`
              : `已用 ${formatSize(stats.usage)}`}
          </div>
          <div style={{ margin: '4px 0 12px' }}>
            {stats.persisted ? (
              <mdui-chip variant="assist" data-testid="storage-persist-tag">
                已持久化，系统不会自动清理
              </mdui-chip>
            ) : (
              <mdui-chip
                variant="assist"
                data-testid="storage-persist-tag"
                title="未持久化，系统空间紧张时可能清理数据"
                style={{ color: 'rgb(var(--mdui-color-error))' }}
              >
                未持久化，系统空间紧张时可能清理数据
              </mdui-chip>
            )}
          </div>
          {/* ⚠️ 分类名走的是 list-item 的**默认插槽**。
              mdui 官方 JSX 注释写「也可以通过 slot="headline" 设置」，但实现里没有这个命名插槽
              （renderInner 只有 description / end-icon 两个命名插槽，headline 只是 <slot> 的 part 名）——
              写 slot="headline" 的内容会被静默丢弃、整列不渲染（实测踩到，已在 e2e 里加了回归断言）。 */}
          <mdui-list>
            {stats.categories.map((c) => (
              <mdui-list-item key={c.label} data-testid="storage-row">
                <span>{c.label}</span>
                <span slot="description">
                  {stats.usage > 0 ? `${((c.bytes / stats.usage) * 100).toFixed(0)}%` : ''}
                </span>
                <span slot="end-icon">{formatSize(c.bytes)}</span>
              </mdui-list-item>
            ))}
          </mdui-list>
          <div className="text-secondary" data-testid="storage-note" style={{ fontSize: 12 }}>
            视频文件存于浏览器 OPFS，字幕/讲义等存于 IndexedDB，仅保存在本机；清除站点数据会全部丢失。
          </div>
        </>
      )}
    </SectionCard>
  );
}
