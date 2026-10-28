import type { ModelSlot } from '../../store/settings';

/**
 * 设置各模块共用的常量与工具。
 *
 * 为什么单独一个文件：这些值同时被「模型」和「数据迁移」两个模块用到
 * （删供应商时要清理三个槽位与收藏项），放在任一模块文件里都会形成反向依赖。
 */

/** 槽位全集：勾选能力、下拉候选、遍历都用它，避免多处各写一份字面量而漏一项 */
export const ALL_SLOTS: readonly ModelSlot[] = ['asr', 'chat', 'vision', 'decision'];

export type ModelFieldName = 'asrModel' | 'llmModel' | 'visionModel' | 'decisionModel';

/** 收藏夹一项在 UI 里的唯一键（供应商 + 模型） */
export const refKey = (r: { providerId: string; model: string }) => `${r.providerId}\0${r.model}`;
