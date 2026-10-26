/** Keep setup credentials in the fragment, never in the HTTP query string. */
export function readBootstrapLink(href: string): { secret: string; cleanHref: string } {
  const url = new URL(href);
  const separator = url.hash.indexOf('?');
  if (separator < 0 || url.hash.slice(0, separator) !== '#/setup') return { secret: '', cleanHref: href };
  const params = new URLSearchParams(url.hash.slice(separator + 1));
  if (!params.has('secret')) return { secret: '', cleanHref: href };
  const secret = params.get('secret') ?? '';
  params.delete('secret');
  const query = params.toString();
  url.hash = `/setup${query ? `?${query}` : ''}`;
  return { secret, cleanHref: url.href };
}

export function consumeBootstrapLink(location: Pick<Location, 'href'>, history: Pick<History, 'state' | 'replaceState'>): string {
  const { secret, cleanHref } = readBootstrapLink(location.href);
  if (cleanHref !== location.href) history.replaceState(history.state, '', cleanHref);
  return secret;
}
