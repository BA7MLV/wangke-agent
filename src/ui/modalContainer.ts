/**
 * HeroUI `Modal.Container` 在本项目里必须补的版式类。
 *
 * ## 结构：Container 必须写在 Backdrop **里面**
 *
 * ```
 * <Modal.Root>
 *   <Modal.Backdrop>        ← fixed inset-0；z-index: var(--z-index-overlay)（= 100000）
 *     <Modal.Container>     ← 撑满遮罩，把 dialog 摆到中间
 *       <Modal.Dialog />
 * ```
 *
 * ⚠️ 这里曾经写的是「把 Container 当成遮罩的**兄弟节点**」，再给容器补
 * `fixed inset-0` 把它拉回视口。那条路有两个修不掉的副作用：
 *
 * 1. **遮罩画在面板之上。** `.modal__backdrop` 带 `z-index: var(--z-index-overlay)`
 *    （base.css 里是 100000），`.modal__container` 没有 z-index；两者同为 `fixed`
 *    且同为 body 子节点时，绘制顺序由 z-index 决定 —— 遮罩盖住面板，面板被自己
 *    那层半透明黑压暗。用 `variant="blur"` 时症状更直白：**整块面板都是模糊的**，
 *    因为 backdrop-filter 模糊的正是它下面绘制的面板。
 *    更麻烦的是它**测不出来**：react-aria 的 `ariaHideOutside` 会把遮罩打成
 *    `inert`，而 inert 不参与命中测试 —— 点击照样穿过去，`page.click` /
 *    `elementFromPoint` 类断言全绿。（也因此在不支持 `inert` 的浏览器上，
 *    遮罩变成可命中，整个面板会点不动。）
 * 2. **遮罩那层浮层是死的。** 兄弟结构下遮罩的 `ModalOverlay` 里没有 `Modal`
 *    子节点，它的 `modalRef.current` 永远是 null，而 react-aria 的
 *    `isValidEvent()` 第一句就是 `if (!ref.current) return false` —— 于是
 *    `isDismissable` / `isKeyboardDismissDisabled` / `shouldCloseOnInteractOutside`
 *    全部空转（`Library.tsx` 里「导入中禁止 Esc」就是这么静默失效的）。
 *    真正干活的是 Container 自己新建的那层匿名 `ModalOverlay`，而它拿不到
 *    `isDismissable` → **点遮罩关不掉弹窗**。
 *
 * 嵌进 Backdrop 之后，RAC 的 `Modal` 走 InternalModalContext 分支直接渲染内容
 * （不再自建浮层），模态语义、`isDismissable`、`ariaHideOutside` 全部归遮罩那一层，
 * 且 dialog 绘制在遮罩背景之上 —— 上面两个问题一起消失。
 *
 * ## 为什么是这几个类
 *
 * - `h-full`：撑满遮罩。遮罩的高度是 RAC 内联写在它身上的
 *   `--visual-viewport-height`（**真实像素**，不是 vh/dvh，挂载首帧也不会算错），
 *   所以这里的百分比高度有确定参照。**不要用 `h-auto`** —— 容器高度一旦由内容
 *   决定，dialog 的 `h-[calc(100%-2rem)]` 就失去参照、整块塌掉。
 * - `w-full`：HeroUI 给的是 `sm:w-fit`，容器内容一宽（长地址、长 Key、模型 id）
 *   容器就比视口还宽，`items-center` 把对话框推到屏幕外。
 * - `items-center` + `p-0`：`.modal__container` 自带 `padding: var(--spacing) * 10`
 *   和一套居中默认值，这里显式写死，免得被版本默认值带偏。
 *
 * 不再需要 `fixed inset-0`（遮罩本身就是那一层），也不再需要 `isolate`
 * （遮罩自己带 z-index，已经是层叠上下文）。
 */
export const MODAL_CONTAINER_CLASS = 'h-full w-full items-center p-0';