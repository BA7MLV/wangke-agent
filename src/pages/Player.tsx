import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App, Button, Empty, Spin, Tabs } from 'antd';
import { ArrowLeftOutlined, CommentOutlined, FileTextOutlined, FileWordOutlined, IdcardOutlined, MessageOutlined } from '@ant-design/icons';
import { MediaPlayer, MediaProvider, Track, type MediaPlayerInstance, type MediaStorage } from '@vidstack/react';
import { DefaultVideoLayout, defaultLayoutIcons } from '@vidstack/react/player/layouts/default';
import '@vidstack/react/player/styles/default/theme.css';
import '@vidstack/react/player/styles/default/layouts/video.css';
import '../player-enhance.css';
import { db, type VideoRow } from '../store/db';
import { getVideoFile } from '../store/fileStore';
import { useSettings } from '../store/settings';
import { toVTT, type Cue } from '../utils/vtt';
import { useIsMobile } from '../utils/useMobile';
import SubtitlePanel from '../components/SubtitlePanel';
import HandoutPanel from '../components/HandoutPanel';
import ChatPanel from '../components/ChatPanel';
import DanmakuPanel from '../components/DanmakuPanel';
import CardsPanel from '../components/CardsPanel';
import RateButtons from '../components/RateButtons';
import CaptionSizeButton from '../components/CaptionSizeButton';
import DanmakuToggleButton from '../components/DanmakuToggleButton';
import SeekFeedback from '../components/SeekFeedback';
import DanmakuLayer from '../components/DanmakuLayer';

/** 把任意 MIME 映射到 vidstack 支持的联合类型，未知则按 mp4 处理 */
function toPlayerMime(mime: string): 'video/mp4' | 'video/webm' | 'video/ogg' | 'audio/mpeg' | 'audio/ogg' {
  const known = ['video/mp4', 'video/webm', 'video/ogg', 'audio/mpeg', 'audio/ogg'] as const;
  return (known as readonly string[]).includes(mime) ? (mime as (typeof known)[number]) : 'video/mp4';
}

