/**
 * 只把引导页用到的四个 hairline 图形打进这一个 chunk。
 * 由 OnboardingFigure 动态 import，首屏和已登录用户都不会下载它。
 */
export { hub, padlock, settle, vault } from '@lucasmarkes/hairline';
export type { Figure, HairlineOptions } from '@lucasmarkes/hairline';
