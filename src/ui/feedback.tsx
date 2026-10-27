/**
 * 反馈类组件的适配层：toast 轻提示 + 命令式确认/提示对话框。
 *
 * 设计要点：
 *
 * 1. **toast** 直接用 HeroUI 的全局 `toast()` API（`@heroui/react`），语义色
 *    （success / danger / info / warning）由 HeroUI 提供，比 mdui 时代的
 *    「四个方法同一种外观」更可辨识。需要在应用根部挂 `<Toast.Provider>`，
 *    见 FeedbackHost。
 *
 * 2. **confirmDialog / alertDialog** 保持 antd 时代的 `Promise<boolean>` /
 *    `Promise<void>` 语义，调用点写法不变（`if (await confirmDialog(...))`）。
 *    HeroUI 的 Modal 是 React 组件，无法像 mdui 的 `dialog()` 那样在业务代码里
 *    new 出来 —— 所以用**命令队列 + 常驻宿主**实现：
 *      - 业务代码调用 confirmDialog() → 命令入队 → 返回 Promise；
 *      - FeedbackHost（挂在 App 根部）订阅队列，把队头渲染成 Modal；
 *      - 用户点确认/取消/遮罩/Esc → 出队并 resolve。
 *
 * 3. e2e 锚点：对话框根节点带 `data-testid="confirm-dialog"`（危险操作是
 *    `confirm-dialog-danger`，带输入框的是 `prompt-dialog`），确认/取消按钮带
 *    `data-testid` 后缀，选择器不依赖 HeroUI 的内部类名。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Label, Modal, TextField, Toast, toast as heroToast } from '@heroui/react';
import { Sym } from './icons';
import { MODAL_CONTAINER_CLASS } from './modalContainer';

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
   * 用于报错详情这类需要原样复制出去的内容。
   */
  copyText?: string;
  /**
   * 危险操作：给确认按钮上错误色。
   * 语义不能只靠颜色，文案仍须写清动作。
   */
  danger?: boolean;
}

/* ── toast ─────────────────────────────────────────────────────────────── */

/**
 * 轻提示（替代 antd 的 message / mdui 的 snackbar）。
 *
 * 停留时长：info/success 3s，warning 5s，error 8s（错误留久一点，方便看清）。
 * 需要常驻的提示不要用 toast，用页面内的 Banner。
 */
export const toast = {
  info: (message: string) => heroToast.info(message, { timeout: 3000 }),
  success: (message: string) => heroToast.success(message, { timeout: 3000 }),
  warning: (message: string) => heroToast.warning(message, { timeout: 5000 }),
  error: (message: string) => heroToast.danger(message, { timeout: 8000 }),
};

/* ── 命令式对话框 ───────────────────────────────────────────────────────── */

interface ConfirmCommand {
  kind: 'confirm';
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

interface AlertCommand {
  kind: 'alert';
  options: ConfirmOptions;
  resolve: () => void;
}

export interface PromptOptions {
  /** 标题 */
  headline: string;
  /** 描述文本 */
  description?: string;
  /** 输入框初值。重命名时传当前标题 */
  defaultValue?: string;
  /** 输入框占位符 */
  placeholder?: string;
  /** 输入框类型；密码确认不应在屏幕上明文显示。 */
  inputType?: 'text' | 'password';
  /** 默认会去掉首尾空白；密码需要保留用户输入时设为 false。 */
  trim?: boolean;
  /** 确认按钮文案 */
  confirmText?: string;
  /** 取消按钮文案 */
  cancelText?: string;
  /**
   * 提交前校验。返回字符串 = 错误提示，**对话框不关闭**、焦点留在输入框。
   *
   * 校验放在这里而不是调用点，是因为一旦关闭，对话框就出队了 ——
   * 想再提示一次得重新 `promptDialog()`，输入内容也丢了。
   */
  validate?: (value: string) => string | null;
}

interface PromptCommand {
  kind: 'prompt';
  options: PromptOptions;
  resolve: (value: string | null) => void;
}

type FeedbackCommand = ConfirmCommand | AlertCommand | PromptCommand;

const queue: FeedbackCommand[] = [];
const listeners = new Set<() => void>();

function enqueue(command: FeedbackCommand): void {
  queue.push(command);
  listeners.forEach((listener) => listener());
}

function dequeue(): void {
  queue.shift();
  listeners.forEach((listener) => listener());
}

function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

/** 确认对话框：resolve(true) = 用户点了确认；其余方式关闭都是 false。 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    enqueue({ kind: 'confirm', options, resolve });
  });
}

/** 只有「知道了」的提示框（替代 antd 的 Modal.info / Modal.error）。 */
export function alertDialog(options: ConfirmOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    enqueue({ kind: 'alert', options, resolve });
  });
}

/** 输入框对话框：resolve(字符串) = 用户确认；取消 / 遮罩 / Esc 一律 resolve(null)。 */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    enqueue({ kind: 'prompt', options, resolve });
  });
}

/**
 * 反馈层宿主：挂在 App 根部一次。
 *
 * 职责：① Toast.Provider 给全局 toast() 提供渲染区域（顶部居中，避开移动端底部 Tab 栏）；
 * ② 把命令队列的队头渲染成 HeroUI Modal。
 */
