import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { ModelUsageCounts, ModelUsageReport, ModelUsageSource } from '@wangke/contracts/cloud';
import { SectionCard } from '../../ui';
import { cloudRequest } from '../../cloud/state';

const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const control = 'min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground';
const compactNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, useGrouping: false });
const tokenAmount = (value: number) => {
  if (value < 1000) return String(value);
  // Promote before rounding would render 1000K or 1000M.
  if (value >= 999950000) return `${compactNumber.format(value / 1000000000)}B`;
  const millions = value >= 999950;
  return `${compactNumber.format(value / (millions ? 1000000 : 1000))}${millions ? 'M' : 'K'}`;
};

/** Server ledger only: browser chat history is not another bill to add to it. */
export default function UsageModule() {
  const { t, i18n } = useTranslation('settings');
  const [start, setStart] = useState(() => day(Date.now() - 6 * 86400000));
  const [end, setEnd] = useState(() => day(Date.now()));
  const [source, setSource] = useState<ModelUsageSource | 'all'>('all');
  const [groupBy, setGroupBy] = useState<'model' | 'day'>('model');
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ query: string; report: ModelUsageReport }>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const span = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  const valid = Boolean(start && end && span >= 1 && span <= 90);
  const query = new URLSearchParams({ start, end, source }).toString();
  const report = valid && result?.query === query ? result.report : undefined;

  useEffect(() => {
    if (!valid) { setLoading(false); setFailed(false); return; }
    const controller = new AbortController();
    setLoading(true); setFailed(false);
    void cloudRequest<ModelUsageReport>(`/model-usage?${query}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setResult({ query, report: value }); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, valid, refresh]);

  const number = (value: number) => value.toLocaleString(i18n.language);
  const amount = (value: number, measured: number, requests: number) => measured > 0 || requests === 0 ? tokenAmount(value) : t('usage.unknown');
  const rate = (value: number | null) => value === null ? t('usage.unknown') : new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 1 }).format(value);
  const total = (counts: ModelUsageCounts) => amount(counts.totalTokens, counts.inputMeasuredRequests + counts.outputMeasuredRequests, counts.requests);
  const coverage = (counts: ModelUsageCounts) => t('usage.coverage', { measured: number(counts.measuredRequests), requests: number(counts.requests), inflight: number(counts.inflightRequests) });
  const rows = report ? groupBy === 'day' ? report.byDayModel : report.bySourceModel : [];

  return <>
    <SectionCard title={t('modules.usage')} testId="usage-controls" actions={
      <Button size="sm" variant="secondary" isDisabled={!valid} isPending={loading} data-testid="usage-refresh" onPress={() => setRefresh(value => value + 1)}>{t('usage.refresh')}</Button>
    }>
      <p className="text-sm text-muted">{t('usage.description')}</p>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="grid min-w-0 gap-1 text-sm">{t('usage.start')}<input className={`${control} w-full`} type="date" value={start} max={end} onChange={event => setStart(event.target.value)} /></label>
        <label className="grid min-w-0 gap-1 text-sm">{t('usage.end')}<input className={`${control} w-full`} type="date" value={end} min={start} onChange={event => setEnd(event.target.value)} /></label>
        <label className="grid min-w-0 gap-1 text-sm">{t('usage.source')}<select aria-label={t('usage.source')} className={control} value={source} onChange={event => setSource(event.target.value as typeof source)}>
          <option value="all">{t('usage.sources.all')}</option><option value="chat">{t('usage.sources.chat')}</option><option value="bot">{t('usage.sources.bot')}</option>
        </select></label>
        <label className="grid min-w-0 gap-1 text-sm">{t('usage.groupBy')}<select aria-label={t('usage.groupBy')} className={control} value={groupBy} onChange={event => setGroupBy(event.target.value as typeof groupBy)}>
          <option value="model">{t('usage.byModel')}</option><option value="day">{t('usage.byDay')}</option>
        </select></label>
      </div>
      {!valid ? <p role="alert" className="mt-3 text-sm text-danger">{t('usage.invalidWindow')}</p> : null}
      {loading ? <p role="status" className="mt-3 text-sm text-muted">{t('usage.loading')}</p> : null}
      {failed ? <p role="alert" className="mt-3 text-sm text-danger">{t(report ? 'usage.refreshError' : 'usage.error')}</p> : null}
    </SectionCard>
    {report ? <div data-testid="usage-report" aria-busy={loading}>
      <SectionCard title={t(`usage.sources.${source}`)} testId="usage-total">
        <p className="text-2xl font-semibold tabular-nums">{total(report.total)} <span className="text-sm font-normal text-muted">{t('usage.tokens')}</span></p>
        <p className="mt-1 text-xs text-muted">{coverage(report.total)}</p>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          {([
            ['input', amount(report.total.inputTokens, report.total.inputMeasuredRequests, report.total.requests), report.total.inputMeasuredRequests],
            ['output', amount(report.total.outputTokens, report.total.outputMeasuredRequests, report.total.requests), report.total.outputMeasuredRequests],
            ['cacheRead', amount(report.total.cacheReadTokens, report.total.cacheMeasuredRequests, report.total.requests), report.total.cacheMeasuredRequests],
            ['cacheWrite', amount(report.total.cacheWriteTokens, report.total.cacheWriteMeasuredRequests, report.total.requests), report.total.cacheWriteMeasuredRequests],
            ['reasoning', amount(report.total.reasoningTokens, report.total.reasoningMeasuredRequests, report.total.requests), report.total.reasoningMeasuredRequests],
          ] as const).map(([key, value, measured]) => <div key={key}><dt className="text-xs text-muted">{t(`usage.${key}`)}</dt><dd className="mt-1 tabular-nums">{value}<span className="mt-1 block text-xs text-muted">{t('usage.fieldCoverage', { measured: number(measured), requests: number(report.total.requests) })}</span></dd></div>)}
          <div><dt className="text-xs text-muted">{t('usage.hitRate')}</dt><dd className="mt-1 tabular-nums">{rate(report.total.cacheHitRate)}</dd></div>
        </dl>
        <p className="mt-4 text-xs text-muted">{t('usage.accountingNote')}</p>
      </SectionCard>
      <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
        {(['chat', 'bot'] as const).filter(value => source === 'all' || source === value).map(value => {
          const counts = report.bySource.find(group => group.source === value);
          return <SectionCard key={value} title={t(`usage.sources.${value}`)} testId={`usage-source-${value}`}>
            <p className="text-xl font-semibold tabular-nums">{counts ? total(counts) : number(0)} <span className="text-sm font-normal text-muted">{t('usage.tokens')}</span></p>
            <p className="mt-1 text-xs text-muted">{counts ? coverage(counts) : t('usage.empty')}</p>
          </SectionCard>;
        })}
      </div>
      <SectionCard title={t(groupBy === 'day' ? 'usage.byDay' : 'usage.byModel')} testId="usage-breakdown">
        {report.total.requests === 0 ? <p className="text-sm text-muted">{t('usage.empty')}</p> : <div className="max-w-full overflow-x-auto" tabIndex={0} role="region" aria-label={t('usage.breakdown')}>
          <table className="w-full min-w-[64rem] text-left text-xs tabular-nums">
            <thead><tr className="border-b border-border">
              {(groupBy === 'day' ? ['date', 'source', 'providerModel', 'requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'hitRate', 'measured'] as const
                : ['source', 'providerModel', 'requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'hitRate', 'measured'] as const)
                .map(key => <th key={key} scope="col" className="px-2 py-2 font-medium text-muted">{t(`usage.${key}`)}</th>)}
            </tr></thead>
            <tbody>{rows.map(row => <tr key={JSON.stringify(['date' in row ? row.date : '', row.source, row.provider, row.model])} className="border-b border-border last:border-0">
              {groupBy === 'day' ? <td className="whitespace-nowrap px-2 py-3">{'date' in row ? String(row.date) : ''}</td> : null}
              <td className="px-2 py-3">{t(`usage.sources.${row.source}`)}</td>
              <th scope="row" className="max-w-56 break-all px-2 py-3 font-normal">{row.provider} / {row.model}</th>
              <td className="px-2 py-3">{number(row.requests)}</td>
              <td className="px-2 py-3">{amount(row.inputTokens, row.inputMeasuredRequests, row.requests)}</td>
              <td className="px-2 py-3">{amount(row.outputTokens, row.outputMeasuredRequests, row.requests)}</td>
              <td className="px-2 py-3">{amount(row.cacheReadTokens, row.cacheMeasuredRequests, row.requests)}</td>
              <td className="px-2 py-3">{amount(row.cacheWriteTokens, row.cacheWriteMeasuredRequests, row.requests)}</td>
              <td className="px-2 py-3">{amount(row.reasoningTokens, row.reasoningMeasuredRequests, row.requests)}</td>
              <td className="px-2 py-3">{rate(row.cacheHitRate)}</td>
              <td className="whitespace-nowrap px-2 py-3">{number(row.measuredRequests)} / {number(row.requests)}</td>
            </tr>)}</tbody>
          </table>
        </div>}
        <p className="mt-3 text-xs text-muted">{t('usage.updated', { time: new Date(report.generatedAt).toLocaleString(i18n.language), start: report.since.slice(0, 10), end: day(Date.parse(report.until) - 1) })}</p>
      </SectionCard>
    </div> : null}
  </>;
}
