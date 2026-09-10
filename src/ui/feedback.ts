/**
 * 反馈类组件的适配层：把 antd 时代的 `message.*` / `Modal.confirm` 语义映射到 mdui 的
 * `snackbar()` / `confirm()` / `alert()` 函数式 API。
 *
 * 为什么不直接暴露 mdui 的函数：迁移期两套 UI 并存，调用点写成 `toast.success(...)`
 * 就能一对一替换 `message.success(...)`，改动是机械的、review 起来能一眼看出等价关系。
 */
import { dialog, snackbar } from './mdui';

/** 同队列串行：多条提示排队出现，而不是同时叠在屏幕上 */
const TOAST_QUEUE = 'wangke-toast';

function showToast(message: string, autoCloseDelay: number) {
  return snackbar({
    message,
    // 顶部展示：移动端底部是 Tab 栏，底部提示会被挤到很别扭的位置
    placement: 'top',
    closeable: true,
    autoCloseDelay,
    queue: TOAST_QUEUE,
  });
}

/**
 * 轻提示，替代 antd 的 `message`。
 *
 * 注意：mdui 的 snackbar 没有 success / error 这种语义色变体（MD3 规范里 snackbar 只有一种形态），
 * 因此四个方法目前外观一致，只有停留时长不同——错误留久一点，方便用户看清。
 * 需要在视觉上区分「成功/失败」的地方，请改用 PersistentError 这类页面内组件，而不是指望提示色。
 */
export const toast = {
  info: (message: string) => showToast(message, 3000),
  success: (message: string) => showToast(message, 3000),
  warning: (message: string) => showToast(message, 5000),
  error: (message: string) => showToast(message, 8000),
};

export interface ConfirmOptions {
  /** 标题 */
  headline: string;
  /** 描述文本 */
  description?: string;
  /** 确认按钮文案。危险操作请显式写成「删除」「清空」这种动作词 */
  confirmText?: string;
  /** 取消按钮文案 */
  cancelText?: string;
  /**
   * 传了就在确认按钮左边加一个「复制详情」按钮，点击后把这段文本写进剪贴板、**对话框不关闭**。
   * 用于报错详情这类需要原样复制出去的内容（替 antd `Typography.Paragraph copyable`）。
   */
  copyText?: string;
  /**
   * 危险操作：给确认按钮上错误色。
   *
   * MD3 的对话框确认按钮统一是 text 变体，mdui 也不提供危险色变体，
   * 所以颜色靠这一层自己给（`mdui-dialog:has([data-danger]) …`，见 layout.css）。
   * 语义不能只靠颜色，文案仍须写清动作。
   */
  danger?: boolean;
}

/**
 * mdui 的 `dialog()` 是自己 new 一个组件塞进 body 的，我们没法往里加属性；
 * 这里往 body 里放一个零尺寸标记元素，给 e2e 一个稳定锚点：
 *   const dlg = page.locator('mdui-dialog:has([data-testid="confirm-dialog"])');
 *   await dlg.locator('mdui-button[slot="action"]').last().click();   // 确认（取消在前）
 *
 * 之所以不用 mdui 现成的 `confirm()`：它在关闭方式不是「点确认」时 **reject**，
 * 既要多写 try/catch，又插不进标记元素；直接用 `dialog()` 反而更短、更好测。
 */
function confirmMarker(danger?: boolean): HTMLElement {
  const marker = document.createElement('span');
  marker.setAttribute('data-testid', danger ? 'confirm-dialog-danger' : 'confirm-dialog');
  return marker;
}

/**
 * 确认对话框，替代 antd 的 `Modal.confirm`。
 *
 * 收敛成 `Promise<boolean>`，调用点写 `if (await confirmDialog(...))` 即可。
 * 注意 `dialog()` 的 action 回调语义：**返回 `false` 是「不关闭」**，
 * 返回 undefined 才会关闭 —— 所以两个按钮都不返回 false，靠闭包变量决定结果。
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let confirmed = false;
    dialog({
      headline: options.headline,
      description: options.description,
      closeOnEsc: true,
      // 与网站既有的 Popconfirm 行为对齐：点遮罩不算确认
      closeOnOverlayClick: true,
      body: confirmMarker(options.danger),
      actions: [
        { text: options.cancelText ?? '取消', onClick: () => undefined },
        {
          text: options.confirmText ?? '确定',
          onClick: () => {
            confirmed = true;
          },
        },
      ],
      onClosed: () => resolve(confirmed),
    });
  });
}

/** 只有「知道了」的提示框，替代 antd 的 `Modal.info` / `Modal.error` */
export function alertDialog(options: ConfirmOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const copyAction = options.copyText
      ? [
          {
            text: '复制详情',
            // 返回 false 是「不关闭对话框」（见 mdui dialog.d.ts），复制完让用户继续看
            onClick: () => {
              void navigator.clipboard?.writeText(options.copyText!);
              return false;
            },
          },
        ]
      : [];
    dialog({
      headline: options.headline,
      description: options.description,
      closeOnEsc: true,
      closeOnOverlayClick: true,
      body: confirmMarker(),
      actions: [...copyAction, { text: options.confirmText ?? '知道了', onClick: () => undefined }],
      onClosed: () => resolve(),
    });
  });
}
