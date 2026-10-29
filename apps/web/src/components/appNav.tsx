import { useLocation, useNavigate } from 'react-router-dom';
import { Sym, type NavConfig, type NavItem } from '../ui';
import { useCourseChat } from '../store/courseChat';
import { useBotPanel } from '../store/botPanel';
import { focusChatComposer } from './chatComposerFocus';

/**
 * 应用级导航的唯一来源：宽屏常驻左侧栏，窄屏由顶栏汉堡按钮弹成 Drawer
 * （见 ui/layout.tsx 的 Sidebar）。没有底部 tab 栏。
 *
 * 主页永远是对话。Bot 入口放在「资源」下面，打开对话页右侧的辅助栏，
 * 不是另一个独立页面（见 pages/CourseChat.tsx 与 store/botPanel.ts）。
 * 「设置」也不在这里：它是全局弹窗，入口在侧栏底部。
 */
export function useAppNav(): NavConfig {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const createSession = useCourseChat((s) => s.createSession);
  const activeId = useCourseChat((s) => s.activeId);
  const botOpen = useBotPanel((s) => s.open);
  const chatPage = ['/', '/chat', '/course-chat'].includes(pathname) || pathname.startsWith('/settings');
  const value = chatPage ? (botOpen ? 'bot' : activeId == null ? 'home' : '')
    : /^\/(library|player)(\/|$)/.test(pathname) ? 'resources' : '';
  const items: NavItem[] = [
    {
      // 主页就是待输入的新会话；后台生成和已有草稿仍沿用会话 store 的保留规则。
      value: 'home',
      label: '主页',
      icon: <Sym name="home" />,
      onClick: () => {
        void createSession();
        useBotPanel.getState().setOpen(false);
        navigate('/');
        focusChatComposer();
      },
      testId: 'nav-rail-chat',
    },
    {
      value: 'resources',
      label: '资源',
      icon: <Sym name="video_library" />,
      to: '/library',
      testId: 'nav-rail-home',
    },
    {
      value: 'bot',
      label: 'Bot',
      icon: <Sym name="smart_toy" />,
      onClick: () => {
        useBotPanel.getState().setOpen(true);
        navigate('/');
      },
      testId: 'nav-rail-bot',
    },
  ];
  return { value, items };
}
