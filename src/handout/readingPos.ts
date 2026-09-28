/**
 * 讲义阅读位置的记与取（DOM 层，纯函数）。
 *
 * ## 为什么记「锚点 + 偏移」而不是 scrollTop
 *
 * 讲义的高度不是常量：视口宽度、图片 blob 解码、预览字体加载都会改它。同一份讲义在
 * 手机和桌面上，同一个 `scrollTop` 落在完全不同的一段上。所以位置必须锚在**内容元素**
 * 上（块序号），偏移只做「同一块内读到了哪个像素」的微调。
 *
 * 代价是内容改动后锚点可能失效（用户 AI 改写了前面的块，后面块序号就移位了）。那时的
 * 行为是**落空回顶部**而不是落到某个相近但错位的位置 —— 前者用户能自己滚，后者会
 * 让「记住阅读位置」变成「随机把人扔到某处」。
 *
 * 落库字段见 `HandoutRow.readPos`，设计见
 * docs/plans/2026-09-28-course-chat-generative-ui-design.md §3。
 */

export interface HandoutReadPos {
  /** 块锚点，与 HandoutDocView 里 `keyOf(target)` 同形：`sum` / `h{sec}` / `s{sec}b{idx}` */
  anchor: string;
  /** 该锚点相对滚动容器顶部的额外偏移（px），可正可负 */
  offset: number;
}

/** 锚点元素上挂的属性名（`data-hd-anchor`） */
const ANCHOR_ATTR = 'data-hd-anchor';

/**
 * 记当前位置：取「视口顶部之上最后一个有内容的块」当锚点，偏移记它顶部被卷上去多少。
 *
 * 选「最后一个已滚过的块」而不是「第一个还露着的块」：后者在首屏时锚点是文档第一个块
 * （偏移恒为 0），用户往下滚一点点就换锚点，位置会被切得很碎。
 */
export function captureHandoutReadPos(scroll: HTMLElement): HandoutReadPos | null {
  const anchors = collectAnchors(scroll);
  if (anchors.length === 0) return null;
  const top = scroll.getBoundingClientRect().top;
  let chosen = anchors[0];
  for (const el of anchors) {
    // 元素顶边已经越过容器顶边 → 它是「读到过的最后一个」
    if (el.getBoundingClientRect().top - top <= 0) chosen = el;
    else break;
  }
  const offset = Math.round(top - chosen.getBoundingClientRect().top);
  return { anchor: chosen.getAttribute(ANCHOR_ATTR)!, offset };
}

/**
 * 落回上次位置。锚点找不到（内容改过 / 旧数据）时返回 false，调用方保持顶部。
 *
 * ⚠️ **offset 是加不是减**。推导（`delta` 是锚点相对内容顶端的位移，恒为正）：
 * ```
 * 记 o = 容器顶 - 锚点顶 = pos.offset（锚点在容器顶之上 o 像素）
 *     P = scrollTop
 * 锚点顶 = 容器顶 + delta - P   ⇒   o = P - delta   ⇒   P = delta + o
 * ```
 * 记成减号的后果很隐蔽：位置只差 2×offset，块高 114px、offset 40px 时正好偏一个段落 ——
 * 表现为「读到第五节，打开停在第四节中段」，而且**每次落位都一样地错**，看着像随机。
 *
 * 落位用 `scrollTop` 直接赋值而不是 `scrollIntoView`：后者会滚**所有**祖先容器，
 * 面板本身也会跟着动（表现为讲义面板忽然跳到中间）。
 */
export function applyHandoutReadPos(scroll: HTMLElement, pos: HandoutReadPos | null | undefined): boolean {
  if (!pos?.anchor) return false;
  const el = scroll.querySelector<HTMLElement>(`[${ANCHOR_ATTR}="${cssEscape(pos.anchor)}"]`);
  if (!el) return false;
  const delta = el.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  const target = Math.max(0, Math.round(scroll.scrollTop + delta + pos.offset));
  // 目标与当前位置差不到一个像素就别写了：写 scrollTop 会让浏览器的「回退」历史多一条
  if (Math.abs(target - scroll.scrollTop) < 1) return true;
  scroll.scrollTop = target;
  return true;
}

/** 文档内全部锚点（按文档顺序） */
function collectAnchors(scroll: HTMLElement): HTMLElement[] {
  return [...scroll.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTR}]`)];
}

/** 锚点串里只有 `s12b34` 这类字符，但仍然转义：属性选择器里一个引号就能让整条查询失效 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
