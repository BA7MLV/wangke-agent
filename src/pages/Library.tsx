import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Alert, Button, Dropdown, Empty, Input, List, Modal, Popconfirm, Progress, Radio, Tag, Upload, Typography } from 'antd';
import {
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  HolderOutlined,
  InboxOutlined,
  LinkOutlined,
  MoreOutlined,
  PlayCircleOutlined,
  RightOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { ALL_FORMATS, BlobSource, Input as MediaInput } from 'mediabunny';
import { db, type FolderRow, type VideoRow } from '../store/db';
import { deleteVideoFile, saveVideoFile } from '../store/fileStore';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { formatSize } from '../utils/format';
import { useIsMobile } from '../utils/useMobile';
import { importBiliVideo } from '../bilibili';
import { getSettings } from '../store/settings';
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

const STATUS_TAG: Record<VideoRow['status'], { color: string; text: string }> = {
  new: { color: 'default', text: '未转写' },
  transcribing: { color: 'processing', text: '转写中' },
  transcribed: { color: 'success', text: '已转写' },
  error: { color: 'error', text: '出错' },
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
  const { message, modal } = App.useApp();
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
  const [moveTarget, setMoveTarget] = useState<number>(-1);
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
  // 哔哩哔哩导入弹窗
  const [biliOpen, setBiliOpen] = useState(false);
  const [biliUrl, setBiliUrl] = useState('');
  const [biliImporting, setBiliImporting] = useState(false);
  const [biliProgress, setBiliProgress] = useState(0);
  const [biliError, setBiliError] = useState<string | null>(null);

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
      message.success(`已导入《${file.name}》`);
      await reload();
    } catch (e) {
      const text = formatCaughtError(e);
      patchTask(key, { status: 'error', error: text });
      modal.error({
        title: `导入《${file.name}》失败`,
        width: 560,
        content: (
          <Typography.Paragraph
            copyable={{ text }}
            style={{ whiteSpace: 'pre-wrap', userSelect: 'text', maxHeight: 320, overflow: 'auto' }}
          >
            {text}
          </Typography.Paragraph>
        ),
      });
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
      message.warning('请先在「设置」页填写哔哩哔哩代理地址');
      return;
    }
    const raw = biliUrl.trim();
    if (!raw) {
      message.warning('请粘贴 B 站视频链接或 BV 号');
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
      message.success(`已解析《${file.name}》，开始写入本地存储`);
      enqueue(file);
    } catch (e) {
      const text = formatCaughtError(e);
      setBiliError(text);
      modal.error({
        title: 'B 站导入失败',
        width: 560,
        content: (
          <Typography.Paragraph
            copyable={{ text }}
            style={{ whiteSpace: 'pre-wrap', userSelect: 'text', maxHeight: 320, overflow: 'auto' }}
          >
            {text}
          </Typography.Paragraph>
        ),
      });
    } finally {
      setBiliImporting(false);
      setBiliProgress(0);
    }
  };

  /**
   * 原生文件选择器兜底入口（兼诊断）：iPad PWA 里若 antd Dragger
   * 选完没反应，用这个可以确认系统到底有没有把文件交给页面——
   * 选中后立即弹出文件数量/名称/大小/类型。
   */
  const handleNativePick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) {
      message.warning('系统没有返回任何文件，请改用 Safari 标签页打开后再试');
      return;
    }
    message.info(
      `已选择 ${files.length} 个文件：` +
        files.map((f) => `${f.name}（${formatSize(f.size)}${f.type ? `，${f.type}` : '，无类型'}）`).join('、'),
      8,
    );
    for (const f of files) {
      if (!isVideoFile(f)) {
        message.warning(`《${f.name}》不是支持的视频格式，已跳过`);
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
      message.warning('标题不能为空');
      return;
    }
    if (name !== renaming.name) {
      await db.videos.update(renaming.id, { name });
      message.success('标题已修改');
    }
    setRenaming(null);
    await reload();
  };

  /** 第一步删除：只删视频文件本体释放空间，字幕/讲义/问答等内容保留 */
  const handleDeleteFile = async (row: VideoRow) => {
    await deleteVideoFile(row.id);
    await db.videos.update(row.id, { fileDeleted: 1 });
    message.success('已删除视频文件，字幕/讲义/问答仍保留');
    await reload();
  };

  /** 第二步删除（文件已删后）：彻底删除记录及全部内容 */
  const handleDelete = async (row: VideoRow) => {
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
    message.success('已删除');
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
      message.warning('文件夹名称不能为空');
      return;
    }
    if (folderModal.mode === 'create') {
      await db.folders.add({ name, createdAt: Date.now() });
      message.success(`已创建文件夹「${name}」`);
    } else if (name !== folderModal.folder.name) {
      await db.folders.update(folderModal.folder.id!, { name });
      message.success('文件夹已重命名');
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
    message.success('文件夹已删除，视频已移回未分类');
    await reload();
  };

  const confirmDeleteFolder = (folder: FolderRow, count: number) => {
    modal.confirm({
      title: `删除文件夹「${folder.name}」？`,
      content: count > 0 ? `里面的 ${count} 个视频会移回未分类，视频本身不会被删除` : '文件夹为空，可直接删除',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => handleDeleteFolder(folder),
    });
  };

  const openMove = (v: VideoRow) => {
    setMoving(v);
    setMoveTarget(v.folderId ?? -1);
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
    await setVideoFolder(moving.id, moveTarget < 0 ? null : moveTarget);
    message.success('已移动');
    setMoving(null);
    await reload();
  };

  /** 移动弹窗内当场新建文件夹并选中 */
  const createFolderInMove = async () => {
    const name = moveNewName.trim();
    if (!name) return;
    const id = (await db.folders.add({ name, createdAt: Date.now() })) as number;
    setMoveNewName('');
    setMoveTarget(id);
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
    if (e.clientY < 80) window.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - 80) window.scrollBy(0, 12);
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
    message.success(`已移入「${name}」`);
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

  // ---------- 视频行渲染 ----------

  /** 手机端操作列：低频的改名/移动/删除收进 ⋯ 菜单；菜单项无法包 Popconfirm，删除改编程式 modal */
  const mobileActions = (v: VideoRow) => [
    <Button key="play" type="primary" icon={<PlayCircleOutlined />} onClick={() => navigate(`/player/${v.id}`)}>
      学习
    </Button>,
    <Dropdown
      key="more"
      trigger={['click']}
      menu={{
        items: [
          { key: 'rename', icon: <EditOutlined />, label: '重命名' },
          { key: 'folder', icon: <FolderOpenOutlined />, label: '移动到文件夹' },
          {
            key: 'del',
            icon: <DeleteOutlined />,
            danger: true,
            label: v.fileDeleted ? '彻底删除记录' : '删除视频文件',
          },
        ],
        onClick: ({ key }) => {
          if (key === 'rename') {
            openRename(v);
            return;
          }
          if (key === 'folder') {
            openMove(v);
            return;
          }
          modal.confirm({
            title: v.fileDeleted ? '彻底删除该记录？' : '删除视频文件？',
            content: v.fileDeleted
              ? '字幕、讲义、问答记录会一并删除，不可恢复'
              : '仅删除视频本体释放空间，字幕、讲义、问答记录保留',
            okText: v.fileDeleted ? '彻底删除' : '删除',
            okButtonProps: { danger: true },
            cancelText: '取消',
            onOk: () => (v.fileDeleted ? handleDelete(v) : handleDeleteFile(v)),
          });
        },
      }}
    >
      <Button icon={<MoreOutlined />} />
    </Dropdown>,
  ];

  const renderVideoItem = (v: VideoRow) => (
    <List.Item
      style={drag?.video.id === v.id ? { opacity: 0.4 } : undefined}
      actions={
        isMobile
          ? mobileActions(v)
          : [
              <Button
                key="play"
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={() => navigate(`/player/${v.id}`)}
              >
                学习
              </Button>,
              <Button key="rename" icon={<EditOutlined />} onClick={() => openRename(v)} />,
              <Button key="folder" icon={<FolderOpenOutlined />} onClick={() => openMove(v)} />,
              v.fileDeleted ? (
                <Popconfirm
                  key="del"
                  title="彻底删除该记录？"
                  description="字幕、讲义、问答记录会一并删除，不可恢复"
                  okText="彻底删除"
                  onConfirm={() => handleDelete(v)}
                >
                  <Button danger icon={<DeleteOutlined />} />
                </Popconfirm>
              ) : (
                <Popconfirm
                  key="del"
                  title="删除视频文件？"
                  description="仅删除视频本体释放空间，字幕、讲义、问答记录保留"
                  onConfirm={() => handleDeleteFile(v)}
                >
                  <Button danger icon={<DeleteOutlined />} />
                </Popconfirm>
              ),
            ]
      }
    >
      {/* 拖拽手柄：按住拖到组头移入文件夹。touchAction:none 让触屏从手柄起手不触发页面滚动 */}
      <Button
        type="text"
        size="small"
        icon={<HolderOutlined />}
        aria-label="拖拽移动到文件夹"
        style={{ cursor: 'grab', touchAction: 'none', color: 'var(--ant-color-text-secondary)', marginRight: 4 }}
        onPointerDown={(e) => startDrag(e, v)}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
      />
      <List.Item.Meta
        title={v.name}
        description={`${formatDuration(v.duration)} · ${formatSize(v.size)} · ${new Date(v.createdAt).toLocaleDateString()}`}
      />
      {v.fileDeleted === 1 && <Tag>文件已删</Tag>}
      <Tag color={STATUS_TAG[v.status].color}>{STATUS_TAG[v.status].text}</Tag>
    </List.Item>
  );

  /** 组头：折叠箭头 + 名称 + 数量，整行点击折叠；真实文件夹带 ⋯ 菜单（重命名/删除），未分类没有；拖拽时组头作为投放目标高亮 */
  const renderGroupHeader = (g: (typeof groups)[number]) => {
    const isCollapsed = collapsed.has(g.key);
    const isDropTarget = drag?.overKey === g.key;
    return (
      <div
        ref={(el) => {
          if (el) headerRefs.current.set(g.key, el);
          else headerRefs.current.delete(g.key);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          margin: '16px 0 4px',
          padding: '4px 8px',
          borderRadius: 8,
          cursor: 'pointer',
          userSelect: 'none',
          border: drag ? '1px dashed var(--ant-color-border)' : '1px solid transparent',
          ...(isDropTarget
            ? { borderColor: 'var(--ant-color-primary)', background: 'var(--ant-color-primary-bg, rgba(22,119,255,0.08))' }
            : undefined),
        }}
        onClick={() => toggleCollapse(g.key)}
      >
        <Button
          type="text"
          size="small"
          icon={isCollapsed ? <RightOutlined /> : <DownOutlined />}
        />
        <FolderOutlined style={{ color: 'var(--ant-color-primary)' }} />
        <span style={{ fontWeight: 600 }}>{g.name}</span>
        <span style={{ color: 'var(--ant-color-text-secondary)', fontSize: 13 }}>{g.videos.length}</span>
        {g.folder && (
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'rename', icon: <EditOutlined />, label: '重命名文件夹' },
                { key: 'del', icon: <DeleteOutlined />, danger: true, label: '删除文件夹' },
              ],
              onClick: ({ key }) => {
                if (key === 'rename') openFolderModal('rename', g.folder!);
                else confirmDeleteFolder(g.folder!, g.videos.length);
              },
            }}
          >
            <Button type="text" size="small" icon={<MoreOutlined />} onClick={(e) => e.stopPropagation()} />
          </Dropdown>
        )}
      </div>
    );
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="title">网课学习助手</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            icon={<LinkOutlined />}
            onClick={() => {
              setBiliError(null);
              setBiliOpen(true);
            }}
          >
            导入 B 站
          </Button>
          <Button icon={<FolderAddOutlined />} onClick={() => openFolderModal('create')}>
            新建文件夹
          </Button>
          <Button icon={<SettingOutlined />} onClick={() => navigate('/settings')}>
            设置
          </Button>
        </div>
      </div>
      <div className="page-body" style={{ maxWidth: 860, margin: '0 auto', width: '100%' }}>
        {SHOW_PWA_HINT && (
          <Alert
            style={{ marginBottom: 16 }}
            type="warning"
            showIcon
            message="建议用 Safari 将本页「添加到主屏幕」后使用"
            description="在普通标签页中，若连续 7 天未打开，系统可能自动清除已导入的视频和字幕；从主屏幕打开则不会被清理。"
          />
        )}
        <Upload.Dragger
          multiple
          showUploadList={false}
          beforeUpload={(file) => {
            if (!isVideoFile(file)) {
              message.warning(`《${file.name}》不是支持的视频格式，已跳过`);
              return false;
            }
            enqueue(file);
            return false;
          }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽视频到此处导入</p>
          <p className="ant-upload-hint">
            请从「文件」App 中选择视频——从相册选择系统可能先转码，大视频会长时间无进度；iCloud
            文件请先在「文件」App 中下载到本机
          </p>
          <p className="ant-upload-hint">
            视频只保存在本机浏览器存储中，不会上传到任何服务器；导入完成后可在「文件」App 中删除原视频释放空间
          </p>
        </Upload.Dragger>

        {/* iPad 兜底/诊断入口：Dragger 选完没反应时用。iOS 上隐藏 input 需可聚焦，不能用 display:none */}
        <input
          ref={nativeInputRef}
          type="file"
          multiple
          onChange={handleNativePick}
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}
        />
        <div style={{ marginTop: 8, textAlign: 'center' }}>
          <Button type="link" size="small" onClick={() => nativeInputRef.current?.click()}>
            上方选完没反应？点这里用系统选择器导入
          </Button>
        </div>

        {tasks.length > 0 && (
          <div style={{ marginTop: 16 }}>
            {tasks.map((t) => (
              <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0' }}>
                <span
                  className="import-task-name"
                  style={{
                    flex: '0 1 220px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={t.name}
                >
                  {t.name}
                </span>
                <Progress
                  style={{ flex: 1, margin: 0 }}
                  size="small"
                  percent={t.status === 'done' ? 100 : t.status === 'writing' ? t.percent : undefined}
                  status={
                    t.status === 'error' ? 'exception' : t.status === 'done' ? 'success' : 'active'
                  }
                  format={(pct) =>
                    t.status === 'error'
                      ? (t.error ?? '失败')
                      : t.status === 'writing'
                        ? `${TASK_STATUS_TEXT.writing} ${pct ?? 0}%`
                        : TASK_STATUS_TEXT[t.status]
                  }
                />
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 24 }}>
          {videos.length === 0 && folders.length === 0 ? (
            <Empty description="还没有视频，先导入一个网课视频吧" />
          ) : (
            groups
              .filter((g) => g.videos.length > 0 || g.folder != null)
              .map((g) => (
                <div key={g.key}>
                  {renderGroupHeader(g)}
                  {!collapsed.has(g.key) && <List dataSource={g.videos} renderItem={renderVideoItem} />}
                </div>
              ))
          )}
        </div>
      </div>
      {/* 拖拽悬浮卡片：跟随指针，位于指针上方避免被手指遮挡；pointerEvents:none 不影响命中检测 */}
      {drag && (
        <div
          style={{
            position: 'fixed',
            left: drag.x,
            top: drag.y - 48,
            transform: 'translateX(-50%)',
            zIndex: 1000,
            pointerEvents: 'none',
            maxWidth: 240,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            padding: '8px 12px',
            borderRadius: 8,
            background: 'var(--ant-color-bg-elevated, #fff)',
            boxShadow: 'var(--ant-box-shadow-secondary, 0 6px 16px rgba(0,0,0,0.12))',
            border: '1px solid var(--ant-color-border, #d9d9d9)',
            fontSize: 14,
          }}
        >
          <HolderOutlined style={{ marginRight: 8, color: 'var(--ant-color-text-secondary)' }} />
          {drag.video.name}
        </div>
      )}
      <Modal
        open={!!renaming}
        title="修改标题"
        okText="保存"
        cancelText="取消"
        onOk={confirmRename}
        onCancel={() => setRenaming(null)}
        destroyOnHidden
      >
        <Input
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          onPressEnter={confirmRename}
          maxLength={100}
          placeholder="输入视频标题"
          autoFocus
        />
      </Modal>
      <Modal
        open={!!folderModal}
        title={folderModal?.mode === 'rename' ? '重命名文件夹' : '新建文件夹'}
        okText="保存"
        cancelText="取消"
        onOk={confirmFolderModal}
        onCancel={() => setFolderModal(null)}
        destroyOnHidden
      >
        <Input
          value={folderText}
          onChange={(e) => setFolderText(e.target.value)}
          onPressEnter={confirmFolderModal}
          maxLength={50}
          placeholder="如：行测、申论、面试"
          autoFocus
        />
      </Modal>
      <Modal
        open={!!moving}
        title={moving ? `移动《${moving.name}》到` : ''}
        okText="移动"
        cancelText="取消"
        onOk={confirmMove}
        onCancel={() => setMoving(null)}
        destroyOnHidden
      >
        <Radio.Group
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          value={moveTarget}
          onChange={(e) => setMoveTarget(e.target.value as number)}
          options={[
            { value: -1, label: '未分类' },
            ...folders.map((f) => ({ value: f.id!, label: f.name })),
          ]}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Input
            value={moveNewName}
            onChange={(e) => setMoveNewName(e.target.value)}
            onPressEnter={createFolderInMove}
            maxLength={50}
            placeholder="新建文件夹名称"
          />
          <Button onClick={createFolderInMove} disabled={!moveNewName.trim()}>
            新建并选中
          </Button>
        </div>
      </Modal>
      <Modal
        open={biliOpen}
        title="导入哔哩哔哩视频"
        okText="开始导入"
        cancelText="取消"
        confirmLoading={biliImporting}
        onOk={handleBiliImport}
        onCancel={() => {
          if (!biliImporting) {
            setBiliOpen(false);
            setBiliUrl('');
            setBiliError(null);
          }
        }}
        destroyOnHidden
      >
        <Input.TextArea
          value={biliUrl}
          onChange={(e) => setBiliUrl(e.target.value)}
          placeholder="粘贴 B 站视频链接 / BV 号 / b23.tv 短链"
          autoSize={{ minRows: 2, maxRows: 4 }}
          disabled={biliImporting}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>
          需先在「设置」页配置自建代理地址；未登录只能导入 360P，登录 Cookie 可解锁更高清晰度。
        </div>
        {biliImporting && (
          <div style={{ marginTop: 12 }}>
            <Progress percent={biliProgress} size="small" />
          </div>
        )}
        {biliError && (
          <Alert
            type="error"
            showIcon
            message="导入失败"
            description={
              <Typography.Paragraph
                copyable={{ text: biliError }}
                style={{ whiteSpace: 'pre-wrap', userSelect: 'text', marginBottom: 0, maxHeight: 200, overflow: 'auto' }}
              >
                {biliError}
              </Typography.Paragraph>
            }
            style={{ marginTop: 12 }}
          />
        )}
      </Modal>
    </div>
  );
}
