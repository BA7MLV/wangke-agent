import { useState } from 'react';
import { Button, Checkbox, Input, ListBox, SearchField, Select } from '@heroui/react';
import { SLOT_LABEL, useSettings, type ModelSlot, type SavedModel } from '../../store/settings';
import { editModelPatch, modelKey, savedModelsOf } from '../../store/modelLibrary';
import { confirmDialog, Field, LoadingButton, SectionCard, toast } from '../../ui';

const slots: ModelSlot[] = ['chat', 'vision', 'asr'];

export default function ModelLibrary({ options, checking, onFetch }: {
  options: Record<string, string[]>;
  checking: boolean;
  onFetch: () => Promise<void>;
}) {
  const settings = useSettings();
  const saved = savedModelsOf(settings);
  const [discover, setDiscover] = useState(false);
  const [query, setQuery] = useState('');
  const [providerId, setProviderId] = useState(settings.providers[0]?.id ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [purpose, setPurpose] = useState<ModelSlot>('chat');
  const [editor, setEditor] = useState<{ original: SavedModel | null; draft: SavedModel } | null>(null);
  const [error, setError] = useState('');
  const provider = settings.providers.find((p) => p.id === providerId);
  const savedKeys = new Set(saved.map(modelKey));
  const needle = query.trim().toLowerCase();
  const discovered = [...new Set(options[providerId] ?? [])].filter((id) => id.toLowerCase().includes(needle));
  const available = discovered.filter((model) => !savedKeys.has(modelKey({ providerId, model })));
  const active = (m: SavedModel) => [settings.llmModel, settings.visionModel, settings.asrModel].some((r) => modelKey(r) === modelKey(m));

  function openEditor(model: SavedModel | null) {
    setError('');
    setEditor({ original: model, draft: model ? { ...model, slots: [...model.slots] } : {
      providerId, model: '', name: '', slots: [provider?.serves[0] ?? 'chat'],
    } });
  }

  return (
    <SectionCard title="我的模型" subtitle="拉取列表后勾选添加；已添加模型同步出现在默认模型和 Chat 选择器中。" testId="card-model-library"
      actions={<>
        <Button variant="secondary" onPress={() => openEditor(null)}>手动添加</Button>
        <LoadingButton loading={checking} variant="primary" data-testid="btn-check-models" onPress={() => {
          setDiscover(true); setQuery(''); void onFetch();
        }}>拉取模型列表</LoadingButton>
      </>}>
      <div className="flex flex-col gap-4">
        {discover && <div className="flex flex-col gap-3 rounded-xl border border-border p-4" data-testid="model-discovery">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">发现模型</h3>
            <Button size="sm" variant="ghost" onPress={() => { setDiscover(false); setSelected(new Set()); }}>关闭</Button>
          </div>
          <p className="text-xs text-muted">拉取不会自动添加或覆盖已有配置。按用途添加，之后可以编辑。</p>
          <div className="flex flex-wrap gap-2">
            <Select aria-label="发现模型的供应商" selectedKey={providerId} className="min-w-40 flex-1" onSelectionChange={(key) => {
              const id = String(key); setProviderId(id); setSelected(new Set());
              setPurpose(settings.providers.find((p) => p.id === id)?.serves[0] ?? 'chat');
            }}>
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover isNonModal><ListBox>{settings.providers.map((p) => <ListBox.Item id={p.id} key={p.id} textValue={p.name}>{p.name || '未命名供应商'}</ListBox.Item>)}</ListBox></Select.Popover>
            </Select>
            <Select aria-label="添加模型的用途" selectedKey={purpose} className="min-w-32" onSelectionChange={(key) => setPurpose(String(key) as ModelSlot)}>
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover isNonModal><ListBox>{(provider?.serves ?? []).map((slot) => <ListBox.Item id={slot} key={slot} textValue={SLOT_LABEL[slot]}>{SLOT_LABEL[slot]}</ListBox.Item>)}</ListBox></Select.Popover>
            </Select>
          </div>
          <SearchField aria-label="搜索发现的模型" value={query} onChange={setQuery}>
            <SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder="搜索模型 ID" /><SearchField.ClearButton /></SearchField.Group>
          </SearchField>
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span className="tabular-nums">{discovered.length} 个结果 · 已勾选 {selected.size} 个</span>
            <Button size="sm" variant="ghost" isDisabled={!available.length} onPress={() => setSelected((prev) => {
              const next = new Set(prev); const all = available.every((id) => next.has(id));
              available.forEach((id) => all ? next.delete(id) : next.add(id)); return next;
            })}>全选 / 取消当前结果</Button>
          </div>
          <div className="flex max-h-64 flex-col gap-2 overflow-y-auto overscroll-contain" aria-busy={checking}>
            {discovered.map((model) => {
              const added = savedKeys.has(modelKey({ providerId, model }));
              return <Checkbox key={model} isDisabled={added} isSelected={added || selected.has(model)} onChange={(on) => setSelected((prev) => {
                const next = new Set(prev); if (on) next.add(model); else next.delete(model); return next;
              })}>
                <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control><span className="break-all font-mono text-sm">{model}</span>{added && <span className="shrink-0 text-xs text-muted">已添加</span>}</Checkbox.Content>
              </Checkbox>;
            })}
            {!discovered.length && <p role="status" className="py-4 text-sm text-muted">{checking ? '正在拉取模型…' : needle ? '没有匹配的模型，试试其他关键词。' : '暂无可用列表，请检查下方供应商连接后重试，或手动添加。'}</p>}
          </div>
          <Button isDisabled={!selected.size || !provider?.serves.includes(purpose)} onPress={() => {
            const current = useSettings.getState();
            const existing = savedModelsOf(current);
            const keys = new Set(existing.map(modelKey));
            const added = [...selected].filter((model) => !keys.has(modelKey({ providerId, model })))
              .map((model) => ({ providerId, model, name: '', slots: [purpose] }));
            current.update({ savedModels: [...existing, ...added] });
            setSelected(new Set()); toast.success(`已添加 ${added.length} 个模型`);
          }}>添加所选模型（{selected.size}）</Button>
        </div>}

        {editor && <form className="flex flex-col gap-3 rounded-xl border border-border p-4" data-testid="model-editor" onSubmit={(event) => {
          event.preventDefault();
          try { settings.update(editModelPatch(useSettings.getState(), editor.original, editor.draft)); setEditor(null); toast.success('模型已保存'); }
          catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        }}>
          <h3 className="text-sm font-semibold">{editor.original ? '编辑模型' : '手动添加模型'}</h3>
          <Select aria-label="模型所属供应商" selectedKey={editor.draft.providerId} isDisabled={!!editor.original} onSelectionChange={(key) => {
            const id = String(key); setEditor({ ...editor, draft: { ...editor.draft, providerId: id, slots: [settings.providers.find((p) => p.id === id)?.serves[0] ?? 'chat'] } });
          }}>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover isNonModal><ListBox>{settings.providers.map((p) => <ListBox.Item id={p.id} key={p.id} textValue={p.name}>{p.name || '未命名供应商'}</ListBox.Item>)}</ListBox></Select.Popover>
          </Select>
          <Field label="模型 ID" hint="请求时发送的精确 ID，请与供应商文档一致。">
            <Input aria-label="模型 ID" autoFocus value={editor.draft.model} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, model: e.target.value } })} />
          </Field>
          <Field label="显示名称" hint="可选，仅改变显示，不改变 API 请求。">
            <Input aria-label="模型显示名称" placeholder="例如：日常问答" value={editor.draft.name} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, name: e.target.value } })} />
          </Field>
          <div className="flex flex-wrap gap-3" role="group" aria-label="模型用途">
            {slots.map((slot) => <Checkbox key={slot} isDisabled={!settings.providers.find((p) => p.id === editor.draft.providerId)?.serves.includes(slot)} isSelected={editor.draft.slots.includes(slot)} onChange={(on) => setEditor({ ...editor, draft: { ...editor.draft, slots: on ? [...editor.draft.slots, slot] : editor.draft.slots.filter((s) => s !== slot) } })}>
              <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{SLOT_LABEL[slot]}</Checkbox.Content>
            </Checkbox>)}
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2"><Button variant="ghost" onPress={() => setEditor(null)}>取消</Button><Button type="submit">保存模型</Button></div>
        </form>}

        <div className="flex flex-col divide-y divide-border" data-testid="saved-models">
          {saved.map((m) => <div key={modelKey(m)} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium" title={m.model}>{m.name || m.model}</div>
              <div className="truncate text-xs text-muted">{settings.providers.find((p) => p.id === m.providerId)?.name || '供应商不可用'} · {m.slots.map((s) => SLOT_LABEL[s]).join(' / ')}{active(m) ? ' · 使用中' : ''}</div>
              {m.name && <div className="truncate font-mono text-xs text-muted">{m.model}</div>}
            </div>
            <Button size="sm" variant="secondary" aria-label={`编辑 ${m.name || m.model}`} onPress={() => openEditor(m)}>编辑</Button>
            <Button size="sm" variant="ghost" isDisabled={active(m)} aria-label={`移除 ${m.name || m.model}`} onPress={async () => {
              if (!await confirmDialog({ headline: '移除模型？', description: `从模型选择器中移除「${m.name || m.model}」。需要时可以重新添加。`, danger: true, confirmText: '移除' })) return;
              const current = useSettings.getState();
              if ([current.llmModel, current.visionModel, current.asrModel].some((r) => modelKey(r) === modelKey(m))) return;
              current.update({ savedModels: savedModelsOf(current).filter((r) => modelKey(r) !== modelKey(m)), favorites: Object.fromEntries(slots.map((s) => [s, current.favorites[s].filter((r) => modelKey(r) !== modelKey(m))])) as typeof current.favorites });
            }}>移除</Button>
          </div>)}
          {!saved.length && <p className="py-4 text-sm text-muted">还没有添加模型。点击「拉取模型列表」开始。</p>}
        </div>
        <p className="text-xs text-muted">使用中的模型需先切换默认模型再移除。所有修改自动保存在本机。</p>
      </div>
    </SectionCard>
  );
}
