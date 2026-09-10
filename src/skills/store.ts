import { db, type SkillRow } from '../store/db';
import { BUILTIN_SKILLS } from './builtin';
import { parseSkillMarkdown } from './types';
import { parseSkillZip, type ParsedSkillPackage } from './zip';

/** 注入提示词的 skill 正文总预算（字符） */
const SKILL_BLOCK_BUDGET = 6000;

/** Level 1：技能元数据（常驻上下文，name + description） */
export interface SkillMeta {
  id: number;
  name: string;
  description: string;
}

/**
 * 进行中的「补齐内置 skill」任务（并发闸门）。
 *
 * 为什么必须有：本函数是「先按名查、查不到就插」，而调用点有好几个且互不感知
 * （设置页 SkillsCard 的 effect、HandoutPanel、ChatPanel、skills/router）。
 * React StrictMode 在 dev 下会把 effect 跑两次，于是两个调用并发进入循环、
 * **都在任何一次插入落库之前查完**，6 个内置技能被插成 12 行
 * （实测：dev 12 行 / 生产构建 6 行；生产不触发 StrictMode 双调用所以看不出来）。
 *
 * 用模块级 in-flight promise 把并发调用收敛成同一次执行；完成后清空，
 * 这样用户删掉内置技能后再次调用仍会重新补齐。
 */
let builtinInflight: Promise<void> | null = null;

/** 首次启动写入 + 版本升级：内置 skill 在 UI 中只读（编辑存为副本、可重置），
 *  因此按名 upsert——同名内置行直接升级为最新内容，用户副本不受影响；references 同步落库。 */
export function ensureBuiltinSkills(): Promise<void> {
  builtinInflight ??= doEnsureBuiltinSkills().finally(() => {
    builtinInflight = null;
  });
  return builtinInflight;
}

async function doEnsureBuiltinSkills(): Promise<void> {
  const now = Date.now();
  // 整体放进一个 rw 事务：IndexedDB 会把同库的 rw 事务串行化，
  // 于是「查—插」不会被另一个并发调用穿插（上面的闸门管同页并发，这层管跨调用/跨标签页）。
  await db.transaction('rw', [db.skills, db.skillRefs], async () => {
    for (const s of BUILTIN_SKILLS) {
      let row = await db.skills.filter((r) => r.name === s.name && !!r.builtin).first();
      if (row?.id != null) {
        if (row.body !== s.body || row.description !== s.description) {
          await db.skills.update(row.id, {
            description: s.description,
            body: s.body,
            updatedAt: now,
          });
        }
      } else {
        const id = (await db.skills.add({
          name: s.name,
          description: s.description,
          body: s.body,
          enabled: 1,
          builtin: 1,
          updatedAt: now,
        })) as number;
        row = { id } as SkillRow;
      }
      for (const r of s.refs ?? []) {
        const exist = await db.skillRefs
          .where('skillId')
          .equals(row.id!)
          .filter((x) => x.path === r.path)
          .first();
        if (exist?.id != null) {
          if (exist.body !== r.body) await db.skillRefs.update(exist.id, { body: r.body });
        } else {
          await db.skillRefs.add({ skillId: row.id!, path: r.path, body: r.body });
        }
      }
    }
  });
}

/** Level 1：加载所有启用中技能的元数据（供路由器 / 问答 agent 发现技能） */
export async function loadEnabledSkillMeta(): Promise<SkillMeta[]> {
  await ensureBuiltinSkills();
  const skills = await db.skills.filter((s) => !!s.enabled).sortBy('id');
  return skills.map((s) => ({ id: s.id!, name: s.name, description: s.description }));
}

/** Level 2：按 id 加载技能正文并拼接（带总预算截断） */
export async function loadSkillBodies(ids: number[]): Promise<string> {
  if (ids.length === 0) return '';
  const rows = await db.skills.where('id').anyOf(ids).toArray();
  return rows
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
    .map((s) => s.body.trim())
    .filter(Boolean)
    .join('\n\n---\n\n')
    .slice(0, SKILL_BLOCK_BUDGET);
}

/** 元数据列表 → 提示词用的清单文本 */
export function skillMetaBlock(metas: SkillMeta[]): string {
  return metas.map((m) => `- ${m.name}：${m.description || '（无描述）'}`).join('\n');
}

/** 导入 .md 单文件或 skill zip 包（含 references/），落库并默认启用 */
export async function importSkillFile(file: File): Promise<{ name: string; refCount: number }> {
  let pkg: ParsedSkillPackage;
  if (/\.zip$/i.test(file.name)) {
    pkg = parseSkillZip(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.zip$/i, ''));
  } else {
    pkg = {
      skill: parseSkillMarkdown(file.name, await file.text()),
      refs: [],
    };
    if (!pkg.skill.body) throw new Error('正文为空');
  }

  const skillId = await db.transaction('rw', [db.skills, db.skillRefs], async () => {
    const id = (await db.skills.add({
      ...pkg.skill,
      enabled: 1,
      builtin: 0,
      updatedAt: Date.now(),
    })) as number;
    if (pkg.refs.length > 0) {
      await db.skillRefs.bulkAdd(pkg.refs.map((r) => ({ skillId: id, path: r.path, body: r.body })));
    }
    return id;
  });
  void skillId;
  return { name: pkg.skill.name, refCount: pkg.refs.length };
}
