import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Dropdown,
  EmptyState as HeroEmptyState,
  ListBox,
  ScrollShadow,
  Separator,
  Typography,
} from '@heroui/react';
import { Sym } from './icons';
import { toast } from './feedback';
import { useRailCollapsed } from './rail';
import './layout.css';

/**
 * 侧栏的显隐断点。宽屏常驻侧栏、窄屏改由 Drawer 承载，这条查询是 tsx 里
 * 唯一决定「哪套导航在生效」的地方（样式侧对应 Tailwind 的 `min-[901px]:`）。
 */
const NARROW_QUERY = '(max-width: 900px)';

/** 窄屏（侧栏改由抽屉承载的那一档）。断点变了要重渲染，否则顶栏按钮语义会错。 */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    setNarrow(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/**
 * 应用外壳：宽屏左侧导航栏 + 顶部标题栏 + 内容区；窄屏顶栏汉堡按钮弹出侧栏抽屉。
 *
 * 版式全部由 HeroUI 组件（ListBox / Button / Drawer / ScrollShadow / Separator）
 * 与 Tailwind 工具类表达，配色只读 HeroUI 语义令牌（bg-surface-secondary / text-muted /
 * border-border / bg-accent-soft …），**不再有自写的类名与样式表** —— 换主题时
 * 侧栏、顶栏、内容列会跟着令牌一起变，不需要逐条改 CSS。
 *
 * 侧栏宽屏可折叠、窄屏走抽屉，两条路径各只有一个入口：
 *   - 宽屏：顶栏那颗 `panel_left`，收起是**整块隐藏**、内容区铺满（不另做图标窄条态 ——
 *     收成窄条要额外一整套收起态样式，而内容一窄对阅读页反而更差）；
 *   - 窄屏：顶栏汉堡，弹 Drawer。
 * 折叠状态见 `ui/rail.ts`（全局一份 + 记本机）。
 *
 * 结构：
 *   .page（--vvh 满高，flex column）
 *     └ .app-shell（flex row，flex-1，min-h-0）
 *         ├ 侧栏（宽屏常驻，收起时不渲染；窄屏 CSS 隐藏，改由 Drawer 承载）
 *         └ .app-shell__main（flex column，flex-1，min-w-0）
 *             ├ .app-bar（顶部标题栏）
 *             └ .page-main（flex-1，滚动容器）
 *                 └ .page-inner（内容列：narrow / wide / fill 三档）
 *
 * **只有一份导航 DOM**：窄屏把同一个 `<Sidebar>` 渲染进 Drawer，宽屏直接就地渲染。
 */

export interface NavItem {
  /** 与 `NavConfig.value` 比对来决定哪一项高亮 */
  value: string;
  label: string;
  /** 图标（放 <Sym>） */
  icon: ReactNode;
  onClick: () => void;
  testId?: string;
  /**
   * 这一项是**动作**（「新会话」）而不是目的地，因此**永不进入选中态**。
   *
   * 导航栏里混一个动作是刻意的：它是这一页唯一的「从头开始」入口，和别的项长得
   * 一样（同一套圆角 pill 与 hover），但「选中」对它没有意义 —— 高亮的含义是
   * 「你现在在哪」，而动作不是一个地方。所以它被排除在 `selectedKeys` 之外：
   * 点它不留下高亮，草稿态下侧栏也不会出现「好像选中了新会话」的假象。
   *
   * 换句话说，侧栏里回答「你在哪」的只有两处：其余导航项（课程库 / 学习）与
   * Recent 里那条当前会话。见 docs/plans/2026-10-15-懒创建会话-design.md §七。
   */
  isAction?: boolean;
}

export interface NavConfig {
  items: NavItem[];
  value: string;
  /** 页面目的地与页内面板切换采用不同的选中语义。 */
  mode?: 'navigation' | 'panels';
  label?: string;
}

/** 侧栏 Recent 行尾菜单里的一个动作（重命名 / 归档 / 置顶 / 删除） */
export interface RecentAction {
  /** 菜单项 id。同一行的 key 要互不相同 —— Menu 的选中态与 `onAction` 都认它 */
  key: string;
  label: string;
  icon: ReactNode;
  onAction: () => void;
  /** 危险动作：文字染 danger 色。只有破坏性的动作该置位 */
  danger?: boolean;
  /** 禁用（如正在生成，store 会拒绝） */
  isDisabled?: boolean;
}

/** 侧栏「Recent」分组里的历史项（会话等），与主导航项结构不同：没有图标库约定，只有气泡图标 */
export interface RecentItem {
  id: string;
  label: string;
  onClick: () => void;
  testId?: string;
  /** 当前正在看的那一条。为 true 时渲染成高亮 pill（见 Sidebar 里 Recent 的说明） */
  active?: boolean;
  /**
   * 行尾菜单的动作。传了就渲染那颗「更多」按钮，并接上右键。
   *
   * 行尾**只留这一颗图标**：四个动作都配图标的话，一行里四颗等权重的图标
   * 紧贴标题，行尾没有重心、标题还被挤成省略号。集中进菜单之后，
   * 那一颗「更多」就是整行唯一的动作锚点。
   *
   * 两个入口（宽屏右键 / 点按钮）**锚在同一个位置**（那颗按钮下方）：
   * 同一个菜单因入口不同而落在不同地方，比「它没跟着我的右键出现」更难适应。
   * 见 docs/plans/2026-10-15-recent-会话操作菜单-design.md §1。
   */
  menu?: RecentAction[];
  /**
   * 删除这一项。传了就允许 Delete / Backspace 快捷键删掉这一行
   * （行尾按钮 Tab 走不到，键盘用户需要别的路径），以及让菜单里能出现「删除」。
   *
   * ⚠️ 菜单**必须**挡掉指针事件冒泡：ListBox.Item 的选中走的是 `useOption`
   * 挂在行根上的 pointerdown，冒泡上来就会「顺手把这条会话也切过去」，
   * 于是点删除变成「切过去 + 删掉」，用户看到的是列表突然少了一项、
   * 当前会话也被换掉了 —— 一次点击做了两件事，其中一件用户没要。
   */
  onDelete?: () => void;
  /** 删除按钮的无障碍标签，如「删除会话 XXX」 */
  deleteLabel?: string;
  /** 删除按钮的测试选择器 */
  deleteTestId?: string;
  /** 删除按钮禁用（如正在生成，store 会拒绝删除） */
  deleteDisabled?: boolean;
}

export interface PageShellProps {
  /** 顶部标题栏标题 */
  title: string;
  /** 标题下方的小字副标题（showcase 里是「Updated Just now」这类状态行） */
  subtitle?: ReactNode;
  /** 传了就显示返回按钮（左上角，回调里自己 navigate） */
  onBack?: () => void;
  /** 标题栏右侧操作区 */
  actions?: ReactNode;
  /** 内容区收窄并居中（表单页用） */
  narrow?: boolean;
  /** 内容区放宽并居中（列表页用）；与 narrow 互斥 */
  wide?: boolean;
  /**
   * 内容区**不滚动也不加内边距**，由页面自己接管整块空间（播放页 / 对话页用）。
   * 默认的内容列是「有内边距、随内容增高、由滚动容器滚」，
   * 而这类页面要的是「整块铺满 + 内部面板各自滚动」，两者必须二选一。
   */
  fill?: boolean;
  /**
   * 挂到根节点上的 **callback ref**。
   * 传 callback ref 而不是 RefObject，是因为根节点可能晚于数据出现。
   */
  rootRef?: (el: HTMLDivElement | null) => void;
  /** 追加到根节点上的类名（页面级的样式挂载点） */
  rootClassName?: string;
  /** 宽屏左侧导航。窄屏由 CSS 隐藏，此时导航走顶栏汉堡按钮弹出的 Drawer。 */
  rail?: NavConfig;
  /** 侧栏 Recent 分组（会话列表等）。传了就渲染这一段 */
  recent?: { label: string; items: RecentItem[] };
  /** 侧栏底部自定义按钮（如「设置」入口） */
  railFooter?: ReactNode;
  children: ReactNode;
}

/**
 * 量出每一行标题的溢出宽度，写进 `--recent-shift` / `--recent-duration`，
 * 供 `.recent-title > span` 的跑马灯动画使用（见 layout.css）。
 *
 * 位移量取决于内容宽度，CSS 自己算不出来，只能量一遍。量在 `.recent-title`
 * 的 **inline style** 上：它是裁剪容器，`scrollWidth - clientWidth` 就是要滑的距离。
 * 超宽才写（负值），没超宽就清掉 —— 缺省 0 时动画原地不动，于是只有超长标题会滚。
 */
function measureRecentTitles(wrap: HTMLElement | null) {
  wrap?.querySelectorAll<HTMLElement>('.recent-title').forEach((title) => {
    const distance = title.scrollWidth - title.clientWidth;
    if (distance > 1) {
      title.style.setProperty('--recent-shift', `-${distance}px`);
      // 按距离定速（约 40px/s），长标题才不会滚得飞快；夹在 2.5~8s 之间
      title.style.setProperty('--recent-duration', `${Math.min(8, Math.max(2.5, distance / 40)).toFixed(2)}s`);
    } else {
      title.style.removeProperty('--recent-shift');
      title.style.removeProperty('--recent-duration');
    }
  });
}

/** 侧栏内部：主导航 / Recent / 底部入口。宽屏就地渲染，窄屏进 Drawer。 */
function Sidebar({
  rail,
  recent,
  railFooter,
  navigationId,
  onNavigate,
}: {
  rail: NavConfig;
  recent?: { label: string; items: RecentItem[] };
  railFooter?: ReactNode;
  navigationId: string;
  /** 窄屏点完就该收起抽屉，否则菜单盖住刚打开的页面 */
  onNavigate?: () => void;
}) {
  /**
   * 键盘当前停在 Recent 的哪一行。
   *
   * 只为 Delete / Backspace 快捷键认人：React Aria 的 ListBox 把整组当成**一个**
   * tab 停靠点，行内嵌的按钮 Tab 根本走不到（实测 Tab 直接从列表跨到下一个区域），
   * 所以键盘用户没有别的路径去删某一条。
   *
   * 靠行自己的 `onFocus` 记账而不是读 `document.activeElement`：焦点随时可能被
   * 移出列表，读 DOM 只能读到「此刻」，读不到「本来停在谁身上」。
   */
  const [focusedRecentId, setFocusedRecentId] = useState<string | null>(null);
  /**
   * 当前开着行尾菜单的那一行。
   *
   * 做成**受控**（每行的 `Dropdown.Root` 都受控）而不是让 Menu 自己管：
   * 右键发生在**整行**上，而 HeroUI 3.2.6 没有 `ContextMenu`，
   * RAC 的 `MenuTrigger` 也只在 `trigger="contextMenu"` 档才接 `contextMenuProps` ——
   * 那一档会把点击开菜单的 `pressProps` 整个换掉，两种入口没法共存。
   * 于是自己收一个 id：右键时 `setMenuId(item.id)`，菜单照样锚在那颗「更多」上。
   */
  const [menuId, setMenuId] = useState<string | null>(null);
  /**
   * 承载 Recent 列表的那层 div，用来量标题的溢出宽度（跑马灯要滑多远）。
   *
   * 量测依赖「标题指纹」而不是 `recent.items` 本身：后者每次 render 都是新数组，
   * 拿它当 `useEffect` 依赖等于**每次 render 都重排一遍**（`scrollWidth` 会强制同步布局）。
   */
  const recentWrapRef = useRef<HTMLDivElement | null>(null);
  const recentTitleKey = recent ? recent.items.map((item) => `${item.id}\u0000${item.label}`).join('\u0001') : '';
  useEffect(() => {
    const wrap = recentWrapRef.current;
    if (!wrap) return;
    measureRecentTitles(wrap);
    // 宽度会变：侧栏收起 / 展开、窗口缩放、字体晚到 —— 尺寸一变就要重算滑动距离
    const observer = new ResizeObserver(() => measureRecentTitles(wrap));
    observer.observe(wrap);
    document.fonts?.ready.then(() => measureRecentTitles(wrap)).catch(() => {});
    return () => observer.disconnect();
  }, [recentTitleKey]);

  return (
    <>
      {/* 这里曾经有一块「身份块」（头像 + 网课学习助手 + 本机课程库 · N 门课程），
          是照着 showcase 截图加的，落地当天被用户否掉、连 `railIdentity` prop 一起删了。
          侧栏第一屏该是导航，不是一句自我介绍 —— 一句话说清的东西不值得占一行。
          见 docs/plans/2026-10-14-对话页改版-design.md §2.3。 */}

      {/* 导航用 ListBox 而不是一堆 <button>：选中态、键盘上下键、aria-current
          全由 React Aria 处理，手写 button 这三样都得自己补，而补齐之前往往漏了后两样。

          ⚠️ 跳转必须挂在 `onSelectionChange` 上，**不能**用 `onAction`：
          `onAction` 只在键盘 Enter/Space 那类「激活」动作里触发，鼠标单击一个
          ListBoxItem 走的是「选择」路径，onAction 根本不响 —— 症状是侧栏点了没反应
          且不报错。`onSelectionChange` 才是选中语义的入口。

          点「已经选中的那一项」时 keys 会是空的（RAC 把它当成取消选中），
          此时 hit 为 undefined，但抽屉仍然要收起，所以 onNavigate 放在条件之外。 */}
      <ListBox
        id={navigationId}
        aria-label="主导航"
        selectionMode="single"
        /* 动作项（`NavItem.isAction`，当前是「新会话」）不进 `selectedKeys`：
           它不是「一个地方」，高亮对它不成立。剩下的项里只有与 `rail.value`
           相符的那一项高亮 —— 首页传的 `value='chat'` 因此不会点亮任何东西，
           这是对的：首页在草稿态时本来就没有「在哪」。见 `NavItem.isAction`。 */
        selectedKeys={rail.items.filter((it) => !it.isAction && it.value === rail.value).map((it) => it.value)}
        onSelectionChange={(keys) => {
          const next = [...keys][0];
          const hit = next == null ? undefined : rail.items.find((it) => it.value === String(next));
          hit?.onClick();
          onNavigate?.();
        }}
        className="gap-0.5"
      >
        {rail.items.map((it) => (
          <ListBox.Item
            key={it.value}
            id={it.value}
            textValue={it.label}
            data-testid={it.testId}
            /* 「当前在哪一项」由 ListBox 自己的 `aria-selected` 承担。
               试过再挂一个 `aria-current="page"`（语义上更贴导航），但 React Aria 的
               ListBoxItem 会把非它管理的 aria 属性滤掉 —— 实测 DOM 上根本不出现，
               留着只会让后来的人以为它在生效。 */
            className="min-h-9 gap-2.5 rounded-full px-2.5 text-sm font-medium text-muted data-[hovered=true]:bg-background data-[selected=true]:bg-accent-soft data-[selected=true]:font-medium data-[selected=true]:text-accent-soft-foreground"
          >
            <span className="grid size-5 shrink-0 place-items-center" aria-hidden="true">
              {it.icon}
            </span>
            <span className="min-w-0 truncate">{it.label}</span>
          </ListBox.Item>
        ))}
      </ListBox>

      {recent && recent.items.length > 0 && (
        <>
          <Separator className="my-3" />
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 px-2.5 pb-2 text-[0.8125rem] text-muted">{recent.label}</div>
            {/* ScrollShadow：会话多起来时滚动区上下缘浮出阴影，比给整块侧栏加边框轻。
                min-h-0 必需 —— 否则 flex 子项的默认 min-height:auto 会让它按内容撑开，
                flex-1 形同虚设。 */}
            <ScrollShadow
              className="min-h-0 flex-1 overflow-y-auto"
              size={28}
              offset={2}
              hideScrollBar
              orientation="vertical"
            >
              {/* Recent 也是 ListBox，而不是一列 <Button>。
                  改之前它没有任何选中态：**当前正在看的会话和别的会话长得一模一样**，
                  会话一多就分不清自己看的是哪一条。换成 ListBox 顺带拿到上下键导航与
                  `aria-selected`，和上面的主导航同一套做法。

                  `disallowEmptySelection` 必需：RAC 把「再点一次已选中项」当成取消选中，
                  不设它的话点当前会话会把高亮弄没，而页面并没有切走。

                  选中态用 `bg-surface` 而不是主导航的 `bg-accent-soft`：
                  导航项是「目的地」，会话项是「同一目的地下的一个实例」，两处都用主色
                  会让人以为侧栏里同时选中了两处。

                  ⚠️ 也不能用看起来更对味的 `bg-default`（中性灰）：浅色主题下
                  `--default` 与侧栏底色是**同一个值**（实测两处都是 oklch(0.94) / #ebebeb），
                  高亮会彻底看不见 —— 同一个坑在用户气泡上踩过一次（见 course-chat.css
                  的 `.course-chat__bubble--user`）。`--surface` 浅色是纯白、深色是
                  oklch(0.21)，两套主题下都与侧栏分得开。 */}
              <div
                ref={recentWrapRef}
                /**
                 * Delete / Backspace = 删掉键盘当前停着的这一行。
                 * ContextMenu / Shift+F10 = 打开这一行的动作菜单（ARIA 规定的
                 * 「打开上下文菜单」键 —— 只给右键不给它，右键菜单对键盘用户就不存在）。
                 *
                 * 挂在**外层普通 div** 而不是 ListBox 上：RAC 的 ListBoxRoot 用
                 * `filterDOMProps(props, {global:true})` 过滤透传属性，`onKeyDown`
                 * 不在白名单里 —— 写上去类型就报错，骗过类型运行期也会被丢掉。
                 * 按键事件是冒泡的，挂在祖先上照样收得到。
                 *
                 * 为什么需要它：行尾那颗「更多」按钮 Tab 走不到（ListBox 是复合控件，
                 * 整组只占一个 tab 停靠点），键盘用户否则只剩「删当前会话」一个入口，
                 * 而「清理 Recent 里那几条旧的」删的恰恰不是当前这条。
                 *
                 * 只认 Delete：焦点在列表上不在输入框，两个键都留着只会让人猜。
                 * 没停在任何一行、或那一行不可删时**不吞**这个键。
                 */
                onKeyDown={(event) => {
                  const target = recent.items.find((item) => item.id === focusedRecentId);
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    if (!target?.menu) return;
                    event.preventDefault();
                    setMenuId(menuId === target.id ? null : target.id);
                    return;
                  }
                  if (event.key !== 'Delete' && event.key !== 'Backspace') return;
                  if (!target?.onDelete || target.deleteDisabled) return;
                  event.preventDefault();
                  target.onDelete();
                }}
              >
                <ListBox
                  aria-label={recent.label}
                  selectionMode="single"
                  disallowEmptySelection
                  selectedKeys={recent.items.filter((item) => item.active).map((item) => item.id)}
                  onSelectionChange={(keys) => {
                    const next = [...keys][0];
                    if (next == null) return;
                    recent.items.find((item) => item.id === String(next))?.onClick();
                    onNavigate?.();
                  }}
                  className="gap-px pr-1"
                >
                  {recent.items.map((item) => (
                    <ListBox.Item
                      key={item.id}
                      id={item.id}
                      textValue={item.label}
                      data-testid={item.testId}
                      onFocus={() => setFocusedRecentId(item.id)}
                      /* 右键整行开菜单。preventDefault 挡掉浏览器自带的上下文菜单 ——
                         不挡的话用户的右键永远看到浏览器的菜单，我们的入口等于没有。 */
                      onContextMenu={
                        item.menu
                          ? (event) => {
                              event.preventDefault();
                              setMenuId(item.id);
                            }
                          : undefined
                      }
                      className="recent-item group min-h-9 gap-2.5 rounded-full px-2.5 text-[0.8125rem] font-normal text-muted data-[hovered=true]:bg-background data-[selected=true]:bg-surface data-[selected=true]:font-medium data-[selected=true]:text-foreground"
                    >
                      <span className="grid size-4 shrink-0 place-items-center text-sm" aria-hidden="true">
                        <Sym name="chat_bubble" />
                      </span>
                      {/* 标题：平时省略号；鼠标停在**整行**上（或键盘焦点进来）时像跑马灯那样
                          自己滚开，看全了来回滑 —— 不用手动去拨。滑动距离由外层 effect 量好后
                          写进 `--recent-shift`（见 layout.css 与 `measureRecentTitles`）。
                          为什么不用 title 属性：iOS Safari 不显示原生 tooltip，而 iPad 是主力平台 ——
                          触屏上的兜底是「重命名对话框里能看到全文」。
                          见 docs/plans/2026-10-15-流式续传与分支-design.md §5。 */}
                      <span className="recent-title min-w-0">
                        <span>{item.label}</span>
                      </span>
                      {item.menu && (
                        /**
                         * 挡冒泡的壳：见 `RecentItem.onDelete` 的注释。
                         * 停的是 pointerdown / mousedown / click 三种 —— React Aria 的
                         * `useSelectableItem` 按下与点击判定各走一个事件，少停一个就会漏。
                         *
                         * 刻意**不**停 focus：ListBox 是复合控件，行上的 `data-focused`
                         * 是上面那几个快捷键（Delete / ContextMenu）认「停在哪一行」的判据，
                         * 按钮把焦点抢走这条判据就会跟着错。
                         */
                        <span
                          className="ml-auto shrink-0"
                          onPointerDown={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Dropdown.Root
                            isOpen={menuId === item.id}
                            onOpenChange={(open) => setMenuId(open ? item.id : null)}
                          >
                            <Dropdown.Trigger
                              /* `Dropdown.Trigger` 包的是 RAC 的 Button，不是 HeroUI 的
                                 Button —— `isIconOnly` / `variant` / `size` 那些属性不存在，
                                 尺寸与配色只能自己给类名。 */
                              /* 显形规则：宽屏**只认鼠标悬停这一行**。
                                 刻意不给「键盘焦点行」「当前选中行」两个例外 ——
                                 那颗按钮 Tab 走不到（ListBox 是复合控件，整组只占一个
                                 tab 停靠点），让它跟着焦点显形等于摆一颗看得见点不到的
                                 按钮；键盘用户真正的入口是 ContextMenu / Shift+F10
                                 开菜单、Delete 直接删（见上面 `focusedRecentId` 的注释）。

                                 窄屏常驻（`max-[900px]`）：触屏没有 hover，藏起来这个
                                 入口就不存在了。见 docs/plans/2026-10-15-recent-会话操作菜单-design.md §3.1。

                                 菜单开着的那一行例外常驻：菜单锚在这颗按钮上，
                                 锚点跟着鼠标移开而隐身，会变成「菜单浮在空气里」。 */
                              className={[
                                'grid size-6 place-items-center rounded-md text-muted transition-opacity',
                                'data-[hovered=true]:bg-background data-[hovered=true]:text-foreground',
                                menuId === item.id
                                  ? 'opacity-100'
                                  : 'opacity-0 group-hover:opacity-100 max-[900px]:opacity-100',
                              ].join(' ')}
                              aria-label={`${item.label} 的更多操作`}
                              data-testid={`${item.testId ?? item.id}-menu-trigger`}
                            >
                              <Sym name="more_vert" />
                            </Dropdown.Trigger>
                            <Dropdown.Popover>
                              <Dropdown.Menu
                                onAction={(key) => {
                                  item.menu?.find((action) => action.key === String(key))?.onAction();
                                }}
                              >
                                {item.menu.map((action) => (
                                  <Dropdown.Item
                                    key={action.key}
                                    id={action.key}
                                    textValue={action.label}
                                    isDisabled={action.isDisabled}
                                    className={
                                      action.danger
                                        ? 'text-danger data-[hovered=true]:bg-danger/10'
                                        : undefined
                                    }
                                    data-testid={`${item.testId ?? item.id}-menu-${action.key}`}
                                  >
                                    {/* 菜单项图标：menu-item 的行高只够一个 1em 的字形，
                                        撑大字号会把整行顶高。 */}
                                    <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">
                                      {action.icon}
                                    </span>
                                    {action.label}
                                  </Dropdown.Item>
                                ))}
                              </Dropdown.Menu>
                            </Dropdown.Popover>
                          </Dropdown.Root>
                        </span>
                      )}
                    </ListBox.Item>
                  ))}
                </ListBox>
              </div>
            </ScrollShadow>
          </div>
        </>
      )}

      {railFooter && (
        <div className="mt-2.5 shrink-0 border-t border-border pt-2">
          {/* 导航项由 ListBox 自带的 `p-1`（`.list-box { padding: var(--spacing) }`）
              往内缩了 4px，底部的设置项也在同一列里，得跟着缩同样的距离，
              否则它的图标会比上面每一项都多探出 4px。分隔线仍铺满，只缩内容。 */}
          <div className="px-1">{railFooter}</div>
        </div>
      )}
    </>
  );
}

export function PageShell({
  title,
  subtitle,
  onBack,
  actions,
  narrow,
  wide,
  fill,
  rootRef,
  rootClassName,
  rail,
  recent,
  railFooter,
  children,
}: PageShellProps) {
  /** 窄屏抽屉开合。宽屏不渲染抽屉，所以不需要额外判宽度。 */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isNarrow = useIsNarrow();
  /** 宽屏侧栏收起。全局一份（ui/rail.ts），所以跨页面切过去时侧栏状态不会跳。 */
  const [railCollapsed, toggleRail] = useRailCollapsed();
  const shellId = useId();
  const titleId = `${shellId}-title`;
  const mainId = `${shellId}-main`;
  const navigationId = `${shellId}-navigation`;

  /**
   * 顶栏浮在滚动内容之上后，内容要自己让出它的高度（见下面 `<header>` 的注释）。
   *
   * 高度**不是常量**：刘海安全区、可选副标题、右侧控件都可能把它撑高，写死一个数
   * 必然在某档上对不齐。所以量一遍 `offsetHeight` 写进主列的 `--app-bar-h`，
   * 由 `.page-shell__content` 与各 fill 页面消费；量到之前用 CSS 里的 60px 兜底。
   *
   * 直接写 DOM 内联样式而不是挂 state：顶栏高度在一次会话里几乎不变，
   * 为它重渲整棵页面树不值当（同 `measureRecentTitles` 的取舍）。
   */
  const barRef = useRef<HTMLElement | null>(null);
  const mainColRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const bar = barRef.current;
    const col = mainColRef.current;
    if (!bar || !col) return;
    const sync = () => col.style.setProperty('--app-bar-h', `${bar.offsetHeight}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  // 抽屉展开时锁住背景滚动，否则手指在遮罩边缘滑动会连带滚背后的内容
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  // 宽屏切到窄屏时抽屉本来就没开，反向切换时收起抽屉，避免回到宽屏后遮罩还在
  useEffect(() => {
    if (!isNarrow) setDrawerOpen(false);
  }, [isNarrow]);

  /**
   * 内容列最大宽度挂在根节点上，只由内容区消费（顶栏不再跟着避让，
   * 见 `<header>` 的注释）。页面可以自己覆盖（如库页的 `page-library` 把它放宽到 1360px）。
   */
  const contentMax = narrow ? '[--page-content-max:720px]' : wide ? '[--page-content-max:960px]' : '';
  const rootClass = [
    'flex h-[var(--vvh,100%)] flex-col overflow-hidden bg-background-secondary text-foreground',
    contentMax,
    rootClassName,
  ]
    .filter(Boolean)
    .join(' ');

  const innerClass = fill
    ? 'flex min-h-0 flex-1 flex-col'
    : narrow || wide
      ? 'page-shell__content mx-auto w-full max-w-[var(--page-content-max,100%)] px-5 pb-5'
      : 'page-shell__content w-full px-5 pb-5';

  return (
    <div className={rootClass} ref={rootRef}>
      <a
        href={`#${mainId}`}
        data-testid="skip-link"
        className="absolute top-2 left-4 z-100 -translate-y-[calc(100%+16px)] rounded-full bg-accent px-[18px] py-2.5 text-sm text-accent-foreground no-underline focus-visible:translate-y-0"
        onClick={(event) => {
          // HashRouter 拥有 URL 的 hash；跳过导航只移动焦点，不触发路由。
          event.preventDefault();
          document.getElementById(mainId)?.focus();
        }}
      >
        跳到主要内容
      </a>
      <div className="flex min-h-0 flex-1 items-stretch">
        {/* 收起时**整块不渲染**，而不是留着 display:none —— 侧栏里是会话列表，
            一屏几十条，留一棵看不见的 DOM 只会让 Tab 顺序凭空多出几十站。 */}
        {rail && !railCollapsed && (
          <nav
            className="hidden w-[16.5rem] shrink-0 flex-col gap-1 bg-background-secondary p-3 text-foreground min-[901px]:flex"
            data-testid="nav-rail"
            aria-label="主导航"
          >
            <Sidebar
              rail={rail}
              recent={recent}
              railFooter={railFooter}
              navigationId={navigationId}
            />
          </nav>
        )}
        <div ref={mainColRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <header
            ref={barRef}
            data-testid="top-app-bar"
            /**
             * 顶栏**浮在滚动内容之上**（`absolute`），不再是流内的一个兄弟节点。
             *
             * 这是「渐进模糊」能成立的前提：内容必须能滚到它背后。原先顶栏在流里占
             * 60px，`<main>` 从它下面才开始滚 —— 那样无论给顶栏加多重的
             * `backdrop-filter`，它背后永远只有一片同色画布，模糊是看不见的。
             *
             * 内容因此要让位：高度量进主列的 `--app-bar-h`，普通页由
             * `.page-shell__content` 消费，fill 页各自消费（见下方 `PageShell` 顶部的注释）。
             *
             * 左内边距**恒为 `px-5`**，所有页面同一档 —— 标题一律贴左上角。
             *
             * 原先横屏（`landscape:`）那条
             * `max(env(safe-area-inset-left), 20px, calc((100% - var(--page-content-max)) / 2 + 20px))`
             * 是想让标题与**居中内容列**的左缘同线。问题是 `--page-content-max`
             * 每个页面各给各的（库页 1360px / 学习页 960px / 对话页铺满），
             * 于是同一颗标题在不同页面上落在完全不同的横坐标上：
             * 实测 1440 视口下学习页标题 x=432，而对话页 x=324（差 108px）；
             * 1920 视口下库页 x=472。**切一次页面标题就横向跳一次** ——
             * 比「标题与内容列差半格」难看得多，而后者只在视口刚好等于内容列宽度时才不存在。
             *
             * 所以撤掉那条公式，统一按顶栏自己的 `px-5` 定位。
             * 代价说清楚：宽屏下标题与居中内容列左缘**不再同线**（差值 = 内容列的居中偏移）。
             * 这是刻意的 —— 顶栏回答的是「这块画布叫什么」，内容列是「画布里的东西」，
             * 两者同宽不是必须成立的关系，而「跨页面位置一致」是用户直接看得见的。
             *
             * ⚠️ 加了折叠开关之后，「**标题**左缘 == 内容列左缘」按几何本来也已不成立
             * （开关 34px + gap 6px 把标题往右推 40px），顶栏最左边本来就有控件。
             *
             * 右内边距仍保留横屏的安全区避让：那是刘海 / 圆角，与对齐无关。
             */
            className={[
              'absolute inset-x-0 top-0 z-[5] flex min-h-[60px] items-center gap-1.5 px-5',
              'pt-[max(10px,env(safe-area-inset-top))] pb-2.5 text-foreground',
              'landscape:pr-[env(safe-area-inset-right)]',
            ].join(' ')}
          >
            {/* 渐进模糊垫层：垫在顶栏内容**之下**（z-index:-1），把滚上来的内容逐级虚化。
                顶栏自己 `z-[5]` 已建层叠上下文，所以负 z 不会溜到 `<main>` 背后，只落在
                标题 / 按钮下面 —— 否则模糊会把标题自己也糊掉。样式见 layout.css。 */}
            <div className="page-app-bar__blur" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            {/* 两档各一颗，语义不同也不重复：
                窄屏的侧栏在抽屉里（没渲染，只能开），汉堡是**开抽屉**；
                宽屏的侧栏在页面里，`panel_left` 是**收 / 放这块画布**。
                同一档里只留一颗 —— 留一个点了没反应的按钮比没有按钮更伤信任。 */}
            {rail && isNarrow && (
              <Button
                isIconOnly
                variant="ghost"
                className="size-[34px] shrink-0"
                data-testid="nav-rail-open"
                aria-label="打开导航"
                onPress={() => setDrawerOpen(true)}
              >
                <Sym name="menu" />
              </Button>
            )}
            {rail && !isNarrow && (
              <Button
                isIconOnly
                variant="ghost"
                className="size-[34px] shrink-0"
                data-testid="nav-rail-toggle"
                aria-label={railCollapsed ? '展开侧边栏' : '收起侧边栏'}
                /* aria-pressed 让「现在是不是收着的」不只存在于视觉里 */
                aria-pressed={railCollapsed}
                onPress={toggleRail}
              >
                <Sym name="panel_left" />
              </Button>
            )}
            {onBack && (
              <Button
                isIconOnly
                variant="ghost"
                className="size-[34px] shrink-0"
                data-testid="nav-back"
                aria-label="返回"
                onPress={onBack}
              >
                <Sym name="arrow_back" />
              </Button>
            )}
            <div className="flex min-w-0 flex-col gap-px">
              {/* `page-title` 是给断言用的：顶栏标题是「这条会话叫什么」的唯一出口，
                  而它没有别的稳定选择器（h1 + 一串 Tailwind 类名经不起重构）。
                  懒创建之后它还要承担一个语义：草稿态显示「新会话」而不是页面名 ——
                  见 docs/plans/2026-10-15-懒创建会话-design.md §四.2。 */}
              <h1
                id={titleId}
                data-testid="page-title"
                className="truncate text-base leading-[1.3] font-semibold"
              >
                {title}
              </h1>
              {subtitle && <div className="truncate text-xs leading-[1.3] text-muted">{subtitle}</div>}
            </div>
            <div className="flex-1" />
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </header>
          <main
            id={mainId}
            role="main"
            tabIndex={-1}
            aria-labelledby={titleId}
            data-testid="page-main"
            className={
              fill
                ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
                : 'min-h-0 flex-1 overflow-y-auto overscroll-y-contain focus:outline-none'
            }
          >
            <div className={innerClass}>{children}</div>
          </main>
        </div>
      </div>

      {/* 窄屏导航抽屉：与宽屏共用同一份 <Sidebar>，点导航项后自动收起。
          宽屏不渲染（而不是渲染后用 CSS 藏起来）—— 少一棵永远不可见的 DOM 树。

          ⚠️ 条件里**多一个 `drawerOpen`**：`drawerOpen` 为 false 时整棵 Drawer 直接卸载，
          而不是留着等退出动画播完。这是刻意的取舍，代价是**关抽屉没有淡出动画**
          （打开时的淡入还在）。

          不这么做的话，关闭后遮罩会永远留在 DOM 里：
          HeroUI Drawer → RAC `ModalOverlay` 的退场是靠 Web Animations API
          （`getAnimations()` + `animation.finished`）判定完成的，一旦那条 promise
          没兑现，`data-exiting="true"` 就一直挂着 —— 一个 `position: fixed; inset: 0`
          的透明遮罩留在页面上，**整个页面点不动**。
          实测：Esc 关闭抽屉后 1.5s，遮罩仍在，`新建对话` 按钮点 4s 超时；
          `prefers-reduced-motion` 开与关都复现（reduced-motion 只是把
          `transition` 关掉让 bug 看起来更干脆，不是触发条件）。

          对一个「关掉菜单后整页失灵」的问题，少一段 200ms 的淡出是划算的交换。
          等上游修好退出动画（RAC 吞掉了 `Promise.all(...).catch(() => {})` 的 rejection）
          再把 `drawerOpen` 从这个条件里去掉。 */}
      {rail && isNarrow && drawerOpen && (
        <Drawer.Root isOpen={drawerOpen} onOpenChange={setDrawerOpen}>
          <Drawer.Backdrop variant="blur" />
          <Drawer.Content placement="left">
            <Drawer.Dialog className="flex">
              <nav className="flex h-full w-[17rem] flex-col gap-1 bg-background p-3 text-foreground" aria-label="主导航">
                <Sidebar
                  rail={rail}
                  recent={recent}
                  railFooter={railFooter}
                  navigationId={navigationId}
                  onNavigate={() => setDrawerOpen(false)}
                />
              </nav>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Root>
      )}
    </div>
  );
}

/**
 * 顶栏右侧的搜索药丸（showcase 右上角那个带放大镜的圆角控件）。
 *
 * 应用里还没有全局搜索，所以它默认只是个**视觉锚点**：点了弹 toast 告知尚未开放，
 * 而不是塞一个不会响的假按钮 —— 假按钮比没有按钮更伤信任。
 */
export interface AppBarSearchProps {
  label?: string;
  onClick?: () => void;
  testId?: string;
}

export function AppBarSearch({ label = '搜索', onClick, testId = 'app-bar-search' }: AppBarSearchProps) {
  return (
    <Button
      variant="secondary"
      className="h-[34px] min-h-[34px] shrink-0 gap-[7px] px-3 text-[0.8125rem] font-normal"
      data-testid={testId}
      aria-label={label}
      onPress={() => {
        if (onClick) onClick();
        else toast.info('全局搜索还没上线，先用左侧的资料和 Recent 找东西吧。');
      }}
    >
      <span className="grid place-items-center text-muted" aria-hidden="true">
        <Sym name="search" />
      </span>
      <span>{label}</span>
    </Button>
  );
}

export interface SectionCardProps {
  /** 卡片标题 */
  title: string;
  /** 标题右侧操作区 */
  actions?: ReactNode;
  /** 标题下方的说明段落 */
  subtitle?: ReactNode;
  /** 给 e2e 用的稳定选择器 */
  testId?: string;
  children: ReactNode;
}

/**
 * 页面的一个内容分区。
 *
 * 底色/圆角/阴影/内边距全部来自 HeroUI 的 `Card`（`bg-surface` + `shadow-surface`）——
 * 浅灰画布上浮一张白纸片，层次靠「底色差 + 极轻阴影」建立，不画边框。
 *
 * ⚠️ 标题**必须是原生 `<h2>`**：`Card.Title` 默认渲染 `h3`，而页面里 `h1` 是顶栏标题，
 * 分区标题退到 h3 会让文档大纲出现断层（探针 `probe-app-shell-material` 也在守这条）。
 * HeroUI 没有 `as` 属性，改写元素要走 `render` —— 见 `Card.TitleProps` 的 `DOMRenderProps`。
 */
export function SectionCard({ title, actions, subtitle, testId, children }: SectionCardProps) {
  return (
    <Card className="mb-4" data-testid={testId}>
      <Card.Header className="min-h-8 flex-row items-center gap-3">
        <Card.Title
          render={(props) => <h2 {...props} />}
          className="min-w-0 flex-1 text-base font-semibold"
        >
          {title}
        </Card.Title>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </Card.Header>
      {subtitle && (
        <Card.Description className="text-[13px] leading-normal">{subtitle}</Card.Description>
      )}
      {/* gap-0：卡片内的设置行自带分隔线与内边距，再叠一层 gap 会变成两套节奏 */}
      <Card.Content className="gap-0">{children}</Card.Content>
    </Card>
  );
}

export interface FieldProps {
  /** 控件上方的标签 */
  label: ReactNode;
  /** 控件下方的说明 */
  hint?: ReactNode;
  /**
   * 版式。
   *
   * - `block`（默认）：标签 → 控件 → 说明，纵向。库页 / 讲义面板用。
   * - `row`：`[标签 + 说明] | [控件]` 两列，控件右对齐。设置面用。
   *
   * **为什么把版式做成显式参数**：以前「行式」是设置弹窗的 CSS 覆盖
   * （`.settings-modal__content .field { display: grid … }`），同一个 `<Field>`
   * 在不同容器里长得不一样，而调用方看不出来 —— 于是到处靠 `field--stack`
   * 这个「逃生口」把它压回单列。版式变成参数之后，逃生口没有存在的理由了。
   */
  layout?: 'block' | 'row';
  /** 追加类名（错误态等） */
  className?: string;
  /** 给 e2e 用的稳定选择器 */
  testId?: string;
  children: ReactNode;
}

/**
 * 一个表单行：标签 + 控件 + 说明。
 *
 * ⚠️ 标签与说明是普通元素，**不是** HeroUI 的 `Label` / `Description`：
 * 那两个是 React Aria 的字段上下文内组件 —— `Description` 在没有 description
 * 插槽的上下文里直接返回 `null`（静默不渲染），`Label` 需要一个真正的控件
 * 来挂 `htmlFor`。行式版式里标签在左列、控件在右列，两者不在同一棵子树里。
 * 控件本身（Switch / Select / Slider / TextField / Checkbox …）仍是 HeroUI 组件。
 */
export function Field({
  label,
  hint,
  layout = 'block',
  className,
  testId,
  children,
}: FieldProps) {
  const row = layout === 'row';
  return (
    <div
      className={[
        'border-b border-border/70 last:border-b-0',
        row
          ? 'grid grid-cols-[minmax(0,1fr)_minmax(0,auto)] items-center gap-x-5 py-3.5 last:pb-0.5 max-[760px]:block max-[760px]:py-3'
          : 'py-3',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={testId}
    >
      {row ? (
        <>
          <div className="col-start-1 self-end text-sm font-medium text-foreground max-[760px]:mb-1.5">
            {label}
          </div>
          {hint && (
            <div className="col-start-1 row-start-2 mt-0.5 self-start text-xs leading-normal text-muted">
              {hint}
            </div>
          )}
          {/* 控件跨两行垂直居中；窄屏回落到纵向时改由父级 block 布局接管 */}
          <div className="col-start-2 row-span-2 row-start-1 min-w-0 justify-self-end max-[760px]:mt-2 max-[760px]:justify-self-stretch">
            {children}
          </div>
        </>
      ) : (
        <>
          <div className="mb-1.5 flex items-center gap-1.5 text-[13px] leading-snug text-muted">
            {label}
          </div>
          <div>{children}</div>
          {hint && <div className="mt-1.5 text-xs leading-normal text-muted">{hint}</div>}
        </>
      )}
    </div>
  );
}

export interface EmptyStateProps {
  /** 顶部大图标（放 <Sym>） */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** 主操作按钮 */
  action?: ReactNode;
  testId?: string;
}

/**
 * 空状态：居中图标 + 文案 + 可选主操作。
 *
 * HeroUI 的 `EmptyState` 本体只是一句 `p-2 text-sm text-muted`（它假设你往里塞
 * 一整块现成内容），所以这里用它的容器 + `Typography` 的标题/段落组出版式，
 * 而不是自己写一套标题样式。
 */
export function EmptyState({ icon, title, description, action, testId }: EmptyStateProps) {
  return (
    <HeroEmptyState
      className="flex flex-col items-center gap-1 px-4 py-12 text-center"
      data-testid={testId}
    >
      {icon && (
        <div className="text-[56px] leading-none text-muted opacity-70" aria-hidden="true">
          {icon}
        </div>
      )}
      <Typography.Heading level={2} className="mt-2 text-base font-semibold text-foreground">
        {title}
      </Typography.Heading>
      {description && (
        <Typography.Paragraph className="max-w-[420px] text-[13px] leading-relaxed text-muted">
          {description}
        </Typography.Paragraph>
      )}
      {action && <div className="mt-3">{action}</div>}
    </HeroEmptyState>
  );
}

export interface HelpTipProps {
  /** 气泡标题 */
  headline: string;
  /** 气泡正文，可多段（用 <p>） */
  children: ReactNode;
  /** 触发按钮的无障碍标签，默认「说明」 */
  label?: string;
  /** 给 e2e 用的稳定选择器（挂在触发按钮上） */
  testId?: string;
}

/**
 * 问号图标 + 点击展开的富文本气泡 —— 长说明的收纳处。
 *
 * 手机上把补充说明整段铺开会把版面吃掉好几行，所以约定：**当场要决策的留正文，
 * 解释性的收进这里**。
 *
 * **为什么不用 HeroUI 的 `Popover`**：`Popover.Trigger` 渲染成
 * `<Pressable><div role="button" /></Pressable>`，`Pressable` 自己 `usePress`
 * 把 press 事件合到 children 上，与 DialogTrigger 注入的 `onPress` 互相覆盖 ——
 * 结果是点击没反应且不报错（本仓库在 `ModelsModule` 里已经踩过并绕开）。
 * 绕开要自己画原生 `<button>` + 受控 `isOpen` + `triggerRef`，为一个问号气泡
 * 引入这套机制不划算。`<details>` 无 JS 依赖、键盘可达、点外面也能收。
 *
 * 气泡宽度必须**写死**：定位前会先量 popup 的 offsetWidth，而那一刻 popup 还停在
 * 触发元素的静态位置上，可用宽度只剩「视口 − 触发元素左边距」—— 问号通常落在整行
 * 偏右，手机上会被压成一条竖条（实测宽 116 / 高 556）。
 */
export function HelpTip({ headline, children, label = '说明', testId }: HelpTipProps) {
  return (
    <details className="relative inline-block">
      <summary
        className="inline-grid cursor-pointer list-none place-items-center text-muted [&>svg]:shrink-0 [&::-webkit-details-marker]:hidden"
        aria-label={label}
        data-testid={testId}
      >
        <Sym name="help" />
      </summary>
      <div
        role="note"
        className="absolute top-[calc(100%+6px)] right-0 z-20 w-[min(17rem,calc(100vw-6rem))] rounded-lg border border-border bg-overlay p-4 text-left shadow-overlay"
      >
        <div className="text-sm font-medium text-foreground">{headline}</div>
        <div className="mt-1.5 text-[13px] leading-relaxed text-muted [&_p:last-child]:mb-0 [&_p]:m-0 [&_p]:mb-2">
          {children}
        </div>
      </div>
    </details>
  );
}

export interface BannerProps {
  /** 语义：info 用主色，warning / error 用对应的会话色 */
  variant?: 'info' | 'warning' | 'error';
  /** 左侧图标（放 <Sym>）。不传则由 HeroUI 按 status 给默认图标 */
  icon?: ReactNode;
  title: ReactNode;
  /** 标题右侧的问号（放 <HelpTip>）；解释性文案收在这里，正文只留结论 */
  help?: ReactNode;
  description?: ReactNode;
  /** 右下角操作区 */
  action?: ReactNode;
  testId?: string;
}

/**
 * 页面内常驻提示条（不用 toast：这个提示需要**常驻**，而 toast 是短暂浮层）。
 *
 * 换成 HeroUI 的 `Alert`：底色/圆角/状态色/默认图标都由它给，
 * `variant` → `status` 的映射是 `info→accent`、`warning→warning`、`error→danger`
 * （HeroUI 没有 `info`，`accent` 才是它的「信息」档）。
 */
export function Banner({
  variant = 'info',
  icon,
  title,
  help,
  description,
  action,
  testId,
}: BannerProps) {
  const status = variant === 'warning' ? 'warning' : variant === 'error' ? 'danger' : 'accent';
  return (
    <Alert status={status} className="mb-4" data-testid={testId} role="note">
      <Alert.Indicator>{icon}</Alert.Indicator>
      <Alert.Content>
        <Alert.Title className="flex items-center gap-0.5">
          <span className="min-w-0">{title}</span>
          {help}
        </Alert.Title>
        {description && (
          <Alert.Description className="text-[13px] leading-relaxed opacity-85">
            {description}
          </Alert.Description>
        )}
      </Alert.Content>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </Alert>
  );
}
