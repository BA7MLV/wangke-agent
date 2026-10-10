/**
 * 实时链路 host 侧运行时状态。
 *
 * 两个取舍：
 *
 * 1. **code 走 persist，relay 地址不放这里**：host 刷新页面后凭同一个 code 重连，
 *    中继给 60 秒宽限期。宽限期内回来 guest 会**自动恢复**（闪一下「重连中」再重新
 *    拉取，全程不用手动操作）—— 但**不是「无感」**：host 断开那一刻中继就向全体
 *    guest 广播 host-link-down，恢复时再补发 host-link-up，两半都有提示
 *    （设计不变量 7：host 消失必须被显式感知）。relay 地址在 settings 里 ——
 *    它要过同步白名单那套归类（`NON_SYNC_SETTINGS_KEYS`），与「这一份共享本身」
 *    的状态不是一回事。反过来 `enabled` 也**不**持久化：刷新后自动恢复共享等于
 *    无感知共享，本地优先工具的用户对这件事零容忍，重新开共享必须由人再拨一次开关。
 * 2. **rotate 先 disable 再 enable**：旧 code 的连接必须真的断掉再建新的 ——
 *    换码不断链的话，拿着旧码的连接仍然有效，轮换就失去意义（想踢掉某台设备时
 *    尤其：新码发了，旧的还连在上面）。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useSettings } from '../store/settings';
import { LiveHost } from './host';

export interface GuestInfo { id: string }

interface LiveLinkState {
  enabled: boolean;
  /** 配对码（中继的 room 名）。唯一持久化的字段，理由见文件头取舍 1 */
  code: string;
  guests: GuestInfo[];
  status: 'off' | 'connecting' | 'online' | 'error';
  error: string;
  enable: () => void;
  disable: () => void;
  rotate: () => void;
}

/** host 实例：模块级单例。stop() 之后置 null，下一次 enable 时重建。 */
let host: LiveHost | null = null;

/** 8 位配对码：去掉易混淆字符（0/O/1/I），朗读与手输都友好 */
function newCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export const useLiveLink = create<LiveLinkState>()(
  persist(
    (set, get) => ({
      enabled: false,
      code: '',
      guests: [],
      status: 'off',
      error: '',
      enable: () => {
        const relay = useSettings.getState().liveRelay.trim();
        if (!relay) {
          set({ error: '先填中继地址（部署 live-relay 后得到）' });
          return;
        }
        const code = get().code || newCode();
        host?.stop();
        host = new LiveHost({
          relayUrl: relay,
          code,
          events: {
            onGuests: (guests) => set({ guests }),
            // 连上就清掉上一次的失败原因；没连上时原样留着 —— onerror 之后
            // onclose 会紧跟而来，那一刻 status 已被改写成 off，只剩 error
            // 还记着「为什么没连上」，UI 文案靠它说事。
            onStatus: (status) => set({ status, error: status === 'online' ? '' : get().error }),
            onError: (msg) => set({ status: 'error', error: msg }),
          },
        });
        // start() 是同步的，其中会同步回调 onStatus('connecting')
        host.start();
        set({ enabled: true, code, error: '' });
      },
      disable: () => {
        host?.stop();
        host = null;
        // error 一起清：开关都关了，还留着一条红字只会让人以为共享还在进行
        set({ enabled: false, guests: [], status: 'off', error: '' });
      },
      rotate: () => {
        const next = newCode();
        get().disable();
        set({ code: next });
        get().enable();
      },
    }),
    {
      name: 'wangke-livelink',
      // 只持久化 code：enabled / guests / status / error 都是这一份共享的运行事实，
      // 把它们写进 localStorage 等于替用户决定「刷新后继续共享」。
      partialize: (s): Pick<LiveLinkState, 'code'> => ({ code: s.code }),
    },
  ),
);
