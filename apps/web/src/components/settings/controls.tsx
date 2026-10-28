import { type ReactNode } from 'react';
import { Input, ListBox, Select, Switch } from '@heroui/react';

/**
 * 设置里的行级控件：iOS「设置」的分组行 —— 左边是名字，右边是值或开关，
 * 手机上也保持一行（44pt 起），不把标签挤到控件上面。
 *
 * 只用 HeroUI 组件；不再出现原生 <select> / <input type="checkbox">，
 * 全应用的选择器、开关长得一样，键盘与读屏行为也一样。
 */
export function SettingRow({ label, children, testId }: { label: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 border-b border-border/70 py-2 last:border-b-0" data-testid={testId}>
      <div className="min-w-0 flex-1 text-sm font-medium text-foreground">{label}</div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function SettingSwitch({ label, isSelected, onChange, isDisabled, testId }: {
  label: string;
  isSelected: boolean;
  onChange: (value: boolean) => void;
  isDisabled?: boolean;
  testId?: string;
}) {
  return (
    <SettingRow label={label} testId={testId}>
      <Switch aria-label={label} isSelected={isSelected} onChange={onChange} isDisabled={isDisabled}>
        <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
      </Switch>
    </SettingRow>
  );
}

export interface SelectOption { id: string; label: string }

export function SettingSelect({ label, value, options, onChange, isDisabled, testId }: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  isDisabled?: boolean;
  testId?: string;
}) {
  return (
    <SettingRow label={label} testId={testId}>
      <Select
        aria-label={label}
        className="w-44 max-w-[48vw]"
        selectedKey={value || null}
        isDisabled={isDisabled}
        onSelectionChange={(key) => { if (key != null) onChange(String(key)); }}
      >
        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover>
          <ListBox>
            {options.map((option) => (
              <ListBox.Item key={option.id} id={option.id} textValue={option.label}>{option.label}</ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </SettingRow>
  );
}

export function SettingNumber({ label, value, onChange, min, max, step, isDisabled }: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  isDisabled?: boolean;
}) {
  return (
    <SettingRow label={label}>
      <Input
        aria-label={label}
        type="number"
        inputMode="decimal"
        className="w-32 text-right"
        min={min}
        max={max}
        step={step}
        disabled={isDisabled}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
      />
    </SettingRow>
  );
}
