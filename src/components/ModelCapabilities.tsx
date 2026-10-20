import { getModelMeta, catalogMetaUpdatedAt, hasModelOverrides, type ModelOverrides } from '../api/modelMeta';
import { capabilityLabel, formatModelTokens, MODEL_KIND_LABEL, modelKind, modalityLabel } from '../api/modelPresentation';
import { useModelMetaRevision } from '../utils/useModelMeta';

type ModelMetadataProps = { catalogId: string; model: string; overrides?: ModelOverrides };

export function ModelCapabilities({ catalogId, model, overrides, compact = false }: ModelMetadataProps & { compact?: boolean }) {
  useModelMetaRevision();
  const meta = getModelMeta(catalogId, model, overrides);
  const source = hasModelOverrides(overrides) ? '用户配置优先，未配置字段跟随 models.dev' : 'models.dev';
  const kind = modelKind(meta);
  return <span className="inline-flex flex-wrap items-center gap-1 text-xs" title={meta ? `${source} · 输入：${modalityLabel(meta.inputModalities)} · 输出：${modalityLabel(meta.outputModalities)}` : 'models.dev 未匹配此供应商与模型；可手动配置能力，不按名称猜测'}>
    <span className="rounded-md bg-default px-2 py-0.5 text-foreground">{kind === 'unknown' && meta?.vision ? '支持图片输入' : MODEL_KIND_LABEL[kind]}</span>
    {!compact && meta?.declaredReasoning === true && <span className="rounded-md bg-default px-2 py-0.5 text-muted">推理</span>}
    {!compact && meta?.declaredToolCall === true && <span className="rounded-md bg-default px-2 py-0.5 text-muted">工具调用</span>}
    {!compact && meta?.declaredContext != null && <span className="px-1 text-muted tabular-nums">{formatModelTokens(meta.declaredContext)} 上下文</span>}
  </span>;
}

export function ModelMetadataDetails({ catalogId, model, overrides }: ModelMetadataProps) {
  useModelMetaRevision();
  const meta = getModelMeta(catalogId, model, overrides);
  const updatedAt = catalogMetaUpdatedAt(catalogId);
  const price = (n?: number) => n == null ? '未提供' : `$${n.toLocaleString('en', { maximumFractionDigits: 6 })}`;
  const rows = [
    ['输入模态', modalityLabel(meta?.inputModalities)], ['输出模态', modalityLabel(meta?.outputModalities)],
    ['上下文窗口', formatModelTokens(meta?.declaredContext)], ['最大输出', formatModelTokens(meta?.declaredOutput)],
    ['推理', capabilityLabel(meta?.declaredReasoning)], ['工具调用', capabilityLabel(meta?.declaredToolCall)],
    ['结构化输出', capabilityLabel(meta?.structuredOutput)],
    ['输入 / 输出价格', `${price(meta?.cost?.input)} / ${price(meta?.cost?.output)}`],
  ];
  return <div className="flex flex-col gap-3 rounded-lg bg-background-secondary p-3" data-testid="model-metadata-details">
    <div className="flex flex-wrap items-center justify-between gap-2"><ModelCapabilities catalogId={catalogId} model={model} overrides={overrides} compact /><a href="https://models.dev" target="_blank" rel="noreferrer" className="text-xs text-accent underline">默认来源 models.dev</a></div>
    {meta ? <>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">{rows.map(([label, value]) => <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 text-sm tabular-nums">{value}</dd></div>)}</dl>
      <p className="text-xs text-muted">窗口单位为 tokens；价格为 USD / 百万 tokens，仅供参考，以供应商实际账单为准。{updatedAt ? ` 同步于 ${new Date(updatedAt).toLocaleString()}。` : ''}{meta.lastUpdated ? ` 条目更新：${meta.lastUpdated}。` : ''}</p>
    </> : <p className="text-xs text-muted">{catalogId ? '该供应商目录尚未匹配此模型。可刷新能力数据；未收录的模型仍可手动添加。' : '请在供应商设置中填写 models.dev 供应商 key，再刷新能力数据。'}</p>}
    <p className="text-xs text-muted">用户配置优先，未配置字段跟随 models.dev；刷新目录不会覆盖用户配置。分类由输入/输出模态推导。音频能力不代表兼容语音转写接口；用途由你确认。</p>
  </div>;
}
