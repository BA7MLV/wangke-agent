import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';

export const MD_FORMAT_ACTIONS = [
  { id: 'heading', label: '标题' },
  { id: 'bold', label: '加粗' },
  { id: 'italic', label: '斜体' },
  { id: 'list', label: '无序列表' },
  { id: 'ordered', label: '有序列表' },
  { id: 'quote', label: '引用' },
  { id: 'link', label: '插入链接' },
  { id: 'image', label: '插入图片' },
  { id: 'code', label: '行内代码' },
  { id: 'codeblock', label: '代码块' },
] as const;

export type MdFormatAction = (typeof MD_FORMAT_ACTIONS)[number]['id'];

/** One transaction per action, so formatting uses the editor's normal undo and save path. */
export function formatMarkdown(state: EditorState, action: MdFormatAction): TransactionSpec {
  const range = state.selection.main;
  let { from, to } = range;
  let insert: string;
  let anchor: number;
  let head: number;

  if (action === 'heading' || action === 'list' || action === 'ordered' || action === 'quote') {
    const first = state.doc.lineAt(from);
    // A selection ending at the next line's start does not include that line.
    const last = state.doc.lineAt(to > from && state.doc.lineAt(to).from === to ? to - 1 : to);
    from = first.from;
    to = last.to;
    const lines = state.sliceDoc(from, to).split('\n');
    const prefix = (i: number) => action === 'heading' ? '## ' : action === 'quote' ? '> ' : action === 'ordered' ? `${i + 1}. ` : '- ';
    const matches = (line: string) => action === 'heading' ? /^## /.test(line) : action === 'quote' ? /^> /.test(line) : action === 'ordered' ? /^\d+\. /.test(line) : /^- /.test(line);
    const remove = lines.every(matches);
    insert = lines.map((line, i) => {
      const stripped = line.replace(action === 'heading' ? /^#{1,6} / : action === 'quote' ? /^> / : /^(?:[-+*]|\d+\.) /, '');
      return remove ? stripped : prefix(i) + stripped;
    }).join('\n');
    anchor = from;
    head = from + insert.length;
  } else {
    const selected = state.sliceDoc(from, to);
    const body = selected || (action === 'image' ? '图片说明' : action === 'link' ? '链接文字' : action === 'code' || action === 'codeblock' ? '代码' : '文字');
    const marker = action === 'bold' ? '**' : action === 'italic' ? '*' : '`';
    if (action === 'image' || action === 'link') {
      const prefix = action === 'image' ? '!' : '';
      const label = action === 'image' ? body.replace(/\r?\n/g, ' ').replace(/[\\[\]]/g, '\\$&') : body;
      insert = `${prefix}[${label}](https://)`;
      anchor = from + prefix.length + label.length + 3;
      head = anchor + 'https://'.length;
    } else if (action === 'codeblock') {
      const before = from > 0 && state.sliceDoc(from - 1, from) !== '\n' ? '\n' : '';
      const after = to < state.doc.length && state.sliceDoc(to, to + 1) !== '\n' ? '\n' : '';
      insert = `${before}\`\`\`\n${body}\n\`\`\`${after}`;
      anchor = from + before.length + 4;
      head = anchor + body.length;
    } else if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length > marker.length * 2) {
      insert = selected.slice(marker.length, -marker.length);
      anchor = from;
      head = from + insert.length;
    } else if (from >= marker.length && state.sliceDoc(from - marker.length, from) === marker && state.sliceDoc(to, to + marker.length) === marker) {
      from -= marker.length;
      to += marker.length;
      insert = body;
      anchor = from;
      head = from + body.length;
    } else {
      insert = marker + body + marker;
      anchor = from + marker.length;
      head = anchor + body.length;
    }
  }

  return {
    changes: { from, to, insert },
    selection: EditorSelection.range(anchor, head),
    userEvent: 'input.format',
    scrollIntoView: true,
  };
}
