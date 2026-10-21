import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MediaPlayer, MediaProvider, Track, type MediaPlayerInstance, type MediaStorage } from '@vidstack/react';
import { DefaultVideoLayout, defaultLayoutIcons } from '@vidstack/react/player/layouts/default';
import '@vidstack/react/player/styles/default/theme.css';
import '@vidstack/react/player/styles/default/layouts/video.css';
import '../player-enhance.css';
import { db, type VideoRow } from '../store/db';
import { getVideoFile } from '../store/fileStore';
import { useSettings } from '../store/settings';
import { setStudyMediaPlaying } from '../store/studyTime';
import { useSelectionAsk } from '../store/selectionAsk';
import type { Cue } from '../utils/vtt';
import { PageShell, EmptyState, Sym, useDynamicColor, toast } from '../ui';
import { useAppNav } from '../components/appNav';
import { SettingsButton } from '../components/SettingsModal';
import { useSettingsDialog } from '../components/settingsDialogStore';
import type { MaterialReaderHandle } from '../materials/types';
import SubtitlePanel from '../components/SubtitlePanel';
import ChatPanel from '../components/ChatPanel';
import DanmakuPanel from '../components/DanmakuPanel';
import CardsPanel from '../components/CardsPanel';
import CommentsSection from '../components/CommentsSection';
import MaterialReader from '../components/MaterialReader';
import SelectionAsk from '../components/SelectionAsk';
import RateButtons from '../components/RateButtons';
import CaptionSizeButton from '../components/CaptionSizeButton';
import DanmakuToggleButton from '../components/DanmakuToggleButton';
import SeekFeedback from '../components/SeekFeedback';
import DanmakuLayer from '../components/DanmakuLayer';
import PlayerBigPlayButton from '../components/PlayerBigPlayButton';
import TimeSliderWithPreview from '../components/TimeSliderWithPreview';
import TheaterModeButton from '../components/TheaterModeButton';
import { createYoutubeKeyShortcuts } from '../utils/playerKeys';
import StudyAssistant, { STUDY_PANEL_KEYS, type StudyPanelKey } from '../components/StudyAssistant';

/** 常驻字幕轨的固定 id：vidstack 的 NativeTextRenderer 会把轨的 id 写到它创建的原生 <track> 上，
 *  而 MediaProvider 的 Tracks 观察器会把「没登记的 <track> 元素」当成新轨补进列表（id 为空时用
 *  `vds-vtt-subtitles-<src>` 生成）。给轨一个显式 id 后，观察器按 id 去重，既不会累积幽灵轨，
 *  也能用 getById 稳定拿到我们这条轨。 */
const SUBS_TRACK_ID = 'live-subs';

/** 把被替换掉的旧 cue 挪到这个时间点：远超任何媒体时长，等于永久失效（不能删，见 syncTrack 注释） */
const CUE_DISABLED_TIME = 1e9;

/** 控制栏的「无操作自动隐藏」延迟。这里刻意设成 24 小时，等于关掉 vidstack 的静止自动隐藏：
 *  显隐完全由鼠标悬停决定（hiding 仍发生在 mouseleave，那一路的 delay 是 0，不受此值影响），
 *  这样 vds 内部状态（data-visible / 焦点 / 菜单）与 CSS 的 hover 视觉始终一致
 *  —— 否则悬停静止 2s 后状态翻成不可见，`.vds-controls[data-visible]` 的底部渐变背景会掉。
 *  注意不能写 Infinity 或超过 2^31-1 的值：setTimeout 会溢出成 ~1ms 立即触发。 */
const CONTROLS_IDLE_DELAY = 24 * 60 * 60 * 1000;

/** 把任意 MIME 映射到 vidstack 支持的联合类型，未知则按 mp4 处理 */
function toPlayerMime(mime: string): 'video/mp4' | 'video/webm' | 'video/ogg' | 'audio/mpeg' | 'audio/ogg' {
  const known = ['video/mp4', 'video/webm', 'video/ogg', 'audio/mpeg', 'audio/ogg'] as const;
  return (known as readonly string[]).includes(mime) ? (mime as (typeof known)[number]) : 'video/mp4';
}

type PanelKey = StudyPanelKey;
const PANEL_KEYS = STUDY_PANEL_KEYS;

