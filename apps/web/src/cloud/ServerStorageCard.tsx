import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ProgressBar, Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { ServerStorageStats } from '@wangke/contracts';
import { SectionCard, Sym } from '../ui';
import { SettingRow } from '../components/settings/controls';
import { formatSize } from '../utils/format';
import { cloudRequest } from './state';

export default function ServerStorageCard() {
  const { t, i18n } = useTranslation('settings');
  const [stats, setStats] = useState<ServerStorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setFailed(false);
    try {
      const result = await cloudRequest<ServerStorageStats>('/storage', { signal: controller.signal });
      if (!controller.signal.aborted) setStats(result);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => { void reload(); return () => request.current?.abort(); }, [reload]);

  return (
    <SectionCard title={t('serverStorage.title')} testId="cloud-storage-card" actions={
      <Button size="sm" variant="secondary" isPending={loading} onPress={() => void reload()} data-testid="cloud-storage-refresh">
        {({ isPending }) => <>{isPending ? <Spinner size="sm" color="current" /> : <Sym name="refresh" />}{t('serverStorage.refresh')}</>}
      </Button>
    }>
      {loading && !stats ? <p className="py-3 text-sm text-muted" role="status">{t('serverStorage.loading')}</p> : null}
      {failed ? <p className="py-2 text-sm text-danger" role="alert">{t(stats ? 'serverStorage.refreshError' : 'serverStorage.error')}</p> : null}
      {stats ? <>
        <SettingRow label={t(stats.partial ? 'serverStorage.partialTotal' : 'serverStorage.total')} testId="cloud-storage-total">
          <span className="text-lg font-semibold tabular-nums">{formatSize(stats.totalBytes)}</span>
        </SettingRow>
        {stats.categories.map(category => (
          <SettingRow key={category.id} label={t(`serverStorage.categories.${category.id}`)} testId={`cloud-storage-${category.id}`}>
            <span className="text-sm text-muted tabular-nums">{formatSize(category.bytes)}</span>
          </SettingRow>
        ))}
        {stats.partial ? <p className="mt-2 text-sm text-warning" role="status">{t('serverStorage.partial')}</p> : null}
        <p className="mt-2 text-xs text-muted">{t('serverStorage.sizeNote')}</p>
        <div className="mt-5 grid gap-4" data-testid="cloud-storage-volumes">
          {stats.volumes.map((volume, index) => {
            const title = t(stats.volumes.length === 1 ? 'serverStorage.disk' : 'serverStorage.diskNumber', { index: index + 1 });
            const capacity = volume.capacity;
            return <div key={volume.id} className="grid gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
                <span className="font-medium">{title}</span>
                <span className="text-muted tabular-nums">{capacity ? t('serverStorage.available', { size: formatSize(capacity.availableBytes) }) : t('serverStorage.unavailable')}</span>
              </div>
              {capacity ? <>
                <ProgressBar aria-label={title} value={Math.min(100, capacity.usedBytes / capacity.totalBytes * 100)}>
                  <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
                </ProgressBar>
                <p className="text-xs text-muted tabular-nums">{t('serverStorage.diskUsage', { used: formatSize(capacity.usedBytes), total: formatSize(capacity.totalBytes) })}</p>
              </> : null}
              {stats.volumes.length > 1 ? <p className="text-xs text-muted">{volume.categories.map(id => t(`serverStorage.categories.${id}`)).join(' · ')}</p> : null}
            </div>;
          })}
          {stats.volumes.length === 0 ? <p className="text-sm text-muted">{t('serverStorage.unavailable')}</p> : null}
        </div>
        <p className="mt-2 text-xs text-muted">{t('serverStorage.diskNote')}</p>
        <p className="mt-2 text-xs text-muted" data-testid="cloud-storage-time">{t('serverStorage.updated', { time: new Date(stats.measuredAt).toLocaleString(i18n.language) })}</p>
      </> : null}
    </SectionCard>
  );
}
