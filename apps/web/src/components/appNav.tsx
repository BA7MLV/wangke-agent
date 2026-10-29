import { useNavigate } from 'react-router-dom';
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
export function useAppNav(active: 'home' | 'chat' | 'study' | 'projects'): NavConfig {
  const navigate = useNavigate();
  const createSession = useCourseChat((s) => s.createSession);
  const botActive = useBotPanel((s) => active === 'chat' && s.open);
  const items: NavItem[] = [
    {
      /**
       * 首项是动作而不是页面（`isAction`，没有选中态）：它回答「想不想从头开始」。
       *
       * 懒创建让新会话零成本：切到草稿态既不落库也不留空会话。已经在草稿里时
       * 不弹提示，直接把焦点交给输入框 —— 用户点「新会话」就是想开始打字。
       * 生成中也允许：当前那条被 park 到后台继续跑。
       */
      value: 'chat',
      label: '新会话',
      isAction: true,
      icon: <Sym name="edit" />,
      onClick: () => {
        void createSession();
        navigate('/');
        focusChatComposer();
      },
      testId: 'nav-rail-chat',
    },
    {
      value: 'home',
      label: '资源',
      icon: <Sym name="video_library" />,
      onClick: () => navigate('/library'),
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
  return { value: botActive ? 'bot' : active, items };
}
