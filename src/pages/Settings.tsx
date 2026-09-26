import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings, type AppTheme, type ModelSlot } from '../store/settings';
import { listModels } from '../api/siliconflow';
import { guessContextWindow, isVisionModel, supportsThinking } from '../api/modelCaps';
import { getModelMeta, isModelMetaStale, modelMetaInfo, refreshModelMeta } from '../api/modelMeta';
import { MAX_RATE, MIN_RATE, PRESET_RATES, formatRate, normalizeRate, sameRate } from '../utils/rate';
import { buildInfoLabel } from '../utils/buildInfo';
import { SuccessCheck, ms } from '../components/motion';
import SkillsCard from '../components/SkillsCard';
import StorageCard from '../components/StorageCard';
import StudyTimeCard from '../components/StudyTimeCard';
import MigrationCard from '../components/MigrationCard';
import { Field, PageShell, SectionCard, confirmDialog, toast, useMduiEvent } from '../ui';
import { useAppNav } from '../components/appNav';
import {
  getBiliBridgeVersion,
  isBiliBridgeAvailable,
  isBridgePostCapable,
  readBiliCookie,
} from '../bilibili/transport';
import { probeBiliLogin } from '../bilibili/api';

const ASR_MODEL_RE = /asr|whisper|sensevoice|xingchen/i;
/** 各收藏槽位的相关性启发式：相关模型在列表中置顶 */
const SLOT_RELEVANT: Record<ModelSlot, (id: string) => boolean> = {
  chat: (id) => supportsThinking(id) || isVisionModel(id),
  vision: isVisionModel,
  asr: (id) => ASR_MODEL_RE.test(id),
};

const SLOT_TABS: { key: ModelSlot; label: string }[] = [
  { key: 'chat', label: '文本' },
  { key: 'vision', label: '视觉' },
  { key: 'asr', label: 'ASR' },
];

