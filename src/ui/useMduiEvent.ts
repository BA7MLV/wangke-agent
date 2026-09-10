import { useEffect, useRef, type RefObject } from 'react';
import type { MduiElementClassMap, MduiElementEventMap, MduiEventName, MduiTag } from '../types/mdui-elements';

/** mdui 标签 → 元素实例类型（如 'mdui-dialog' → Dialog） */
export type MduiElementOf<Tag extends MduiTag> = MduiElementClassMap[Tag];

/** 某个标签上某个事件的回调签名；第二个参数是触发事件的元素，省掉一次 `as` */
export type MduiEventHandler<Tag extends MduiTag, Name extends MduiEventName<Tag>> = (
  event: MduiElementEventMap[Tag][Name],
  element: MduiElementOf<Tag>,
) => void;

/**
 * 给 mdui 自定义元素绑定事件，返回要挂到该元素上的 ref。
 *
 * ## 为什么不能直接写 JSX 的 onXxx
 * mdui 的事件名大多是自定义名（`opened` / `overlay-click` / `action-click` / `submenu-open` …）。
 * 实测（见 docs/plans/2026-09-10-mdui-migration-design.md 第二节）：
 * - React 19 会把 `on<name>` 当作事件名交给 addEventListener，但**不做驼峰转换**，
 *   于是 `onopened` 有效、`onOpened`／`onOpen` 静默失效（不报错、也不触发）；
 * - React 18 完全不支持自定义元素上的自定义事件，连 `change` 都不触发。
 *
 * 所以：**标准名事件（click / input / focus / blur）可以声明式写；其余一律走本 hook**。
 *
 * ## 用法
 * ```tsx
 * const dialogRef = useMduiEvent('mdui-dialog', 'opened', () => {
 *   // 第二个参数 element 已收敛为 Dialog
 * });
 * return <mdui-dialog ref={dialogRef} />;
 * ```
 *
 * ## 实现取舍
 * effect 故意**不写依赖数组**：元素可能在本组件首次提交之后才挂上（条件渲染、弹层懒挂载），
 * 没有依赖项可观察这种变化，每轮渲染重新绑定是最省心的正确做法（先 remove 后 add 在同一次
 * 提交里同步完成，中间不可能有事件派发）。事件闭包通过 handlerRef 取最新值，避免读到过期 state。
 */
export function useMduiEvent<Tag extends MduiTag, Name extends MduiEventName<Tag>>(
  tag: Tag,
  event: Name,
  handler: MduiEventHandler<Tag, Name>,
): RefObject<MduiElementOf<Tag> | null> {
  const ref = useRef<MduiElementOf<Tag> | null>(null);
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;

    const el = ref.current;
    if (!el) return;

    const listener = (e: Event) => {
      handlerRef.current(e as MduiElementEventMap[Tag][Name], el);
    };
    el.addEventListener(event as string, listener);
    return () => el.removeEventListener(event as string, listener);
  });

  return ref;
}
