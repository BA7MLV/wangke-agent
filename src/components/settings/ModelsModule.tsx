import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  Checkbox,
  Chip,
  Input,
  ListBox,
  Popover,
  SearchField,
  Select,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
} from '@heroui/react';
import { Header } from 'react-aria-components';
import {
  SLOT_LABEL,
  catalogOf,
  nextProviderId,
  modelOverridesOf,
  providersForSlot,
  sameRef,
  useSettings,
  type ApiProtocol,
  type ModelSlot,
  type Provider,
  type Settings,
} from '../../store/settings';
import { useProviderModels } from '../../utils/useProviderModels';
import {
  guessContextWindow,
  isVisionModel,
  supportsThinking,
} from '../../api/modelCaps';
import { UNLIMITED_ROUNDS } from '../../harness/loopGuard';
import { getModelMeta, isModelMetaStale, modelMetaInfo, refreshModelMeta, type ModelOverrides } from '../../api/modelMeta';
import { ms } from '../motion';
import { confirmDialog, Field, LoadingButton, SectionCard, Sym, toast } from '../../ui';
import { ALL_SLOTS, refKey, type ModelFieldName } from './shared';
import JevCard from './JevCard';
import ModelLibrary from './ModelLibrary';
import { modelLabel, modelsForSlot, savedModelsOf } from '../../store/modelLibrary';
import { ModelCapabilities } from '../ModelCapabilities';
import { useModelMetaRevision } from '../../utils/useModelMeta';
import { formatModelTokens } from '../../api/modelPresentation';

const ASR_MODEL_RE = /asr|whisper|sensevoice|xingchen/i;

/**
 * 各槽位的相关性启发式：相关模型在列表中置顶。**只影响排序**，不决定谁能进这个槽位。
 *
 * 带 catalogId 是因为能力判断必须按供应商查（同一模型 id 在别家可能不支持视觉/思考）。
 */
const SLOT_RELEVANT: Record<ModelSlot, (catalogId: string, id: string, overrides?: ModelOverrides) => boolean> = {
  chat: (cat, id, overrides) => supportsThinking(cat, id, overrides) || isVisionModel(cat, id, overrides),
  vision: (cat, id, overrides) => isVisionModel(cat, id, overrides),
  // ASR 只能靠名字猜 —— models.dev 的 modalities.input 里有 'audio'，但那含 TTS，
  // 而 /audio/transcriptions 只认 ASR 模型，两者在数据上区分不开。这里仍按名字排，
  // 但真正的准入靠供应商的 serves 勾选（见 ProviderRow）。
  asr: (_cat, id) => ASR_MODEL_RE.test(id),
};

/** 槽位 → 图标。三个槽位并排出现时，图标是唯一能一眼分开它们的东西 */
const SLOT_ICON: Record<ModelSlot, ReactNode> = {
  chat: <Sym name="neurology" />,
  vision: <Sym name="visibility" />,
  asr: <Sym name="mic" />,
};

/** 槽位 → 一句话说明它负责什么。放在槽位名下，替代原来分散在各处的长 hint */
const SLOT_HINT: Record<ModelSlot, string> = {
  chat: '负责讲义生成与课程问答，支持视觉时也可直接读图',
  vision: '主模型可读图时自动复用，否则使用已添加的图片理解模型；也可独立指定',
  asr: '把视频音轨转成字幕，可以和文本模型不在同一家',
};

const SLOT_ORDER: readonly ModelSlot[] = ['chat', 'vision', 'asr'];

/** 上下文窗口的紧凑写法：128000 → 128K，1048576 → 1M。列表里每行都要显示，太长会挤掉模型名 */
/** 能力徽标：多模态 / 可思考。模型 id 长的行里这两枚最占地方，所以做成小圆角标签 */
function CapBadges({ catalogId, model, overrides }: { catalogId: string; model: string; overrides?: ModelOverrides }) {
  return <ModelCapabilities catalogId={catalogId} model={model} overrides={overrides} compact />;
}

/**
 * 供应商列表里的一行模型（Pi 的 /model 面板就是这个结构）。
 *
 * 一行 = 一个「供应商 + 模型」组合，所以**供应商名必须印出来**：`Qwen/Qwen3` 在两家
 * 都可能存在，只显示模型 id 没法分辨自己收藏的是哪一家的。右侧再跟上下文窗口，
 * 因为选模型时最关心的就是「它能记多少」。
 */
function ModelOptionRow({
  providerId,
  providerName,
  model,
  catalogId,
  selected,
  favorite,
  label,
  onSelect,
  onToggleFavorite,
  slot,
  idPrefix,
}: {
  /** 供应商 id。写进行 id 而不是只写名字：`id` 是唯一键，两家重名会撞（见上面的说明） */
  providerId: string;
  providerName: string;
  model: string;
  catalogId: string;
  /** false = 没填 models.dev key，上下文窗口只能按名字猜，得标出来 */
  catalogKnown: boolean;
  selected: boolean;
  favorite: boolean;
  label?: string;
  onSelect: () => void;
  onToggleFavorite: () => void;
  slot: ModelSlot;
  /**
   * id 前缀。收藏分组里的项和供应商分组里的项可能是同一个模型（收藏是置顶
   * 而不是搬家），两处 id 撞了 React Aria 会抛 Duplicate key。
   */
  idPrefix?: string;
}) {
  const favTestId = `fav-${slot}-${providerName}-${model}`;
  const overrides = useSettings((s) => modelOverridesOf(s, { providerId, model }));
  // 星标放在 ListBox.Item **内部**：Item 是 React Aria collection 的成员，
  // 在外面另起一个 <div> 会让 collection 遍历到非collection 节点，行为不可预期。
  return (
    <ListBox.Item
      // 用 '::' 而不是 '\0' 分隔：ListBox.Item 的 id 会被 React Aria 直接写进
      // DOM 的 id 属性，而 NUL 是 XML/HTML 明确不允许出现在属性值里的字符 ——
      // 列表一有内容，React 就会在 commit 阶段抛
      // "getOwnerDocumentFromRootContainer(...).createTextNode is not a function"，
      // 整棵树崩掉（空列表时因为没有 Item 所以看不出来）。
      // 模型 id 里不会出现连续两个冒号，用它分隔足够安全。
      //
      // 左半段必须是**供应商 id**（不是名字）：名字允许重名，当唯一键会把两家同名的
      // 候选挤成一条；而且供应商下拉认的是 id，认名字等于指向一家不存在的供应商。
      id={`${idPrefix ?? ''}${providerId}::${model}`}
      textValue={label || model}
      data-testid={`model-option-${model}`}
      className="relative flex flex-1 min-w-0 items-center gap-3.5 rounded-sm pr-[38px]"
      onAction={onSelect}
    >
      <span className="flex flex-1 min-w-0 items-center gap-2">
        <span className="truncate font-mono text-[13px]" title={model}>{label || model}</span>
        {selected && <Sym name="check" />}
        <CapBadges catalogId={catalogId} model={model} overrides={overrides} />
      </span>
      <span className="flex shrink-0 items-baseline gap-2.5 text-[11px] text-muted">
        <span className="max-w-[120px] truncate text-right">{providerName}</span>
        <span
          className="min-w-12 text-right tabular-nums"
        >
          {formatModelTokens(getModelMeta(catalogId, model, overrides)?.declaredContext)}
        </span>
      </span>
      <span
        className={`absolute top-1/2 right-2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full border-0 bg-transparent text-base text-muted transition-opacity duration-200 cursor-pointer ${favorite ? 'opacity-100 text-accent' : 'opacity-60 hover:bg-foreground/8'} `}
        data-fav={favorite ? 'true' : 'false'}
        data-testid={favTestId}
        role="button"
        tabIndex={-1}
        aria-label={favorite ? `取消收藏 ${model}` : `收藏 ${model}`}
        onClick={(event) => {
          // 星标在 Item 内部，靠阻止冒泡避免顺手把模型也选中
          event.stopPropagation();
          onToggleFavorite();
        }}
      >
        <Sym name="star" filled={favorite} />
      </span>
    </ListBox.Item>
  );
}

