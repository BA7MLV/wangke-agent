import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { SectionCard } from '../../ui';
import { cloudRequest } from '../../cloud/state';

interface Counts {
  requests: number; cacheMeasuredRequests: number; cacheWriteMeasuredRequests: number; cacheReadTokens: number;
  cacheWriteTokens: number; cacheMeasuredInputTokens: number; cacheHitRate: number | null;
}
interface Report {
  total: Counts;
  byModel: Array<Counts & { provider: string; model: string }>;
}

export default function PromptCacheUsage({ serverManaged }: { serverManaged: boolean }) {
  const { t, i18n } = useTranslation('settings');
  const [report, setReport] = useState<Report>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const reload = async () => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setLoading(true); setFailed(false);
    try {
      let result: Report;
      if (serverManaged) result = await cloudRequest<Report>('/model-usage?days=1', { signal: request.signal });
      else {
        const { readModelUsageReport } = await import('../../store/modelUsage');
        const local = await readModelUsageReport();
        const counts = (value: typeof local.total): Counts => ({ requests: value.requests, cacheMeasuredRequests: value.cacheMeasuredRequests,
          cacheWriteMeasuredRequests: value.cacheWriteMeasuredRequests,
          cacheReadTokens: value.cacheRead, cacheWriteTokens: value.cacheWrite, cacheMeasuredInputTokens: value.cacheInput, cacheHitRate: value.cacheHitRate });
        result = { ...local, total: counts(local.total), byModel: local.byModel.map(group => ({ ...counts(group), provider: group.providerId, model: group.model })) };
      }
      if (!request.signal.aborted) setReport(result);
    } catch { if (!request.signal.aborted) setFailed(true); }
    finally { if (!request.signal.aborted) setLoading(false); }
  };
  const rate = (value: number | null) => value == null ? t('cacheUsage.unknown') : new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 1 }).format(value);
  return <SectionCard title={t('cacheUsage.title')} testId="prompt-cache-usage" actions={
    <Button size="sm" variant="secondary" isPending={loading} onPress={() => void reload()}>{t('cacheUsage.refresh')}</Button>
  }>
    <p className="text-xs text-muted">{t('cacheUsage.description')}</p>
    {failed ? <p role="alert" className="mt-2 text-sm text-danger">{t('cacheUsage.error')}</p> : null}
    {report ? <div className="mt-3 grid gap-3">
      <p className="text-sm tabular-nums" data-testid="prompt-cache-total">{t('cacheUsage.summary', { rate: rate(report.total.cacheHitRate), measured: report.total.cacheMeasuredRequests, requests: report.total.requests })}</p>
      {report.byModel.map(group => <div key={JSON.stringify([group.provider, group.model])} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 break-all">{group.provider} / {group.model}</span>
        <span className="text-muted tabular-nums">{t('cacheUsage.detail', { rate: rate(group.cacheHitRate), read: group.cacheMeasuredRequests > 0 ? group.cacheReadTokens.toLocaleString(i18n.language) : t('cacheUsage.unknown'), write: group.cacheWriteMeasuredRequests > 0 ? group.cacheWriteTokens.toLocaleString(i18n.language) : t('cacheUsage.unknown'), measured: group.cacheMeasuredRequests, requests: group.requests })}</span>
      </div>)}
      <a className="w-fit text-xs text-accent underline" href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(report, null, 2))}`} download="prompt-cache-baseline.json">{t('cacheUsage.export')}</a>
    </div> : null}
  </SectionCard>;
}
