import {
  Plus,
  ImagePlus,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  FileText,
  CalendarDays,
  MessageCircle,
  MessageSquare,
  Check,
  CircleCheck,
  ChevronRight,
  X,
  CloudUpload,
  Code,
  MessageSquareText,
  Copy,
  FolderPlus,
  Crop,
  Trash2,
  FileText as FileTextAlt,
  Server,
  Download,
  GripVertical,
  Pencil,
  CircleAlert,
  Puzzle,
  Folder,
  FolderOpen,
  CaseSensitive,
  MessagesSquare,
  AudioLines,
  CircleHelp,
  House,
  Image,
  Key,
  KeyRound,
  ChevronDown,
  ChevronsUpDown,
  Lightbulb,
  Link,
  Flame,
  Menu,
  Mic,
  EllipsisVertical,
  Ellipsis,
  Bookmark,
  Brain,
  Clock,
  Zap,
  Expand,
  Camera,
  FileType,
  CirclePlay,
  ListChecks,
  RefreshCw,
  Search,
  Send,
  Settings,
  Star,
  StarHalf,
  Palette,
  Square,
  RefreshCw as Undo,
  Upload,
  ShieldCheck,
  Library,
  Eye,
  EyeOff,
  TriangleAlert,
  ZoomIn,
  ZoomOut,
  PanelLeft,
  GitBranch,
  Archive,
  ArchiveRestore,
  Pin,
  PinOff,
  Wrench,
  History,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * 图标名 → Lucide 组件的映射表。
 *
 * **为什么换掉 Material Symbols**：那是 MD3（= mdui 的设计语言）的官方图标集，
 * 圆润、笔画粗、字形偏「手机系统」，和 HeroUI showcase 那套细笔画、方头方尾的
 * Lucide 放在一起会明显不像一家人。HeroUI 官方文档与 showcase 自己用的就是 Lucide。
 *
 * 表的 key 沿用**原来的 snake_case 名**，不为图标准备第二套叫法 —— 全库 209 处
 * `<Sym name="…" />` 调用点因此一行都不用改，改动只发生在这一层。
 */
const ICONS: Record<string, LucideIcon> = {
  add: Plus,
  add_photo_alternate: ImagePlus,
  /** 会话归档（侧栏 Recent 的行尾菜单） */
  archive: Archive,
  /** 从归档里恢复（设置 → 数据 → 已归档会话） */
  archive_restore: ArchiveRestore,
  arrow_back: ArrowLeft,
  /** 向下：对话页「回到底部」。与 `arrow_upward`（发送）成对，一个把内容送上去、一个把人拉回最新 */
  arrow_downward: ArrowDown,
  arrow_upward: ArrowUp,
  article: FileText,
  calendar_month: CalendarDays,
  chat: MessageCircle,
  chat_bubble: MessageSquare,
  check: Check,
  check_circle: CircleCheck,
  chevron_right: ChevronRight,
  close: X,
  cloud_upload: CloudUpload,
  code: Code,
  comment: MessageSquareText,
  content_copy: Copy,
  create_new_folder: FolderPlus,
  crop_free: Crop,
  delete: Trash2,
  description: FileTextAlt,
  dns: Server,
  download: Download,
  drag_indicator: GripVertical,
  edit: Pencil,
  error: CircleAlert,
  extension: Puzzle,
  folder: Folder,
  folder_open: FolderOpen,
  format_size: CaseSensitive,
  forum: MessagesSquare,
  graphic_eq: AudioLines,
  help: CircleHelp,
  home: House,
  image: Image,
  /** 从断点恢复的提问卡（刷新后重新武装）：顺时针回头的表盘，表示「接着上次」 */
  history: History,
  key: Key,
  key_off: KeyRound,
  keyboard_arrow_down: ChevronDown,
  lightbulb: Lightbulb,
  link: Link,
  local_fire_department: Flame,
  menu: Menu,
  mic: Mic,
  more_vert: EllipsisVertical,
  /** 横向省略号：消息操作行里的「更多」用横排（竖排是列表行尾的惯例，这里是动作行） */
  more_horiz: Ellipsis,
  /** 来源：回答引用了哪门课、引到哪一处 */
  bookmark: Bookmark,
  neurology: Brain,
  open_in_full: Expand,
  /** 顶栏的侧栏折叠开关 */
  panel_left: PanelLeft,
  /** 从某条消息分叉出一条新会话（对话消息操作行 / Recent 行尾菜单） */
  fork: GitBranch,
  photo_camera: Camera,
  picture_as_pdf: FileType,
  /** 置顶会话 */
  pin: Pin,
  /** 取消置顶 */
  pin_off: PinOff,
  /**
   * 排队（流式期间的「排队 / 插入」切换、排队条标题）。
   *
   * 用时钟而不是清单：排队这个词在界面上的意思是「等一会儿」，等待的意象比清单更准 ——
   * 清单（list_checks）在这个库里已经被 `toc` / `quiz` 占了，再占一个会撞车。
   */
  schedule: Clock,
  /**
   * 插入 / 立刻投递（排队条的「插队」键、插入模式的意象）。
   *
   * 闪电表示「不等了、现在就插进去」，与排队的时钟正好是一对反面。
   */
  bolt: Zap,
  /**
   * 「工具」：会话里的工具链（agent 这一轮调了哪些工具）。
   *
   * 用扳手而不是齿轮：`settings` 已经是齿轮，而齿轮在这个应用里**特指设置入口** ——
   * 让它同时表示「调过工具」会让用户以为那条消息能点开设置。
   */
  build: Wrench,
  play_circle: CirclePlay,
  quiz: ListChecks,
  refresh: RefreshCw,
  search: Search,
  send: Send,
  settings: Settings,
  star: Star,
  star_half: StarHalf,
  style: Palette,
  stop: Square,
  subtitles: CaseSensitive,
  swap_horiz: RefreshCw,
  toc: ListChecks,
  tune: Settings,
  /**
   * 上下双箭头：**只有它一个**要「既可能向上也可能向下」的语义 ——
   * 思考链的中间态（思考中，展开/收起都点得动，箭头不该倒向某一侧）。
   *
   * ⚠️ 它原先映射到 `ChevronDown`（= `keyboard_arrow_down`），于是「思考中」和
   * 「已完成」在图标上长得一模一样，用户看不出那颗箭头此刻代表哪个状态。
   * Lucide 的 `ChevronsUpDown` 才是这个名字真正要的字形。
   */
  unfold_more: ChevronsUpDown,
  undo: Undo,
  upload: Upload,
  verified: ShieldCheck,
  video_library: Library,
  visibility: Eye,
  visibility_off: EyeOff,
  warning: TriangleAlert,
  zoom_in: ZoomIn,
  zoom_out: ZoomOut,
};

/** 全库可用的图标名。`Sym name` 的自动补全靠它。 */
export type SymbolName = keyof typeof ICONS;

export const SYMBOL_NAMES = Object.keys(ICONS) as SymbolName[];

/**
 * 图标名入参类型：已知名字给自动补全，同时宽容任意字符串
 * （外部配置里写错名字时不该被类型系统拦下 —— 运行时会给出警告并渲染空）。
 */
export type SymNameInput = SymbolName | (string & {});

export interface SymProps {
  name: SymNameInput;
  /**
   * 兼容旧调用点的实心态开关。
   *
   * Lucide 只有描边一套字形，所以这个 prop 只对**少数**图标有意义：
   * Star / CirclePlay / Image 等本身有 fill 版本，其余的实心态会被忽略。
   * MD3「未选中描边、选中实心」那套双态在 Lucide 里不成立，取而代之的是
   * 靠 ListBox.Item 的 `data-selected` 换底色与文字色（见 ui/layout.tsx 的侧栏导航项）。
   */
  filled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** 需要被读屏播报时才设 false */
  decorative?: boolean;
  /** 覆盖尺寸（默认跟随字号，1em） */
  size?: number | string;
}

/**
 * 全站唯一的图标组件。
 *
 * 用法：
 * ```tsx
 * <Sym name="forum" />                      // 描边
 * <Sym name="star" filled />                 // 有 fill 变体的图标走实心
 * <Sym name="add" className="size-5" />      // 尺寸用 Tailwind 类控制
 * ```
 *
 * 设计要点：
 * 1. **纯 SVG 组件**，不依赖图标字体 / Web Components 运行时，可放进任何 HeroUI 组件的 children；
 * 2. 尺寸默认 `1em` —— 跟随所在处的字号，按钮里不用再单独给类；
 * 3. `aria-hidden` 默认 true：图标几乎总是伴随可见文字或 aria-label 出现；
 * 4. 尺寸**始终**输出 `1em` 兜底（见下方注释）：表现属性排在 CSS 之后，
 *    所以 `className` 里的 `size-5` 照样赢，而没写尺寸的类名不会炸成 300×150。
 */
export function Sym({ name, filled = false, className, style, decorative = true, size }: SymProps) {
  // 宽容 kebab-case 写法（create-new-folder ≡ create_new_folder）
  const Icon = ICONS[name.replace(/-/g, '_')];
  if (!Icon) {
    if (import.meta.env.DEV) {
      console.warn(`[Sym] 未知图标 "${name}"，请先加入 src/ui/icons.tsx 的 ICONS 表`);
    }
    return null;
  }
  // filled 只对有实心变体的图标有意义；其余的实心态在 Lucide 里没有对应字形，
  // 强行 fill 会把描边糊成一坨，所以按需决定要不要挂 fill。
  const fillable = filled && ['star', 'star_half', 'play_circle', 'image', 'folder', 'mic', 'stop', 'pin'].includes(name);
  /**
   * 尺寸只有一条路径：把 `1em` 作为**兜底值**写进 width/height 属性。
   *
   * ⚠️ 曾经这里写的是「传了 className 就不给尺寸，交给类名」，理由是怕两条规则打架。
   * 这个理由是错的：SVG 的 width/height 是**表现属性**，在 CSS 层叠里排在所有作者
   * 样式之后，所以类名永远赢（实测 `.size-5` → 20×20、`.font-sized{font-size:40px}`
   * → 40×40，两者都不受属性影响）。
   *
   * 代价却是实打实的：不给兜底时 SVG 会退化成「替换元素固有尺寸」（300×150 量级），
   * 在纵向 flex 里还会被拉成整屏 —— 库页的投放区图标就是这么炸的，
   * `font-size: 40px` 对 SVG 完全无效，那颗云朵撑到了 1094×1094，
   * 把「导入课程与资料」压成了右侧一列单字（见 scripts/probe-icons.mjs）。
   *
   * `1em` 正好是本组件文档里承诺的默认值：跟随所在处的字号。
   * 于是那些只写了 `font-size` 的老类名（图标字体时代的写法）也一并修好了。
   */
  const dimension = size ?? '1em';
  return (
    <Icon
      className={className}
      style={style}
      width={dimension}
      height={dimension}
      fill={fillable ? 'currentColor' : 'none'}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    />
  );
}