export function FeedbackHost() {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const listener = () => forceRender((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const current = queue[0] ?? null;

  // 关闭时按「非确认」语义出队并 resolve；alert 只有确认一条路。
  const handleOpenChange = useCallback((open: boolean) => {
    const command = queue[0];
    if (open || !command) return;
    if (command.kind === 'confirm') command.resolve(false);
    else if (command.kind === 'alert') command.resolve();
    else command.resolve(null);
    dequeue();
  }, []);

  return (
    <>
      <Toast.Provider placement="top" gap={8} maxVisibleToasts={3} />
      {current && <FeedbackDialog key={queue.length} command={current} onOpenChange={handleOpenChange} />}
    </>
  );
}

interface FeedbackDialogProps {
  command: FeedbackCommand;
  onOpenChange: (open: boolean) => void;
}

function FeedbackDialog({ command, onOpenChange }: FeedbackDialogProps) {
  const { options } = command;
  const isConfirm = command.kind === 'confirm';
  const isPrompt = command.kind === 'prompt';
  /** `danger` / `copyText` 只有 confirm 有，prompt 没有 —— 分开收窄，别在联合类型上取 */
  const confirmOptions = isPrompt ? null : command.options;
  const promptOptions = isPrompt ? command.options : null;
  /**
   * 输入框的本地值。
   *
   * 放在组件 state 而不是 `FeedbackDialogProps` 上：`FeedbackDialog` 按
   * `queue.length` 做 key，每条命令都重新挂载，所以这份 state 天然「一命令一份」，
   * 下一个对话框不会看见上一个的残留输入。
   */
  const [draft, setDraft] = useState(promptOptions?.defaultValue ?? '');
  /** 校验没过时的提示；有值就渲染在输入框下面并把它标红 */
  const [error, setError] = useState<string | null>(null);
  // 用 ref 拿最新的 resolve，避免按钮回调闭包过期
  const commandRef = useRef(command);
  commandRef.current = command;

  const finish = (result: boolean | void) => {
    const cmd = commandRef.current;
    if (cmd.kind === 'confirm') cmd.resolve(result === true);
    else if (cmd.kind === 'alert') cmd.resolve();
    else cmd.resolve(null);
    dequeue();
  };

  /**
   * prompt 的确认路径：先过 `validate`，过了才出队并 resolve(值)。
   *
   * 空串一律当取消：确认一个空标题等于把这条会话改成无名，用户多半是直接回车忘了填。
   */
  const submitPrompt = () => {
    const value = promptOptions?.trim === false ? draft : draft.trim();
    if (!value) return;
    const problem = promptOptions?.validate?.(value) ?? null;
    if (problem) return setError(problem);
    const cmd = commandRef.current;
    if (cmd.kind === 'prompt') cmd.resolve(value);
    dequeue();
  };

  return (
    <Modal.Root isOpen onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
          <Modal.Dialog
            className="feedback-dialog"
            data-testid={
              isPrompt
                ? 'prompt-dialog'
                : confirmOptions?.danger
                  ? 'confirm-dialog-danger'
                  : 'confirm-dialog'
            }
          >
            <Modal.Header>
              <Modal.Heading>{options.headline}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {options.description && <p className="feedback-dialog__desc">{options.description}</p>}
              {promptOptions && (
                <TextField
                  value={draft}
                  onChange={(next) => {
                    setDraft(next);
                    // 一开始改就把上一次的校验错误抹掉：提示还挂着会让人以为这次也没改成
                    setError(null);
                  }}
                  isInvalid={error != null}
                >
                  <Label>{promptOptions.headline}</Label>
                  <Input
                    autoFocus
                    data-testid="prompt-dialog-input"
                    type={promptOptions.inputType ?? 'text'}
                    placeholder={promptOptions.placeholder}
                    /* 回车提交。HeroUI 的 TextField 不接 `onSubmit`，
                       而 Modal 也不是 form —— 不在这里手动拦的话，
                       用户敲完字按回车只会把对话框关掉（当成按了取消）。 */
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      submitPrompt();
                    }}
                  />
                </TextField>
              )}
              {error && (
                /* 错误自己渲染：HeroUI 的 TextField 没有 `validationErrors`，
                   光标 `isInvalid` 只给红框，不给「为什么错」这句话。 */
                <p className="text-danger text-sm" data-testid="prompt-dialog-error" role="alert">
                  {error}
                </p>
              )}
            </Modal.Body>
            <Modal.Footer>
              {confirmOptions?.copyText && (
                <Button
                  variant="tertiary"
                  onPress={() => copyToClipboard(confirmOptions.copyText!)}
                  data-testid="confirm-dialog-copy"
                >
                  复制详情
                </Button>
              )}
              {!isPrompt && (
                <Button
                  variant="tertiary"
                  onPress={() => finish(false)}
                  data-testid="confirm-dialog-cancel"
                >
                  {options.cancelText ?? '取消'}
                </Button>
              )}
              <Button
                variant={confirmOptions?.danger ? 'danger' : 'primary'}
                onPress={isPrompt ? submitPrompt : () => finish(isConfirm)}
                data-testid={isPrompt ? 'prompt-dialog-confirm' : 'confirm-dialog-confirm'}
              >
                {isPrompt
                  ? (promptOptions?.confirmText ?? '保存')
                  : (options.confirmText ?? (isConfirm ? '确定' : '知道了'))}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}

/** 供调试：当前排队的反馈命令数 */
export function feedbackQueueLength(): number {
  return queue.length;
}
