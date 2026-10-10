import { useLiveLink } from '../livelink/store';
import './live-share-bar.css';

/**
 * 实时共享常驻指示条。
 *
 * 为什么必须常驻、而不是只放在设置页里：**「正在共享」藏在设置页二级里等于没有** ——
 * 本地优先工具的用户对无感知共享零容忍（设计不变量 5）。host 一开共享，任何页面上方
 * 都有一条消不掉的提示（只能主动点「停止」），已连接设备数也实时跟着变。
 *
 * 布局上的关键约束（.live-share-host 那层为什么存在）见同名样式文件顶部注释。
 */
export default function LiveShareBar() {
  // 按字段订阅而不是整 store：guest 每次 hello/bye 都会换 guests 数组，
  // 整 store 订阅会让用不到的字段变化也触发重渲染。
  const active = useLiveLink((s) => s.enabled && s.status === 'online');
  const guestCount = useLiveLink((s) => s.guests.length);
  const disable = useLiveLink((s) => s.disable);
  if (!active) return null;
  return (
    <div className="live-share-bar" data-testid="live-share-bar" role="status">
      <span className="live-share-bar__text" data-testid="live-share-text">
        正在共享给 {guestCount} 台设备 · 主机下线即链路中断
      </span>
      <mdui-button
        variant="text"
        className="live-share-bar__stop"
        data-testid="live-share-stop"
        onClick={disable}
      >
        停止
      </mdui-button>
    </div>
  );
}
