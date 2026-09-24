import { useJobStore } from '../store/jobs';
import { formatCaughtError } from '../utils/errorText';
import { parseMaterial, type MaterialFormat } from '../materials/parse';

/**
 * 材料的解析任务。
 *
 * 2026-09-24：**原来还有第二段「建索引」**（把文本块向量化、打 embedding API、按块计费）。
 * 稠密检索移除后这一段整体消失，任务只剩解析一件事 —— 也因此不再需要 API Key：
 * 材料解析完就能检索（词法检索直接扫 `materialBlocks`）。
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
}

export async function startMaterialJob(
  materialId: string,
  format: MaterialFormat,
): Promise<MaterialJobResult> {
  if (running.has(materialId)) return { parsed: 0, scanned: false, empty: false };
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
      return { parsed: res.blockCount, scanned: res.scanned, empty: res.empty };
    }

    upsert(materialId, { phase: 'done', message: '', done: 1, total: 1 });
    return { parsed: res.blockCount, scanned: false, empty: false };
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
