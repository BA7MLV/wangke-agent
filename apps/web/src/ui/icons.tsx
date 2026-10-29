import type { SVGProps } from 'react';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArchive,
  IconArchiveOff,
  IconArrowBackUp,
  IconArrowDown,
  IconArrowForwardUp,
  IconArrowLeft,
  IconArrowUp,
  IconArrowsExchange,
  IconArrowsMaximize,
  IconAspectRatio,
  IconBolt,
  IconBookmark,
  IconBrain,
  IconBulb,
  IconCalendarMonth,
  IconCamera,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircleCheck,
  IconCirclePlay,
  IconClock,
  IconCloudUpload,
  IconCode,
  IconCopy,
  IconCrop,
  IconCursorText,
  IconDeviceTv,
  IconDots,
  IconDotsVertical,
  IconDownload,
  IconEraser,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconFileText,
  IconFileTypePdf,
  IconFlame,
  IconFolder,
  IconFolderFilled,
  IconFolderOpen,
  IconFolderPlus,
  IconGitBranch,
  IconGripVertical,
  IconHelp,
  IconHighlight,
  IconHistory,
  IconHome,
  IconInfoCircle,
  IconKey,
  IconKeyOff,
  IconKeyboard,
  IconLayoutGrid,
  IconLayoutSidebar,
  IconLetterCase,
  IconLibrary,
  IconLink,
  IconList,
  IconListCheck,
  IconLogout,
  IconMaximize,
  IconMenu2,
  IconMessage,
  IconMessage2,
  IconMessageCircle,
  IconMessages,
  IconMicrophone,
  IconMicrophoneFilled,
  IconMinimize,
  IconPalette,
  IconPaperclip,
  IconPencil,
  IconPhoto,
  IconPhotoFilled,
  IconPhotoPlus,
  IconPinned,
  IconPinnedFilled,
  IconPinnedOff,
  IconPlayerPlay,
  IconPlayerPlayFilled,
  IconPlus,
  IconPointer,
  IconPuzzle,
  IconRefresh,
  IconRobot,
  IconSearch,
  IconSelector,
  IconSend,
  IconServer,
  IconSettings,
  IconShieldCheck,
  IconSortDescending,
  IconSquare,
  IconSquareFilled,
  IconStar,
  IconStarFilled,
  IconStarHalf,
  IconStarHalfFilled,
  IconTool,
  IconTrash,
  IconUpload,
  IconWaveSine,
  IconX,
  IconZoomIn,
  IconZoomOut,
  type Icon,
} from '@tabler/icons-react';

/** 全站描边线宽，播放器的图标适配层也复用这一值。 */
export const ICON_STROKE = 1.75;

/**
 * 图标名 → Tabler 组件的映射表。
 *
 * 沿用原来的 snake_case 名，业务组件不依赖图标库的命名。
 * 只静态导入实际使用的组件，避免把整套图标打进产物。
 */
