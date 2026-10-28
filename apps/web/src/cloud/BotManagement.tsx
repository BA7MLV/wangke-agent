import { useEffect, useState } from 'react';
import { Button, Input, Label, ListBox, Select, Switch, TextArea } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { request } from '../api/serverClient';
import { confirmDialog } from '../ui';
import type { CloudConfig } from '@wangke/contracts/cloud';
import { useNavigate } from 'react-router-dom';

type Budget = NonNullable<CloudConfig['botBudget']>;
interface Memory { id: string; path?: string; scope: string; scope_id: string; content: string; source: string; source_revision: string | null; revision: number; status: string; kind: string }
interface Run { id: string; threadId: string; status: string; errorCode: string | null; steps: number; activeMs: number }
interface Overview { budget: Budget; runs: Run[]; usage: { requests: number; knownTokens: number; unknownReservedTokens: number; knownCost: number | null; unknownCostRequests: number }; memoryJob: { enabled: number; tokenBudget: number; intervalSeconds: number } }
interface Detail { budget: Budget; requests: Array<{ id: string; purpose: string; status: string; input_tokens: number | null; output_tokens: number | null; reserved_tokens: number; cost: number | null; started_at: string; ended_at: string | null }>; steps: Array<{ id: string; tool: string; status: string; preview: string; created_at: string; completed_at: string | null }>; summaries: Array<{ id: string; content: string }>; artifacts: Array<{ id: string; size_bytes: number }> }
const emptyMemory = { id: '', path: '', revision: 0, scope: 'owner', scopeId: '', kind: 'preference', content: '', source: 'user:management', sourceRevision: '' };
const memoryForm = (row: Memory) => ({ id: row.id, path: row.path ?? '', revision: row.revision, scope: row.scope, scopeId: row.scope_id, kind: row.kind, content: row.content, source: row.source, sourceRevision: row.source_revision ?? '' });
/** HeroUI Select 的薄封装：一个标签、一组 [值, 文案]。 */
function PlainSelect({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <Select className="w-full" selectedKey={value} onSelectionChange={key => { if (key != null) onChange(String(key)); }}>
    <Label>{label}</Label>
    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
    <Select.Popover><ListBox>{options.map(([id, text]) => <ListBox.Item key={id} id={id} textValue={text}>{text}</ListBox.Item>)}</ListBox></Select.Popover>
  </Select>;
}

export default function BotManagement() {
  const { t } = useTranslation('bot');
  const navigate = useNavigate();
  const [overview, setOverview] = useState<Overview>();
  const [budget, setBudget] = useState<Budget>();
  const [prices, setPrices] = useState<string>();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [runOffset, setRunOffset] = useState(0);
  const [form, setForm] = useState(emptyMemory);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Run>();
  const [detail, setDetail] = useState<Detail>();
  const [detailOffset, setDetailOffset] = useState(0);
  const [versions, setVersions] = useState<Array<{ revision: number; value: string }>>([]);
  const [versionOffset, setVersionOffset] = useState(0);
  const [skills, setSkills] = useState<Array<{ id: number; name: string; missingMcp: string[] }>>([]);
  const [skillScope, setSkillScope] = useState('null');
  const [artifact, setArtifact] = useState<{ artifactId: string; text: string; nextOffset: number | null }>();
  const post = (path: string, body: unknown) => request(`/bot${path}`, { method: 'POST', body: JSON.stringify(body) });
  const load = async () => {
    const [next, list] = await Promise.all([request<Overview>(`/bot/manage?offset=${runOffset}`), request<{ memories: Memory[] }>(`/bot/memories?deleted=true&query=${encodeURIComponent(search)}&offset=${offset}`)]);
    setOverview(next); setMemories(list.memories);
    setBudget(current => current ?? next.budget);
    setPrices(current => current ?? JSON.stringify(next.budget.prices, null, 2));
  };
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(query); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    void Promise.all([request<Overview>(`/bot/manage?offset=${runOffset}`, { signal: controller.signal }), request<{ memories: Memory[] }>(`/bot/memories?deleted=true&query=${encodeURIComponent(search)}&offset=${offset}`, { signal: controller.signal })]).then(([next, list]) => { if (ignore) return; setOverview(next); setMemories(list.memories); setBudget(current => current ?? next.budget); setPrices(current => current ?? JSON.stringify(next.budget.prices, null, 2)); }).catch(e => { if (!ignore) setError((e as Error).message); });
    return () => { ignore = true; controller.abort(); };
  }, [offset, runOffset, search]);
  async function act(action: () => Promise<unknown>) { setBusy(true); setError(''); try { await action(); window.dispatchEvent(new Event('system-files-changed')); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function openRun(run: Run, page = 0) {
    const [next, scope] = await Promise.all([request<Detail>(`/bot/runs/${run.id}?offset=${page}`), request<{ skills: typeof skills; scope: string | null }>(`/bot/threads/${run.threadId}/skills`)]);
    setSelected(run); setDetail(next); setDetailOffset(page); setSkills(scope.skills); setSkillScope(scope.scope ?? 'null');
  }
  async function openVersions(row: Memory, page = 0) {
    const next = await request<{ versions: typeof versions }>(`/bot/memories/${row.id}/versions?offset=${page}`);
    setForm(memoryForm(row)); setVersions(next.versions); setVersionOffset(page);
  }
  return <section className="flex min-w-0 flex-col gap-4" aria-label={t('title')} data-testid="bot-management">
    <h3 className="text-base font-semibold">{t('title')}</h3>
    {error ? <p role="alert" className="break-words text-danger">{error}</p> : null}
    <Button variant="secondary" isDisabled={busy} onPress={() => void act(load)}>{t('refresh')}</Button>
    {overview && budget ? <>
      <p data-testid="bot-usage">{t('usage', { ...overview.usage, knownCost: overview.usage.knownCost ?? t('unknown') })}</p>
      <fieldset className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4"><legend>{t('budget')}</legend>
        {(['runTokens', 'dayTokens', 'activeMs', 'contextTokens'] as const).map(key => <label key={key}>{t(key)}<Input className="w-full" type="number" min={100} value={budget[key]} onChange={e => setBudget({ ...budget, [key]: Number(e.target.value) })} /></label>)}
        <label>{t('runCost')}<Input className="w-full" type="number" min={0} step="0.01" value={budget.runCost ?? ''} onChange={e => setBudget({ ...budget, runCost: e.target.value ? Number(e.target.value) : undefined })} /></label>
        <label htmlFor="bot-budget-prices">{t('prices')}</label><TextArea id="bot-budget-prices" className="w-full font-mono text-sm" rows={3} value={prices ?? ''} onChange={e => setPrices(e.target.value)} />
        <Button isDisabled={busy} onPress={() => void act(() => post('/budget', { ...budget, prices: JSON.parse(prices ?? '[]') }))}>{t('save')}</Button>
      </fieldset>
      <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-4"><legend>{t('consolidation')}</legend>
        <Switch isSelected={Boolean(overview.memoryJob.enabled)} onChange={on => setOverview({ ...overview, memoryJob: { ...overview.memoryJob, enabled: Number(on) } })}><Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control><Label>{t('enabled')}</Label></Switch.Content></Switch>
        <label>{t('jobTokens')}<Input className="w-full" type="number" value={overview.memoryJob.tokenBudget} onChange={e => setOverview({ ...overview, memoryJob: { ...overview.memoryJob, tokenBudget: Number(e.target.value) } })} /></label>
        <label>{t('interval')}<Input className="w-full" type="number" value={overview.memoryJob.intervalSeconds} onChange={e => setOverview({ ...overview, memoryJob: { ...overview.memoryJob, intervalSeconds: Number(e.target.value) } })} /></label>
        <Button isDisabled={busy} onPress={() => void act(() => post('/memory-job', { ...overview.memoryJob, enabled: Boolean(overview.memoryJob.enabled) }))}>{t('save')}</Button>
      </fieldset>
      <h4>{t('runs')}</h4>
      {!overview.runs.length ? <p>{t('empty')}</p> : null}
      {overview.runs.map(run => <div key={run.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-default p-3"><span className="min-w-0 break-all text-sm">{run.id} · {run.status} · {run.errorCode} · {run.steps} · {Math.round(run.activeMs / 1000)}s</span><Button variant="secondary" isDisabled={busy} onPress={() => void act(() => openRun(run))}>{t('details')}</Button>{run.status === 'paused' ? <Button isDisabled={busy} onPress={() => void act(() => post(`/runs/${run.id}/resume`, {}))}>{t('resume')}</Button> : null}{['queued', 'running', 'waiting_user', 'paused'].includes(run.status) ? <Button variant="secondary" isDisabled={busy} onPress={() => void act(() => request(`/runs/${run.id}/cancel`, { method: 'POST', body: '{}' }))}>{t('stop')}</Button> : null}</div>)}
      <div className="flex gap-2"><Button variant="secondary" isDisabled={runOffset === 0} onPress={() => setRunOffset(Math.max(0, runOffset - 50))}>{t('previous')}</Button><Button variant="secondary" isDisabled={overview.runs.length < 50} onPress={() => setRunOffset(runOffset + 50)}>{t('next')}</Button></div>
    </> : <p role="status">{t('loading')}</p>}
    {detail && selected ? <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4">
      <h4>{t('details')} · <span className="break-all">{selected.id}</span></h4>
      <details><summary>{t('budget')}</summary><pre className="whitespace-pre-wrap break-all text-sm">{JSON.stringify(detail.budget, null, 2)}</pre></details>
      <label>{t('skillScope')}<Input className="w-full font-mono" value={skillScope} onChange={e => setSkillScope(e.target.value)} /></label><p className="text-sm text-muted">{t('scopeHint')}</p>
      {skills.map(skill => <p key={skill.id} className="break-words text-sm">{skill.id}: {skill.name}{skill.missingMcp.length ? ` · MCP: ${skill.missingMcp.join(', ')}` : ''}</p>)}
      <Button isDisabled={busy} onPress={() => void act(() => post(`/threads/${selected.threadId}/skills`, { ids: JSON.parse(skillScope) }))}>{t('save')}</Button>
      {detail.requests.map(row => <p key={row.id} className="break-all text-sm">{row.purpose} · {row.status} · {row.input_tokens === null ? `${t('unknown')} (${row.reserved_tokens})` : `${row.input_tokens} + ${row.output_tokens}`} · {row.cost ?? t('unknown')} · {row.ended_at ? `${Date.parse(row.ended_at) - Date.parse(row.started_at)}ms` : '…'}</p>)}
      {detail.steps.map(step => <details key={step.id}><summary className="break-all">{step.tool} · {step.status} · {step.completed_at ? `${Date.parse(step.completed_at) - Date.parse(step.created_at)}ms` : '…'}</summary><pre className="whitespace-pre-wrap break-all text-sm">{step.preview}</pre></details>)}
      {detail.summaries.map(summary => <details key={summary.id}><summary>{t('summary')}</summary><pre className="whitespace-pre-wrap break-words text-sm">{summary.content}</pre></details>)}
      {detail.artifacts.map(item => <Button key={item.id} variant="secondary" isDisabled={busy} onPress={() => void act(async () => setArtifact(await request(`/bot/artifacts/${item.id}`)))}>{t('artifact')} · {item.size_bytes}</Button>)}
      <div className="flex gap-2"><Button variant="secondary" isDisabled={detailOffset === 0 || busy} onPress={() => void act(() => openRun(selected, Math.max(0, detailOffset - 50)))}>{t('previous')}</Button><Button variant="secondary" isDisabled={busy || Math.max(detail.requests.length, detail.steps.length, detail.artifacts.length) < 50} onPress={() => void act(() => openRun(selected, detailOffset + 50))}>{t('next')}</Button></div>
    </div> : null}
    {artifact ? <div><pre className="whitespace-pre-wrap break-all text-sm">{artifact.text}</pre>{artifact.nextOffset !== null ? <Button onPress={() => void act(async () => setArtifact(await request(`/bot/artifacts/${artifact.artifactId}?offset=${artifact.nextOffset}`)))}>{t('next')}</Button> : null}</div> : null}
    <h4>{t('memory')}</h4><label>{t('search')}<Input className="w-full" value={query} onChange={e => { setQuery(e.target.value); setOffset(0); }} /></label>
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4"><legend>{t('editMemory')}</legend>
      <PlainSelect label={t('scope')} value={form.scope} onChange={scope => setForm({ ...form, scope })} options={[['owner', 'owner'], ['bot', 'bot'], ['course', 'course']]} />
      <label>{t('scopeId')}<Input className="w-full" value={form.scopeId} onChange={e => setForm({ ...form, scopeId: e.target.value })} /></label>
      <PlainSelect label={t('kind')} value={form.kind} onChange={kind => setForm({ ...form, kind })} options={[['preference', t('preference')], ['course_fact', t('courseFact')], ['note', t('note')], ['diary', t('diary')]]} />
      {form.kind === 'note' || form.kind === 'diary' ? <label>{t('notebookPath')}<Input className="w-full font-mono" readOnly={Boolean(form.id)} value={form.path} placeholder={form.kind === 'diary' ? '/system/memory/YYYY-MM-DD.md' : '/system/memory/preferences.md'} onChange={e => setForm({ ...form, path: e.target.value })} /></label> : null}
      <label htmlFor="bot-memory-content">{t('content')}</label><TextArea id="bot-memory-content" className="w-full" rows={3} value={form.content} onChange={e => setForm({ ...form, content: e.target.value })} />
      <label>{t('source')}<Input className="w-full" placeholder={'record:videos:"course-id"'} value={form.source} onChange={e => setForm({ ...form, source: e.target.value })} /></label>
      <label>{t('sourceRevision')}<Input className="w-full" readOnly value={form.sourceRevision} /></label>
      <Button isDisabled={busy || !form.content.trim()} onPress={() => void act(async () => { await post('/memories', { ...form, path: form.path || undefined, id: form.id || undefined, revision: form.revision || undefined }); setForm(emptyMemory); setVersions([]); })}>{t('save')}</Button><Button variant="secondary" onPress={() => { setForm(emptyMemory); setVersions([]); }}>{t('new')}</Button>
    </fieldset>
    {!memories.length ? <p>{t('empty')}</p> : null}
    {memories.map(row => <div key={row.id} className="flex min-w-0 flex-col gap-2 rounded-lg bg-default p-3">{row.path && row.status !== 'deleted' ? <Button variant="ghost" className="self-start" onPress={() => navigate(`/library?file=${encodeURIComponent(row.path!)}`)}>{row.path.split('/').pop()}</Button> : null}<p className="whitespace-pre-wrap break-words">{row.content || t('deleted')}</p><p className="break-all text-sm text-muted">{row.scope}:{row.scope_id} · r{row.revision} · {row.status} · {row.source}</p><div className="flex flex-wrap gap-2"><Button variant="secondary" isDisabled={busy} onPress={() => { setForm(memoryForm(row)); setVersions([]); }}>{t('edit')}</Button><Button variant="secondary" isDisabled={busy} onPress={() => void act(() => openVersions(row))}>{t('versions')}</Button>{row.status !== 'deleted' ? <Button variant="secondary" isDisabled={busy} onPress={() => void act(async () => { if (await confirmDialog({ headline: t('delete'), description: t('deleteHint'), confirmText: t('delete'), danger: true })) await post(`/memories/${row.id}/delete`, { revision: row.revision }); })}>{t('delete')}</Button> : null}</div></div>)}
    {versions.map(version => <div key={version.revision} className="flex flex-wrap items-center gap-2"><span className="min-w-0 break-words text-sm">r{version.revision} · {(JSON.parse(version.value) as Memory).content}</span><Button variant="secondary" isDisabled={busy || (JSON.parse(version.value) as Memory).status === 'deleted'} onPress={() => void act(async () => { await post(`/memories/${form.id}/restore`, { revision: version.revision, expected: form.revision }); setVersions([]); setForm(emptyMemory); })}>{t('restore')}</Button></div>)}
    {versions.length ? <div className="flex gap-2"><Button isDisabled={busy || versionOffset === 0} onPress={() => void act(() => openVersions(memories.find(row => row.id === form.id)!, Math.max(0, versionOffset - 50)))}>{t('previous')}</Button><Button isDisabled={busy || versions.length < 50} onPress={() => void act(() => openVersions(memories.find(row => row.id === form.id)!, versionOffset + 50))}>{t('next')}</Button></div> : null}
    <div className="flex gap-2"><Button variant="secondary" isDisabled={offset === 0} onPress={() => setOffset(Math.max(0, offset - 50))}>{t('previous')}</Button><Button variant="secondary" isDisabled={memories.length < 50} onPress={() => setOffset(offset + 50)}>{t('next')}</Button></div>
  </section>;
}
