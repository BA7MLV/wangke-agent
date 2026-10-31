import { WEB_TOOLS, type WebSearchResult } from '@wangke/contracts/web-search';
import { WebSearchConfiguration, WebSearchError } from './config.js';
import { boundedText, normalizeSources, searchAdapters } from './providers.js';
import { fetchPage } from './fetch.js';

export function webError(error: unknown): WebSearchError {
  return error instanceof WebSearchError ? error : new WebSearchError(error instanceof Error && error.name === 'TimeoutError' ? 'web_timeout' : 'web_request_failed', 502);
}
export class WebSearchService {
  private active = new Map<string, number>();
  constructor(readonly configuration: WebSearchConfiguration, private fetcher: typeof fetch = fetch) {}
  definitions(owner: string, network: boolean) {
    if (!network) return [];
    const config = this.configuration.get(owner);
    return WEB_TOOLS.filter(t => t.function.name === 'websearch' ? config.enabled && config.providers.some(p => p.id === config.providerId && p.enabled) : config.fetchEnabled);
  }
  async call(owner: string, name: string, args: Record<string, unknown>, signal: AbortSignal, permitted: () => boolean) {
    if (!permitted()) throw new WebSearchError('web_network_denied', 403);
    if ((this.active.get(owner) ?? 0) >= 4) throw new WebSearchError('web_busy', 429);
    this.active.set(owner, (this.active.get(owner) ?? 0) + 1);
    const scoped = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
    try {
      const config = this.configuration.get(owner, true);
      if (name === 'webfetch' && config.fetchEnabled) {
        if (!args || Object.keys(args).some(k => k !== 'url')) throw new WebSearchError('web_invalid_arguments');
        const result = await fetchPage(args.url, scoped, this.fetcher);
        if (!permitted() || !this.configuration.get(owner).fetchEnabled) throw new WebSearchError('web_network_denied', 403);
        return result;
      }
      if (name !== 'websearch' || !config.enabled) throw new WebSearchError('web_disabled', 403);
      if (!args || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000 || Object.keys(args).some(k => !['query', 'limit'].includes(k))) throw new WebSearchError('web_invalid_arguments');
      const query = args.query.trim(), limit = args.limit ?? 6;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 8) throw new WebSearchError('web_invalid_arguments');
      const preferred = config.providers.find(p => p.id === config.providerId && p.enabled);
      if (!preferred) throw new WebSearchError('web_provider_required');
      const providers = [preferred, ...(config.fallback ? config.providers.filter(p => p.enabled && p.id !== preferred.id) : [])];
      const started = Date.now(); let failure: WebSearchError = new WebSearchError('web_request_failed', 502);
      for (const provider of providers) {
        scoped.throwIfAborted();
        if (!permitted() || this.configuration.get(owner).revision !== config.revision) throw new WebSearchError('web_config_conflict', 409);
        try {
          const adapter = searchAdapters[provider.kind], request = adapter.request(provider, query, limit);
          const response = await this.fetcher(request.url, { ...request.init, redirect: 'error', signal: AbortSignal.any([scoped, AbortSignal.timeout(12000)]) });
          if (!response.ok) {
            await response.body?.cancel();
            throw new WebSearchError(response.status === 429 ? 'web_rate_limited' : [401, 403].includes(response.status) ? 'web_auth_failed' : 'web_provider_failed', response.status);
          }
          let body: unknown;
          try { body = JSON.parse(await boundedText(response, 512000)); } catch (error) { throw error instanceof WebSearchError ? error : new WebSearchError('web_invalid_response', 502); }
          const result: WebSearchResult = { kind: 'web_search', query, provider: provider.name, sources: normalizeSources(adapter.results(body), limit), durationMs: Date.now() - started };
          if (!permitted() || this.configuration.get(owner).revision !== config.revision) throw new WebSearchError('web_config_conflict', 409);
          return result;
        } catch (error) {
          scoped.throwIfAborted(); failure = webError(error);
          // Only transient failures are eligible for the explicitly enabled fallback.
          if (!['web_request_failed', 'web_timeout', 'web_rate_limited', 'web_provider_failed'].includes(failure.code) || ![429, 500, 502, 503, 504].includes(failure.status)) throw failure;
        }
      }
      throw failure;
    } catch (error) { signal.throwIfAborted(); throw webError(error); }
    finally { const count = (this.active.get(owner) ?? 1) - 1; if (count) this.active.set(owner, count); else this.active.delete(owner); }
  }
}