/**
 * 阅读材料只保留「问答」面板。
 *
 * 其余三个面板都以字幕为输入（字幕轨/弹幕/制卡），材料没有字幕 ——
 * 留着它们只会显示「请先生成字幕」，而那个按钮点下去会对着 PDF 起一次转写，
 * 属于**看起来能用、实际是错的**入口，必须挡掉。
 */
const MATERIAL_PANEL_KEYS: readonly PanelKey[] = ['chat'];

export default function Player() {
  const { id } = useParams<{ id: string }>();
  return <PlayerResource key={id} id={id} />;
}

function PlayerResource({ id }: { id: string | undefined }) {
  const navigate = useNavigate();
  // 播放页是资料库的下级页面：宽屏 rail 里高亮资料入口。
  const nav = useAppNav('home');
  const [video, setVideo] = useState<VideoRow | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
  // 记录存在但视频文件本体已删：进入无文件模式，字幕/讲义/问答仍可用
  const [fileMissing, setFileMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [segments, setSegments] = useState<Cue[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const playerRef = useRef<MediaPlayerInstance>(null);
  const captionScale = useSettings((s) => s.captionScale);
  const shortcuts = useSettings((s) => s.shortcuts);
  const { open: settingsOpen } = useSettingsDialog();
  const dynamicColor = useSettings((s) => s.dynamicColor);
  /** 当前面板。宽屏与窄屏共用同一套 Tabs，横竖屏不再分叉。 */
  const [activeTab, setActiveTab] = useState<PanelKey>('subs');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [keyboardControls, setKeyboardControls] = useState(false);
  // 桌面影院模式：只改变页面布局，学习助手继续挂载以保留草稿、滚动位置与生成状态。
  const [theaterMode, setTheaterMode] = useState(false);
  const toggleTheaterMode = useCallback(() => setTheaterMode((active) => !active), []);
  /**
   * 评论区展开状态。窄屏和影院模式仍需在 `.video-pane` 上标记展开态，以便在有限高度里
   * 给评论让位；桌面普通模式改为整条左栏滚动，不再压缩播放器。
   */
  const [commentsOpen, setCommentsOpen] = useState(true);
  // 阅读器命令式句柄：问答里的「[第3页]」引用点一下就靠它跳过去
  const readerRef = useRef<MaterialReaderHandle | null>(null);
  // 选区提问投递：浮层点完必须让用户看到问答面板（窄屏下面板可能是隐藏的）
  const pendingAsk = useSelectionAsk((s) => s.pending);
  useEffect(() => {
    if (pendingAsk) {
      setActiveTab('chat');
      setAssistantOpen(true);
    }
  }, [pendingAsk]);

  /**
   * 离开播放页 / 换视频时清掉「正在播放」标记。
   *
   * 学习时长追踪靠这个标记来豁免空闲判定（看课不必一直动键鼠）。
   * 不清的后果很具体：从播放页返回课程库后，标记还是 true —— 人去吃饭了，
   * 库页照样一直记时长。清理放在 `id` 的依赖上，换视频时同样会先清一次。
   */
  useEffect(() => () => setStudyMediaPlaying(false), [id]);

  /**
   * Material You 动态取色：以「课程封面」为色彩来源。
   *
   * ⚠️ 这里取的是 `db.frames` 里的幻灯片帧（`frames.kind === 'slide'`，通常是课件首页），
   * 没有幻灯片帧就退而用最早的一帧；一帧都没有就保持默认配色。
   *
   * 这是**旧路径**：v10 起封面已经是入库即生成的独立资源（`pipelines/cover.ts`，
   * `covers` 表对所有视频都有），换成它会让动态取色对所有视频生效，而且配色会和
   * 资料库卡片缩略图一致。之所以还没换：`scripts/e2e-material-you.mjs` 是按
   * 「种一帧 frames」来验这条链路的，改行为要同步改那个脚本的播种方式，
   * 属于独立一笔改动 —— 别只改这一处，会静默打掉那条 e2e。
   *
   * 这里只负责「取帧 → 建 blob URL → 用完回收」，真正的取色与上色在 useDynamicColor 里
   * （那一层刻意不依赖数据层，才能留在通用的 ui/ 适配层）。
   */
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id || !dynamicColor) {
      setCoverUrl(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      const frames = await db.frames.where('videoId').equals(id).toArray();
      if (frames.length === 0) return;
      // 幻灯片帧优先；同类里取时间最早的那一帧
      frames.sort(
        (a, b) => Number(b.kind === 'slide') - Number(a.kind === 'slide') || a.ts - b.ts,
      );
      if (cancelled) return;
      objectUrl = URL.createObjectURL(frames[0].blob);
      setCoverUrl(objectUrl);
    })().catch(() => {
      /* 取不到封面就用默认配色，不影响播放 */
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setCoverUrl(null);
    };
  }, [id, dynamicColor]);

  // 配色挂在整页根节点上（Player 的根元素），离开播放页自动失效
  const colorSchemeRef = useDynamicColor({ sourceUrl: coverUrl, enabled: dynamicColor });

  /**
   * 断点续播 + 主页进度条：Vidstack 原生 MediaStorage 机制——打开时 getTime 恢复进度，
   * 播放中 setTime 落盘（含暂停/页面隐藏）。
   *
   * 「位置」与「看没看完」分开存：`lastPosition` 永远写**真实位置**（播完停在结尾），
   * 「播完后再打开要从头开始」由 `finished` 标记 + 这里的 getTime 翻译。
   * 这样主页凭 `lastPosition / duration` 就能直接画出满条，不需要特判。
   * 详见 docs/plans/2026-09-18-home-progress-bar-design.md §3.2。
   */
  const resumeStorage = useMemo<MediaStorage>(
    () => ({
      async getTime() {
        if (!id) return null;
        const row = await db.videos.get(id);
        if (!row) return null;
        if (row.finished === 1) {
          // 上一轮看完了：本次打开即新一轮观看，清掉标记并把位置归零。
          //
          // 必须真写库，而不是「读到 finished 就返回 0」糊弄过去：播完 → 打开 →
          // 拖到 90% 看一段 → 退出，读时糊弄的版本会让标记一直留着，
          // 下次又从头开始，刚看的那段进度白丢。
          //
          // 读进度失败不该拦住播放，所以吞掉异常、照样返回 0（从头上放）。
          try {
            await db.videos.update(id, { finished: 0, lastPosition: 0 });
          } catch {
            /* 落库失败只影响主页那根条，不影响本次从头播放 */
          }
          return 0;
        }
        return row.lastPosition ?? null;
      },
      async setTime(time, ended) {
        // 时长没探到等情况下 vidstack 会传 NaN，别把垃圾写进库
        if (!id || !Number.isFinite(time)) return;
        // 播完时 vidstack 传的是 duration（其 #onEnded 里 `setTime(duration(), true)`），
        // 正好就是「看到哪儿了」的真实位置，直接落盘
        await db.videos.update(
          id,
          ended ? { lastPosition: time, finished: 1 } : { lastPosition: time },
        );
      },
      // 其余 getter 返回 null（无保存值），音量/字幕/倍率等行为与之前一致
      async getVolume() { return null; },
      async getMuted() { return null; },
      async getLang() { return null; },
      async getCaptions() { return null; },
      async getPlaybackRate() { return null; },
      async getVideoQuality() { return null; },
      async getAudioGain() { return null; },
    }),
    [id],
  );

  useEffect(() => {
    let url = '';
    (async () => {
      if (!id) return;
      const row = await db.videos.get(id);
      if (!row) {
        toast.error('视频不存在');
        navigate('/library');
        return;
      }
      const blob = await getVideoFile(id);
      if (blob) {
        url = URL.createObjectURL(blob);
        setVideoUrl(url);
      } else {
        setFileMissing(true);
      }
      setVideo(row);
      setLoading(false);
    })();
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);

  // 订阅播放进度
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !videoUrl) return;
    let last = 0;
    return player.subscribe(({ currentTime: t }) => {
      if (Math.abs(t - last) >= 0.25) {
        last = t;
        setCurrentTime(t);
      }
    });
  }, [videoUrl]);

  // 增量字幕：一条常驻字幕轨 + 每完成一段就往轨里 addCue（不重建轨、不重拉整份 VTT）。
  // 详见 docs/plans/2026-09-10-live-subtitle-design.md「实测结论」。
  const [subsRunning, setSubsRunning] = useState(false);
  /**
   * 字幕是否已经读过一次（由 SubtitlePanel 通知）。
   *
   * ⚠️ 在它为 true 之前，`hasSubtitles` 必须是 `null`（未知）而不是 `false`（没有）：
   * `segments` 来自 SubtitlePanel 的首个 liveQuery 回调，首帧必然是空的 ——
   * 当成 false 会让兄弟面板先闪一下「请先生成字幕」（不变量 I10）。
   */
  const [subsLoaded, setSubsLoaded] = useState(false);
  const [trackReady, setTrackReady] = useState(false);

  // 换视频：字幕状态回到「未知」，等 SubtitlePanel 重新读一遍
  useEffect(() => {
    setSubsLoaded(false);
  }, [id]);

  // 有第一段完成字幕后才挂轨（与旧行为一致：没字幕时不在字幕菜单里留空条目），挂上后不再撤
  useEffect(() => {
    if (segments.length > 0 && !trackReady) setTrackReady(true);
  }, [segments.length, trackReady]);

  const onSegmentsChange = useCallback((segs: Cue[]) => setSegments(segs), []);
  const onSubsLoadedChange = useCallback((isLoaded: boolean) => setSubsLoaded(isLoaded), []);

  const segmentsRef = useRef<Cue[]>([]);
  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  // 我们灌进去的 cue（id → cue 对象），用于把已被替换掉的旧 cue 推出时间轴
  const cueStoreRef = useRef(new Map<string, VTTCue>());

  // cue 的 id 由内容算出（见 SubtitlePanel），所以：内容没变 → 同 id → addCue 幂等；重新转写后
  // 内容变了 → 新 id → 作为新 cue 加入，旧的被推失效。整条轨全程不重建。
  const syncTrack = useCallback((list: Cue[]) => {
    const textTracks = playerRef.current?.textTracks;
    const track = textTracks?.getById(SUBS_TRACK_ID) ?? textTracks?.toArray().find((t) => t.kind === 'subtitles');
    if (!track) return;

    const store = cueStoreRef.current;
    const keep = new Set<string>();
    for (const c of list) {
      if (!c.id) continue;
      keep.add(c.id);
      if (store.has(c.id)) continue; // 已灌过，跳过（liveQuery 会反复全量触发）
      const cue = new VTTCue(c.start, c.end, c.text);
      cue.id = c.id;
      // Chrome 没实现 VTTCue.positionAlign（规范里有，实测返回 undefined）。vidstack 的自绘字幕
      // 渲染器（media-captions）正是拿它 + position 算字幕框宽度：undefined 会落到「maxSize =
      // position = 50」，于是 --cue-width 变成 50%、--cue-left 仍是 0% —— 字幕框只占视频左半边，
      // 文字看着偏左（不居中）。这个属性是 media-captions 自己那套 VTTCue 的类字段默认值，走
      // <Track src=vtt> 时解析出来的 cue 天然带着它，改成 addCue 原生 cue 后就丢了，这里补回。
      cue.positionAlign = 'auto';
      try {
        track.addCue(cue as unknown as Parameters<typeof track.addCue>[0]);
        store.set(c.id, cue);
      } catch {
        // 单条 cue 异常（时间非法等）不影响其余
      }
    }

    // 已不在计划里的旧 cue：不能调 removeCue —— vidstack 的 removeCue 会无条件向原生 <track>
    // 转发（addCue 有 instanceof 守卫、removeCue 没有），而那个原生轨处于未加载态会抛
    // NotFoundError，并且跳过后面的 activeCues 刷新，画面反而留过期字幕。
    // 改成把它挪到不可达的时间点：既不再参与 activeCues，渲染器也会随之移除已画出的节点。
    for (const [cid, cue] of store) {
      if (keep.has(cid)) continue;
      cue.startTime = CUE_DISABLED_TIME;
      cue.endTime = CUE_DISABLED_TIME;
      store.delete(cid);
    }

    // vidstack 的默认轨自动选择依赖 TextTrackList 的 #defaults，而它的 key 用了归一化后的
    // 'captions'、remove 却按 track.kind（'subtitles'）查，导致默认轨引用永不清理 —— 首次挂载
    // 之外都不一定会自动选中，这里显式置位（已在 showing 时是空操作）。
    if (track.mode !== 'showing') track.mode = 'showing';
  }, []);

  useEffect(() => {
    if (!trackReady) return;
    syncTrack(segments);
  }, [trackReady, segments, syncTrack]);

  // 轨挂载/被重建时补同步（与上面的直接调用互为兜底，不依赖 React effect 的先后顺序）
  useEffect(() => {
    if (!trackReady) return;
    const list = playerRef.current?.textTracks;
    if (!list) return;
    const onAdd = () => syncTrack(segmentsRef.current);
    list.addEventListener('add', onAdd);
    return () => list.removeEventListener('add', onAdd);
  }, [trackReady, syncTrack]);

  // 弹幕/卡片要等本轮转写结束再解锁，避免拿半份字幕去生成
  const hasSubtitles = subsLoaded ? segments.length > 0 && !subsRunning : null;

  // 默认 YouTube 式映射，设置改变时重建；其余渲染保留连按累加游标。
  const keyShortcuts = useMemo(() => createYoutubeKeyShortcuts(shortcuts), [shortcuts]);

  /**
   * 布局槽位。
   *
   * 两点讲究：
   * 1. 对象引用要尽量稳定 —— 每次渲染都传新字面量会让 Vidstack 重建 slot 内容并重置控制栏
   *    idle 状态（手机断点切换触发重渲染时，控制栏会意外自动隐藏）。依赖只有 `videoUrl`
   *    （进播放器时已就位，之后不再变）。
   * 2. `googleCastButton: null` 是**替换**默认按钮而不是禁用：vidstack 的 `slot()` 用
   *    `isUndefined(slot) ? 默认值 : slot` 判断，传 null 正好把默认投屏按钮摘掉。
   *    本项目没接 Google Cast 框架，那颗按钮点了没有任何反应，留着只是视觉噪音。
   */
  const layoutSlots = useMemo(
    () => ({
      topControlsGroupStart: <RateButtons />,
      topControlsGroupEnd: (
        <>
          <DanmakuToggleButton />
          <CaptionSizeButton />
        </>
      ),
      // 进度条换成带缩略图预览的版本（YouTube 的 hover 预览）
      timeSlider: <TimeSliderWithPreview previewSrc={videoUrl} />,
      // 放在默认全屏按钮左边：影院模式是页内扩展，全屏仍保留为更强的一档。
      beforeFullscreenButton: (
        <TheaterModeButton active={theaterMode} onToggle={toggleTheaterMode} />
      ),
      googleCastButton: null,
    }),
    [theaterMode, toggleTheaterMode, videoUrl],
  );

  if (loading) {
    // 首载形状与真实布局**同形**：左视频区（16:9）+ 右侧面板栏（复用 .side-pane 的卡片）。
    // 挂在 PageShell 上而不是一条裸 div：顶栏 / 侧栏 / 返回键立刻在位，不必等数据。
    return (
      <PageShell
        title=""
        onBack={() => navigate('/library')}
        fill
        rootRef={colorSchemeRef}
        rootClassName="page-player"
        rail={nav}
        railFooter={<SettingsButton variant="rail" testId="nav-rail-settings" />}
        /* 顶栏右上角那颗设置图标撤掉（与 AI 助手页 / 课程库 / 学习页同一口径）：
           设置入口统一收在侧栏底部的 `railFooter`（窄屏在抽屉里）——
           同一个入口在一条顶栏里露两次没有必要。 */
      >
        <div
          className="player-layout player-layout--assistant player-layout--loading"
          data-testid="player-skeleton"
          aria-busy="true"
        >
          <div className="video-pane">
            <div className="player-skel__stage skel-breathe" />
          </div>
        </div>
      </PageShell>
    );
  }

  if (!video || !id) {
    return (
      <div className="page player-fallback">
        <EmptyState testId="player-empty" title="视频不存在" description="这条记录可能已被删除" />
      </div>
    );
  }

  // 阅读材料：面板只剩问答，左侧渲染阅读器而不是播放器
  const isMaterial = video.kind === 'material';
  const panelKeys = isMaterial ? MATERIAL_PANEL_KEYS : PANEL_KEYS;
  /**
   * 实际生效的面板。不直接把 activeTab 塞进 Tabs 的 selectedKey：
   * 材料页的 activeTab 初值仍是 'subs'（面板里没有这一项），直接传会让 Tabs 处于
   * 「selectedKey 指向不存在的 tab」的状态；用派生值可以让首帧就落在问答上，不需要等一个 effect。
   */
  const effTab: PanelKey = panelKeys.includes(activeTab) ? activeTab : panelKeys[0];

  // 四个面板只实例化一份，在所有尺寸下都由学习助手的 Tabs 保活切换。
  // 材料只实例化问答：其余面板都以字幕为输入，挂上去只会给出「先生成字幕」的错误入口。
  const panels: Partial<Record<PanelKey, ReactNode>> = isMaterial
    ? {
        chat: (
          <ChatPanel
            videoId={id}
            videoName={video.name}
            // 材料没有播放器：playerRef 留空（ChatPanel 据此隐藏截图按钮、不渲染 #seek- 链接）
            playerRef={playerRef}
            readerRef={readerRef}
            materialKind={video.materialFormat === 'pdf' || !video.materialFormat ? 'page' : 'para'}
            // 格式原样传下去：md 才有编辑面，ChatPanel 据此决定是否给 agent 挂 edit_markdown
            materialFormat={video.materialFormat}
          />
        ),
      }
    : {
        subs: (
          <SubtitlePanel
            videoId={id}
            playerRef={playerRef}
            currentTime={currentTime}
            onSegmentsChange={onSegmentsChange}
            onRunningChange={setSubsRunning}
            onLoadedChange={onSubsLoadedChange}
          />
        ),
        chat: (
          <ChatPanel videoId={id} videoName={video.name} playerRef={playerRef} readerRef={readerRef} />
        ),
        dm: <DanmakuPanel videoId={id} playerRef={playerRef} hasSubtitles={hasSubtitles} />,
        cards: <CardsPanel videoId={id} videoName={video.name} playerRef={playerRef} hasSubtitles={hasSubtitles} />,
      };

  /**
   * 视频栏的类名。`video-pane--comments-open` 只给视频加（材料页没有评论区；它锚定的是
   * 「秒」，材料只有页/段）。这个状态主要服务窄屏与影院模式的高度分配。
   */
  const videoPaneClass = [
    'video-pane',
    isMaterial ? 'video-pane--reading' : '',
    !isMaterial && commentsOpen ? 'video-pane--comments-open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <PageShell
      title={video.name}
      onBack={() => navigate('/library')}
      fill
      rootRef={colorSchemeRef}
      rootClassName="page-player"
      rail={nav}
      railFooter={<SettingsButton variant="rail" testId="nav-rail-settings" />}
      /* 顶栏右上角那颗设置图标撤掉（与 AI 助手页 / 课程库 / 学习页同一口径）：
         设置入口统一收在侧栏底部的 `railFooter`（窄屏在抽屉里）——
         同一个入口在一条顶栏里露两次没有必要。 */
    >
      <div className={`player-layout player-layout--assistant${theaterMode ? ' player-layout--theater' : ''}`}>
        {/* 字幕字号变量设在普通容器上（不 media-player host：它 upgrade 时会重写内联样式），
            经继承传递给内部的 .vds-captions */}
        <div
          className={videoPaneClass}
          style={{ '--media-user-font-size': captionScale } as CSSProperties}
        >
          {isMaterial ? (
            <MaterialReader key={id} material={video} handleRef={readerRef} />
          ) : fileMissing ? (
            <div className="video-pane__missing">
              <EmptyState
                testId="player-file-missing"
                icon={<Sym name="error" />}
                title="视频文件已删除"
                description="字幕 / 讲义 / 问答仍可使用"
              />
            </div>
          ) : (
            <MediaPlayer
              ref={playerRef}
              title={video.name}
              src={{ src: videoUrl, type: toPlayerMime(video.mimeType) }}
              storage={resumeStorage}
              playsInline
              crossOrigin
              // 控制栏只在鼠标悬停播放器时出现（YouTube 行为）：mouseenter → show(0)、
              // mouseleave → hide(0) 立即收起；静态隐藏关掉（见 CONTROLS_IDLE_DELAY）。
              // 「未播放过」那段 vds 不注册鼠标监听，由 player-enhance.css 的 :hover 兜住。
              // 键盘焦点在播放器内部时暂时保持控制栏，确保 Tab 不会把控制键从焦点顺序中
              // 隐藏；焦点离开整个播放器后再恢复 YouTube 式的移出即隐藏。
              hideControlsOnMouseLeave={!keyboardControls}
              onFocus={() => setKeyboardControls(true)}
              onBlur={(event) => {
                const next = event.relatedTarget;
                if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
                  setKeyboardControls(false);
                }
              }}
              controlsDelay={CONTROLS_IDLE_DELAY}
              // YouTube 式快捷键（←/→ 5s、j/l 10s、Home/End、暂停逐帧…）。见 utils/playerKeys.ts
              keyShortcuts={keyShortcuts}
              keyTarget="player"
              keyDisabled={!shortcuts.enabled || settingsOpen}
              onKeyDownCapture={(event) => {
                // 输入法候选字和嵌套编辑器内的按键不触发媒体动作。
                const target = event.target;
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 ||
                  (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))) {
                  event.stopPropagation();
                }
              }}
              // 学习时长追踪：播放中不做「人走开了」的空闲判定（看课不用一直操作键鼠）。
              // 暂停/播完/卸载都恢复普通判定，见 store/studyTime.ts。
              onPlay={() => setStudyMediaPlaying(true)}
              onPlaying={() => setStudyMediaPlaying(true)}
              onPause={() => setStudyMediaPlaying(false)}
              onEnded={() => setStudyMediaPlaying(false)}
              // 这里刻意**不带** style：播放器是直角，真正的实现在 player-enhance.css 的
              // `[data-media-player] { --video-border-radius: 0 }` —— vds 默认布局会在宿主上写
              // `border-radius: var(--video-border-radius, 6px)`，只删这里的内联圆角是盖不住它的。
              // 此前这行是 style={{ borderRadius: 12, overflow: 'hidden' }}（2026-09-23 按用户
              // 要求去掉直角）；overflow 当初只为让圆角能裁住视频，没有别的用途，因此一并删掉。
            >
              <MediaProvider>
                {/* 常驻单轨、不设 src：挂载即 ready，之后由 syncTrack 增量 addCue */}
                {trackReady && <Track id={SUBS_TRACK_ID} kind="subtitles" label="中文字幕" default />}
              </MediaProvider>
              {/* 中央大播放按钮：必须挂在 <MediaProvider> 之外 —— 手势层是在 provider 元素上
                  监听 pointerup 的（单击暂停 / 双击全屏），挂在里面会被它连点两下。 */}
              <PlayerBigPlayButton />
              <SeekFeedback />
              <DanmakuLayer videoId={id} />
              {/* 滑块方向键跟随小幅跳转步长。映射改变时重挂布局，刷新 vidstack 在控件
                  挂载时生成的 aria-keyshortcuts，避免旧映射反向覆盖新配置。只重挂控制栏，不重载视频。 */}
              <DefaultVideoLayout key={JSON.stringify(shortcuts.bindings)} icons={defaultLayoutIcons} slots={layoutSlots} seekStep={shortcuts.arrowSeek} />
            </MediaPlayer>
          )}

          {/* 评论区：贴在播放器下方，**必须在 .video-pane 内部**。
              放成 .player-layout 的直接子节点会变成「视频栏与侧栏之间的第三栏」
              （`display:flex` 的 row 布局），视频栏被挤窄、顺序也全乱 —— 实测踩到过。
              材料页不渲染：它锚定的是「秒」，材料只有页/段。 */}
          {!isMaterial && (
            <CommentsSection
              videoId={id}
              playerRef={playerRef}
              hasSubtitles={hasSubtitles}
              onOpenChange={setCommentsOpen}
            />
          )}
        </div>

      </div>

      <StudyAssistant open={assistantOpen} onOpenChange={setAssistantOpen}
        activeTab={effTab} onTabChange={setActiveTab} panelKeys={panelKeys} panels={panels} />

      {/* 全局选区浮层：挂在播放页根上，跨越阅读器与面板两棵子树 */}
      <SelectionAsk />
    </PageShell>
  );
}
