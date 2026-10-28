import type { CloudProvider } from '@wangke/contracts/cloud';
import { BudgetBlocked, UsageLedger, type RequestAttribution } from './budget.js';
import { modelUsage } from './model-client.js';
import { boundedRequest, checkRequestCapacity } from './request-budget.js';

/** Instrument the existing learning/proxy protocol implementation rather than
 * adding a second converter or counting parent and child requests twice. */
export function accountedFetch(ledger: UsageLedger, base: Omit<RequestAttribution, 'provider' | 'model'>, providers: CloudProvider[], fetcher: typeof fetch): typeof fetch {
  let attempt = 0;
  return async (url, init) => {
    if (!base.run) return fetcher(url, init); // Ordinary non-Bot traffic is unchanged.
    const endpoint = String(url);
    const modelEndpoint = /\/(chat\/completions|responses|messages)$/.test(new URL(endpoint).pathname);
    const provider = providers.find(p => endpoint.startsWith(`${p.baseUrl}/`) && modelEndpoint);
    if (!provider) { if (modelEndpoint) throw new Error('model_attribution_missing'); return fetcher(url, init); }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { model?: string; max_tokens?: number; max_output_tokens?: number } : undefined;
    if (!body || typeof body.model !== 'string') throw new Error('model_attribution_missing');
    const model = ledger.model(base.owner, { providerId: provider.id, model: body.model });
    const request = boundedRequest(body, endpoint, model.outputTokens);
    checkRequestCapacity(request.total, Math.min(model.contextTokens, ledger.limits(base.owner, base.run).contextTokens));
    const attribution = { ...base, provider: provider.id, model: body.model };
    const id = ledger.reserve(attribution, ++attempt, request.total);
    try {
      const response = await fetcher(url, { ...init, body: JSON.stringify(request.body) });
      ledger.checkAdmission(attribution);
      if (!response.ok) { ledger.settle(id, `http_${response.status}`); return response; }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        let usage;
        try { usage = modelUsage(await response.clone().json()); } catch { /* unknown remains reserved */ }
        if (ledger.settle(id, 'completed', usage)) throw new BudgetBlocked('model_usage_exceeded_reservation');
        ledger.checkAdmission(attribution);
        return response;
      }
      let usage: ReturnType<typeof modelUsage>, pending = '';
      let anthropicUsage: Record<string, unknown> | undefined;
      const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      const observe = (line: string) => {
        if (!line.startsWith('data: ')) return;
        try {
          const event = object(JSON.parse(line.slice(6)));
          if (!event) return;
          usage = modelUsage(event) ?? modelUsage(event.response) ?? usage;
          if (event.type === 'message_start') anthropicUsage = object(object(event.message)?.usage);
          if (event.type === 'message_delta' && anthropicUsage) usage = modelUsage({ usage: { ...anthropicUsage, ...object(event.usage) } }) ?? usage;
        } catch { /* [DONE] and vendor events */ }
      };
      const decoder = new TextDecoder();
      const observed = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          ledger.checkAdmission(attribution);
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split('\n'); pending = lines.pop()!.slice(-65536);
          for (const line of lines) observe(line);
          controller.enqueue(chunk);
        },
        flush() { observe(pending + decoder.decode()); if (ledger.settle(id, 'completed', usage)) throw new BudgetBlocked('model_usage_exceeded_reservation'); ledger.checkAdmission(attribution); },
      }));
      // Interrupted streams retain an inflight/unknown reservation, including
      // process death, rather than advertising zero consumption.
      return new Response(observed, { status: response.status, headers: response.headers });
    } catch (error) { ledger.settle(id, 'network_unknown'); throw error; }
  };
}
