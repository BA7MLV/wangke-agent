import { useLayoutEffect, useRef } from 'react';
import { markShapes } from './drawMark';
import { prefersReducedMotion } from '../../utils/motion';
import type { DiagramShape } from './diagramSchema';

/**
 * ```diagram 围栏的流式画布：**按 key 只追加，不重建**。
 *
 * 与 LiveSvg（```svg 链路）的三点差别，全部来自「JSON 中间层」这个新媒介：
 *
 * 1. **单位是逻辑图元，不是源码片段**。`shapes` 里每一项是渲染器产出的一个
 *    节点 / 一条边 / 一条曲线，带着稳定 key（`node:a` / `edge:0` / `curve:1`）。
 *    半截 JSON 每多写完一个数组项，就多一个 key —— 增量单位从「字符」变成了
 *    「结构」，所以预览不会出现画到一半的路径。
 * 2. **已存在的 key 允许静默更新**。JSON 是流式变完整的：布局依赖全量数据
 *    （后来的宽节点会把列宽撑开、新边会把层号加深），先落位的节点因此可能挪位。
 *    更新走「整块替换、不打 class」—— 没有动画重播，也没有把预览画错。
 *    （LiveSvg 那边不需要更新：SVG 源码的坐标模型写完就定死了。）
 * 3. **viewBox 每拍跟拍**。graph 的畫布尺寸随内容增长，闭合前的终态由最后一拍
 *    收敛到完整渲染结果；svg 链路的 viewBox 在根标签闭合那一刻就定死了。
 *
 * 元素打 class 的时机在插入**之后**（此刻才是真节点），与 LiveSvg 同一套规则
 * （见 drawMark.ts）。更新路径刻意**不**打 class —— 打了就会让落画动画对
 * 已经画过的图元重播一遍。
 */
export default function DiagramCanvas({ viewBox, shapes }: { viewBox: string; shapes: DiagramShape[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<SVGElement | null>(null);
  /** key → 当前 DOM 节点。只增不删（除整体重置），key 的顺序由 shapes 数组决定 */
  const nodesRef = useRef(new Map<string, Element>());
  /** key → 已上屏的 svg 原文。内容没变就跳过替换，省掉无谓的 DOM churn */
  const shownRef = useRef(new Map<string, string>());

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // 根 <svg> 只在第一拍建：画布宽高比此后每拍更新（graph 会向上下/右长），
    // 但**节点不重建** —— 重建等于让整张图重画，正是要避免的那次闪烁。
    if (!rootRef.current) {
      host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"></svg>`;
      rootRef.current = host.querySelector('svg');
      if (!rootRef.current) return;
    }
    const root = rootRef.current;
    if (root.getAttribute('viewBox') !== viewBox) root.setAttribute('viewBox', viewBox);

    const nodes = nodesRef.current;
    const shown = shownRef.current;

    // key 集合缩小（半截数据被改写，正常流式里不会发生）：推倒重来，
    // 而不是留一张对不上的半张图。
    if (shapes.length < shown.size) {
      root.replaceChildren();
      nodes.clear();
      shown.clear();
    }

    const still = prefersReducedMotion();
    for (let i = 0; i < shapes.length; i++) {
      const { key, svg } = shapes[i];
      const prevShown = shown.get(key);
      if (prevShown === svg) continue; // 内容没变：DOM 原样保留
      const prevNode = nodes.get(key);

      // 插入必须在 <svg> 上下文里做：HTML 解析器只把 <svg> 子树里的元素放进
      // SVG 命名空间，插完再 replaceWith 到老节点的位置上，顺序不变。
      root.insertAdjacentHTML('beforeend', svg);
      const added = root.lastElementChild;
      if (!added) break;
      added.setAttribute('data-dkey', key);
      if (prevNode) {
        prevNode.replaceWith(added); // 静默更新：不带 class，不重播动画
      } else if (!still) {
        markShapes(added, i);
      }
      nodes.set(key, added);
      shown.set(key, svg);
    }

    // 出现在上一拍、这一拍没有的 key（理论上不会发生：完整值不会变回不完整）：
    // 摘掉对应节点，避免画布残留。
    for (const [key, node] of nodes) {
      if (!shapes.some((s) => s.key === key)) {
        node.remove();
        nodes.delete(key);
        shown.delete(key);
      }
    }
  });

  return <div ref={hostRef} className="xmd-live-svg" data-testid="diagram-canvas-root" />;
}
