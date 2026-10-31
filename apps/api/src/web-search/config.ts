import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfiguration } from '../cloud/config.js';
import { safeWebUrl, type WebSearchConfig, type SearchProvider } from '@wangke/contracts/web-search';

export class WebSearchError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export class WebSearchConfiguration {
  constructor(private store: DatabaseStore, private credentials: CloudConfiguration) {}
  get(owner: string, secrets = false): WebSearchConfig {
    const row = this.store.db.prepare('SELECT value,revision FROM web_search_config WHERE owner_id=?').get(owner) as { value: string; revision: string } | undefined;
    const config: WebSearchConfig = row ? { ...JSON.parse(this.credentials.open(row.value)), revision: row.revision }
      : { revision: '0', enabled: false, fetchEnabled: false, providerId: '', fallback: false, providers: [] };
    if (!secrets) config.providers = config.providers.map(({ apiKey, ...p }) => ({ ...p, configured: Boolean(apiKey) }));
    return config;
  }
  save(owner: string, input: WebSearchConfig) {
    return this.store.transaction(() => {
      const previous = this.get(owner, true);
      if (!input || input.revision !== previous.revision) throw new WebSearchError('web_config_conflict', 409);
      if (typeof input.enabled !== 'boolean' || typeof input.fetchEnabled !== 'boolean' || typeof input.fallback !== 'boolean' || typeof input.providerId !== 'string' || !Array.isArray(input.providers) || input.providers.length > 12) throw new WebSearchError('web_invalid_config');
      const ids = new Set<string>();
      const providers: SearchProvider[] = input.providers.map(p => {
        if (!p || typeof p.id !== 'string' || !/^[\w-]{1,64}$/.test(p.id) || ids.has(p.id) || !['tavily', 'brave', 'searxng'].includes(p.kind) || typeof p.enabled !== 'boolean' || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80) throw new WebSearchError('web_invalid_config');
        ids.add(p.id);
        const old = previous.providers.find(row => row.id === p.id);
        let baseUrl: string | undefined;
        if (p.kind === 'searxng') {
          const valid = safeWebUrl(p.baseUrl);
          if (!valid) throw new WebSearchError('web_invalid_url');
          const url = new URL(valid);
          if (url.search || url.hash) throw new WebSearchError('web_invalid_url');
          baseUrl = url.href.replace(/\/+$/, '');
        }
        // Endpoint/type changes never carry a credential to a new destination.
        const apiKey = p.apiKey === undefined ? (old?.kind === p.kind && old?.baseUrl === baseUrl ? old.apiKey ?? '' : '') : p.apiKey;
        if (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new WebSearchError('web_invalid_config');
        if (p.enabled && p.kind !== 'searxng' && !apiKey.trim()) throw new WebSearchError('web_key_required');
        return { id: p.id, kind: p.kind, name: p.name.trim(), enabled: p.enabled, ...(baseUrl ? { baseUrl } : {}), apiKey: apiKey.trim() };
      });
      if (input.enabled && !providers.some(p => p.id === input.providerId && p.enabled)) throw new WebSearchError('web_provider_required');
      const config = { enabled: input.enabled, fetchEnabled: input.fetchEnabled, fallback: input.fallback, providerId: input.providerId, providers };
      this.store.db.prepare('INSERT INTO web_search_config(owner_id,value,revision) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET value=excluded.value,revision=excluded.revision')
        .run(owner, this.credentials.seal(JSON.stringify(config)), crypto.randomUUID());
      this.credentials.audit(owner, 'websearch.configured', { enabled: config.enabled, providerIds: providers.map(p => p.id) });
      return this.get(owner);
    });
  }
}
