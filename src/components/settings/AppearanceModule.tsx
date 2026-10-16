import { ColorSwatchPicker, Switch, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { Check } from 'lucide-react';
import { useSettings, type AppTheme } from '../../store/settings';
import { Field, SectionCard } from '../../ui';
import { ACCENT_COLOR_OPTIONS } from '../../ui/theme';

/**
 * 「外观」模块：主题与阅读时是否联网。
 *
 * 两件事放一起的理由：它们都是「看东西长什么样」的决定，而阅读资源的联网与否
 * 恰好也是这一屏里唯一的隐私相关开关 —— 分到「内容源」会让那个开关更难被想起来。
 */
export default function AppearanceModule() {
  const settings = useSettings();

  return (
    <>
      <SectionCard
        title="外观"
        subtitle="深浅色可跟随系统或手动切换，主题色也可在下方选择"
        testId="card-appearance"
      >
        <Field label="主题" layout="row" testId="field-theme">
          <ToggleButtonGroup
            data-testid="theme-select"
            aria-label="主题"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[settings.theme]}
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (next) settings.update({ theme: next as AppTheme });
            }}
          >
            <ToggleButton id="auto">跟随系统</ToggleButton>
            <ToggleButton id="light">浅色</ToggleButton>
            <ToggleButton id="dark">深色</ToggleButton>
          </ToggleButtonGroup>
        </Field>
        <Field
          label="主题色"
          layout="row"
          hint="更改按钮、选中项和焦点提示的强调色"
          testId="field-accent-color"
        >
          <ColorSwatchPicker
            aria-label="主题色"
            data-testid="accent-color-picker"
            value={
              ACCENT_COLOR_OPTIONS.find(({ id }) => id === settings.accentColor)?.value ??
              ACCENT_COLOR_OPTIONS[0].value
            }
            onChange={(color) => {
              const value = color.toString('hex').toLowerCase();
              const next = ACCENT_COLOR_OPTIONS.find((option) => option.value === value);
              if (next) settings.update({ accentColor: next.id });
            }}
          >
            {ACCENT_COLOR_OPTIONS.map(({ id, label, value }) => (
              <ColorSwatchPicker.Item key={id} color={value} aria-label={label}>
                <ColorSwatchPicker.Swatch />
                <ColorSwatchPicker.Indicator>
                  <Check aria-hidden="true" />
                </ColorSwatchPicker.Indicator>
              </ColorSwatchPicker.Item>
            ))}
          </ColorSwatchPicker>
        </Field>
        <Field
          label="动态取色"
          layout="row"
          hint="从课程封面（抽帧里的幻灯片帧）提取主色，让播放页的配色随课程变化。取不到封面时自动用默认配色"
          testId="field-dynamic-color"
        >
          <Switch
            data-testid="dynamic-color"
            aria-label="动态取色"
            isSelected={settings.dynamicColor}
            onChange={(on) => settings.update({ dynamicColor: on })}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        </Field>
      </SectionCard>

      <SectionCard
        title="阅读材料"
        subtitle="只影响 HTML 材料；PDF / Word / Markdown 的材料都在文件里，不涉及联网"
        testId="card-material"
      >
        <Field
          label="HTML 联网加载外部资源"
          layout="row"
          hint="按原文档的样子渲染 HTML 时，它引用的远程图片 / 样式表 / 字体会被加载。关掉后完全离线：只放行文档内嵌的资源，外部引用一律跳过并在阅读器顶部说明。两种情况下脚本都不会执行"
          testId="field-html-remote"
        >
          <Switch
            data-testid="html-remote-assets"
            aria-label="HTML 联网加载外部资源"
            isSelected={settings.htmlRemoteAssets}
            onChange={(on) => settings.update({ htmlRemoteAssets: on })}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        </Field>
      </SectionCard>
    </>
  );
}