type ModelFieldName = 'asrModel' | 'llmModel' | 'visionModel';

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
  });
  /** 自定义倍速的输入草稿（null = 输入框为空，「添加」按钮置灰） */
  const [rateDraft, setRateDraft] = useState<number | null>(null);
  const [bridgeTick, setBridgeTick] = useState(0);
  /** 读取本机 Cookie 的进行中标记 + 读到的结果说明 */
  const [cookieReading, setCookieReading] = useState(false);
  /** 上一次「读取本机 Cookie」的结果说明（失败时写清是哪一种失败） */
  const [cookieNote, setCookieNote] = useState('');
  /** 说明是「问题」（红）还是「只是没法读明细，不影响用」（灰） */
  const [cookieNoteLevel, setCookieNoteLevel] = useState<'info' | 'warn'>('info');
  /** 「备用出口」的展开态：null = 跟着主路径（没桥就展开，有桥就收起） */
  const [advOverride, setAdvOverride] = useState<boolean | null>(null);
  /** 油猴桥视角的登录态（进设置页探测一次；null = 探不到） */
  const [biliLogin, setBiliLogin] = useState<{ isLogin: boolean; uname?: string } | null>(null);

  const bridgeOk = isBiliBridgeAvailable();
  const advOpen = advOverride ?? !bridgeOk;

  /**
   * 「读取本机 Cookie」：经油猴桥的 GM_cookie 读 .bilibili.com 全量 Cookie 并填入。
   * 失败的四种情况分开提示（否则「没读到」这一句话会把「脚本太旧」和「没登录」混在一起，无法对症）。
   */
  const readCookieFromBrowser = async () => {
    setCookieReading(true);
    try {
      const result = await readBiliCookie();
      if (result.status !== 'ok') {
        if (result.status === 'empty') {
          // 「读到 0 项」有两种截然不同的含义，靠桥出口自己问一次登录态来分辨（桥的请求会带上浏览器 Cookie）：
          //   已登录 → 只是扩展不给 GM_cookie 明细，不影响任何功能，别吓唬用户；
          //   未登录 → 那确实该先去登录。
          const login = await probeBiliLogin({ proxy: settings.bilibiliProxy, cookie: settings.bilibiliCookie });
          setBiliLogin(login);
          const note = login?.isLogin
            ? `读到 0 项 Cookie，但油猴桥出口已登录${login.uname ? `（${login.uname}）` : ''}：说明扩展没提供 GM_cookie 明细。这不影响导入 —— 桥的请求本来就会带上浏览器自己的 Cookie，这个输入框留空即可`
            : '能读 Cookie，但本机没有 bilibili.com 的：先在浏览器里登录 B 站（无痕窗口、容器标签页读不到）';
          setCookieNoteLevel(login?.isLogin ? 'info' : 'warn');
          setCookieNote(note);
          if (login?.isLogin) toast.info(note);
          else toast.warning(note);
          return;
        }
        const note =
          result.status === 'no-bridge'
            ? '没检测到油猴桥：先点上面的「安装脚本」装好脚本（装完刷新本页），再点这个按钮'
            : result.status === 'old-bridge'
              ? `当前脚本是 ${result.version} 版，没有读 Cookie 的能力：浏览器里的脚本副本不会自动更新，请在左侧重新安装一次`
              : '脚本读不到 Cookie（浏览器/扩展不支持或未授权 GM_cookie：Safari 的 Userscripts 属于这种）。手动粘贴即可，或者直接留空 —— 装了油猴桥时请求会自动带上浏览器自己的 Cookie';
        setCookieNoteLevel('warn');
        setCookieNote(note);
        toast.warning(note);
        return;
      }
      settings.update({ bilibiliCookie: result.cookie });
      const hasSess = /(^|;\s*)SESSDATA=/.test(result.cookie);
      const note = hasSess
        ? `已读取 ${result.cookie.split(';').length} 项 Cookie（含 SESSDATA）`
        : '已读取本机 Cookie，但没发现 SESSDATA（可能未登录 B 站）';
      setCookieNoteLevel(hasSess ? 'info' : 'warn');
      setCookieNote(note);
      toast.success(note);
      const state = await probeBiliLogin({ proxy: settings.bilibiliProxy, cookie: result.cookie });
      setBiliLogin(state);
    } finally {
      setCookieReading(false);
    }
  };

  const [keyError, setKeyError] = useState(false);
  const keyInputRef = useRef<HTMLDivElement>(null);
  const revertTimerRef = useRef<number | undefined>(undefined);
  const [metaInfo, setMetaInfo] = useState(modelMetaInfo);
  const [metaRefreshing, setMetaRefreshing] = useState(false);

  // 装/卸脚本后「备用出口」回到自动态（有桥就收起）
  useEffect(() => {
    setAdvOverride(null);
  }, [bridgeTick]);

  // 进入设置页（或安装脚本后 tick 变化）探测一次 B 站登录态：只做展示，失败静默。
  // 依赖只跟 bridgeTick 走 —— 带 cookie 进依赖会在输框里每敲一个字发一次请求。
  const biliProbeRef = useRef({ proxy: '', cookie: '' });
  biliProbeRef.current = { proxy: settings.bilibiliProxy, cookie: settings.bilibiliCookie };
  useEffect(() => {
    if (!bridgeOk) {
      setBiliLogin(null);
      return;
    }
    let alive = true;
    void probeBiliLogin(biliProbeRef.current).then((r) => {
      if (alive) setBiliLogin(r);
    });
    return () => {
      alive = false;
    };
  }, [bridgeTick]);

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

  useEffect(() => {
    const t = window.setInterval(() => setBridgeTick((n) => n + 1), 1500);
    return () => window.clearInterval(t);
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

  /** 各槽位的模型值读写 */
  const modelValue = (name: ModelFieldName) => settings[name];
  const setModelValue = (name: ModelFieldName, v: string) => {
    if (name === 'llmModel') {
      // 切文本模型时按内置表回填上下文窗口默认值（仍可手改）
      settings.update({ llmModel: v, contextWindow: guessContextWindow(v) });
    } else {
      settings.update({ [name]: v });
    }
  };

  const modelField = (name: ModelFieldName, label: string) => (
    <ModelField
      key={name}
      label={label}
      value={modelValue(name)}
      options={modelOptions}
      checkState={checkResult ? checkResult[name] : undefined}
      onValueChange={(v) => setModelValue(name, v)}
      onPick={(v) => setModelValue(name, v)}
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
  const htmlRemoteRef = useMduiEvent('mdui-switch', 'change', (_e, el) =>
    settings.update({ htmlRemoteAssets: el.checked }),
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
    <PageShell
      title="设置"
      onBack={() => navigate('/')}
      narrow
      rootClassName="page-settings"
      rail={nav.rail}
      bottomNav={nav.bottom}
    >
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
          className="field--stack"
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

      <SectionCard
        title="阅读材料"
        subtitle="只影响 HTML 材料；PDF / Word / Markdown 的材料都在文件里，不涉及联网"
        testId="card-material"
      >
        <Field
          label="HTML 联网加载外部资源"
          hint="按原文档的样子渲染 HTML 时，它引用的远程图片 / 样式表 / 字体会被加载。关掉后完全离线：只放行文档内嵌的资源，外部引用一律跳过并在阅读器顶部说明。两种情况下脚本都不会执行"
          testId="field-html-remote"
        >
          <mdui-switch
            ref={htmlRemoteRef}
            data-testid="html-remote-assets"
            checked={settings.htmlRemoteAssets}
          />
        </Field>
      </SectionCard>

      <SectionCard title="哔哩哔哩导入" testId="card-bilibili">
        {/* 常驻只有这一行：主路径（油猴桥）状态 + 登录态。备用出口收进下面的折叠项 ——
            装了桥还能正常登录时，代理地址与 Cookie 都是纯噪音（请求自带浏览器 Cookie）。 */}
        <Field
          label="油猴桥（推荐）"
          hint={bridgeOk ? undefined : '装一次脚本，之后导入全部从本机直连 B 站，不经过任何中转'}
          testId="field-bili-bridge"
        >
          <div className="row row--nowrap" data-bridge-tick={bridgeTick} data-testid="bili-bridge-status">
            <span className="text-secondary" style={{ flex: 1 }}>
              {!bridgeOk ? (
                '未检测到油猴脚本'
              ) : (
                <>
                  已连接 v{getBiliBridgeVersion()}
                  {isBridgePostCapable() ? '' : '（版本过旧，读不到自带字幕）'} ·{' '}
                  <span data-testid="bili-login-state">
                    {biliLogin == null
                      ? '登录态未确认'
                      : biliLogin.isLogin
                        ? `已登录${biliLogin.uname ? `：${biliLogin.uname}` : ''}`
                        : '未登录（B 站只给低清晰度）'}
                  </span>
                </>
              )}
            </span>
            <mdui-button
              variant={bridgeOk ? 'text' : 'tonal'}
              data-testid="bili-bridge-install"
              onClick={() => window.open('/wangke-bili-bridge.user.js', '_blank')}
            >
              {bridgeOk ? '重装脚本' : '安装脚本'}
            </mdui-button>
          </div>
        </Field>

        {/* 备用出口：收起时整块不渲染（不是 CSS 隐藏）—— 免得一屏文字都在说「不用填」，也避免键盘 Tab 进隐藏输入框 */}
        <button
          type="button"
          data-testid="bili-adv-toggle"
          aria-expanded={advOpen}
          onClick={() => setAdvOverride(!advOpen)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            padding: '12px 0 0',
            background: 'none',
            border: 'none',
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span className="text-secondary" style={{ flex: 1, fontSize: 14 }}>
            备用出口：代理地址 / B 站 Cookie
          </span>
          {advOpen ? <mdui-sym-keyboard-arrow-down /> : <mdui-sym-chevron-right />}
        </button>
        {advOpen && (
          <div data-testid="bili-adv">
            <div className="text-secondary" style={{ fontSize: 12, margin: '10px 0 12px' }}>
              只有油猴桥不可用、或要改用代理时才需要填。装了桥时请求会自动带上浏览器自己的 Cookie，
              「B 站 Cookie」可以留空。
            </div>
            <Field
              label="代理地址"
              hint="Cloudflare Worker 的出口 IP 常被 B 站拒绝，优先级低于油猴桥"
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
            <Field label="B 站 Cookie" hint="仅存本机 localStorage，用于代理回退路径" testId="field-bili-cookie">
              <div className="row row--nowrap">
                <mdui-text-field
                  data-testid="bili-cookie"
                  type="password"
                  toggle-password
                  clearable
                  placeholder="SESSDATA=...; bili_jct=..."
                  value={settings.bilibiliCookie}
                  style={{ flex: 1, minWidth: 0 }}
                  onInput={(e) =>
                    settings.update({
                      bilibiliCookie: (e.target as HTMLElement & { value: string }).value.trim(),
                    })
                  }
                />
                <mdui-button
                  variant="tonal"
                  data-testid="bili-cookie-read"
                  loading={cookieReading}
                  onClick={() => void readCookieFromBrowser()}
                >
                  读取本机 Cookie
                </mdui-button>
              </div>
              {cookieNote && (
                <div
                  className="text-secondary"
                  style={{
                    fontSize: 12,
                    marginTop: 6,
                    color: cookieNoteLevel === 'warn' ? 'rgb(var(--mdui-color-error))' : undefined,
                  }}
                  data-testid="bili-cookie-note"
                >
                  {cookieNote}
                </div>
              )}
            </Field>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="播放"
        testId="card-rates"
        subtitle={`播放器控制栏除内置的 ${PRESET_RATES.map(formatRate).join(' / ')} 外，还会平铺这里添加的档位（${MIN_RATE}–${MAX_RATE}），可逐条删除`}
      >
        <Field label="自定义倍速" className="field--stack" testId="field-custom-rates">
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

      <StudyTimeCard />

      <StorageCard />

      <MigrationCard />

      <SkillsCard />

      {/* 页脚：构建信息。用途是排障，不是装饰 —— PWA 的 autoUpdate 会在后台更新 SW
          但不刷新当前页面，iPad 上「改了怎么还是老的」时，靠这一行判断当前跑的是哪个构建
          （时间戳单独一个没有参照物，所以带上 commit 短哈希）。详见
          docs/plans/2026-09-18-build-info-design.md */}
      <div
        className="text-secondary"
        style={{ fontSize: 12, textAlign: 'center', margin: '4px 0 8px' }}
        data-testid="build-info"
      >
        {buildInfoLabel(__BUILD_INFO__, import.meta.env.DEV)}
      </div>
    </PageShell>
  );
}
