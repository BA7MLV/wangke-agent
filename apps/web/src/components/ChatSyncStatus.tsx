import { useEffect, useState } from 'react';
import { useCourseChat, retryChatSync } from '../store/courseChat';
import { useCloudSync } from '../cloud/sync';

/** Normal sync is silent. Slow/failed sync is recoverable without hiding content. */
export default function ChatSyncStatus() {
  const id = useCourseChat(state => state.activeId);
  const pending = useCourseChat(state => state.messages.some(message => message.syncPending && !message.streaming && message.role === 'ai' && !message.interrupted));
  const historyError = useCourseChat(state => state.historyError);
  const syncError = useCloudSync(state => state.error);
  const [slow, setSlow] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  useEffect(() => {
    setSlow(false);
    setRetryError('');
    if (!pending) return;
    const timer = setTimeout(() => setSlow(true), 2000);
    return () => clearTimeout(timer);
  }, [id, pending]);
  const error = historyError || syncError || retryError;
  if (id == null || !pending || !slow && !error) return null;
  return <div className="course-chat__sync-status" role="status" data-testid="chat-sync-status">
    <span>{error ? '同步暂未完成，当前回答已保留' : '回答已完成，正在同步到本机…'}</span>
    {error && <button type="button" disabled={retrying} onClick={async () => {
      setRetrying(true);
      setRetryError('');
      try { await retryChatSync(id); }
      catch (error) { setRetryError(error instanceof Error ? error.message : String(error)); }
      finally { setRetrying(false); }
    }}>{retrying ? '重试中…' : '重试同步'}</button>}
  </div>;
}
