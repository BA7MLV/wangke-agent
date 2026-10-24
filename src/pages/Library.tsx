import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ALL_FORMATS, BlobSource, Input as MediaInput } from 'mediabunny';
import {
  Button,
  Card,
  Chip,
  Dropdown,
  Input,
  Label,
  ListBox,
  Modal,
  ProgressBar,
  Radio,
  RadioGroup,
  SearchField,
  Tag,
  TagGroup,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  buttonVariants,
} from '@heroui/react';
import {
  Banner,
  EmptyState,
  HelpTip,
  LoadingButton,
  PageShell,
  SkeletonReveal,
  Sym,
  alertDialog,
  confirmDialog,
  toast,
  MODAL_CONTAINER_CLASS,
  useSkeletonGate,
} from '../ui';
import { useAppNav } from '../components/appNav';
import { useCourseChat } from '../store/courseChat';
import { useLibraryNavigation } from '../store/libraryNavigation';
import { useRecentChats } from '../components/useRecentChats';
import { SettingsButton } from '../components/SettingsModal';
import AgentModule from '../components/settings/AgentModule';
import { db, type FolderRow, type VideoRow } from '../store/db';
import { useLibraryRevision } from '../pipelines/folderPlan';
import { deleteMaterialFile, deleteVideoFile, saveMaterialFile, saveVideoFile } from '../store/fileStore';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { formatSize } from '../utils/format';
import { progressRatio } from '../utils/videoProgress';
import { useIsMobile } from '../utils/useMobile';
import { useMarqueeSelection } from '../utils/useMarqueeSelection';
// 课程/材料 id 的生成（降级实现与理由见 utils/uuid.ts 的文件头，仓库里只有那一份）
import { fetchPageSubtitles, importBiliPages, resolveBiliTarget, type BiliTarget } from '../bilibili';
import type { BiliSubtitleItem } from '../bilibili/dmview';
import { formatTotalDuration, pageLabel, resolveSelectedPages, selectedDuration } from '../bilibili/pages';
import { defaultSelectedLangs, type SubtitleBundle } from '../bilibili/subtitle';
import type { BiliVideoSource } from '../bilibili/source';
import { saveImportedSubtitles } from '../store/subtitles';
import { getSettings } from '../store/settings';
import { describeTransport, isBiliBridgeAvailable, isBridgePostCapable } from '../bilibili/transport';
import { isJobActive, libraryJobCopy, useJobStore, useTranscribeJob } from '../store/jobs';
import { cancelTranscription } from '../pipelines/transcribeQueue';
import { startMaterialJob } from '../pipelines/materialJob';
import { enqueueCover } from '../pipelines/coverQueue';
import { useCoverRevision } from '../store/covers';
import { detectMaterialFormat, isLegacyDocFile, isMaterialFile } from '../materials/parse';
import { formatCaughtError } from '../utils/errorText';
import { uuid } from '../utils/uuid';
import './library.css';
import { folderAncestors, validFolderDrop, moveLibraryItems, undoLibraryMove } from '../materials/libraryFolders';

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 可导入的视频扩展名。iPadOS 文件选择器按 UTI 过滤 accept，
 * mkv/flv/ts/wmv 等扩展名映射不到系统认识的 UTI 会被置灰选不了，
 * 因此 input 不设 accept，改为选中后在 JS 侧校验。
 */
const VIDEO_EXTS = new Set([
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'flv', 'ts', 'm2ts', 'wmv', 'avi', 'mpg', 'mpeg', '3gp', 'rmvb', 'rm',
]);

function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXTS.has(ext);
}

/**
 * 可导入的文件 = 视频 或 阅读材料（PDF / Word / Markdown / HTML）。
 *
 * `.doc`（旧版二进制）也算「可导入」—— 但不是在导入时静默忽略，而是在
 * `importMaterial` 里**明确报错并给出「另存为 .docx」的提示**。
 * 让用户知道「这个格式我认识但处理不了」比让他猜「为什么文件选不上」强得多。
 */
function isImportable(file: File): boolean {
  return isVideoFile(file) || isMaterialFile(file);
}

/** iOS/iPadOS 检测（含 iPadOS 13+ 伪装成 MacIntel 的情况） */
function isIOS(): boolean {
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/** 是否已作为 PWA 添加到主屏幕运行 */
function isStandalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

// iOS 普通 Safari 标签页受 ITP 限制：7 天无交互可能清除 OPFS/IndexedDB，
// 主屏幕 PWA 豁免。只需在 iOS 非独立模式下提示一次。
const SHOW_PWA_HINT = isIOS() && !isStandalone();

/** 先用 Safari 原生媒体元数据读取时长，避免 iPadOS 为常见 MP4/MOV 扫描整个容器。 */
async function probeNativeDuration(file: Blob): Promise<number> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    const duration = await new Promise<number>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('native duration timeout')), 3000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve(video.duration);
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('native duration unavailable'));
      };
    });
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * 用 mediabunny 解析容器头探测时长：只读文件头/尾少量字节，
 * 支持 MKV/FLV 等 Safari 原生 <video> 不认的格式；15s 超时兜底。
 */
async function probeDuration(file: Blob): Promise<number> {
  try {
    const native = await probeNativeDuration(file);
    if (native > 0) return native;
  } catch {
    // Safari 不认识的容器交给 mediabunny 处理。
  }
  const input = new MediaInput({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const duration = await Promise.race([
      input.computeDuration(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 15000)),
    ]);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch {
    return 0;
  } finally {
    input.dispose();
  }
}

/**
 * 转写状态标记。
 *
 * 原先用 antd `Tag`，颜色是 `default / processing / success / error`；
 * mdui 的 `mdui-chip` 不带语义色变体、标签文字颜色还在 shadow DOM 里，按状态分别上色做不到，
 * 现在用 HeroUI Chip 的静态语义色变体表达状态，不再依赖页面专属 tag 样式。
 */
const STATUS_TAG: Record<VideoRow['status'], { variant: '' | 'primary' | 'error'; text: string }> = {
  new: { variant: '', text: '未转写' },
  transcribing: { variant: 'primary', text: '转写中' },
  transcribed: { variant: 'primary', text: '已转写' },
  error: { variant: 'error', text: '出错' },
};

interface ImportTask {
  key: string;
  name: string;
  status: 'queued' | 'probing' | 'writing' | 'done' | 'error';
  percent: number; // 0-100，仅 writing 阶段有意义
  error?: string;
}

/**
 * 拖拽的两种「卡片级」投放区（除已有的文件夹组头之外）。
 *
 * - `pin`：拖到顶栏左侧 → 置顶 / 取消置顶（在所属组内排最前）；
 * - `delete`：拖到顶栏右侧 → 删除（走与行内删除同一个确认弹窗）。
 *
 * 只在拖拽进行中出现，位置钉在视口顶部两角（`position: fixed`），
 * 命中检测照旧用手动 `getBoundingClientRect`（Pointer Events + 指针捕获下
 * 不能靠 DOM 事件目标），见 `moveDrag`。
 */
type DragZone = 'pin' | 'delete';

interface DragState {
  video: VideoRow;
  x: number;
  y: number;
  /** 悬停到的文件夹组头 key（含 `UNCAT_KEY`），未悬停为 null */
  overKey: string | null;
  /** 悬停到的卡片级投放区，未悬停为 null */
  zone: DragZone | null;
}

/** 整卡长按多久进入拖拽（毫秒）。与系统「长按呼出菜单」的常见时长同量级 */
const LONG_PRESS_MS = 400;

/** 长按期间允许的抖动上限（px）：超过即判定为滚动/点按，取消长按 */
const LONG_PRESS_SLOP = 8;

const TASK_STATUS_TEXT: Record<ImportTask['status'], string> = {
  queued: '排队中',
  probing: '读取信息',
  writing: '写入中',
  done: '已导入',
  error: '失败',
};

/** 材料写入的提示文案与视频不同（材料不做容器探测，直接就是写文件） */
const MATERIAL_MIME: Record<'pdf' | 'docx' | 'md' | 'html', string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown',
  html: 'text/html',
};

/** 「未分类」虚拟组的 key（折叠状态持久化用） */
const UNCAT_KEY = '__uncat__';
const LIBRARY_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'video', label: '视频' },
  { value: 'material', label: '阅读材料' },
  { value: 'started', label: '继续学习' },
] as const;
type LibraryFilter = (typeof LIBRARY_FILTERS)[number]['value'];

/** 简介弹窗复用原资料卡片；主画布使用 Finder 的图标 / 列表布局。 */
/** 卡片根：表面 / 圆角 / 阴影由 HeroUI `Card` 自带，这里只补内边距与纵向排布 */
const CARD_CLS = 'video-row group relative gap-0 p-1.5 pb-2 select-none [-webkit-touch-callout:none] [-webkit-user-select:none]';
const THUMB_CLS =
  'video-row__thumb relative block aspect-video w-full cursor-pointer overflow-hidden rounded-2xl bg-default-soft';
const MAIN_CLS = 'video-row__main mt-2 min-w-0 px-0.5';
const NAME_CLS = 'video-row__name line-clamp-2 text-[15px] font-medium leading-snug text-foreground';
const META_CLS = 'video-row__meta mt-0.5 truncate text-xs text-muted';
const TAGS_CLS = 'video-row__tags mt-1.5 flex items-center gap-1.5 px-0.5';
const ACTIONS_CLS = 'video-row__actions mt-1.5 flex items-center justify-end gap-1 px-0.5 [&>[data-slot=button]:first-child]:mr-auto';
/** 骨架里的灰块：与真内容同级元素等尺寸（能靠父级继承的绝不手写像素） */
const SKEL_CLS = 'skel-breathe block rounded-md bg-background-tertiary';

const FOLDER_COLORS = [
  { id: 'blue', label: '默认蓝色', hue: 198, swatch: '#50bfe8' },
  { id: 'green', label: '绿色', hue: 142, swatch: '#63bc7c' },
  { id: 'yellow', label: '黄色', hue: 46, swatch: '#e6c34e' },
  { id: 'orange', label: '橙色', hue: 27, swatch: '#e89b50' },
  { id: 'red', label: '红色', hue: 0, swatch: '#df7373' },
  { id: 'purple', label: '紫色', hue: 274, swatch: '#ad83d8' },
  { id: 'gray', label: '灰色', hue: 198, swatch: '#9ca3af' },
] as const;

/** Finder 专属的拟物文件夹，保留自绘外观，不随通用操作图标库替换。 */
function FolderIcon({ color = 'blue' }: { color?: FolderRow['color'] }) {
  const id = useId();
  const palette = FOLDER_COLORS.find((entry) => entry.id === color) ?? FOLDER_COLORS[0];
  return (
    <svg className="finder-folder-icon" data-folder-color={palette.id} style={{ filter: `hue-rotate(${palette.hue - 198}deg) saturate(${palette.id === 'gray' ? 0 : 1}) drop-shadow(0 2px 1px rgb(0 0 0 / 20%))` }} viewBox="0 0 120 96" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-back`} x1="60" y1="10" x2="60" y2="88" gradientUnits="userSpaceOnUse"><stop stopColor="#48b8e8" /><stop offset=".3" stopColor="#168dc3" /><stop offset="1" stopColor="#56bce4" /></linearGradient>
        <linearGradient id={`${id}-front`} x1="60" y1="29" x2="60" y2="88" gradientUnits="userSpaceOnUse"><stop stopColor="#87ddfa" /><stop offset="1" stopColor="#50bfe8" /></linearGradient>
      </defs>
      <path d="M8 18a8 8 0 0 1 8-8h23c4 0 6 2 10 5l7 5h48a8 8 0 0 1 8 8v53a7 7 0 0 1-7 7H15a7 7 0 0 1-7-7Z" fill={`url(#${id}-back)`} />
      <rect x="12" y="25" width="96" height="55" rx="5" fill="#c5eeff" />
      <rect x="8" y="25" width="104" height="63" rx="7" fill={`url(#${id}-front)`} stroke="#39afe0" />
      <path d="M15 32h90M12 82h96" stroke="#a2e2fa" strokeLinecap="round" />
    </svg>
  );
}

/** 首屏骨架复用 Finder 网格尺寸；工具栏与路径栏在加载期间保留。 */
function LibrarySkeleton({ count }: { count: number }) {
  return (
    <div className="finder-items finder-items--icons" data-testid="library-skeleton" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <div className="finder-item" key={index}>
        <span className="finder-item__icon"><span className={`${SKEL_CLS} h-20 w-24`} /></span>
        <span className={`${SKEL_CLS} h-4 w-20`} />
        <span className={`${SKEL_CLS} mt-1 h-3 w-12`} />
      </div>)}
    </div>
  );
}

