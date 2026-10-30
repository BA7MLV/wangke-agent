import { getModelMeta, catalogMetaUpdatedAt, hasModelOverrides, matchModelMeta, type ModelOverrides } from '../api/modelMeta';
import { capabilityLabel, formatModelTokens, MODEL_KIND_LABEL, modelKind, modalityLabel, type ModelKind } from '../api/modelPresentation';
import { useModelMetaRevision } from '../utils/useModelMeta';
import { Sym, type SymbolName } from '../ui/icons';

const MODEL_KIND_ICON: Record<ModelKind, SymbolName> = {
  llm: 'chat_bubble', vlm: 'visibility', audio: 'graphic_eq', image: 'image',
  video: 'play_circle', multimodal: 'extension', decision: 'account_tree', unknown: 'help',
};

type ModelMetadataProps = { catalogId: string; model: string; overrides?: ModelOverrides };

export function ModelCapabilities({ catalogId, model, overrides, compact = false }: ModelMetadataProps & { compact?: boolean }) {
  useModelMetaRevision();
  const meta = getModelMeta(catalogId, model, overrides);
  const match = matchModelMeta(overrides?.metadataCatalogId ?? catalogId, model);
  const source = hasModelOverrides(overrides) ? '已保存配置优先，目录只补全缺失能力' : match.status === 'exact' ? 'models.dev' : '默认能力（非接口验证）';
  const kind = modelKind(meta);
  const visionFallback = kind === 'unknown' && meta?.vision;
  const kindLabel = visionFallback ? '支持图片输入' : MODEL_KIND_LABEL[kind];
  return <span className="inline-flex flex-wrap items-center gap-1 text-xs" title={meta ? `${source} · 输入：${modalityLabel(meta.inputModalities)} · 输出：${modalityLabel(meta.outputModalities)}` : 'models.dev 未匹配此供应商与模型；可手动配置能力，不按名称猜测'}>
    <span className="inline-flex size-6 shrink-0 items-center justify-center text-foreground" role="img" aria-label={kindLabel} title={kindLabel}>
      <Sym name={visionFallback ? 'visibility' : MODEL_KIND_ICON[kind]} className="size-3.5" />
    </span>
    {!compact && meta?.declaredReasoning === true && <span className="rounded-md bg-default px-2 py-1 text-muted">推理</span>}
    {!compact && meta?.toolCall === true && <span className="rounded-md bg-default px-2 py-1 text-muted">{meta.declaredToolCall === undefined ? '工具调用（默认）' : '工具调用'}</span>}
    {!compact && meta?.declaredContext != null && <span className="px-1 text-muted tabular-nums">{formatModelTokens(meta.declaredContext)} 上下文</span>}
  </span>;
}

export function ModelMetadataDetails({ catalogId, model, overrides }: ModelMetadataProps) {
  useModelMetaRevision();
  const meta = getModelMeta(catalogId, model, overrides);
  const match = matchModelMeta(overrides?.metadataCatalogId ?? catalogId, model);
  const updatedAt = match.status === 'exact' ? catalogMetaUpdatedAt(match.candidates[0].catalogId) : null;
  const rows = [
    ['输入模态', modalityLabel(meta?.inputModalities)], ['输出模态', modalityLabel(meta?.outputModalities)],
    ['上下文窗口', formatModelTokens(meta?.declaredContext)], ['最大输出', formatModelTokens(meta?.declaredOutput)],
    ['推理', capabilityLabel(meta?.declaredReasoning)], ['工具调用', meta?.declaredToolCall === undefined ? '默认开启（未验证）' : capabilityLabel(meta.declaredToolCall)],
    ['结构化输出', capabilityLabel(meta?.structuredOutput)],
  ];
  return <div className="flex flex-col gap-3 rounded-lg bg-background-secondary p-3" data-testid="model-metadata-details">
    <div className="flex flex-wrap items-center justify-between gap-2"><ModelCapabilities catalogId={catalogId} model={model} overrides={overrides} compact /><a href="https://models.dev" target="_blank" rel="noreferrer" className="text-xs text-accent underline">{match.status === 'exact' ? `能力来源 ${match.candidates[0].catalogId} · models.dev` : '默认来源 models.dev'}</a></div>
    {meta ? <>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">{rows.map(([label, value]) => <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 text-sm tabular-nums">{value}</dd></div>)}</dl>
      <p className="text-xs text-muted">窗口单位为 tokens。{updatedAt ? ` 同步于 ${new Date(updatedAt).toLocaleString()}。` : ''}{meta.lastUpdated ? ` 条目更新：${meta.lastUpdated}。` : ''}</p>
    </> : null}
    {match.status !== 'exact' && <p className="text-xs text-muted">{match.status === 'ambiguous' ? '目录有多个同名模型，且未找到可匹配的官方条目，暂用默认能力，可按实际接口自定义。' : '目录未匹配此模型，仍可直接接入。'} 未声明的输入/输出默认文本，工具调用默认开启；默认值不代表接口验证通过。</p>}
    <p className="text-xs text-muted">手动配置优先，接口声明其次，models.dev 只补全能力。刷新目录不会覆盖已保存配置。音频能力不代表兼容语音转写接口；用途由你确认。</p>
  </div>;
}
