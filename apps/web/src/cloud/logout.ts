import { serverClient } from '../api/serverClient';
import { confirmDialog } from '../ui/feedback';
import { flushCloud, stopCloud, useCloudSync } from './sync';

/** 所有登出入口共用：先同步，失败或仍有待同步改动时让用户决定。 */
export async function logoutCloud(): Promise<void> {
  let flushed = true;
  try { await flushCloud(); } catch { flushed = false; }
  if ((!flushed || useCloudSync.getState().pending > 0)
    && !await confirmDialog({ headline: '还有改动没有同步', description: '现在退出会丢失这些改动。', confirmText: '仍然退出', danger: true })) return;
  await serverClient.logout();
  stopCloud();
}
