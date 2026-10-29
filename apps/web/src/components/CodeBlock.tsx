import { useId, useState, type ReactNode } from 'react';
import { Button, Dropdown, Label } from '@heroui/react';
import { Sym, toast } from '../ui';
import { copyText } from '../utils/clipboard';
import type { ArtifactActions } from './ArtifactEditor';
import StickyHeader from './StickyHeader';
import './code-block.css';

/** Source is inert. Only callers with an authorized work may supply a preview. */
export default function CodeBlock({ source, language = 'text', preview, editActions }: {
  source: string; language?: string; preview?: ReactNode; editActions?: ArtifactActions | null;
}) {
  const label = language.trim().split(/\s+/)[0] || 'text';
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewMounted, setPreviewMounted] = useState(false);
  const contentId = useId();
  return <div className="md-embedded-ui code-block" data-testid="code-block" data-code-block-id={contentId} data-language={label} data-view={previewOpen ? 'preview' : 'code'}>
    <StickyHeader className="code-block__header">
      <span className="code-block__language">{label}</span>
      <Dropdown>
        <Button isIconOnly size="sm" variant="tertiary" aria-label={label === 'html' ? '更多 HTML 操作' : '更多代码操作'} data-testid="code-block-more" data-code-owner={contentId}>
          <Sym name="more_horiz" size={18} />
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu aria-label="代码操作" disabledKeys={editActions?.busy ? ['edit', 'undo'] : []} onAction={key => {
            if (key === 'copy') void copyText(source).then(ok => ok ? toast.success('源码已复制') : toast.error('复制失败'));
            if (key === 'preview') { setPreviewMounted(true); setPreviewOpen(value => !value); }
            if (key === 'edit') editActions?.edit();
            if (key === 'undo') editActions?.undo?.();
          }}>
            <Dropdown.Item id="copy" textValue="复制代码"><Sym name="content_copy" /><Label>复制代码</Label></Dropdown.Item>
            {preview != null ? <Dropdown.Item id="preview" textValue={previewOpen ? '查看代码' : '预览'} aria-controls={contentId}>
              <Sym name={previewOpen ? 'code' : 'visibility'} /><Label>{previewOpen ? '查看代码' : '预览'}</Label>
            </Dropdown.Item> : null}
            {editActions ? <Dropdown.Item id="edit" textValue="修改 HTML"><Sym name="edit" /><Label>修改 HTML</Label></Dropdown.Item> : null}
            {editActions?.undo ? <Dropdown.Item id="undo" textValue="撤销上次修改"><Sym name="undo" /><Label>撤销上次修改</Label></Dropdown.Item> : null}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </StickyHeader>
    <div id={contentId} className="code-block__content">
      <pre className="code-block__source" hidden={previewOpen}><code>{source}</code></pre>
      {/* Keep an explicitly opened runtime alive across source/preview switches. */}
      {previewMounted && <div className="code-block__preview" hidden={!previewOpen}>{preview}</div>}
    </div>
  </div>;
}
