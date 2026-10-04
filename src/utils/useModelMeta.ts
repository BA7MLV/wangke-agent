import { useEffect, useState } from 'react';
import { subscribeModelMeta } from '../api/modelMeta';

/**
 * 元数据刷新回来时重渲染一次。
 *
 * 挂在**判断依赖元数据**的组件上（当前是课程助手与播放页问答的思考工具栏）：
 * 启动时会静默拉一次 models.dev，拉回来之前「有没有深度档位」只能按「不知道」处理，
 * 没有这条通知，控件就会一直停在拉取前的判断上（刷新成功但控件不出现）。
 *
 * 用法：`useModelMetaRevision()`，不用返回值 —— 它只负责触发重渲染。
 */
export function useModelMetaRevision(): void {
  const [, setTick] = useState(0);
  useEffect(() => subscribeModelMeta(() => setTick((n) => n + 1)), []);
}