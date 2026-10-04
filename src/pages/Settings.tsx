import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  SLOT_LABEL,
  catalogOf,
  nextProviderId,
  providersForSlot,
  sameRef,
  useSettings,
  type AppTheme,
  type ModelSlot,
  type Provider,
  type Settings,
} from '../store/settings';
import { listModels } from '../api/siliconflow';
import { guessContextWindow, isVisionModel, supportsThinking } from '../api/modelCaps';
import { UNLIMITED_ROUNDS } from '../harness/loopGuard';
import { getModelMeta, isModelMetaStale, modelMetaInfo, refreshModelMeta } from '../api/modelMeta';
import { MAX_RATE, MIN_RATE, PRESET_RATES, formatRate, normalizeRate, sameRate } from '../utils/rate';
import { buildInfoLabel } from '../utils/buildInfo';
import { SuccessCheck, ms, IconSwap } from '../components/motion';
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
/**
 * 各收藏槽位的相关性启发式：相关模型在列表中置顶。**只影响排序**，不决定谁能进这个槽位。
 *
 * 带 catalogId 是因为能力判断必须按供应商查（同一模型 id 在别家可能不支持视觉/思考）。
 */
const SLOT_RELEVANT: Record<ModelSlot, (catalogId: string, id: string) => boolean> = {
  chat: (cat, id) => supportsThinking(cat, id) || isVisionModel(cat, id),
  vision: (cat, id) => isVisionModel(cat, id),
  // ASR 只能靠名字猜 —— models.dev 的 modalities.input 里有 'audio'，但那含 TTS，
  // 而 /audio/transcriptions 只认 ASR 模型，两者在数据上区分不开。这里仍按名字排，
  // 但真正的准入靠供应商的 serves 勾选（见 ProviderCard）。
  asr: (_cat, id) => ASR_MODEL_RE.test(id),
};

const SLOT_TABS: { key: ModelSlot; label: string }[] = [
  { key: 'chat', label: '文本' },
  { key: 'vision', label: '视觉' },
  { key: 'asr', label: 'ASR' },
];

type ModelFieldName = 'asrModel' | 'llmModel' | 'visionModel';

/** 收藏夹一项在 UI 里的唯一键（供应商 + 模型） */
const refKey = (r: { providerId: string; model: string }) => `${r.providerId}\0${r.model}`;