export default function Player() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [video, setVideo] = useState<VideoRow | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
  // 记录存在但视频文件本体已删：进入无文件模式，字幕/讲义/问答仍可用
  const [fileMissing, setFileMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [segments, setSegments] = useState<Cue[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const playerRef = useRef<MediaPlayerInstance>(null);
  const captionScale = useSettings((s) => s.captionScale);
  const isMobile = useIsMobile();
  // 手机端底部 Tab 当前面板（桌面/平板走 antd Tabs，内部自管）
  const [activeTab, setActiveTab] = useState<'subs' | 'handout' | 'chat' | 'dm' | 'cards'>('subs');

  // 断点续播：Vidstack 原生 MediaStorage 机制——打开时 getTime 恢复进度，
  // 播放中自动节流 setTime 落盘（含暂停/页面隐藏），播完 ended=true 归零
  const resumeStorage = useMemo<MediaStorage>(
    () => ({
      async getTime() {
        if (!id) return null;
        return (await db.videos.get(id))?.lastPosition ?? null;
      },
      async setTime(time, ended) {
        if (!id) return;
        await db.videos.update(id, { lastPosition: ended ? 0 : time });
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
        message.error('视频不存在');
        navigate('/');
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



  // 字幕 VTT blob URL
  const vttUrl = useMemo(() => {
    if (segments.length === 0) return '';
    return URL.createObjectURL(new Blob([toVTT(segments)], { type: 'text/vtt' }));
  }, [segments]);
  useEffect(() => () => {
    if (vttUrl) URL.revokeObjectURL(vttUrl);
  }, [vttUrl]);

  const onSegmentsChange = useCallback((segs: Cue[]) => setSegments(segs), []);

  // slots 对象固定引用：每次渲染的新字面量会让 Vidstack 重建 slot 内容并重置控制栏 idle
  // 状态（手机断点切换触发重渲染时，控制栏会意外自动隐藏）
  const layoutSlots = useMemo(
    () => ({
      topControlsGroupStart: <RateButtons />,
      topControlsGroupEnd: (
        <>
          <DanmakuToggleButton />
          <CaptionSizeButton />
        </>
      ),
    }),
    [],
  );

  if (loading) {
    return (
      <div className="page" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!video || !id) return <Empty />;

  // 五个面板只实例化一份：桌面/平板挂进 antd Tabs，手机挂进 panel-host（hidden 保活切换）
  const panels: Record<'subs' | 'handout' | 'chat' | 'dm' | 'cards', ReactNode> = {
    subs: (
      <SubtitlePanel
        videoId={id}
        playerRef={playerRef}
        currentTime={currentTime}
        onSegmentsChange={onSegmentsChange}
      />
    ),
    handout: <HandoutPanel videoId={id} hasSubtitles={segments.length > 0} />,
    chat: <ChatPanel videoId={id} videoName={video.name} playerRef={playerRef} />,
    dm: <DanmakuPanel videoId={id} playerRef={playerRef} hasSubtitles={segments.length > 0} />,
    cards: <CardsPanel videoId={id} videoName={video.name} playerRef={playerRef} hasSubtitles={segments.length > 0} />,
  };

  return (
    <div className="page">
      <div className="page-header">
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')} />
        <div className="title">{video.name}</div>
      </div>
      <div className="player-layout">
        {/* 字幕字号变量设在普通容器上（不 media-player host：它 upgrade 时会重写内联样式），
            经继承传递给内部的 .vds-captions */}
        <div className="video-pane" style={{ '--media-user-font-size': captionScale } as CSSProperties}>
          {fileMissing ? (
            <Empty style={{ margin: 'auto' }} description="视频文件已删除，字幕 / 讲义 / 问答仍可使用" />
          ) : (
            <MediaPlayer
              ref={playerRef}
              title={video.name}
              src={{ src: videoUrl, type: toPlayerMime(video.mimeType) }}
              storage={resumeStorage}
              playsInline
              crossOrigin
              style={{ borderRadius: 8, overflow: 'hidden' }}
            >
              <MediaProvider>
                {vttUrl && <Track src={vttUrl} kind="subtitles" label="中文字幕" default />}
              </MediaProvider>
              <SeekFeedback />
              <DanmakuLayer videoId={id} />
              <DefaultVideoLayout icons={defaultLayoutIcons} slots={layoutSlots} />
            </MediaPlayer>
          )}
        </div>
        {isMobile ? (
          <>
            <div className="panel-host">
              {(['subs', 'handout', 'chat', 'dm', 'cards'] as const).map((key) => (
                <div key={key} className="panel-slot" hidden={activeTab !== key}>
                  {panels[key]}
                </div>
              ))}
            </div>
            <nav className="mobile-tabbar">
              {(
                [
                  { key: 'subs', label: '字幕', icon: <FileTextOutlined /> },
                  { key: 'handout', label: '讲义', icon: <FileWordOutlined /> },
                  { key: 'chat', label: '问答', icon: <MessageOutlined /> },
                  { key: 'dm', label: '弹幕', icon: <CommentOutlined /> },
                  { key: 'cards', label: '卡片', icon: <IdcardOutlined /> },
                ] as const
              ).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={activeTab === t.key ? 'active' : ''}
                  onClick={() => setActiveTab(t.key)}
                >
                  {t.icon}
                  <span>{t.label}</span>
                </button>
              ))}
            </nav>
          </>
        ) : (
          <div className="side-pane">
            <Tabs
              style={{ padding: '0 12px', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
              items={[
                { key: 'subs', label: '字幕', children: panels.subs },
                { key: 'handout', label: '讲义', children: panels.handout },
                { key: 'chat', label: '问答', children: panels.chat },
                { key: 'dm', label: '弹幕', children: panels.dm },
                { key: 'cards', label: '卡片', children: panels.cards },
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
}
