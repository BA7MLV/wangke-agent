/**
 * 目录整理方案的数据结构 + 校验。纯模块无运行时依赖，Node 下可直接单测。
 *
 * **落库不在这里**（那是 `pipelines/folderPlan.ts` 的事，且必须等用户点确认才跑）——
 * 这个模块只回答一个问题：模型给的这份方案，结构上能不能执行。
 *
 * 设计见 docs/plans/2026-09-28-course-chat-generative-ui-design.md §5。
 */

export interface FolderPlanEntry {
  /** 目标分类名。库里有同名分类就并进去，不新建 */
  name: string;
  /** 要移入的课程 id（来自 list_courses / list_folders 的真实 id） */
  courseIds: string[];
}

export interface FolderPlan {
  /** 一句话说明这次的整理思路（展示在卡片顶部，也是模型自己的推理摘要） */
  summary: string;
  folders: FolderPlanEntry[];
}

export type FolderPlanValidation = { ok: true; plan: FolderPlan } | { ok: false; error: string };

/** 单次整理的分类数上限。只有 1 条也算「整理」（把散在未分类里的归到一处是真实需求），但 12 条以上用户自己都记不住 */
export const MIN_PLAN_FOLDERS = 1;
export const MAX_PLAN_FOLDERS = 12;
/** 单个分类名的字数上限 */
const MAX_NAME_CHARS = 24;
/** 单个分类一次最多归入的课程数：库大到一次几百门时，应该让模型分批并说明，而不是糊一张长卡 */
const MAX_COURSES_PER_FOLDER = 60;

/**
 * 校验并清洗模型输出的整理方案。
 *
 * ⚠️ **课程 id 的存在性不在这里判** —— 这个模块是纯逻辑、不碰 db。未知 id 会在
 * `pipelines/folderPlan.ts::applyFolderPlan` 里被丢弃，并把丢弃清单回给模型
 * （模型需要知道自己写的哪几个 id 是编的，否则下一轮还会重犯）。
 */
export function validateFolderPlan(raw: unknown): FolderPlanValidation {
  const plan = (raw as Partial<FolderPlan> | null) ?? {};

  const summary = typeof plan.summary === 'string' ? plan.summary.trim() : '';
  if (!summary) return { ok: false, error: 'summary（整理思路）不能为空' };
  if (summary.length > 300) return { ok: false, error: 'summary 超过 300 字，请压缩成一句话' };

  if (!Array.isArray(plan.folders)) return { ok: false, error: 'folders 必须是数组' };
  if (plan.folders.length < MIN_PLAN_FOLDERS || plan.folders.length > MAX_PLAN_FOLDERS) {
    return {
      ok: false,
      error: `folders 必须有 ${MIN_PLAN_FOLDERS}~${MAX_PLAN_FOLDERS} 个分类（收到 ${plan.folders.length} 个）`,
    };
  }

  const folders: FolderPlanEntry[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < plan.folders.length; i++) {
    const e = plan.folders[i] as Partial<FolderPlanEntry> | null;
    const where = `第 ${i + 1} 个分类`;

    const name = typeof e?.name === 'string' ? e.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) return { ok: false, error: `${where}：name（分类名）不能为空` };
    if (name.length > MAX_NAME_CHARS) return { ok: false, error: `${where}：name 超过 ${MAX_NAME_CHARS} 字` };
    // 同名分类项直接合并，而不是报错：模型分两批列同一个分类是常见写法，合并比让它重试一轮划算
    if (seenNames.has(name)) {
      const prev = folders.find((x) => x.name === name)!;
      for (const id of normalizeIds(e?.courseIds)) {
        if (!prev.courseIds.includes(id)) prev.courseIds.push(id);
      }
      continue;
    }
    seenNames.add(name);
    folders.push({ name, courseIds: normalizeIds(e?.courseIds) });
  }

  const over = folders.find((e) => e.courseIds.length > MAX_COURSES_PER_FOLDER);
  if (over) {
    return {
      ok: false,
      error: `分类「${over.name}」一次归入 ${over.courseIds.length} 门课程，超过 ${MAX_COURSES_PER_FOLDER} 门；请分批整理`,
    };
  }

  return { ok: true, plan: { summary, folders } };
}

function normalizeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}
