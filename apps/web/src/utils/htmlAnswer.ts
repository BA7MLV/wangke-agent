import DOMPurify from 'dompurify';

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