/**
 * 「按下就收起」：面板 / 触发按钮之外的任意一次 pointerdown 都要关掉面板。
 *
 * 为什么需要自己写：模型检索面板打了 `isNonModal`（理由见 SlotModelSelect 里的注释），
 * 而 react-aria 的「点外面关闭」挂在 `isDismissable` 上，`usePopover` 把后者写死成
 * `!isNonModal` —— 也就是说，非模态浮层在这一层上没有任何自动收起。
 * Esc 仍然有效（走 `isKeyboardDismissDisabled`，与 isNonModal 无关）。
 *
 * 为什么用 pointerdown 而不是 click：click 要等 mouseup，按下时目标可能已经变了；
 * 而且按下即关能给用户「点空了」的即时反馈，不用等一次完整的按下-抬起。
 *
 * 挂在冒泡阶段而不是捕获阶段：捕获阶段里把面板从 DOM 里摘掉，中途还在传播的这次
 * 点击有可能落空（尤其当目标正好在被移除的子树里）。
 */
function DismissOnOutsidePress({
  triggerRef,
  onDismiss,
}: {
  triggerRef: React.RefObject<HTMLElement | null>;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const handle = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // 面板本体（data-model-picker）与触发按钮之外的按下都算「点外面」
      if (target instanceof Element && target.closest('[data-model-picker]')) return;
      if (triggerRef.current?.contains(target)) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', handle);
    return () => document.removeEventListener('pointerdown', handle);
  }, [onDismiss, triggerRef]);
  return null;
}

/**
 * 一个槽位绑定的模型。
 *
 * 形态取自 Pi agent 的模型选择器：一张**整行可点**的大按钮直接显示
 * 「模型名 + 能力 + 窗口」，点开才是检索面板。**为什么不给自由输入框**：
 * 旧版是「输入框 + 选择按钮」两个控件，输入框在前、下拉在后 —— 用户会先看到那个
 * 看起来能随便填的输入框，于是去手抄模型 id，而抄错一个字符要到运行时才报 404。
 * 检索面板把「有哪些」摆在「选哪个」前面，手抄的路径仍然保留（面板底部的
 * 「手动填写」），但不再是默认视线落点。
 */
