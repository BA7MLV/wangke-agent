import { useState, type ReactNode } from 'react';
import { Dropdown, ListBox, ScrollShadow, SearchField, Separator, Switch, Tooltip } from '@heroui/react';
import { Sym } from '../ui';
import { useSettings, sameRef, type ModelRef, type ModelSlot } from '../store/settings';
import { guessContextWindow, hasThinkingDepth, supportsThinking } from '../api/modelCaps';
import { useModelMetaRevision } from '../utils/useModelMeta';
import ReasoningEffortSlider from './ReasoningEffortSlider';
import './subtitle-danmaku.css';
import { modelKey, modelLabel, modelsForSlot } from '../store/modelLibrary';
import { ModelCapabilities } from './ModelCapabilities';

interface Props {
  slot: ModelSlot;
  /** 当前值（对应的全局槽位字段名） */
  field: 'asrModel' | 'llmModel' | 'visionModel';
  /**
   * 触发器的形态。
   *
   * - `icon`（默认）：32px 方形图标键，弹出锚定在旁边的下拉菜单，面板头那一排用 ——
   *   那一排是四个图标键并列，点一个弹出一屏半高的东西会把整排都压住；
   * - `chip`：图标 + 模型名 + 箭头的药丸，对话页输入卡里用 —— 输入卡上要能一眼看到
   *   「现在用的是哪个模型」，只给图标的话每次都得点开确认。
   *
   * 两种形态**不复用同一个弹层**：chip 那一格下面要装的不只是模型（见 `showThinking`），
   * 锚定菜单的高度上限摆不下那份内容，硬塞就得靠滚动，反而比底部弹层更难用。
   */
  variant?: 'icon' | 'chip';
  /**
   * chip 形态下要不要在弹层里带上思考设置。只有对话页传 true。
   *
   * 「用哪个模型」和「怎么答」本来就只改同一件事 —— 这一轮怎么答 ——
   * 所以它们该在同一个弹层里，而不是在工具行上再挂一颗灯泡 icon 当第二个入口。
   */
  showThinking?: boolean;
  /**
   * 生成中禁用深度滑块。**开关不禁用**：它只影响下一次提问，改它不影响已经在飞的那一轮，
   * 而滑块上正按着的手指容易让人以为在改当前这轮 —— 那就干脆别让动。
   */
  thinkingDepthDisabled?: boolean;
}

/** 槽位 → 图标：面板头寸土寸金，图标至少要能一眼看出「这个按钮换的是哪个模型」。 */
const SLOT_ICON: Record<ModelSlot, ReactNode> = {
  asr: <Sym name="mic" />,
  vision: <Sym name="visibility" />,
  chat: <Sym name="neurology" />,
};

/** 槽位 → 中文名：不内联展示模型 id 之后，这个信息缺口由 tooltip 补上 */
const SLOT_LABEL: Record<ModelSlot, string> = {
  asr: '转写模型',
  vision: '视觉模型',
  chat: '文本模型',
};

/**
 * 药丸上只留模型自己那一段名字。
 *
 * 供应商侧的命名空间（`deepseek-ai/`、`Qwen/`…）在药丸里是纯噪音 —— 供应商名在
 * 展开的菜单里独立一列，且 tooltip 里有全名。这里只做展示裁剪，**不动真实值**。
 */
export function shortModelName(model: string): string {
  const tail = model.split('/').pop() ?? model;
  return tail.trim() || model;
}

/**
 * 面板头部的紧凑模型切换：一个图标 + 点击弹出菜单（`variant="chip"` 时换成
 * 图标 + 模型名 + 箭头的药丸，点击后从底部滑出一张弹层）。
 *
 * 当前模型名放进 tooltip，选中项在菜单里用内联对勾标出。
 *
 * 多供应商后菜单项必须显示**供应商名**：`Qwen/Qwen3` 在两家都可能有，只显示模型 id
 * 分不清自己切到了哪一家。
 */
