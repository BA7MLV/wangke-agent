import { useId, useState } from 'react';
import { Button, Checkbox, Input } from '@heroui/react';
import { evaluateNouls } from '../../api/typesafe';
import { useSettings, type JevSettings } from '../../store/settings';
import { Field, LoadingButton, SectionCard } from '../../ui';

/** 独立决策连接，不能与生成模型槽位混用。除显式测试外，不在设置页自动发请求。 */
export default function JevCard() {
  const config = useSettings((s) => s.jev);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ config: JevSettings; error: boolean; text: string } | null>(null);
  const update = (patch: Partial<JevSettings>) => {
    const store = useSettings.getState();
    store.update({ jev: { ...store.jev, ...patch } });
    setResult(null);
  };
  const check = async () => {
    setChecking(true);
    setResult(null);
    try {
      await evaluateNouls(config, {
        state: '这是一段用于测试连接的课程学习文本。',
        questions: { connected: { type: 'noul', instructions: '这段文本是否与课程学习有关？' } },
      });
      setResult({ config, error: false, text: '连接成功，已收到有效的决策概率。' });
    } catch (error) {
      setResult({ config, error: true, text: error instanceof Error ? error.message : 'Jev 连接失败' });
    } finally {
      setChecking(false);
    }
  };
  return (
    <SectionCard
      title="Jev 决策模型（可选）"
      subtitle="只负责技能选择与历史筛选，不生成文字，也不替代文本、视觉或语音模型"
      testId="card-jev"
      actions={
        <Button variant="tertiary" aria-expanded={expanded} aria-controls={contentId} onPress={() => setExpanded((value) => !value)} data-testid="btn-toggle-jev">
          {expanded ? '收起' : '展开配置'}
        </Button>
      }
    >
      <div id={contentId} hidden={!expanded}>
      <div className="mb-4 flex justify-end">
        <LoadingButton variant="secondary" loading={checking} onPress={() => void check()} data-testid="btn-check-jev">
          测试 Jev 连接
        </LoadingButton>
      </div>
      <p className="mb-4 text-pretty text-sm text-muted">
        默认关闭。启用技能路由会向 TypeSafe 发送课程名、字幕样本与技能说明；启用上下文压缩会发送当前问题和部分历史对话。
        压缩仅筛选本次请求，不改写原文、不删除聊天记录。连接配置与 Key 仅存本机，不参与云同步或迁移包导出。
      </p>
      <Field label="API 地址" hint="填写包含 /v1 的根地址；浏览器直连需要服务端允许跨域请求">
        <Input className="w-full" aria-label="Jev API 地址" value={config.baseUrl} onChange={(e) => update({ baseUrl: e.target.value.trim() })} />
      </Field>
      <Field label="API Key">
        <Input className="w-full" aria-label="Jev API Key" type="password" autoComplete="off" value={config.apiKey} onChange={(e) => update({ apiKey: e.target.value.trim() })} />
      </Field>
      <Field label="模型 ID" hint="默认固定 jev-1.13.0；更换版本后建议重新评估筛选阈值">
        <Input className="w-full" aria-label="Jev 模型 ID" value={config.model} onChange={(e) => update({ model: e.target.value.trim() })} />
      </Field>
      <div className="flex flex-col gap-3">
        <Checkbox aria-label="讲义技能路由" isSelected={config.skillRouting} onChange={(skillRouting) => update({ skillRouting })} data-testid="jev-skill-routing">
          <Checkbox.Content>
            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
            讲义技能路由
          </Checkbox.Content>
        </Checkbox>
        <Checkbox aria-label="长对话上下文压缩（实验性）" isSelected={config.contextCompression} onChange={(contextCompression) => update({ contextCompression })} data-testid="jev-context-compression">
          <Checkbox.Content>
            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
            长对话上下文压缩（实验性）
          </Checkbox.Content>
        </Checkbox>
      </div>
      <p className="mt-3 text-pretty text-xs text-muted">
        输入预算用满（预留 4096 tokens 回答空间）时自动压缩，也可点击对话框的用量环立即压缩。
        仅高把握可省略的旧轮次会被筛掉；最近两轮不参与语义删除。挂起续跑与中断续写沿用原逻辑。
        不确定或失败时回退；最终仍受上下文窗口预算限制。
      </p>
      {result?.config === config ? (
        <p role={result.error ? 'alert' : 'status'} className={result.error ? 'mt-3 text-sm text-danger' : 'mt-3 text-sm text-success'}>
          {result.text}
        </p>
      ) : null}
      </div>
    </SectionCard>
  );
}