export default function Library() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // 兼容旧链接；新入口统一位于 /system。
  const agentFileOpen = ['/system/AGENTS.md', 'AGENTS.md'].includes(searchParams.get('file') ?? '');
  const nav = useAppNav('home');
  const bootstrapChat = useCourseChat((s) => s.bootstrap);
  const recent = useRecentChats();
  useEffect(() => {
    void bootstrapChat();
  }, [bootstrapChat]);
  const isMobile = useIsMobile();
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  /**
   * 列表的加载状态。
   *
   * ⚠️ 为什么不能拿 `videos.length === 0 && folders.length === 0` 兼表「空库」：
   * 首帧这两个数组**必然是空的**（reload 是异步 IndexedDB 读），于是「还没加载出来」
   * 和「库里确实没东西」被混成了同一个状态 —— 有数据的库冷启动时，空态会先闪现
   * 64–94ms 再被列表顶掉（实测见 `scripts/probe-loading-latency.mjs` 的 B 组）。
   *
   * 三态分开之后，空态只在 `ready` 且数组真的为空时才出现。
   * 同一套规矩在 `store/courseChat.ts` 已经是这么写的（`loaded` / `error` 各自独立，
   * 注释里明确禁止用 `activeId === null` 兼表「正在加载」）。
   */
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 首次读库是否已经落定（成功或失败都算）—— 决定后续刷新失败时是「换错误页」还是「只弹 toast」 */
  const initialLoadSettled = useRef(false);
  const [searchText, setSearchText] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const folderHistory = useLibraryNavigation((s) => s.folderHistory);
  const setFolderHistory = useLibraryNavigation((s) => s.setFolderHistory);
  const folderKey = folderHistory.entries[folderHistory.index];
  const inSystemFolder = agentFileOpen || folderKey === 'system';
  const setAgentFileOpen = (open: boolean) => {
    // 从设置或聊天深链接打开时，关闭文件后留在它所属的目录。
    setFolderHistory((history) => history.entries[history.index] === 'system' ? history :
      { entries: [...history.entries.slice(0, history.index + 1), 'system'], index: history.index + 1 });
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (open) next.set('file', '/system/AGENTS.md');
      else next.delete('file');
      return next;
    });
  };
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const marquee = useMarqueeSelection(selection, setSelection);
  const [view, setView] = useState<'icons' | 'list'>('icons');
  const [sort, setSort] = useState<'name' | 'recent'>('name');
  const [importOpen, setImportOpen] = useState(false);
  const [details, setDetails] = useState<VideoRow | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const finderDragKeys = useRef<string[]>([]);
  const finderPressSelection = useRef<string[]>([]);
  const [finderDragging, setFinderDragging] = useState<string[]>([]);
  const [dropHint, setDropHint] = useState('');
  const [lastMove, setLastMove] = useState<Awaited<ReturnType<typeof moveLibraryItems>>>([]);
  const [moveNotice, setMoveNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [undoingMove, setUndoingMove] = useState(false);
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const springTarget = useRef<string | null>(null);
  const dragOrigin = useRef<string | null>(null);
  const springOpened = useRef(false);
  const finderDropCommitted = useRef(false);
  const dragImage = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const clearSpring = () => {
    if (springTimer.current) clearTimeout(springTimer.current);
    springTimer.current = null;
    springTarget.current = null;
  };
  useEffect(() => () => { clearSpring(); dragImage.current?.remove(); }, []);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [contextPoint, setContextPoint] = useState<{ x: number; y: number } | null>(null);
  const contextAnchor = useRef<HTMLSpanElement>(null);
  const [tasks, setTasks] = useState<ImportTask[]>([]);
  // 重命名视频弹窗状态：renaming 为 null 时弹窗关闭
  const [renaming, setRenaming] = useState<VideoRow | null>(null);
  const [renameText, setRenameText] = useState('');
  // 文件夹弹窗：create=新建，rename=重命名；为 null 时关闭
  const [folderModal, setFolderModal] = useState<{ mode: 'create' } | { mode: 'rename'; folder: FolderRow } | null>(null);
  const [folderText, setFolderText] = useState('');
  // 移动到文件夹弹窗：moving 为 null 时关闭；moveTarget -1 表示未分类
  const [moving, setMoving] = useState<VideoRow | null>(null);
  const [moveTarget, setMoveTarget] = useState<string>('-1');
  const [moveNewName, setMoveNewName] = useState('');
  /**
   * 拖拽移动（Pointer Events 实现，iPad Safari 不支持 HTML5 DnD）：
   * 按住视频行的拖拽手柄（立即）或整张卡片长按（约 400ms）→ 悬浮卡片跟随 →
   * 拖到组头上松手移入该文件夹、拖到顶栏左侧松手置顶、拖到顶栏右侧松手删除。
   * dragRef 镜像 drag 供事件处理器同步读取（避免闭包拿到旧 state）。
   */
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const headerRefs = useRef(new Map<string, HTMLDivElement>());
  /** 顶栏两个投放区的 DOM，命中检测时现量矩形（拖拽期间才挂载） */
  const pinZoneRef = useRef<HTMLDivElement>(null);
  const deleteZoneRef = useRef<HTMLDivElement>(null);
  // 顺序导入链：多个文件排队逐个写入，避免并发写存储互相拖慢
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const nativeInputRef = useRef<HTMLInputElement>(null);
  // HTML5 拖放（桌面/iPad 从「文件」App 拖入）的悬停高亮
  const [dropActive, setDropActive] = useState(false);
  // 哔哩哔哩导入弹窗（两步：解析 → 勾语言 → 下载）
  const [biliOpen, setBiliOpen] = useState(false);
  const [biliUrl, setBiliUrl] = useState('');
  const [biliTarget, setBiliTarget] = useState<BiliTarget | null>(null);
  const [biliResolving, setBiliResolving] = useState(false);
  /** 勾选的字幕语言（B 站 lan key）；第一路（按优先级）作主字幕 */
  const [biliLangs, setBiliLangs] = useState<string[]>([]);
  /** 已解析出的字幕语言（跟着「第一个选中的分 P」走，切 P 会刷新） */
  const [biliLangItems, setBiliLangItems] = useState<BiliSubtitleItem[]>([]);
  /** biliLangItems 是哪个分 P 的（用来判断切 P 后要不要重新拉） */
  const [biliLangPage, setBiliLangPage] = useState<number | null>(null);
  const [biliSubtitleError, setBiliSubtitleError] = useState<string | null>(null);
  const [biliSubtitleLoading, setBiliSubtitleLoading] = useState(false);
  /** 勾选的分 P 序号 */
  const [biliPagesSel, setBiliPagesSel] = useState<number[]>([]);
  const [biliImporting, setBiliImporting] = useState(false);
  const [biliProgress, setBiliProgress] = useState(0);
  /** 导入中的阶段文案（多 P 时是「P2 … · 2/5」） */
  const [biliLabel, setBiliLabel] = useState('');
  const [biliError, setBiliError] = useState<string | null>(null);
  /** 语言列表刷新的竞态计数：只认最后一次请求 */
  const langReqRef = useRef(0);

  const reload = async () => {
    try {
      const [rows, folderRows] = await Promise.all([
        db.videos.orderBy('createdAt').reverse().toArray(),
        db.folders.orderBy('createdAt').toArray(),
      ]);
      setVideos(rows);
      setFolders(folderRows);
      setLoadError(null);
      initialLoadSettled.current = true;
      setLoadState('ready');
    } catch (e) {
      const message = formatCaughtError(e);
      setLoadError(message);
      /**
       * 只有**首次**加载失败才把整页切成错误页。
       *
       * 后续的刷新（revision 变化、后台任务收尾）失败时换掉整页是错的 ——
       * 用户手里已经有一份能看的列表，一次后台重读失败不该把它抽走：
       * 内容还在、只是可能不是最新，这比「突然什么都没有了」好得多。
       * 这种情形留一条 toast 就够。
       */
      if (initialLoadSettled.current) {
        toast.error(`资料刷新失败：${message}`);
      } else {
        setLoadState('error');
      }
    }
  };

  useEffect(() => {
    void db.files.get('wrongbook.md').then(async (file) => {
      if (file) await (await import('../store/wrongbook')).ensureWrongbookMaterial();
    })
      .catch((error) => toast.error(`错题本迁移失败：${formatCaughtError(error)}`))
      .then(() => reload());
  }, []);

  /**
   * 助手在**别的页面**整理了目录（课程助手页的方案卡确认后会建文件夹、改 folderId），
   * 这里要立刻看到归位结果。
   *
   * 靠重新挂载是不行的：用户在库页时助手可能在聊天页确认了方案，回来时组件已经挂着了，
   * 什么都不会变。信号只带一个计数器（`useLibraryRevision`），本组件只管「变了就重读」。
   */
  const libraryRevision = useLibraryRevision((s) => s.revision);
  useEffect(() => {
    if (libraryRevision > 0) void reload();
  }, [libraryRevision]);

  /**
   * 任务跑到终态时刷新列表。
   *
   * 材料的解析/建索引是**后台任务**：`parseMaterial` 会回写 `videos.unitCount` / `scanned`，
   * 但库页的 `videos` 是导入那一刻读出来的快照，不会自己更新 ——
   * 于是一份已经解析好的 PDF 在列表里一直挂着「待解析」标签。
   * 这里订阅 job store，任务到 done/error 时重读一次。
   *
   * `settledRef` 记住已处理过的 id，避免每次渲染重复 reload；
   * 非活动任务（done/error）也顺手从集合里摘掉，重启同名任务时能再次触发。
   */
  const jobs = useJobStore((s) => s.jobs);
  const settledJobs = useRef(new Set<string>());
  useEffect(() => {
    let needReload = false;
    for (const [id, job] of Object.entries(jobs)) {
      const settled = job.phase === 'done' || job.phase === 'error';
      if (!settled) {
        settledJobs.current.delete(id);
        continue;
      }
      if (!settledJobs.current.has(id)) {
        settledJobs.current.add(id);
        needReload = true;
      }
    }
    if (needReload) void reload();
  }, [jobs]);

  /** 视频按文件夹分组：文件夹组按创建时间在前，未分类固定最后 */
  const groups = useMemo(() => {
    const folderIds = new Set(folders.map((f) => f.id));
    const byFolder = new Map<number, VideoRow[]>();
    const uncat: VideoRow[] = [];
    for (const v of videos) {
      if (v.folderId != null && folderIds.has(v.folderId)) {
        const arr = byFolder.get(v.folderId) ?? [];
        arr.push(v);
        byFolder.set(v.folderId, arr);
      } else {
        uncat.push(v);
      }
    }
    /**
     * 组内置顶优先，其余维持 reload 的新→旧顺序。
     *
     * 用一次稳定排序而不是「先挑出置顶再 concat」：`Array.prototype.sort` 在现代引擎里
     * 是稳定排序，同置顶状态下相对次序不动 —— 于是 `videos`（createdAt 倒序）的顺序
     * 被原样保留，不必在这里再比一次时间戳。
     */
    const byPinned = (list: VideoRow[]) =>
      [...list].sort((a, b) => (b.pinned === 1 ? 1 : 0) - (a.pinned === 1 ? 1 : 0));
    return [
      ...folders.map((f) => ({
        key: String(f.id),
        name: f.name,
        videos: byPinned(byFolder.get(f.id!) ?? []),
        folder: f as FolderRow | null,
      })),
      { key: UNCAT_KEY, name: '未分类', videos: byPinned(uncat), folder: null },
    ];
  }, [videos, folders]);

  const searchQuery = searchText.trim().toLocaleLowerCase();
  const hasFilters = searchQuery.length > 0 || filter !== 'all';
  // 搜索时展开命中的组；清除筛选后恢复用户原本的折叠状态，不写入新的折叠偏好。
  const visibleGroups = useMemo(
    () => groups.map((group) => ({
      ...group,
      videos: group.videos.filter((video) => {
        if (searchQuery && !video.name.toLocaleLowerCase().includes(searchQuery)) return false;
        if (filter === 'video') return video.kind !== 'material';
        if (filter === 'material') return video.kind === 'material';
        if (filter === 'started') {
          return video.kind !== 'material' && (video.lastPosition ?? 0) > 0 && video.finished !== 1;
        }
        return true;
      }),
    })).filter((group) => group.videos.length > 0 || (!hasFilters && group.folder != null)),
    [groups, searchQuery, filter, hasFilters],
  );
  const currentFolder = inSystemFolder ? undefined : groups.find((group) => group.key === folderKey && group.folder != null);
  const folderTitle = inSystemFolder ? 'system' : currentFolder?.name ?? '全部资料';
  const scopedGroups = currentFolder ? visibleGroups.filter((group) => group.key === currentFolder.key) : visibleGroups;
  const folderTiles = groups.filter((group) => !inSystemFolder && group.folder &&
    (group.folder.parentId ?? null) === (currentFolder?.folder?.id ?? null) &&
    (!hasFilters || scopedGroups.some((visible) => visible.key === group.key) || (filter === 'all' && group.name.toLocaleLowerCase().includes(searchQuery))))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : (b.folder?.createdAt ?? 0) - (a.folder?.createdAt ?? 0));
  const displayedVideos = scopedGroups.flatMap((group) => !inSystemFolder && (currentFolder || hasFilters || group.folder == null) ? group.videos : [])
    .sort((a, b) => (b.pinned ?? 0) - (a.pinned ?? 0) || (sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : b.createdAt - a.createdAt));
  // 系统文件映射设置原文，不入课程表，不参与课程统计、移动、重命名或删除。
  const showSystemFolder = !inSystemFolder && !currentFolder && (filter === 'all' || filter === 'material') &&
    (!searchQuery || 'system agents.md agent 默认提示词 全局指令'.includes(searchQuery));
  const showAgentFile = inSystemFolder && (filter === 'all' || filter === 'material') &&
    (!searchQuery || 'agents.md agent 默认提示词 全局指令'.includes(searchQuery));
  const visibleCount = displayedVideos.length + folderTiles.length + (showAgentFile ? 1 : 0) + (showSystemFolder ? 1 : 0);
  const folderPath = folderAncestors(folders, currentFolder?.folder?.id ?? null);
  // Keep the native drag source mounted while spring-loading another directory.
  const renderedFolders = finderDragging.length
    ? [...folderTiles, ...groups.filter((group) => group.folder && !folderTiles.some((visible) => visible.key === group.key))]
    : folderTiles;
  const renderedVideos = finderDragging.length
    ? [...displayedVideos, ...videos.filter((video) => !displayedVideos.some((visible) => visible.id === video.id))]
    : displayedVideos;
  const selectedKey = selection.size === 1 ? [...selection][0] : undefined;
  const selectedFolder = folderTiles.find((group) => `folder:${group.key}` === selectedKey);
  const selectedVideo = displayedVideos.find((video) => `file:${video.id}` === selectedKey);

  /**
   * 首次读库要不要出骨架。
   *
   * 实测本机 IndexedDB 全表读回 p50 是 0.3ms，所以**绝大多数情况下这里一直是 false**
   * —— 列表直接就位，连一帧骨架都不会出现，这正是想要的结果（见 ui/skeleton.tsx 的说明）。
   * 它只在慢设备 / 主线程被长任务占住时才会真的露脸。
   *
   * ⚠️ 判据写成「加载中 **且手上还没有任何东西可显示**」，而不是只看 `loadState === 'loading'`。
   *
   * 就今天的代码而言这两个写法**等价** —— `setLoadState('loading')` 只出现在重试按钮里，
   * 刷新（`libraryRevision` 变化、导入 / 删除后的重读）根本不会把状态打回 `loading`。
   * 之所以还是把「没有内容」这半句写上，是因为它才是这个判断真正的意思：
   * 骨架的正确用法是填「还什么都没有」的那个空档，一旦手里有内容可显示，就不该拿骨架
   * 去盖住它（把已经看得见的内容换成骨架，比刷新慢一点糟糕得多）。
   * 这是一个守卫：将来谁给刷新也加上 `loading`（这很自然，想让刷新有个指示），
   * 这里不会跟着退化成「刷新时把列表清空」。
   *
   * 顺带说明为什么这里能安全地看数组长度：它和 `loadState === 'loading'` **同时成立**
   * 才等于「首屏」，不存在把「未加载」当成「确实为空」的老问题 ——
   * 那个老问题恰恰是只看数组长度、不看加载状态造成的。
   */
  const isFirstLoad = loadState === 'loading' && videos.length === 0 && folders.length === 0;
  const showSkeleton = useSkeletonGate(isFirstLoad);

  const clearFilters = () => {
    setSearchText('');
    setFilter('all');
    searchInputRef.current?.focus();
  };

  const openFolder = (key: string | null) => {
    setFolderHistory((history) => ({ entries: [...history.entries.slice(0, history.index + 1), key], index: history.index + 1 }));
    setSelection(new Set());
    setSearchText('');
    setFilter('all');
  };
  const travelFolder = (delta: number) => {
    setFolderHistory((history) => ({ ...history, index: Math.max(0, Math.min(history.entries.length - 1, history.index + delta)) }));
    setSelection(new Set());
    setSearchText('');
    setFilter('all');
  };
  const openItem = (key: string) => {
    if (key === 'system:agent-instructions') setAgentFileOpen(true);
    else if (key === 'system:folder') openFolder('system');
    else if (key.startsWith('folder:')) openFolder(key.slice(7));
    else if (key.startsWith('file:')) navigate(`/player/${key.slice(5)}`);
  };

  const patchTask = (key: string, patch: Partial<ImportTask>) => {
    setTasks((prev) => prev.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  };

  /** 报错详情：页面内提示没法承载长文本，仍旧弹窗，但保留「一键复制详情」 */
  const showError = (headline: string, text: string) => {
    void alertDialog({ headline, description: text, copyText: text });
  };

  /**
   * 导入阅读材料（PDF / Word / Markdown / HTML）。
   *
   * 与视频导入的差别：
   * - **不做容器探测**（没有时长可探，`duration` 恒为 0）；
   * - 文件进 OPFS 的 `materials/` 目录（与视频分开放，便于各自清理）；
   * - 写盘成功即视为导入完成，**解析与建索引丢到后台 job** —— 三百页 PDF 要几十秒，
   *   卡在导入队列里会让「导入 5 个文件」变成一次要等好几分钟。
   */
  const importMaterial = async (file: File, key: string) => {
    if (isLegacyDocFile(file)) {
      throw new Error('这是旧版 .doc 格式，暂不支持。请在 Word / WPS 里「另存为 .docx」后重新导入。');
    }
    const format = detectMaterialFormat(file);
    patchTask(key, { status: 'writing', percent: 0 });
    const id = uuid();
    await saveMaterialFile(id, file, (ratio) => patchTask(key, { percent: Math.round(ratio * 100) }));
    await db.videos.put({
      id,
      ...(currentFolder?.folder?.id != null ? { folderId: currentFolder.folder.id } : {}),
      name: file.name.replace(/\.[^.]+$/, ''),
      size: file.size,
      mimeType: file.type || MATERIAL_MIME[format],
      duration: 0,
      createdAt: Date.now(),
      status: 'new',
      kind: 'material',
      materialFormat: format,
      coverState: 'pending',
    });
    // 封面与解析各走各的队列：PDF 的封面要渲染首页，Word 的会直接标成完成
    // （没有可渲染的首页，保留文档图标占位），两种都不阻塞导入后的解析。
    enqueueCover(id);
    await reload();
    setTasks((prev) => prev.filter((t) => t.key !== key));
    toast.success(`已导入《${file.name}》，正在解析…`);
    // 不 await：解析在后台跑（进度在列表行的 job 区域可见），用户可以继续导入下一个
    void startMaterialJob(id, format).catch((e) => {
      toast.error(`解析《${file.name}》失败：${formatCaughtError(e)}`);
      showError(`解析《${file.name}》失败`, formatCaughtError(e));
    });
  };

  const importOne = async (file: File, key: string, subtitles?: SubtitleBundle, biliSource?: BiliVideoSource) => {
    // 大视频拷入 OPFS 要数分钟，持 Wake Lock 防熄屏后 tab 被挂起中断导入
    await acquireWakeLock();
    try {
      if (isMaterialFile(file)) {
        await importMaterial(file, key);
        return;
      }
      const id = uuid();
      patchTask(key, { status: 'writing', percent: 0 });
      // 探测时长与写入文件互不依赖。旧实现先 probe、再 save，
      // 在 iPadOS 上会把两个慢步骤串起来；并行后总耗时取较慢的一项。
      const durationPromise = probeDuration(file);
      const savePromise = saveVideoFile(id, file, (ratio) =>
        patchTask(key, { percent: Math.round(ratio * 100) }),
      );
      const [duration] = await Promise.all([durationPromise, savePromise]);
      await db.videos.put({
        id,
        ...(currentFolder?.folder?.id != null ? { folderId: currentFolder.folder.id } : {}),
        name: file.name.replace(/\.[^.]+$/, ''),
        size: file.size,
        mimeType: file.type || 'video/mp4',
        ...(biliSource ? { biliSource } : {}),
        duration,
        createdAt: Date.now(),
        status: 'new',
        coverState: 'pending',
      });
      // 封面入库即入队（不 await）：它是派生资源，晚一两秒出现没关系，
      // 但绝不该再像以前那样「只有跑过讲义的视频才有」——详见 pipelines/cover.ts
      enqueueCover(id);
      // B 站自带字幕：主语言写 segments、全部语言写 subtitleTracks，并直接置为已转写
      if (subtitles) await saveImportedSubtitles(id, subtitles);
      await reload();
      // 视频已经出现在下方列表，队列只留还在进行 / 失败的项
      setTasks((prev) => prev.filter((t) => t.key !== key));
      toast.success(
        subtitles?.primary
          ? `已导入《${file.name}》· 自带字幕 ${subtitles.primary.cues.length} 条`
          : `已导入《${file.name}》`,
      );
    } catch (e) {
      const text = formatCaughtError(e);
      patchTask(key, { status: 'error', error: text });
      showError(`导入《${file.name}》失败`, text);
    } finally {
      await releaseWakeLock();
    }
  };

  const enqueue = (file: File, subtitles?: SubtitleBundle, biliSource?: BiliVideoSource) => {
    const key = uuid();
    setTasks((prev) => [...prev, { key, name: file.name, status: 'queued', percent: 0 }]);
    chainRef.current = chainRef.current.then(() => importOne(file, key, subtitles, biliSource));
  };

  /** 清空 B 站导入弹窗的草稿（关弹窗 / 导入成功后都调） */
  function resetBiliDraft() {
    ++langReqRef.current;
    setBiliSubtitleError(null);
    setBiliSubtitleLoading(false);
    setBiliUrl('');
    setBiliTarget(null);
    setBiliLangs([]);
    setBiliLangItems([]);
    setBiliLangPage(null);
    setBiliPagesSel([]);
    setBiliError(null);
    setBiliLabel('');
  }

  /** 选中的分 P 里最靠前的那个（字幕语言按它刷新） */
  function firstSelectedPage(target: BiliTarget, selected: number[]): number | null {
    const hit = resolveSelectedPages(target.pages, selected)[0];
    return hit ? hit.page : null;
  }

  /**
   * 切分 P 后刷新字幕语言列表：每个分 P 的 cid 不同，字幕语言也可能不同
   * （同理「这集没字幕」也要如实告诉用户）。保留用户已勾、且新列表里仍存在的语言。
   */
  async function refreshLangsForPage(target: BiliTarget, page: number) {
    const { bilibiliProxy, bilibiliCookie } = getSettings();
    const seq = ++langReqRef.current;
    setBiliSubtitleLoading(true);
    setBiliSubtitleError(null);
    let subtitleError: string | null = null;
    const items = await fetchPageSubtitles({ proxy: bilibiliProxy, cookie: bilibiliCookie }, target, page, (message) => {
      subtitleError = message;
    });
    if (seq !== langReqRef.current) return; // 又有新的切换，丢弃这次结果
    setBiliSubtitleError(subtitleError);
    setBiliSubtitleLoading(false);
    setBiliLangItems(items);
    setBiliLangPage(page);
    setBiliLangs((prev) => {
      const keep = prev.filter((lan) => items.some((i) => i.lan === lan));
      return keep.length > 0 ? keep : defaultSelectedLangs(items);
    });
  }

  // 分 P chips：选中切换 + 切换后刷新语言列表。
  // mdui-chip 时代靠容器上的 change 事件冒泡来读 chip.selected；迁到 TagGroup 后
  // 直接用受控的 selectedKeys + onSelectionChange，回调给的是「新的完整选中集」。
  const selectPages = (keys: Iterable<string>) => {
    if (!biliTarget) return;
    const next = [...keys].map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    setBiliPagesSel(next);
    const first = firstSelectedPage(biliTarget, next);
    if (first != null && first !== biliLangPage) void refreshLangsForPage(biliTarget, first);
  };

  // 语言 chips：同样改成受控选中集
  const selectLangs = (keys: Iterable<string>) => {
    setBiliLangs([...keys]);
  };

  /**
   * B 站导入第一步：解析链接，拿到标题/时长与「自带字幕」语言列表。
   * 真正下载放到第二步，因为选哪几路字幕要用户先拍板。
   */
  const handleBiliResolve = async () => {
    const { bilibiliProxy, bilibiliCookie } = getSettings();
    if (describeTransport({ proxy: bilibiliProxy }).kind === 'none') {
      toast.warning('请先安装油猴脚本（设置页「安装脚本」），或填写代理地址');
      return;
    }
    const raw = biliUrl.trim();
    if (!raw) {
      toast.warning('请粘贴 B 站视频链接或 BV 号');
      return;
    }
    setBiliResolving(true);
    setBiliError(null);
    try {
      const target = await resolveBiliTarget({ proxy: bilibiliProxy, cookie: bilibiliCookie }, raw);
      setBiliTarget(target);
      setBiliSubtitleError(target.subtitleError ?? null);
      setBiliPagesSel(target.defaultPages);
      setBiliLangItems(target.subtitles);
      setBiliLangPage(target.defaultPages[0] ?? null);
      setBiliLangs(defaultSelectedLangs(target.subtitles));
      if (target.subtitles.length === 0 && !target.subtitleError) {
        // 分两种：真没字幕 vs 旧版脚本不支持 POST（否则会误以为「这视频没字幕」）
        if (isBiliBridgeAvailable() && !isBridgePostCapable()) {
          toast.warning('油猴脚本版本过旧，读不到 B 站自带字幕；到「设置」重新安装一次脚本即可');
        } else {
          toast.info('该视频没有自带字幕，导入后可点「生成字幕」走本地转写');
        }
      }
    } catch (e) {
      const text = formatCaughtError(e);
      setBiliError(text);
      showError('B 站解析失败', text);
    } finally {
      setBiliResolving(false);
    }
  };

  /** B 站导入第二步：逐个分 P 下载，每完成一个立刻入队写盘 */
  const handleBiliImport = async () => {
    if (!biliTarget) return;
    const selected = resolveSelectedPages(biliTarget.pages, biliPagesSel);
    if (selected.length === 0) {
      toast.warning('请至少勾选一个分 P');
      return;
    }
    const totalSec = selectedDuration(biliTarget.pages, biliPagesSel);
    // 防手滑：一门课几十 P 几十小时，误点「全选」会很惨
    if (selected.length > 10 || totalSec > 6 * 3600) {
      const ok = await confirmDialog({
        headline: `确认下载 ${selected.length} ${biliTarget.kind === 'season' ? '集' : '个分 P'}？`,
        description: `合计约 ${formatTotalDuration(totalSec)}，会逐个写入本机存储（可随时在任务列表里看到进度）`,
        confirmText: '开始下载',
      });
      if (!ok) return;
    }

    const { bilibiliProxy, bilibiliCookie } = getSettings();
    setBiliImporting(true);
    setBiliProgress(0);
    setBiliLabel('');
    setBiliError(null);
    try {
      await importBiliPages(
        biliTarget,
        { proxy: bilibiliProxy, cookie: bilibiliCookie, langs: biliLangs, pages: biliPagesSel },
        // 每下完一个 P 就入队：下一个 P 的下载与上一个 P 的 OPFS 写入并行
        (item) => void enqueue(item.file, item.subtitles.tracks.length > 0 ? item.subtitles : undefined, item.source),
        (ratio, label) => {
          setBiliProgress(Math.round(ratio * 100));
          setBiliLabel(label);
        },
      );
      setBiliOpen(false);
      resetBiliDraft();
    } catch (e) {
      const text = formatCaughtError(e);
      setBiliError(text);
      showError('B 站导入失败', text);
    } finally {
      setBiliImporting(false);
      setBiliProgress(0);
      setBiliLabel('');
    }
  };

  /** 多分 P 相关派生值（单 P 视频时整块 UI 都不出现） */
  const multiPage = (biliTarget?.pages.length ?? 0) > 1;
  const selectedSec = biliTarget ? selectedDuration(biliTarget.pages, biliPagesSel) : 0;

  /** 全选 / 清空分 P（清空后语言列表保持最后的那个 P，用户可自己再勾） */
  function selectAllPages(all: boolean) {
    if (!biliTarget) return;
    if (!all) {
      setBiliPagesSel([]);
      return;
    }
    setBiliPagesSel(biliTarget.pages.map((p) => p.page));
    const first = biliTarget.pages[0]?.page ?? null;
    if (first != null && first !== biliLangPage) void refreshLangsForPage(biliTarget, first);
  }

  /**
   * 原生文件选择器入口（兼诊断）：iPad PWA 里若投放区选完没反应，
   * 用这个可以确认系统到底有没有把文件交给页面——选中后立即提示文件数量/名称/大小/类型。
   */
  const handleNativePick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (inSystemFolder) { toast.warning('system 仅存放应用系统文件，请返回资料目录导入。'); return; }
    if (files.length === 0) {
      toast.warning('系统没有返回任何文件，请改用 Safari 标签页打开后再试');
      return;
    }
    const accepted = files.filter(isImportable);
    const skipped = files.filter((f) => !isImportable(f));
    if (skipped.length > 0) toast.warning(`已跳过 ${skipped.length} 个不支持的文件（只支持视频与 PDF/Word/Markdown）`);
    if (files.length > 1) toast.info(`已选择 ${accepted.length} 个文件，开始逐个导入`);
    if (accepted.length > 0) setImportOpen(false);
    for (const f of accepted) enqueue(f);
  };

  /** HTML5 拖放（桌面 / iPad 从「文件」App 拖入） */
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    if (inSystemFolder || (e.target as Element).closest('[data-system-folder]')) {
      toast.warning('system 仅存放应用系统文件，请返回资料目录导入。');
      return;
    }
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    setImportOpen(false);
    for (const f of files) {
      if (!isImportable(f)) {
        toast.warning(`《${f.name}》不是支持的格式（只支持视频与 PDF/Word/Markdown），已跳过`);
        continue;
      }
      enqueue(f);
    }
  };

  const openRename = (row: VideoRow) => {
    setRenaming(row);
    setRenameText(row.name);
  };

  const confirmRename = async () => {
    if (!renaming) return;
    const name = renameText.trim();
    if (!name) {
      toast.warning('标题不能为空');
      return;
    }
    if (name !== renaming.name) {
      await db.videos.update(renaming.id, { name });
      toast.success('标题已修改');
    }
    setRenaming(null);
    await reload();
  };

  /** 第一步删除：只删文件本体释放空间，字幕/讲义/问答等内容保留 */
  const handleDeleteFile = async (row: VideoRow) => {
    const isMaterial = row.kind === 'material';
    if (isMaterial) await deleteMaterialFile(row.id);
    else await deleteVideoFile(row.id);
    await db.videos.update(row.id, { fileDeleted: 1 });
    toast.success(isMaterial ? '已删除材料文件，问答记录仍保留' : '已删除视频文件，字幕/讲义/问答仍保留');
    await reload();
  };

  /** 第二步删除（文件已删后）：彻底删除记录及全部内容 */
  const handleDelete = async (row: VideoRow) => {
    // 记录都没了，后台还在转它就没意义了（队列里也要摘掉，否则会给已删除的视频写段）
    cancelTranscription(row.id);
    useJobStore.getState().drop(row.id);
    await db.transaction(
      'rw',
      [
        db.videos,
        db.segments,
        db.subtitleTracks,
        db.frames,
        db.handouts,
        db.chats,
        db.chatSessions,
        // v9：材料的文本块。不一起清会留下孤儿数据占空间
        // （向量表已随稠密检索移除，见 2026-09-23-context-engineering-design.md §1.6）
        db.materialBlocks,
        db.materialInk,
        // v10：封面（主键就是 videoId）
        db.covers,
        // v12：评论区
        db.comments,
        // 弹幕与卡片：一直是漏的（本次一并补上）。
        // 它们和评论一样都是「按字幕生成的派生物」，留着只是占空间 —— 而且视频没了之后
        // 永远没有入口再看到，与 e2e-covers 守的「删除不残留」是同一条原则。
        db.danmakus,
        db.cards,
      ],
      async () => {
        await db.videos.delete(row.id);
        await db.segments.where('videoId').equals(row.id).delete();
        await db.subtitleTracks.where('videoId').equals(row.id).delete();
        await db.frames.where('videoId').equals(row.id).delete();
        await db.handouts.where('videoId').equals(row.id).delete();
        await db.chats.where('videoId').equals(row.id).delete();
        await db.chatSessions.where('videoId').equals(row.id).delete();
        await db.materialBlocks.where('materialId').equals(row.id).delete();
        await db.materialInk.where('materialId').equals(row.id).delete();
        await db.covers.delete(row.id);
        await db.comments.where('videoId').equals(row.id).delete();
        await db.danmakus.where('videoId').equals(row.id).delete();
        await db.cards.where('videoId').equals(row.id).delete();
      },
    );
    // 材料在 materials/ 目录下，用视频的删除函数会清不掉（OPFS 里两份文件各自独立）
    if (row.kind === 'material') await deleteMaterialFile(row.id);
    else await deleteVideoFile(row.id);
    toast.success('已删除');
    await reload();
  };

  /** 重新解析材料（换索引、修解析失败）：清掉旧块与旧向量再走一遍完整流水线 */
  const reparseMaterial = (row: VideoRow) => {
    const format = row.materialFormat ?? 'pdf';
    useJobStore.getState().drop(row.id);
    toast.info(`开始重新解析《${row.name}》…`);
    void startMaterialJob(row.id, format)
      .then(async (res) => {
        toast.success(
          res.scanned
            ? `《${row.name}》没有文本层（扫描件），只能划词/框选提问`
            : res.empty
              ? `《${row.name}》没有正文，无法参与问答检索`
              : `《${row.name}》解析完成（${res.parsed} 个文本块）`,
        );
        await reload();
      })
      .catch((e) => {
        const text = formatCaughtError(e);
        showError(`解析《${row.name}》失败`, text);
      });
  };

  /**
   * 删除确认：桌面端原本是行内 Popconfirm、手机端是 ⋯ 菜单里的 modal.confirm，
   * 合并成同一个 confirmDialog —— 两条路径的文案与结果完全一致，没必要维护两份。
   */
  const askDeleteVideo = (v: VideoRow) => {
    const full = v.fileDeleted === 1;
    void confirmDialog({
      headline: full ? '彻底删除该记录？' : '删除视频文件？',
      description: full
        ? '字幕、讲义、问答记录会一并删除，不可恢复'
        : '仅删除视频本体释放空间，字幕、讲义、问答记录保留',
      confirmText: full ? '彻底删除' : '删除',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void (full ? handleDelete(v) : handleDeleteFile(v));
    });
  };

  /**
   * 置顶 / 取消置顶。入口有两处：行内菜单（键盘与触屏可达）与长按拖拽到顶栏左侧。
   * 语义是**组内**排最前（见 `groups` 的 byPinned），不是全库独立置顶区。
   */
  const togglePin = async (v: VideoRow) => {
    const next = v.pinned === 1 ? 0 : 1;
    await db.videos.update(v.id, { pinned: next });
    toast.success(next === 1 ? `已置顶《${v.name}》` : `已取消置顶《${v.name}》`);
    await reload();
  };

  // ---------- 文件夹操作 ----------

  const openFolderModal = (mode: 'create' | 'rename', folder?: FolderRow) => {
    setFolderModal(mode === 'create' ? { mode } : { mode, folder: folder! });
    setFolderText(mode === 'create' ? '' : folder!.name);
  };

  const confirmFolderModal = async () => {
    if (!folderModal) return;
    const name = folderText.trim();
    if (!name) {
      toast.warning('文件夹名称不能为空');
      return;
    }
    if (folderModal.mode === 'create') {
      await db.folders.add({ name, createdAt: Date.now(), parentId: currentFolder?.folder?.id });
      toast.success(`已创建文件夹「${name}」`);
    } else if (name !== folderModal.folder.name) {
      await db.folders.update(folderModal.folder.id!, { name });
      toast.success('文件夹已重命名');
    }
    setFolderModal(null);
    await reload();
  };

  /** 删除文件夹：组内视频移回未分类，视频本体与内容不动 */
  const handleDeleteFolder = async (folder: FolderRow) => {
    await db.transaction('rw', [db.folders, db.videos], async () => {
      await db.videos
        .filter((v) => v.folderId === folder.id)
        .modify((v) => {
          if (folder.parentId == null) delete v.folderId;
          else v.folderId = folder.parentId;
        });
      await db.folders.filter((row) => row.parentId === folder.id).modify((row) => {
        if (folder.parentId == null) delete row.parentId;
        else row.parentId = folder.parentId;
      });
      await db.folders.delete(folder.id!);
    });
    toast.success('文件夹已删除，内容已移回上级目录');
    await reload();
  };

  const confirmDeleteFolder = (folder: FolderRow, _count: number) => {
    void confirmDialog({
      headline: `删除文件夹「${folder.name}」？`,
      description: '其中的资料和子文件夹会移回上级目录，内容不会被删除。',
      confirmText: '删除',
      danger: true,
    }).then((ok) => {
      if (ok) void handleDeleteFolder(folder);
    });
  };

  const openMove = (v: VideoRow) => {
    setMoving(v);
    setMoveTarget(String(v.folderId ?? -1));
    setMoveNewName('');
  };

  /** folderId 传 null 表示移回未分类（删除字段而非写 0/undefined，保持行干净） */
  const setVideoFolder = async (videoId: string, folderId: number | null) => {
    await db.videos
      .where('id')
      .equals(videoId)
      .modify((v) => {
        if (folderId == null) delete v.folderId;
        else v.folderId = folderId;
      });
  };

  const confirmMove = async () => {
    if (!moving) return;
    const target = Number(moveTarget);
    await setVideoFolder(moving.id, target < 0 ? null : target);
    toast.success('已移动');
    setMoving(null);
    await reload();
  };

  const moveFinderItems = async (keys: string[], target: number | null) => {
    try {
      const placements = await moveLibraryItems(keys, target);
      setLastMove(placements);
      const targetName = target == null ? '全部资料' : folders.find((folder) => folder.id === target)?.name;
      setMoveNotice({ text: placements.length ? `已将 ${keys.length} 个项目移入「${targetName}」` : '项目已在此文件夹中' });
      setSelection(new Set(target === (currentFolder?.folder?.id ?? null) ? keys : target != null ? [`folder:${target}`] : []));
      await reload();
    } catch (error) {
      setMoveNotice({ text: `移动失败：${formatCaughtError(error)}`, error: true });
    }
  };

  const undoFinderMove = async () => {
    if (undoingMove) return;
    setUndoingMove(true);
    try {
      await undoLibraryMove(lastMove);
      setLastMove([]);
      setMoveNotice({ text: '已撤销移动' });
      setSelection(new Set());
      await reload();
    } catch (error) {
      setMoveNotice({ text: `撤销失败：${formatCaughtError(error)}`, error: true });
    } finally { setUndoingMove(false); }
  };

  const startFinderDrag = (event: { currentTarget: HTMLElement; dataTransfer?: DataTransfer }, key: string) => {
    const keys = (finderPressSelection.current.includes(key) ? finderPressSelection.current : selection.has(key) ? [...selection] : [key])
      .filter((item) => !item.startsWith('system:'));
    finderDragKeys.current = keys;
    setFinderDragging(keys);
    dragOrigin.current = folderKey;
    springOpened.current = false;
    finderDropCommitted.current = false;
    setDropHint('拖到文件夹以移动；停留片刻可打开文件夹');
    dragImage.current?.remove();
    const preview = document.createElement('div');
    preview.className = 'finder-drag-preview';
    const icon = event.currentTarget.querySelector('.finder-item__icon')?.cloneNode(true);
    if (icon) preview.append(icon);
    const label = document.createElement('span');
    label.className = 'finder-drag-preview__name';
    label.textContent = event.currentTarget.querySelector('.finder-item__name')?.textContent ?? '资料';
    preview.append(label);
    if (keys.length > 1) {
      preview.dataset.multiple = 'true';
      const badge = document.createElement('span');
      badge.className = 'finder-drag-preview__badge';
      badge.textContent = String(keys.length);
      preview.append(badge);
    }
    document.body.append(preview);
    dragImage.current = preview;
    if (event.dataTransfer) {
      event.dataTransfer.setDragImage(preview, 34, 34);
      event.dataTransfer.setData('application/x-library-items', JSON.stringify(keys));
      event.dataTransfer.effectAllowed = 'move';
    }
    setSelection(new Set(keys));
  };
  const endFinderDrag = () => {
    clearSpring();
    if (springOpened.current && !finderDropCommitted.current) {
      setFolderHistory((history) => ({ ...history, entries: [...history.entries.slice(0, history.index), dragOrigin.current] }));
    }
    finderDragKeys.current = [];
    setFinderDragging([]);
    setDropFolder(null);
    setDropHint('');
    dragImage.current?.remove();
    dragImage.current = null;
  };
  const updateFinderDrop = (target: number | null, spring = false) => {
      const valid = validFolderDrop(folders, finderDragKeys.current, target);
      const targetKey = String(target ?? 'root');
      const sameFolder = finderDragKeys.current.every((key) => key.startsWith('folder:')
        ? (folders.find((folder) => folder.id === Number(key.slice(7)))?.parentId ?? null) === target
        : (videos.find((video) => video.id === key.slice(5))?.folderId ?? null) === target);
      setDropFolder(valid ? targetKey : null);
      const name = target == null ? '全部资料' : folders.find((folder) => folder.id === target)?.name;
      setDropHint(!valid ? '不能移入自身或子文件夹' : sameFolder ? `项目已在「${name}」中` : `将 ${finderDragKeys.current.length} 个项目移入「${name}」${spring ? ' · 停留以打开' : ''}`);
      if (spring && valid && targetKey !== String(currentFolder?.folder?.id ?? 'root')) {
        if (springTarget.current !== targetKey) {
          clearSpring();
          springTarget.current = targetKey;
          springTimer.current = setTimeout(() => {
            springOpened.current = true;
            setFolderHistory((history) => ({ ...history, entries: [...history.entries.slice(0, history.index), target == null ? null : String(target)] }));
            setSelection(new Set(finderDragKeys.current));
            setSearchText('');
            setFilter('all');
            setDropFolder(null);
            setDropHint(`已打开「${name}」· 松手放入，或继续拖到子文件夹`);
            if (canvasRef.current) canvasRef.current.scrollTop = 0;
            clearSpring();
          }, 850);
        }
      } else clearSpring();
      return valid;
  };
  const commitFinderDrop = (target: number | null) => {
    const keys = finderDragKeys.current;
    if (validFolderDrop(folders, keys, target)) {
      finderDropCommitted.current = true;
      void moveFinderItems(keys, target);
    }
    endFinderDrag();
  };
  const folderDropProps = (target: number | null, spring = false) => {
    const handlers = {
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes('application/x-library-items')) return;
      event.preventDefault();
      event.stopPropagation();
      if (inSystemFolder || (event.target as Element).closest('[data-system-folder]')) {
        event.dataTransfer.dropEffect = 'none';
        clearSpring();
        setDropFolder(null);
        return;
      }
      event.dataTransfer.dropEffect = updateFinderDrop(target, spring) ? 'move' : 'none';
    },
    onDragLeave: (event: React.DragEvent) => {
      // Child-to-padding transitions fire dragleave after the new target's
      // dragenter. Do not erase that new highlight; the canvas resolves it.
      const window = event.currentTarget.closest('.finder-window');
      if (!window?.contains(event.relatedTarget as Node | null)) { clearSpring(); setDropFolder(null); setDropHint('拖到文件夹以移动；停留片刻可打开文件夹'); }
    },
    onDrop: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes('application/x-library-items')) return;
      event.preventDefault();
      event.stopPropagation();
      if (inSystemFolder || (event.target as Element).closest('[data-system-folder]')) return;
      setDropFolder(null);
      clearSpring();
      commitFinderDrop(target);
    },
    };
    return { ...handlers, onDragEnter: handlers.onDragOver };
  };

  const pathDropProps = (target: number | null) => {
    const props = folderDropProps(target, true);
    return { onDragEnterCapture: props.onDragOver, onDragOverCapture: props.onDragOver, onDropCapture: props.onDrop, onDragLeave: props.onDragLeave };
  };

  // Resolve the entire option at the canvas boundary, before React Aria's
  // item/press handlers can swallow native drag events on its descendants.
  const finderCanvasDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('application/x-library-items')) return;
    const folder = (event.target as Element).closest<HTMLElement>('[data-group-key]');
    folderDropProps(folder ? Number(folder.dataset.groupKey) : currentFolder?.folder?.id ?? null, !!folder).onDragOver(event);
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientY < rect.top + 40) event.currentTarget.scrollBy(0, -16);
    else if (event.clientY > rect.bottom - 40) event.currentTarget.scrollBy(0, 16);
  };

  // Internal moves use pointer events, not the host WebView's HTML drag session.
  // Native file imports remain on the existing HTML drag-and-drop path.
  const pointerDragActions = useRef({ startFinderDrag, updateFinderDrop, commitFinderDrop, endFinderDrag });
  pointerDragActions.current = { startFinderDrag, updateFinderDrop, commitFinderDrop, endFinderDrag };
  const pointerDragCleanup = useRef<(() => void) | null>(null);
  const suppressFinderClick = useRef(false);
  useEffect(() => () => pointerDragCleanup.current?.(), []);
  const beginFinderPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    finderPressSelection.current = [...selection];
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const item = (event.target as Element).closest<HTMLElement>('.finder-item');
    if (item?.dataset.systemFile || item?.dataset.systemFolder) return;
    const content = item?.querySelector<HTMLElement>('.finder-item__content');
    if (!item || !content) return;
    const key = item.dataset.groupKey ? `folder:${item.dataset.groupKey}` : `file:${item.dataset.videoId}`;
    pointerDragCleanup.current?.();
    suppressFinderClick.current = false;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let active = false;
    const hit = (x: number, y: number) => {
      const element = document.elementFromPoint(x, y);
      if (element?.closest('[data-system-folder]')) return null;
      const path = element?.closest<HTMLElement>('.finder-path-target');
      if (path) return { target: path.dataset.folderId ? Number(path.dataset.folderId) : null, spring: true };
      const canvas = element?.closest('.finder-canvas');
      if (!canvas) return null;
      const folder = element?.closest<HTMLElement>('[data-group-key]');
      return { target: folder ? Number(folder.dataset.groupKey) : Number(canvas.getAttribute('data-folder-id')) || null, spring: !!folder };
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
        active = true;
        suppressFinderClick.current = true;
        pointerDragActions.current.startFinderDrag({ currentTarget: content }, key);
        window.getSelection()?.removeAllRanges();
      }
      e.preventDefault();
      if (dragImage.current) {
        dragImage.current.style.left = '0';
        dragImage.current.style.transform = `translate(${e.clientX + 16}px, ${e.clientY + 16}px)`;
      }
      const destination = hit(e.clientX, e.clientY);
      if (destination) pointerDragActions.current.updateFinderDrop(destination.target, destination.spring);
      else { clearSpring(); setDropFolder(null); setDropHint('拖到文件夹以移动，或按 Esc 取消'); }
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          if (e.clientY < rect.top + 40) canvas.scrollBy(0, -16);
          else if (e.clientY > rect.bottom - 40) canvas.scrollBy(0, 16);
        }
      }
    };
    const finish = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (active) {
        const destination = hit(e.clientX, e.clientY);
        if (destination) pointerDragActions.current.commitFinderDrop(destination.target);
        else pointerDragActions.current.endFinderDrag();
      }
      pointerDragCleanup.current?.();
    };
    const cancel = () => { if (active) pointerDragActions.current.endFinderDrag(); pointerDragCleanup.current?.(); };
    const keydown = (e: KeyboardEvent) => { if (e.key === 'Escape' && active) { e.preventDefault(); e.stopPropagation(); cancel(); } };
    window.addEventListener('pointermove', move, { passive: false, capture: true });
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', keydown, true);
    pointerDragCleanup.current = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', keydown, true);
      pointerDragCleanup.current = null;
    };
  };

  /** 移动弹窗内当场新建文件夹并选中 */
  const createFolderInMove = async () => {
    const name = moveNewName.trim();
    if (!name) return;
    const id = (await db.folders.add({ name, createdAt: Date.now() })) as number;
    setMoveNewName('');
    setMoveTarget(String(id));
    await reload();
  };

  // ---------- 拖拽：移入文件夹 / 置顶 / 删除 ----------

  /**
   * 整卡起拖：鼠标移动超过阈值或触屏长按后汇到这里。
   *
   * 捕获指针：后续的 move/up 都派发到整张卡片，React 合成事件照常触发。
   */
  const beginDrag = (el: HTMLElement, pointerId: number, v: VideoRow, x: number, y: number) => {
    el.setPointerCapture(pointerId);
    const d: DragState = { video: v, x, y, overKey: null, zone: null };
    dragRef.current = d;
    setDrag(d);
  };

  const moveDrag = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    // 拖动中指针捕获抑制了页面滚动，贴近视口边缘时手动滚动。
    // 滚动容器是 PageShell 的内容区。用 data-testid 而不是类名找它 ——
    // 外壳的版式类名已经全部并进 Tailwind 工具类，没有稳定的类名可依赖了。
    const main = document.querySelector<HTMLElement>('[data-testid="page-main"]');
    if (e.clientY < 80) main?.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - 80) main?.scrollBy(0, 12);
    const inRect = (el: HTMLElement | null): boolean => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    // 顶栏两个投放区优先：落在里面就吃掉这次命中，不再去比组头
    // （组头在它们下方的文档流里，两套矩形理论上不会重叠，但优先级写死更稳）
    let zone: DragZone | null = null;
    if (inRect(pinZoneRef.current)) zone = 'pin';
    else if (inRect(deleteZoneRef.current)) zone = 'delete';
    let overKey: string | null = null;
    if (!zone) {
      for (const [key, el] of headerRefs.current) {
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          overKey = key;
          break;
        }
      }
    }
    const next: DragState = { ...d, x: e.clientX, y: e.clientY, overKey, zone };
    dragRef.current = next;
    setDrag(next);
  };

  const endDrag = async () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    // 顶栏投放区：置顶 / 删除。删除走与行内同一个确认弹窗（销毁性操作不静默执行）
    if (d.zone === 'delete') {
      askDeleteVideo(d.video);
      return;
    }
    if (d.zone === 'pin') {
      await togglePin(d.video);
      return;
    }
    if (!d.overKey) return;
    const target = d.overKey === UNCAT_KEY ? null : Number(d.overKey);
    if (target === (d.video.folderId ?? null)) return; // 原地放回
    await setVideoFolder(d.video.id, target);
    const name = target == null ? '未分类' : folders.find((f) => f.id === target)?.name;
    toast.success(`已移入「${name}」`);
    await reload();
  };

  const cancelDrag = () => {
    dragRef.current = null;
    setDrag(null);
  };

  // 拖动期间禁止文本选中、禁止触屏在拖动中滚动页面；Esc 取消拖拽。
  // 触屏长按起手时 `touch-action` 不是 none（整张卡片要保持可滚动），
  // 所以这里补一条非 passive 的 touchmove 阻止默认滚动 —— 只在拖拽进行中挂上。
  useEffect(() => {
    if (!drag) return;
    document.body.style.userSelect = 'none';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDrag();
    };
    const preventTouchScroll = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('touchmove', preventTouchScroll, { passive: false });
    return () => {
      document.body.style.userSelect = '';
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('touchmove', preventTouchScroll);
    };
  }, [drag != null]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 渲染 ----------

  const renderGroupHeader = (g: (typeof groups)[number]) => {
    return (
      <ListBox.Item
        key={`folder:${g.key}`}
        id={`folder:${g.key}`}
        textValue={g.name}
        className="finder-item"
        data-testid="group-header"
        data-group-key={g.key}
        data-drop-target={dropFolder === g.key || undefined}
        data-dragging={finderDragging.includes(`folder:${g.key}`) || undefined}
        hidden={!folderTiles.some((folder) => folder.key === g.key)}
      >
        <span className="finder-item__content" data-drop-target={dropFolder === g.key || undefined} data-dragging={finderDragging.includes(`folder:${g.key}`) || undefined} data-hidden={!folderTiles.some((folder) => folder.key === g.key) || undefined} {...folderDropProps(g.folder!.id!, true)} draggable onDragStart={(event) => startFinderDrag(event, `folder:${g.key}`)} onDragEnd={endFinderDrag}>
        <span className="finder-item__icon"><FolderIcon color={g.folder?.color} /></span>
        <span className="finder-item__name" title={g.name}>{g.name}</span>
        <span className="finder-item__meta">{g.videos.length + folders.filter((folder) => folder.parentId === g.folder!.id).length} 个项目</span>
        <span className="finder-item__date">{new Date(g.folder!.createdAt).toLocaleDateString()}</span>
        <span className="finder-item__kind">文件夹</span>
        </span>
      </ListBox.Item>
    );
  };

  const renderVideoItem = (v: VideoRow) => (
    <VideoRow
      key={v.id}
      video={v}
      isMobile={true}
      dragging={drag?.video.id === v.id}
      onPlay={() => navigate(`/player/${v.id}`)}
      onRename={() => openRename(v)}
      onMove={() => openMove(v)}
      onTogglePin={() => void togglePin(v)}
      onDelete={() => askDeleteVideo(v)}
      onReparse={v.kind === 'material' ? () => reparseMaterial(v) : undefined}
      onBeginDrag={(el, pointerId, x, y) => beginDrag(el, pointerId, v, x, y)}
      onDragMove={moveDrag}
      onDragEnd={() => void endDrag()}
      onDragCancel={cancelDrag}
    />
  );

  return (
    <PageShell
      title="资料"
      wide
      fill
      rootClassName="page-library"
      rail={nav}
      recent={recent}
      railFooter={<SettingsButton variant="rail" testId="nav-rail-settings" />}
      /* 顶栏右上角那颗设置图标撤掉（2026-10-15，与 AI 助手页同一口径）：
         设置入口统一收在侧栏底部的 `railFooter`（窄屏在抽屉里）——
         同一个入口在一条顶栏里露两次没有必要。 */
    >
      {SHOW_PWA_HINT && (
        // 标题留结论（该做什么），「为什么」收进问号——那段解释在手机上要占四行，
        // 而它只在 iOS 非独立模式下出现，正好是最缺横向空间的那一档。
        <Banner
          variant="warning"
          testId="pwa-hint"
          icon={<Sym name="warning" />}
          title="建议用 Safari 将本页「添加到主屏幕」后使用"
          help={
            <HelpTip headline="为什么要添加到主屏幕" label="说明" testId="pwa-hint-help">
              <p>
                在普通标签页中，若连续 7 天未打开，系统可能自动清除已导入的视频和字幕；
                从主屏幕打开则不会被清理。
              </p>
            </HelpTip>
          }
        />
      )}

      <Modal.Root isOpen={importOpen} onOpenChange={setImportOpen}>
        <Modal.Backdrop><Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
          <Modal.Header><Modal.Heading>导入资料</Modal.Heading><Modal.CloseTrigger /></Modal.Header>
          <Modal.Body>
      <Card.Root
        className={`drop-zone relative mt-3 flex cursor-pointer flex-row items-center gap-4 border border-dashed border-border bg-surface-secondary p-4 text-left transition-colors hover:bg-surface-tertiary max-[640px]:flex-col max-[640px]:items-center max-[640px]:gap-3 max-[640px]:p-4 max-[640px]:text-center ${dropActive ? 'border-accent bg-accent-soft' : ''}`}
        data-testid="drop-zone"
        onClick={() => nativeInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dropActive) setDropActive(true);
        }}
        onDragLeave={(e) => {
          // 在子元素之间移动也会触发 dragleave，只有真正离开整块区域才取消高亮
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false);
        }}
        onDrop={handleDrop}
      >
        <Sym name="cloud_upload" className="drop-zone__icon shrink-0 text-[28px] text-accent max-[640px]:text-[32px]" />
        <div className="drop-zone__copy min-w-0 flex-1 max-[640px]:w-full">
          <div className="drop-zone__title text-sm font-medium text-foreground">导入课程与资料</div>
          {/* 格式与存储位置留在正文；系统选择器和空间管理细节收进说明。 */}
          <div className="drop-zone__hint mt-0.5 flex items-center gap-1 text-xs leading-relaxed text-muted max-[640px]:justify-center">
            <span>拖入视频、PDF、Word、Markdown、HTML，只存本机</span>
            {/* HelpTip 内部已经 stopPropagation —— 这里整块是可点击的投放区，
                不拦住会顺手弹出文件选择器。 */}
            <HelpTip headline="导入说明" label="导入说明" testId="import-help">
              <p>
                请从「文件」App 中选择视频。从「相册」选择时系统会先转码，大视频可能长时间没有进度；
                存在 iCloud 里的文件，请先在「文件」App 中下载到本机。
              </p>
              <p>
                视频只保存在本机浏览器存储中，不会上传到任何服务器。导入完成后，可以在「文件」App
                中删除原视频来释放空间。
              </p>
            </HelpTip>
          </div>
        </div>
        <div className="drop-zone__actions flex shrink-0 flex-wrap justify-center gap-2 max-[640px]:w-full [&>[data-slot=button]]:max-[640px]:flex-1">
          {/* onClick 保留：投放区整块可点，按钮要拦住冒泡才不会顺手弹出文件选择器
              （RAC 的 usePress 会把 onClick 接到真实 click 上，stopPropagation 有效）。 */}
          <Button
            data-testid="btn-native-pick"
            variant="primary"
            onPress={() => nativeInputRef.current?.click()}
            onClick={(e) => e.stopPropagation()}
          >
            <Sym name="upload" />
            导入文件
          </Button>
          <Button
            data-testid="btn-bili-import"
            variant="secondary"
            onPress={() => {
              setImportOpen(false);
              setBiliError(null);
              setBiliOpen(true);
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <Sym name="link" />
            从 B 站导入
          </Button>
        </div>
      </Card.Root>
          </Modal.Body>
        </Modal.Dialog></Modal.Container></Modal.Backdrop>
      </Modal.Root>
      <input ref={nativeInputRef} data-testid="import-input" type="file" multiple tabIndex={-1} aria-label="选择要导入的视频或阅读材料" onChange={handleNativePick} style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }} />

      {tasks.length > 0 && (
        <Card.Root variant="secondary" className="import-tasks mt-3 flex flex-col gap-2 p-3" data-testid="import-tasks">
          {tasks.map((t) => (
            <div key={t.key} className="import-task flex min-w-0 flex-col gap-1" data-testid="import-task">
              <div className="import-task__head flex min-w-0 items-center gap-2">
                <span className="import-task-name min-w-0 flex-1 truncate text-[13px] text-foreground" title={t.name}>
                  {t.name}
                </span>
                <span
                  className={
                    t.status === 'error'
                      ? 'import-task__status max-w-[42%] truncate text-xs text-danger'
                      : 'import-task__status max-w-[42%] truncate text-xs tabular-nums text-muted'
                  }
                  data-testid="import-task-status"
                  title={t.status === 'error' ? t.error : undefined}
                >
                  {t.status === 'error'
                    ? (t.error ?? '失败')
                    : t.status === 'writing'
                      ? `${t.percent}%`
                      : TASK_STATUS_TEXT[t.status]}
                </span>
                {t.status === 'error' && (
                  <Button
                    isIconOnly
                    variant="tertiary"
                    size="sm"
                    data-testid="btn-dismiss-import-error"
                    aria-label="关掉这条失败提示"
                    onPress={() => setTasks((prev) => prev.filter((x) => x.key !== t.key))}
                  >
                    <Sym name="close" />
                  </Button>
                )}
              </div>
              {t.status !== 'done' && t.status !== 'error' && (
                // mdui-linear-progress 不给 value 就是不确定态；RAC 用显式的 isIndeterminate 表达，
                // 两者一一对应（value 有值时按百分比走，没有就转圈）。
                <ProgressBar
                  data-testid="import-progress"
                  maxValue={100}
                  value={t.status === 'writing' ? t.percent : 0}
                  isIndeterminate={t.status !== 'writing'}
                  aria-label="导入进度"
                />
              )}
            </div>
          ))}
        </Card.Root>
      )}

      <section className="finder-window" aria-label="资料访达" data-drag-active={finderDragging.length > 0 || undefined}
        onDragOver={(event) => {
          if (inSystemFolder || (event.target as Element).closest('[data-system-folder]')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'none';
            setDropActive(false);
            return;
          }
          if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDropActive(true); }
          else folderDropProps(currentFolder?.folder?.id ?? null).onDragOver(event);
        }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }}
        onDrop={(event) => {
          if (event.dataTransfer.types.includes('application/x-library-items')) folderDropProps(currentFolder?.folder?.id ?? null).onDrop(event);
          else handleDrop(event);
        }}
        data-drop-active={dropActive || undefined}
      >
        <header className="finder-toolbar">
          <div className="finder-navigation">
            <Button isIconOnly variant="ghost" aria-label="后退" isDisabled={folderHistory.index === 0} onPress={() => travelFolder(-1)}><Sym name="chevron_left" /></Button>
            <Button isIconOnly variant="ghost" aria-label="前进" isDisabled={folderHistory.index === folderHistory.entries.length - 1} onPress={() => travelFolder(1)}><Sym name="chevron_right" /></Button>
          </div>
          <h2 className="finder-title">{folderTitle}</h2>
          <div className="finder-tools">
            <ToggleButtonGroup className="finder-view-switch" selectionMode="single" disallowEmptySelection selectedKeys={[view]} onSelectionChange={(keys) => { const key = [...keys][0]; if (key === 'icons' || key === 'list') setView(key); }} aria-label="显示方式">
              <ToggleButton id="icons" aria-label="图标视图"><Sym name="grid_view" /></ToggleButton>
              <ToggleButton id="list" aria-label="列表视图"><Sym name="list" /></ToggleButton>
            </ToggleButtonGroup>
            <Dropdown>
              <Dropdown.Trigger className="finder-tool" aria-label="排序与筛选"><Sym name="sort" /></Dropdown.Trigger>
              <Dropdown.Popover><Dropdown.Menu aria-label="排序与筛选" onAction={(key) => {
                if (key === 'name' || key === 'recent') setSort(key);
                else { setFilter(key as LibraryFilter); setSelection(new Set()); }
              }}>
                <Dropdown.Item id="name" textValue="按名称排序">按名称排序 {sort === 'name' && <Sym name="check" className="size-4" />}</Dropdown.Item>
                <Dropdown.Item id="recent" textValue="最近导入优先">最近导入优先 {sort === 'recent' && <Sym name="check" className="size-4" />}</Dropdown.Item>
                <Dropdown.Section>
                  {LIBRARY_FILTERS.map((item) => <Dropdown.Item key={item.value} id={item.value} textValue={item.label}>{item.label} {filter === item.value && <Sym name="check" className="size-4" />}</Dropdown.Item>)}
                </Dropdown.Section>
              </Dropdown.Menu></Dropdown.Popover>
            </Dropdown>
            <span className="finder-tool-divider" />
            <Button isIconOnly variant="ghost" data-testid="btn-new-folder" aria-label="新建文件夹" isDisabled={inSystemFolder} onPress={() => openFolderModal('create')}><Sym name="create_new_folder" /></Button>
            <Button isIconOnly variant="ghost" aria-label="导入资料" isDisabled={inSystemFolder} onPress={() => setImportOpen(true)}><Sym name="upload" /></Button>
            <Dropdown isOpen={actionMenuOpen} onOpenChange={(open) => { setActionMenuOpen(open); if (!open) setContextPoint(null); }}>
              <Dropdown.Trigger className="finder-tool" aria-label="所选项目的操作" isDisabled={!selectedFolder && !selectedVideo}><Sym name="more_horiz" /></Dropdown.Trigger>
              <Dropdown.Popover {...(contextPoint ? { triggerRef: contextAnchor, placement: 'bottom start' as const } : {})}><Dropdown.Menu aria-label="项目操作" onAction={(key) => {
                if (key === 'open' && selectedKey) openItem(selectedKey);
                if (selectedFolder?.folder) {
                  if (key === 'rename') openFolderModal('rename', selectedFolder.folder);
                  if (key === 'delete') void confirmDeleteFolder(selectedFolder.folder, selectedFolder.videos.length);
                }
                if (selectedVideo) {
                  if (key === 'rename') openRename(selectedVideo);
                  if (key === 'move') openMove(selectedVideo);
                  if (key === 'pin') void togglePin(selectedVideo);
                  if (key === 'details') setDetails(selectedVideo);
                  if (key === 'delete') askDeleteVideo(selectedVideo);
                }
              }}>
                <Dropdown.Item id="open" textValue="打开">打开</Dropdown.Item>
                <Dropdown.Item id="rename" textValue="重命名">重命名</Dropdown.Item>
                {selectedFolder?.folder && <Dropdown.SubmenuTrigger>
                  <Dropdown.Item id="folder-color" textValue="文件夹颜色"><Label>文件夹颜色</Label><Dropdown.SubmenuIndicator /></Dropdown.Item>
                  <Dropdown.Popover><Dropdown.Menu aria-label="文件夹颜色" selectionMode="single" selectedKeys={[selectedFolder.folder.color ?? 'blue']} onAction={(key) => {
                    const color = FOLDER_COLORS.find((entry) => entry.id === key)?.id;
                    const folderId = selectedFolder.folder?.id;
                    if (!color || folderId == null) return;
                    void (async () => {
                      try {
                        await db.folders.update(folderId, { color });
                        await reload();
                      } catch (error) {
                        toast.error(`修改文件夹颜色失败：${formatCaughtError(error)}`);
                      }
                    })();
                  }}>
                    {FOLDER_COLORS.map((color) => <Dropdown.Item key={color.id} id={color.id} textValue={color.label}>
                      <span className="size-4 shrink-0 rounded-full border border-black/10" style={{ backgroundColor: color.swatch }} aria-hidden="true" />
                      <Label>{color.label}</Label><Dropdown.ItemIndicator />
                    </Dropdown.Item>)}
                  </Dropdown.Menu></Dropdown.Popover>
                </Dropdown.SubmenuTrigger>}
                {selectedVideo && <Dropdown.Item id="move" textValue="移动到文件夹">移动到文件夹</Dropdown.Item>}
                {selectedVideo && <Dropdown.Item id="pin" textValue="置顶">{selectedVideo.pinned === 1 ? '取消置顶' : '置顶'}</Dropdown.Item>}
                {selectedVideo && <Dropdown.Item id="details" textValue="显示简介">显示简介</Dropdown.Item>}
                <Dropdown.Item id="delete" textValue="删除" className="text-danger">删除</Dropdown.Item>
              </Dropdown.Menu></Dropdown.Popover>
            </Dropdown>
          </div>
          <SearchField className="finder-search" aria-label={currentFolder || inSystemFolder ? '搜索此文件夹' : '搜索全部资料'} value={searchText} onChange={(value) => { setSearchText(value); setSelection(new Set()); }}>
            <SearchField.Group><SearchField.SearchIcon /><SearchField.Input ref={searchInputRef} data-testid="library-search" placeholder="搜索" /><SearchField.ClearButton /></SearchField.Group>
          </SearchField>
        </header>
        {hasFilters && <div className="finder-search-scope"><span>搜索范围：{folderTitle}{filter !== 'all' ? ` · ${LIBRARY_FILTERS.find((item) => item.value === filter)?.label}` : ''}</span><Button variant="ghost" size="sm" onPress={clearFilters}>清除筛选</Button></div>}
      <div className="finder-canvas" data-testid="video-list" onClick={(event) => { if (event.target === event.currentTarget) setSelection(new Set()); }}
        ref={canvasRef}
        data-folder-id={currentFolder?.folder?.id ?? ''}
        onDragStartCapture={(event) => { if ((event.target as Element).closest('.finder-item')) event.preventDefault(); }}
        onDragEnterCapture={finderCanvasDragOver}
        onDragOverCapture={finderCanvasDragOver}
        onDropCapture={(event) => {
          const folder = (event.target as Element).closest<HTMLElement>('[data-group-key]');
          folderDropProps(folder ? Number(folder.dataset.groupKey) : currentFolder?.folder?.id ?? null).onDrop(event);
        }}
        onPointerDownCapture={beginFinderPointer}
        onPointerDown={marquee.onPointerDown}
        onClickCapture={(event) => {
          if (suppressFinderClick.current) { event.preventDefault(); event.stopPropagation(); suppressFinderClick.current = false; }
          else marquee.onClickCapture(event);
        }}
        onContextMenu={(event) => {
          const item = (event.target as HTMLElement).closest<HTMLElement>('[data-video-id], [data-group-key]');
          if (!item) return;
          event.preventDefault();
          const key = item.dataset.videoId ? `file:${item.dataset.videoId}` : `folder:${item.dataset.groupKey}`;
          setSelection(new Set([key]));
          setContextPoint({ x: event.clientX, y: event.clientY });
          setActionMenuOpen(true);
        }}
      >
        <span ref={contextAnchor} aria-hidden="true" style={{ position: 'fixed', left: contextPoint?.x ?? 0, top: contextPoint?.y ?? 0, width: 1, height: 1, pointerEvents: 'none' }} />
        <SkeletonReveal show={showSkeleton} skeleton={<LibrarySkeleton count={isMobile ? 3 : 6} />}>
          {/* 只在首屏把内容让给骨架；其余任何时刻（包括将来真给刷新加了 loading 态）
              都要继续渲染手上的列表，不能把已有内容清空 —— 这是「台上至少有一层」那条
              不变量在调用侧的对应写法，与 showSkeleton 的判据保持一致。 */}
          {isFirstLoad ? null : loadState === 'error' ? (
            /* 读库失败：原先既没有 try/catch 也没有错误态，IndexedDB 打不开时
               页面会停在「什么都没有」的样子，用户只会以为自己的课程丢了。
               错误态至少要把「读不出来」和「确实没有」分开。 */
            <Banner
              variant="error"
              testId="library-load-error"
              icon={<Sym name="error" />}
              title="资料读取失败"
              description={loadError ?? '本机数据库打不开，课程与资料暂时读不出来。'}
              action={
                <Button
                  variant="secondary"
                  data-testid="btn-library-retry"
                  onPress={() => {
                    setLoadState('loading');
                    setLoadError(null);
                    void reload();
                  }}
                >
                  重试
                </Button>
              }
            />
          ) : videos.length === 0 && folders.length === 0 && !showAgentFile && !showSystemFolder && !hasFilters ? (
            // 不再给 description：上面那条投放区已经把「点哪儿导入 / 从 B 站导入 / 只存本机不上传」
            // 全说完了，这里再铺一句等于让手机端多占三行重复文案。
            <EmptyState testId="empty-state" icon={<Sym name="folder_open" />} title="还没有资料" action={<Button variant="secondary" onPress={() => setImportOpen(true)}>导入文件</Button>} />
          ) : hasFilters && visibleCount === 0 ? (
            <EmptyState
              testId="library-no-results"
              icon={<Sym name="search" />}
              title="没有找到匹配的内容"
              description={searchQuery ? '试试其他名称，或清除筛选查看全部内容。' : '当前筛选下没有内容，可以切换到全部查看。'}
              action={<Button variant="secondary" onPress={clearFilters}>清除搜索和筛选</Button>}
            />
          ) : (
            <>
              {view === 'list' && <div className="finder-list-heading" aria-hidden="true"><span>名称</span><span>项目 / 大小</span><span>添加日期</span><span>种类</span></div>}
              <ListBox aria-label={folderTitle} className={`finder-items finder-items--${view}`} layout={view === 'icons' ? 'grid' : 'stack'} selectionMode="multiple" selectionBehavior="replace" selectedKeys={selection} onSelectionChange={(keys) => setSelection(new Set([...keys].map(String)))} onAction={(key) => openItem(String(key))} onClick={(event) => { if (event.target === event.currentTarget) setSelection(new Set()); }}>
                {showSystemFolder && <ListBox.Item id="system:folder" textValue="system" className="finder-item finder-item--folder" data-testid="system-folder" data-system-folder="true" data-selection-key="system:folder">
                  <span className="finder-item__content">
                    <span className="finder-item__icon"><FolderIcon color="gray" /></span>
                    <span className="finder-item__name" title="/system">system</span>
                    <span className="finder-item__meta">1 个项目</span>
                    <span className="finder-item__date">应用系统文件</span>
                    <span className="finder-item__kind">系统文件夹</span>
                  </span>
                </ListBox.Item>}
                {showAgentFile && <ListBox.Item id="system:agent-instructions" textValue="AGENTS.md" className="finder-item" data-testid="agent-instructions-file" data-system-file="AGENTS.md" data-selection-key="system:agent-instructions">
                  <span className="finder-item__content">
                    <span className="finder-item__icon"><Sym name="description" className="text-6xl text-accent" /></span>
                    <span className="finder-item__name" title="AGENTS.md">AGENTS.md</span>
                    <span className="finder-item__meta">全局 Agent 指令</span>
                    <span className="finder-item__date">与设置实时同步</span>
                    <span className="finder-item__kind">系统 Markdown</span>
                  </span>
                </ListBox.Item>}
                {renderedFolders.map(renderGroupHeader)}
                {renderedVideos.map((video) => <ListBox.Item key={`file:${video.id}`} id={`file:${video.id}`} textValue={video.name} className="finder-item" data-testid="video-item" data-video-id={video.id} hidden={!displayedVideos.some((row) => row.id === video.id)} data-dragging={finderDragging.includes(`file:${video.id}`) || undefined}>
                  <span className="finder-item__content"
                  data-dragging={finderDragging.includes(`file:${video.id}`) || undefined}
                  data-hidden={!displayedVideos.some((row) => row.id === video.id) || undefined}
                  draggable
                  onDragStart={(event) => startFinderDrag(event, `file:${video.id}`)}
                  onDragEnd={endFinderDrag}
                  >
                  <span className="finder-item__icon"><FinderFileIcon video={video} /></span>
                  <span className="finder-item__name" title={video.name}>{video.name}{video.kind === 'material' && video.materialFormat && !video.name.toLowerCase().endsWith(`.${video.materialFormat}`) ? `.${video.materialFormat}` : ''}</span>
                  <span className="finder-item__meta" title={formatSize(video.size)}>{finderProgressText(video) ?? formatSize(video.size)}</span>
                  <span className="finder-item__date">{new Date(video.createdAt).toLocaleDateString()}</span>
                   <span className="finder-item__kind">{video.kind === 'material' ? video.materialFormat?.toUpperCase() ?? '文档' : '视频'}</span>
                  </span>
                </ListBox.Item>)}
              </ListBox>
              {currentFolder && visibleCount === 0 && <EmptyState icon={<Sym name="folder_open" />} title="文件夹还是空的" description="通过资料的更多菜单，将已有资料移动到这里。" action={<Button variant="secondary" onPress={() => openFolder(null)}>浏览全部资料</Button>} />}
            </>
          )}
        </SkeletonReveal>
        {marquee.box && <div className="finder-selection-box" data-testid="selection-box" aria-hidden="true" style={marquee.box} />}
      </div>
        <footer className="finder-footer">
          {moveNotice && !finderDragging.length && <div className="finder-move-notice" data-error={moveNotice.error || undefined} role={moveNotice.error ? 'alert' : 'status'}><span>{moveNotice.text}</span>{lastMove.length > 0 && <Button size="sm" variant="ghost" onPress={() => void undoFinderMove()} isDisabled={undoingMove}>撤销移动</Button>}<Button size="sm" isIconOnly variant="ghost" aria-label="关闭移动提示" onPress={() => setMoveNotice(null)}>×</Button></div>}
           <nav aria-label="资料路径" className="finder-path"><span className="finder-path-target" data-drop-target={dropFolder === 'root' || undefined} {...pathDropProps(null)}><Button variant="ghost" size="sm" onPress={() => openFolder(null)}><Sym name="folder" />全部资料</Button></span>{inSystemFolder && <><Sym name="chevron_right" /><Button variant="ghost" size="sm" aria-current="page" onPress={() => openFolder('system')}>system</Button></>}{folderPath.map((folder) => <span key={folder.id} className="finder-path-target" data-folder-id={folder.id} data-drop-target={dropFolder === String(folder.id) || undefined} {...pathDropProps(folder.id!)}><Sym name="chevron_right" /><Button variant="ghost" size="sm" aria-current={folder.id === currentFolder?.folder?.id ? 'page' : undefined} onPress={() => openFolder(String(folder.id))}>{folder.name}</Button></span>)}{!finderDragging.length && (selectedVideo || selectedFolder) && <><Sym name="chevron_right" /><span>{selectedVideo?.name ?? selectedFolder?.name}</span></>}</nav>
          {finderDragging.length > 0 && <div className="finder-drag-status" role="status"><Sym name={dropHint.startsWith('不能') ? 'block' : 'folder_open'} /><span>{dropHint}</span><kbd>Esc 取消</kbd></div>}
          <div className="finder-status"><span role="status">{selection.size > 0 ? `已选择 ${selection.size} 项，共 ${visibleCount} 项` : `${visibleCount} 个项目`}</span><span className="finder-interaction-hint">{isMobile ? '轻点打开 · 长按选择' : '拖动空白处框选 · 双击打开'}</span>{selectedVideo && <Button isIconOnly size="sm" variant="ghost" aria-label="显示简介" onPress={() => setDetails(selectedVideo)}><Sym name="info" /></Button>}</div>
        </footer>
        {dropActive && <div className="finder-drop-overlay">松开以导入资料</div>}
      </section>
      <Modal.Root isOpen={agentFileOpen} onOpenChange={setAgentFileOpen}>
        <Modal.Backdrop><Modal.Container placement="center" size="lg" className={MODAL_CONTAINER_CLASS}><Modal.Dialog data-testid="agent-instructions-file-dialog">
          <Modal.Header><Modal.Heading>全局 Agent 指令文件</Modal.Heading><Modal.CloseTrigger aria-label="关闭指令文件" data-testid="agent-file-close" /></Modal.Header>
          <Modal.Body><AgentModule fileView /></Modal.Body>
        </Modal.Dialog></Modal.Container></Modal.Backdrop>
      </Modal.Root>
      <Modal.Root isOpen={!!details} onOpenChange={(open) => { if (!open) setDetails(null); }}>
        <Modal.Backdrop><Modal.Container placement="center" size="sm" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
          <Modal.Header><Modal.Heading>资料简介</Modal.Heading><Modal.CloseTrigger /></Modal.Header>
          <Modal.Body>{details && renderVideoItem(videos.find((video) => video.id === details.id) ?? details)}</Modal.Body>
        </Modal.Dialog></Modal.Container></Modal.Backdrop>
      </Modal.Root>

      {/* 拖拽悬浮卡片：跟随指针，位于指针上方避免被手指遮挡；pointerEvents:none 不影响命中检测 */}
      {drag && (
        <div className="drag-ghost pointer-events-none fixed z-50 flex w-56 max-w-[70vw] flex-col gap-2 rounded-2xl border border-accent bg-surface p-4 text-sm text-foreground shadow-lg -translate-x-1/2" style={{ left: drag.x, top: drag.y + 20 }} aria-hidden="true">
          <Sym name={drag.zone === 'delete' ? 'delete' : 'drag_indicator'} className={`text-2xl ${drag.zone === 'delete' ? 'text-danger' : 'text-accent'}`} />
          <span className="line-clamp-2 font-medium">{drag.video.name}</span>
          <span className="text-xs text-muted">{drag.zone === 'delete' ? '松手后确认删除' : drag.zone === 'pin' ? '松手完成置顶操作' : drag.overKey ? '松手移入此文件夹' : '拖到上方操作区或文件夹'}</span>
        </div>
      )}

      {/* 顶栏两个卡片级投放区：拖拽进行中才挂载，钉在视口顶部两角。
          左侧「置顶」（已置顶的卡片显示为「取消置顶」），右侧「删除」。
          pointerEvents:none —— 命中检测走 getBoundingClientRect，不需要它们接事件，
          也就不会挡住悬浮卡片或误触。 */}
      {drag && (
        <div className="drag-zones pointer-events-none fixed top-0 right-0 left-0 z-50 flex justify-between gap-4 p-3" role="status" aria-live="polite" aria-atomic="true">
          <div
            ref={pinZoneRef}
            className={`drag-zone flex min-h-24 w-56 max-w-[45%] items-center justify-center gap-2 rounded-2xl border-2 border-dashed bg-surface p-4 text-sm font-medium shadow-lg ${drag.zone === 'pin' ? 'border-solid border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border-secondary text-foreground'}`}
            data-testid="drag-zone-pin"
          >
            <Sym name={drag.video.pinned === 1 ? 'pin_off' : 'pin'} className="drag-zone__icon" />
            <span>{drag.zone === 'pin' ? '松手即可' : '拖到这里'}{drag.video.pinned === 1 ? '取消置顶' : '置顶'}</span>
          </div>
          <div
            ref={deleteZoneRef}
            className={`drag-zone flex min-h-24 w-56 max-w-[45%] items-center justify-center gap-2 rounded-2xl border-2 border-dashed bg-surface p-4 text-sm font-medium shadow-lg ${drag.zone === 'delete' ? 'border-solid border-danger bg-danger-soft text-danger-soft-foreground' : 'border-border-secondary text-foreground'}`}
            data-testid="drag-zone-delete"
          >
            <Sym name="delete" className="drag-zone__icon" />
            <span className="flex flex-col gap-1"><span>{drag.zone === 'delete' ? '松手删除' : '拖到这里删除'}</span><span className="text-xs font-normal">松手后仍需确认</span></span>
          </div>
        </div>
      )}

      {/* ── 弹窗 ─────────────────────────────────────────────────────────── */}
      {/* mdui-dialog → HeroUI Modal：内容分装进 Header/Body/Footer，Esc 与点遮罩关闭
          由 onOpenChange 同步回 state（不再需要 useMduiEvent 监听 closed 事件）。 */}
      <Modal.Root isOpen={!!renaming} onOpenChange={(open) => !open && setRenaming(null)}>
        <Modal.Backdrop>
          <Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
            <Modal.Dialog data-testid="rename-dialog">
              <Modal.Header>
                <Modal.Heading>修改标题</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                {/* data-testid 挂 TextField 包装层：e2e 用 `[data-testid="rename-input"] input` 定位控件 */}
                <TextField data-testid="rename-input" fullWidth>
                  <Input
                    value={renameText}
                    maxLength={100}
                    placeholder="输入视频标题"
                    aria-label="视频标题"
                    autoFocus
                    onChange={(e) => setRenameText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void confirmRename();
                    }}
                  />
                </TextField>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" data-testid="rename-cancel" onPress={() => setRenaming(null)}>
                  取消
                </Button>
                <Button variant="primary" data-testid="rename-save" onPress={() => void confirmRename()}>
                  保存
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>

      <Modal.Root isOpen={!!folderModal} onOpenChange={(open) => !open && setFolderModal(null)}>
        <Modal.Backdrop>
          <Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
            <Modal.Dialog data-testid="folder-dialog">
              <Modal.Header>
                <Modal.Heading>
                  {folderModal?.mode === 'rename' ? '重命名文件夹' : '新建文件夹'}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <TextField data-testid="folder-input" fullWidth>
                  <Input
                    value={folderText}
                    maxLength={50}
                    placeholder="如：行测、申论、面试"
                    aria-label="文件夹名称"
                    autoFocus
                    onChange={(e) => setFolderText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void confirmFolderModal();
                    }}
                  />
                </TextField>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" data-testid="folder-cancel" onPress={() => setFolderModal(null)}>
                  取消
                </Button>
                <Button variant="primary" data-testid="folder-save" onPress={() => void confirmFolderModal()}>
                  保存
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>

      <Modal.Root isOpen={!!moving} onOpenChange={(open) => !open && setMoving(null)}>
        <Modal.Backdrop>
          <Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
            <Modal.Dialog data-testid="move-dialog">
              <Modal.Header>
                <Modal.Heading>{moving ? `移动《${moving.name}》到` : ''}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                {/* mdui-radio-group/-radio → RadioGroup/Radio；选中值走 value + onChange。
                    Radio 需要显式组合 Content/Control/Indicator 才有可点的圆点。 */}
                <RadioGroup
                  value={moveTarget}
                  onChange={(key) => setMoveTarget(String(key))}
                  data-testid="move-radio-group"
                  aria-label="移动到文件夹"
                >
                  <Radio value="-1">
                    <Radio.Content>
                      <Radio.Control>
                        <Radio.Indicator />
                      </Radio.Control>
                      未分类
                    </Radio.Content>
                  </Radio>
                  {folders.map((f) => (
                    <Radio key={f.id} value={String(f.id)}>
                      <Radio.Content>
                        <Radio.Control>
                          <Radio.Indicator />
                        </Radio.Control>
                        {f.name}
                      </Radio.Content>
                    </Radio>
                  ))}
                </RadioGroup>
                <div className="row row--nowrap" style={{ marginTop: 16 }}>
                  <TextField data-testid="move-new-name" fullWidth>
                    <Input
                      value={moveNewName}
                      maxLength={50}
                      placeholder="新建文件夹名称"
                      aria-label="新建文件夹名称"
                      onChange={(e) => setMoveNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createFolderInMove();
                      }}
                    />
                  </TextField>
                  <Button
                    data-testid="move-create-folder"
                    variant="secondary"
                    isDisabled={!moveNewName.trim()}
                    onPress={() => void createFolderInMove()}
                  >
                    新建并选中
                  </Button>
                </div>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" data-testid="move-cancel" onPress={() => setMoving(null)}>
                  取消
                </Button>
                <Button variant="primary" data-testid="move-confirm" onPress={() => void confirmMove()}>
                  移动
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>

      {/* 导入中不允许 Esc / 点遮罩关闭：isDismissable 管遮罩，isKeyboardDismissDisabled 管 Esc。
          （原 mdui 版的 close-on-esc / close-on-overlay-click 二选一即可关闭。） */}
      <Modal.Root
        isOpen={biliOpen}
        onOpenChange={(open) => {
          if (!open && !biliImporting) {
            setBiliOpen(false);
            resetBiliDraft();
          }
        }}
      >
        <Modal.Backdrop isDismissable={!biliImporting} isKeyboardDismissDisabled={biliImporting}>
          <Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
            <Modal.Dialog data-testid="bili-dialog">
              <Modal.Header>
                <Modal.Heading>导入哔哩哔哩视频</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                {/* 原来是多行自增的 mdui-text-field → TextField 包 TextArea。
                    TextArea 没有 isDisabled，用原生 disabled。 */}
                <TextField fullWidth>
                  <TextArea
                    data-testid="bili-url"
                    rows={2}
                    value={biliUrl}
                    placeholder="粘贴 B 站视频链接 / BV 号 / b23.tv 短链"
                    aria-label="B 站视频链接"
                    disabled={biliImporting || biliResolving}
                    onChange={(e) => {
                      setBiliUrl(e.target.value);
                      setBiliTarget(null); // 改链接后旧的解析结果（含字幕列表）作废
                      ++langReqRef.current;
                      setBiliSubtitleError(null);
                      setBiliSubtitleLoading(false);
                    }}
                  />
                </TextField>
                <div className="text-secondary" style={{ marginTop: 8, fontSize: 12 }}>
                  {isBiliBridgeAvailable()
                    ? '已连接油猴桥，将从本机直连 B 站。未登录约 360P，设置里贴 SESSDATA 可解锁更高清晰度。'
                    : '推荐先在「设置」安装油猴脚本（桌面浏览器）；没有脚本则需填写代理。未登录约 360P。'}
                </div>
                {biliTarget && (
                  <div style={{ marginTop: 12 }} data-testid="bili-target">
                    <div className="row row--nowrap" style={{ alignItems: 'baseline', gap: 8 }}>
                      <strong
                        style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {biliTarget.title}
                      </strong>
                      <span className="text-secondary" style={{ fontSize: 12 }} data-testid="bili-summary">
                        {multiPage
                          ? `共 ${biliTarget.pages.length} ${biliTarget.kind === 'season' ? '集' : 'P'} · 已选 ${biliPagesSel.length} · 合计 ${formatTotalDuration(selectedSec)}`
                          : formatTotalDuration(selectedSec)}
                      </span>
                    </div>
                    {multiPage && (
                      <>
                        <div className="row row--nowrap" style={{ gap: 8, marginTop: 10 }}>
                          <span className="text-secondary" style={{ flex: 1, fontSize: 12 }}>
                            {biliTarget.kind === 'season' ? '合集选集（可多选，默认仅选当前视频）' : '分 P（每个 P 是一条独立视频，可多选）'}
                          </span>
                          <Button variant="tertiary" data-testid="bili-pages-all" onPress={() => selectAllPages(true)}>
                            全选
                          </Button>
                          <Button
                            variant="tertiary"
                            data-testid="bili-pages-none"
                            isDisabled={biliPagesSel.length === 0}
                            onPress={() => selectAllPages(false)}
                          >
                            清空
                          </Button>
                        </div>
                        {/* mdui-chip selectable → TagGroup/Tag（React Aria 的多选标签）：
                            选中集以 selectedKeys 受控，onSelectionChange 直接给新集合，
                            不再需要「容器上监听 change 冒泡」那套补丁。 */}
                        <TagGroup
                          selectionMode="multiple"
                          selectedKeys={biliPagesSel.map(String)}
                          onSelectionChange={(keys) => selectPages([...keys].map(String))}
                          aria-label={biliTarget.kind === 'season' ? '选择合集视频' : '选择分 P'}
                        >
                          <TagGroup.List
                            className="row"
                            style={{ flexWrap: 'wrap', gap: 8, marginTop: 6, maxHeight: 168, overflowY: 'auto' }}
                            data-testid="bili-pages"
                          >
                            {biliTarget.pages.map((p) => (
                              <Tag
                                key={p.page}
                                id={String(p.page)}
                                textValue={pageLabel(p)}
                                /* 原 title 提示（分 P 名 + 时长）改由 aria-label 承载：
                                   RAC 的 filterDOMProps 不放行 title 属性。 */
                                aria-label={`${pageLabel(p)} · ${formatDuration(p.duration)}`}
                                data-page={String(p.page)}
                                data-testid="bili-page"
                              >
                                {pageLabel(p)}
                              </Tag>
                            ))}
                          </TagGroup.List>
                        </TagGroup>
                      </>
                    )}
                    {biliSubtitleLoading ? (
                      <p className="text-secondary mt-2 text-sm" role="status">正在读取字幕…</p>
                    ) : biliSubtitleError ? (
                      <div className="mt-2 flex flex-col gap-2" data-testid="bili-subtitle-error">
                        <Banner variant="warning" title="字幕读取失败，并非已确认没有字幕" description={biliSubtitleError} />
                        <Button variant="tertiary" isDisabled={biliImporting} onPress={() => {
                          const page = firstSelectedPage(biliTarget, biliPagesSel);
                          if (page != null) void refreshLangsForPage(biliTarget, page);
                        }}>重试读取字幕</Button>
                      </div>
                    ) : biliLangItems.length > 0 ? (
                      <>
                        <div className="text-secondary" style={{ fontSize: 12, marginTop: 10 }}>
                          {multiPage ? `字幕语言（按${biliTarget.kind === 'season' ? `第${biliLangPage ?? ''}集` : ` P${biliLangPage ?? ''}`}上可用的语言）` : '自带字幕'}
                          ：选中的第一路作主字幕（讲义/问答用它），其余可选做播放页的「对照语言」
                        </div>
                        <TagGroup
                          selectionMode="multiple"
                          selectedKeys={biliLangs}
                          onSelectionChange={(keys) => selectLangs([...keys].map(String))}
                          aria-label="选择字幕语言"
                        >
                          <TagGroup.List
                            className="row"
                            style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}
                            data-testid="bili-langs"
                          >
                            {biliLangItems.map((s) => (
                              <Tag
                                key={s.lan}
                                id={s.lan}
                                textValue={s.lanDoc || s.lan}
                                data-lang={s.lan}
                                data-testid="bili-lang"
                              >
                                {s.lanDoc || s.lan}
                              </Tag>
                            ))}
                          </TagGroup.List>
                        </TagGroup>
                      </>
                    ) : (
                      <div className="text-secondary" style={{ fontSize: 12, marginTop: 10 }}>
                        该视频没有自带字幕，导入后可点「生成字幕」走本地转写
                      </div>
                    )}
                  </div>
                )}
                {biliImporting && (
                  <div className="mt-3 flex flex-col gap-2" data-testid="bili-download-status">
                    <div className="text-secondary truncate text-sm" data-testid="bili-label" title={biliLabel}>
                      {biliLabel ? `正在下载 ${biliLabel}` : '正在下载…'}
                    </div>
                    <ProgressBar
                      data-testid="bili-progress"
                      maxValue={100}
                      value={biliProgress}
                      aria-label="总体下载进度"
                    >
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span>总体进度</span>
                        <ProgressBar.Output className="tabular-nums" data-testid="bili-progress-value" />
                      </div>
                      <ProgressBar.Track>
                        <ProgressBar.Fill data-testid="bili-progress-fill" />
                      </ProgressBar.Track>
                    </ProgressBar>
                    <p className="text-secondary text-xs">包含所选视频的下载、封装和字幕处理，完成后自动加入资料库。</p>
                  </div>
                )}
                {biliError && (
                  <Banner
                    variant="error"
                    testId="bili-error"
                    icon={<Sym name="error" />}
                    title="导入失败"
                    description="详情见上方的错误弹窗，可一键复制"
                  />
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" data-testid="bili-cancel" onPress={() => setBiliOpen(false)}>
                  取消
                </Button>
                {biliTarget ? (
                  <LoadingButton
                    variant="primary"
                    data-testid="bili-confirm"
                    loading={biliImporting}
                    onPress={() => void handleBiliImport()}
                  >
                    开始导入
                  </LoadingButton>
                ) : (
                  <LoadingButton
                    variant="primary"
                    data-testid="bili-confirm"
                    loading={biliResolving}
                    onPress={() => void handleBiliResolve()}
                  >
                    解析
                  </LoadingButton>
                )}
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>
    </PageShell>
  );
}

