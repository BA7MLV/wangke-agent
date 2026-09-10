import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings, type AppTheme, type ModelSlot } from '../store/settings';
import { listModels } from '../api/siliconflow';
import { guessContextWindow, isVisionModel, supportsThinking } from '../api/modelCaps';
import { getModelMeta, isModelMetaStale, modelMetaInfo, refreshModelMeta } from '../api/modelMeta';
import { db } from '../store/db';
import { MAX_RATE, MIN_RATE, PRESET_RATES, formatRate, normalizeRate, sameRate } from '../utils/rate';
import { SuccessCheck, ms } from '../components/motion';
import SkillsCard from '../components/SkillsCard';
import StorageCard from '../components/StorageCard';
import MigrationCard from '../components/MigrationCard';
import { Field, PageShell, SectionCard, confirmDialog, toast, useMduiEvent } from '../ui';
import { useAppNav } from '../components/appNav';

const ASR_MODEL_RE = /asr|whisper|sensevoice|xingchen/i;
const EMBED_MODEL_RE = /embed|bge|gte/i;

/** 各收藏槽位的相关性启发式：相关模型在列表中置顶 */
const SLOT_RELEVANT: Record<ModelSlot, (id: string) => boolean> = {
  chat: (id) => supportsThinking(id) || isVisionModel(id),
  vision: isVisionModel,
  asr: (id) => ASR_MODEL_RE.test(id),
  embed: (id) => EMBED_MODEL_RE.test(id),
};

const SLOT_TABS: { key: ModelSlot; label: string }[] = [
  { key: 'chat', label: '文本' },
  { key: 'vision', label: '视觉' },
  { key: 'asr', label: 'ASR' },
  { key: 'embed', label: 'Embedding' },
];

type ModelFieldName = 'asrModel' | 'llmModel' | 'embedModel' | 'visionModel';

/**
 * 模型输入行。
 *
 * 为什么不是 antd 的 `AutoComplete`：mdui 没有等价组件（设计文档 §2.5 就把它列为「需要自建」）。
 * 这里没有硬凑一个 combobox，而是做成「自由输入 + 按需展开的可筛选列表」：
 *   - 输入框仍是唯一的值来源，粘贴任意模型 id 的行为完全不变；
 *   - 列表只在用户主动点「选择」时展开，且用 `mdui-list` 而不是绝对定位的弹层 ——
 *     手机上不必担心 popover 被软键盘顶飞或定位漂移，也不会和播放器/面板的键盘拦截打架。
 * 这是有意的取舍（换来的是稳），如果将来要更像桌面端的 combobox，再基于 `mdui-dropdown` 重做。
 */
