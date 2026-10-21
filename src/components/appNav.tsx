import { useNavigate } from 'react-router-dom';
import { Sym, toast, type NavConfig, type NavItem } from '../ui';
import { useCourseChat } from '../store/courseChat';

/**
 * 应用级导航（新会话 / 课程库）的唯一来源。
 *
 * 只有左侧栏一份：宽屏常驻在内容行左边，窄屏由顶栏汉堡按钮弹成 Drawer
 * （见 ui/layout.tsx 的 Sidebar）。**没有底部 tab 栏** —— 它把同一组目的地
 * 用图标再画一遍，信息冗余还白占一条高度。
 *
 * 「设置」不在这里：它是全局弹窗而不是路由，入口由各页面放在顶栏 / 侧栏底部
 * （见 components/SettingsModal.tsx）。
 *
 * 播放页也用这份配置（value='home'：播放页是课程库的下级页面）。
 */
export function useAppNav(active: 'home' | 'chat' | 'study' | 'bot'): NavConfig {
  const navigate = useNavigate();
  const createSession = useCourseChat((s) => s.createSession);
  // 图标只有一套 Lucide 描边字形，选中态靠 ListBox 的选中底色表达 ——
  // MD3 那套「未选中描边、选中实心」在 Lucide 下没有对应字形，硬凑会显得是两个图标集。
  const items: NavItem[] = [
    {
      /**
       * 首项是**动作**（`isAction`）而不是页面：它回答的不是「你在哪」而是
       * 「想不想从头开始」。所以它没有选中态（见 layout.tsx 的 `NavItem.isAction`）。
       *
        * 对话页顶栏也提供相同动作。懒创建让新会话成为零成本：
       * 切草稿态既不落库也不产生垃圾，所以放在侧栏第一格（ChatGPT 的「新对话」位置）
       * 不必付任何代价。见 docs/plans/2026-10-15-懒创建会话-design.md §七。
       */
      value: 'chat',
      label: '新会话',
      isAction: true,
      // 图标仍是「聊天」而不是「加号」：这一格的去处还是对话页，
      // 新会话只是它默认落到的那条（草稿态）会话。
      icon: <Sym name="edit" />,
      /**
       * 先切草稿态、再跳转 —— 顺序无所谓（`createSession` 是同步的 store 方法，
       * 跳转也不会重挂对话页），但两件事缺一不可：
       * 少了 `createSession`，人在会话 X 里点「新会话」会毫无反应（`navigate('/')`
       * 在已经位于 `/` 时是空操作）；少了 `navigate`，在课程库 / 学习页点它就切不回来。
       *
       * 生成中时 `createSession` 也**允许**（2026-10-16 起）：当前那条正在跑的会话被 park 到
       * 后台继续，视图切到新草稿 —— 「等它答，先开一条新的问」是一条正常路径。
       * 不额外做禁用态：导航栏是全应用共用的一份，为「对话正在生成」把它变灰，
       * 等于在课程库页也灰掉一个无关的动作。
       */
      onClick: () => {
        if (active === 'chat' && useCourseChat.getState().activeId == null) toast.info('已在新会话');
        else void createSession();
        navigate('/');
      },
      testId: 'nav-rail-chat',
    },
    {
      value: 'home',
      label: '资料',
      icon: <Sym name="video_library" />,
      onClick: () => navigate('/library'),
      testId: 'nav-rail-home',
    },
    {
      value: 'bot',
      label: 'Bot',
      icon: <Sym name="smart_toy" />,
      onClick: () => navigate('/bot'),
      testId: 'nav-rail-bot',
    },
  ];
  return { value: active, items };
}
