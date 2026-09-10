import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Popover, Progress, Segmented, Space, Tooltip, Typography } from 'antd';
import { ControlOutlined, DownloadOutlined, FileWordOutlined, SettingOutlined } from '@ant-design/icons';
import { renderAsync } from 'docx-preview';
import { ensureHandoutPreviewFonts } from '../handout/previewFonts';
import { db, type HandoutRow } from '../store/db';
import { runHandout, type HandoutProgress } from '../pipelines/handout';
import { loadEnabledSkillMeta, type SkillMeta } from '../skills/store';
import { useIsMobile } from '../utils/useMobile';
import { TextSwap } from './motion';
import ModelPicker from './ModelPicker';
import HandoutDocView from './HandoutDocView';
import PersistentError from './PersistentError';
import { formatCaughtError } from '../utils/errorText';

interface Props {
  videoId: string;
  hasSubtitles: boolean;
}

type SkillMode = 'auto' | 'pin' | 'drop';

export default function HandoutPanel({ videoId, hasSubtitles }: Props) {
  const { message, modal } = App.useApp();
  const [handout, setHandout] = useState<HandoutRow | null>(null);
  const [progress, setProgress] = useState<HandoutProgress | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [skillModes, setSkillModes] = useState<Record<number, SkillMode>>({});
  const skelRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  /**
   * 手机端 docx 预览等比缩放：docx-preview 按 A4 像素宽（~794px）渲染，窄屏溢出。
   * 逐页 transform scale 到容器宽，并用负 marginBottom 补偿布局高度（transform 不占布局）。
   * 非手机端重置，处理窗口宽窄互切。
   */
  const fitPreviewScale = useCallback(() => {
    const el = previewRef.current;
    if (!el) return;
    const pages = el.querySelectorAll<HTMLElement>('section.docx');
    const avail = el.clientWidth - 8;
    pages.forEach((p) => {
      // 先重置再测量，避免重复调用时叠加
      p.style.transform = '';
      p.style.marginBottom = '';
      const w = p.scrollWidth;
      if (isMobile && avail > 0 && w > avail) {
        const s = avail / w;
        p.style.transform = `scale(${s})`;
        p.style.transformOrigin = 'top left';
        p.style.marginBottom = `${-(p.scrollHeight * (1 - s)) + 8}px`;
      }
    });
  }, [isMobile]);

  // 窗口宽窄切换 / 插图加载完成（高度变化影响补偿）时重算缩放
  useEffect(() => {
    window.addEventListener('resize', fitPreviewScale);
    const el = previewRef.current;
    el?.addEventListener('load', fitPreviewScale, true); // img load 不冒泡，走捕获
    return () => {
      window.removeEventListener('resize', fitPreviewScale);
      el?.removeEventListener('load', fitPreviewScale, true);
    };
  }, [fitPreviewScale]);

  const loadLatest = useCallback(async () => {
    const rows = await db.handouts.where('videoId').equals(videoId).sortBy('createdAt');
    setHandout(rows[rows.length - 1] ?? null);
  }, [videoId]);

  useEffect(() => {
    loadLatest();
  }, [loadLatest]);

  /** 打开技能覆盖面板时加载：启用中的技能 + 本视频的手动覆盖 */
  const loadSkillState = useCallback(async () => {
    const metas = await loadEnabledSkillMeta();
    setSkills(metas);
    const ov = (await db.videos.get(videoId))?.skillOverride;
    const map: Record<number, SkillMode> = {};
    for (const m of metas) {
      map[m.id] = ov?.pin.includes(m.id) ? 'pin' : ov?.drop.includes(m.id) ? 'drop' : 'auto';
    }
    setSkillModes(map);
  }, [videoId]);

  const setSkillMode = async (id: number, mode: SkillMode) => {
    const next = { ...skillModes, [id]: mode };
    setSkillModes(next);
    const pin = Object.entries(next).filter(([, v]) => v === 'pin').map(([k]) => Number(k));
    const drop = Object.entries(next).filter(([, v]) => v === 'drop').map(([k]) => Number(k));
    await db.videos.update(videoId, { skillOverride: { pin, drop } });
  };

  // 渲染 DOCX 预览（skeleton-reveal：脉冲占位 → cross-fade + cross-blur 到内容）
  // 仅旧版无 IR 的讲义行走此路径；有 sectionsJson 的讲义由 HandoutDocView 结构化渲染
  useEffect(() => {
    const skel = skelRef.current;
    const el = previewRef.current;
    if (!handout || handout.sectionsJson || !skel || !el) return;
    const skeleton = skel.querySelector('.t-skel-skeleton');
    // 回到加载态：is-resetting 杀掉反向过渡，reflow 后恢复，重新脉冲
    skel.classList.add('is-resetting');
    skel.classList.remove('is-revealed');
    skeleton?.classList.remove('is-pulsing');
    void skel.offsetWidth;
    skel.classList.remove('is-resetting');
    skeleton?.classList.add('is-pulsing');

    el.innerHTML = '';
    ensureHandoutPreviewFonts(); // 公文字体兜底：local() 优先，缺字体设备下载开源仿宋分包
    renderAsync(handout.blob, el, undefined, { inWrapper: true })
      .then(() => {
        skel.classList.add('is-revealed');
        fitPreviewScale();
        // 字体分包异步加载完成后页面高度可能微变，重算一次手机端缩放补偿
        void document.fonts.ready.then(() => fitPreviewScale());
      })
      .catch((e) => console.error('docx 预览失败', e));
  }, [handout, fitPreviewScale]);

  const start = async () => {
    setErrorText(null);
    setProgress({ phase: 'frames', done: 0, total: 1, message: '准备中…' });
    try {
      await runHandout(videoId, setProgress);
      message.success('讲义生成完成');
    } catch (e) {
      const errText = formatCaughtError(e);
      setErrorText(errText);
      modal.error({
        title: '讲义生成失败',
        width: 560,
        content: (
          <Typography.Paragraph
            copyable={{ text: errText }}
            style={{ whiteSpace: 'pre-wrap', userSelect: 'text', maxHeight: 320, overflow: 'auto' }}
          >
            {errText}
          </Typography.Paragraph>
        ),
      });
    } finally {
      setProgress(null);
      await loadLatest();
    }
  };

  const downloadDocx = async () => {
    if (!handout?.id) return;
    // 从 DB 读最新行：块级编辑落盘后 blob 已重建，面板内存里的可能是旧版
    const row = await db.handouts.get(handout.id);
    if (!row) return;
    const url = URL.createObjectURL(row.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${row.title}.docx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const running = progress !== null;
  const pct = progress && progress.total > 1 ? Math.round((progress.done / progress.total) * 100) : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Space style={{ padding: '8px 0', flexShrink: 0 }} wrap>
        <Button
          type="primary"
          icon={<FileWordOutlined />}
          loading={running}
          onClick={start}
          disabled={!hasSubtitles}
          title={hasSubtitles ? undefined : '请先在「字幕」页生成字幕'}
        >
          {handout ? '重新生成讲义' : '生成讲义'}
        </Button>
        {handout && (
          <Button size="small" icon={<DownloadOutlined />} onClick={() => void downloadDocx()}>
            下载 DOCX
          </Button>
        )}
        <Popover
          trigger="click"
          placement="bottomLeft"
          onOpenChange={(open) => open && void loadSkillState()}
          content={
            // 手机屏宽有限，Popover 内容宽取 340 与屏宽安全值的较小者
            <div style={{ width: 'min(340px, calc(100vw - 64px))' }}>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
                「自动」由路由器按课程内容选用；「必用 / 排除」为本视频的手动覆盖。
              </div>
              {skills.length === 0 && <div style={{ color: '#999' }}>暂无启用的技能，请到「设置 → 写作技能」添加</div>}
              {skills.map((s) => (
                <div
                  key={s.id}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}
                >
                  <Tooltip title={s.description || '（无描述）'} placement="left">
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                  </Tooltip>
                  <Segmented
                    size="small"
                    options={[
                      { label: '自动', value: 'auto' },
                      { label: '必用', value: 'pin' },
                      { label: '排除', value: 'drop' },
                    ]}
                    value={skillModes[s.id] ?? 'auto'}
                    onChange={(v) => void setSkillMode(s.id, v as SkillMode)}
                  />
                </div>
              ))}
              {handout?.usedSkills && handout.usedSkills.length > 0 && (
                <div style={{ fontSize: 12, color: '#888', borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
                  上次生成选用：{handout.usedSkills.join('、')}
                </div>
              )}
            </div>
          }
        >
          <Button size="small" icon={<ControlOutlined />}>
            技能
          </Button>
        </Popover>
        <Popover
          content={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>抽帧筛选 / 截图描述（视觉）</div>
                <ModelPicker slot="vision" field="visionModel" />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>讲义写作（文本）</div>
                <ModelPicker slot="chat" field="llmModel" />
              </div>
            </div>
          }
          trigger="click"
          placement="bottomRight"
        >
          <Button size="small" type="text" icon={<SettingOutlined />}>模型</Button>
        </Popover>
      </Space>

      {!hasSubtitles && !running && (
        <div style={{ color: '#999', padding: 16, textAlign: 'center' }}>
          讲义基于字幕内容生成，请先在「字幕」页生成字幕
        </div>
      )}

      {running && progress && (
        <div style={{ padding: '4px 0 12px', flexShrink: 0 }}>
          <Progress percent={pct} size="small" status="active" />
          <TextSwap text={progress.message} style={{ fontSize: 12, color: '#888' }} />
        </div>
      )}

      <PersistentError title="讲义生成失败" text={errorText} onClose={() => setErrorText(null)} />

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {handout ? (
          handout.sectionsJson ? (
            // 结构化视图：块级左滑 / hover → AI 改写、手动编辑；DOCX 由 IR 实时重建
            <HandoutDocView handout={handout} />
          ) : (
            // 旧版生成的讲义（无 IR）：只读 docx-preview 预览
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 8, flexShrink: 0 }}
                message="该讲义由旧版生成，仅支持只读预览；重新生成后可逐段 AI 改写 / 手动编辑"
              />
              <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                <div ref={skelRef} className="t-skel" style={{ height: '100%' }}>
                  <div className="t-skel-skeleton" style={{ padding: '8px 4px', overflow: 'hidden' }}>
                    <div style={{ height: 22, width: '45%', margin: '8px auto 20px', borderRadius: 4, background: '#ececec' }} />
                    <div style={{ height: 12, width: '92%', margin: '10px 0', borderRadius: 4, background: '#f0f0f0' }} />
                    <div style={{ height: 12, width: '97%', margin: '10px 0', borderRadius: 4, background: '#f0f0f0' }} />
                    <div style={{ height: 12, width: '78%', margin: '10px 0', borderRadius: 4, background: '#f0f0f0' }} />
                    <div style={{ height: 120, width: '70%', margin: '18px auto', borderRadius: 6, background: '#ececec' }} />
                    <div style={{ height: 12, width: '88%', margin: '10px 0', borderRadius: 4, background: '#f0f0f0' }} />
                    <div style={{ height: 12, width: '64%', margin: '10px 0', borderRadius: 4, background: '#f0f0f0' }} />
                  </div>
                  <div
                    ref={previewRef}
                    className="t-skel-content docx-preview-container"
                    style={{ overflow: 'auto' }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      bottom: 0,
                      zIndex: 3,
                      pointerEvents: 'none',
                      textAlign: 'center',
                      fontSize: 11,
                      color: '#aaa',
                      padding: '14px 0 4px',
                      background: 'linear-gradient(transparent, #fff 55%)',
                    }}
                  >
                    目录页码将在 Word / WPS 中打开文档后自动生成
                  </div>
                </div>
              </div>
            </div>
          )
        ) : (
          !running &&
          hasSubtitles && (
            <div style={{ color: '#999', padding: 16, textAlign: 'center' }}>
              点击「生成讲义」，将自动抽取课程画面、提炼大纲并排版为公文格式 DOCX
            </div>
          )
        )}
      </div>
    </div>
  );
}
