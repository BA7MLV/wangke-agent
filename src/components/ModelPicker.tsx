import type { ReactNode } from 'react';
import { useSettings, sameRef, type ModelRef, type ModelSlot } from '../store/settings';
import { guessContextWindow, isVisionModel, supportsThinking } from '../api/modelCaps';
import './subtitle-danmaku.css';

interface Props {
  slot: ModelSlot;
  /** 当前值（对应的全局槽位字段名） */
  field: 'asrModel' | 'llmModel' | 'visionModel';
}

/** 槽位 → 图标：面板头寸土寸金，图标至少要能一眼看出「这个按钮换的是哪个模型」。
 *  图标是 Material Symbols（描边态），选中/悬停态交给 mdui-button-icon 自带的态层。 */
const SLOT_ICON: Record<ModelSlot, ReactNode> = {
  asr: <mdui-sym-mic />,
  vision: <mdui-sym-visibility />,
  chat: <mdui-sym-neurology />,
};

/** 槽位 → 中文名：不内联展示模型 id 之后，这个信息缺口由 tooltip 补上 */
const SLOT_LABEL: Record<ModelSlot, string> = {
  asr: '转写模型',
  vision: '视觉模型',
  chat: '文本模型',
};

/**
 * 面板头部的紧凑模型切换：一个图标 + 点击弹出菜单。
 *
 * 之前是 `mdui-select` 内联展示模型 id（最宽 220px），在窄面板头里太占地方、还挤掉操作按钮。
 * 改成图标触发后：当前模型名放进 tooltip，选中项在菜单里用内联对勾标出（见下方注释）。
 *
 * 多供应商后菜单项必须显示**供应商名**：`Qwen/Qwen3` 在两家都可能有，只显示模型 id
 * 分不清自己切到了哪一家。
 */
export default function ModelPicker({ slot, field }: Props) {
  const settings = useSettings();
  const value = settings[field];
  const favs = settings.favorites[slot];
  // 收藏夹不含当前值时并入当前值（去重、过滤空串），保证选中态始终可见、有效
  const candidates: ModelRef[] = [
    ...new Map(
      [...(favs.length > 0 ? favs : []), value]
        .filter((r) => r.model)
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

  const tooltip =
    favs.length === 0
      ? `${SLOT_LABEL[slot]}：${nameOf(value.providerId)} · ${value.model}（收藏夹为空，可在设置页拉取并收藏模型）`
      : `${SLOT_LABEL[slot]}：${nameOf(value.providerId)} · ${value.model}（点击切换）`;

  return (
    <mdui-tooltip content={tooltip}>
      <mdui-dropdown>
        <mdui-button-icon
          slot="trigger"
          data-testid="model-picker"
          aria-label={`切换${SLOT_LABEL[slot]}`}
        >
          {SLOT_ICON[slot]}
        </mdui-button-icon>
        <mdui-menu>
          {candidates.map((ref) => {
            const id = `${ref.providerId}\0${ref.model}`;
            const cat = catalogOf(ref.providerId);
            return (
              <mdui-menu-item
                key={id}
                data-testid={`model-picker-item-${id}`}
                onClick={() => pick(ref)}
              >
                <span className="model-picker__opt">
                  {/* 选中对勾：非当前项用 opacity:0 占位，保证每行文本对齐（不依赖 mdui-menu-item
                      的 selected 属性——它的 JSX 类型里漏了 selected，且属性反射行为不确定） */}
                  <mdui-sym-check
                    className="model-picker__check"
                    style={sameRef(ref, value) ? undefined : { opacity: 0 }}
                  />
                  {/* 供应商名独立一列：多供应商下模型 id 不再能唯一标识一个模型 */}
                  <span className="model-picker__provider">{nameOf(ref.providerId)}</span>
                  <span className="model-picker__id">{ref.model}</span>
                  {isVisionModel(cat, ref.model) && (
                    <span className="tag-mini tag-mini--primary">多模态</span>
                  )}
                  {supportsThinking(cat, ref.model) && <span className="tag-mini">可思考</span>}
                </span>
              </mdui-menu-item>
            );
          })}
        </mdui-menu>
      </mdui-dropdown>
    </mdui-tooltip>
  );
}
