import { useLayoutEffect, useRef } from 'react';
import { markShapes } from './drawMark';
import { prefersReducedMotion } from '../../utils/motion';

/**
 * 流式 SVG 画布（```svg 链路用）：**只追加，不重建**。
 *
 * 为什么不用 `dangerouslySetInnerHTML` 每拍重画一遍：
 * 那样每次新内容到达都会把所有节点换掉，于是「落画」动画对**整张图**重播一遍 ——
 * 用户看到的是画面反复闪着重画，而不是笔在往前走。这里保留同一个根 `<svg>`，
 * 只把新写完的那几个元素 append 进去，所以每个元素的动画恰好跑一次。
 *
 * ```diagram 链路不走这里：那边按 key 增量（见 DiagramCanvas），因为 JSON 的布局
 * 依赖全量数据、先落位的图元可能挪位。SVG 源码的坐标写完就定死了，没有这个问题。
 *
 * 打标规则与两条链路共用（drawMark.ts）—— 抽出去的理由写在那。
 */

/** 打标在插入**之后**做：此刻它们已经是真节点，getAttribute / classList 都可用 */
export default function LiveSvg({ rootAttrs, elements }: { rootAttrs: string; elements: string[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<SVGElement | null>(null);
  const drawnRef = useRef(0);

  // ⚠️ 必须是 **useLayoutEffect**，不是 useEffect：
  // 根 <svg> 是在这里建出来的，而它带着 viewBox —— 也就是画布的宽高比。
  // 放进 useEffect 的话第一帧画出来的是个空 div（整块塌成一行提示的高度），
  // 下一帧才补出画布，于是整块图形会先抖一下再落位。同步阶段建好，首帧就是对的。
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // 根标签只在第一拍建：它的属性在标签闭合那一刻就定死了，之后不会再变。
    // rootAttrs 已经过 svgRender 的白名单净化（见 peekSvgProgress）。
    if (!rootRef.current) {
      host.innerHTML = `<svg ${rootAttrs}></svg>`;
      rootRef.current = host.querySelector('svg');
      if (!rootRef.current) return;
    }
    const root = rootRef.current;

    // 兜底：元素数不增反减说明内容被改写过（正常流式里不会发生）。
    // 此时推倒重来，而不是留一张对不上的半张图。
    if (elements.length < drawnRef.current) {
      root.replaceChildren();
      drawnRef.current = 0;
    }

    const still = prefersReducedMotion();
    for (let i = drawnRef.current; i < elements.length; i++) {
      const before = root.childElementCount;
      // 片段已净化，且解析上下文是 <svg>，所以子元素落在 SVG 命名空间里
      root.insertAdjacentHTML('beforeend', elements[i]);
      if (still) continue;
      for (let k = before; k < root.childElementCount; k++) {
        markShapes(root.children[k], i - drawnRef.current);
      }
    }
    drawnRef.current = elements.length;
  });

  return <div ref={hostRef} className="xmd-live-svg" data-testid="live-svg" />;
}
