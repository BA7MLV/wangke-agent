import { useState } from 'react';
import { Button, Checkbox, Input, SearchField } from '@heroui/react';
import { SLOT_LABEL, useSettings, type ModelSlot, type SavedModel } from '../../store/settings';
import { editModelPatch, modelKey, savedModelsOf } from '../../store/modelLibrary';
import { Field, SectionCard, toast } from '../../ui';

const slots: ModelSlot[] = ['chat', 'vision', 'asr'];
const capabilities = ['text', 'image', 'audio', 'video', 'pdf'];
type Draft = SavedModel & { contextWindowText: string; maxOutputTokensText: string };

export default function ModelLibrary({ providerId }: { providerId: string }) {
  const settings = useSettings();
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
    const current = editor.draft[field] ?? ['text'];
    setEditor({ ...editor, draft: { ...editor.draft, [field]: on ? [...new Set([...current, value])] : current.filter((x) => x !== value) } });
  };

  return <SectionCard title="模型" subtitle="添加或编辑当前供应商的模型。" testId="card-model-library"
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
          <Field label="上下文窗口"><Input type="number" aria-label="上下文窗口" placeholder="128000" value={editor.draft.contextWindowText} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, contextWindowText: e.target.value } })} /></Field>
          <Field label="最大输出令牌数"><Input type="number" aria-label="最大输出令牌数" placeholder="16384" value={editor.draft.maxOutputTokensText} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, maxOutputTokensText: e.target.value } })} /></Field>
        </div>
        <Field label="推理等级"><Input aria-label="推理等级" placeholder="low, medium, high" value={editor.draft.reasoningEffort ?? ''} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, reasoningEffort: e.target.value } })} /></Field>
        {(['inputCapabilities', 'outputCapabilities'] as const).map((field) => <Field key={field} label={field === 'inputCapabilities' ? '输入能力' : '输出能力'}>
          <div className="flex flex-wrap gap-x-5 gap-y-2">{capabilities.map((cap) => <Checkbox key={cap} isSelected={(editor.draft[field] ?? ['text']).includes(cap)} onChange={(on) => toggle(field, cap, on)}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{cap}</Checkbox.Content></Checkbox>)}</div>
        </Field>)}
        <Checkbox isSelected={editor.draft.toolCalling ?? true} onChange={(on) => setEditor({ ...editor, draft: { ...editor.draft, toolCalling: on } })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>工具调用</Checkbox.Content></Checkbox>
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
