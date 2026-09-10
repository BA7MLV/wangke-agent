import { useCallback, useEffect, useRef, useState } from 'react';
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
import './handout-panel.css';
import {
  Panel,
  PanelBar,
  PanelProgress,
  PanelPlaceholder,
  EmptyState,
  Banner,
  Field,
  toast,
  alertDialog,
  useMduiEvent,
} from '../ui';

interface Props {
  videoId: string;
  hasSubtitles: boolean;
}

type SkillMode = 'auto' | 'pin' | 'drop';

export default function HandoutPanel({ videoId, hasSubtitles }: Props) {
  const [handout, setHandout] = useState<HandoutRow | null>(null);
  const [progress, setProgress] = useState<HandoutProgress | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [skillModes, setSkillModes] = useState<Record<number, SkillMode>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      toast.success('讲义生成完成');
    } catch (e) {
      const errText = formatCaughtError(e);
      setErrorText(errText);
      // 原 antd Modal.error 带可复制的错误详情；mdui 用 alertDialog + copyText 复制
      await alertDialog({
        headline: '讲义生成失败',
        description: errText,
        copyText: errText,
        confirmText: '知道了',
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

  // 生成参数对话框：Esc / 点遮罩关闭时同步回 React state，避免「关掉又自己弹回」
  const settingsDlgRef = useMduiEvent('mdui-dialog', 'closed', () => setSettingsOpen(false));

  return (
    <Panel testId="panel-handout">
      <PanelBar>
        <mdui-tooltip content={!hasSubtitles ? '请先在「字幕」页生成字幕' : ''}>
          <mdui-button
            variant="filled"
            data-testid="handout-generate"
            loading={running}
            disabled={!hasSubtitles}
            onClick={start}
          >
            <mdui-sym-article slot="icon" />
            {handout ? '重新生成讲义' : '生成讲义'}
          </mdui-button>
        </mdui-tooltip>
        {handout && (
          <mdui-button data-testid="handout-export" onClick={() => void downloadDocx()}>
            <mdui-sym-download slot="icon" />
            下载 DOCX
          </mdui-button>
        )}
        <mdui-button
          data-testid="handout-settings"
          onClick={() => {
            void loadSkillState();
            setSettingsOpen(true);
          }}
        >
          <mdui-sym-tune slot="icon" />
          参数设置
        </mdui-button>
      </PanelBar>

      {!hasSubtitles && !running && (
        <PanelPlaceholder>讲义基于字幕内容生成，请先在「字幕」页生成字幕</PanelPlaceholder>
      )}

      {running && progress && (
        <PanelProgress testId="handout-progress" percent={pct} text={<TextSwap text={progress.message} />} />
      )}

      <PersistentError title="讲义生成失败" text={errorText} onClose={() => setErrorText(null)} />

      <div className="hp-body">
        {handout ? (
          handout.sectionsJson ? (
            // 结构化视图：块级左滑 / hover → AI 改写、手动编辑；DOCX 由 IR 实时重建
            <HandoutDocView handout={handout} />
          ) : (
            // 旧版生成的讲义（无 IR）：只读 docx-preview 预览
            <div className="hp-legacy">
              <Banner variant="info" title="该讲义由旧版生成，仅支持只读预览；重新生成后可逐段 AI 改写 / 手动编辑" />
              <div className="hp-legacy__scroll">
                <div ref={skelRef} className="t-skel hp-legacy__skel">
                  <div className="t-skel-skeleton hp-skel">
                    <div className="hp-skel__bar hp-skel__bar--title" />
                    <div className="hp-skel__bar" />
                    <div className="hp-skel__bar" />
                    <div className="hp-skel__bar hp-skel__bar--short" />
                    <div className="hp-skel__img" />
                    <div className="hp-skel__bar" />
                    <div className="hp-skel__bar hp-skel__bar--short" />
                  </div>
                  <div
                    ref={previewRef}
                    className="t-skel-content docx-preview-container hp-legacy__preview"
                  />
                  <div className="hp-legacy__fade">目录页码将在 Word / WPS 中打开文档后自动生成</div>
                </div>
              </div>
            </div>
          )
        ) : (
          !running &&
          hasSubtitles && (
            <EmptyState
              testId="handout-empty"
              icon={<mdui-sym-article />}
              title="还没有讲义"
              description="点击「生成讲义」，将自动抽取课程画面、提炼大纲并排版为公文格式 DOCX"
            />
          )
        )}
      </div>

      {/* 生成参数（模型 + 技能覆盖）：原两个 antd Popover 合并为一个受控对话框。
          内容含模型下拉与每个技能的「自动/必用/排除」分段控件，不是「点一下就关」的单选项，
          用对话框比 dropdown 菜单更合适（菜单项点击即关、放不下多组交互控件）。 */}
      <mdui-dialog
        ref={settingsDlgRef}
        open={settingsOpen}
        close-on-esc
        close-on-overlay-click
        headline="生成参数"
        data-testid="handout-settings-dialog"
      >
        <div className="hp-settings">
          <Field label="抽帧筛选 / 截图描述（视觉）">
            <ModelPicker slot="vision" field="visionModel" />
          </Field>
          <Field label="讲义写作（文本）">
            <ModelPicker slot="chat" field="llmModel" />
          </Field>
          <div className="hp-settings__hint">
            「自动」由路由器按课程内容选用；「必用 / 排除」为本视频的手动覆盖。
          </div>
          {skills.length === 0 ? (
            <div className="hp-settings__empty">暂无启用的技能，请到「设置 → 写作技能」添加</div>
          ) : (
            skills.map((s) => (
              <SkillModeRow
                key={s.id}
                skill={s}
                mode={skillModes[s.id] ?? 'auto'}
                onMode={(v) => void setSkillMode(s.id, v)}
              />
            ))
          )}
          {handout?.usedSkills && handout.usedSkills.length > 0 && (
            <div className="hp-settings__used">上次生成选用：{handout.usedSkills.join('、')}</div>
          )}
        </div>
        <mdui-button slot="action" variant="text" onClick={() => setSettingsOpen(false)}>
          关闭
        </mdui-button>
      </mdui-dialog>
    </Panel>
  );
}

/** 单个技能的「自动 / 必用 / 排除」分段控件行。
 *  不用 mdui-list-item（custom 插槽覆盖式，塞不下标题 + 控件两组内容）；
 *  分段控件值从元素上读，change 事件走 useMduiEvent（mdui 自定义事件 React 不自动绑定）。 */
function SkillModeRow({
  skill,
  mode,
  onMode,
}: {
  skill: SkillMeta;
  mode: SkillMode;
  onMode: (mode: SkillMode) => void;
}) {
  const ref = useMduiEvent('mdui-segmented-button-group', 'change', (_e, el) =>
    onMode(el.value as SkillMode),
  );
  return (
    <div className="hp-skill-row">
      <mdui-tooltip content={skill.description || '（无描述）'}>
        <span className="hp-skill-row__name">{skill.name}</span>
      </mdui-tooltip>
      <mdui-segmented-button-group ref={ref} value={mode}>
        <mdui-segmented-button value="auto">自动</mdui-segmented-button>
        <mdui-segmented-button value="pin">必用</mdui-segmented-button>
        <mdui-segmented-button value="drop">排除</mdui-segmented-button>
      </mdui-segmented-button-group>
    </div>
  );
}
