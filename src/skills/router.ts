import { chatOnce, textOf } from '../api/siliconflow';
import { getSettings } from '../store/settings';
import { db } from '../store/db';
import { PROMPTS } from '../harness/prompts';
import { loadEnabledSkillMeta, loadSkillBodies, skillMetaBlock, type SkillMeta } from './store';

export interface RoutedSkills {
  /** 最终选用的技能（路由结果 + 手动覆盖） */
  selected: SkillMeta[];
  /** 拼接后的注入文本 */
  block: string;
}

/** 从路由输出中稳健提取技能名称列表 */
function parseRoutedNames(text: string): string[] {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as { skills?: unknown };
    return Array.isArray(obj.skills) ? obj.skills.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 讲义技能路由（渐进式披露 Level 1 → 2）：
 * 元数据进路由调用 → 只加载选中技能的正文；再叠加视频级手动覆盖（pin 必用 / drop 排除）。
 * 路由调用失败时兜底为全部启用（退化为旧行为），不阻塞讲义生成。
 */
export async function routeHandoutSkills(
  videoId: string,
  videoName: string,
  sample: string,
): Promise<RoutedSkills> {
  const metas = await loadEnabledSkillMeta();
  if (metas.length === 0) return { selected: [], block: '' };

  let autoIds: Set<number>;
  try {
    const settings = getSettings();
    const msg = await chatOnce(settings, {
      model: settings.llmModel,
      max_tokens: 300,
      messages: [{ role: 'user', content: PROMPTS.routeSkills(videoName, sample, skillMetaBlock(metas)) }],
    });
    const names = new Set(parseRoutedNames(textOf(msg)));
    autoIds = new Set(metas.filter((m) => names.has(m.name)).map((m) => m.id));
  } catch {
    autoIds = new Set(metas.map((m) => m.id));
  }

  const override = (await db.videos.get(videoId))?.skillOverride;
  for (const id of override?.pin ?? []) autoIds.add(id);
  for (const id of override?.drop ?? []) autoIds.delete(id);

  const selected = metas.filter((m) => autoIds.has(m.id));
  const block = await loadSkillBodies(selected.map((s) => s.id));
  return { selected, block };
}