export default function ModelPicker({
  slot,
  field,
  variant = 'icon',
  showThinking = false,
  thinkingDepthDisabled,
}: Props) {
  const settings = useSettings();
  const value = settings[field];
  const favs = settings.favorites[slot];
  // 收藏夹不含当前值时并入当前值（去重、过滤空串），保证选中态始终可见、有效
  const candidates: ModelRef[] = [
    ...new Map(
      [...modelsForSlot(settings, slot).sort((a, b) => Number(favs.some((f) => sameRef(f, b))) - Number(favs.some((f) => sameRef(f, a)))), value]
        .filter((r) => r.model && settings.providers.some((p) => p.id === r.providerId && p.serves.includes(slot)))
        .map((r) => [`${r.providerId}\0${r.model}`, r]),
    ).values(),
  ];
  /** 供应商被删掉的收藏项：仍列出但标出来，否则用户会以为菜单漏了东西 */
  const nameOf = (id: string) => settings.providers.find((p) => p.id === id)?.name ?? '（已删除的供应商）';
  const catalogOf = (id: string) => settings.providers.find((p) => p.id === id)?.catalogId ?? '';

  const pick = (ref: ModelRef) => {
    // 切文本模型时按能力表回填上下文窗口默认值（仍可手改），与设置页行为一致
    if (field === 'llmModel') {
      settings.update({
        llmModel: ref,
        contextWindow: guessContextWindow(catalogOf(ref.providerId), ref.model),
      });
    } else {
      settings.update({ [field]: ref });
    }
  };

  const keyOf = modelKey;
  const currentKey = keyOf(value);

  const tooltip =
    candidates.length <= 1
      ? `${SLOT_LABEL[slot]}：${nameOf(value.providerId)} · ${value.model}（在设置 → 我的模型中添加更多模型）`
      : `${SLOT_LABEL[slot]}：${nameOf(value.providerId)} · ${value.model}（点击切换）`;

  /** 列表行内那一块：勾 + 供应商 + 模型 id + 能力标记。下拉菜单与弹层共用 */
  const rowContent = (ref: ModelRef) => {
    const cat = catalogOf(ref.providerId);
    return (
      <span className="model-picker__opt">
        {/* 选中对勾：非当前项用 opacity:0 占位，保证每行文本对齐 */}
        <Sym
          name="check"
          className="model-picker__check"
          style={sameRef(ref, value) ? undefined : { opacity: 0 }}
        />
        {/* 供应商名独立一列：多供应商下模型 id 不再能唯一标识一个模型 */}
        <span className="model-picker__provider">{nameOf(ref.providerId)}</span>
        <span className="model-picker__id" title={ref.model}>{modelLabel(settings, ref)}</span>
        <ModelCapabilities catalogId={cat} model={ref.model} compact />
      </span>
    );
  };

  if (variant === 'icon') {
    return (
      <Dropdown>
        <Tooltip>
          <Tooltip.Trigger>
            {/* ⚠️ Dropdown.Trigger 自己就渲染一个 <button>。在它里面再放 HeroUI 的
                <Button> 会产出 `<button><button>` —— 无效 HTML，React 每次渲染都抛
                validateDOMNesting 警告，而且点击事件在内层被吃掉后菜单偶尔不弹。
                触发器的外观直接用 className 挂到 Trigger 上即可（见 model-picker__trigger）。 */}
            <Dropdown.Trigger
              className="model-picker__trigger"
              aria-label={`切换${SLOT_LABEL[slot]}：当前 ${value.model}`}
              data-testid="model-picker"
            >
              {SLOT_ICON[slot]}
            </Dropdown.Trigger>
          </Tooltip.Trigger>
          <Tooltip.Content>
            <p className="model-picker__tooltip">{tooltip}</p>
          </Tooltip.Content>
        </Tooltip>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            onAction={(key) => {
              const ref = candidates.find((c) => keyOf(c) === key);
              if (ref) pick(ref);
            }}
          >
            {candidates.map((ref) => (
              <Dropdown.Item
                key={keyOf(ref)}
                id={keyOf(ref)}
                textValue={ref.model}
                data-testid={`model-picker-item-${keyOf(ref)}`}
              >
                {rowContent(ref)}
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    );
  }

  return <ChipDropdown
    slot={slot}
    candidates={candidates}
    value={value}
    currentKey={currentKey}
    keyOf={keyOf}
    pick={pick}
    rowContent={rowContent}
    tooltip={tooltip}
    showThinking={showThinking}
    thinkingDepthDisabled={thinkingDepthDisabled}
    nameOf={nameOf}
    catalogOf={catalogOf}
  />;
}

/**
 * chip 形态：药丸触发器 + 锚定在它上方的下拉面板（模型列表 + 思考设置）。
 *
 * **为什么不是 `Dropdown.Menu`**：Menu 是给「一串动作」用的，它的键盘模型是
 * 上下键在项之间走、Enter 触发、Esc 关闭。而这里下半段是一条 6 档滑块（只有开关的模型
 * 则是一枚 Switch）—— 塞进 Menu 的话方向键会跟档位抢，Tab 也走不出去。`Dropdown.Popover` 本身只是
 * RAC 的 `Popover`（`Dropdown.Menu` 是它的一个可选子节点，不是必需），所以直接往里
 * 放 `ListBox` + 一段普通内容，键盘与焦点各归各家。
 *
 * **为什么面板在上方（`top start`）**：这个 chip 在输入卡底部，向下展开必然出屏。
 * RAC 的 Popover 自己会翻转与平移，`top` 只是首选方向。
 *
 * ⚠️ 选完模型**不关**面板：要调思考的人还在这块地方，跟着关掉等于逼他再点一次。
 * （`Dropdown.Menu` 的 `onAction` 是自动关的，改用 ListBox 的选中语义就没有这层。）
 */
function ChipDropdown({
  slot,
  candidates,
  value,
  currentKey,
  keyOf,
  pick,
  rowContent,
  tooltip,
  showThinking,
  thinkingDepthDisabled,
  nameOf,
  catalogOf,
}: {
  slot: ModelSlot;
  candidates: ModelRef[];
  value: ModelRef;
  currentKey: string;
  keyOf: (ref: ModelRef) => string;
  pick: (ref: ModelRef) => void;
  rowContent: (ref: ModelRef) => ReactNode;
  tooltip: string;
  showThinking: boolean;
  thinkingDepthDisabled?: boolean;
  nameOf: (id: string) => string;
  catalogOf: (id: string) => string;
}) {
  const settings = useSettings();

  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const visible = candidates.filter((ref) => `${nameOf(ref.providerId)} ${ref.model} ${modelLabel(settings, ref)}`.toLowerCase().includes(needle));

  /**
   * 能不能思考 / 有没有深度，按**当前选中的模型**查，而不是按「面板打开时的那个」。
   * 用户在列表里换个模型，这两行就该当场跟着变 —— 深度区写死的话，
   * 「换到 GLM-5.2 却还留着上一个模型的档位」会被当成 bug。
   *
   * `useModelMetaRevision()`：能力表是启动后异步拉回来的，没有这条通知，
   * 拉回来之前这里只能按「不知道」处理，控件会一直停在拉取前的判断上。
   */
  useModelMetaRevision();
  const catalog = catalogOf(value.providerId);
  const canThink = showThinking && supportsThinking(catalog, value.model);
  const canDepth = canThink && hasThinkingDepth(catalog, value.model);
  const thinking = settings.thinkingEnabled;
  const effort = settings.thinkingEffort;

  return (
    <Dropdown>
      <Tooltip>
        <Tooltip.Trigger>
          {/* 同 icon 形态那条警告：Dropdown.Trigger 自己渲染 <button>，外面别再套 Button */}
          <Dropdown.Trigger
            className="model-picker__trigger model-picker__trigger--chip"
            aria-label={`切换${SLOT_LABEL[slot]}：当前 ${value.model}`}
            data-testid="model-picker"
          >
            {SLOT_ICON[slot]}
            <span className="model-picker__chip-name">{shortModelName(modelLabel(settings, value))}</span>
            <Sym name="keyboard_arrow_down" className="model-picker__chip-caret" />
          </Dropdown.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Content>
          <p className="model-picker__tooltip">{tooltip}</p>
        </Tooltip.Content>
      </Tooltip>
      <Dropdown.Popover placement="top start" className="model-picker__panel">
        {/* 标题行写全「谁 + 现在哪个」：面板是贴着输入卡底部浮起来的，
            只列模型名的话分不清自己开的是哪一个槽位的面板 */}
        <div className="model-picker__panel-head">
          <span className="shrink-0 text-sm font-semibold">{SLOT_LABEL[slot]}</span>
          <span className="min-w-0 truncate text-xs text-muted">
            {nameOf(value.providerId)} · {value.model}
          </span>
        </div>

        <SearchField aria-label="搜索已添加模型" value={query} onChange={setQuery} className="px-3 py-2">
          <SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder="搜索模型或供应商" /><SearchField.ClearButton /></SearchField.Group>
        </SearchField>
        {/* min-h-0 必需：flex 子项默认 min-height:auto，不设的话
            ScrollShadow 会按内容撑开、把下面的思考区顶出面板。 */}
        <ScrollShadow
          className="model-picker__panel-list min-h-0 flex-1"
          size={28}
          offset={2}
          hideScrollBar
          orientation="vertical"
        >
          <ListBox
            aria-label={SLOT_LABEL[slot]}
            selectionMode="single"
            /* 再点一次已选中项不该把高亮弄没 —— 选完模型是要继续待在这个
               面板里调思考的，那一下「取消选中」看起来就像面板坏了 */
            disallowEmptySelection
            selectedKeys={[currentKey]}
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (next == null) return;
              const ref = candidates.find((c) => keyOf(c) === String(next));
              if (ref) pick(ref);
            }}
            className="model-picker__panel-items"
          >
            {visible.map((ref) => (
              <ListBox.Item
                key={keyOf(ref)}
                id={keyOf(ref)}
                textValue={ref.model}
                data-testid={`model-picker-item-${keyOf(ref)}`}
                className="model-picker__panel-item"
              >
                {rowContent(ref)}
              </ListBox.Item>
            ))}
          </ListBox>
        </ScrollShadow>
        {!visible.length && <p role="status" className="px-3 py-2 text-xs text-muted">没有匹配的模型</p>}
        <p className="px-3 py-2 text-xs text-muted">在设置 → 我的模型中添加和编辑模型</p>

        {canThink && (
          <>
            {/* HeroUI 的 Separator **默认 orientation="vertical"**：在 flex 容器里
                可能变成一条 8px 宽的竖条，夹在两段内容中间像块补丁。横线得显式点名。 */}
            <Separator orientation="horizontal" className="model-picker__panel-sep" />
            {/* 一条紧凑的设置行：**左边一个标签、右边是控件本身**，没有第二行说明。
                这一段曾经是「思考 / 先推演再作答…」两行标题 + 下面再来一行「思考深度」，
                同一个东西被起了两次名字，而中间那句文案只是承诺、不带信息 —— 全砍掉。
                深度控件只在模型**声明了**档位或预算区间时出现：只有开关的模型
                （Qwen3.5 系、部分 DeepSeek）给不出深度，给个装饰性旋钮反而是骗人。
                它**不跟着 `thinking` 隐藏** —— 第一档就是「不思考」，藏起来用户就没法
                把思考关回去。 */}
            <div className="model-picker__think">
              <span className="model-picker__think-label">{canDepth ? '思考深度' : '思考'}</span>
              {canDepth ? (
                <ReasoningEffortSlider
                  fluid
                  value={thinking ? effort : 'none'}
                  onChange={(next) =>
                    settings.update(
                      next === 'none'
                        ? { thinkingEnabled: false }
                        : { thinkingEnabled: true, thinkingEffort: next },
                    )
                  }
                  disabled={thinkingDepthDisabled}
                />
              ) : (
                <Switch
                  /* 只给标签、不给 testid：HeroUI 的 `Switch` 本体是 RAC 的
                     `SwitchField`（一个 div），testid 挂上去就落在这个壳上 ——
                     它的可访问名与 aria-checked 都在里面的 button 上，
                     探针读状态会读到 null。 */
                  aria-label="开启思考"
                  isSelected={thinking}
                  onChange={(on) => settings.update({ thinkingEnabled: on })}
                >
                  <Switch.Content data-testid="chat-thinking-toggle">
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Content>
                </Switch>
              )}
            </div>
            {/* 只有开关的模型才需要一句解释（「为什么没有滑块」），且它挂在行**下面**
                而不是夹在标签与控件之间 —— 有滑块的那些模型一个字都不写 */}
            {!canDepth && (
              <p className="model-picker__think-hint">这个模型只支持开关，没有深度档位。</p>
            )}
          </>
        )}
      </Dropdown.Popover>
    </Dropdown>
  );
}
