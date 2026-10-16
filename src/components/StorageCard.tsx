import { useCallback, useEffect, useState } from 'react';
import { Button, Chip, ProgressBar, Spinner } from '@heroui/react';
import { SectionCard, Sym } from '../ui';
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
        <Button
          variant="secondary"
          isPending={loading}
          data-testid="storage-refresh"
          onPress={() => void reload()}
        >
          {({ isPending }) => (
            <>
              {isPending ? <Spinner size="sm" color="current" /> : <Sym name="refresh" />}
              刷新
            </>
          )}
        </Button>
      }
    >
      {stats && (
        <>
          <ProgressBar
            value={percent}
            maxValue={100}
            aria-label="存储占用比例"
            data-testid="storage-progress"
          />
          <div className="mt-1 text-xs text-muted" data-testid="storage-quota">
            {stats.quota > 0
              ? `已用 ${formatSize(stats.usage)} / 配额 ${formatSize(stats.quota)}`
              : `已用 ${formatSize(stats.usage)}`}
          </div>
          <div className="mt-1 mb-3">
            {stats.persisted ? (
              <Chip variant="soft" data-testid="storage-persist-tag">
                已持久化，系统不会自动清理
              </Chip>
            ) : (
              <Chip
                variant="soft"
                color="danger"
                data-testid="storage-persist-tag"
                title="未持久化，系统空间紧张时可能清理数据"
              >
                未持久化，系统空间紧张时可能清理数据
              </Chip>
            )}
          </div>
          {/* 分类明细用普通行列表：这里只是「名称 + 占比 + 大小」的静态展示，
              用 ListBox 反而要处理选中语义，div + flex 足够。 */}
          <div className="flex flex-col gap-1">
            {stats.categories.map((c) => (
              <div
                key={c.label}
                className="flex flex-nowrap items-start justify-between gap-3"
                data-testid="storage-row"
              >
                <span>{c.label}</span>
                <span className="text-xs text-muted">
                  {stats.usage > 0 ? `${((c.bytes / stats.usage) * 100).toFixed(0)}% · ` : ''}
                  {formatSize(c.bytes)}
                </span>
              </div>
            ))}
          </div>
          <div className="text-xs text-muted" data-testid="storage-note">
            视频文件存于浏览器 OPFS，字幕/讲义等存于 IndexedDB，仅保存在本机；清除站点数据会全部丢失。
          </div>
        </>
      )}
    </SectionCard>
  );
}
