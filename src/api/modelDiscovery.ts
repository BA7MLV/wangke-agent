import { ApiError, listModels } from './siliconflow';
import { modelListCacheKey, writeModelList, type ModelListConnection } from './modelListCache';

interface Pending {
  controller: AbortController;
  promise: Promise<string[]>;
  users: number;
}
const pending = new Map<string, Pending>();

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function fetchModels(connection: ModelListConnection, signal: AbortSignal): Promise<string[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await listModels(connection, signal);
    } catch (error) {
      signal.throwIfAborted();
      const transient = error instanceof TypeError || (error instanceof ApiError
        && [408, 429, 500, 502, 503, 504].includes(error.status));
      // GET 最多重试一次；认证/权限/格式错误不重试。总耗时仍受 20 秒期限约束。
      if (!transient || attempt >= 1) throw error;
      const delay = error instanceof ApiError ? error.retryAfterMs : undefined;
      await wait(delay ?? 500 + Math.random() * 500, signal);
    }
  }
}

/** 同一连接共享请求；最后一个订阅者离开时取消。超时覆盖所有分页及响应体读取。 */
export async function discoverModels(connection: ModelListConnection, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const key = await modelListCacheKey(connection);
  signal.throwIfAborted();
  let request = pending.get(key);
  if (!request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('拉取模型列表超时，请重试', 'TimeoutError')), 20_000);
    const entry: Pending = { controller, users: 0, promise: Promise.resolve([]) };
    entry.promise = fetchModels(connection, controller.signal)
      .then((ids) => {
        controller.signal.throwIfAborted();
        writeModelList(key, ids);
        return ids;
      })
      .catch((error) => { throw controller.signal.aborted ? controller.signal.reason : error; })
      .finally(() => {
        clearTimeout(timer);
        if (pending.get(key) === entry) pending.delete(key);
      });
    pending.set(key, entry);
    request = entry;
  }
  const shared = request;
  shared.users++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback: () => void) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', abort);
      shared.users--;
      if (shared.users === 0 && pending.get(key) === shared) {
        pending.delete(key);
        shared.controller.abort();
      }
      callback();
    };
    const abort = () => finish(() => reject(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    shared.promise.then((ids) => finish(() => resolve(ids)), (error) => finish(() => reject(error)));
  });
}
