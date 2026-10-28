import { isValidElement, type ReactNode } from 'react';

/** Read semantic props before descending: custom formula/image components have no text children. */
export function tableCellText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(tableCellText).join('');
  if (!isValidElement(node)) return '';
  const props = node.props as Record<string, unknown>;
  if (typeof props['data-source'] === 'string') return props['data-source'];
  if (node.type === 'br') return '\n';
  if (node.type === 'img' || typeof props.src === 'string') return String(props.alt ?? '');
  return tableCellText(props.children as ReactNode);
}

const htmlText = (text: string) => text.replace(/[&<>|\\`$]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '\\': '&#92;', '`': '&#96;', '$': '&#36;',
})[char]!);
const prose = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // Backslash-escaped brackets are also LaTeX display delimiters in our renderer.
  .replace(/\[/g, '&#91;').replace(/\]/g, '&#93;')
  .replace(/[\\`*_~$|]/g, '\\$&').replace(/\r\n?|\n/g, '<br>');

function code(text: string): string {
  // GFM handles pipes before code spans. HTML entities inside <code> avoid changing
  // literal backslashes and also preserve code that contains both pipes and backticks.
  if (/[|\r\n]/.test(text)) return `<code>${htmlText(text).replace(/\r\n?|\n/g, '<br>')}</code>`;
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(runs.reduce((max, run) => Math.max(max, run.length), 0) + 1);
  const pad = /^`|`$/.test(text) || (/^ .* $/.test(text) && /\S/.test(text)) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

const destination = (href: string) => href.replace(/[\\\s<>|()]/g, (char) => encodeURIComponent(char));

/** A ready-to-insert Markdown table cell. Never escape the assembled markup a second time. */
export function tableCellMarkdown(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return prose(String(node));
  if (Array.isArray(node)) return node.map(tableCellMarkdown).join('');
  if (!isValidElement(node)) return '';
  const props = node.props as Record<string, unknown>;
  const children = props.children as ReactNode;
  const source = props['data-source'];
  if (typeof source === 'string') {
    return props['data-display'] === 'true' ? `\\[${source}\\]` : `\\(${source}\\)`;
  }
  if (node.type === 'code' || ('block' in props && props.block !== true)) return code(tableCellText(children));
  if (node.type === 'br') return '<br>';
  if (typeof props.src === 'string') return `![${prose(String(props.alt ?? ''))}](${destination(props.src)})`;
  const inner = tableCellMarkdown(children);
  if (typeof props.href === 'string') return `[${inner}](${destination(props.href)})`;
  if (!inner) return inner;
  switch (node.type) {
    case 'strong': return `**${inner}**`;
    case 'em': return `*${inner}*`;
    case 'del': return `~~${inner}~~`;
    default: return inner;
  }
}
