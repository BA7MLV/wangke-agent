import { create } from 'zustand';
import { db } from '../store/db';
import type { FolderPlan } from '../harness/folderPlan';

/**
 * 课程库数据变更信号。
 *
 * 只解决一件事：**助手在别的页面改了 folders / folderId，课程库要立刻看到归位结果。**
 * 不用 Dexie `liveQuery` —— 那会让整页所有查询都变成活的，而写操作是一次性的；
 * 也不靠「重进页面自然重读」（用户在库页时助手在聊天页整理完，回库页若已挂载就什么都不会变）。
 *
 * 只存一个计数器：订阅方只需要知道「变了，重新 load」，不需要知道变了什么。
 */
interface LibraryRevisionStore {
  revision: number;
  bump: () => void;
}

export const useLibraryRevision = create<LibraryRevisionStore>()((set) => ({
  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

export interface AppliedPlanResult {
  /** 实际建立的新文件夹名（库里已有的同名分类被复用，不算在内） */
  createdFolders: string[];
  /** 实际移动成功的课程数 */
  moved: number;
  /** 被丢弃的课程：id 在库里不存在（模型编的）或已被删除 */
  missing: string[];
  /** 各分类最终落到的文件夹名（用于回给模型确认结果） */
  perFolder: { name: string; count: number }[];
}

/**
 * 落库一份目录整理方案。
 *
 * 三个必须钉住的行为：
 * 1. **同名分类复用**：库里已有「数学」就不再建「数学」，否则模型每整理一轮就会多出一堆
 *    「数学（2）」——这是这类功能最典型的退化方式。
 * 2. **未知 id 丢弃并回报**：模型编出来的 courseId 不能写进库（会造出指向空气的分类），
 *    但必须把丢弃清单告诉模型，否则它下一轮还会写同样的假 id。
 * 3. **整体一个事务**：建目录与改 folderId 要么都成要么都不成。中间失败会留下「有目录、
 *    课程没进去」的空壳，而用户看不出是哪一步坏了。
 */
export async function applyFolderPlan(plan: FolderPlan): Promise<AppliedPlanResult> {
  const result: AppliedPlanResult = { createdFolders: [], moved: 0, missing: [], perFolder: [] };

  await db.transaction('rw', [db.folders, db.videos], async () => {
    const folders = await db.folders.toArray();
    const byName = new Map(folders.map((f) => [f.name, f.id!]));
    const videos = await db.videos.toArray();
    const knownIds = new Set(videos.map((v) => v.id));
    /** 本次要改的行：courseId → folderId（null = 移回未分类） */
    const moves = new Map<string, number | null>();
    const dropped = new Set<string>();

    for (const entry of plan.folders) {
      // 空分类不建目录：模型列了一个「以后放这类」的空壳时，落库后它在库页就是一个
      // 永远为空的分组，还得用户自己去删。不如不建。
      if (entry.courseIds.length === 0) continue;
      let folderId = byName.get(entry.name);
      if (folderId == null) {
        folderId = (await db.folders.add({ name: entry.name, createdAt: Date.now() })) as number;
        byName.set(entry.name, folderId);
        result.createdFolders.push(entry.name);
      }
      let count = 0;
      for (const courseId of entry.courseIds) {
        if (!knownIds.has(courseId)) {
          dropped.add(courseId);
          continue;
        }
        // 同一门课被两个分类收走时以**后一个**为准：这份方案就是用户批准的那一份，
        // 不在这里做「先到先得」会让结果与卡片上看到的不一致。
        moves.set(courseId, folderId);
        count++;
      }
      result.perFolder.push({ name: entry.name, count });
    }
    result.missing = [...dropped];
    result.moved = moves.size;

    for (const [courseId, folderId] of moves) {
      // 移回未分类要**删字段**而不是写 undefined —— Library 的 setVideoFolder 是同一套做法，
      // 两处对「未分类」的定义必须一致（见 db.ts VideoRow.folderId 的注释）。
      await db.videos
        .where('id')
        .equals(courseId)
        .modify((row) => {
          if (folderId == null) delete row.folderId;
          else row.folderId = folderId;
        });
    }
  });

  useLibraryRevision.getState().bump();
  return result;
}

/** 整理方案的人类可读摘要（给工具结果与方案卡共用） */
export function formatPlanForModel(plan: FolderPlan, applied: AppliedPlanResult | null): string {
  if (!applied) {
    return plan.folders
      .map((e) => `- ${e.name}：${e.courseIds.length} 门`)
      .concat([`共 ${plan.folders.length} 个分类、${plan.folders.reduce((n, e) => n + e.courseIds.length, 0)} 门课程`])
      .join('\n');
  }
  const lines = applied.perFolder.map((p) => `- ${p.name}：实际归入 ${p.count} 门`);
  if (applied.createdFolders.length > 0) lines.push(`新建文件夹：${applied.createdFolders.join('、')}`);
  if (applied.missing.length > 0) {
    lines.push(`⚠️ 忽略了 ${applied.missing.length} 个课程库中不存在的 id：${applied.missing.join('、')}（不要再次使用它们）`);
  }
  lines.push(`合计移动 ${applied.moved} 门课程。`);
  return lines.join('\n');
}
