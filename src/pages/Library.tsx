import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ALL_FORMATS, BlobSource, Input as MediaInput } from 'mediabunny';
import { Banner, EmptyState, PageShell, alertDialog, confirmDialog, toast, useMduiEvent } from '../ui';
import { useAppNav } from '../components/appNav';
import { db, type FolderRow, type VideoRow } from '../store/db';
import { deleteVideoFile, saveVideoFile } from '../store/fileStore';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { formatSize } from '../utils/format';
import { useIsMobile } from '../utils/useMobile';
import { importBiliVideo } from '../bilibili';
import { getSettings } from '../store/settings';
import { isJobActive, useJobStore, useTranscribeJob } from '../store/jobs';
import { cancelTranscription } from '../pipelines/transcribeQueue';
import { formatCaughtError } from '../utils/errorText';

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
 * crypto.randomUUID 仅在安全上下文（HTTPS / localhost）可用。
 * iPad 通过局域网 http://IP 访问时它是 undefined，直接调用会同步抛异常
 * （表现为选完文件毫无反应）。getRandomValues 在所有上下文都可用，用它降级。
 */
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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

/**
 * 用 mediabunny 解析容器头探测时长：只读文件头/尾少量字节，
 * 支持 MKV/FLV 等 Safari 原生 <video> 不认的格式；15s 超时兜底。
 */
