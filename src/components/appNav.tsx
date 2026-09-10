import { useNavigate } from 'react-router-dom';
import type { NavConfig, NavItem } from '../ui';

/**
 * 应用级导航（课程库 / 设置）的唯一来源。
 *
 * 宽屏走左侧 NavigationRail、窄屏走底部 NavigationBar（PageShell 里两者共用这份定义、
 * 由 CSS 控制互斥显隐），只有 testId 前缀不同 —— e2e 需要能分别点到两个 DOM 里的项。
 *
 * 播放页也用 `rail`（value='home'：播放页是课程库的下级页面），
 * 它的 `bottomNav` 位置让给面板切换，见 pages/Player.tsx。
 */
export function useAppNav(active: 'home' | 'settings'): { rail: NavConfig; bottom: NavConfig } {
  const navigate = useNavigate();
  const items = (prefix: string): NavItem[] => [
    {
      value: 'home',
      label: '课程库',
      // MD3 的导航惯例：未选中描边、选中实心
      icon: <mdui-sym-video-library />,
      activeIcon: <mdui-sym-video-library filled />,
      onClick: () => navigate('/'),
      testId: `${prefix}-home`,
    },
    {
      value: 'settings',
      label: '设置',
      icon: <mdui-sym-settings />,
      activeIcon: <mdui-sym-settings filled />,
      onClick: () => navigate('/settings'),
      testId: `${prefix}-settings`,
    },
  ];
  return {
    rail: { value: active, items: items('nav-rail') },
    bottom: { value: active, items: items('nav-bottom') },
  };
}
