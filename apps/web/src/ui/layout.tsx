import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { buttonVariants } from '@heroui/styles';
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
import BrandLogo from './BrandLogo';
import { toast } from './feedback';
import { useRailCollapsed } from './rail';
import { DotBadge, MatrixDots } from '../components/motion';
import { useSettingsDialog } from '../components/settingsDialogStore';
import { useChatNotifications } from '../store/chatNotifications';
import { observeBrowserChrome } from './browserChrome';
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

/** 导航由共享 NavigationShell 持有；PageShell 只负责当前页面的标题与内容。 */

export type NavItem = {
  /** 与 `NavConfig.value` 比对来决定哪一项高亮 */
  value: string;
  label: string;
  /** 图标（放 <Sym>） */
  icon: ReactNode;
  testId?: string;
  /** 非目的地动作不显示当前页高亮。 */
  isAction?: boolean;
} & (
  | { to: string; onClick?: never }
  | { to?: never; onClick: () => void }
);

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

/** 侧栏「Recent」分组里的历史项（会话等）。 */
export interface RecentItem {
  id: string;
  label: string;
  onClick: () => void;
  testId?: string;
  /** 当前正在看的那一条。为 true 时渲染成高亮 pill（见 Sidebar 里 Recent 的说明） */
  active?: boolean;
  /** 正在等待助手回复，优先以点阵代替普通 / 置顶图标。 */
  pendingReply?: boolean;
  pinned?: boolean;
  onUnpin?: () => void;
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

/** 量出 Recent 标题的实际溢出量，供 hover 跑马灯使用。 */
function measureRecentTitle(row: HTMLElement) {
  const title = row.querySelector<HTMLElement>('.recent-title');
  if (!title) return;
  const overflow = Math.max(0, title.scrollWidth - title.clientWidth);
  title.dataset.overflow = String(overflow > 0);
  title.style.setProperty('--recent-shift', `${-overflow}px`);
  title.style.setProperty('--recent-duration', `${Math.max(5, overflow / 40)}s`);
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
  /** 嵌套页面在窄屏只显示返回按钮，不显示顶栏汉堡入口。 */
  hideRailOnNarrow?: boolean;
  /**
   * 右侧辅助栏（Bot 等「随手可用的功能」）。
   *
   * 宽屏（≥1100px）与主列并排，主列照常可用 —— 这是 HIG 里的 inspector / supplementary
   * column；更窄时同一份内容改由右侧 Drawer 承载，手机上铺满全屏，像一次 push。
   * 开合状态由页面持有（它知道该不该记住），PageShell 只负责摆放。
   */
  aside?: PageAside;
  children: ReactNode;
}

export interface PageAside {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 无障碍名称，也是窄屏 Drawer 的标题 */
  label: string;
  content: ReactNode;
}

const ASIDE_INLINE_QUERY = '(min-width: 1100px)';
function useAsideInline(): boolean {
  const [inline, setInline] = useState(() => window.matchMedia(ASIDE_INLINE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(ASIDE_INLINE_QUERY);
    setInline(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setInline(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return inline;
}

/** 纯跳转保留链接语义；新建、聚焦和面板切换仍用按钮。三种侧栏共用同一入口。 */
function NavigationItem({ item, active, compact = false, onNavigate }: {
  item: NavItem;
  active: boolean;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const className = compact
    ? 'sidebar-control page-shell__rail-icon'
    : 'sidebar-control page-shell__nav-item h-11 min-h-11 w-full justify-start gap-3 rounded-full border border-transparent px-3 text-sm font-medium text-muted';
  const common = {
    'aria-current': !item.isAction && active ? 'page' as const : undefined,
    'aria-label': compact ? item.label : undefined,
    'data-testid': item.testId,
  };
  const content = compact ? item.icon : <>
    <span className="page-shell__nav-icon" aria-hidden="true">{item.icon}</span>
    <span className="min-w-0 truncate">{item.label}</span>
  </>;

  if (item.to !== undefined) {
    return <Link {...common} to={item.to}
      className={buttonVariants({ variant: 'ghost', isIconOnly: compact, className })}
      onClick={(event) => {
        // 修饰键和中键仍交给浏览器开新页，不收起当前页的手机抽屉。
        if (!event.defaultPrevented && event.button === 0
          && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) onNavigate?.();
      }}>
      {content}
    </Link>;
  }

  return <Button {...common} variant="ghost" isIconOnly={compact} className={className}
    onPress={() => { item.onClick(); onNavigate?.(); }}>
    {content}
  </Button>;
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
  recent?: { label: string; items: RecentItem[]; loading?: boolean };
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
  const unreadIds = useChatNotifications((s) => s.unreadIds);
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
  return (
    <>
      <div id={navigationId} className="flex shrink-0 flex-col gap-1">
        {rail.items.map((it) => (
          <NavigationItem key={it.value} item={it} active={it.value === rail.value} onNavigate={onNavigate} />
        ))}
      </div>

      {recent && (
        <>
          <Separator className="my-3" />
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 px-3 pb-2 text-[0.8125rem] text-muted">{recent.label}</div>
            {!recent.loading && recent.items.length === 0 && (
              <div className="px-3 text-xs leading-6 text-muted">开始对话后，会话会显示在这里</div>
            )}
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
                  `aria-selected`；会话选择由 store 控制，与主导航的链接 / 动作区分开。

                  `disallowEmptySelection` 必需：RAC 把「再点一次已选中项」当成取消选中，
                  不设它的话点当前会话会把高亮弄没，而页面并没有切走。

                  选中态和主导航统一用中性色 `bg-surface`，不使用强调色。

                  ⚠️ 也不能用看起来更对味的 `bg-default`（中性灰）：浅色主题下
                  `--default` 与侧栏底色是**同一个值**（实测两处都是 oklch(0.94) / #ebebeb），
                  高亮会彻底看不见 —— 同一个坑在用户气泡上踩过一次（见 course-chat.css
                  的 `.course-chat__bubble--user`）。`--surface` 浅色是纯白、深色是
                  oklch(0.21)，两套主题下都与侧栏分得开。 */}
              <div
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
                      onFocus={(event) => {
                        setFocusedRecentId(item.id);
                        measureRecentTitle(event.currentTarget);
                      }}
                      onMouseEnter={(event) => measureRecentTitle(event.currentTarget)}
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
                      className="sidebar-control recent-item group min-h-9 gap-3 rounded-full px-3 text-[0.8125rem] font-normal text-muted"
                    >
                      {item.pendingReply ? (
                        <span className="grid size-6 shrink-0 place-items-center text-sm"
                          role="status" aria-label="正在等待回复…">
                          <MatrixDots />
                        </span>
                      ) : item.pinned && item.onUnpin ? (
                        <span className="shrink-0" title="取消置顶"
                          onPointerDown={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}>
                          <Button isIconOnly size="sm" variant="ghost"
                            className="sidebar-control size-6 min-w-0 rounded-md text-muted"
                            aria-label={`取消置顶 ${item.label}`}
                            data-testid={`${item.testId ?? item.id}-unpin`}
                            onPress={item.onUnpin}>
                            <Sym name="pin" />
                          </Button>
                        </span>
                      ) : <span className="grid size-6 shrink-0 place-items-center text-sm" aria-hidden="true">
                        <Sym name="chat_bubble" />
                      </span>}
                      {/* 长标题在 hover / 聚焦时横向滚动；完整内容仍保留在 DOM 中。 */}
                      <span className="recent-title min-w-0">
                        <span>{item.label}</span>
                      </span>
                      {unreadIds.includes(Number(item.id)) && (
                        <span className="size-2 shrink-0 rounded-full bg-accent"
                          role="img" aria-label="会话已完成，未查看"
                          data-testid={`${item.testId ?? item.id}-unread`} />
                      )}
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
                                'sidebar-control grid size-6 place-items-center rounded-md text-muted transition-opacity',
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
        <div className="mt-auto shrink-0 pt-2" data-testid="nav-rail-footer">
          {railFooter}
        </div>
      )}
    </>
  );
}

const NavigationContext = createContext<{ isNarrow: boolean; open: () => void } | null>(null);

/** 挂在布局路由上一次；子页面加载或切换时，导航、Recent 滚动和账号区不卸载。 */
export function NavigationShell({
  rail,
  recent,
  railFooter,
  children,
}: {
  rail: NavConfig;
  recent: { label: string; items: RecentItem[]; loading?: boolean };
  railFooter: ReactNode;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hasUnread = useChatNotifications((s) => s.unreadIds.length > 0);
  const { open: settingsOpen } = useSettingsDialog();
  useEffect(() => {
    if (settingsOpen) setDrawerOpen(false);
  }, [settingsOpen]);
  const isNarrow = useIsNarrow();
  const [railCollapsed, toggleRail] = useRailCollapsed();
  const navigationId = useId();
  const open = useCallback(() => setDrawerOpen(true), []);
  const navigation = useMemo(() => ({ isNarrow, open }), [isNarrow, open]);

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

  const railToggle = (
    <Button isIconOnly variant="ghost"
      className={`sidebar-control relative shrink-0 rounded-full${railCollapsed ? ' page-shell__nav-logo' : ''}`}
      data-testid="nav-rail-toggle" aria-label={railCollapsed ? '展开侧边栏' : '收起侧边栏'}
      aria-expanded={!railCollapsed} aria-pressed={railCollapsed} onPress={toggleRail}>
      {railCollapsed ? <BrandLogo /> : <Sym name="panel_left" />}
      <DotBadge open={hasUnread} className="nav-unread" label="有已完成的会话未查看" testId="nav-unread-dot" />
    </Button>
  );

  return (
    <NavigationContext.Provider value={navigation}>
      <div className="app-navigation-shell flex h-[var(--vvh,100%)] min-h-0 overflow-hidden bg-background-secondary text-foreground">
        {!isNarrow && (
          <nav className={`page-shell__rail t-resize${railCollapsed ? ' page-shell__compact-rail' : ''}`}
            aria-label="主导航" data-testid={railCollapsed ? 'nav-rail-compact' : 'nav-rail'}>
            <div className="page-shell__rail-header">
              <div className="page-shell__brand" role={railCollapsed ? undefined : 'img'} aria-label="DeepStudent Go" data-testid="app-brand">
                {railCollapsed ? railToggle : <BrandLogo />}
              </div>
              {!railCollapsed && railToggle}
            </div>
            {railCollapsed ? <>
              {rail.items.map(item => (
                <span key={item.value} title={item.label}>
                  <NavigationItem item={item} active={item.value === rail.value} compact />
                </span>
              ))}
              <div className="page-shell__compact-footer">{railFooter}</div>
            </> : <div className="page-shell__rail-content">
              <Sidebar rail={rail} recent={recent} railFooter={railFooter} navigationId={navigationId} />
            </div>}
          </nav>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        {isNarrow && (
          <Drawer.Root isOpen={drawerOpen} onOpenChange={setDrawerOpen}>
            <Drawer.Backdrop variant="opaque" className="app-nav-backdrop">
              <Drawer.Content placement="left">
                <Drawer.Dialog className="app-nav-drawer" aria-label="DeepStudent Go">
                  <Drawer.Header className="mb-4 flex flex-row items-center justify-between p-0">
                    <Drawer.Heading className="page-shell__brand" aria-label="DeepStudent Go" data-testid="app-brand"><BrandLogo /></Drawer.Heading>
                    <Drawer.CloseTrigger aria-label="关闭导航"><Sym name="close" /></Drawer.CloseTrigger>
                  </Drawer.Header>
                  <nav className="flex min-h-0 flex-1 flex-col gap-1 text-foreground" aria-label="主导航">
                    <Sidebar rail={rail} recent={recent} railFooter={railFooter} navigationId={navigationId}
                      onNavigate={() => setDrawerOpen(false)} />
                  </nav>
                </Drawer.Dialog>
              </Drawer.Content>
            </Drawer.Backdrop>
          </Drawer.Root>
        )}
      </div>
    </NavigationContext.Provider>
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
  hideRailOnNarrow = false,
  aside,
  children,
}: PageShellProps) {
  const navigation = useContext(NavigationContext);
  const asideInline = useAsideInline();
  const hasUnread = useChatNotifications((s) => s.unreadIds.length > 0);
  const shellId = useId();
  const titleId = `${shellId}-title`;
  const mainId = `${shellId}-main`;
  const edgeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (edgeRef.current) return observeBrowserChrome(edgeRef.current);
  }, []);

  // 顶栏高度只写 CSS 变量，不为测量重新渲染整页。
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

  /**
   * 内容列最大宽度挂在根节点上，只由内容区消费（顶栏不再跟着避让，
   * 见 `<header>` 的注释）。页面可以自己覆盖（如库页的 `page-library` 把它放宽到 1360px）。
   */
  const contentMax = narrow ? '[--page-content-max:720px]' : wide ? '[--page-content-max:960px]' : '';
  const rootClass = [
    'page-shell flex min-h-0 flex-col overflow-hidden bg-background-secondary text-foreground',
    navigation ? 'h-full flex-1' : 'h-[var(--vvh,100%)]',
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

  const showMobileRail = navigation?.isNarrow && !hideRailOnNarrow;

  return (
    <div className={rootClass} ref={rootRef}>
      {/* 明确的 background-color 供 Safari 贴边取色；安全区与模糊上缘共用同一实色。 */}
      <div ref={edgeRef} className="page-shell__top-edge" aria-hidden="true" />
      <a
        href={`#${mainId}`}
        data-testid="skip-link"
        className="absolute top-2 left-4 z-100 -translate-y-[calc(100%+16px)] rounded-full bg-accent px-5 py-3 text-sm text-accent-foreground no-underline focus-visible:translate-y-0"
        onClick={(event) => {
          // HashRouter 拥有 URL 的 hash；跳过导航只移动焦点，不触发路由。
          event.preventDefault();
          document.getElementById(mainId)?.focus();
        }}
      >
        跳到主要内容
      </a>
      <div className="flex min-h-0 flex-1 items-stretch">
        <div ref={mainColRef} className={`relative flex min-h-0 min-w-0 flex-1 flex-col${navigation ? ' page-shell__surface' : ''}`}>
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
              * 侧栏收起或窄屏时，顶栏的导航入口仍会把标题向右推；展开时入口在侧栏内。
             *
             * 右内边距仍保留横屏的安全区避让：那是刘海 / 圆角，与对齐无关。
             */
            className={[
              'absolute inset-x-0 top-0 z-[5] flex min-h-[60px] items-center gap-2 px-5',
              'pt-[max(12px,env(safe-area-inset-top))] pb-3 text-foreground',
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
              <span />
            </div>
            {/* 窄屏默认保留汉堡菜单；嵌套页可改为只显示返回按钮。 */}
            {showMobileRail && (
              <Button
                isIconOnly
                variant="tertiary"
                className="page-shell__toolbar-button relative shrink-0 rounded-full"
                data-testid="nav-rail-open"
                aria-label="打开导航"
                onPress={navigation?.open}
              >
                <Sym name="menu" />
                <DotBadge open={hasUnread} className="nav-unread"
                  label="有已完成的会话未查看" testId="nav-unread-dot" />
              </Button>
            )}
            {onBack && (
              <Button
                isIconOnly
                variant="ghost"
                className="shrink-0 rounded-full"
                data-testid="nav-back"
                aria-label="返回"
                onPress={onBack}
              >
                <Sym name="arrow_back" />
              </Button>
            )}
            <div className="flex min-w-0 flex-col gap-px">
              {/* 主页显示页面名，历史会话显示自己的标题。 */}
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
        {aside && asideInline && aside.open && (
          <aside className="app-aside" aria-label={aside.label} data-testid="app-aside">
            {aside.content}
          </aside>
        )}
      </div>

      {aside && !asideInline && (
        <Drawer.Root isOpen={aside.open} onOpenChange={aside.onOpenChange}>
          <Drawer.Backdrop variant="opaque" className="app-aside-backdrop">
            <Drawer.Content placement="right">
              <Drawer.Dialog className="app-aside-drawer" aria-label={aside.label} data-testid="app-aside">
                {aside.content}
              </Drawer.Dialog>
            </Drawer.Content>
          </Drawer.Backdrop>
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
      className="h-[34px] min-h-[34px] shrink-0 gap-2 px-3 text-[0.8125rem] font-normal"
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
    <Card className="ui-smooth mb-4" data-testid={testId}>
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
          ? 'grid grid-cols-[minmax(0,1fr)_minmax(0,auto)] items-center gap-x-5 py-4 last:pb-1 max-[760px]:block max-[760px]:py-3'
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
          <div className="mb-1.5 flex items-center gap-2 text-[13px] leading-snug text-muted">
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
        <Alert.Title className="flex items-center gap-1">
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
