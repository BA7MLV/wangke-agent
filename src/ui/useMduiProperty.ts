import { useLayoutEffect, type RefObject } from 'react';

/**
 * 把 React 的值写进 mdui 元素的 **JS property**（不是 attribute）。
 *
 * ## 什么时候需要它
 * React 19 对自定义元素的处理已经比 18 好很多：属性名如果在元素实例上存在为 property，
 * React 就会写成 property（React 18 只写 attribute）。所以**大多数场景直接用 JSX 属性即可**，
 * 例如 `<mdui-text-field value={v} />`、`<mdui-switch defaultChecked />` 在 React 19 下都是对的。
 *
 * 需要本 hook 的是这几类：
 * 1. property 名与要表达的业务值不对应（例如把若干 React state 归一化成一个值写进去）；
 * 2. 写入时机有要求：mdui 组件在挂载时可能会用自己的默认值覆盖 attribute，需要在提交后确定性地再写一次；
 * 3. 元素的 property 只有 JS property、没有同名 HTML 属性，且不想依赖 React 的 attribute/property 判定。
 *
 * ## 实现取舍
 * - 用 `useLayoutEffect` 而非 `useEffect`：在浏览器绘制前写入，避免「先用默认值画一帧再跳变」。
 * - 故意不写依赖数组：元素可能是本组件提交之后才挂上的，没有依赖项能观察这件事；
 *   每轮渲染都跑一次，靠 `!==` 守卫消除无意义写入（写同值不会触发 mdui 的 requestUpdate）。
 * - **不做「强制写入」**：如果每轮渲染都无条件覆盖，会打断用户正在输入的受控输入框。
 *   需要「用户改了但 React 值没变时回弹」的场景，请让 state 走一次新对象/新值，
 *   等值守卫自然就会写入（这也是 antd 时代同样的行为）。
 */
/**
 * ⚠️ 这里刻意**不加** `T extends HTMLElement` 约束：mdui 的元素类在结构上并不总是可赋值给
 * `HTMLElement`（实测 `TextField` 声明了 `autocorrect?: string`，而 lib.dom 的
 * `HTMLElement.autocorrect` 是 `boolean`），加了约束会让 `<mdui-text-field>` 的 ref 直接编译不过。
 */
export function useMduiProperty<T extends object, K extends keyof T>(
  ref: RefObject<T | null>,
  prop: K,
  value: T[K],
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el[prop] !== value) {
      el[prop] = value;
    }
  });
}
