import { forwardRef, useImperativeHandle, useRef, type ReactNode } from 'react';
import { Button, Spinner, TextArea, cn } from '@heroui/react';
import { Sym } from '../ui';
import { useImeEnter } from '../utils/imeEnter';
import { useComposerSize } from './ComposerExpand';
import './message-composer.css';

/**
 * iMessage 式输入栏：左边一颗圆形「＋」，右边一条胶囊输入框，发送键收在胶囊里。
 *
 * - 自动增高：从一行长到 `--composer-max-height`（默认约 8 行），之后在框内滚动，
 *   页面布局不跟着跳。
 * - 回车发送、Shift+回车换行；输入法选词的回车不发送（含 Safari，见 utils/imeEnter）。
 * - 没有文字时发送键不出现，有字时用 transitions.dev 的 icon swap 曲线弹出 ——
 *   和 iMessage 一样，靠出现与否表达「现在能不能发」，不用灰掉的按钮。
 * - 移动端键盘：页面高度由 useMobileGlobals 写的 `--vvh` 跟随可视视口，
 *   输入栏只负责在键盘弹出时去掉底部安全区留白。
 */
export interface MessageComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** 生成或执行中：没有草稿时发送键换成停止键；有草稿时仍允许发送 */
  busy?: boolean;
  onStop?: () => void;
  onAttach?: () => void;
  attachBusy?: boolean;
  attachLabel?: string;
  ariaLabel: string;
  /** 胶囊上方的附加内容（引用、附件预览） */
  accessory?: ReactNode;
  className?: string;
}

export interface MessageComposerHandle {
  focus: () => void;
}

const MessageComposer = forwardRef<MessageComposerHandle, MessageComposerProps>(function MessageComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  busy,
  onStop,
  onAttach,
  attachBusy,
  attachLabel = '添加附件',
  ariaLabel,
  accessory,
  className,
}, ref) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ime = useImeEnter();
  useComposerSize(inputRef, value);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  const canSend = !disabled && value.trim().length > 0;
  const submit = () => {
    if (!canSend) return;
    onSubmit(value);
  };

  return (
    <div className={cn('imsg-composer', className)} data-disabled={disabled || undefined}>
      {accessory && <div className="imsg-composer__accessory">{accessory}</div>}
      <div className="imsg-composer__row">
        {onAttach && (
          <Button
            isIconOnly
            variant="secondary"
            className="imsg-composer__attach"
            aria-label={attachLabel}
            isDisabled={disabled || attachBusy}
            onPress={onAttach}
          >
            {attachBusy ? <Spinner size="sm" color="current" /> : <Sym name="add" />}
          </Button>
        )}
        <div className="imsg-composer__field">
          <TextArea
            ref={inputRef}
            rows={1}
            fullWidth
            aria-label={ariaLabel}
            className="imsg-composer__input"
            placeholder={placeholder}
            value={value}
            disabled={disabled}
            enterKeyHint="send"
            onChange={(event) => onChange(event.target.value)}
            {...ime.compositionProps}
            onKeyDown={(event) => {
              if (!ime.isSubmitEnter(event)) return;
              event.preventDefault();
              submit();
            }}
          />
          {busy && onStop && !value.trim() ? (
            <Button isIconOnly size="sm" variant="secondary" className="imsg-composer__send" data-shown aria-label="停止" onPress={onStop}>
              <Sym name="stop" />
            </Button>
          ) : (
            <Button
              isIconOnly
              size="sm"
              variant="primary"
              className="imsg-composer__send"
              data-shown={canSend || undefined}
              aria-label="发送"
              aria-hidden={!canSend}
              isDisabled={!canSend}
              onPress={submit}
            >
              <Sym name="arrow_upward" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});

export default MessageComposer;
