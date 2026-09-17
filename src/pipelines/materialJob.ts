import { useJobStore } from '../store/jobs';
import { getSettings } from '../store/settings';
import { formatCaughtError } from '../utils/errorText';
import { parseMaterial, type MaterialFormat } from '../materials/parse';
import { ensureMaterialIndex } from './embedMaterial';

/**
 * 材料的「解析 → 建索引」任务。
 *
 * 一趟跑完两件事，但**进度分两段**（`parse` / `index`）：解析是本地的、几十秒；
 * 建索引要打 API、按块数计费。混成一段会让「卡在 40% 很久」看起来像卡死。
 *
 * 放在 job store 里（而不是组件 state）的理由与转写一致：用户导入一份 300 页 PDF
 * 之后通常就切走了，回来时希望看到「已经解析好了」而不是「进度没了、也不知道成没成」。
 */

/** 同一份材料同时只跑一次（库页与阅读器都可能触发重解析） */
const running = new Set<string>();

export function isMaterialJobRunning(id: string): boolean {
  return running.has(id);
}

export interface MaterialJobResult {
  parsed: number;
  scanned: boolean;
  empty: boolean;
  indexed: boolean;
}

/**
 * 跑解析 + 建索引。
 *
 * 没有 API Key 时**只解析不建索引**：材料照样能打开、能划词提问，
 * 只是语义检索不可用（问答面板会给出「索引尚未就绪」的提示）。
 * 反过来把整件事因为没 Key 就失败掉是错的设计 —— 阅读本身不需要联网。
 */
export async function startMaterialJob(
  materialId: string,
  format: MaterialFormat,
  opts: { index?: boolean } = {},
): Promise<MaterialJobResult> {
  if (running.has(materialId)) return { parsed: 0, scanned: false, empty: false, indexed: false };
  running.add(materialId);
  const { upsert } = useJobStore.getState();
  try {
    upsert(materialId, {
      phase: 'parse',
      message: '正在解析材料…',
      done: 0,
      total: 1,
      resume: false,
      error: undefined,
    });
    const res = await parseMaterial(materialId, format, (p) => {
      upsert(materialId, { phase: 'parse', message: p.message, done: p.done, total: p.total });
    });

    if (res.scanned || res.empty) {
      // 两种情况都「解析成功但没有可检索文本」。标记为 done 而不是 error ——
      // 扫描件确实能用（划词/框选），空文档只是没内容可问。
      // 话术必须分开：把空 Word 说成「扫描件」是错话（见 chunk.ts 的 judgeMaterialText）。
      upsert(materialId, {
        phase: 'done',
        message: res.scanned
          ? '没有文本层（扫描件），只能划词/框选提问'
          : '这份材料没有正文，无法参与问答检索',
        done: 1,
        total: 1,
      });
      return { parsed: res.blockCount, scanned: res.scanned, empty: res.empty, indexed: false };
    }

    let indexed = false;
    if (opts.index !== false && getSettings().apiKey) {
      upsert(materialId, {
        phase: 'index',
        message: '建立问答索引…',
        done: 0,
        total: res.blockCount,
      });
      await ensureMaterialIndex(materialId, (p) => {
        upsert(materialId, { phase: 'index', message: p.message, done: p.done, total: p.total });
      });
      indexed = true;
    }

    upsert(materialId, { phase: 'done', message: '', done: 1, total: 1 });
    return { parsed: res.blockCount, scanned: false, empty: false, indexed };
  } catch (e) {
    upsert(materialId, {
      phase: 'error',
      message: '材料解析失败',
      error: formatCaughtError(e),
      done: 0,
      total: 0,
    });
    throw e;
  } finally {
    running.delete(materialId);
  }
}
