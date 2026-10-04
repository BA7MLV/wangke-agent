import { useLayoutEffect, useRef } from 'react';

/**
 * 流式 SVG 画布：**只追加，不重建**。
 *
 * 为什么不用 `dangerouslySetInnerHTML` 每拍重画一遍：
 * 那样每次新内容到达都会把所有节点换掉，于是「落画」动画对**整张图**重播一遍 ——
 * 用户看到的是画面反复闪着重画，而不是笔在往前走。这里保留同一个根 `<svg>`，
 * 只把新写完的那几个元素 append 进去，所以每个元素的动画恰好跑一次。
 *
 * 元素打 class 的时机在插入**之后**：此刻它们已经是真节点，`getAttribute` / `classList`
 * 都可用，不必用正则去改字符串（`d="…"` 里有 `>`、属性值里有引号，正则改标记迟早出事）。
 * 打出来的 class 与 `mermaid.css` 里的 `@keyframes` 一一对应。
 */

/** 有描边的图元：让描边「走」一遍，才是那道一笔画出来的感觉 */
const STROKE_TAGS = new Set(['path', 'line', 'polyline', 'polygon', 'circle', 'ellipse', 'rect']);
/** 这些容器里的东西是「定义」而不是「画出来的图形」，不该参与落画动画（marker 里的箭头尤其明显） */
const DEF_TAGS = new Set([
  'defs', 'symbol', 'marker', 'pattern', 'clipPath', 'mask', 'linearGradient', 'radialGradient',
]);

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

/**
 * 给刚插入的那批节点打落画动画的 class。
 *
 * @param order 这一批里的序号（顶层元素按文档顺序到齐，也就是笔顺）
 */
function markShapes(top: Element, order: number): void {
  // 只写**序数**，错开的时间步长在 CSS 里用动效令牌算（--xmd-draw-order → --xmd-draw-delay）。
  // 延迟挂在顶层节点上：自定义属性会继承，同一个 <g> 里的图元一起动比逐个错开更连贯。
  if (top instanceof SVGElement) top.style.setProperty('--xmd-draw-order', String(order));

  const walk = (el: Element) => {
    const tag = el.tagName;
    if (DEF_TAGS.has(tag)) return;
    if (STROKE_TAGS.has(tag)) {
      if (canTraceStroke(el)) {
        // pathLength=1：让「全长」等于 1 个用户单位，于是 dasharray / dashoffset 都能写成常数 1。
        // 不用 getTotalLength() —— 那要求路径已在文档里且 d 合法，半截图元上会直接抛。
        el.setAttribute('pathLength', '1');
        el.classList.add('xmd-svg-stroke');
      }
      if (hasFill(tag, el)) el.classList.add('xmd-svg-fill');
    } else if (tag === 'text' || tag === 'tspan') {
      if (!hasOwnOpacity(el)) el.classList.add('xmd-svg-fade');
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(top);
}

/**
 * 这条描边能不能「走」一遍。
 *
 * 两个让路的条件：元素自带 `stroke-dasharray`（那是虚线图案，一笔抹掉就毁了）、
 * 或者自带 `pathLength`（那它对虚线间距是有意义的，不能覆盖成 1）。
 */
function canTraceStroke(el: Element): boolean {
  const stroke = el.getAttribute('stroke');
  if (!stroke || stroke === 'none') return false;
  return !el.hasAttribute('stroke-dasharray') && !el.hasAttribute('pathLength');
}

/**
 * 这个图元有没有实心填充。
 *
 * 两层判据：先看**能不能**被填充（`line` / `polyline` 只有描边，缺省 fill 对它们无意义 ——
 * 判成「有填充」会给它们挂上淡入动画，白挂），再看**实际上**填不填：
 * SVG 缺省的 fill 是黑（不是 `none`），所以没写 `fill` 属性的实心图元照样要淡入。
 */
function hasFill(tag: string, el: Element): boolean {
  if (tag === 'line' || tag === 'polyline') return false;
  const fill = el.getAttribute('fill');
  return fill === null || (fill !== 'none' && fill !== 'transparent');
}

/**
 * 元素自带透明度时**不接管**它的淡入。
 *
 * 淡入动画带 `fill-mode: forwards`，结束值会一直压在内联样式之上 ——
 * 一个 `opacity="0.4"` 的图元会被动画顶成全不透明。这是「顺手加的动效」改坏了原图的那种坑。
 */
function hasOwnOpacity(el: Element): boolean {
  return el.hasAttribute('opacity') || /opacity/.test(el.getAttribute('style') ?? '');
}

/** 用户在系统里关了动效：那就不画过程，直接落定 */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
