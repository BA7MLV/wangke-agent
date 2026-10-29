import crypto from 'node:crypto';
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens, OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpRepository } from './repository.js';

export interface OAuthData {
  tokens?: OAuthTokens;
  client?: OAuthClientInformationMixed;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
  redirectUrl?: string;
  pending?: { state: string; expires: number; used?: boolean };
}
export const oauthFetch: typeof fetch = (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(15000)]) });

export class McpOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: string;
  constructor(private repository: McpRepository, private owner: string, private id: string, private revision: string, private interactive = false) {}
  private data() {
    const server = this.repository.get(this.owner, this.id);
    if (!server || server.revision !== this.revision) throw new Error('mcp_config_changed');
    return server.oauth ?? {};
  }
  private update(fn: (data: OAuthData) => OAuthData) { this.repository.updateOAuth(this.owner, this.id, this.revision, fn); }
  get redirectUrl() { return this.data().redirectUrl; }
  get clientMetadata() { return { client_name: 'DeepStudent Go', redirect_uris: this.redirectUrl ? [this.redirectUrl] : [], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  clientInformation() { return this.data().client; }
  saveClientInformation(client: OAuthClientInformationMixed) { this.update(d => ({ ...d, client })); }
  tokens() { return this.data().tokens; }
  saveTokens(tokens: OAuthTokens) { this.update(d => ({ ...d, tokens })); }
  discoveryState() { return this.data().discovery; }
  saveDiscoveryState(discovery: OAuthDiscoveryState) { this.update(d => ({ ...d, discovery })); }
  state() {
    if (!this.interactive) throw new Error('mcp_oauth_required');
    const state = crypto.randomBytes(32).toString('base64url');
    this.update(d => ({ ...d, pending: { state, expires: Date.now() + 600000 } }));
    return state;
  }
  saveCodeVerifier(verifier: string) { this.update(d => ({ ...d, verifier })); }
  codeVerifier() { const v = this.data().verifier; if (!v) throw new Error('mcp_oauth_state'); return v; }
  redirectToAuthorization(url: URL) {
    if (!this.interactive) throw new Error('mcp_oauth_required');
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('mcp_oauth_failed');
    this.authorizationUrl = url.href;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    this.update(d => scope === 'all' ? { redirectUrl: d.redirectUrl } : { ...d, [scope === 'client' ? 'client' : scope]: undefined });
  }
  async begin(serverUrl: string, redirectUrl: string) {
    this.update(() => ({ redirectUrl }));
    await auth(this, { serverUrl, fetchFn: oauthFetch });
    if (!this.authorizationUrl) throw new Error('mcp_oauth_failed');
    return { authorizationUrl: this.authorizationUrl };
  }
  async complete(serverUrl: string, state: string, code?: string) {
    const pending = this.data().pending;
    if (!pending || pending.used || pending.expires < Date.now() || pending.state !== state) throw new Error('mcp_oauth_state');
    this.update(d => ({ ...d, pending: { ...pending, used: true } }));
    try {
      if (!code || code.length > 8192) throw new Error('mcp_oauth_denied');
      const result = await auth(this, { serverUrl, authorizationCode: code, fetchFn: oauthFetch });
      if (result !== 'AUTHORIZED') throw new Error('mcp_oauth_failed');
    } finally { this.update(d => ({ ...d, pending: undefined, verifier: undefined })); }
  }
  async disconnect() {
    const data = this.data();
    // Local credentials are removed even when the provider has no RFC 7009 endpoint.
    this.repository.resetOAuth(this.owner, this.id);
    const metadata = data.discovery?.authorizationServerMetadata as Record<string, unknown> | undefined;
    const endpoint = metadata?.revocation_endpoint;
    let revoked = false;
    if (typeof endpoint === 'string' && data.tokens && data.client) {
      const body = new URLSearchParams({ token: data.tokens.refresh_token ?? data.tokens.access_token, client_id: data.client.client_id });
      if (data.client.client_secret) body.set('client_secret', data.client.client_secret);
      try { revoked = (await oauthFetch(endpoint, { method: 'POST', body })).ok; } catch { /* Report local-only removal. */ }
    }
    return { revoked };
  }
}
