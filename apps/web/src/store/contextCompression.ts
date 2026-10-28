import { create } from 'zustand';
import { prepareHistoryWithJev, type HistoryRow } from '../harness/jevContext';
import { estimateTokens, fitHistoryToBudget } from '../harness/context';
import type { JevSettings } from './settings';

interface ContextRow {
  id?: number;
  rowId?: number;
  role: string;
  content: string;
}

export interface CompressionState {
  phase: 'idle' | 'compressing' | 'success' | 'unchanged' | 'error';
  message: string;
  /** 行 ID + 原文校验：编辑/重试后内容不同则自动重新纳入，不误用旧筛选结果。 */
  omitted: ReadonlyMap<number, string>;
  attempt: string;
  revision: number;
}

export const EMPTY_COMPRESSION: CompressionState = {
  phase: 'idle', message: '', omitted: new Map(), attempt: '', revision: 0,
};

/** 仅缓存当前页面生命周期的发送计划；不持久化、不修改/同步聊天记录。 */
export const useContextCompressionStore = create<{ sessions: Record<number, CompressionState> }>(() => ({ sessions: {} }));
const pending = new Map<number, Promise<void>>();

function patch(sessionId: number, value: Partial<CompressionState>) {
  useContextCompressionStore.setState((state) => ({
    sessions: { ...state.sessions, [sessionId]: { ...(state.sessions[sessionId] ?? EMPTY_COMPRESSION), ...value } },
  }));
}

/** 与数据库行 / UI 行共用；最近两轮即使曾被筛掉也必须保留。 */
export function retainedContext<T extends ContextRow>(rows: T[], state = EMPTY_COMPRESSION): T[] {
  let protectedFrom = 0;
  let turns = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'user' && ++turns === 2) { protectedFrom = i; break; }
  }
  return rows.filter((row, i) => {
    const id = row.id ?? row.rowId;
    return i >= protectedFrom || id == null || state.omitted.get(id) !== row.content;
  });
}

/** 等待同会话的手动压缩时，发送按钮的停止仍能即时取消等待。 */
function waitFor(job: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return job;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    job.then(() => { cleanup(); resolve(); }, (error) => { cleanup(); reject(error); });
  });
}

/** 自动与手动共用，按会话串行；先套已压缩计划，再按本轮真实预算检查是否需要再压缩。 */
export async function prepareSessionHistory<T extends HistoryRow & ContextRow>(
  sessionId: number,
  rows: T[],
  budget: number,
  query: string,
  config: JevSettings,
  options: { signal?: AbortSignal; force?: boolean; onStart?: () => void; onCompressed?: (turns: number) => void } = {},
): Promise<T[]> {
  options.signal?.throwIfAborted();
  if (!config.contextCompression || !config.apiKey.trim()) return fitHistoryToBudget(rows, budget);
  while (pending.has(sessionId)) await waitFor(pending.get(sessionId)!, options.signal);
  options.signal?.throwIfAborted();
  const previous = useContextCompressionStore.getState().sessions[sessionId] ?? EMPTY_COMPRESSION;
  const effective = retainedContext(rows, previous);
  const tokens = effective.reduce((sum, row) => sum + estimateTokens(row.content), 0);
  // 同一份满载历史只自动尝试一次，避免失败/没有可省略项时 React effect 无限重试。
  const attempt = `${budget}:${effective.map((row) => `${row.id ?? row.rowId}:${row.content.length}`).join(',')}`;
  if (!options.force && (tokens < budget || previous.attempt === attempt)) return fitHistoryToBudget(effective, budget);

  let settle!: () => void;
  const job = new Promise<void>((resolve) => { settle = resolve; });
  pending.set(sessionId, job);
  const revision = previous.revision + 1;
  patch(sessionId, { phase: 'compressing', message: '正在压缩上下文…', revision, attempt });
  try {
    let failed = false;
    let started = false;
    let removed: T[] = [];
    const result = await prepareHistoryWithJev(effective, budget, query, config, {
      ...options,
      onStart: () => { started = true; options.onStart?.(); },
      onOmitted: (omitted) => { removed = omitted; },
      onError: (error) => {
        failed = true;
        patch(sessionId, { phase: 'error', message: `${error instanceof Error ? error.message : '压缩失败'}，已保留原上下文` });
      },
    });
    options.signal?.throwIfAborted();
    if (!failed) {
      const omitted = new Map(previous.omitted);
      let saved = 0;
      for (const row of removed) {
        const id = row.id ?? row.rowId;
        if (id == null) continue;
        omitted.set(id, row.content);
        saved += estimateTokens(row.content);
      }
      patch(sessionId, {
        omitted,
        phase: saved > 0 ? 'success' : 'unchanged',
        message: saved > 0
          ? `上下文已压缩，减少约 ${saved.toLocaleString()} tokens；聊天记录完整保留`
          : started ? '没有可安全省略的旧轮次，已保留上下文' : '暂无可压缩的旧轮次（最近两轮保留，过大内容跳过）',
      });
    }
    return result;
  } catch (error) {
    patch(sessionId, { phase: 'idle', message: '已取消压缩', attempt: '' });
    throw error;
  } finally {
    if (pending.get(sessionId) === job) pending.delete(sessionId);
    settle();
  }
}
