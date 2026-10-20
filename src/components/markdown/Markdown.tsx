import { lazy, memo, Suspense, useMemo } from 'react';
import { XMarkdown, type ComponentProps, type XMarkdownProps } from '@ant-design/x-markdown';
import { protectMath } from './math';
import { MarkdownStreamingProvider } from './streaming';
import { SourceImage, SourceImageLink } from '../MaterialImage';
import { markdownSanitizeConfig } from './sanitize';
import './markdown.css';

const MathFormula = lazy(() => import('./MathFormula'));

function IncompleteInline(props: ComponentProps) {
  let text = String(props['data-raw'] ?? '');
  try { text = decodeURIComponent(text); } catch { /* Keep malformed input readable. */ }
  // Keep the label visible while withholding incomplete URLs/images from the DOM.
  if (text.startsWith('![')) return <span>{text.slice(2).split(']')[0]}</span>;
  if (text.startsWith('[')) return <span>{text.slice(1).split(']')[0]}</span>;
  if (text.startsWith('`')) return <code>{text.replace(/^`+|`+$/g, '')}</code>;
  const marker = /^(\*{1,3}|_{1,3})/.exec(text)?.[0];
  if (marker) {
    const body = text.slice(marker.length).replace(/[*_]+$/, '');
    return marker.length > 1 ? <strong>{body}</strong> : <em>{body}</em>;
  }
  return <span>{text}</span>;
}

const SHARED_COMPONENTS = {
  img: SourceImage,
  a: SourceImageLink,
  'math-formula': Formula,
  'incomplete-link': IncompleteInline,
  'incomplete-image': IncompleteInline,
  'incomplete-emphasis': IncompleteInline,
  'incomplete-inline-code': IncompleteInline,
};

function Formula(props: ComponentProps) {
  const display = props['data-display'] === 'true';
  const pending = props['data-pending'] === 'true';
  const source = String(props['data-source'] ?? '');
  const fallback = <span className="md-math-pending" aria-label="公式生成中">⋯</span>;
  return <span className={display ? 'md-math md-math--display' : 'md-math'} aria-busy={pending}>
    {pending ? fallback : <Suspense fallback={fallback}><MathFormula source={source} display={display} /></Suspense>}
  </span>;
}

/** Shared rendering contract for streamed answers, history, explanations and materials. */
export const Markdown = memo(function Markdown({ components, streaming, content, children, dompurifyConfig, ...props }: XMarkdownProps) {
  const source = content ?? children ?? '';
  const hasNextChunk = !!streaming?.hasNextChunk;
  const protectedContent = useMemo(() => protectMath(source, hasNextChunk), [source, hasNextChunk]);
  const mergedComponents = useMemo(() => ({ ...SHARED_COMPONENTS, ...components }), [components]);
  const sanitizeConfig = useMemo(() => markdownSanitizeConfig(dompurifyConfig), [dompurifyConfig]);
  return (
    <MarkdownStreamingProvider value={hasNextChunk}>
      <XMarkdown
        {...props}
        dompurifyConfig={sanitizeConfig}
        // Prose defaults must stop at embedded host UI (editor, preview, diagram).
        // markdown.css supplies the same defaults without descendant-style leaks.
        disableDefaultStyles
        content={protectedContent}
        components={mergedComponents}
        streaming={streaming}
      />
    </MarkdownStreamingProvider>
  );
});
