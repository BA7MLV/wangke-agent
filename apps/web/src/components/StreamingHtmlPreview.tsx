import { useLayoutEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import { splitStreamingHtml } from '../utils/streamingHtml';
import './streaming-html-preview.css';

/**
 * The preview is deliberately a static, main-document rendering.
 *
 * It is not the final widget: scripts, styles, SVG, URLs and event handlers
 * are removed here.  This makes every intermediate frame safe even when the
 * JSON argument is only half written.  Once the tool call passes validation,
 * `WidgetBlock` replaces this preview with the existing isolated iframe.
 */
interface Props {
  html: string;
  /** Show the live-generation indicator. Tool previews use the default. */
  isStreaming?: boolean;
  /** Accessible status shown while a normal assistant HTML answer is parsing. */
  statusText?: string;
}

const ALLOWED_TAGS = [
  'a', 'article', 'aside', 'b', 'blockquote', 'br', 'button', 'caption', 'code', 'col',
  'colgroup', 'dd', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'label', 'li', 'main',
  'ol', 'option', 'p', 'pre', 'select', 'small', 'span', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'tr', 'ul',
];

const ALLOWED_ATTR = [
  'alt', 'checked', 'colspan', 'disabled', 'for', 'height', 'href', 'name', 'placeholder',
  'rowspan', 'selected', 'start', 'target', 'title', 'type', 'value', 'width',
];

const SANITIZE_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  FORBID_TAGS: ['base', 'embed', 'form', 'iframe', 'link', 'meta', 'object', 'script', 'style', 'svg', 'template'],
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
};

/** A DOM patcher: frozen blocks are appended once; only the live tail is replaced. */
class StreamingHtmlRenderer {
  private stableRawLength = 0;
  private stableSafeHTML = '';
  private liveHTML = '';

  constructor(private readonly frozen: HTMLElement, private readonly live: HTMLElement) {}

  update(source: string): void {
    // A new tool call may reuse the same component instance.  Resetting is
    // safer than trying to reconcile two unrelated streams.
    if (source.length < this.stableRawLength) {
      this.stableRawLength = 0;
      this.stableSafeHTML = '';
      this.liveHTML = '';
      this.frozen.replaceChildren();
      this.live.replaceChildren();
    }

    // Security invariant: sanitize the complete accumulated stream first.
    // A dangerous token may start in one network chunk and finish in another.
    // `cleanSource` is never assigned to innerHTML; it is only parsed into
    // nodes after this step.
    const cleanSource = sanitizeHtml(source);
    const { stableEnd } = splitStreamingHtml(source);
    const cleanStable = sanitizeHtml(source.slice(0, stableEnd));

    if (!cleanSource.startsWith(cleanStable)) {
      // Extremely unusual parser normalization can make a fragment differ
      // from the same prefix in the complete document.  Render the safe full
      // snapshot as the live tail rather than risk duplication or omission.
      this.stableRawLength = 0;
      this.stableSafeHTML = '';
      this.frozen.replaceChildren();
      this.live.replaceChildren(parseSafeFragment(cleanSource, true));
      this.liveHTML = cleanSource;
      return;
    }

    if (!cleanStable.startsWith(this.stableSafeHTML)) {
      // DOMPurify normally keeps a completed top-level block byte-stable.  If
      // a browser/version normalizes it differently, prefer a safe full
      // snapshot over appending a potentially misaligned fragment.
      this.stableRawLength = 0;
      this.stableSafeHTML = '';
      this.frozen.replaceChildren();
    }
    if (cleanStable.length > this.stableSafeHTML.length) {
      const delta = cleanStable.slice(this.stableSafeHTML.length);
      const safe = parseSafeFragment(delta, true);
      if (safe) this.frozen.appendChild(safe);
      this.stableSafeHTML = cleanStable;
    }
    this.stableRawLength = stableEnd;

    const liveHTML = cleanSource.slice(cleanStable.length);
    if (liveHTML !== this.liveHTML) {
      this.live.replaceChildren(parseSafeFragment(liveHTML, true));
      this.liveHTML = liveHTML;
    }
  }
}

export default function StreamingHtmlPreview({
  html,
  isStreaming = true,
  statusText = '正在生成交互图形',
}: Props) {
  const frozenRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<StreamingHtmlRenderer | null>(null);
  const rafRef = useRef<number | null>(null);
  const latestHTML = useRef(html);

  latestHTML.current = html;

  useLayoutEffect(() => {
    const frozen = frozenRef.current;
    const live = liveRef.current;
    if (!frozen || !live) return;
    rendererRef.current ??= new StreamingHtmlRenderer(frozen, live);

    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      rendererRef.current?.update(latestHTML.current);
    });

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [html]);

  return (
    <div
      className="md-embedded-ui widget-stream-preview"
      data-testid="widget-stream-preview"
      aria-busy={isStreaming || undefined}
    >
      {isStreaming && (
        <div className="widget-stream-preview__status" role="status" aria-live="polite">
          <span className="widget-stream-preview__dot" aria-hidden="true" />
          {statusText}
        </div>
      )}
      <div ref={frozenRef} className="widget-stream-preview__frozen" />
      <div ref={liveRef} className="widget-stream-preview__live" />
    </div>
  );
}

function sanitizeHtml(raw: string): string {
  return DOMPurify.sanitize(raw, SANITIZE_CONFIG);
}

function parseSafeFragment(raw: string, alreadySanitized = false): DocumentFragment {
  const clean = alreadySanitized ? raw : sanitizeHtml(raw);
  const parsed = new DOMParser().parseFromString(clean, 'text/html');

  // DOMPurify handles script/event-attribute removal.  This second pass is a
  // network boundary: intermediate previews must never fetch a remote image
  // or navigate through a model-provided URL.
  const elements = parsed.body.querySelectorAll<HTMLElement>('*');
  for (const element of elements) {
    element.removeAttribute('class');
    element.removeAttribute('id');
    element.removeAttribute('style');
    const src = element.getAttribute('src');
    if (src && !/^data:image\/(?:gif|jpe?g|png|webp);base64,/i.test(src)) element.removeAttribute('src');
    const href = element.getAttribute('href');
    if (href && !/^(?:#|mailto:|https:\/\/)/i.test(href)) element.removeAttribute('href');
    if (href && /^https:\/\//i.test(href)) {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
  }

  const fragment = document.createDocumentFragment();
  while (parsed.body.firstChild) fragment.appendChild(parsed.body.firstChild);
  return fragment;
}
