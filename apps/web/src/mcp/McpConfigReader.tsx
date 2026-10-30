import { useCallback, useEffect, useState } from 'react';
import { Button, TextArea } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { MCP_PATH, type SystemDocument } from '@wangke/contracts/system';
import { readSystemDocument, saveSystemMarkdown, systemMaterialId } from '../materials/systemFiles';
import { ServerApiError } from '../api/serverClient';
import messages from '../i18n/locales/zh-CN/settings.json';

/** Raw JSON editing for the resource; visual management lives in Settings. Drafts never follow polls. */
export default function McpConfigReader() {
  const { t } = useTranslation('settings');
  const [document, setDocument] = useState<SystemDocument>();
  const [editor, setEditor] = useState<{ base: SystemDocument; text: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const message = useCallback((error: unknown) => {
    const code = error instanceof ServerApiError ? error.code : error instanceof Error ? error.message : '';
    return Object.hasOwn(messages.mcp.errors, code ?? '')
      ? t(`mcp.errors.${code as keyof typeof messages.mcp.errors}`)
      : error instanceof Error ? error.message : t('mcp.errors.generic');
  }, [t]);

  useEffect(() => {
    let active = true, request = 0;
    const refresh = () => {
      const id = ++request;
      void readSystemDocument(MCP_PATH).then(file => {
        if (active && id === request) {
          setDocument(file);
          setEditor(current => current ?? { base: file, text: file.content });
        }
      }).catch(error => { if (active && id === request) setError(message(error)); });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    window.addEventListener('system-files-changed', refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('system-files-changed', refresh); };
  }, [message]);

  const save = async () => {
    if (!editor) return;
    setBusy(true); setError('');
    try {
      await saveSystemMarkdown(systemMaterialId(MCP_PATH)!, editor.text, editor.base.content, false, editor.base.revision);
      const saved = await readSystemDocument(MCP_PATH);
      setDocument(saved); setEditor({ base: saved, text: saved.content });
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  const reload = async () => {
    setBusy(true); setError('');
    try {
      const latest = await readSystemDocument(MCP_PATH);
      setDocument(latest); setEditor({ base: latest, text: latest.content });
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  const conflict = editor && document && editor.base.revision !== document.revision;
  return <section className="flex flex-col gap-4 p-4 overflow-auto h-full" data-testid="mcp-config-reader">
    <header>
      <div><h2 className="font-semibold">mcp.json</h2><p className="text-sm text-muted">{MCP_PATH}{document ? ` · r${document.revision}` : ''}</p></div>
    </header>
    <p className="text-sm text-muted">{t('mcp.fileHint')}</p>
    {error ? <p role="alert" className="text-danger" data-testid="mcp-json-error">{error}</p> : null}
    {editor ? <>
      <p className="text-sm text-muted">{t('mcp.jsonHint')}</p>
      <TextArea aria-label={t('mcp.jsonEditor')} data-testid="mcp-json-editor" className="w-full min-h-80 font-mono text-sm" rows={20} spellCheck={false} value={editor.text} disabled={busy} onChange={event => { setEditor({ ...editor, text: event.target.value }); setError(''); }} />
      {conflict ? <p role="status" className="text-warning">{t('mcp.fileConflict')}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button isDisabled={busy || editor.text === editor.base.content} onPress={() => void save()} data-testid="mcp-json-save">{t('mcp.save')}</Button>
        <Button variant="tertiary" isDisabled={busy || !document} onPress={() => void reload()}>{t('mcp.reloadFile')}</Button>
      </div>
    </> : <p role="status">{t('mcp.loading')}</p>}
  </section>;
}
