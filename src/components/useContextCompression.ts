import { useEffect, useRef } from 'react';
import { db } from '../store/db';
import { estimateTokens } from '../harness/context';
import { getSettings, useSettings } from '../store/settings';
import {
  EMPTY_COMPRESSION, prepareSessionHistory, retainedContext, useContextCompressionStore,
} from '../store/contextCompression';
import { toast } from '../ui';

/** 图标与发送管线共享状态/发送计划；不把可见消息列表当成压缩结果修改。 */
export function useContextCompression({ sessionId, tokens, windowTokens, query, busy }: {
  sessionId: number | null;
  tokens: number;
  windowTokens: number;
  query: string;
  busy: boolean;
}) {
  const state = useContextCompressionStore((s) => sessionId == null ? EMPTY_COMPRESSION : s.sessions[sessionId] ?? EMPTY_COMPRESSION);
  const config = useSettings((s) => s.jev);
  const controller = useRef<AbortController | null>(null);
  const locked = useRef(false);
  useEffect(() => () => { controller.current?.abort(); }, [sessionId]);

  const compress = async (force = true) => {
    if (busy || locked.current || sessionId == null || state.phase === 'compressing') return;
    const settings = getSettings();
    if (!settings.jev.contextCompression || !settings.jev.apiKey.trim()) {
      if (force) toast.info('请先在「设置 → 模型 → Jev」填写 Key 并启用上下文压缩');
      return;
    }
    locked.current = true;
    const abort = new AbortController();
    controller.current = abort;
    try {
      const rows = await db.chats.where('sessionId').equals(sessionId).sortBy('createdAt');
      abort.signal.throwIfAborted();
      const current = useContextCompressionStore.getState().sessions[sessionId] ?? EMPTY_COMPRESSION;
      const historyTokens = retainedContext(rows, current).reduce((sum, row) => sum + estimateTokens(row.content), 0);
      const fixedTokens = Math.max(0, tokens - historyTokens);
      const budget = Math.max(0, windowTokens - fixedTokens - 4096);
      await prepareSessionHistory(sessionId, rows, budget, query || '继续当前对话，保留仍适用的事实、约束与未完成任务。', settings.jev, { force, signal: abort.signal });
      if (force) {
        const result = useContextCompressionStore.getState().sessions[sessionId];
        if (result?.phase === 'error') toast.error(result.message);
        else if (result?.phase === 'unchanged') toast.info(result.message);
      }
    } catch (error) {
      if (!abort.signal.aborted) toast.error(error instanceof Error ? error.message : '上下文压缩失败');
    } finally {
      if (controller.current === abort) controller.current = null;
      locked.current = false;
    }
  };

  useEffect(() => {
    if (!busy && config.contextCompression && config.apiKey.trim() && tokens >= Math.max(0, windowTokens - 4096)) {
      void compress(false);
    }
    // compress 读取本次渲染的预算，状态结束/输入变化均可重新检查；manager 的 attempt 防止重复出网。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, tokens, windowTokens, busy, config, state.phase]);

  return { state, compress: () => void compress(true) };
}
