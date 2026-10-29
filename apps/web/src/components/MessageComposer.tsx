import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode, type ClipboardEventHandler } from 'react';
import { Button, Dropdown, Spinner, cn } from '@heroui/react';
import { Sym } from '../ui';
import { useImeEnter } from '../utils/imeEnter';
import ComposerExpand, { useComposerSize } from './ComposerExpand';
import { ChatComposer, ChatComposerInput, ChatComposerTools } from './ChatComposer';
import VoiceInput from './VoiceInput';
import { CHAT_IMAGE_ACCEPT } from '../chat/attachments';
import './message-composer.css';

/**
 * Bot / IM 输入管线，复用主对话的输入卡、文本框和工具栏。
 *
 * - 自动增高：复用输入卡的最大高度，之后在框内滚动，
 *   页面布局不跟着跳。
 * - 回车发送、Shift+回车换行；输入法选词的回车不发送（含 Safari，见 utils/imeEnter）。
 * - 与主页共用语音/发送操作位、长文本展开和输入法保护。
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
  onFiles?: (files: File[]) => void;
  sending?: boolean;
  hasAttachments?: boolean;
  onScope?: () => void;
  onSettings?: () => void;
  onFocus?: () => void;
  attachLabel?: string;
  ariaLabel: string;
  /** 输入卡内、文本框上方的附加内容（引用、附件预览） */
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
  onFiles,
  sending,
  hasAttachments,
  onScope,
  onSettings,
  onFocus,
  attachLabel = '添加附件',
  ariaLabel,
  accessory,
  className,
}, ref) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const holdRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const voiceBase = useRef('');
  const [editVersion, setEditVersion] = useState(0);
  const ime = useImeEnter();
  const overflow = useComposerSize(inputRef, value);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  const hasDraft = value.trim().length > 0 || Boolean(hasAttachments);
  const canSend = !disabled && !sending && hasDraft;
  const edit = (next: string) => { setEditVersion(version => version + 1); onChange(next); };
  const submit = () => {
    if (!canSend) return;
    setEditVersion(version => version + 1);
    onSubmit(value);
  };
  const paste: ClipboardEventHandler<HTMLTextAreaElement> = event => {
    const files = Array.from(event.clipboardData.files);
    if (!disabled && onFiles && files.length) { event.preventDefault(); onFiles(files); }
  };

  return (
    <div className={cn('imsg-composer', className)} data-disabled={disabled || undefined}>
      <ChatComposer ref={holdRef}
        onDragOver={event => { if (!disabled && onFiles && event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
        onDrop={event => { if (!disabled && onFiles && event.dataTransfer.files.length) { event.preventDefault(); onFiles(Array.from(event.dataTransfer.files)); } }}>
        {accessory && <div className="imsg-composer__accessory">{accessory}</div>}
        {onFiles && <div className="imsg-composer__attach chat-add-menu">
          <Dropdown>
            <Button isIconOnly size="sm" variant="tertiary" className="chat-add-menu__trigger" aria-label={attachLabel} isDisabled={disabled} data-testid="bot-add"><Sym name="add" /></Button>
            <Dropdown.Popover placement="top start"><Dropdown.Menu aria-label="添加到对话" onAction={key => {
              if (key === 'images') imageInput.current?.click();
              else if (key === 'files') fileInput.current?.click();
              else if (key === 'scope') onScope?.();
              else if (key === 'settings') onSettings?.();
            }}>
              <Dropdown.Item id="images" textValue="上传图片"><Sym name="image" />上传图片</Dropdown.Item>
              <Dropdown.Item id="files" textValue="上传文件"><Sym name="attach_file" />上传文件</Dropdown.Item>
              {onScope && <Dropdown.Item id="scope" textValue="工具范围"><Sym name="extension" />工具范围</Dropdown.Item>}
              {onSettings && <Dropdown.Item id="settings" textValue="模型与权限"><Sym name="tune" />模型与权限</Dropdown.Item>}
            </Dropdown.Menu></Dropdown.Popover>
          </Dropdown>
          <input ref={imageInput} type="file" accept={CHAT_IMAGE_ACCEPT} multiple hidden data-testid="bot-image-input" onChange={event => { onFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
          <input ref={fileInput} type="file" multiple hidden data-testid="bot-file-input" onChange={event => { onFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        </div>}
        <ComposerExpand visible={overflow} value={value} onChange={edit} onPaste={paste} />
          <ChatComposerInput
            ref={inputRef}
            rows={1}
            fullWidth
            aria-label={ariaLabel}
            className="imsg-composer__input"
            placeholder={placeholder}
            value={value}
            disabled={disabled}
            enterKeyHint="send"
            onChange={(event) => edit(event.target.value)}
            onPaste={paste}
            onFocus={onFocus}
            aria-description="长按输入栏说话，松开完成，上滑取消；识别后可编辑再发送"
            {...ime.compositionProps}
            onKeyDown={(event) => {
              if (!ime.isSubmitEnter(event)) return;
              event.preventDefault();
              submit();
            }}
          />
        <ChatComposerTools aria-label="输入区工具">
          {sending ? <Spinner size="sm" aria-label="正在发送" /> : busy && onStop ? (
            <Button isIconOnly size="sm" variant={hasDraft ? 'primary' : 'tertiary'} className={hasDraft ? 'imsg-composer__send' : 'imsg-composer__stop'} aria-label={hasDraft ? '排队发送' : '停止'} isDisabled={hasDraft && !canSend} onPress={hasDraft ? submit : onStop}>
              <Sym name={hasDraft ? 'arrow_upward' : 'stop'} filled={!hasDraft} />
            </Button>
          ) : (
            <VoiceInput holdTargetRef={holdRef} disabled={disabled} hasText={hasDraft} editVersion={editVersion}
              onStart={() => { voiceBase.current = value; }}
              onText={text => onChange(voiceBase.current ? `${voiceBase.current} ${text}` : text)} onSend={submit} />
          )}
        </ChatComposerTools>
      </ChatComposer>
    </div>
  );
});

export default MessageComposer;
