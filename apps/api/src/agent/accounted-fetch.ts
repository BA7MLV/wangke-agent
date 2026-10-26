import type { CloudProvider } from '../../../../packages/contracts/src/cloud.js';
import { UsageLedger, type RequestAttribution } from './budget.js';
import { modelUsage } from './model-client.js';

/** Instrument the existing learning/proxy protocol implementation rather than
 * adding a second converter or counting parent and child requests twice. */
export function accountedFetch(ledger: UsageLedger, base: Omit<RequestAttribution, 'provider' | 'model'>, providers: CloudProvider[], fetcher: typeof fetch): typeof fetch {
  let attempt = 0;
  return async (url, init) => {
    const endpoint = String(url);
    const provider = providers.find(p => endpoint.startsWith(`${p.baseUrl}/`) && /\/(chat\/completions|responses|messages)$/.test(endpoint));
    if (!provider) return fetcher(url, init);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { model?: string; max_tokens?: number; max_output_tokens?: number } : undefined;
    if (!body || typeof body.model !== 'string') throw new Error('model_attribution_missing');
    const id = ledger.reserve({ ...base, provider: provider.id, model: body.model }, ++attempt, Math.ceil(String(init?.body).length / 2) + Math.max(4096, Number(body.max_output_tokens ?? body.max_tokens) || 4096));
    try {
      const response = await fetcher(url, init);
      if (!response.ok) { ledger.settle(id, `http_${response.status}`); return response; }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        let usage;
        try { usage = modelUsage(await response.clone().json()); } catch { /* unknown remains reserved */ }
        ledger.settle(id, 'completed', usage);
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
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split('\n'); pending = lines.pop()!.slice(-65536);
          for (const line of lines) observe(line);
          controller.enqueue(chunk);
        },
        flush() { observe(pending + decoder.decode()); ledger.settle(id, 'completed', usage); },
      }));
      // Interrupted streams retain an inflight/unknown reservation, including
      // process death, rather than advertising zero consumption.
      return new Response(observed, { status: response.status, headers: response.headers });
    } catch (error) { ledger.settle(id, 'network_unknown'); throw error; }
  };
}