function SlotModelSelect({
  name,
  slot,
  settings,
  options,
}: {
  name: ModelFieldName;
  slot: ModelSlot;
  settings: Settings;
  /** 该槽位候选供应商各自拉到的在架模型（key = provider id） */
  options: Record<string, string[]>;
}) {
  const ref = settings[name];
  const update = useSettings((s) => s.update);
  const provider = settings.providers.find((p) => p.id === ref.providerId);
  const [kw, setKw] = useState('');
  const [open, setOpen] = useState(false);
  // 面板是 fixed 定位的，React Aria 要靠触发元素的 ref 才能算出「贴在按钮下方」。
  // 之前按钮是 Popover.Trigger（自带 ref），换成自己的 <button> 后必须自己传，
  // 否则面板会停在 (0,0) 且被 clip 掉 —— DOM 里有、屏幕上看不见。
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const favs = settings.favorites[slot];
  const catalogId = catalogOf(settings, ref.providerId);

  // 选了模型就顺手关面板：这是「选完即完成」的动作，留着面板挡住下面的运行参数
  useEffect(() => {
    if (open) setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.model, ref.providerId]);

  /**
   * 面板一打开就把光标放进检索框。
   *
   * 模态浮层时这件事是 react-aria 干的（非模态不干，见下面的 isNonModal 注释），
   * 而面板里的 `Popover.Dialog` 是 RAC 的 Dialog —— 它打开时会把焦点接到自己身上
   * （`tabIndex=-1` 的容器），所以光标停在面板边框而不是输入框里。
   * 子组件的 effect 先跑、这个父级 effect 后跑，所以这里 focus 能压过它。
   */
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector('input')?.focus({ preventScroll: true });
  }, [open]);

  /** 面板里要列的供应商：勾了该槽位的那些家；当前指的那家即便没勾也列出（否则改不回去） */
  const candidates = useMemo(() => {
    const list = providersForSlot(settings, slot);
    if (!list.some((p) => p.id === ref.providerId) && provider) return [provider, ...list];
    return list;
  }, [settings, slot, ref.providerId, provider]);

  const relevant = SLOT_RELEVANT[slot];
  const needle = kw.trim().toLowerCase();
  const isFav = (p: Provider, m: string) => favs.some((x) => x.providerId === p.id && x.model === m);

  /**
   * 选中一个模型：供应商与模型 id 一次性写进同一次 update。
   *
   * ⚠️ 这里**不能**再调一次「切供应商」的回调去做 providerId 的修正 ——
   * 那个回调读的是本次渲染的 `settings` 快照（模型还是旧的），
   * 于是它的 update 会把刚选中的模型又写回旧值：
   * 用户点一条候选，面板关掉了、界面纹丝不动，看起来就是「点了没反应」。
   * （反过来，先改供应商再选模型又是同一个坑的另一头。）
   * 供应商与模型本来就该在一次写入里一起改，所以这里一次写完。
   */
  const setModel = (providerId: string, model: string) => {
    if (!model) return;
    const patch: Partial<Settings> = { [name]: { providerId, model } };
    if (name === 'llmModel') {
      patch.contextWindow = guessContextWindow(catalogOf(settings, providerId), model, modelOverridesOf(settings, { providerId, model }));
    }
    update(patch);
  };

  const toggleFavorite = (providerId: string, model: string) => {
    const entry = { providerId, model };
    const on = isFav({ id: providerId } as Provider, model);
    update({
      favorites: {
        ...settings.favorites,
        [slot]: on
          ? favs.filter((x) => !sameRef(x, entry))
          : [...favs.filter((x) => !sameRef(x, entry)), entry],
      },
    });
  };

  /** 分组：收藏优先置顶（Pi 的 /model 也是收藏先列），其余按供应商分组 */
  const groups = candidates.map((p) => {
    const ids = Array.from(
      new Set(
        modelsForSlot(settings, slot).filter((m) => m.providerId === p.id).map((m) => m.model).filter(
           (id) => !needle || `${id} ${modelLabel(settings, { providerId: p.id, model: id })} ${p.name}`.toLowerCase().includes(needle),
        ),
      ),
    ).sort((a, b) => Number(relevant(p.catalogId, b, modelOverridesOf(settings, { providerId: p.id, model: b }))) - Number(relevant(p.catalogId, a, modelOverridesOf(settings, { providerId: p.id, model: a }))));
    return { provider: p, ids };
  });
  const favRows = candidates.flatMap((p) =>
    favs
      .filter((f) => f.providerId === p.id && (!needle || f.model.toLowerCase().includes(needle)))
      .map((f) => ({ provider: p, id: f.model })),
  );
  // 收藏夹里指向已删供应商 / 已取消能力的项仍要列出来，否则勾过的东西凭空消失
  const orphanFavs = favs.filter(
    (f) => !candidates.some((p) => p.id === f.providerId) && (!needle || f.model.toLowerCase().includes(needle)),
  );

  const totalResults = favRows.length + orphanFavs.length + groups.reduce((n, g) => n + g.ids.length, 0);

  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-background-secondary p-3 px-3.5 transition-shadow hover:shadow-sm">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-background text-[17px] text-muted" aria-hidden="true">
          {SLOT_ICON[slot]}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold leading-tight text-foreground">{SLOT_LABEL[slot]}</div>
          <div className="mt-px truncate text-xs text-muted">{SLOT_HINT[slot]}</div>
        </div>
        {/* 候选供应商只列勾了该能力的那些家 —— 这是「手动标能力」的实际用途 */}
        {(slot !== 'vision' || ref.model) && <Select
          className="w-[148px] shrink-0"
          data-testid={`provider-${name}`}
          aria-label={`${SLOT_LABEL[slot]}使用的供应商`}
          selectedKey={ref.providerId}
          onSelectionChange={(key) => {
            if (key != null) {
              const first = modelsForSlot(settings, slot).find((m) => m.providerId === String(key));
              if (first) setModel(first.providerId, first.model);
            }
          }}
        >
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          {/* isNonModal 必需，见下面模型检索面板的同一段注释：
              模态浮层会给「它以外的一切」打 inert，连父弹窗一起打中，
              于是展开下拉之后整个设置面板就点不动了。 */}
          <Select.Popover isNonModal>
            <ListBox>
              {candidates.map((p) => (
                <ListBox.Item key={p.id} id={p.id} textValue={p.name}>
                  {p.name}
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>}
      </div>

      {slot === 'vision' && <Checkbox
        aria-label="自动：优先主模型，否则使用读图模型"
        isSelected={!ref.model}
        onChange={(on) => {
          const first = modelsForSlot(settings, 'vision')[0];
          if (!on && !first) { toast.warning('请先添加用于图片理解的模型'); return; }
          update({ visionModel: on ? { providerId: '', model: '' } : { providerId: first.providerId, model: first.model } });
        }}
      ><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>自动：优先主模型，否则使用读图模型</Checkbox.Content></Checkbox>}

      {slot === 'vision' && !ref.model ? <p className="text-xs text-muted">主模型无图片输入能力或能力未知时，自动使用已添加且已配置凭据的图片理解模型。请先添加读图模型并勾选「图片理解」用途；不会按模型名称猜测能力，也不会静默忽略图片。</p> : <>
      {(
        // 受控用法（isOpen + onOpenChange），不用 Popover.Trigger。
        //
        // 为什么绕开 Trigger：HeroUI v3 的 Popover.Trigger 渲染成
        // <Pressable><div role="button" /></Pressable>，而 Pressable 自己调 usePress
        // 把 press 事件合到 children 上；DialogTrigger 注入的 onPress 则走 props，
        // 两者互相覆盖，结果 onPress 永远不触发 —— 点这个按钮面板弹不出来
        // （控制台会刷 "A PressResponder was rendered without a pressable child"）。
        // Select.Trigger 没这问题，因为它渲染的是真正的 <button>。
        //
        // 所以这里自己画一个原生 <button>，点击行为由 DOM 保证，稳。
        //
        // ⚠️ `isNonModal` 不是可选项：RAC 的浮层默认是**模态**的，展开时会给
        // 「它之外的一切」打 `inert`（react-aria 的 ariaHideOutside，shouldUseInert）。
        // 这个面板就开在设置弹窗里，于是被打中 inert 的正好是整块 `.react-aria-ModalOverlay`
        // —— 表现是：面板弹出来了，但设置面板（含左侧模块列）整块点不动，
        // 键盘也过不去，只能刷新页面。这正是「设置页面根本点不动」的成因。
        //
        // 打上 isNonModal 后走 react-aria 的 keepVisible 分支，一个 inert 都不加；
        // Esc 仍然能关（isKeyboardDismissDisabled 与 isNonModal 无关）。
        // 代价是「点外面自动收起」不再由 react-aria 代劳 —— 那是 isDismissable 管的，
        // 而 usePopover 把 isDismissable 写死成 `!isNonModal`。
        // 所以补一个 DismissOnOutsidePress 把这件事接回来，检索框也改为自己拿焦点
        // （模态时是 react-aria 把焦点丢给面板首帧，非模态下它不再管这件事）。
        <Popover isOpen={open} onOpenChange={setOpen}>
          <button
            ref={triggerRef}
            type="button"
            className="mt-2.5 box-border flex min-h-[42px] w-full cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2 text-left font-[inherit] text-foreground shadow-sm transition-[border-color,box-shadow] duration-200 hover:border-accent/45 hover:shadow-md focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 aria-expanded:border-accent/55 aria-expanded:shadow-lg"
            data-testid={`model-button-${name}`}
            aria-label={`选择${SLOT_LABEL[slot]}模型，当前为 ${ref.model || '未设置'}`}
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={() => setOpen((v) => !v)}
          >
            <span className="flex flex-1 min-w-0 items-center gap-2">
              {ref.model ? (
                <>
                  <span className="truncate font-mono text-[13px] font-medium" title={ref.model}>{modelLabel(settings, ref)}</span>
                  <CapBadges catalogId={catalogId} model={ref.model} overrides={modelOverridesOf(settings, ref)} />
                </>
              ) : (
                <span className="truncate text-[13px] text-muted">未选择模型</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-[13px] text-muted">
              <span className="text-xs tabular-nums text-muted">
                {ref.model ? formatModelTokens(getModelMeta(catalogId, ref.model, modelOverridesOf(settings, ref))?.declaredContext) : ''}
              </span>
              <Sym name="keyboard_arrow_down" />
            </span>
          </button>
          {/* 非模态浮层不再自带「点外面收起」，这里接回来。
              pointerdown 比 click 早：按下那一刻就知道该关，不用等 mouseup。 */}
          {open && <DismissOnOutsidePress triggerRef={triggerRef} onDismiss={() => setOpen(false)} />}
          <Popover.Content
            className="p-0"
            placement="bottom start"
            triggerRef={triggerRef}
            isNonModal
            // DismissOnOutsidePress 靠这个属性认出「面板本体」，
            // 比按 HeroUI 的 .popover 类名匹配稳（类名会随版本改）。
            data-model-picker={name}
            ref={panelRef}
            style={{
              width: 'min(34rem, calc(100vw - 3rem))',
            }}
          >
            {/**
             * 高度上限挂在 **Dialog** 上，不挂在浮层上。
             *
             * RAC 的 `Popover` 会把「可用空间」算好、以**行内** `max-height` 写回浮层元素，
             * 于是 `Popover.Content` 的 `style.maxHeight` 会被它静默覆盖（实测传给它的
             * `min(28rem, calc(100dvh - 8rem))` 被换成了 589px）。行内样式压不过，
             * 只能换个元素挂。
             *
             * `overflow-hidden` + `flex-col` + ListBox 的 `min-h-0` 三者缺一不可：
             * 少了 `overflow-hidden` 面板就不会裁剪，列表会**整条溢出到浮层外面**
             * （40 个模型时列表高 1467px、浮层只有 589px），那内容是滚不到的 ——
             * 这正是「选择模型这里没有办法滚动」的成因。
             */}
            <Popover.Dialog
              className="flex min-h-0 flex-col gap-0 overflow-hidden"
              style={{ maxHeight: 'min(28rem, calc(100dvh - 8rem))' }}
            >
              <SearchField
                aria-label={`筛选${SLOT_LABEL[slot]}模型`}
                data-testid={`model-search-${name}`}
                value={kw}
                onChange={(v) => setKw(v)}
              >
                <SearchField.Group className="px-3 py-2.5 pb-1.5">
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder={`搜索 ${candidates.length} 家供应商的模型`} />
                  <SearchField.ClearButton />
                </SearchField.Group>
              </SearchField>

              <ListBox
                className="min-h-0 overflow-y-auto overscroll-contain px-0 py-0"
                aria-label={`${SLOT_LABEL[slot]}模型候选`}
                selectionMode="none"
                // 这里**刻意不挂** onAction：选中逻辑在每个 ModelOptionRow 上（它手里
                // 已经有 provider 对象，直接就能拿到 id 与名字）。
                // 从 key 反解是走不通的 —— 收藏分组的 id 带 `fav::` 前缀，
                // 按第一个 `::` 切会把「fav」当成供应商 id；而两段都挂着时
                // 反解那次会晚于行内那次执行，把刚选中的模型又覆盖回旧值。
              >
                {favRows.length > 0 && (
                  <ListBox.Section>
                    {/* 分组头必须是 react-aria-components 的 Header，不能用普通 div。
                        ListBoxSection 靠遍历 children 建collection 树，遇到非 collection
                        节点就走错分支，React 会在 commit 阶段抛
                        "getOwnerDocumentFromRootContainer(...).createTextNode is not a function"，
                        整棵树崩掉 —— 面板打不开、截图全白，只有列表为空时才看不出问题。 */}
                    <Header className="sticky top-0 z-[1] flex items-center gap-1.5 bg-surface px-3 py-[7px] pb-1 text-[11px] font-semibold tracking-wide text-muted" data-testid={`fav-group-${slot}`}>
                      <Sym name="star" filled />
                      收藏
                    </Header>
                    {favRows.map(({ provider, id }) => (
                      <ModelOptionRow
                        key={`fav::${provider.id}::${id}`}
                        slot={slot}
                        providerId={provider.id}
                        providerName={provider.name}
                        model={id}
                        catalogId={provider.catalogId}
                        catalogKnown={provider.catalogId.trim().length > 0}
                        selected={sameRef({ providerId: provider.id, model: id }, ref)}
                        favorite={true}
                        label={modelLabel(settings, { providerId: provider.id, model: id })}
                        onSelect={() => setModel(provider.id, id)}
                        onToggleFavorite={() => toggleFavorite(provider.id, id)}
                        idPrefix="fav::"
                      />
                    ))}
                  </ListBox.Section>
                )}

                {orphanFavs.length > 0 && (
                  <ListBox.Section>
                    <Header className="sticky top-0 z-[1] flex items-center gap-1.5 bg-surface px-3 py-[7px] pb-1 text-[11px] font-semibold tracking-wide text-danger" data-testid={`orphan-group-${slot}`}>
                      <Sym name="warning" />
                      收藏里指向已不可用的供应商
                    </Header>
                    {orphanFavs.map((f) => (
                      <ModelOptionRow
                        key={`orphan::${f.providerId}::${f.model}`}
                        slot={slot}
                        providerId={f.providerId}
                        providerName={
                          `（${settings.providers.find((p) => p.id === f.providerId)?.name ?? f.providerId}：已不可用）`
                        }
                        model={f.model}
                        catalogId=""
                        catalogKnown={false}
                        selected={sameRef(f, ref)}
                        favorite={true}
                        onSelect={() => toast.warning('请先恢复供应商及其用途配置')}
                        onToggleFavorite={() => toggleFavorite(f.providerId, f.model)}
                        idPrefix="orphan::"
                      />
                    ))}
                  </ListBox.Section>
                )}

                {groups.map(({ provider, ids }) =>
                  ids.length > 0 ? (
                    <ListBox.Section key={provider.id}>
                      <Header className="sticky top-0 z-[1] flex items-center gap-1.5 bg-surface px-3 py-[7px] pb-1 text-[11px] font-semibold tracking-wide text-muted">
                        {provider.name}
                        <span className="font-normal tabular-nums opacity-75">{ids.length}</span>
                      </Header>
                      {ids.map((id) => (
                        <ModelOptionRow
                          key={`${provider.id}::${id}`}
                          slot={slot}
                          providerId={provider.id}
                          providerName={provider.name}
                          model={id}
                          catalogId={provider.catalogId}
                          catalogKnown={provider.catalogId.trim().length > 0}
                          selected={sameRef({ providerId: provider.id, model: id }, ref)}
                          favorite={isFav(provider, id)}
                          label={modelLabel(settings, { providerId: provider.id, model: id })}
                          onSelect={() => setModel(provider.id, id)}
                          onToggleFavorite={() => toggleFavorite(provider.id, id)}
                        />
                      ))}
                    </ListBox.Section>
                  ) : null,
                )}
              </ListBox>

              <div className="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-2.5">
                {totalResults === 0 ? (
                  <span className="min-w-0 truncate text-xs text-muted">
                    {Object.keys(options).length === 0
                      ? '请先在「我的模型」中添加模型'
                      : '没有匹配的已添加模型'}
                  </span>
                ) : (
                  <span className="min-w-0 truncate text-xs text-muted">{totalResults} 个模型</span>
                )}
                <span className="text-xs text-muted">在「我的模型」中添加和编辑</span>
              </div>
            </Popover.Dialog>
          </Popover.Content>
        </Popover>
      )}
      </>}
    </div>
  );
}

/**
 * 一家供应商：折叠时一行摘要，展开才编辑凭据。
 *
 * 为什么默认折叠：这是「配一次就长期不动」的配置，四个输入框常驻会让模型选择器
 * （真正需要反复操作的那部分）被推到屏幕外。摘要行已经把要紧的信息全给了 ——
 * 名字、地址、实现了哪些端点、有没有 Key、能不能连通。
 */
function ProviderRow({
  provider,
  others,
  note,
  status,
  modelCount,
  open,
  onToggle,
  onChange,
  onRemove,
  removable,
  shaking,
  children,
}: {
  provider: Provider;
  others: readonly Provider[];
  note?: string;
  status: 'ready' | 'unconfigured' | 'failed' | 'unchecked';
  modelCount: number | null;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<Provider>) => void;
  onRemove: () => void;
  removable: boolean;
  shaking: boolean;
  children: ReactNode;
}) {
  const inputRef = useRef<HTMLDivElement>(null);
  const [dupName, setDupName] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showConnection, setShowConnection] = useState(open || !provider.apiKey.trim() || !provider.baseUrl.trim());

  // 与其他家重名时提示：模型选型都按供应商名显示，重名会让设置与面板都对不上是哪一家
  useEffect(() => {
    setDupName(others.some((p) => p.name.trim() === provider.name.trim()));
  }, [provider.name, others]);

  // key 缺失时的抖动。动画通过内联 style 驱动，不依赖 .t-input / .is-shaking 类名。
  useEffect(() => {
    if (!shaking) return;
    setShowConnection(true);
    const el = inputRef.current;
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    const shakeMs = ms('--shake-dur-a', 80) * 2 + ms('--shake-dur-b', 60) * 2;
    el.style.animation = `t-input-shake ${shakeMs}ms linear`;
    const t = window.setTimeout(() => {
      if (el) el.style.animation = 'none';
    }, shakeMs + 20);
    return () => clearTimeout(t);
  }, [shaking]);

  const STATUS_HINT: Record<typeof status, string> = {
    ready: '列表已获取',
    unchecked: '未获取列表',
    failed: '列表获取失败',
    unconfigured: '未配置',
  };

  const providerIcon = /deepseek/i.test(provider.name)
    ? 'neurology'
    : /anthropic|claude/i.test(provider.name)
      ? 'bolt'
      : /openai/i.test(provider.name)
        ? 'code'
        : 'dns';

  const statusColor =
    status === 'ready'
      ? 'text-success'
      : status === 'failed' || status === 'unconfigured'
        ? 'text-danger'
        : 'text-muted';

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-border/80 bg-background-secondary transition-shadow ${open ? 'border-accent/45 bg-background shadow-md' : 'min-h-[218px] hover:shadow-sm max-[640px]:min-h-[150px]'}`}
      data-testid={`provider-card-${provider.id}`}
      data-open={open ? 'true' : undefined}
    >
      <button
        type="button"
        className={`box-border flex w-full cursor-pointer flex-col items-stretch gap-5 border-0 bg-transparent p-5 text-left font-[inherit] text-foreground transition-colors duration-200 hover:bg-foreground/4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus max-[640px]:gap-2.5 max-[640px]:p-2.5 ${open ? 'min-h-[96px]' : 'min-h-[218px] max-[640px]:min-h-[150px]'}`}
        data-testid={`provider-summary-${provider.id}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="flex items-start justify-between gap-3">
          <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-background text-3xl text-foreground shadow-sm max-[640px]:size-9 max-[640px]:rounded-xl max-[640px]:text-lg" aria-hidden="true">
            <Sym name={providerIcon} />
          </span>
          <span className={`max-w-full truncate rounded-full px-3 py-1 text-xs font-medium max-[640px]:px-1.5 max-[640px]:py-0.5 max-[640px]:text-[9px] ${removable ? 'mr-10 max-[640px]:mr-9' : ''} ${statusColor} ${status === 'ready' ? 'bg-success/12' : status === 'failed' || status === 'unconfigured' ? 'bg-danger/12' : 'bg-foreground/8'}`}>
            {STATUS_HINT[status]}
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-end gap-1">
          <span className="flex items-center gap-1.5 truncate text-lg font-semibold text-foreground max-[640px]:text-xs">
            {provider.name.trim() || '未命名供应商'}
            {dupName && <Chip size="sm" variant="soft" color="danger" className="h-4 px-1 text-[10px]">重名</Chip>}
          </span>
          <span className="truncate font-mono text-xs text-muted max-[640px]:text-[9px]" title={provider.baseUrl}>
            {provider.baseUrl.trim() || 'API 地址未配置'}
          </span>
        </span>
        <span className="flex items-center gap-2 text-sm text-muted max-[640px]:gap-1 max-[640px]:text-[10px]">
          <Sym name="toc" className="max-[640px]:size-3" />
          <span className="tabular-nums">{modelCount ?? 0}</span>
          <span className="max-[640px]:hidden">个模型</span>
          <span className="ml-auto text-xs text-muted max-[640px]:hidden">{open ? '详情' : '进入'}</span>
        </span>
      </button>
      {removable && (
        <Button
          variant="ghost"
          isIconOnly
          size="sm"
          className="absolute top-4 right-4 text-muted hover:text-danger max-[640px]:top-2 max-[640px]:right-2"
          data-testid={`provider-remove-${provider.id}`}
          onPress={onRemove}
          aria-label={`删除供应商 ${provider.name || provider.id}`}
        >
          <Sym name="delete" />
        </Button>
      )}

      {open && (
        <div className="flex flex-col gap-3 border-t border-border/70 px-5 pt-4 pb-5">
          <details open={showConnection} onToggle={(event) => setShowConnection(event.currentTarget.open)}>
            <summary className="cursor-pointer py-2 text-sm font-medium">连接设置 · 地址、密钥与协议</summary>
            <div className="flex flex-col gap-3 pt-3">
          <div className="flex flex-nowrap items-center gap-2">
            <Input
              value={provider.name}
              data-testid={`provider-name-${provider.id}`}
              aria-label="供应商名称"
              placeholder="供应商名称，如「硅基流动」"
              aria-invalid={dupName || undefined}
              onChange={(e) => onChange({ name: e.target.value })}
              className="flex-1"
            />
          </div>
          <Field label="API 地址" testId={`field-base-url-${provider.id}`}>
            <Input
              value={provider.baseUrl}
              data-testid={`base-url-${provider.id}`}
              aria-label="API 地址"
              placeholder="https://api.example.com/v1"
              onChange={(e) => onChange({ baseUrl: e.target.value.trim() })}
            />
          </Field>
          <Field label="API 协议" hint="选择这家供应商的对话请求格式；模型列表会按所选协议查询">
            <Select
              aria-label={`${provider.name || '供应商'} API 协议`}
              selectedKey={provider.protocol ?? 'openai-chat'}
              onSelectionChange={(key) => {
                if (key != null) onChange({ protocol: String(key) as ApiProtocol });
              }}
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover isNonModal>
                <ListBox>
                  <ListBox.Item id="openai-chat" textValue="OpenAI Chat">OpenAI Chat</ListBox.Item>
                  <ListBox.Item id="openai-responses" textValue="OpenAI Responses">OpenAI Responses</ListBox.Item>
                  <ListBox.Item id="anthropic-messages" textValue="Anthropic Messages">Anthropic Messages</ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          </Field>
          <Field
            label="API Key"
            hint="仅保存在本机浏览器 localStorage 中；云同步与迁移包都不含它"
            testId={`field-api-key-${provider.id}`}
          >
            <div>
              <div
                ref={inputRef}
                className={`rounded-md border transition-colors duration-150 ${shaking ? 'border-danger' : 'border-border'}`}
                style={{ willChange: 'transform' }}
              >
                <div className="flex flex-nowrap items-center gap-2">
                  <Input
                    data-testid={`api-key-${provider.id}`}
                    aria-label={`${provider.name} 的 API Key`}
                    aria-invalid={shaking || undefined}
                    type={showKey ? 'text' : 'password'}
                    placeholder="sk-..."
                    value={provider.apiKey}
                    onChange={(e) => onChange({ apiKey: e.target.value.trim() })}
                    className="flex-1 border-0 shadow-none focus-visible:ring-0"
                  />
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    aria-label={showKey ? `隐藏 ${provider.name} 的 API Key` : `显示 ${provider.name} 的 API Key`}
                    onPress={() => setShowKey((v) => !v)}
                  >
                    <Sym name={showKey ? 'visibility_off' : 'visibility'} />
                  </Button>
                </div>
              </div>
              <p
                className={`mt-1 text-xs text-danger transition-opacity duration-[280ms] ${shaking ? 'opacity-100 visible' : 'opacity-0 invisible'}`}
                data-testid={`key-error-${provider.id}`}
              >
                请先填写这家供应商的 API Key
              </p>
            </div>
          </Field>
          <Field
            label="能做的活"
            hint="手动勾选它实现了哪些接口。槽位的候选供应商只列勾选了该能力的那些家 —— 靠模型名猜不出来"
            layout="block"
            testId={`field-serves-${provider.id}`}
          >
            <div className="flex flex-wrap items-center gap-2" data-testid={`serves-${provider.id}`}>
              {ALL_SLOTS.map((slot) => (
                <Checkbox
                  key={slot}
                  isSelected={provider.serves.includes(slot)}
                  data-testid={`serves-${provider.id}-${slot}`}
                  onChange={(on) => {
                    const next = on
                      ? [...new Set([...provider.serves, slot])]
                      : provider.serves.filter((s) => s !== slot);
                    onChange({ serves: next });
                  }}
                >
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <span>{SLOT_LABEL[slot]}</span>
                  </Checkbox.Content>
                </Checkbox>
              ))}
            </div>
          </Field>
          <Field
            label="能力目录供应商（可选）"
            hint="通常无需填写。默认按模型 ID 精确匹配能力；同名有歧义时，可指定 models.dev 供应商 key。不影响连接与模型列表。"
            testId={`field-catalog-${provider.id}`}
          >
            <Input
              value={provider.catalogId}
              data-testid={`catalog-${provider.id}`}
              aria-label="models.dev 供应商 key"
              placeholder="自动匹配（可选，如 siliconflow-cn）"
              onChange={(e) => onChange({ catalogId: e.target.value.trim() })}
            />
          </Field>
            </div>
          </details>
          {note && (
            <div role={status === 'failed' ? 'alert' : 'status'} className="text-xs leading-relaxed text-muted" data-testid={`provider-note-${provider.id}`}>
              {note}
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * 「模型」模块。
 *
 * 供应商优先：展开一家后管理连接及其模型，再设置各用途的默认模型和运行参数。
 */
export default function ModelsModule() {
  const settings = useSettings();
  useModelMetaRevision();
  /** 哪一家的 key 缺失（provider id）。null = 都没问题 */
  const [keyError, setKeyError] = useState<string | null>(null);
  /** 当前进入详情页的供应商（provider id）。null = 供应商总览 */
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const { modelOptions, discoveredModels, providerNotes, checking, refresh: refreshProviderModels } = useProviderModels(settings.providers, selectedProviderId);
  const [, setMetaInfo] = useState(modelMetaInfo);
  const [metaRefreshing, setMetaRefreshing] = useState(false);
  const revertTimerRef = useRef<number | undefined>(undefined);

  /** 供应商 key 仅用于消除同名歧义；未填写也能刷新和使用能力目录。 */
  const catalogs = useMemo(
    () => settings.providers.map((p) => p.catalogId).filter((c) => c.trim().length > 0),
    [settings.providers],
  );
  const catalogsKey = catalogs.join('\0');

  // 能力数据过期则静默刷新（离线/失败不影响使用，回退启发式）
  useEffect(() => {
    if (!isModelMetaStale()) return;
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

  /** 只刷新目录；不改用户能力覆盖或手动设置的历史预算。 */
  const handleRefreshMeta = async () => {
    setMetaRefreshing(true);
    try {
      const { count } = await refreshModelMeta(catalogs);
      setMetaInfo(modelMetaInfo());
      toast.success(`已更新 ${count} 个模型的能力数据`);
    } catch (e) {
      toast.error(`刷新失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMetaRefreshing(false);
    }
  };

  /** error-state-shake：红边 + 消息由 keyError 驱动，hold 后自动回退 */
  const triggerKeyError = (providerId: string) => {
    setKeyError(providerId);
    // 出错的那家必须露出来，否则抖动发生在折叠区里，用户看不到
    setSelectedProviderId(providerId);
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    const shakeMs = ms('--shake-dur-a', 80) * 2 + ms('--shake-dur-b', 60) * 2;
    revertTimerRef.current = window.setTimeout(() => {
      revertTimerRef.current = undefined;
      setKeyError(null);
    }, shakeMs + ms('--revert-hold', 3000));
  };

  useEffect(() => () => clearTimeout(revertTimerRef.current), []);

  /**
   * 手动刷新只请求当前供应商的 `/models`，不检查或修改其他连接。
   */
  const handleCheck = async (providerId: string) => {
    const provider = settings.providers.find((p) => p.id === providerId);
    if (!provider) return;
    if (!provider.apiKey.trim() || !provider.baseUrl.trim()) {
      triggerKeyError(providerId);
      toast.warning('请先填写当前供应商的 API 地址与 Key');
      return;
    }
    try {
      const ids = await refreshProviderModels(provider);
      if (ids) toast.success(ids.length ? `已拉取 ${ids.length} 个模型` : '接口返回空模型列表，可手动添加模型');
    } catch (error) {
      toast.warning(`拉取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 一家的连通状态：优先看上次检查的结论，其次看配置是否完整 */
  const statusOf = (p: Provider): 'ready' | 'unconfigured' | 'failed' | 'unchecked' => {
    if (!p.apiKey.trim() || !p.baseUrl.trim()) return 'unconfigured';
    const note = providerNotes[p.id];
    if (note?.startsWith('拉取失败')) return 'failed';
    if (note) return 'ready';
    return 'unchecked';
  };

  const addProvider = () => {
    const id = nextProviderId(settings);
    settings.update({
      providers: [
        ...settings.providers,
        { id, name: '', baseUrl: '', apiKey: '', protocol: 'openai-chat', serves: ['chat'], catalogId: '' },
      ],
    });
    // 新加的那家没有地址没有 Key，不摊开就是一行没用的空壳
    setSelectedProviderId(id);
  };

  const removeProvider = (p: Provider) => {
    // 删掉一家之后，指向它的槽位与收藏项必须一起处理，否则界面上留着
    // 一个解析不出端点的引用，表现为「所有请求都报供应商已被删除」。
    // 槽位改指第一家（id 必然存在：至少剩一家）；收藏项直接丢。
    const rest = settings.providers.filter((x) => x.id !== p.id);
    const fallback = rest[0].id;
    const patch: Partial<Settings> = { providers: rest, savedModels: savedModelsOf(settings).filter((m) => m.providerId !== p.id) };
    for (const name of ['asrModel', 'llmModel', 'visionModel'] as ModelFieldName[]) {
      if (settings[name].providerId === p.id) {
        const slot = name === 'llmModel' ? 'chat' : name === 'visionModel' ? 'vision' : 'asr';
        const replacement = modelsForSlot(settings, slot).find((m) => m.providerId !== p.id);
        patch[name] = { providerId: replacement?.providerId ?? fallback, model: replacement?.model ?? '' };
      }
    }
    const favs = { ...settings.favorites };
    for (const slot of ALL_SLOTS) {
      const kept = favs[slot].filter((r) => r.providerId !== p.id);
      if (kept.length !== favs[slot].length) favs[slot] = kept;
    }
    patch.favorites = favs;
    settings.update(patch);
    if (selectedProviderId === p.id) setSelectedProviderId(null);
    toast.info(`已删除「${p.name || p.id}」，相关槽位改指「${rest[0].name || rest[0].id}」`);
  };

  const selectedProvider = selectedProviderId
    ? settings.providers.find((p) => p.id === selectedProviderId) ?? null
    : null;

  return (
    <>
      <SectionCard
        title={selectedProvider ? (selectedProvider.name.trim() || '未命名供应商') : '模型供应商'}
        subtitle={selectedProvider ? '配置连接、检查可用模型并管理该供应商的模型。' : '选择供应商后进入独立详情页，管理连接和模型。'}
        testId="card-api"
        actions={<>
          {selectedProvider && <LoadingButton variant="secondary" loading={checking} data-testid="btn-check-models" onPress={() => void handleCheck(selectedProvider.id)}>拉取模型列表</LoadingButton>}
          <LoadingButton variant="tertiary" loading={metaRefreshing} data-testid="btn-refresh-meta" onPress={() => void handleRefreshMeta()}>刷新能力数据</LoadingButton>
          {!selectedProvider && <Button variant="secondary" data-testid="btn-add-provider" onPress={addProvider}><Sym name="add" />添加供应商</Button>}
        </>}
      >
        {selectedProvider ? (
          <div className="flex flex-col gap-4">
            <Button
              variant="tertiary"
              className="self-start"
              data-testid="provider-back"
              onPress={() => setSelectedProviderId(null)}
            >
              <Sym name="arrow_back" />返回供应商列表
            </Button>
            <ProviderRow
              key={selectedProvider.id}
              provider={selectedProvider}
              others={settings.providers.filter((x) => x.id !== selectedProvider.id)}
              note={providerNotes[selectedProvider.id]}
              status={statusOf(selectedProvider)}
              modelCount={modelOptions[selectedProvider.id]?.length ?? null}
              open
              shaking={keyError === selectedProvider.id}
              removable={settings.providers.length > 1}
              onToggle={() => undefined}
              onChange={(patch) => {
                settings.update({ providers: settings.providers.map((x) => (x.id === selectedProvider.id ? { ...x, ...patch } : x)) });
              }}
              onRemove={async () => {
                if (await confirmDialog({ headline: '删除供应商？', description: `删除「${selectedProvider.name || selectedProvider.id}」及其已添加模型，相关默认模型将切换到其他供应商。`, danger: true, confirmText: '删除' })) removeProvider(selectedProvider);
              }}
            >
              <ModelLibrary key={selectedProvider.id} providerId={selectedProvider.id} discovered={discoveredModels[selectedProvider.id]} />
            </ProviderRow>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4 max-[640px]:gap-1.5">
            <button
              type="button"
              className="flex min-h-[218px] cursor-pointer flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border bg-transparent p-5 text-center text-muted transition-colors duration-200 hover:border-accent/55 hover:bg-background-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus max-[640px]:min-h-[150px] max-[640px]:gap-2 max-[640px]:rounded-xl max-[640px]:p-2"
              data-testid="provider-add-card"
              aria-label="添加供应商"
              onClick={addProvider}
            >
              <span className="grid size-16 place-items-center rounded-2xl bg-background-secondary text-3xl text-foreground shadow-sm max-[640px]:size-9 max-[640px]:rounded-xl max-[640px]:text-lg">
                <Sym name="add" />
              </span>
              <span className="text-lg font-semibold text-foreground max-[640px]:text-[10px]">连接提供商</span>
              <span className="text-sm max-[640px]:text-[9px]">API 密钥或登录</span>
            </button>
            {settings.providers.map((p, i) => (
              <ProviderRow
                key={p.id}
                provider={p}
                others={settings.providers.filter((x) => x.id !== p.id)}
                note={providerNotes[p.id]}
                status={statusOf(p)}
                modelCount={modelOptions[p.id]?.length ?? null}
                open={false}
                shaking={keyError === p.id}
                removable={settings.providers.length > 1 || i > 0}
                onToggle={() => setSelectedProviderId(p.id)}
                onChange={(patch) => {
                  settings.update({ providers: settings.providers.map((x) => (x.id === p.id ? { ...x, ...patch } : x)) });
                }}
                onRemove={async () => {
                  if (await confirmDialog({ headline: '删除供应商？', description: `删除「${p.name || p.id}」及其已添加模型，相关默认模型将切换到其他供应商。`, danger: true, confirmText: '删除' })) removeProvider(p);
                }}
              >
                <ModelLibrary key={p.id} providerId={p.id} />
              </ProviderRow>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs leading-relaxed text-muted">
          能力数据由 models.dev 提供。
        </p>
      </SectionCard>
      {!selectedProvider && <>
      <SectionCard
        title="选择模型"
        subtitle="选择主模型与语音转写模型；图片理解可自动复用主模型或单独指定。Chat 可随时切换。"
        testId="card-models"
      >
        <div className="flex flex-col gap-2.5">
          {SLOT_ORDER.map((slot) => {
            const name = (
              { chat: 'llmModel', vision: 'visionModel', asr: 'asrModel' } as const
            )[slot];
            return (
              <SlotModelSelect
                key={slot}
                name={name}
                slot={slot}
                settings={settings}
                options={modelOptions}
              />
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        title="运行参数"
        subtitle="检索深度与并发。日常不需要动，换模型或觉得回答太慢时再调"
        testId="card-tuning"
      >
        <Field
          label="问答检索轮次上限"
          hint="每轮检索都会重发已检索内容：轮次越多材料越全，但更慢、更费 token。选「不限」也有几道护栏兜着 —— 同样的调用重复出现会停、单轮读到的材料接近上下文长度会停、模型空回复会被拉回来重说一遍、界面上随时可以按停止生成"
          testId="field-agent-rounds"
        >
          <ToggleButtonGroup
            data-testid="agent-rounds"
            aria-label="问答检索轮次上限"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[String(settings.agentRounds)]}
            onSelectionChange={(keys) => {
              // ⚠️ 不能写 `Number(next) || 12`：「不限」这一档的值是 0（UNLIMITED_ROUNDS 哨兵），
              // `0 || 12` 会把它悄悄改回 12 —— 那个选项就永远存不下来
              const n = Number([...keys][0]);
              settings.update({ agentRounds: Number.isFinite(n) ? n : 12 });
            }}
          >
            {[3, 6, 12, 20].map((n) => (
              <ToggleButton key={n} id={String(n)}>
                {n}
              </ToggleButton>
            ))}
            {/* 0 = 不限（agent.ts 的 UNLIMITED_ROUNDS 哨兵）。用哨兵而不是再加一个布尔字段：
                两个字段迟早会漂移，「轮数」和「有没有上限」必须是同一个量的两种取值 */}
            <ToggleButton id={String(UNLIMITED_ROUNDS)}>不限</ToggleButton>
          </ToggleButtonGroup>
        </Field>
        <Field
          label={`字幕转写并发（当前 ${settings.asrConcurrency}）`}
          hint="初始并发数（1-12）；转写中遇限流自动减半，稳定后缓慢提升"
          layout="block"
          testId="field-asr-concurrency"
        >
          <Slider
            data-testid="asr-concurrency"
            aria-label="字幕转写并发数"
            minValue={1}
            maxValue={12}
            step={1}
            value={settings.asrConcurrency}
            onChange={(v) => settings.update({ asrConcurrency: typeof v === 'number' ? v : v[0] })}
          >
            <Slider.Track>
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
        </Field>
      </SectionCard>

      <JevCard />
      </>}
    </>
  );
}
