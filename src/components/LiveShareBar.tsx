import { Button } from '@heroui/react';
import { useLiveLink } from '../livelink/store';
import './live-share-bar.css';

/**
 * 实时共享常驻指示条。
 *
 * 为什么必须常驻、而不是只放在设置页里：**「正在共享」藏在设置页二级里等于没有** ——
 * 本地优先工具的用户对无感知共享零容忍（设计不变量 5）。host 一开共享，任何页面上方
 * 都有一条消不掉的提示（只能主动点「停止」），已连接设备数也实时跟着变。
 *
 * ⚠️ 显示条件是 `enabled` 而**不是** `enabled && status === 'online'`（终审 L）：
 * 「开着但没连上」（中继地址填错 / connecting / 连接已断）恰恰是最需要提示的状态，
 * 而原条件在那几种状态下整条消失 —— 用户以为没在共享，其实开关还开着，数据面已经
 * 不可用也没人知道。所以只要 enabled 就常驻，文案按 status 区分。
 *
 * 布局上的关键约束（.live-share-host 那层为什么存在）见同名样式文件顶部注释。
 */
export default function LiveShareBar() {
  // 按字段订阅而不是整 store：guest 每次 hello/bye 都会换 guests 数组，
  // 整 store 订阅会让用不到的字段变化也触发重渲染。
  const enabled = useLiveLink((s) => s.enabled);
  const status = useLiveLink((s) => s.status);
  const guestCount = useLiveLink((s) => s.guests.length);
  const error = useLiveLink((s) => s.error);
  const disable = useLiveLink((s) => s.disable);
  if (!enabled) return null;
  return (
    <div className="live-share-bar" data-testid="live-share-bar" role="status">
      <span className="live-share-bar__text" data-testid="live-share-text">
        {shareText(status, guestCount, error)}
      </span>
      <Button
        variant="tertiary"
        size="sm"
        className="live-share-bar__stop"
        data-testid="live-share-stop"
        onPress={disable}
      >
        停止
      </Button>
    </div>
  );
}

/**
 * 四种状态四种实话。**没有一种状态允许说「没事」**：这条横幅的存在本身就是隐私
 * 承诺，文案只负责说清「现在通不通、guest 能不能看到内容」。
 */
function shareText(status: 'off' | 'connecting' | 'online' | 'error', guests: number, error: string): string {
  switch (status) {
    case 'online':
      return `正在共享给 ${guests} 台设备 · 主机下线即链路中断`;
    case 'connecting':
      return '实时链路连接中…（连上之前 guest 看不到任何内容）';
    case 'error':
    default:
      // status 'off' 既可能是「连上过又断了」也可能是「从来没连上」。store 的
      // onError 在被 onclose 改写成 off 之前会把原因留在 error 里，带得上就说清
      // 原因（典型：中继地址填错），带不上才说「已断开」。
      return error
        ? `连接失败：${error} · guest 现在看不到任何内容`
        : '连接已断开，guest 现在看不到任何内容 · 点「停止」关闭共享';
  }
}
