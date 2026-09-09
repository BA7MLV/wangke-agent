import { Select, Tag, Tooltip } from 'antd';
import { useSettings, type ModelSlot } from '../store/settings';
import { guessContextWindow, isVisionModel, supportsThinking } from '../api/modelCaps';

interface Props {
  slot: ModelSlot;
  /** 当前值（对应的全局槽位字段名） */
  field: 'asrModel' | 'llmModel' | 'embedModel' | 'visionModel';
}

/** 面板头部的紧凑模型切换下拉：候选 = 收藏夹，为空时仅显示当前模型 */
export default function ModelPicker({ slot, field }: Props) {
  const settings = useSettings();
  const value = settings[field];
  const favs = settings.favorites[slot];
  // 收藏夹不含当前值时并入当前值（去重、过滤空串），保证选中态始终可见、有效
  const candidates = [...new Set(favs.length > 0 ? [...favs, value] : [value])].filter(Boolean);
  const options = candidates.map((id) => ({
    value: id,
    label: (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{id}</span>
        {isVisionModel(id) && <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>多模态</Tag>}
        {supportsThinking(id) && <Tag color="purple" style={{ marginInlineEnd: 0 }}>可思考</Tag>}
      </span>
    ),
  }));
  return (
    <Tooltip title={favs.length === 0 ? '收藏夹为空，可在设置页拉取并收藏模型' : '切换模型'}>
      <Select
        size="small"
        variant="borderless"
        value={value}
        options={options}
        onChange={(v) =>
          // 切文本模型时按内置表回填上下文窗口默认值（仍可手改），与设置页行为一致
          field === 'llmModel'
            ? settings.update({ llmModel: v, contextWindow: guessContextWindow(v) })
            : settings.update({ [field]: v })
        }
        popupMatchSelectWidth={false}
        style={{ maxWidth: 220, minWidth: 0 }}
        showSearch
        filterOption={(input, opt) => String(opt?.value).toLowerCase().includes(input.toLowerCase())}
      />
    </Tooltip>
  );
}