/**
 * 单个视频行。抽成组件是为了让 ⋯ 菜单 / 开关这类「每行一份」的元素各自持有自己的 ref，
 * 而不必在父级维护一张 ref 表（阶段 1 的 SkillRow 同一模式）。
 *
 * 行结构自建（不用 mdui-list-item）：一行里有拖拽手柄 + 标题/元信息 + 标签 + 最多 3 个按钮，
 * 而 mdui-list-item 的 custom 插槽是覆盖式的，塞不下（详见 layout.css 的注释）。
 */
/**
 * 卡片缩略图：读 `covers` 表里那份**派生封面**（生成逻辑见 `pipelines/cover.ts`）。
 *
 * 与上一版的差别：那版直接取 `db.frames` 的第一帧，于是「只有跑过讲义的视频才有封面」
 * 成了默认行为，讲义重生成时封面还会短暂消失。现在封面是入库即生成的独立资源，
 * 帧池归讲义用、封面归列表用，各管各的。
 *
 * 四处刻意的做法：
 *   1. `covers.get(videoId)` 是**主键查询、只读一条**。封面之所以不挂在 `videos` 行上，
 *      就是为了让列表页那句 `videos.toArray()` 不会把几十上百张图的 blob 一并拉进内存。
 *   2. 订阅 `useCoverRevision`：封面是异步补上的，靠它把新生成的图换上，
 *      而不用为一张缩略图去调整个列表的 reload。
 *   3. 用 `createdAt` 判断「是不是同一版封面」——IndexedDB 每次读都会重新反序列化，
 *      Blob 的对象身份稳定不了，比不了引用只能比这个。
 *   4. 先建好新的 object URL 再回收旧的，中间不留「指向已撤销 URL」的空窗；
 *      组件卸载时才做最后一次回收。
 */
