import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, AutoComplete, Button, Card, Checkbox, Form, Input, InputNumber, Segmented, Space, Tabs, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { useSettings, type ModelSlot } from '../store/settings';
import { listModels } from '../api/siliconflow';
import { guessContextWindow, isVisionModel, supportsThinking } from '../api/modelCaps';
import { getModelMeta, isModelMetaStale, modelMetaInfo, refreshModelMeta } from '../api/modelMeta';
import { db } from '../store/db';
import { SuccessCheck, ms } from '../components/motion';
import SkillsCard from '../components/SkillsCard';
import StorageCard from '../components/StorageCard';

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

export default function Settings() {
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const settings = useSettings();
  const [checking, setChecking] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [checkResult, setCheckResult] = useState<Record<string, boolean> | null>(null);
  const [favSearch, setFavSearch] = useState<Record<ModelSlot, string>>({
    chat: '',
    vision: '',
    asr: '',
    embed: '',
  });
  // embedModel 走本地草稿：逐键输入只改草稿不弹确认，下拉选择 / 失焦提交时才确认
  const [embedDraft, setEmbedDraft] = useState(settings.embedModel);
  const embedConfirmRef = useRef(false);

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
      message.success(`已更新 ${count} 个模型的能力数据`);
    } catch (e) {
      message.error(`刷新失败：${e instanceof Error ? e.message : String(e)}`);
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
        message.success('所有模型均可用');
      } else {
        message.warning(`有 ${missing.length} 个模型未上架，请从下拉列表选择替代模型`);
      }
    } catch (e) {
      message.error(`检查失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChecking(false);
    }
  };

  /** embedModel 提交点：草稿与已提交值不同才弹确认；确认窗打开会夺走焦点触发 blur，用 ref 抑制重复弹窗 */
  const commitEmbedModel = (draft: string) => {
    if (draft === settings.embedModel || embedConfirmRef.current) return;
    embedConfirmRef.current = true;
    modal.confirm({
      title: '更换向量模型需要重建问答索引',
      content: '将清除所有视频已建立的向量索引，下次提问时自动重建。确定更换？',
      onOk: async () => {
        try {
          await db.embeddings.clear();
          settings.update({ embedModel: draft });
        } finally {
          embedConfirmRef.current = false;
        }
      },
      onCancel: () => {
        setEmbedDraft(settings.embedModel);
        embedConfirmRef.current = false;
      },
    });
  };

  const modelField = (
    name: 'asrModel' | 'llmModel' | 'embedModel' | 'visionModel',
    label: string,
  ) => {
    const isEmbed = name === 'embedModel';
    return (
      <Form.Item
        label={
          <Space size={4}>
            {label}
            {checkResult &&
              (checkResult[name] ? (
                <SuccessCheck />
              ) : (
                <Tag icon={<CloseCircleOutlined />} color="error" />
              ))}
          </Space>
        }
      >
        <AutoComplete
          value={isEmbed ? embedDraft : settings[name]}
          onChange={(v) => {
            if (isEmbed) {
              setEmbedDraft(v);
            } else if (name === 'llmModel') {
              // 切文本模型时按内置表回填上下文窗口默认值（仍可手改）
              settings.update({ llmModel: v, contextWindow: guessContextWindow(v) });
            } else {
              settings.update({ [name]: v });
            }
          }}
          onSelect={isEmbed ? (v: string) => commitEmbedModel(v) : undefined}
          onBlur={isEmbed ? () => commitEmbedModel(embedDraft) : undefined}
          options={modelOptions.map((id) => ({ value: id }))}
          filterOption={(input, opt) => opt!.value.toLowerCase().includes(input.toLowerCase())}
          style={{ width: '100%' }}
        />
      </Form.Item>
    );
  };

  /** 收藏夹单个 tab：搜索筛选 + 相关模型置顶的复选列表 */
  const favTabContent = (slot: ModelSlot) => {
    const kw = favSearch[slot].trim().toLowerCase();
    const relevant = SLOT_RELEVANT[slot];
    const list = modelOptions
      .filter((id) => !kw || id.toLowerCase().includes(kw))
      .sort((a, b) => Number(relevant(b)) - Number(relevant(a)));
    return (
      <>
        <Input
          allowClear
          placeholder="筛选模型"
          value={favSearch[slot]}
          onChange={(e) => setFavSearch((s) => ({ ...s, [slot]: e.target.value }))}
          style={{ marginBottom: 8 }}
        />
        <Checkbox.Group
          value={settings.favorites[slot]}
          onChange={(vals) =>
            settings.update({ favorites: { ...settings.favorites, [slot]: vals.map(String) } })
          }
          options={list.map((id) => ({
            value: id,
            label: (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {id}
                {isVisionModel(id) && (
                  <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
                    多模态
                  </Tag>
                )}
                {supportsThinking(id) && (
                  <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                    可思考
                  </Tag>
                )}
              </span>
            ),
          }))}
          style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflow: 'auto' }}
        />
      </>
    );
  };

  return (
    <div className="page">
      <div className="page-header">
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')} />
        <div className="title">设置</div>
      </div>
      <div className="page-body" style={{ maxWidth: 640, margin: '0 auto', width: '100%' }}>
        <Card title="硅基流动 API" style={{ marginBottom: 16 }}>
          <Form layout="vertical">
            <Form.Item label="API Key" extra="仅保存在本机浏览器 localStorage 中">
              <div className={keyError ? 't-input-wrap is-error' : 't-input-wrap'}>
                <div ref={keyInputRef} className={keyError ? 't-input is-error' : 't-input'}>
                  <Input.Password
                    value={settings.apiKey}
                    status={keyError ? 'error' : ''}
                    onChange={(e) => {
                      clearKeyError();
                      settings.update({ apiKey: e.target.value.trim() });
                    }}
                    placeholder="sk-..."
                  />
                </div>
                <p className="t-error-msg" style={{ margin: '4px 0 0', fontSize: 12, color: '#ff4d4f' }}>
                  请先填写 API Key
                </p>
              </div>
            </Form.Item>
            <Form.Item label="API 地址">
              <Input
                value={settings.baseUrl}
                onChange={(e) => settings.update({ baseUrl: e.target.value.trim() })}
              />
            </Form.Item>
            <Form.Item
              label="字幕转写并发"
              extra="初始并发数（1-12）；转写中遇限流自动减半，稳定后缓慢提升"
            >
              <InputNumber
                min={1}
                max={12}
                value={settings.asrConcurrency}
                onChange={(v) => settings.update({ asrConcurrency: v ?? 4 })}
              />
            </Form.Item>
          </Form>
        </Card>

        <Card
          title="模型配置"
          style={{ marginBottom: 16 }}
          extra={
            <Button type="primary" loading={checking} onClick={handleCheck}>
              检查模型可用性
            </Button>
          }
        >
          <Form layout="vertical">
            {modelField('asrModel', '语音识别（ASR）')}
            {modelField('llmModel', '文本生成（讲义 / 问答）')}
            {modelField('embedModel', '向量（Embedding）')}
            {modelField('visionModel', '视觉（截图理解）')}
            <Form.Item
              label="上下文窗口（tokens）"
              extra={
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span>
                    {metaInfo
                      ? `能力数据源：models.dev（${metaInfo.count} 个模型，${new Date(metaInfo.updatedAt).toLocaleDateString()} 更新）`
                      : '能力数据未拉取，暂用内置启发式兜底'}
                    ；切换文本模型自动填入，可手改
                  </span>
                  <Button size="small" loading={metaRefreshing} onClick={handleRefreshMeta}>
                    刷新能力数据
                  </Button>
                </div>
              }
            >
              <InputNumber
                min={8192}
                step={1024}
                value={settings.contextWindow}
                onChange={(v) => settings.update({ contextWindow: v || 131072 })}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item
              label="问答检索轮次上限"
              extra="每轮检索都会重发已检索内容：轮次越多材料越全，但更慢、更费 token；大窗口模型下 12~20 轮安全。达到上限后会强制收尾作答，不会没有回答"
            >
              <Segmented
                value={settings.agentRounds}
                options={[3, 6, 12, 20]}
                onChange={(v) => settings.update({ agentRounds: v as number })}
              />
            </Form.Item>
          </Form>
        </Card>

        <Card title="模型收藏夹" style={{ marginBottom: 16 }}>
          {modelOptions.length === 0 ? (
            <Typography.Text type="secondary">
              先点击上方「检查模型可用性」拉取模型列表
            </Typography.Text>
          ) : (
            <Tabs
              size="small"
              items={SLOT_TABS.map(({ key, label }) => ({
                key,
                label,
                children: favTabContent(key),
              }))}
            />
          )}
        </Card>

        <StorageCard />

        <SkillsCard />
      </div>
    </div>
  );
}
