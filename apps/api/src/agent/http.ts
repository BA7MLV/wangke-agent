import { Agent, type Dispatcher } from 'undici';

// Node fetch otherwise has a hidden five-minute headers/body deadline. These
// requests are already bounded by caller AbortSignals; keep connection setup
// bounded separately and leave other application HTTP traffic untouched.
const dispatcher = new Agent({ connect: { timeout: 10_000 }, headersTimeout: 0, bodyTimeout: 0 })
  .compose(dispatch => (options, handler) => dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler));

export function agentHttpInit(init: RequestInit & { signal: AbortSignal }): RequestInit & { dispatcher: Dispatcher } {
  return { ...init, dispatcher };
}