function useThumb(videoId: string): string | null {
  const revision = useCoverRevision();
  const [url, setUrl] = useState<string | null>(null);
  const created = useRef<string | null>(null);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    db.covers
      .get(videoId)
      .then((row) => {
        if (cancelled) return;
        const at = row?.createdAt ?? null;
        // 同一版封面（别的卡片触发了 revision 变化）：不重建、不撤销，免得图标闪一下
        if (at === shownAt.current) return;
        const next = row?.blob ? URL.createObjectURL(row.blob) : null;
        if (created.current) URL.revokeObjectURL(created.current);
        created.current = next;
        shownAt.current = at;
        setUrl(next);
      })
      .catch(() => {
        /* 读封面失败只是「这次没图」，静默走占位，不影响列表 */
      });
    return () => {
      cancelled = true;
    };
  }, [videoId, revision]);

  useEffect(
    () => () => {
      if (created.current) URL.revokeObjectURL(created.current);
      created.current = null;
      shownAt.current = null;
    },
    [],
  );

  return url;
}

function finderProgressText(video: VideoRow): string | null {
  const ratio = progressRatio(video);
  if (ratio == null) return null;
  return video.finished === 1 ? '已看完' : `已看 ${Math.round(ratio * 100)}%`;
}

function FinderFileIcon({ video }: { video: VideoRow }) {
  const cover = useThumb(video.id);
  const isMaterial = video.kind === 'material';
  const ratio = progressRatio(video);
  const extension = isMaterial ? (video.materialFormat ?? 'doc').toUpperCase() : 'VIDEO';
  return (
    <span className={isMaterial ? 'finder-document' : 'finder-video'}>
      {cover ? <img src={cover} alt="" loading="lazy" decoding="async" /> : <span className="finder-file-placeholder" aria-hidden="true">{isMaterial ? <><i /><i /><i /><i /><i /><i /></> : <Sym name="play_circle" />}</span>}
      <span className="finder-file-extension">{extension}</span>
      {ratio != null && <span
        className="finder-video-progress"
        role="progressbar"
        aria-label={`${video.name}观看进度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuetext={finderProgressText(video) ?? undefined}
      ><span style={{ width: `${ratio * 100}%` }} /></span>}
      {video.pinned === 1 && <span className="finder-file-pin" aria-label="已置顶"><Sym name="pin" /></span>}
    </span>
  );
}

function VideoRow({
  video: v,
  isMobile,
  dragging,
  onPlay,
  onRename,
  onMove,
  onTogglePin,
  onDelete,
  onReparse,
  onBeginDrag,
  onDragMove,
  onDragEnd,
  onDragCancel,
}: {
  video: VideoRow;
  isMobile: boolean;
  dragging: boolean;
  onPlay: () => void;
  onRename: () => void;
  onMove: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  /** 只有阅读材料有：重新解析 + 重建索引 */
  onReparse?: () => void;
  /** 整卡长按到点：以卡片元素为指针捕获目标开始拖拽 */
  onBeginDrag: (el: HTMLElement, pointerId: number, x: number, y: number) => void;
  onDragMove: (e: React.PointerEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragCancel: () => void;
}) {
  const isMaterial = v.kind === 'material';
  const matKind: 'page' | 'para' = v.materialFormat === 'pdf' || !v.materialFormat ? 'page' : 'para';
  const noun = matKind === 'page' ? '页' : '段';
  const unitText = v.unitCount
    ? `${v.unitCount} ${noun}`
    : v.empty === 1
      ? '无正文'
      : '未解析';
  /**
   * 材料的状态标签与视频不是一套语义：
   * 已解析 / 待解析 / 扫描件（不可检索）/ 无正文（不可检索）/ 文件已删。
   * 「扫描件」与「无正文」都用 error 色的理由：它们不是失败，但**功能确实受限**，必须显眼。
   * 两者必须分开：扫描件是「有页面但取不到字」（只可能是 PDF），无正文是「压根没内容」。
   */
  const status = isMaterial
    ? v.scanned === 1
      ? { variant: 'error' as const, text: '扫描件·不可检索' }
      : v.empty === 1
        ? { variant: 'error' as const, text: '无正文·不可检索' }
        : v.unitCount
          ? { variant: 'primary' as const, text: `已解析 ${v.unitCount} ${noun}` }
          : { variant: '' as const, text: '待解析' }
    : STATUS_TAG[v.status];
  const meta = `${isMaterial ? unitText : formatDuration(v.duration)} · ${formatSize(v.size)} · ${new Date(v.createdAt).toLocaleDateString()}`;
  const cover = useThumb(v.id);
  /**
   * 播放进度条的比例。`null` = 不该画这根条 —— 渲染条件就是它，而不是画一条 0 宽度的
   * （否则「看了 2 秒」和「没看过」在页面上长得一样）。规则全在纯函数里，
   * 见 utils/videoProgress.ts 与 docs/plans/2026-09-18-home-progress-bar-design.md。
   *
   * 数据不用额外查：列表页的 reload() 本来就把 videos 整行读进内存了。
   */
  const ratio = progressRatio(v);
  // 转写是全局队列里的后台任务：在播放页、在别处、刷新后续跑的，列表上都要看得到
  const job = useTranscribeJob(v.id);
  const activeJob = isJobActive(job) ? job : undefined;
  const jobCopy = activeJob ? libraryJobCopy(activeJob) : undefined;

  /**
   * 整卡长按起拖。
   *
   * 为什么要长按而不是「按下即拖」：整张卡片在触屏上还要能**滚动列表**、点缩略图进播放页，
   * 若按下就进入拖拽这两件事都会被抢走。长按（按住不动约 400ms）是触屏里表达「拿起」的
   * 通用手势，且与「点一下 = 进入」互不冲突。
   *
    * 鼠标按住移动超过阈值即可起拖，不需要等长按。
   */
  const articleRef = useRef<HTMLElement>(null);
  const pressTimer = useRef<number | null>(null);
  const pressOrigin = useRef<{ x: number; y: number; pointerId: number; pointerType: string } | null>(null);
  /** 长按起拖后要吃掉落点那次 click（否则松手会顺手点进播放页 / 弹出菜单） */
  const swallowClick = useRef(false);

  useEffect(() => () => {
    if (pressTimer.current != null) window.clearTimeout(pressTimer.current);
  }, []);

  const clearPress = () => {
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressOrigin.current = null;
  };

  const onCardPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    // 长按只认主指针（触屏 / 鼠标左键）
    if (!e.isPrimary || e.button !== 0) return;
    const target = e.target as HTMLElement;
    // 缩略图也是起拖区域；操作按钮仍保持原生点击行为。
    if (target.closest('button, a, input, textarea, select, [data-slot="dropdown-trigger"]') && !target.closest('[data-testid="video-thumb"]')) return;
    const el = articleRef.current;
    if (!el) return;
    // 新一次按下：清掉上一轮可能残留的「吃掉 click」（正常情况那一下已经被消耗）
    swallowClick.current = false;
    const x = e.clientX;
    const y = e.clientY;
    pressOrigin.current = { x, y, pointerId: e.pointerId, pointerType: e.pointerType };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      const origin = pressOrigin.current;
      pressOrigin.current = null;
      if (!origin) return;
      // 起拖：吃掉落点那次 click，交给父级的统一拖拽逻辑
      swallowClick.current = true;
      onBeginDrag(el, origin.pointerId, x, y);
    }, LONG_PRESS_MS);
  };

  const onCardPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const origin = pressOrigin.current;
    if (!origin || pressTimer.current == null) return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) <= LONG_PRESS_SLOP) return;
    clearPress();
    // 鼠标整卡按住拖动即可拿起；触屏移动则交还页面滚动。
    if (origin.pointerType === 'mouse' && articleRef.current) {
      swallowClick.current = true;
      onBeginDrag(articleRef.current, origin.pointerId, e.clientX, e.clientY);
      e.preventDefault();
    }
  };

  return (
    <Card.Root<'article'>
        ref={articleRef}
      className={`${CARD_CLS} ${dragging ? 'video-row--dragging opacity-40' : ''}`}
      data-testid="video-item"
      data-video-id={v.id}
      data-kind={isMaterial ? 'material' : 'video'}
      data-pinned={v.pinned === 1 ? '1' : undefined}
      aria-describedby={`library-drag-hint-${v.id}`}
      aria-labelledby={`library-title-${v.id}`}
      onPointerDown={onCardPointerDown}
      onPointerMove={(e) => {
        onCardPointerMove(e);
        onDragMove(e);
      }}
      onPointerUp={() => {
        clearPress();
        onDragEnd();
      }}
      onPointerCancel={() => {
        clearPress();
        onDragCancel();
      }}
      onPointerLeave={clearPress}
      onClickCapture={(e) => {
        if (swallowClick.current) {
          swallowClick.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onContextMenu={(e) => {
        // 长按期间抑制系统菜单（桌面右键 / 触屏长按呼出）
        if (dragging || pressTimer.current != null) e.preventDefault();
      }}
    >
      {/* 缩略图：16:9 通栏，右下角压时长徽标（YouTube 卡片的两件套）。
          点缩略图直接进播放页，与卡片式的「整张可点」一致 */}
      <button
        type="button"
        className={`${THUMB_CLS} mb-2 overflow-hidden transition-shadow hover:shadow-md`}
        data-testid="video-thumb"
        aria-label={`${isMaterial ? '阅读' : '学习'} ${v.name}${ratio == null ? '' : v.finished === 1 ? '，已看完' : `，已观看 ${Math.round(ratio * 100)}%`}`}
        onClick={onPlay}
        onDragStart={(e) => e.preventDefault()}
      >
        {cover ? (
          // 视频与 PDF 共用同一条封面链路，所以这里不再按类型分叉
          <img className="block h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transition-none" src={cover} alt="" loading="lazy" decoding="async" />
        ) : (
          // 没有画面时：先用主色铺底（LQIP），连主色都没有才落到主题色底
          <span
            className="video-row__thumb-empty flex h-full w-full items-center justify-center text-[44px] text-accent opacity-50"
            style={v.dominantColor ? { background: v.dominantColor } : undefined}
          >
            {isMaterial ? (
              v.materialFormat === 'pdf' ? <Sym name="picture_as_pdf" /> : <Sym name="description" />
            ) : (
              <Sym name="play_circle" />
            )}
          </span>
        )}
        <span className="video-row__duration absolute right-1.5 bottom-1.5 rounded-md bg-black/80 px-1.5 py-0.5 text-xs font-medium tabular-nums text-white">
          {isMaterial ? (v.unitCount ? `${v.unitCount} ${noun}` : '—') : formatDuration(v.duration)}
        </span>
        {/* 置顶徽标：压在缩略图右上角。标签行里也有一条「已置顶」，
            但缩略图是卡片最显眼的位置，一眼就能看出哪些排在了前面。 */}
        {v.pinned === 1 && (
          <span className="video-row__pin absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-accent text-accent-foreground shadow-sm" data-testid="video-pin" aria-hidden="true">
            <Sym name="pin" filled />
          </span>
        )}
        {/* 播放进度条：贴缩略图底边（YouTube 卡片同款位置）。
            与上面的时长徽标不冲突（条高 4px 贴底、徽标 bottom: 6px），
            与主区的 .video-row__job 也不冲突 —— 那是转写/建索引的**后台任务**进度，
            位置和颜色都不同，别混。 */}
        {ratio != null && (
          <span
            className="video-row__progress absolute right-0 bottom-0 left-0 h-1 bg-black/30"
            data-testid="video-progress"
            data-ratio={ratio.toFixed(3)}
            data-finished={v.finished === 1 ? '1' : undefined}
            aria-hidden="true"
          >
            <span
              className="video-row__progress-fill block h-full bg-accent"
              data-testid="video-progress-fill"
              style={{ width: `${ratio * 100}%` }}
            />
          </span>
        )}
      </button>
      <div className={MAIN_CLS}>
        <h3 className={NAME_CLS} id={`library-title-${v.id}`} title={v.name}>
          {v.name}
        </h3>
        <div className={META_CLS} title={meta}>
          {meta}
        </div>
        {activeJob && (
          <div className="video-row__job mt-1.5 flex items-center gap-1.5 text-xs text-accent" data-testid="video-job">
            {/* 与导入进度条同一套映射：算得出百分比就定量显示，算不出走不确定态。 */}
            <ProgressBar
              maxValue={100}
              aria-label={jobCopy?.detail ?? '后台任务进度'}
              value={
                // 只有「按份数推进」的任务才有确定百分比：转写（按段）与材料解析（按页/段）。
                // 其余（排队/抽取/VAD）走不确定态。
                activeJob.phase === 'asr'
                  ? Math.round((activeJob.done / Math.max(1, activeJob.total)) * 100)
                  : activeJob.phase === 'parse' && activeJob.total > 1
                    ? Math.round((activeJob.done / Math.max(1, activeJob.total)) * 100)
                    : 0
              }
              isIndeterminate={
                !(activeJob.phase === 'asr' || (activeJob.phase === 'parse' && activeJob.total > 1))
              }
            />
            <span>{jobCopy?.detail}</span>
          </div>
        )}
      </div>
      <div className={TAGS_CLS}>
        {v.pinned === 1 && <Chip size="sm" color="accent" variant="soft">已置顶</Chip>}
        {v.fileDeleted === 1 && <Chip size="sm" color="default" variant="soft">文件已删</Chip>}
        <Chip size="sm" color={status.variant === 'error' ? 'danger' : status.variant ? 'accent' : 'default'} variant="soft">
          {jobCopy ? jobCopy.tag : status.text}
        </Chip>
      </div>
      <p id={`library-drag-hint-${v.id}`} className="sr-only" data-testid="card-drag-hint">按住整张卡片拖动 · 触屏长按</p>
      <div className={ACTIONS_CLS}>
        <Button data-testid="btn-play" variant="secondary" onPress={onPlay}>
          <Sym name="play_circle" />
          {isMaterial ? '阅读' : '学习'}
        </Button>
        {isMobile ? (
          // 手机端：图标按钮 + Dropdown 菜单（菜单项用 id + onAction 分发）
          <Dropdown>
            <Dropdown.Trigger
              className={buttonVariants({ isIconOnly: true, variant: 'tertiary', size: 'sm' })}
              data-testid="btn-more"
              aria-label="更多操作"
            >
              <Sym name="more_vert" />
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label="更多操作"
                onAction={(key) => {
                  if (key === 'rename') onRename();
                  else if (key === 'move') onMove();
                  else if (key === 'pin') onTogglePin();
                  else if (key === 'reparse') onReparse?.();
                  else if (key === 'delete') onDelete();
                }}
              >
                <Dropdown.Item id="rename" textValue="重命名" data-testid="menu-rename">
                  <Sym name="edit" />
                  重命名
                </Dropdown.Item>
                <Dropdown.Item id="move" textValue="移动到文件夹" data-testid="menu-move">
                  <Sym name="folder_open" />
                  移动到文件夹
                </Dropdown.Item>
                <Dropdown.Item
                  id="pin"
                  textValue={v.pinned === 1 ? '取消置顶' : '置顶'}
                  data-testid="menu-pin"
                >
                  <Sym name={v.pinned === 1 ? 'pin_off' : 'pin'} />
                  {v.pinned === 1 ? '取消置顶' : '置顶'}
                </Dropdown.Item>
                {/* 解析失败/想换索引重来时用得上；参数化重试比隐式后台扫描可控 */}
                {isMaterial && onReparse && (
                  <Dropdown.Item id="reparse" textValue="重新解析" data-testid="menu-reparse">
                    <Sym name="refresh" />
                    重新解析
                  </Dropdown.Item>
                )}
                <Dropdown.Item
                  id="delete"
                  textValue={v.fileDeleted ? '彻底删除记录' : isMaterial ? '删除材料文件' : '删除视频文件'}
                  data-testid="menu-delete"
                >
                  <Sym name="delete" />
                  {v.fileDeleted ? '彻底删除记录' : isMaterial ? '删除材料文件' : '删除视频文件'}
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        ) : (
          <>
            <Button
              isIconOnly
              variant="tertiary"
              size="sm"
              data-testid="btn-rename"
              aria-label="重命名"
              onPress={onRename}
            >
              <Sym name="edit" />
            </Button>
            <Button
              isIconOnly
              variant="tertiary"
              size="sm"
              data-testid="btn-move"
              aria-label="移动到文件夹"
              onPress={onMove}
            >
              <Sym name="folder_open" />
            </Button>
            <Button
              isIconOnly
              variant="tertiary"
              size="sm"
              data-testid="btn-pin"
              aria-label={v.pinned === 1 ? '取消置顶' : '置顶'}
              onPress={onTogglePin}
            >
              <Sym name={v.pinned === 1 ? 'pin_off' : 'pin'} />
            </Button>
            {isMaterial && onReparse && (
              <Button
                isIconOnly
                variant="tertiary"
                size="sm"
                data-testid="btn-reparse"
                aria-label="重新解析"
                onPress={onReparse}
              >
                <Sym name="refresh" />
              </Button>
            )}
            <Button
              isIconOnly
              variant="tertiary"
              size="sm"
              data-testid="btn-delete"
              aria-label="删除"
              onPress={onDelete}
            >
              <Sym name="delete" />
            </Button>
          </>
        )}
      </div>
    </Card.Root>
  );
}
