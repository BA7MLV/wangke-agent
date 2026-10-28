import { useEffect, useState } from 'react';
import { Button, Checkbox } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { listMcpServers } from './client';
import { cloud } from '../cloud/state';
import type { McpServer } from '@wangke/contracts/mcp';

export default function McpScope({ value, onChange }: { value?: string[]; onChange: (ids: string[] | undefined) => Promise<void> }) {
  const { t } = useTranslation('settings');
  const [servers, setServers] = useState<McpServer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!cloud.enabled) return;
    let cancelled = false;
    void listMcpServers().then(r => { if (!cancelled) setServers(r.servers.filter(s => s.enabled)); }).catch(() => { if (!cancelled) setError(t('mcp.errors.generic')); });
    return () => { cancelled = true; };
  }, [t]);
  const save = async (ids: string[] | undefined) => {
    setBusy(true); setError('');
    try { await onChange(ids); } catch { setError(t('mcp.errors.generic')); }
    finally { setBusy(false); }
  };
  if (!cloud.enabled || (!servers.length && !error && value === undefined)) return null;
  return <section className="flex flex-col gap-2 mt-4" aria-label={t('mcp.scope')}>
    <h3 className="font-semibold">{t('mcp.scope')}</h3>
    <p className="text-sm text-muted">{t('mcp.scopeHint')}</p>
    {servers.map(server => <Checkbox key={server.id} isDisabled={busy} isSelected={value === undefined || value.includes(server.id)} onChange={enabled => {
      const ids = new Set(value ?? servers.map(s => s.id));
      if (enabled) ids.add(server.id); else ids.delete(server.id);
      void save([...ids]);
    }}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control><span>{server.name}</span></Checkbox.Content></Checkbox>)}
    <p className="text-sm text-muted">{value === undefined ? t('mcp.inherited') : value.length === 0 ? t('mcp.scopeNone') : t('mcp.scopeSelected', { count: value.length })}</p>
    <div className="flex gap-2"><Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void save(undefined)}>{t('mcp.inherit')}</Button><Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void save([])}>{t('mcp.disableAll')}</Button></div>
    {error && <p role="alert" className="text-danger">{error}</p>}
  </section>;
}