const ICONS: Record<string, Icon> = {
  add: IconPlus,
  attach_file: IconPaperclip,
  add_photo_alternate: IconPhotoPlus,
  /** 会话归档（侧栏 Recent 的行尾菜单） */
  archive: IconArchive,
  /** 从归档里恢复（设置 → 数据 → 已归档会话） */
  archive_restore: IconArchiveOff,
  logout: IconLogout,
  arrow_back: IconArrowLeft,
  /** 向下：对话页「回到底部」。与 `arrow_upward`（发送）成对，一个把内容送上去、一个把人拉回最新 */
  arrow_downward: IconArrowDown,
  arrow_upward: IconArrowUp,
  article: IconFileText,
  calendar_month: IconCalendarMonth,
  chat: IconMessageCircle,
  chat_bubble: IconMessage,
  check: IconCheck,
  check_circle: IconCircleCheck,
  chevron_left: IconChevronLeft,
  chevron_right: IconChevronRight,
  chevron_up: IconChevronUp,
  close: IconX,
  cloud_upload: IconCloudUpload,
  code: IconCode,
  comment: IconMessage2,
  content_copy: IconCopy,
  create_new_folder: IconFolderPlus,
  crop_free: IconCrop,
  delete: IconTrash,
  description: IconFileText,
  dns: IconServer,
  download: IconDownload,
  drag_indicator: IconGripVertical,
  edit: IconPencil,
  eraser: IconEraser,
  error: IconAlertCircle,
  extension: IconPuzzle,
  folder: IconFolder,
  folder_open: IconFolderOpen,
  format_size: IconLetterCase,
  forum: IconMessages,
  fullscreen: IconMaximize,
  fullscreen_exit: IconMinimize,
  graphic_eq: IconWaveSine,
  grid_view: IconLayoutGrid,
  help: IconHelp,
  highlighter: IconHighlight,
  home: IconHome,
  image: IconPhoto,
  info: IconInfoCircle,
  /** 从断点恢复的提问卡（刷新后重新武装）：顺时针回头的表盘，表示「接着上次」 */
  history: IconHistory,
  key: IconKey,
  key_off: IconKeyOff,
  keyboard: IconKeyboard,
  keyboard_arrow_down: IconChevronDown,
  lightbulb: IconBulb,
  link: IconLink,
  list: IconList,
  local_fire_department: IconFlame,
  menu: IconMenu2,
  mic: IconMicrophone,
  more_vert: IconDotsVertical,
  /** 横向省略号：消息操作行里的「更多」用横排（竖排是列表行尾的惯例，这里是动作行） */
  more_horiz: IconDots,
  /** 来源：回答引用了哪门课、引到哪一处 */
  bookmark: IconBookmark,
  neurology: IconBrain,
  account_tree: IconGitBranch,
  open_in_full: IconArrowsMaximize,
  open_in_new: IconExternalLink,
  /** 顶栏的侧栏折叠开关 */
  panel_left: IconLayoutSidebar,
  /** 从某条消息分叉出一条新会话（对话消息操作行 / Recent 行尾菜单） */
  fork: IconGitBranch,
  photo_camera: IconCamera,
  picture_as_pdf: IconFileTypePdf,
  /** 置顶会话 */
  pin: IconPinned,
  /** 取消置顶 */
  pin_off: IconPinnedOff,
  play: IconPlayerPlay,
  pointer: IconPointer,
  redo: IconArrowForwardUp,
  /**
   * 排队（流式期间的「排队 / 插入」切换、排队条标题）。
   *
   * 用时钟而不是清单：排队这个词在界面上的意思是「等一会儿」，等待的意象比清单更准 ——
   * 清单（list_checks）在这个库里已经被 `toc` / `quiz` 占了，再占一个会撞车。
   */
  schedule: IconClock,
  /**
   * 插入 / 立刻投递（排队条的「插队」键、插入模式的意象）。
   *
   * 闪电表示「不等了、现在就插进去」，与排队的时钟正好是一对反面。
   */
  bolt: IconBolt,
  /**
   * 「工具」：会话里的工具链（agent 这一轮调了哪些工具）。
   *
   * 用扳手而不是齿轮：`settings` 已经是齿轮，而齿轮在这个应用里**特指设置入口** ——
   * 让它同时表示「调过工具」会让用户以为那条消息能点开设置。
   */
  build: IconTool,
  play_circle: IconCirclePlay,
  quiz: IconListCheck,
  refresh: IconRefresh,
  search: IconSearch,
  send: IconSend,
  settings: IconSettings,
  smart_toy: IconRobot,
  sort: IconSortDescending,
  star: IconStar,
  star_half: IconStarHalf,
  style: IconPalette,
  stop: IconSquare,
  subtitles: IconLetterCase,
  swap_horiz: IconArrowsExchange,
  text_cursor: IconCursorText,
  theater: IconAspectRatio,
  theater_exit: IconDeviceTv,
  toc: IconListCheck,
  tune: IconSettings,
  /**
   * 上下双箭头：**只有它一个**要「既可能向上也可能向下」的语义 ——
   * 思考链的中间态（思考中，展开/收起都点得动，箭头不该倒向某一侧）。
   *
   * 不能复用 `keyboard_arrow_down`，否则「思考中」和「已完成」无法区分。
   */
  unfold_more: IconSelector,
  undo: IconArrowBackUp,
  upload: IconUpload,
  verified: IconShieldCheck,
  video_library: IconLibrary,
  visibility: IconEye,
  visibility_off: IconEyeOff,
  warning: IconAlertTriangle,
  zoom_in: IconZoomIn,
  zoom_out: IconZoomOut,
};

/** 只使用官方实心字形；没有 Filled 变体时仍显示描边，不能强行给路径填色。 */
const FILLED_ICONS: Record<string, Icon> = {
  star: IconStarFilled,
  star_half: IconStarHalfFilled,
  play: IconPlayerPlayFilled,
  image: IconPhotoFilled,
  folder: IconFolderFilled,
  mic: IconMicrophoneFilled,
  stop: IconSquareFilled,
  pin: IconPinnedFilled,
};

/** 全库可用的图标名。`Sym name` 的自动补全靠它。 */
export type SymbolName = keyof typeof ICONS;

export const SYMBOL_NAMES = Object.keys(ICONS) as SymbolName[];

/**
 * 图标名入参类型：已知名字给自动补全，同时宽容任意字符串
 * （外部配置里写错名字时不该被类型系统拦下 —— 运行时会给出警告并渲染空）。
 */
export type SymNameInput = SymbolName | (string & {});

export interface SymProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'ref' | 'stroke' | 'fill'> {
  name: SymNameInput;
  /**
   * 使用 Tabler 官方 Filled 变体；未登记实心版本的图标保持描边。
   * 导航的选中态仍由 ListBox.Item 的 `data-selected` 表达，不依赖实心图标。
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
 * 业务统一使用的图标组件。
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
export function Sym({ name, filled = false, className, style, decorative = true, size, ...svgProps }: SymProps) {
  // 宽容 kebab-case 写法（create-new-folder ≡ create_new_folder）
  const normalizedName = name.replace(/-/g, '_');
  const Icon = (filled && FILLED_ICONS[normalizedName]) || ICONS[normalizedName];
  if (!Icon) {
    if (import.meta.env.DEV) {
      console.warn(`[Sym] 未知图标 "${name}"，请先加入 src/ui/icons.tsx 的 ICONS 表`);
    }
    return null;
  }
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
      {...svgProps}
      className={className}
      style={style}
      size={dimension}
      stroke={ICON_STROKE}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    />
  );
}
