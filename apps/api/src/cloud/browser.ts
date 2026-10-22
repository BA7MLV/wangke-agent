import crypto from 'node:crypto';
import type { CloudTask } from '../../../../packages/contracts/src/cloud.js';
import type { TaskContext } from './execution.js';
import { workerTokens } from './workerAuth.js';

/** Compatibility executor. Keep browser-only rendering and not-yet-ported flows here. */
export async function executeBrowserTask(context: TaskContext, origin: string) {
  if (process.env.CLOUD_BROWSER_DISABLED === '1') throw new Error('该任务尚需浏览器兼容执行器，当前已禁用');
  context.checkActive();
  const token = crypto.randomBytes(32).toString('base64url');
  workerTokens.set(token, { id: context.owner, taskId: context.task.id });
  let browser: import('playwright').Browser | undefined;
  const abort = () => { void browser?.close().catch(() => {}); };
  context.signal.addEventListener('abort', abort, { once: true });
  try {
    const { chromium } = await import('playwright');
    context.checkActive();
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
    context.checkActive();
    const pageContext = await browser.newContext({ serviceWorkers: 'block' });
    await pageContext.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) return route.abort();
      return route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } });
    });
    const page = await pageContext.newPage();
    await page.goto(`${origin}/?cloud-worker=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => typeof (window as any).__runCloudTask === 'function', undefined, { timeout: 120_000 });
    return await page.evaluate(async (task: CloudTask) => (window as any).__runCloudTask(task), context.task);
  } finally {
    context.signal.removeEventListener('abort', abort);
    workerTokens.delete(token);
    await browser?.close().catch(() => {});
  }
}
