import { chatOnce, textOf } from '../api/modelClient';
import type { ModelTarget } from '../store/settings';
import { PROMPTS } from '../harness/prompts';
import { parseRewrittenBlock, type Block } from './ir';

export interface RewriteContext { title: string; heading?: string; prev?: string; next?: string }
const labels: Record<Block['type'], string> = {
  lead: '主旨段', para: '正文段落', h2: '小节标题（名词性短语，不带编号）',
  list: '列表（保持 items 数组结构）', table: '三线表', figure: '图注', note: '提示段',
};

export async function rewriteBlock(
  target: ModelTarget, original: Block, instruction: string, context: RewriteContext,
  signal?: AbortSignal, fetcher?: typeof fetch,
): Promise<Block> {
  const extraRule = original.type === 'table'
    ? `表头列数（${original.header.length} 列）与数据行数（${original.rows.length} 行）必须保持不变，只能修改文字。`
    : original.type === 'figure' ? '只修改 caption 图注文字。' : undefined;
  const value = original.type === 'figure' ? { caption: original.caption ?? '' } : original;
  const prompt = PROMPTS.rewriteBlock(JSON.stringify(value), labels[original.type], instruction, { ...context, extraRule });
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    try {
      const message = await chatOnce(target, { max_tokens: 2000, messages: [{ role: 'user', content: prompt }], signal }, fetcher);
      return parseRewrittenBlock(textOf(message), original);
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
      if ([400, 401, 403].includes((error as { status: number }).status)) throw error;
      if (!attempt) await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
