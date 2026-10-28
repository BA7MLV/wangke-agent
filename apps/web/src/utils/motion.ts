/**
 * 系统是否开了「减少动态效果」。
 *
 * CSS 里的动画由 `@media (prefers-reduced-motion: reduce)` 自己兜住，但 **JS 发起的**
 * 动效媒体查询管不到 —— 最典型的是 `scrollTo({ behavior: 'smooth' })`：它照样会平滑
 * 滚过去。凡是这类程序化的滚动 / 位移，动手前先问它一句，降级成直接到位。
 *
 * （原先这段住在 `components/mermaid/drawMark.ts` 里，只有落画动画在用；对话页
 * 「回到底部」是第二个消费者 —— 它不属于 mermaid，所以提到这里做唯一一份。）
 */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
