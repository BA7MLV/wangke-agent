import { useId, useState } from 'react';
import { Button, Input, Switch } from '@heroui/react';
import { useSettings } from '../../store/settings';
import { Field, SectionCard } from '../../ui';
import {
  SHORTCUT_ACTIONS, defaultShortcutSettings, formatShortcut, recordedShortcut, shortcutConflict,
  type ShortcutAction, type ShortcutSettings,
} from '../../utils/shortcutSettings';

function ShortcutRecorder({ action, label, value, bindings, onChange }: {
  action: ShortcutAction;
  label: string;
  value: string;
  bindings: ShortcutSettings['bindings'];
  onChange: (value: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState('');
  const errorId = useId();
  return (
    <div className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center gap-2">
          <Input
            aria-label={`${label}快捷键`}
            aria-describedby={error ? errorId : undefined}
            aria-invalid={!!error}
            data-testid={`shortcut-${action}`}
            className="w-44 font-mono text-sm"
            readOnly
            value={focused ? '请按下快捷键…' : formatShortcut(value)}
            onFocus={() => { setFocused(true); setError(''); }}
            onBlur={() => { setFocused(false); setError(''); }}
            onKeyDown={(event) => {
              if (event.key === 'Tab') return;
              event.stopPropagation();
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (event.key === 'Escape') { setFocused(false); setError(''); return; }
              if (['Control', 'Alt', 'Meta', 'Shift'].includes(event.key) || event.repeat) return;
              const keys = recordedShortcut(event.nativeEvent);
              if (!keys) { setError('支持字母、空格、方向键、Home / End 和标点，可搭配修饰键；Shift + 数字可用于倍速，单独数字保留用于进度跳转。'); return; }
              const conflict = shortcutConflict(bindings, action, keys);
              if (conflict) { setError(`该按键已用于「${conflict}」，请先清除原绑定或换一个按键。`); return; }
              onChange(keys);
              setError('');
              setFocused(false);
            }}
          />
          <Button size="sm" variant="ghost" aria-label={`清除${label}快捷键`}
            isDisabled={!value} onPress={() => { onChange(''); setError(''); }}>
            清除
          </Button>
        </div>
      </div>
      {error ? <p id={errorId} role="alert" className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}

function SeekStep({ label, testId, value, onChange }: {
  label: string; testId: string; value: number; onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Field label={label} hint="1–120 秒">
      <Input aria-label={label} data-testid={testId} type="number" min={1} max={120} step={1}
        className="w-32 tabular-nums" value={draft ?? String(value)}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const next = Number(text);
          if (text && Number.isInteger(next) && next >= 1 && next <= 120) onChange(next);
        }}
        onBlur={() => {
          if (draft?.trim() && Number.isFinite(Number(draft))) onChange(Number(draft));
          setDraft(null);
        }} />
    </Field>
  );
}

export default function ShortcutsModule() {
  const shortcuts = useSettings((s) => s.shortcuts);
  const update = useSettings((s) => s.update);
  const change = (patch: Partial<ShortcutSettings>) => update({ shortcuts: { ...shortcuts, ...patch } });
  return (
    <>
      <SectionCard title="快捷键" subtitle="自动保存并立即生效。先点击播放器使其获得焦点；输入文字、选择输入法候选字或打开设置时不会触发。" testId="card-shortcuts">
        <Field label="启用播放器快捷键" layout="row">
          <Switch aria-label="启用播放器快捷键" data-testid="shortcuts-enabled" isSelected={shortcuts.enabled}
            onChange={(enabled) => change({ enabled })}>
            <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
          </Switch>
        </Field>
        <div className="flex flex-wrap gap-4">
          {([{ key: 'arrowSeek', label: '小幅快进 / 快退（秒）' }, { key: 'keySeek', label: '大幅快进 / 快退（秒）' }] as const).map(({ key, label }) => (
            <SeekStep key={key} label={label} testId={`shortcut-step-${key}`} value={shortcuts[key]}
              onChange={(value) => change({ [key]: value })} />
          ))}
        </div>
      </SectionCard>
      <SectionCard title="按键配置" subtitle="点击按键框后按下新的按键或组合键，替换该项的全部原绑定。Tab 切换下一项，Esc 取消；清除可停用单项。系统或浏览器可能保留部分组合键。" testId="card-shortcut-bindings">
        <div className="mb-3 flex justify-end">
          <Button variant="secondary" size="sm" data-testid="shortcuts-reset"
            onPress={() => update({ shortcuts: defaultShortcutSettings() })}>恢复默认设置</Button>
        </div>
        {SHORTCUT_ACTIONS.map(({ id, label }) => (
          <ShortcutRecorder key={id} action={id} label={label} value={shortcuts.bindings[id]} bindings={shortcuts.bindings}
            onChange={(value) => change({ bindings: { ...shortcuts.bindings, [id]: value } })} />
        ))}
        <p className="mt-4 text-sm text-muted">默认采用 B 站式操作：播放时长按小幅快进键临时 3 倍速，松开恢复；↑ / ↓ 每次调整 10% 音量。数字键 0–9 跳到视频的 0%–90%；逐帧按约 30 fps 计算，仅暂停时生效。滑块、菜单等控件获得焦点后，方向键优先操作控件本身。</p>
      </SectionCard>
    </>
  );
}
