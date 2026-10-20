import { useState } from 'react';
import { Button, Checkbox, Input, SearchField } from '@heroui/react';
import { SLOT_LABEL, useSettings, type ModelSlot, type SavedModel } from '../../store/settings';
import { editModelPatch, modelKey, savedModelsOf } from '../../store/modelLibrary';
import { Field, SectionCard, toast } from '../../ui';
import { getModelMeta, MODEL_OVERRIDE_FIELDS } from '../../api/modelMeta';
import { ModelMetadataDetails } from '../ModelCapabilities';
import { useModelMetaRevision } from '../../utils/useModelMeta';

const slots: ModelSlot[] = ['chat', 'vision', 'asr'];
const capabilities = ['text', 'image', 'audio', 'video', 'pdf'];
type Draft = SavedModel & { contextWindowText: string; maxOutputTokensText: string };

export default function ModelLibrary({ providerId }: { providerId: string }) {
  const settings = useSettings();
  useModelMetaRevision();
  const provider = settings.providers.find((p) => p.id === providerId);
  const saved = savedModelsOf(settings).filter((m) => m.providerId === providerId);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<{ original: SavedModel | null; draft: Draft } | null>(null);
  const [error, setError] = useState('');
  const filtered = saved.filter((m) => `${m.model} ${m.name}`.toLowerCase().includes(query.trim().toLowerCase()));
  const active = (m: SavedModel) => [settings.llmModel, settings.visionModel, settings.asrModel].some((r) => modelKey(r) === modelKey(m));

  const openEditor = (model: SavedModel | null) => {
    const base = model ? { ...model, slots: [...model.slots] } : {
      providerId, model: '', name: '', slots: [provider?.serves[0] ?? 'chat'] as ModelSlot[],
    };
    setError('');
    setEditor({ original: model, draft: { ...base, contextWindowText: model?.contextWindow?.toString() ?? '', maxOutputTokensText: model?.maxOutputTokens?.toString() ?? '' } });
  };

  const toggle = (field: 'inputCapabilities' | 'outputCapabilities', value: string, on: boolean) => {
    if (!editor) return;
    const current = editor.draft[field] ?? [];
    setEditor({ ...editor, draft: { ...editor.draft, [field]: on ? [...new Set([...current, value])] : current.filter((x) => x !== value) } });
  };

  const catalogMeta = editor ? getModelMeta(provider?.catalogId ?? '', editor.draft.model) : null;

  return <SectionCard title="模型" subtitle="默认使用 models.dev 能力；手动配置的字段始终优先。" testId="card-model-library"
    actions={<Button variant="secondary" onPress={() => openEditor(null)}>新模型</Button>}>
    <div className="flex flex-col gap-4">
      {editor && <form className="flex flex-col gap-4 rounded-xl border border-border bg-background-secondary p-4" data-testid="model-editor" onSubmit={(event) => {
        event.preventDefault();
        try {
          const { contextWindowText, maxOutputTokensText, ...draft } = editor.draft;
          settings.update(editModelPatch(useSettings.getState(), editor.original, {
            ...draft,
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
          <Field label="上下文窗口" hint="留空跟随 models.dev"><Input type="number" min={1} aria-label="上下文窗口" placeholder={catalogMeta?.declaredContext?.toString() ?? '未提供'} value={editor.draft.contextWindowText} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, contextWindowText: e.target.value } })} /></Field>
          <Field label="最大输出令牌数" hint="留空跟随 models.dev"><Input type="number" min={1} aria-label="最大输出令牌数" placeholder={catalogMeta?.declaredOutput?.toString() ?? '未提供'} value={editor.draft.maxOutputTokensText} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, maxOutputTokensText: e.target.value } })} /></Field>
        </div>
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
            <Checkbox aria-label="自定义工具调用" isSelected={editor.draft.toolCalling !== undefined} onChange={(on) => setEditor({ ...editor, draft: { ...editor.draft, toolCalling: on ? catalogMeta?.declaredToolCall ?? false : undefined } })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>自定义工具调用</Checkbox.Content></Checkbox>
            <Checkbox aria-label="支持工具调用" isDisabled={editor.draft.toolCalling === undefined} isSelected={editor.draft.toolCalling ?? catalogMeta?.declaredToolCall ?? false} onChange={(on) => setEditor({ ...editor, draft: { ...editor.draft, toolCalling: on } })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>支持工具调用</Checkbox.Content></Checkbox>
          </div>
        </Field>
        <ModelMetadataDetails catalogId={provider?.catalogId ?? ''} model={editor.draft.model} overrides={{ ...editor.draft, contextWindow: editor.draft.contextWindowText ? Number(editor.draft.contextWindowText) : undefined, maxOutputTokens: editor.draft.maxOutputTokensText ? Number(editor.draft.maxOutputTokensText) : undefined }} />
        <Button variant="secondary" className="self-start" onPress={() => {
          const draft = { ...editor.draft, contextWindowText: '', maxOutputTokensText: '' };
          for (const field of MODEL_OVERRIDE_FIELDS) delete draft[field];
          setEditor({ ...editor, draft });
        }}>恢复 models.dev 默认能力</Button>
        <Field label="使用用途"><div className="flex flex-wrap gap-4">{slots.map((slot) => <Checkbox key={slot} isDisabled={!provider?.serves.includes(slot)} isSelected={editor.draft.slots.includes(slot)} onChange={(on) => setEditor({ ...editor, draft: { ...editor.draft, slots: on ? [...editor.draft.slots, slot] : editor.draft.slots.filter((s) => s !== slot) } })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{SLOT_LABEL[slot]}</Checkbox.Content></Checkbox>)}</div></Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex gap-2"><Button type="submit">{editor.original ? '保存修改' : '添加模型'}</Button><Button variant="ghost" onPress={() => setEditor(null)}>取消</Button></div>
      </form>}

      <SearchField aria-label="搜索模型" value={query} onChange={setQuery}><SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder="查找模型" /><SearchField.ClearButton /></SearchField.Group></SearchField>
      <div className="flex flex-col divide-y divide-border" data-testid="saved-models">
        {filtered.map((m) => <div key={modelKey(m)} className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{m.name || m.model}</div><div className="truncate text-xs text-muted">{m.name && `${m.model} · `}{m.slots.map((s) => SLOT_LABEL[s]).join(' / ')}{active(m) ? ' · 使用中' : ''}</div></div>
          <Button size="sm" variant="secondary" aria-label={`编辑 ${m.name || m.model}`} onPress={() => openEditor(m)}>编辑</Button>
        </div>)}
        {!filtered.length && <p role="status" className="py-5 text-sm text-muted">还没有添加模型，点击“新模型”开始。</p>}
      </div>
    </div>
  </SectionCard>;
}