function ModelField({
  label,
  value,
  options,
  checkState,
  onValueChange,
  onPick,
  testId,
}: {
  label: string;
  value: string;
  options: string[];
  /** undefined = 还没检查过；true/false = 检查结果 */
  checkState: boolean | undefined;
  onValueChange: (v: string) => void;
  onPick: (v: string) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [kw, setKw] = useState('');

  const fieldRef = useMduiEvent('mdui-text-field', 'input', (_e, el) => onValueChange(el.value));
  const filterRef = useMduiEvent('mdui-text-field', 'input', (_e, el) => setKw(el.value));

  const list = options
    .filter((id) => !kw.trim() || id.toLowerCase().includes(kw.trim().toLowerCase()))
    .sort((a, b) => Number(SLOT_RELEVANT.asr(a)) - Number(SLOT_RELEVANT.asr(b)));

  return (
    <Field
      label={
        <>
          <span>{label}</span>
          {checkState === true && <SuccessCheck />}
          {checkState === false && (
            <mdui-sym-error
              data-testid={`${testId}-bad`}
              style={{ color: 'rgb(var(--mdui-color-error))', fontSize: '16px' }}
            />
          )}
        </>
      }
      testId={`${testId}-field`}
    >
      <div className="row row--nowrap">
        <mdui-text-field
          ref={fieldRef}
          data-testid={testId}
          value={value}
          clearable
          style={{ flex: '1 1 auto', minWidth: 0 }}
        />
        {options.length > 0 && (
          <mdui-button
            variant="text"
            data-testid={`${testId}-pick`}
            onClick={() => setOpen((o) => !o)}
          >
            选择
          </mdui-button>
        )}
      </div>
      {open && options.length > 0 && (
        <div className="model-picker">
          <mdui-text-field
            ref={filterRef}
            data-testid={`${testId}-filter`}
            placeholder="筛选模型"
            clearable
          />
          <mdui-list>
            {list.map((id) => (
              <mdui-list-item
                key={id}
                headline={id}
                data-testid={`${testId}-option`}
                onClick={() => {
                  onPick(id);
                  setOpen(false);
                }}
              />
            ))}
          </mdui-list>
        </div>
      )}
    </Field>
  );
}

/** 收藏夹里的一个勾选项：需要独立 hook，所以拆成子组件 */
function FavRow({
  id,
  checked,
  onToggle,
}: {
  id: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  const ref = useMduiEvent('mdui-checkbox', 'change', (_e, el) => onToggle(el.checked));
  return (
    <mdui-checkbox ref={ref} checked={checked} data-testid={`fav-${id}`} style={{ display: 'flex' }}>
      <span className="fav-label">
        <span className="fav-label__id">{id}</span>
        {isVisionModel(id) && <span className="tag-mini">多模态</span>}
        {supportsThinking(id) && <span className="tag-mini">可思考</span>}
      </span>
    </mdui-checkbox>
  );
}

/** 自定义倍速的一个档位：可删除 chip，同样需要独立 hook */
function RateChip({ rate, onDelete }: { rate: number; onDelete: () => void }) {
  const ref = useMduiEvent('mdui-chip', 'delete', () => onDelete());
  return (
    <mdui-chip ref={ref} deletable data-testid={`rate-chip-${formatRate(rate)}`}>
      {formatRate(rate)}
    </mdui-chip>
  );
}

export default function Settings() {
  const navigate = useNavigate();
  const nav = useAppNav('settings');
  const settings = useSettings();
  const [checking, setChecking] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [checkResult, setCheckResult] = useState<Record<string, boolean> | null>(null);
  const [favTab, setFavTab] = useState<ModelSlot>('chat');
  const [favSearch, setFavSearch] = useState<Record<ModelSlot, string>>({
    chat: '',
    vision: '',
    asr: '',
    embed: '',
  });
  // embedModel 走本地草稿：逐键输入只改草稿不弹确认，下拉选择 / 失焦提交时才确认
  const [embedDraft, setEmbedDraft] = useState(settings.embedModel);
  const embedConfirmRef = useRef(false);
  /** 自定义倍速的输入草稿（null = 输入框为空，「添加」按钮置灰） */
  const [rateDraft, setRateDraft] = useState<number | null>(null);

  // 已提交值外部变化（确认写回 / 面板 ModelPicker 切换）时同步草稿
  useEffect(() => {
    setEmbedDraft(settings.embedModel);
  }, [settings.embedModel]);
  const [keyError, setKeyError] = useState(false);
  const keyInputRef = useRef<HTMLDivElement>(null);
  const revertTimerRef = useRef<number | undefined>(undefined);
  const [metaInfo, setMetaInfo] = useState(modelMetaInfo);
  const [metaRefreshing, setMetaRefreshing] = useState(false);

  // 能力数据过期则进入设置页时静默刷新（离线/失败不影响使用，回退启发式）
  useEffect(() => {
    if (!isModelMetaStale()) return;
    let cancelled = false;
    refreshModelMeta()
      .then(() => {
        if (!cancelled) setMetaInfo(modelMetaInfo());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** 手动刷新：更新缓存并把当前文本模型的上下文窗口回填为最新元数据（仍可手改） */
  const handleRefreshMeta = async () => {
    setMetaRefreshing(true);
    try {
      const { count } = await refreshModelMeta();
      setMetaInfo(modelMetaInfo());
      const meta = getModelMeta(settings.llmModel);
      if (meta) settings.update({ contextWindow: meta.context });
      toast.success(`已更新 ${count} 个模型的能力数据`);
    } catch (e) {
      toast.error(`刷新失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMetaRefreshing(false);
    }
  };

  /** error-state-shake：红边 + 消息由 keyError 驱动，hold 后自动回退；输入即取消 */
  const triggerKeyError = () => {
    setKeyError(true);
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    const shakeMs = ms('--shake-dur-a', 80) * 2 + ms('--shake-dur-b', 60) * 2;
    revertTimerRef.current = window.setTimeout(() => {
      revertTimerRef.current = undefined;
      setKeyError(false);
    }, shakeMs + ms('--revert-hold', 3000));
  };

  // React 提交 className 后再挂 .is-shaking（否则会被重渲染的 className 覆盖），
  // remove → reflow → re-add 保证重复触发时抖动可重放
  useEffect(() => {
    if (!keyError) return;
    const input = keyInputRef.current;
    if (!input) return;
    input.classList.remove('is-shaking');
    void input.offsetWidth; // force reflow
    input.classList.add('is-shaking');
    const shakeMs = ms('--shake-dur-a', 80) * 2 + ms('--shake-dur-b', 60) * 2;
    const t = window.setTimeout(() => input.classList.remove('is-shaking'), shakeMs + 20);
    return () => clearTimeout(t);
  }, [keyError]);

  const clearKeyError = () => {
    if (revertTimerRef.current) {
      clearTimeout(revertTimerRef.current);
      revertTimerRef.current = undefined;
    }
    setKeyError(false);
  };

  const handleCheck = async () => {
    if (!settings.apiKey) {
      triggerKeyError();
      return;
    }
    setChecking(true);
    try {
      const ids = await listModels({ apiKey: settings.apiKey, baseUrl: settings.baseUrl });
      setModelOptions(ids);
      const result: Record<string, boolean> = {
        asrModel: ids.includes(settings.asrModel),
        llmModel: ids.includes(settings.llmModel),
        embedModel: ids.includes(settings.embedModel),
        visionModel: ids.includes(settings.visionModel),
      };
      setCheckResult(result);
      const missing = Object.entries(result).filter(([, ok]) => !ok);
      if (missing.length === 0) {
        toast.success('所有模型均可用');
      } else {
        toast.warning(`有 ${missing.length} 个模型未上架，请从下拉列表选择替代模型`);
      }
    } catch (e) {
      toast.error(`检查失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChecking(false);
    }
  };

  /** embedModel 提交点：草稿与已提交值不同才弹确认；确认窗打开会夺走焦点触发 blur，用 ref 抑制重复弹窗 */
  const commitEmbedModel = (draft: string) => {
    if (draft === settings.embedModel || embedConfirmRef.current) return;
    embedConfirmRef.current = true;
    void confirmDialog({
      headline: '更换向量模型需要重建问答索引',
      description: '将清除所有视频已建立的向量索引，下次提问时自动重建。确定更换？',
      confirmText: '更换',
    }).then(async (ok) => {
      try {
        if (ok) {
          await db.embeddings.clear();
          settings.update({ embedModel: draft });
        } else {
          setEmbedDraft(settings.embedModel);
        }
      } finally {
        embedConfirmRef.current = false;
      }
    });
  };

  /** 播放器倍速：内置档位之外再补几个常用档（0.25–4，存 settings.customRates） */
  const addCustomRate = () => {
    if (rateDraft == null || !Number.isFinite(rateDraft)) return;
    const next = normalizeRate(rateDraft);
    if ([...PRESET_RATES, ...settings.customRates].some((r) => sameRate(r, next))) {
      toast.info(`${formatRate(next)} 已经在档位里了`);
    } else {
      settings.update({ customRates: [...settings.customRates, next].sort((a, b) => a - b) });
    }
    setRateDraft(null);
  };

  const removeCustomRate = (r: number) => {
    settings.update({ customRates: settings.customRates.filter((x) => !sameRate(x, r)) });
  };

  /** 各槽位的模型值读写：embed 走草稿，其余直接落库 */
  const modelValue = (name: ModelFieldName) => (name === 'embedModel' ? embedDraft : settings[name]);
  const setModelValue = (name: ModelFieldName, v: string) => {
    if (name === 'embedModel') {
      setEmbedDraft(v);
    } else if (name === 'llmModel') {
      // 切文本模型时按内置表回填上下文窗口默认值（仍可手改）
      settings.update({ llmModel: v, contextWindow: guessContextWindow(v) });
    } else {
      settings.update({ [name]: v });
    }
  };
  const pickModel = (name: ModelFieldName, v: string) => {
    if (name === 'embedModel') commitEmbedModel(v);
    else setModelValue(name, v);
  };

  const modelField = (name: ModelFieldName, label: string) => (
    <ModelField
      key={name}
      label={label}
      value={modelValue(name)}
      options={modelOptions}
      checkState={checkResult ? checkResult[name] : undefined}
      onValueChange={(v) => setModelValue(name, v)}
      onPick={(v) => pickModel(name, v)}
      testId={`model-${name}`}
    />
  );

  const favKeywordRef = useMduiEvent('mdui-text-field', 'input', (_e, el) =>
    setFavSearch((s) => ({ ...s, [favTab]: el.value })),
  );
  const tabsRef = useMduiEvent('mdui-tabs', 'change', (_e, el) =>
    setFavTab(el.value as ModelSlot),
  );
  const concurrencyRef = useMduiEvent('mdui-slider', 'change', (_e, el) =>
    settings.update({ asrConcurrency: el.value || 4 }),
  );
  const roundsRef = useMduiEvent('mdui-segmented-button-group', 'change', (_e, el) =>
    settings.update({ agentRounds: Number(el.value) || 12 }),
  );
  const themeRef = useMduiEvent('mdui-segmented-button-group', 'change', (_e, el) =>
    settings.update({ theme: el.value as AppTheme }),
  );
  const dynamicColorRef = useMduiEvent('mdui-switch', 'change', (_e, el) =>
    settings.update({ dynamicColor: el.checked }),
  );
  const rateDraftRef = useMduiEvent('mdui-text-field', 'input', (_e, el) => {
    const n = Number(el.value);
    setRateDraft(el.value.trim() === '' || !Number.isFinite(n) ? null : n);
  });

  /** 收藏夹单个 tab：搜索筛选 + 相关模型置顶的勾选列表 */
  const favTabContent = (slot: ModelSlot) => {
    const kw = favSearch[slot].trim().toLowerCase();
    const relevant = SLOT_RELEVANT[slot];
    const list = modelOptions
      .filter((id) => !kw || id.toLowerCase().includes(kw))
      .sort((a, b) => Number(relevant(b)) - Number(relevant(a)));
    const selected = settings.favorites[slot];
    return (
      <>
        <mdui-text-field
          ref={favKeywordRef}
          data-testid="fav-filter"
          placeholder="筛选模型"
          clearable
          value={favSearch[slot]}
        />
        <div className="fav-list" data-testid="fav-list">
          {list.map((id) => (
            <FavRow
              key={id}
              id={id}
              checked={selected.includes(id)}
              onToggle={(next) =>
                settings.update({
                  favorites: {
                    ...settings.favorites,
                    [slot]: next ? [...selected, id] : selected.filter((x) => x !== id),
                  },
                })
              }
            />
          ))}
        </div>
      </>
    );
  };

  const metaHint = (
    <div className="row row--between">
      <span>
        {metaInfo
          ? `能力数据源：models.dev（${metaInfo.count} 个模型，${new Date(metaInfo.updatedAt).toLocaleDateString()} 更新）`
          : '能力数据未拉取，暂用内置启发式兜底'}
        ；切换文本模型自动填入，可手改
      </span>
      <mdui-button
        variant="text"
        loading={metaRefreshing}
        data-testid="btn-refresh-meta"
        onClick={() => void handleRefreshMeta()}
      >
        刷新能力数据
      </mdui-button>
    </div>
  );

  return (
    <PageShell title="设置" onBack={() => navigate('/')} narrow rail={nav.rail} bottomNav={nav.bottom}>
      <SectionCard title="硅基流动 API" testId="card-api">
        <Field
          label="API Key"
          hint="仅保存在本机浏览器 localStorage 中"
          className={keyError ? 't-input-wrap is-error' : 't-input-wrap'}
          testId="field-api-key"
        >
          <div ref={keyInputRef} className={keyError ? 't-input is-error' : 't-input'}>
            <mdui-text-field
              data-testid="api-key"
              type="password"
              toggle-password
              clearable
              placeholder="sk-..."
              value={settings.apiKey}
              onInput={(e) => {
                clearKeyError();
                settings.update({ apiKey: (e.target as HTMLElement & { value: string }).value.trim() });
              }}
            />
          </div>
          <p className="t-error-msg" data-testid="key-error">
            请先填写 API Key
          </p>
        </Field>
        <Field label="API 地址" testId="field-base-url">
          <mdui-text-field
            data-testid="base-url"
            value={settings.baseUrl}
            clearable
            onInput={(e) =>
              settings.update({ baseUrl: (e.target as HTMLElement & { value: string }).value.trim() })
            }
          />
        </Field>
        <Field
          label={`字幕转写并发（当前 ${settings.asrConcurrency}）`}
          hint="初始并发数（1-12）；转写中遇限流自动减半，稳定后缓慢提升"
          testId="field-asr-concurrency"
        >
          <mdui-slider
            ref={concurrencyRef}
            data-testid="asr-concurrency"
            min={1}
            max={12}
            step={1}
            value={settings.asrConcurrency}
          />
        </Field>
      </SectionCard>

      <SectionCard
        title="模型配置"
        testId="card-models"
        actions={
          <mdui-button
            variant="filled"
            loading={checking}
            data-testid="btn-check-models"
            onClick={() => void handleCheck()}
          >
            检查模型可用性
          </mdui-button>
        }
      >
        {modelField('asrModel', '语音识别（ASR）')}
        {modelField('llmModel', '文本生成（讲义 / 问答）')}
        {modelField('embedModel', '向量（Embedding）')}
        {modelField('visionModel', '视觉（截图理解）')}
        <Field label="上下文窗口（tokens）" hint={metaHint} testId="field-context-window">
          <mdui-text-field
            data-testid="context-window"
            type="number"
            min={8192}
            step={1024}
            value={String(settings.contextWindow)}
            onInput={(e) => {
              const n = Number((e.target as HTMLElement & { value: string }).value);
              settings.update({ contextWindow: n || 131072 });
            }}
          />
        </Field>
        <Field
          label="问答检索轮次上限"
          hint="每轮检索都会重发已检索内容：轮次越多材料越全，但更慢、更费 token；大窗口模型下 12~20 轮安全。达到上限后会强制收尾作答，不会没有回答"
          testId="field-agent-rounds"
        >
          <mdui-segmented-button-group
            ref={roundsRef}
            data-testid="agent-rounds"
            selects="single"
            value={String(settings.agentRounds)}
          >
            {[3, 6, 12, 20].map((n) => (
              <mdui-segmented-button key={n} value={String(n)}>
                {n}
              </mdui-segmented-button>
            ))}
          </mdui-segmented-button-group>
        </Field>
      </SectionCard>

      <SectionCard title="模型收藏夹" testId="card-favorites">
        {modelOptions.length === 0 ? (
          <div className="text-secondary">先点击上方「检查模型可用性」拉取模型列表</div>
        ) : (
          <mdui-tabs ref={tabsRef} data-testid="fav-tabs" value={favTab}>
            {SLOT_TABS.map(({ key, label }) => (
              <mdui-tab key={key} value={key} data-testid={`fav-tab-${key}`}>
                {label}
              </mdui-tab>
            ))}
            {SLOT_TABS.map(({ key }) => (
              <mdui-tab-panel key={key} slot="panel" value={key} data-testid={`fav-panel-${key}`}>
                {favTabContent(key)}
              </mdui-tab-panel>
            ))}
          </mdui-tabs>
        )}
      </SectionCard>

      <SectionCard
        title="外观"
        subtitle="深浅两套色板都来自 MD3 设计令牌，「跟随系统」会随系统的深浅色实时切换"
        testId="card-appearance"
      >
        <Field label="主题" testId="field-theme">
          <mdui-segmented-button-group
            ref={themeRef}
            data-testid="theme-select"
            selects="single"
            value={settings.theme}
          >
            <mdui-segmented-button value="auto">跟随系统</mdui-segmented-button>
            <mdui-segmented-button value="light">浅色</mdui-segmented-button>
            <mdui-segmented-button value="dark">深色</mdui-segmented-button>
          </mdui-segmented-button-group>
        </Field>
        <Field
          label="动态取色"
          hint="Material You 的动态配色：从课程封面（抽帧里的幻灯片帧）提取主色，让播放页的配色随课程变化。取不到封面时自动用默认配色"
          testId="field-dynamic-color"
        >
          <mdui-switch
            ref={dynamicColorRef}
            data-testid="dynamic-color"
            checked={settings.dynamicColor}
          />
        </Field>
      </SectionCard>

      <SectionCard title="哔哩哔哩导入" testId="card-bilibili">
        <Field
          label="代理地址"
          hint="自建 Cloudflare Worker 地址，用于绕过 B 站 CORS 与防盗链。留空则无法导入 B 站视频"
          testId="field-bili-proxy"
        >
          <mdui-text-field
            data-testid="bili-proxy"
            value={settings.bilibiliProxy}
            clearable
            placeholder="https://bili-proxy.yourname.workers.dev"
            onInput={(e) =>
              settings.update({
                bilibiliProxy: (e.target as HTMLElement & { value: string }).value.trim(),
              })
            }
          />
        </Field>
        <Field
          label="B 站 Cookie（可选）"
          hint="粘贴自己账号的 Cookie 可解锁更高清晰度；不上传任何服务器，仅存本机 localStorage"
          testId="field-bili-cookie"
        >
          <mdui-text-field
            data-testid="bili-cookie"
            type="password"
            toggle-password
            clearable
            placeholder="SESSDATA=...; bili_jct=..."
            value={settings.bilibiliCookie}
            onInput={(e) =>
              settings.update({
                bilibiliCookie: (e.target as HTMLElement & { value: string }).value.trim(),
              })
            }
          />
        </Field>
      </SectionCard>

      <SectionCard
        title="播放"
        testId="card-rates"
        subtitle={`播放器控制栏除内置的 ${PRESET_RATES.map(formatRate).join(' / ')} 外，还会平铺这里添加的档位（${MIN_RATE}–${MAX_RATE}），可逐条删除`}
      >
        <Field label="自定义倍速" testId="field-custom-rates">
          <div className="stack">
            <div className="row" data-testid="rate-chips">
              {settings.customRates.length === 0 ? (
                <span className="text-secondary">暂未添加</span>
              ) : (
                settings.customRates.map((r) => (
                  <RateChip key={r} rate={r} onDelete={() => removeCustomRate(r)} />
                ))
              )}
            </div>
            <div className="row row--nowrap">
              <mdui-text-field
                ref={rateDraftRef}
                data-testid="rate-input"
                type="number"
                min={MIN_RATE}
                max={MAX_RATE}
                step={0.25}
                placeholder="1.25"
                style={{ flex: '0 1 140px' }}
              />
              <mdui-button
                variant="tonal"
                data-testid="rate-add"
                disabled={rateDraft == null}
                onClick={addCustomRate}
              >
                添加
              </mdui-button>
            </div>
          </div>
        </Field>
      </SectionCard>

      <StorageCard />

      <MigrationCard />

      <SkillsCard />
    </PageShell>
  );
}
