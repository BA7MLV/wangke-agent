import { useState } from 'react';
import { Button, Modal, TextArea } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { cloudRequest } from '../cloud/state';
import { MODAL_CONTAINER_CLASS } from '../ui';
import type { McpServer } from '@wangke/contracts/mcp';
import messages from '../i18n/locales/zh-CN/settings.json';

function errorKey(e: unknown) {
  const code = e instanceof Error ? e.message : '';
  return `mcp.errors.${Object.hasOwn(messages.mcp.errors, code) ? code as keyof typeof messages.mcp.errors : 'generic'}` as const;
}
export function McpImport({ onSaved }: { onSaved: () => Promise<void> }) {
  const { t } = useTranslation('settings');
  const [text, setText] = useState<string | null>(null);
  const [preview, setPreview] = useState<Array<{ name: string; transport: string }>>([]);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (save: boolean) => {
    setBusy(true); setError('');
    try {
      let config: unknown; try { config = JSON.parse(text ?? ''); } catch { throw new Error('mcp_invalid_import'); }
      const result = await cloudRequest<{ servers: Array<{ name: string; transport: string }> }>(save ? '/mcp/import' : '/mcp/import/preview', { method: 'POST', body: JSON.stringify(config) });
      if (save) { setText(null); setPreview([]); await onSaved(); } else setPreview(result.servers);
    } catch (e) { setError(t(errorKey(e))); } finally { setBusy(false); }
  };
  return <><Button variant="tertiary" onPress={() => { setText(''); setPreview([]); setError(''); }}>{t('mcp.import')}</Button>
    <Modal.Root isOpen={text !== null} onOpenChange={open => { if (!open && !busy) setText(null); }}><Modal.Backdrop><Modal.Container size="lg" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
      <Modal.Header><Modal.Heading>{t('mcp.import')}</Modal.Heading></Modal.Header>
      <Modal.Body><p className="text-sm text-muted">{t('mcp.importHint')}</p><TextArea fullWidth aria-label={t('mcp.import')} value={text ?? ''} rows={10} disabled={busy} onChange={e => { setText(e.target.value); setPreview([]); }} />
        {preview.map(s => <p key={s.name}>{s.name} · {s.transport}</p>)}{error && <p role="alert">{error}</p>}
      </Modal.Body><Modal.Footer><Button variant="tertiary" isDisabled={busy} onPress={() => setText(null)}>{t('mcp.cancel')}</Button><Button isDisabled={busy || !text} onPress={() => void submit(preview.length > 0)}>{t(preview.length ? 'mcp.importConfirm' : 'mcp.preview')}</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal.Root></>;
}
export function McpConnectionActions({ server, onSaved }: { server: McpServer; onSaved: () => Promise<void> }) {
  const { t } = useTranslation('settings'); const [link, setLink] = useState('');
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const run = async (action: 'start' | 'disconnect' | 'log') => {
    setBusy(true); setMessage(''); setLink('');
    try {
      if (action === 'log') setMessage((await cloudRequest<{ text: string }>(`/mcp/${server.id}/log`)).text || t('mcp.noLogs'));
      else if (action === 'start') setLink((await cloudRequest<{ authorizationUrl: string }>(`/mcp/${server.id}/oauth/start`, { method: 'POST' })).authorizationUrl);
      else { const result = await cloudRequest<{ revoked: boolean }>(`/mcp/${server.id}/oauth/disconnect`, { method: 'POST' }); setMessage(t(result.revoked ? 'mcp.revoked' : 'mcp.disconnectedLocal')); }
      await onSaved();
    } catch (e) { setMessage(t(errorKey(e))); } finally { setBusy(false); }
  };
  if (server.auth !== 'oauth' && server.transport !== 'stdio') return null;
  return <div className="flex flex-col gap-2">
    {server.auth === 'oauth' ? <><p className="text-sm">{t(server.oauthAuthorized ? 'mcp.authorized' : 'mcp.notAuthorized')}</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void run('start')}>{t('mcp.authorize')}</Button><Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void run('disconnect')}>{t('mcp.disconnect')}</Button></div></> : <div className="flex gap-2 items-center">{server.pid ? <span>PID {server.pid}</span> : null}<Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void run('log')}>{t('mcp.logs')}</Button></div>}
    {link && <a className="underline text-accent" href={link} target="_blank" rel="noreferrer">{t('mcp.openAuthorization')}</a>}
    {message && <pre role="status" className="text-sm whitespace-pre-wrap break-all max-h-48 overflow-auto">{message}</pre>}
  </div>;
}
