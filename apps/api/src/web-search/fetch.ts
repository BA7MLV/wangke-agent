import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import ipaddr from 'ipaddr.js';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { safeWebUrl, type WebFetchResult } from '@wangke/contracts/web-search';
import { WebSearchError } from './config.js';
import { boundedText } from './providers.js';

export function publicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function publicUrl(raw: unknown): URL {
  const value = safeWebUrl(raw);
  if (!value) throw new WebSearchError('web_invalid_url');
  const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.port && !['80', '443'].includes(url.port) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isIP(host) && !publicAddress(host)) throw new WebSearchError('web_address_denied', 403);
  return url;
}
/** Check DNS in the connection lookup itself: no validation/connection rebinding gap. */
const dispatcher = new Agent({ connections: 4, connect: { timeout: 10000,
  lookup(hostname, options, callback) {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) { callback(error, '', 4); return; }
      if (!addresses.length || addresses.some(row => !publicAddress(row.address))) { callback(new WebSearchError('web_address_denied', 403), '', 4); return; }
      const filtered = options.family ? addresses.filter(row => row.family === options.family) : addresses;
      if (!filtered.length) { callback(new Error('web_dns_failed'), '', 4); return; }
      if (options.all) callback(null, filtered);
      else callback(null, filtered[0].address, filtered[0].family);
    });
  },
} });
export async function fetchPage(raw: unknown, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<WebFetchResult> {
  let url = publicUrl(raw);
  for (let hop = 0; hop <= 4; hop++) {
    const response = await fetcher(url.href, { redirect: 'manual', signal, headers: { accept: 'text/html, text/plain, application/json', 'user-agent': 'Wangke-WebReader/1.0' }, dispatcher } as RequestInit);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || hop === 4) throw new WebSearchError('web_redirect_failed', 502);
      url = publicUrl(new URL(location, url).href); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new WebSearchError(response.status === 429 ? 'web_rate_limited' : 'web_fetch_failed', 502); }
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (!['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/json', 'text/xml', 'application/xml'].includes(type)) { await response.body?.cancel(); throw new WebSearchError('web_unsupported_content'); }
    let content = await boundedText(response, 1_000_000), title = url.hostname;
    if (['text/html', 'application/xhtml+xml'].includes(type)) {
      const { document } = parseHTML(content);
      for (const element of document.querySelectorAll('script,style,noscript,iframe,form')) element.remove();
      title = document.title || title;
      const fallback = document.body.textContent ?? '';
      const article = new Readability(document, { maxElemsToParse: 20000, disableJSONLD: true }).parse();
      content = article?.textContent || fallback;
      title = article?.title || title;
    }
    content = content.replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!content) throw new WebSearchError('web_empty_page', 502);
    return { kind: 'web_fetch', url: url.href, title: title.slice(0, 300), content: content.slice(0, 16000), truncated: content.length > 16000 };
  }
  throw new WebSearchError('web_redirect_failed', 502);
}
