import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import McpScope from './McpScope';
import { cloudRequest } from '../cloud/state';

export default function BotMcpScope({ threadId }: { threadId: string }) {
  const { t } = useTranslation('settings');
  const [scope, setScope] = useState<{ serverIds: string[] | null }>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void cloudRequest<{ serverIds: string[] | null }>('/mcp/scope', { method: 'POST', body: JSON.stringify({ threadId }) })
      .then(value => { if (!cancelled) setScope(value); }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [threadId]);
  if (error) return <p role="alert">{t('mcp.errors.generic')}</p>;
  if (!scope) return <p role="status">{t('mcp.loading')}</p>;
  return <McpScope value={scope.serverIds ?? undefined} onChange={async ids => {
    const saved = await cloudRequest<{ serverIds: string[] | null }>('/mcp/scope', { method: 'PUT', body: JSON.stringify({ threadId, serverIds: ids ?? null }) });
    setScope(saved);
  }} />;
}