/** 槽位全集：勾选能力、下拉候选、遍历都用它，避免三处各写一份字面量而漏一项 */
const ALL_SLOTS: readonly ModelSlot[] = ['asr', 'chat', 'vision'];

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
  catalogId,
  checkState,
  onValueChange,
  onPick,
  testId,
}: {
  label: string;
  value: string;
  options: string[];
  /** 能力判断的数据源（供应商在 models.dev 的 key） */
  catalogId: string;
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

  const relevant = SLOT_RELEVANT.asr;
  const list = options
    .filter((id) => !kw.trim() || id.toLowerCase().includes(kw.trim().toLowerCase()))
    .sort((a, b) => Number(relevant(catalogId, b)) - Number(relevant(catalogId, a)));

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
      <div>
        <div className="row row--nowrap">
          <mdui-text-field
            ref={fieldRef}
            data-testid={testId}
            aria-label={label}
            value={value}
            clearable
            style={{ flex: '1 1 auto', minWidth: 0 }}
          />
          {options.length > 0 && (
            <mdui-button
              variant="text"
              data-testid={`${testId}-pick`}
              aria-expanded={open}
              aria-controls={`${testId}-options`}
              onClick={() => setOpen((o) => !o)}
            >
              选择
            </mdui-button>
          )}
        </div>
        {open && options.length > 0 && (
          <div className="model-picker" id={`${testId}-options`}>
            <mdui-text-field
              ref={filterRef}
              data-testid={`${testId}-filter`}
              aria-label={`筛选${label}模型`}
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
      </div>
    </Field>
  );
}

/**
 * 收藏夹里的一个勾选项：需要独立 hook，所以拆成子组件。
 *
 * 一行 = 一个「供应商 + 模型」组合，所以**供应商名必须印出来**：`Qwen/Qwen3` 在两家
 * 都可能存在，只显示模型 id 的勾选框没法分辨自己收藏的是哪一家的。
 */
function FavRow({
  slot,
  model,
  providerName,
  catalogId,
  checked,
  onToggle,
}: {
  slot: ModelSlot;
  model: string;
  providerName: string;
  catalogId: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  const ref = useMduiEvent('mdui-checkbox', 'change', (_e, el) => onToggle(el.checked));
  return (
    <mdui-checkbox
      ref={ref}
      checked={checked}
      // ⚠️ testid 必须带槽位：mdui-tabs 会把所有面板都留在 DOM 里（只切显隐），
      // 同一个模型于是会在三个页签下各渲染一行 —— 不带 slot 的话选择器会命中 3 个元素。
      data-testid={`fav-${slot}-${providerName}-${model}`}
      style={{ display: 'flex' }}
    >
      <span className="fav-label">
        <span className="fav-label__provider">{providerName}</span>
        <span className="fav-label__id">{model}</span>
        {isVisionModel(catalogId, model) && <span className="tag-mini">多模态</span>}
        {supportsThinking(catalogId, model) && <span className="tag-mini">可思考</span>}
      </span>
    </mdui-checkbox>
  );
}

/**
 * 一个槽位的完整配置行：供应商下拉 + 模型输入。
 *
 * 供应商下拉**只列 `serves` 含该槽位的那几家** —— 这是「手动标能力」的实际用途：
 * 标了不提供 ASR 的供应商就不会出现在 ASR 槽位里，从源头上排掉「拿文本接口当 ASR 用」。
 * 当前指的那家没标这个能力时仍列出来（否则用户改不回去），但旁边标红说明。
 *
 * 拆成独立组件而不是内联进 Settings：`useMduiEvent` 是 hook，内联进 map 会在
 * 供应商数量变化时打乱调用顺序。
 */
function SlotField({
  name,
  slot,
  label,
  settings,
  options,
  checkState,
  onProvider,
}: {
  name: ModelFieldName;
  slot: ModelSlot;
  label: string;
  settings: Settings;
  options: string[];
  checkState: boolean | undefined;
  onProvider: (name: ModelFieldName, providerId: string) => void;
}) {
  const ref = settings[name];
  const candidates = providersForSlot(settings, slot);
  const missingCap = !candidates.some((p) => p.id === ref.providerId);
  const update = useSettings((s) => s.update);
  const selectRef = useMduiEvent('mdui-select', 'change', (_e, el) =>
    onProvider(name, String(el.value)),
  );
  return (
    <div className="slot-field">
      {/* 选项用 mdui-menu-item 而不是 mdui-select-item：mdui 的 select 只认 menu-item，
          项目里其他几处下拉（会话选择等）也都是这么写的 */}
      <mdui-select
        ref={selectRef}
        data-testid={`provider-${name}`}
        aria-label={`${label}使用的供应商`}
        value={ref.providerId}
      >
        {candidates.map((p) => (
          <mdui-menu-item key={p.id} value={p.id}>
            {p.name}
          </mdui-menu-item>
        ))}
      </mdui-select>
      <ModelField
        label={label}
        value={ref.model}
        options={options}
        catalogId={catalogOf(settings, ref.providerId)}
        checkState={checkState}
        onValueChange={(v) => update({ [name]: { ...ref, model: v } })}
        onPick={(v) => update({ [name]: { ...ref, model: v } })}
        testId={`model-${name}`}
      />
      {missingCap && (
        <div
          className="text-secondary"
          style={{ fontSize: 12, color: 'rgb(var(--mdui-color-error))' }}
          data-testid={`provider-${name}-nocap`}
        >
          当前供应商「{settings.providers.find((p) => p.id === ref.providerId)?.name ?? ref.providerId}
          」没有勾选「{SLOT_LABEL[slot]}」能力，可能不支持这个槽位
        </div>
      )}
    </div>
  );
}

/**
 * 一家供应商的配置块：名称 / 地址 / Key / 能力勾选 / 能力数据源。
 *
 * 拆成组件是因为每家都要独立的 mdui 事件钩子（key 抖动、checkbox change），
 * 内联渲染的话这些 hook 排在同一个组件里，供应商增删就会打乱调用顺序。
 */
function ProviderCard({
  provider,
  others,
  note,
  onChange,
  onRemove,
  removable,
  shaking,
}: {
  provider: Provider;
  /** 除了自己以外的供应商（重名校验用） */
  others: readonly Provider[];
  /** 上次「检查模型可用性」的结论 */
  note?: string;
  onChange: (patch: Partial<Provider>) => void;
  onRemove: () => void;
  removable: boolean;
  shaking: boolean;
}) {
  const inputRef = useRef<HTMLDivElement>(null);
  const [dupName, setDupName] = useState(false);

  // 与其他家重名时提示：模型选型都按供应商名显示，重名会让设置页与面板都对不上是哪一家
  useEffect(() => {
    setDupName(others.some((p) => p.name.trim() === provider.name.trim()));
  }, [provider.name, others]);

  // key 缺失时的抖动。className 由父组件驱动（挂/摘 .is-shaking），
  // remove → reflow → re-add 让重复触发时可以重放
  useEffect(() => {
    if (!shaking) return;
    const el = inputRef.current;
    if (!el) return;
    el.classList.remove('is-shaking');
    void el.offsetWidth;
    el.classList.add('is-shaking');
    const shakeMs = ms('--shake-dur-a', 80) * 2 + ms('--shake-dur-b', 60) * 2;
    const t = window.setTimeout(() => el.classList.remove('is-shaking'), shakeMs + 20);
    return () => clearTimeout(t);
  }, [shaking]);

  return (
    <div className="provider-card" data-testid={`provider-card-${provider.id}`}>
      <div className="row row--between">
        <mdui-text-field
          value={provider.name}
          data-testid={`provider-name-${provider.id}`}
          aria-label="供应商名称"
          placeholder="供应商名称"
          value-error={dupName ? '与另一家同名' : undefined}
          onInput={(e) => onChange({ name: (e.target as HTMLElement & { value: string }).value })}
          style={{ flex: '1 1 auto', minWidth: 0 }}
        />
        {removable && (
          <mdui-button
            variant="text"
            data-testid={`provider-remove-${provider.id}`}
            onClick={onRemove}
            aria-label={`删除供应商 ${provider.name}`}
          >
            <mdui-sym-delete />
          </mdui-button>
        )}
      </div>
      <Field label="API 地址" testId={`field-base-url-${provider.id}`}>
        <mdui-text-field
          value={provider.baseUrl}
          data-testid={`base-url-${provider.id}`}
          aria-label="API 地址"
          placeholder="https://api.example.com/v1"
          clearable
          onInput={(e) =>
            onChange({ baseUrl: (e.target as HTMLElement & { value: string }).value.trim() })
          }
        />
      </Field>
      <Field
        label="API Key"
        hint="仅保存在本机浏览器 localStorage 中；云同步与迁移包都不含它"
        className={shaking ? 't-input-wrap is-error' : 't-input-wrap'}
        testId={`field-api-key-${provider.id}`}
      >
        <div>
          <div ref={inputRef} className={shaking ? 't-input is-error' : 't-input'}>
            <mdui-text-field
              data-testid={`api-key-${provider.id}`}
              aria-label={`${provider.name} 的 API Key`}
              aria-invalid={shaking}
              type="password"
              toggle-password
              clearable
              placeholder="sk-..."
              value={provider.apiKey}
              onInput={(e) =>
                onChange({ apiKey: (e.target as HTMLElement & { value: string }).value.trim() })
              }
            />
          </div>
          <p className="t-error-msg" data-testid={`key-error-${provider.id}`}>
            请先填写这家供应商的 API Key
          </p>
        </div>
      </Field>
      <Field
        label="能做的活"
        hint="手动勾选它实现了哪些接口。槽位的供应商下拉只列勾选了该槽位的那些家 —— 靠模型名猜不出来"
        className="field--stack"
        testId={`field-serves-${provider.id}`}
      >
        <div className="row" data-testid={`serves-${provider.id}`}>
          {ALL_SLOTS.map((slot) => (
            <mdui-checkbox
              key={slot}
              checked={provider.serves.includes(slot)}
              data-testid={`serves-${provider.id}-${slot}`}
              style={{ display: 'flex' }}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                const next = on
                  ? [...new Set([...provider.serves, slot])]
                  : provider.serves.filter((s) => s !== slot);
                onChange({ serves: next });
              }}
            >
              {SLOT_LABEL[slot]}
            </mdui-checkbox>
          ))}
        </div>
      </Field>
      <Field
        label="能力数据源"
        hint="models.dev 上的供应商 key（如 siliconflow-cn）。填了才能查到这个模型的上下文窗口 / 视觉 / 思考能力；留空则按模型名猜"
        testId={`field-catalog-${provider.id}`}
      >
        <mdui-text-field
          value={provider.catalogId}
          data-testid={`catalog-${provider.id}`}
          aria-label="models.dev 供应商 key"
          placeholder="siliconflow-cn"
          clearable
          onInput={(e) =>
            onChange({ catalogId: (e.target as HTMLElement & { value: string }).value.trim() })
          }
        />
      </Field>
      {note && (
        <div
          className="text-secondary"
          style={{ fontSize: 12, marginTop: 4 }}
          data-testid={`provider-note-${provider.id}`}
        >
          {note}
        </div>
      )}
    </div>
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
  /** 每家供应商各自拉到的在架模型（key = provider id）。分家存是因为各家列表互不相干。 */
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});
  /** 检查结果按「供应商+模型」记，而不是按槽位 —— 同一模型在两家都上架是常事 */
  const [checkResult, setCheckResult] = useState<Record<string, boolean> | null>(null);
  /** 上次检查的逐家结论（成功/失败），让用户看得见是哪一家出的问题 */
  const [providerNotes, setProviderNotes] = useState<Record<string, string>>({});
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

  /** 哪一家的 key 缺失（provider id）。null = 都没问题 */
  const [keyError, setKeyError] = useState<string | null>(null);
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

  /**
   * 要拉哪些供应商的能力数据：所有**填了 models.dev key** 的那几家。
   *
   * 只拉登记过的（`refreshModelMeta` 内部也只保留这几家）：models.dev 全库 226 家，
   * 整份缓存下来对 localStorage 纯浪费，而配额满了会静默让整份缓存写不进去。
   * 供应商增删后依赖要跟着变 —— 所以这里是 settings.providers 而不是挂载时取一次。
   */
  const catalogs = useMemo(
    () => settings.providers.map((p) => p.catalogId).filter((c) => c.trim().length > 0),
    [settings.providers],
  );
  const catalogsKey = catalogs.join('\0');

  // 能力数据过期则进入设置页时静默刷新（离线/失败不影响使用，回退启发式）
  useEffect(() => {
    if (catalogs.length === 0 || !isModelMetaStale()) return;
    let cancelled = false;
    refreshModelMeta(catalogs)
      .then(() => {
        if (!cancelled) setMetaInfo(modelMetaInfo());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [catalogsKey]);

  useEffect(() => {
    const t = window.setInterval(() => setBridgeTick((n) => n + 1), 1500);
    return () => window.clearInterval(t);
  }, []);

  /** 手动刷新：更新缓存并把当前文本模型的上下文窗口回填为最新元数据（仍可手改） */
  const handleRefreshMeta = async () => {
    if (catalogs.length === 0) {
      toast.warning('没有供应商填写 models.dev 供应商 key，无从拉取能力数据');
      return;
    }
    setMetaRefreshing(true);
    try {
      const { count } = await refreshModelMeta(catalogs);
      setMetaInfo(modelMetaInfo());
      const meta = getModelMeta(
        catalogOf(settings, settings.llmModel.providerId),
        settings.llmModel.model,
      );
      if (meta) settings.update({ contextWindow: meta.context });
      toast.success(`已更新 ${count} 个模型的能力数据`);
    } catch (e) {
      toast.error(`刷新失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMetaRefreshing(false);
    }
  };

  /** error-state-shake：红边 + 消息由 keyError 驱动，hold 后自动回退；输入即取消 */
  const triggerKeyError = (providerId: string) => {
    setKeyError(providerId);
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    const shakeMs = ms('--shake-dur-a', 80) * 2 + ms('--shake-dur-b', 60) * 2;
    revertTimerRef.current = window.setTimeout(() => {
      revertTimerRef.current = undefined;
      setKeyError(null);
    }, shakeMs + ms('--revert-hold', 3000));
  };

  // React 提交 className 后再挂 .is-shaking（否则会被重渲染的 className 覆盖），
  // remove → reflow → re-add 保证重复触发时抖动可重放。
  // 依赖换成 keyError 的 provider id —— 多供应商下每家的输入框独立抖动。
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
    setKeyError(null);
  };

  /**
 * 「检查模型可用性」：**逐家**拉 `/models`。
   *
 * 为什么不能第一家失败就整轮放弃：多供应商之后，一家的 key 过期是常态（用户换了新 key
 * 但没删旧供应商）。整体失败会让其余几家连候选列表都拉不出来 —— 于是用户为了修一家
 * 的问题，必须先把另外几家也全部弄好。所以逐家独立记录结果，汇总成一句提示。
   */
  const handleCheck = async () => {
    const providers = settings.providers;
    const noKey = providers.filter((p) => !p.apiKey.trim());
    if (noKey.length === providers.length) {
      triggerKeyError(noKey[0].id);
      toast.warning('请先填写至少一家供应商的 API Key');
      return;
    }
    setChecking(true);
    const opts: Record<string, string[]> = {};
    const notes: Record<string, string> = {};
    const result: Record<string, boolean> = {};
    await Promise.all(
      providers.map(async (p) => {
        if (!p.apiKey.trim()) {
          notes[p.id] = '未填写 API Key，已跳过';
          return;
        }
        try {
          const ids = await listModels({ apiKey: p.apiKey.trim(), baseUrl: p.baseUrl.trim() });
          opts[p.id] = ids;
          notes[p.id] = `${ids.length} 个模型在架`;
        } catch (e) {
          notes[p.id] = `拉取失败：${e instanceof Error ? e.message : String(e)}`;
        }
      }),
    );
    // 三个槽位各自按「自己那家」的列表判定
    for (const name of ['asrModel', 'llmModel', 'visionModel'] as ModelFieldName[]) {
      const ref = settings[name];
      const ids = opts[ref.providerId];
      if (ids) result[refKey(ref)] = ids.includes(ref.model);
    }
    setModelOptions(opts);
    setCheckResult(result);
    setProviderNotes(notes);

    const failed = Object.entries(notes).filter(([, note]) => note.startsWith('拉取失败'));
    const missing = Object.values(result).filter((ok) => !ok).length;
    const parts: string[] = [];
    if (failed.length > 0) parts.push(`${failed.length} 家拉取失败`);
    if (missing > 0) parts.push(`${missing} 个模型未上架`);
    if (parts.length === 0) toast.success('所有模型均可用');
    else toast.warning(`${parts.join('，')}，详见各供应商下方说明`);
    setChecking(false);
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

  /**
   * 切槽位的供应商。
   *
   * 换供应商时**模型 id 原样保留**而不是清空 —— 用户换的往往只是同一模型在另一家的
   * 镜像 id（`Qwen/Qwen3` 两家都有同名），清空会逼他重新找一遍。真的不存在也不拦：
   * 保留用户输入 + 候选列表里打对勾/红叉，比强制清空更可解释。
   */
  const setSlotProvider = (name: ModelFieldName, providerId: string) => {
    const next = { ...settings[name], providerId };
    if (name === 'llmModel') {
      settings.update({
        llmModel: next,
        contextWindow: guessContextWindow(catalogOf(settings, providerId), next.model),
      });
    } else {
      settings.update({ [name]: next });
    }
  };

  /** 一个槽位配置行（见 SLOT_FIELD_CARD 的注释：供应商与模型分两层配置） */
  const slotField = (name: ModelFieldName, slot: ModelSlot, label: string) => (
    <SlotField
      key={name}
      name={name}
      slot={slot}
      label={label}
      settings={settings}
      options={modelOptions[settings[name].providerId] ?? []}
      checkState={checkResult ? checkResult[refKey(settings[name])] : undefined}
      onProvider={setSlotProvider}
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
  const roundsRef = useMduiEvent('mdui-segmented-button-group', 'change', (_e, el) => {
    // ⚠️ 不能写 `Number(el.value) || 12`：「不限」这一档的值是 0（UNLIMITED_ROUNDS 哨兵），
    // `0 || 12` 会把它悄悄改回 12 —— 那个选项就永远存不下来
    const n = Number(el.value);
    settings.update({ agentRounds: Number.isFinite(n) ? n : 12 });
  });
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

  /** 收藏夹单个 tab：按供应商分组，每组内搜索筛选 + 相关模型置顶 */
  const favTabContent = (slot: ModelSlot) => {
    const kw = favSearch[slot].trim().toLowerCase();
    const relevant = SLOT_RELEVANT[slot];
    const selected = settings.favorites[slot];
    // 只列勾了该能力的供应商：收藏这个槽位就是给这个槽位用
    const groups = providersForSlot(settings, slot).map((p) => {
      const ids = (modelOptions[p.id] ?? [])
        .filter((id) => !kw || id.toLowerCase().includes(kw))
        .sort((a, b) => Number(relevant(p.catalogId, b)) - Number(relevant(p.catalogId, a)));
      return { provider: p, ids };
    });
    // 收藏夹里指向已删除供应商 / 已取消勾选能力的项仍要列出来，
    // 否则用户勾过的东西会凭空消失，且没有任何提示说明为什么
    const orphans = selected.filter(
      (r) => !groups.some((g) => g.provider.id === r.providerId),
    );
    const toggle = (ref: { providerId: string; model: string }, next: boolean) =>
      settings.update({
        favorites: {
          ...settings.favorites,
          [slot]: next
            ? [...selected.filter((x) => !sameRef(x, ref)), ref]
            : selected.filter((x) => !sameRef(x, ref)),
        },
      });

    return (
      <>
        <mdui-text-field
          ref={favKeywordRef}
          data-testid="fav-filter"
          aria-label="筛选收藏模型"
          placeholder="筛选模型"
          clearable
          value={favSearch[slot]}
        />
        {groups.every((g) => g.ids.length === 0) && orphans.length === 0 ? (
          <div className="text-secondary">没有匹配的模型</div>
        ) : (
          <div className="fav-list" data-testid="fav-list">
            {orphans.map((ref) => (
              <FavRow
                key={refKey(ref)}
                slot={slot}
                model={ref.model}
                providerName={`（${settings.providers.find((p) => p.id === ref.providerId)?.name ?? ref.providerId}：已不可用）`}
                catalogId=""
                checked
                onToggle={(next) => toggle(ref, next)}
              />
            ))}
            {groups.map(
              ({ provider, ids }) =>
                ids.length > 0 && (
                  <div key={provider.id} className="fav-group">
                    <div className="fav-group__head" data-testid={`fav-group-${provider.id}`}>
                      {provider.name}
                      <span className="text-secondary">（{ids.length}）</span>
                    </div>
                    {ids.map((id) => {
                      const ref = { providerId: provider.id, model: id };
                      return (
                        <FavRow
                          key={refKey(ref)}
                          slot={slot}
                          model={id}
                          providerName={provider.name}
                          catalogId={provider.catalogId}
                          checked={selected.some((x) => sameRef(x, ref))}
                          onToggle={(next) => toggle(ref, next)}
                        />
                      );
                    })}
                  </div>
                ),
            )}
          </div>
        )}
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
      <SectionCard
        title="模型供应商"
        subtitle="每家一个连接：地址 + Key + 它能做的活。三个槽位各自挑一家，ASR 可以和文本模型不在同一家"
        testId="card-api"
        actions={
          <mdui-button
            variant="tonal"
            data-testid="btn-add-provider"
            onClick={() => {
              const id = nextProviderId(settings);
              settings.update({
                providers: [
                  ...settings.providers,
                  { id, name: '', baseUrl: '', apiKey: '', serves: ['chat'], catalogId: '' },
                ],
              });
            }}
          >
            添加供应商
          </mdui-button>
        }
      >
        {settings.providers.map((p, i) => (
          <ProviderCard
            key={p.id}
            provider={p}
            others={settings.providers.filter((x) => x.id !== p.id)}
            note={providerNotes[p.id]}
            shaking={keyError === p.id}
            removable={settings.providers.length > 1 || i > 0}
            onChange={(patch) =>
              settings.update({
                providers: settings.providers.map((x) => (x.id === p.id ? { ...x, ...patch } : x)),
              })
            }
            onRemove={() => {
              // 删掉一家之后，指向它的槽位与收藏项必须一起处理，否则界面上留着
              // 一个解析不出端点的引用，表现为「所有请求都报供应商已被删除」。
              // 槽位改指第一家（id 必然存在：至少剩一家）；收藏项直接丢。
              const rest = settings.providers.filter((x) => x.id !== p.id);
              const fallback = rest[0].id;
              const patch: Partial<Settings> = { providers: rest };
              for (const name of ['asrModel', 'llmModel', 'visionModel'] as ModelFieldName[]) {
                if (settings[name].providerId === p.id) {
                  patch[name] = { ...settings[name], providerId: fallback };
                }
              }
              const favs = { ...settings.favorites };
              for (const slot of ALL_SLOTS) {
                const kept = favs[slot].filter((r) => r.providerId !== p.id);
                if (kept.length !== favs[slot].length) favs[slot] = kept;
              }
              patch.favorites = favs;
              settings.update(patch);
              toast.info(`已删除「${p.name || p.id}」，相关槽位改指「${rest[0].name || rest[0].id}」`);
            }}
          />
        ))}
      </SectionCard>

      <SectionCard
        title="模型配置"
        subtitle="凭据在上面那层，这里只管「哪个槽位用哪家的哪个模型」"
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
        {slotField('asrModel', 'asr', '语音识别（ASR）')}
        {slotField('llmModel', 'chat', '文本生成（讲义 / 问答）')}
        {slotField('visionModel', 'vision', '视觉（截图理解）')}
        <Field
          label="上下文窗口（tokens）"
          hint={`${metaHint}。这个值用来裁历史；每轮回答的输出上限另按模型真实能力给（取本值与模型实际窗口里更大的那个），所以这里填得偏小不会浪费模型的输出额度`}
          testId="field-context-window"
        >
          <mdui-text-field
            data-testid="context-window"
            aria-label="上下文窗口，单位 tokens"
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
          hint="每轮检索都会重发已检索内容：轮次越多材料越全，但更慢、更费 token。选「不限」也有几道护栏兜着 —— 同样的调用重复出现会停、单轮读到的材料接近上下文长度会停、模型空回复会被拉回来重说一遍、界面上随时可以按停止生成"
          testId="field-agent-rounds"
        >
          <mdui-segmented-button-group
            ref={roundsRef}
            data-testid="agent-rounds"
            aria-label="问答检索轮次上限"
            selects="single"
            value={String(settings.agentRounds)}
          >
            {[3, 6, 12, 20].map((n) => (
              <mdui-segmented-button key={n} value={String(n)}>
                {n}
              </mdui-segmented-button>
            ))}
            {/* 0 = 不限（agent.ts 的 UNLIMITED_ROUNDS 哨兵）。用哨兵而不是再加一个布尔字段：
                两个字段迟早会漂移，「轮数」和「有没有上限」必须是同一个量的两种取值 */}
            <mdui-segmented-button value={String(UNLIMITED_ROUNDS)}>不限</mdui-segmented-button>
          </mdui-segmented-button-group>
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
            aria-label="字幕转写并发数"
            min={1}
            max={12}
            step={1}
            value={settings.asrConcurrency}
          />
        </Field>
      </SectionCard>

      <SectionCard title="模型收藏夹" testId="card-favorites">
        {Object.keys(modelOptions).length === 0 ? (
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
            aria-label="主题"
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
            aria-label="动态取色"
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
            aria-label="HTML 联网加载外部资源"
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
          aria-controls="bili-advanced-settings"
          onClick={() => setAdvOverride(!advOpen)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            minHeight: 48,
            padding: '8px 0',
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
          {/* icon-swap：折叠 / 展开两个箭头叠在同一格交叉淡入淡出 */}
          <IconSwap
            active={advOpen ? 'b' : 'a'}
            a={<mdui-sym-chevron-right />}
            b={<mdui-sym-keyboard-arrow-down />}
          />
        </button>
        {advOpen && (
          <div data-testid="bili-adv" id="bili-advanced-settings">
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
                aria-label="代理地址"
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
            <Field label="B 站 Cookie" hint="仅存本机 localStorage，用于代理回退路径" className="field--stack" testId="field-bili-cookie">
              <div>
                <div className="row row--nowrap">
                  <mdui-text-field
                    data-testid="bili-cookie"
                    aria-label="B 站 Cookie"
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
              </div>
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
                aria-label="添加自定义播放倍速"
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
