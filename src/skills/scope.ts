/**
 * 会话技能范围的三态判定与求交。
 *
 * ## 为什么单独拆一个零依赖模块
 *
 * 下面这三条是「限定技能」语义的**唯一真相**，而且恰好全是本功能最容易写错的地方：
 * `[]` 与 `undefined` 混淆、白名单与启用状态取交集、工具层放行条件。
 * 放在这里不 import 任何东西，Node 就能直接 `import '../src/skills/scope.ts'` 跑单测；
 * 塞在 `skills/store.ts` 里则要连带 Dexie 和内置 skill 的 `?raw` 资源一起打包，测不动。
 *
 * 三态约定（与 `ChatSessionRow.skillIds` 一致）：
 * - `undefined` = **不限定**，全部启用技能可用（默认态、老数据）
 * - `[]`        = **限定**，且一个技能都不给
 * - `[id, ...]` = **限定**为该集合
 */

/**
 * 是否处于「限定」模式。
 *
 * **只看 `undefined`，不看长度**：`[]` 是合法的「限定为空集」。用 `ids?.length` 判断
 * 会把 `[]` 和 `undefined` 混为一谈，于是「用户明确禁用了全部技能」静默退化成
 * 「全部技能可用」—— 正是这个项目最忌讳的那类静默错账。
 */
export function isSkillLimited(ids?: number[]): ids is number[] {
  return ids !== undefined;
}

/**
 * 白名单 × 启用集合 = 实际可用技能。
 *
 * 保持 `enabledIds` 的原有顺序（调用方依赖它做稳定展示）。
 * 不限定模式下**原样返回入参数组**（不复制）—— 调用方只读，不要改写返回值。
 */
export function intersectSkillIds(enabledIds: number[], allow?: number[]): number[] {
  if (!isSkillLimited(allow)) return enabledIds;
  const set = new Set(allow);
  return enabledIds.filter((id) => set.has(id));
}

/**
 * 单个技能是否在可选范围内（工具层放行条件）。
 *
 * ⚠️ 放行判断写的是 `allow === undefined`，**不是** `!allow?.length` ——
 * 后者会让「限定为空集」退化成「不限制」，模型于是仍能加载任意技能，
 * 白名单形同虚设。这个分支由 `test-qa-skill-scope.mjs` 专门盯着。
 */
export function isSkillAllowed(id: number | undefined, allow?: number[]): boolean {
  if (!isSkillLimited(allow)) return true;
  return id != null && allow.includes(id);
}
