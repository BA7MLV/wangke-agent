import { useState } from 'react';
import { Button, Checkbox, Input, ListBox, SearchField, Select } from '@heroui/react';
import { catalogOf, SLOT_LABEL, useSettings, type ModelSlot, type SavedModel } from '../../store/settings';
import { editModelPatch, modelKey, savedModelsOf, suggestedModelSlots } from '../../store/modelLibrary';
import { Field, SectionCard, toast } from '../../ui';
import { getModelMeta, matchModelMeta, MODEL_OVERRIDE_FIELDS } from '../../api/modelMeta';
import type { DiscoveredModel } from '../../api/modelDiscoveryData';
import { ModelMetadataDetails } from '../ModelCapabilities';
import { useModelMetaRevision } from '../../utils/useModelMeta';

const slots: ModelSlot[] = ['chat', 'vision', 'asr', 'decision'];
const capabilities = ['text', 'image', 'audio', 'video', 'pdf'];
type Draft = SavedModel & { contextWindowText: string; maxOutputTokensText: string };

export default function ModelLibrary({ providerId, discovered = [] }: { providerId: string; discovered?: DiscoveredModel[] }) {
  const settings = useSettings();
  useModelMetaRevision();
  const catalogId = catalogOf(settings, providerId);
  const saved = savedModelsOf(settings).filter((m) => m.providerId === providerId);
  const [query, setQuery] = useState('');
  const [discoveryQuery, setDiscoveryQuery] = useState('');
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [editor, setEditor] = useState<{ original: SavedModel | null; draft: Draft; slotsEdited?: boolean } | null>(null);
  const [error, setError] = useState('');
  const filtered = saved.filter((m) => `${m.model} ${m.name}`.toLowerCase().includes(query.trim().toLowerCase()));
  const savedIds = new Set(saved.map((m) => m.model));
  const available = discovered.filter((m) => !savedIds.has(m.id));
  const discoveryNeedle = discoveryQuery.trim().toLowerCase();
  const discoveryResults = available.filter((m) => `${m.id} ${m.name ?? ''}`.toLowerCase().includes(discoveryNeedle));
  const active = (m: SavedModel) => [settings.llmModel, settings.visionModel, settings.asrModel, settings.decisionModel].some((r) => modelKey(r) === modelKey(m));

  const openEditor = (model: SavedModel | null, found?: DiscoveredModel) => {
    const { id: discoveredId, ...declared } = found ?? { id: '' };
    const base = model ? { ...model, slots: [...model.slots] } : {
      ...declared, providerId, model: discoveredId, name: found?.name ?? '', slots: [] as ModelSlot[],
    };
    setError('');
    setEditor({ original: model, draft: { ...base, contextWindowText: base.contextWindow?.toString() ?? '', maxOutputTokensText: base.maxOutputTokens?.toString() ?? '' } });
  };

  const toggle = (field: 'inputCapabilities' | 'outputCapabilities', value: string, on: boolean) => {
    if (!editor) return;
    const current = editor.draft[field] ?? [];
    setEditor({ ...editor, draft: { ...editor.draft, [field]: on ? [...new Set([...current, value])] : current.filter((x) => x !== value) } });
  };

  const catalogMeta = editor ? getModelMeta(editor.draft.metadataCatalogId ?? catalogId, editor.draft.model) : null;
  const match = editor ? matchModelMeta(catalogId, editor.draft.model) : null;
  const selectedSlots = editor && !editor.original && !editor.slotsEdited
    ? suggestedModelSlots(catalogId, editor.draft.model, editor.draft)
    : editor?.draft.slots ?? [];

  return <SectionCard title="模型" subtitle="点击“查找模型”获取接口列表，也可手动添加；接口能力优先，models.dev 只补全。" testId="card-model-library"
    actions={<Button variant="secondary" onPress={() => openEditor(null)}>新模型</Button>}>
    <div className="flex flex-col gap-4">
      {editor && <form className="flex flex-col gap-4 rounded-xl border border-border bg-background-secondary p-4" data-testid="model-editor" onSubmit={(event) => {
        event.preventDefault();
        try {
          const { contextWindowText, maxOutputTokensText, ...draft } = editor.draft;
          settings.update(editModelPatch(useSettings.getState(), editor.original, {
            ...draft,
            slots: selectedSlots,
            contextWindow: contextWindowText ? Number(contextWindowText) : undefined,
            maxOutputTokens: maxOutputTokensText ? Number(maxOutputTokensText) : undefined,
          }));
          setEditor(null); toast.success('模型已保存');
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      }}>
        <h3 className="text-base font-semibold">{editor.original ? '编辑模型' : '新模型'}</h3>
        <div className="grid grid-cols-2 gap-4 max-[640px]:grid-cols-1">
          <Field label="模型 ID"><Input aria-label="模型 ID" autoFocus placeholder="gpt-4o" value={editor.draft.model} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, model: e.target.value } })} /></Field>
          <Field label="模型名称"><Input aria-label="模型名称" placeholder="GPT-4o" value={editor.draft.name} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, name: e.target.value } })} /></Field>
          <Field label="上下文窗口" hint="单位 tokens；留空使用 models.dev 能力，填写后优先使用此配置"><Input type="number" min={1} aria-label="上下文窗口" placeholder={catalogMeta?.declaredContext?.toString() ?? '未提供'} value={editor.draft.contextWindowText} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, contextWindowText: e.target.value } })} /></Field>
          <Field label="最大输出令牌数" hint="单位 tokens；决策模型可为 0，留空跟随目录"><Input type="number" min={selectedSlots.includes('decision') ? 0 : 1} aria-label="最大输出令牌数" placeholder={catalogMeta?.declaredOutput?.toString() ?? '未提供'} value={editor.draft.maxOutputTokensText} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, maxOutputTokensText: e.target.value } })} /></Field>
        </div>
        {match?.status === 'ambiguous' && <Field label="确认能力来源" hint="同名模型可能有不同的服务能力。仅改变能力来源，不改变请求地址或模型 ID。">
          <Select aria-label="模型能力来源" placeholder="请选择目录供应商（可选）" selectedKey={editor.draft.metadataCatalogId ?? null} onSelectionChange={(key) => setEditor({ ...editor, draft: { ...editor.draft, metadataCatalogId: key ? String(key) : undefined } })}>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover><ListBox>{match.candidates.map((candidate) => <ListBox.Item key={candidate.catalogId} id={candidate.catalogId} textValue={candidate.catalogId}>{candidate.catalogId}</ListBox.Item>)}</ListBox></Select.Popover>
          </Select>
        </Field>}
        <Checkbox aria-label="自定义推理等级" isSelected={editor.draft.reasoningEffort !== undefined} onChange={(on) => setEditor({ ...editor, draft: { ...editor.draft, reasoningEffort: on ? catalogMeta?.thinking?.effort?.join(', ') ?? '' : undefined } })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>自定义推理等级</Checkbox.Content></Checkbox>
        {editor.draft.reasoningEffort !== undefined && <Field label="推理等级" hint="填写该接口接受的 reasoning_effort 档位，用英文逗号分隔；留空表示不支持推理。"><Input aria-label="推理等级" placeholder="low, medium, high" value={editor.draft.reasoningEffort} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, reasoningEffort: e.target.value } })} /></Field>}
        {(['inputCapabilities', 'outputCapabilities'] as const).map((field) => <Field key={field} label={field === 'inputCapabilities' ? '输入能力' : '输出能力'}>
          <div className="flex flex-col gap-2">
            <Checkbox aria-label={`自定义${field === 'inputCapabilities' ? '输入' : '输出'}能力`} isSelected={editor.draft[field] !== undefined} onChange={(on) => setEditor({ ...editor, draft: { ...editor.draft, [field]: on ? [...(catalogMeta?.[field === 'inputCapabilities' ? 'inputModalities' : 'outputModalities'] ?? ['text'])] : undefined } })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>自定义{field === 'inputCapabilities' ? '输入' : '输出'}能力</Checkbox.Content></Checkbox>
            <div className="flex flex-wrap gap-x-5 gap-y-2">{capabilities.map((cap) => <Checkbox key={cap} aria-label={`${field === 'inputCapabilities' ? '输入' : '输出'} ${cap}`} isDisabled={editor.draft[field] === undefined} isSelected={(editor.draft[field] ?? catalogMeta?.[field === 'inputCapabilities' ? 'inputModalities' : 'outputModalities'] ?? []).includes(cap)} onChange={(on) => toggle(field, cap, on)}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{cap}</Checkbox.Content></Checkbox>)}</div>
          </div>
        </Field>)}
        <Field label="工具调用">
          <div className="flex flex-wrap gap-4">
            <Checkbox aria-label="自定义工具调用" isSelected={editor.draft.toolCalling !== undefined} onChange={(on) => setEditor({ ...editor, draft: { ...editor.draft, toolCalling: on ? catalogMeta?.toolCall ?? true : undefined } })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>自定义工具调用</Checkbox.Content></Checkbox>
            <Checkbox aria-label="支持工具调用" isDisabled={editor.draft.toolCalling === undefined} isSelected={editor.draft.toolCalling ?? catalogMeta?.toolCall ?? true} onChange={(on) => setEditor({ ...editor, draft: { ...editor.draft, toolCalling: on } })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>支持工具调用</Checkbox.Content></Checkbox>
          </div>
        </Field>
        <ModelMetadataDetails catalogId={catalogId} model={editor.draft.model} overrides={{ ...editor.draft, contextWindow: editor.draft.contextWindowText ? Number(editor.draft.contextWindowText) : undefined, maxOutputTokens: editor.draft.maxOutputTokensText ? Number(editor.draft.maxOutputTokensText) : undefined }} />
        <Button variant="secondary" className="self-start" onPress={() => {
          const draft = { ...editor.draft, contextWindowText: '', maxOutputTokensText: '' };
          for (const field of MODEL_OVERRIDE_FIELDS) delete draft[field];
          setEditor({ ...editor, draft });
        }}>恢复 models.dev 默认能力</Button>
        <Field label="使用用途" hint="新模型按输入/输出能力预选用途，可按实际接口支持情况调整；不受供应商层限制。"><div className="flex flex-wrap gap-4">{slots.map((slot) => <Checkbox key={slot} isSelected={selectedSlots.includes(slot)} onChange={(on) => setEditor({ ...editor, slotsEdited: true, draft: { ...editor.draft, slots: on ? [...new Set([...selectedSlots, slot])] : selectedSlots.filter((s) => s !== slot) } })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{SLOT_LABEL[slot]}</Checkbox.Content></Checkbox>)}</div></Field>
        {selectedSlots.includes('decision') && <>
          <Field label="决策接口协议" hint="目录分类不代表接口兼容；请核实供应商支持此端点，不能使用普通聊天协议。">
            <Select aria-label="决策接口协议" placeholder="请选择已确认的协议" selectedKey={editor.draft.decisionProtocol ?? null} onSelectionChange={(key) => setEditor({ ...editor, draft: { ...editor.draft, decisionProtocol: key === 'typesafe-systemone' ? key : undefined } })}>
              <Select.Trigger data-testid="decision-protocol-trigger"><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover isNonModal><ListBox><ListBox.Item id="typesafe-systemone" textValue="TypeSafe System One">TypeSafe System One（/systemone）</ListBox.Item></ListBox></Select.Popover>
            </Select>
          </Field>
          <Field label="决策 API 根地址（可选）" hint="留空复用供应商地址；填写包含 /v1、不含 /systemone 的根地址。将使用该供应商的 Key，请仅填写可信地址。">
            <Input aria-label="决策 API 根地址" placeholder={settings.providers.find((p) => p.id === providerId)?.baseUrl} value={editor.draft.decisionBaseUrl ?? ''} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, decisionBaseUrl: e.target.value } })} />
          </Field>
          <p className="text-xs text-muted">仅支持返回逐问题概率的 System One 接口；其他决策协议暂不支持。保存模型不会自动开启路由或上下文压缩。</p>
        </>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex gap-2"><Button type="submit">{editor.original ? '保存修改' : '添加模型'}</Button><Button variant="ghost" onPress={() => setEditor(null)}>取消</Button></div>
      </form>}

      <SearchField aria-label="搜索已保存模型" value={query} onChange={setQuery}><SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder="搜索已保存模型" /><SearchField.ClearButton /></SearchField.Group></SearchField>
      <div className="flex flex-col divide-y divide-border" data-testid="saved-models">
        {filtered.map((m) => <div key={modelKey(m)} className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{m.name || m.model}</div><div className="truncate text-xs text-muted">{m.name && `${m.model} · `}{m.slots.map((s) => SLOT_LABEL[s]).join(' / ')}{active(m) ? ' · 使用中' : ''}</div></div>
          <Button size="sm" variant="secondary" aria-label={`编辑 ${m.name || m.model}`} onPress={() => openEditor(m)}>编辑</Button>
        </div>)}
        {!filtered.length && <p role="status" className="py-5 text-sm text-muted">{saved.length ? '没有匹配的已保存模型。' : '还没有添加模型，点击“新模型”开始。'}</p>}
      </div>
      {available.length > 0 && <details className="rounded-xl border border-border" data-testid="discovered-models" open={discoveryOpen} onToggle={(event) => {
        setDiscoveryOpen(event.currentTarget.open);
        if (!event.currentTarget.open) setDiscoveryQuery('');
      }}>
        <summary className="cursor-pointer px-3 py-3 text-sm font-medium tabular-nums focus-visible:outline-2 focus-visible:outline-focus" data-testid="discovered-model-select">接口发现的模型 · {available.length}</summary>
        {discoveryOpen && <div className="flex flex-col gap-3 border-t border-border p-3">
          <p className="text-xs text-pretty text-muted">添加时带入接口声明的能力；你可以修改。重新查找不会覆盖已保存的模型。</p>
          <SearchField aria-label="搜索接口模型" value={discoveryQuery} onChange={setDiscoveryQuery}><SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder="搜索模型名称或 ID" /><SearchField.ClearButton /></SearchField.Group></SearchField>
          <ul className="m-0 max-h-64 list-none divide-y divide-border overflow-y-auto p-0" aria-label="接口模型结果">
            {discoveryResults.map((m) => <li key={m.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1"><div className="truncate text-sm" title={m.name || m.id}>{m.name || m.id}</div>{m.name && m.name !== m.id && <div className="truncate text-xs text-muted" title={m.id}>{m.id}</div>}</div>
              <Button size="sm" variant="secondary" aria-label={`添加 ${m.id}`} onPress={() => {
                setDiscoveryOpen(false);
                openEditor(null, m);
              }}>添加</Button>
            </li>)}
            {!discoveryResults.length && <li role="status" className="py-3 text-sm text-muted">没有匹配的模型</li>}
          </ul>
        </div>}
      </details>}
    </div>
  </SectionCard>;
}
