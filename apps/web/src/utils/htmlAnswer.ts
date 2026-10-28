import DOMPurify from 'dompurify';

/** Only for WidgetBlock's opaque sandbox. Never insert this result into the host DOM. */
export function prepareInteractiveHtml(source: string): string {
  // Template contents are inert (including resource loading). Do not parse executable works
  // into the host document or a resource-loading detached document before the iframe CSP exists.
  const template = document.createElement('template');
  const fragment = template.content;
  // An HTML parsing context retains head/body attributes (notably body onload),
  // unlike template.innerHTML's fragment context, which discards those wrappers.
  const root = fragment.ownerDocument.createElement('html');
  fragment.append(root);
  root.innerHTML = source;
  // Remove document-level redirects/embeddings, not scripts or event handlers.
  for (const element of fragment.querySelectorAll('meta,base,iframe,object,embed')) element.remove();
  for (const element of fragment.querySelectorAll('*')) {
    for (const attr of ['href', 'xlink:href', 'action', 'formaction', 'target', 'download']) {
      // Keep stylesheet dependencies visible to CSP diagnostics instead of silently dropping them.
      if (element.tagName === 'LINK' && attr === 'href') continue;
      const value = element.getAttribute(attr);
      if (value != null && !(attr === 'href' && value.startsWith('#'))) element.removeAttribute(attr);
    }
  }
  // The iframe parser merges body attributes into its shell; its CSP/bridge always comes first.
  return root.innerHTML;
}

/** Styles are only safe here because the result is rendered in WidgetBlock's opaque iframe, never the host DOM. */
export function sanitizeHtmlAnswer(source: string): string {
  const clean = DOMPurify.sanitize(source, {
    ADD_TAGS: ['style'],
    FORCE_BODY: true,
    FORBID_TAGS: ['script', 'meta', 'base', 'link', 'iframe', 'object', 'embed', 'form', 'template'],
    FORBID_ATTR: ['srcset', 'action', 'formaction', 'autofocus', 'target', 'download'],
    ALLOW_DATA_ATTR: false,
  });
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  for (const element of doc.querySelectorAll('*')) {
    // CSP blocks remote resources, but navigation needs its own boundary.
    for (const attr of ['href', 'xlink:href', 'src']) {
      const value = element.getAttribute(attr);
      if (value != null && !(attr === 'src' ? /^data:image\/(?:gif|jpe?g|png|webp);base64,/i.test(value) : value.startsWith('#')))
        element.removeAttribute(attr);
    }
  }
  // DOMParser moves leading <style> nodes into <head>; do not drop them again.
  return doc.head.innerHTML + doc.body.innerHTML;
}
