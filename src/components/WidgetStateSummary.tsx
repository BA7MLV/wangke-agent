import type { WidgetJson } from '../harness/widgetState';

/** Plain text/semantic lists, never HTML from generated state. Exact data remains inspectable. */
export default function WidgetStateSummary({ value }: { value: WidgetJson }) {
  if (value === null) return <span className="text-muted">未设置</span>;
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>;
  if (typeof value === 'number') return <span className="tabular-nums">{value}</span>;
  if (typeof value === 'string') return <span className="whitespace-pre-wrap break-words">{value}</span>;
  if (Array.isArray(value)) return <ol className="m-0 list-inside list-decimal space-y-1 pl-0">
    {value.map((item, index) => <li key={index}><WidgetStateSummary value={item} /></li>)}
  </ol>;
  return <dl className="m-0 space-y-2">
    {Object.entries(value).map(([key, item]) => <div key={key} className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
      <dt className="text-muted">{key}</dt>
      <dd className="m-0 min-w-0 flex-1 basis-24"><WidgetStateSummary value={item} /></dd>
    </div>)}
  </dl>;
}
