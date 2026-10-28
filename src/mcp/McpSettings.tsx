import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Modal, Switch, TextArea } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { SectionCard, MODAL_CONTAINER_CLASS } from '../ui';
import { cloud } from '../cloud/state';
import { deleteMcpServer, listMcpServers, saveMcpServer, testMcpServer } from './client';
import type { McpServer, McpServerInput, McpTool } from '../../packages/contracts/src/mcp';
import settingsMessages from '../i18n/locales/zh-CN/settings.json';
import { McpImport, McpConnectionActions } from './McpAdvanced';
import { SettingSelect } from '../components/settings/controls';

const initial: McpServerInput = { name: '', url: '', transport: 'streamable-http', auth: 'none', enabled: true, timeoutMs: 30000, disabledTools: [] };
export default function McpSettings() {
  const { t } = useTranslation('settings');
  const [servers, setServers] = useState<McpServer[]>([]);
  const [draft, setDraft] = useState<(McpServerInput & { id?: string; configured?: boolean }) | null>(null);
  const [headerText, setHeaderText] = useState('');
  const [argsText, setArgsText] = useState('[]');
  const [envText, setEnvText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [tools, setTools] = useState<Record<string, McpTool[]>>({});
  const [timings, setTimings] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<string>();
  const [remove, setRemove] = useState<McpServer | null>(null);
  const message = (e: unknown) => {
    const code = e instanceof Error ? e.message : '';
    return t(`mcp.errors.${Object.hasOwn(settingsMessages.mcp.errors, code) ? code as keyof typeof settingsMessages.mcp.errors : 'generic'}`);
  };
  const reload = useCallback(async () => { setServers((await listMcpServers()).servers); setLoaded(true); }, []);
  useEffect(() => {
    if (!cloud.enabled) return;
    let cancelled = false;
    void listMcpServers().then(r => { if (!cancelled) { setServers(r.servers); setLoaded(true); } }).catch(() => { if (!cancelled) setError(t('mcp.errors.generic')); });
    return () => { cancelled = true; };
  }, [t]);
  const action = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id); setError('');
    try { await work(); await reload(); } catch (e) { setError(message(e)); await reload().catch(() => {}); }
    finally { setBusy(''); }
  };
  const test = (server: McpServer) => action(server.id, async () => {
    const result = await testMcpServer(server.id);
    setTools(current => ({ ...current, [server.id]: result.tools }));
    setTimings(current => ({ ...current, [server.id]: result.durationMs })); setExpanded(server.id);
  });
  const edit = (server?: McpServer) => { setError(''); setHeaderText(''); setEnvText(''); setArgsText(JSON.stringify(server?.args ?? [])); setDraft(server ? { ...server } : { ...initial }); };
  const save = () => action('save', async () => {
    if (!draft) return;
    let headers: Record<string, string> | undefined;
    if (draft.auth === 'headers' && headerText.trim()) {
      try { headers = JSON.parse(headerText); } catch { throw new Error('mcp_invalid_credentials'); }
    }
    let process: Partial<McpServerInput> = {};
    if (draft.transport === 'stdio') {
      try { process = { args: JSON.parse(argsText), ...(envText.trim() ? { env: JSON.parse(envText) } : {}) }; } catch { throw new Error('mcp_invalid_command'); }
    }
    await saveMcpServer({ ...draft, ...process, ...(headers === undefined ? {} : { headers }) }, draft.id);
    setDraft(null); setHeaderText(''); setEnvText('');
  });
  if (!cloud.enabled) return <SectionCard title="MCP" subtitle={t('mcp.offline')}><p>{t('mcp.description')}</p></SectionCard>;
  return <SectionCard title={t('mcp.title')} subtitle={t('mcp.description')}>
    <div className="flex flex-col gap-4" data-testid="mcp-settings">
      <div className="flex flex-wrap gap-2"><Button onPress={() => edit()} isDisabled={!!busy}>{t('mcp.add')}</Button><McpImport onSaved={reload} /><Button variant="tertiary" isDisabled={!!busy} onPress={() => void action('reload', reload)}>{t('mcp.refresh')}</Button></div>
      {error && <p role="alert" className="text-danger">{error}</p>}
      {!loaded && !error ? <p role="status">{t('mcp.loading')}</p> : null}
      {loaded && !servers.length ? <p className="text-muted">{t('mcp.empty')}</p> : null}
      {servers.map(server => <section key={server.id} className="rounded-xl bg-background-secondary p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0"><h3 className="font-semibold break-words">{server.name}</h3><p className="text-sm text-muted break-all">{server.transport === 'stdio' ? server.command : server.url}</p></div>
          <Switch aria-label={t('mcp.enableServer', { name: server.name })} isSelected={server.enabled} isDisabled={!!busy} onChange={enabled => void action(server.id, () => saveMcpServer({ ...server, enabled }, server.id))}><Switch.Control><Switch.Thumb /></Switch.Control></Switch>
        </div>
        <p className="text-sm" role="status">{server.transport} · {t(`mcp.status.${busy === server.id ? 'connecting' : server.status}`)}{server.toolCount !== undefined ? ` · ${t('mcp.toolCount', { count: server.toolCount })}` : ''}{timings[server.id] !== undefined ? ` · ${timings[server.id]} ms` : ''}</p>
        <McpConnectionActions server={server} onSaved={reload} />
        {server.error && <p className="text-sm text-danger">{message(new Error(server.error))}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" isDisabled={!!busy} onPress={() => void test(server)}>{t('mcp.test')}</Button>
          <Button size="sm" variant="tertiary" isDisabled={!!busy} onPress={() => edit(server)}>{t('mcp.edit')}</Button>
          <Button size="sm" variant="tertiary" isDisabled={!!busy} onPress={() => tools[server.id] ? setExpanded(expanded === server.id ? undefined : server.id) : void test(server)}>{t('mcp.tools')}</Button>
          <Button size="sm" variant="danger-soft" isDisabled={!!busy} onPress={() => setRemove(server)}>{t('mcp.delete')}</Button>
        </div>
        {expanded === server.id && tools[server.id] ? <div className="flex flex-col gap-3">
          {tools[server.id].length === 0 && <p>{t('mcp.noTools')}</p>}
          {tools[server.id].map(tool => <div key={tool.name} className="rounded-lg bg-background p-3">
            <div className="flex justify-between gap-2"><strong className="break-all">{tool.originalName}</strong><Switch aria-label={t('mcp.enableTool', { name: tool.originalName })} isSelected={!server.disabledTools.includes(tool.originalName)} isDisabled={!!busy} onChange={enabled => void action(server.id, () => saveMcpServer({ ...server, disabledTools: enabled ? server.disabledTools.filter(n => n !== tool.originalName) : [...server.disabledTools, tool.originalName] }, server.id))}><Switch.Control><Switch.Thumb /></Switch.Control></Switch></div>
            <p className="text-sm whitespace-pre-wrap break-words">{tool.description}</p>
            <details><summary className="text-sm text-muted cursor-pointer">{t('mcp.parameters')}</summary><pre className="text-xs overflow-x-auto max-h-60">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>
          </div>)}
        </div> : null}
      </section>)}
    </div>
    <Modal.Root isOpen={draft !== null} onOpenChange={open => { if (!open && !busy) { setDraft(null); setHeaderText(''); setEnvText(''); } }}>
      <Modal.Backdrop><Modal.Container size="lg" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
        <Modal.Header><Modal.Heading>{draft?.id ? t('mcp.edit') : t('mcp.add')}</Modal.Heading></Modal.Header>
        <Modal.Body>{draft && <div className="flex flex-col gap-3 [&_label]:flex [&_label]:flex-col [&_label]:gap-1">
          <label>{t('mcp.name')}<Input fullWidth value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
          <SettingSelect label={t('mcp.transport')} value={draft.transport}
            options={[{ id: 'streamable-http', label: 'Streamable HTTP' }, { id: 'sse', label: 'HTTP + SSE' }, { id: 'stdio', label: 'stdio' }]}
            onChange={value => setDraft({ ...draft, transport: value as McpServerInput['transport'], auth: value === 'stdio' ? 'none' : draft.auth })} />
          {draft.transport === 'stdio' ? <>
            <p className="text-sm text-muted">{t('mcp.stdioHint')}</p>
            <label>{t('mcp.command')}<Input fullWidth value={draft.command ?? ''} onChange={e => setDraft({ ...draft, command: e.target.value })} /></label>
            <label>{t('mcp.args')}<TextArea fullWidth aria-label={t('mcp.args')} value={argsText} onChange={e => setArgsText(e.target.value)} /></label>
            <label>{t('mcp.cwd')}<Input fullWidth value={draft.cwd ?? ''} onChange={e => setDraft({ ...draft, cwd: e.target.value })} /></label>
            <label>{t('mcp.env')}<TextArea fullWidth aria-label={t('mcp.env')} value={envText} placeholder={t('mcp.secretKept')} onChange={e => setEnvText(e.target.value)} /></label>
            <Button size="sm" variant="tertiary" onPress={() => setEnvText('{}')}>{t('mcp.clearSecret')}</Button>
          </> : <label>{t('mcp.url')}<Input fullWidth type="url" placeholder="https://example.com/mcp" value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} /></label>}
          {draft.transport !== 'stdio' ? <p className="text-sm text-muted">{t('mcp.transportHint')}</p> : null}
          <SettingSelect label={t('mcp.auth')} value={draft.auth} isDisabled={draft.transport === 'stdio'}
            options={[{ id: 'none', label: t('mcp.authNone') }, { id: 'bearer', label: 'Bearer Token' }, { id: 'headers', label: t('mcp.authHeaders') }, { id: 'oauth', label: 'OAuth' }]}
            onChange={value => { setDraft({ ...draft, auth: value as McpServerInput['auth'], token: undefined, headers: undefined }); setHeaderText(''); }} />
          {draft.auth === 'oauth' ? <p className="text-sm text-muted">{t('mcp.oauthHint')}</p> : null}
          {draft.auth === 'bearer' ? <label>Bearer Token<Input fullWidth type="password" autoComplete="new-password" value={draft.token ?? ''} placeholder={draft.configured ? t('mcp.secretKept') : ''} onChange={e => setDraft({ ...draft, token: e.target.value })} /></label> : null}
          {draft.auth === 'headers' ? <label>{t('mcp.headers')}<TextArea fullWidth aria-label={t('mcp.headers')} value={headerText} placeholder={draft.configured ? t('mcp.secretKept') : '{"X-API-Key": "..."}'} onChange={e => setHeaderText(e.target.value)} /></label> : null}
          {draft.auth !== 'none' && draft.auth !== 'oauth' ? <div><p className="text-sm text-muted">{t('mcp.secretHint')}</p><Button size="sm" variant="tertiary" onPress={() => { setDraft({ ...draft, token: '', headers: {} }); setHeaderText('{}'); }}>{t('mcp.clearSecret')}</Button></div> : null}
          <label>{t('mcp.timeout')}<Input fullWidth type="number" min={1} max={120} value={String(draft.timeoutMs / 1000)} onChange={e => setDraft({ ...draft, timeoutMs: Number(e.target.value) * 1000 })} /></label>
          {error && <p role="alert" className="text-danger">{error}</p>}
        </div>}</Modal.Body>
        <Modal.Footer><Button variant="tertiary" isDisabled={!!busy} onPress={() => { setDraft(null); setHeaderText(''); setEnvText(''); }}>{t('mcp.cancel')}</Button><Button isDisabled={!!busy || !draft?.name.trim() || !(draft.transport === 'stdio' ? draft.command?.trim() : draft.url.trim())} onPress={() => void save()}>{t('mcp.save')}</Button></Modal.Footer>
      </Modal.Dialog></Modal.Container></Modal.Backdrop>
    </Modal.Root>
    <Modal.Root isOpen={remove !== null} onOpenChange={open => { if (!open && !busy) setRemove(null); }}><Modal.Backdrop><Modal.Container className={MODAL_CONTAINER_CLASS} size="sm"><Modal.Dialog>
      <Modal.Header><Modal.Heading>{t('mcp.delete')}</Modal.Heading></Modal.Header><Modal.Body>{t('mcp.deleteConfirm', { name: remove?.name })}</Modal.Body>
      <Modal.Footer><Button variant="tertiary" isDisabled={!!busy} onPress={() => setRemove(null)}>{t('mcp.cancel')}</Button><Button variant="danger" isDisabled={!!busy} onPress={() => { if (remove) void action(remove.id, async () => { await deleteMcpServer(remove.id); setRemove(null); }); }}>{t('mcp.delete')}</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal.Root>
  </SectionCard>;
}