async function probeDuration(file: Blob): Promise<number> {
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
 * 因此改用页面自己的静态标记 `.tag-mini`（与 SkillsCard 同一取舍），配色走 MD3 语义色板。
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

const TASK_STATUS_TEXT: Record<ImportTask['status'], string> = {
  queued: '等待中',
  probing: '读取文件信息…',
  writing: '写入本地存储',
  done: '完成',
  error: '失败',
};

/** 「未分类」虚拟组的 key（折叠状态持久化用） */
const UNCAT_KEY = '__uncat__';
const COLLAPSE_STORE_KEY = 'library.collapsedGroups';

function loadCollapsed(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(COLLAPSE_STORE_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export default function Library() {
  const navigate = useNavigate();
  const nav = useAppNav('home');
  const isMobile = useIsMobile();
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());
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
   * 按住视频行的拖拽手柄 → 悬浮卡片跟随 → 拖到组头上松手移入该文件夹。
   * dragRef 镜像 drag 供事件处理器同步读取（避免闭包拿到旧 state）。
   */
  const [drag, setDrag] = useState<{ video: VideoRow; x: number; y: number; overKey: string | null } | null>(null);
  const dragRef = useRef<{ video: VideoRow; x: number; y: number; overKey: string | null } | null>(null);
  const headerRefs = useRef(new Map<string, HTMLDivElement>());
  // 顺序导入链：多个文件排队逐个写入，避免并发写存储互相拖慢
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const nativeInputRef = useRef<HTMLInputElement>(null);
  // HTML5 拖放（桌面/iPad 从「文件」App 拖入）的悬停高亮
  const [dropActive, setDropActive] = useState(false);
  // 哔哩哔哩导入弹窗
  const [biliOpen, setBiliOpen] = useState(false);
  const [biliUrl, setBiliUrl] = useState('');
  const [biliImporting, setBiliImporting] = useState(false);
  const [biliProgress, setBiliProgress] = useState(0);
  const [biliError, setBiliError] = useState<string | null>(null);

  // mdui-dialog 自己处理 Esc / 点遮罩关闭时只是把 open 属性拿掉，React 的 state 不知道，
  // 必须接 closed 事件同步回 state，否则出现「关不掉 / 自己弹回来」（阶段 1 已实测）。
  const renameDlgRef = useMduiEvent('mdui-dialog', 'closed', () => setRenaming(null));
  const folderDlgRef = useMduiEvent('mdui-dialog', 'closed', () => setFolderModal(null));
  const moveDlgRef = useMduiEvent('mdui-dialog', 'closed', () => setMoving(null));
  const biliDlgRef = useMduiEvent('mdui-dialog', 'closed', () => {
    if (!biliImporting) {
      setBiliOpen(false);
      setBiliUrl('');
      setBiliError(null);
    }
  });
  const moveRadioRef = useMduiEvent('mdui-radio-group', 'change', (_e, el) => setMoveTarget(el.value));

  const reload = async () => {
    const [rows, folderRows] = await Promise.all([
      db.videos.orderBy('createdAt').reverse().toArray(),
      db.folders.orderBy('createdAt').toArray(),
    ]);
    setVideos(rows);
    setFolders(folderRows);
  };

  useEffect(() => {
    reload();
  }, []);

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
    return [
      ...folders.map((f) => ({
        key: String(f.id),
        name: f.name,
        videos: byFolder.get(f.id!) ?? [],
        folder: f as FolderRow | null,
      })),
      { key: UNCAT_KEY, name: '未分类', videos: uncat, folder: null },
    ];
  }, [videos, folders]);

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(COLLAPSE_STORE_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const patchTask = (key: string, patch: Partial<ImportTask>) => {
    setTasks((prev) => prev.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  };

  /** 报错详情：页面内提示没法承载长文本，仍旧弹窗，但保留「一键复制详情」 */
  const showError = (headline: string, text: string) => {
    void alertDialog({ headline, description: text, copyText: text });
  };

  const importOne = async (file: File, key: string) => {
    // 大视频拷入 OPFS 要数分钟，持 Wake Lock 防熄屏后 tab 被挂起中断导入
    await acquireWakeLock();
    try {
      patchTask(key, { status: 'probing' });
      const duration = await probeDuration(file);

      const id = uuid();
      patchTask(key, { status: 'writing', percent: 0 });
      await saveVideoFile(id, file, (ratio) =>
        patchTask(key, { percent: Math.round(ratio * 100) }),
      );
      await db.videos.put({
        id,
        name: file.name.replace(/\.[^.]+$/, ''),
        size: file.size,
        mimeType: file.type || 'video/mp4',
        duration,
        createdAt: Date.now(),
        status: 'new',
      });
      patchTask(key, { status: 'done', percent: 100 });
      toast.success(`已导入《${file.name}》`);
      await reload();
    } catch (e) {
      const text = formatCaughtError(e);
      patchTask(key, { status: 'error', error: text });
      showError(`导入《${file.name}》失败`, text);
    } finally {
      await releaseWakeLock();
    }
  };

  const enqueue = (file: File) => {
    const key = uuid();
    setTasks((prev) => [...prev, { key, name: file.name, status: 'queued', percent: 0 }]);
    chainRef.current = chainRef.current.then(() => importOne(file, key));
  };

  /** 哔哩哔哩导入：先经代理下载+重封装成 File，再走现有本地导入链 */
  const handleBiliImport = async () => {
    const { bilibiliProxy, bilibiliCookie } = getSettings();
    if (!bilibiliProxy) {
      toast.warning('请先在「设置」页填写哔哩哔哩代理地址');
      return;
    }
    const raw = biliUrl.trim();
    if (!raw) {
      toast.warning('请粘贴 B 站视频链接或 BV 号');
      return;
    }
    setBiliImporting(true);
    setBiliProgress(0);
    setBiliError(null);
    try {
      const file = await importBiliVideo(raw, { proxy: bilibiliProxy, cookie: bilibiliCookie }, (r) =>
        setBiliProgress(Math.round(r * 100)),
      );
      setBiliOpen(false);
      setBiliUrl('');
      toast.success(`已解析《${file.name}》，开始写入本地存储`);
      enqueue(file);
    } catch (e) {
      const text = formatCaughtError(e);
      setBiliError(text);
      showError('B 站导入失败', text);
    } finally {
      setBiliImporting(false);
      setBiliProgress(0);
    }
  };

  /**
   * 原生文件选择器入口（兼诊断）：iPad PWA 里若投放区选完没反应，
   * 用这个可以确认系统到底有没有把文件交给页面——选中后立即提示文件数量/名称/大小/类型。
   */
  const handleNativePick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) {
      toast.warning('系统没有返回任何文件，请改用 Safari 标签页打开后再试');
      return;
    }
    const accepted = files.filter(isVideoFile);
    const skipped = files.filter((f) => !isVideoFile(f));
    if (skipped.length > 0) toast.warning(`已跳过 ${skipped.length} 个非视频文件`);
    if (files.length > 1) toast.info(`已选择 ${accepted.length} 个视频，开始逐个导入`);
    for (const f of accepted) enqueue(f);
  };

  /** HTML5 拖放（桌面 / iPad 从「文件」App 拖入） */
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    for (const f of files) {
      if (!isVideoFile(f)) {
        toast.warning(`《${f.name}》不是支持的视频格式，已跳过`);
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

  /** 第一步删除：只删视频文件本体释放空间，字幕/讲义/问答等内容保留 */
  const handleDeleteFile = async (row: VideoRow) => {
    await deleteVideoFile(row.id);
    await db.videos.update(row.id, { fileDeleted: 1 });
    toast.success('已删除视频文件，字幕/讲义/问答仍保留');
    await reload();
  };

  /** 第二步删除（文件已删后）：彻底删除记录及全部内容 */
  const handleDelete = async (row: VideoRow) => {
    // 记录都没了，后台还在转它就没意义了（队列里也要摘掉，否则会给已删除的视频写段）
    cancelTranscription(row.id);
    useJobStore.getState().drop(row.id);
    await db.transaction('rw', [db.videos, db.segments, db.frames, db.handouts, db.chats, db.chatSessions, db.embeddings], async () => {
      await db.videos.delete(row.id);
      await db.segments.where('videoId').equals(row.id).delete();
      await db.frames.where('videoId').equals(row.id).delete();
      await db.handouts.where('videoId').equals(row.id).delete();
      await db.chats.where('videoId').equals(row.id).delete();
      await db.chatSessions.where('videoId').equals(row.id).delete();
      await db.embeddings.where('videoId').equals(row.id).delete();
    });
    await deleteVideoFile(row.id);
    toast.success('已删除');
    await reload();
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
      await db.folders.add({ name, createdAt: Date.now() });
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
          delete v.folderId;
        });
      await db.folders.delete(folder.id!);
    });
    toast.success('文件夹已删除，视频已移回未分类');
    await reload();
  };

  const confirmDeleteFolder = (folder: FolderRow, count: number) => {
    void confirmDialog({
      headline: `删除文件夹「${folder.name}」？`,
      description: count > 0 ? `里面的 ${count} 个视频会移回未分类，视频本身不会被删除` : '文件夹为空，可直接删除',
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

  /** 移动弹窗内当场新建文件夹并选中 */
  const createFolderInMove = async () => {
    const name = moveNewName.trim();
    if (!name) return;
    const id = (await db.folders.add({ name, createdAt: Date.now() })) as number;
    setMoveNewName('');
    setMoveTarget(String(id));
    await reload();
  };

  // ---------- 拖拽移入文件夹 ----------

  const startDrag = (e: React.PointerEvent<HTMLElement>, v: VideoRow) => {
    e.preventDefault();
    // 捕获指针：后续的 move/up 都派发到手柄元素，React 合成事件照常触发
    e.currentTarget.setPointerCapture(e.pointerId);
    const d = { video: v, x: e.clientX, y: e.clientY, overKey: null as string | null };
    dragRef.current = d;
    setDrag(d);
  };

  const moveDrag = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    // 拖动中指针捕获抑制了页面滚动，贴近视口边缘时手动滚动
    const main = document.querySelector('mdui-layout-main');
    if (e.clientY < 80) main?.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - 80) main?.scrollBy(0, 12);
    // 命中检测：指针落在哪个组头的矩形内
    let overKey: string | null = null;
    for (const [key, el] of headerRefs.current) {
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        overKey = key;
        break;
      }
    }
    const next = { ...d, x: e.clientX, y: e.clientY, overKey };
    dragRef.current = next;
    setDrag(next);
  };

  const endDrag = async () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d?.overKey) return;
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

  // 拖动期间禁止文本选中；Esc 取消拖拽
  useEffect(() => {
    if (!drag) return;
    document.body.style.userSelect = 'none';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDrag();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.userSelect = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [drag != null]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 渲染 ----------

  const renderGroupHeader = (g: (typeof groups)[number]) => {
    const isCollapsed = collapsed.has(g.key);
    const isDropTarget = drag?.overKey === g.key;
    const headerClass = [
      'group-header',
      drag ? 'group-header--dragging' : '',
      isDropTarget ? 'group-header--over' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div
        key={g.key}
        ref={(el) => {
          if (el) headerRefs.current.set(g.key, el);
          else headerRefs.current.delete(g.key);
        }}
        className={headerClass}
        data-testid="group-header"
        data-group-key={g.key}
        onClick={() => toggleCollapse(g.key)}
      >
        <span className="group-header__icon">
          {isCollapsed ? <mdui-sym-chevron-right /> : <mdui-sym-keyboard-arrow-down />}
        </span>
        <span className="group-header__icon">
          <mdui-sym-folder />
        </span>
        <span className="group-header__name">{g.name}</span>
        <span className="group-header__count">{g.videos.length}</span>
        <span className="library-toolbar__spacer" />
        {g.folder && (
          <mdui-dropdown>
            <mdui-button-icon
              slot="trigger"
              data-testid="btn-folder-more"
              aria-label="文件夹操作"
              onClick={(e) => e.stopPropagation()}
            >
              <mdui-sym-more-vert />
            </mdui-button-icon>
            <mdui-menu>
              <mdui-menu-item
                data-testid="menu-folder-rename"
                onClick={() => openFolderModal('rename', g.folder!)}
              >
                <mdui-sym-edit slot="icon" />
                重命名文件夹
              </mdui-menu-item>
              <mdui-menu-item
                data-testid="menu-folder-delete"
                onClick={() => confirmDeleteFolder(g.folder!, g.videos.length)}
              >
                <mdui-sym-delete slot="icon" />
                删除文件夹
              </mdui-menu-item>
            </mdui-menu>
          </mdui-dropdown>
        )}
      </div>
    );
  };

  const renderVideoItem = (v: VideoRow) => (
    <VideoRow
      key={v.id}
      video={v}
      isMobile={isMobile}
      dragging={drag?.video.id === v.id}
      onPlay={() => navigate(`/player/${v.id}`)}
      onRename={() => openRename(v)}
      onMove={() => openMove(v)}
      onDelete={() => askDeleteVideo(v)}
      onDragStart={(e) => startDrag(e, v)}
      onDragMove={moveDrag}
      onDragEnd={() => void endDrag()}
      onDragCancel={cancelDrag}
    />
  );

  return (
    <PageShell
      title="课程库"
      wide
      rail={nav.rail}
      bottomNav={nav.bottom}
    >
      {SHOW_PWA_HINT && (
        <Banner
          variant="warning"
          testId="pwa-hint"
          icon={<mdui-sym-warning />}
          title="建议用 Safari 将本页「添加到主屏幕」后使用"
          description="在普通标签页中，若连续 7 天未打开，系统可能自动清除已导入的视频和字幕；从主屏幕打开则不会被清理。"
        />
      )}

      {/* 导入投放区：替 antd Upload.Dragger（mdui 没有上传组件，自己搭）。
          整块是可投放目标，点击任意空白处打开系统文件选择器。 */}
      <div
        className={dropActive ? 'drop-zone drop-zone--over' : 'drop-zone'}
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
        <mdui-sym-cloud-upload className="drop-zone__icon" />
        <div className="drop-zone__title">点击或拖拽视频到此处导入</div>
        <div className="drop-zone__hint">
          请从「文件」App 中选择视频——从相册选择系统可能先转码，大视频会长时间无进度；iCloud
          文件请先在「文件」App 中下载到本机
        </div>
        <div className="drop-zone__hint">
          视频只保存在本机浏览器存储中，不会上传到任何服务器；导入完成后可在「文件」App
          中删除原视频释放空间
        </div>
        <div className="drop-zone__actions">
          <mdui-button
            data-testid="btn-bili-import"
            variant="tonal"
            onClick={(e) => {
              e.stopPropagation();
              setBiliError(null);
              setBiliOpen(true);
            }}
          >
            <mdui-sym-link slot="icon" />
            从 B 站导入
          </mdui-button>
          <mdui-button
            data-testid="btn-native-pick"
            variant="text"
            onClick={(e) => {
              e.stopPropagation();
              nativeInputRef.current?.click();
            }}
          >
            <mdui-sym-upload slot="icon" />
            上方没反应？用系统选择器导入
          </mdui-button>
        </div>
        {/* iOS 上隐藏 input 需可聚焦，不能用 display:none */}
        <input
          ref={nativeInputRef}
          data-testid="import-input"
          type="file"
          multiple
          onChange={handleNativePick}
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}
        />
      </div>

      {tasks.length > 0 && (
        <div data-testid="import-tasks">
          {tasks.map((t) => (
            <div key={t.key} className="import-task" data-testid="import-task">
              <span className="import-task-name" title={t.name}>
                {t.name}
              </span>
              {/* value 省略 = 不确定态（mdui 的 linear-progress 在 value 未定义时走 indeterminate），
                  正好对应 antd Progress 的 status="active" */}
              <mdui-linear-progress
                data-testid="import-progress"
                max={100}
                value={
                  t.status === 'done' ? 100 : t.status === 'writing' ? t.percent : undefined
                }
              />
              <span
                className={
                  t.status === 'error'
                    ? 'import-task__status import-task__status--error'
                    : 'import-task__status'
                }
                data-testid="import-task-status"
              >
                {t.status === 'error'
                  ? (t.error ?? '失败')
                  : t.status === 'writing'
                    ? `${TASK_STATUS_TEXT.writing} ${t.percent}%`
                    : TASK_STATUS_TEXT[t.status]}
              </span>
            </div>
          ))}
        </div>
      )}

      {(videos.length > 0 || folders.length > 0) && (
        <div className="library-toolbar">
          <span className="library-toolbar__spacer" />
          <mdui-button data-testid="btn-new-folder" variant="text" onClick={() => openFolderModal('create')}>
            <mdui-sym-create-new-folder slot="icon" />
            新建文件夹
          </mdui-button>
        </div>
      )}

      <div data-testid="video-list">
        {videos.length === 0 && folders.length === 0 ? (
          <EmptyState
            testId="empty-state"
            title="还没有视频"
            description="点上方投放区选择本机视频，或从 B 站链接导入。视频只保存在这台设备上，不会上传。"
          />
        ) : (
          groups
            .filter((g) => g.videos.length > 0 || g.folder != null)
            .map((g) => (
              <div key={g.key}>
                {renderGroupHeader(g)}
                {!collapsed.has(g.key) && g.videos.map(renderVideoItem)}
              </div>
            ))
        )}
      </div>

      {/* 拖拽悬浮卡片：跟随指针，位于指针上方避免被手指遮挡；pointerEvents:none 不影响命中检测 */}
      {drag && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y - 48 }}>
          <mdui-sym-drag-indicator className="drag-ghost__icon" />
          <span className="drag-ghost__name">{drag.video.name}</span>
        </div>
      )}

      {/* ── 弹窗 ─────────────────────────────────────────────────────────── */}
      <mdui-dialog
        ref={renameDlgRef}
        open={!!renaming}
        headline="修改标题"
        data-testid="rename-dialog"
        close-on-esc
        close-on-overlay-click
      >
        <mdui-text-field
          data-testid="rename-input"
          value={renameText}
          maxlength={100}
          placeholder="输入视频标题"
          autofocus
          onInput={(e) => setRenameText((e.target as HTMLElement & { value: string }).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void confirmRename();
          }}
        />
        <mdui-button slot="action" variant="text" data-testid="rename-cancel" onClick={() => setRenaming(null)}>
          取消
        </mdui-button>
        <mdui-button slot="action" variant="filled" data-testid="rename-save" onClick={() => void confirmRename()}>
          保存
        </mdui-button>
      </mdui-dialog>

      <mdui-dialog
        ref={folderDlgRef}
        open={!!folderModal}
        headline={folderModal?.mode === 'rename' ? '重命名文件夹' : '新建文件夹'}
        data-testid="folder-dialog"
        close-on-esc
        close-on-overlay-click
      >
        <mdui-text-field
          data-testid="folder-input"
          value={folderText}
          maxlength={50}
          placeholder="如：行测、申论、面试"
          autofocus
          onInput={(e) => setFolderText((e.target as HTMLElement & { value: string }).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void confirmFolderModal();
          }}
        />
        <mdui-button slot="action" variant="text" data-testid="folder-cancel" onClick={() => setFolderModal(null)}>
          取消
        </mdui-button>
        <mdui-button
          slot="action"
          variant="filled"
          data-testid="folder-save"
          onClick={() => void confirmFolderModal()}
        >
          保存
        </mdui-button>
      </mdui-dialog>

      <mdui-dialog
        ref={moveDlgRef}
        open={!!moving}
        headline={moving ? `移动《${moving.name}》到` : ''}
        data-testid="move-dialog"
        close-on-esc
        close-on-overlay-click
      >
        <mdui-radio-group ref={moveRadioRef} value={moveTarget} data-testid="move-radio-group">
          <mdui-radio value="-1">未分类</mdui-radio>
          {folders.map((f) => (
            <mdui-radio key={f.id} value={String(f.id)}>
              {f.name}
            </mdui-radio>
          ))}
        </mdui-radio-group>
        <div className="row row--nowrap" style={{ marginTop: 16 }}>
          <mdui-text-field
            data-testid="move-new-name"
            value={moveNewName}
            maxlength={50}
            placeholder="新建文件夹名称"
            onInput={(e) => setMoveNewName((e.target as HTMLElement & { value: string }).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createFolderInMove();
            }}
          />
          <mdui-button
            data-testid="move-create-folder"
            variant="tonal"
            disabled={!moveNewName.trim()}
            onClick={() => void createFolderInMove()}
          >
            新建并选中
          </mdui-button>
        </div>
        <mdui-button slot="action" variant="text" data-testid="move-cancel" onClick={() => setMoving(null)}>
          取消
        </mdui-button>
        <mdui-button slot="action" variant="filled" data-testid="move-confirm" onClick={() => void confirmMove()}>
          移动
        </mdui-button>
      </mdui-dialog>

      <mdui-dialog
        ref={biliDlgRef}
        open={biliOpen}
        headline="导入哔哩哔哩视频"
        data-testid="bili-dialog"
        close-on-esc={!biliImporting}
        close-on-overlay-click={!biliImporting}
      >
        <mdui-text-field
          data-testid="bili-url"
          value={biliUrl}
          rows={2}
          autosize
          max-rows={4}
          placeholder="粘贴 B 站视频链接 / BV 号 / b23.tv 短链"
          disabled={biliImporting}
          onInput={(e) => setBiliUrl((e.target as HTMLElement & { value: string }).value)}
        />
        <div className="text-secondary" style={{ marginTop: 8, fontSize: 12 }}>
          需先在「设置」页配置自建代理地址；未登录只能导入 360P，登录 Cookie 可解锁更高清晰度。
        </div>
        {biliImporting && (
          <div style={{ marginTop: 12 }}>
            <mdui-linear-progress data-testid="bili-progress" max={100} value={biliProgress} />
          </div>
        )}
        {biliError && (
          <Banner
            variant="error"
            testId="bili-error"
            icon={<mdui-sym-error />}
            title="导入失败"
            description="详情见上方的错误弹窗，可一键复制"
          />
        )}
        <mdui-button slot="action" variant="text" data-testid="bili-cancel" onClick={() => setBiliOpen(false)}>
          取消
        </mdui-button>
        <mdui-button
          slot="action"
          variant="filled"
          data-testid="bili-confirm"
          loading={biliImporting}
          onClick={() => void handleBiliImport()}
        >
          开始导入
        </mdui-button>
      </mdui-dialog>
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
function VideoRow({
  video: v,
  isMobile,
  dragging,
  onPlay,
  onRename,
  onMove,
  onDelete,
  onDragStart,
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
  onDelete: () => void;
  onDragStart: (e: React.PointerEvent<HTMLElement>) => void;
  onDragMove: (e: React.PointerEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragCancel: () => void;
}) {
  const status = STATUS_TAG[v.status];
  const meta = `${formatDuration(v.duration)} · ${formatSize(v.size)} · ${new Date(v.createdAt).toLocaleDateString()}`;
  // 转写是全局队列里的后台任务：在播放页、在别处、刷新后续跑的，列表上都要看得到
  const job = useTranscribeJob(v.id);
  const activeJob = isJobActive(job) ? job : undefined;
  const jobText = !activeJob
    ? ''
    : activeJob.phase === 'asr'
      ? `转写中 ${activeJob.done}/${activeJob.total}`
      : activeJob.phase === 'queued'
        ? '转写排队中'
        : activeJob.message || '转写中';
  return (
    <div
      className={dragging ? 'video-row video-row--dragging' : 'video-row'}
      data-testid="video-item"
      data-video-id={v.id}
    >
      <div
        className="video-row__handle"
        role="button"
        tabIndex={0}
        aria-label="拖拽移动到文件夹"
        data-testid="drag-handle"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragCancel}
      >
        <mdui-sym-drag-indicator />
      </div>
      <div className="video-row__main">
        <div className="video-row__name" title={v.name}>
          {v.name}
        </div>
        <div className="video-row__meta" title={meta}>
          {meta}
        </div>
        {activeJob && (
          <div className="video-row__job" data-testid="video-job">
            <mdui-linear-progress
              max={100}
              value={
                activeJob.phase === 'asr'
                  ? Math.round((activeJob.done / Math.max(1, activeJob.total)) * 100)
                  : undefined
              }
            />
            <span>{jobText}</span>
          </div>
        )}
      </div>
      <div className="video-row__tags">
        {v.fileDeleted === 1 && <span className="tag-mini">文件已删</span>}
        <span className={status.variant ? `tag-mini tag-mini--${status.variant}` : 'tag-mini'}>
          {activeJob ? jobText : status.text}
        </span>
      </div>
      <div className="video-row__actions">
        <mdui-button data-testid="btn-play" variant="filled" onClick={onPlay}>
          <mdui-sym-play-circle slot="icon" />
          学习
        </mdui-button>
        {isMobile ? (
          <mdui-dropdown>
            <mdui-button-icon slot="trigger" data-testid="btn-more" aria-label="更多操作">
              <mdui-sym-more-vert />
            </mdui-button-icon>
            <mdui-menu>
              <mdui-menu-item data-testid="menu-rename" onClick={onRename}>
                <mdui-sym-edit slot="icon" />
                重命名
              </mdui-menu-item>
              <mdui-menu-item data-testid="menu-move" onClick={onMove}>
                <mdui-sym-folder-open slot="icon" />
                移动到文件夹
              </mdui-menu-item>
              <mdui-menu-item data-testid="menu-delete" onClick={onDelete}>
                <mdui-sym-delete slot="icon" />
                {v.fileDeleted ? '彻底删除记录' : '删除视频文件'}
              </mdui-menu-item>
            </mdui-menu>
          </mdui-dropdown>
        ) : (
          <>
            <mdui-button-icon data-testid="btn-rename" aria-label="重命名" onClick={onRename}>
              <mdui-sym-edit />
            </mdui-button-icon>
            <mdui-button-icon data-testid="btn-move" aria-label="移动到文件夹" onClick={onMove}>
              <mdui-sym-folder-open />
            </mdui-button-icon>
            <mdui-button-icon data-testid="btn-delete" aria-label="删除" onClick={onDelete}>
              <mdui-sym-delete />
            </mdui-button-icon>
          </>
        )}
      </div>
    </div>
  );
}
