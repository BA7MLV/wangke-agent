import { ColorSwatchPicker, Switch, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { useSettings, type AppTheme, type FontScale } from '../../store/settings';
import { Field, SectionCard, Sym } from '../../ui';
import { ACCENT_COLOR_OPTIONS, FONT_SCALE_OPTIONS } from '../../ui/theme';
import { useTranslation } from 'react-i18next';
import LanguageSelect from '../LanguageSelect';

/**
 * 「外观」模块：主题与阅读时是否联网。
 *
 * 两件事放一起的理由：它们都是「看东西长什么样」的决定，而阅读资源的联网与否
 * 恰好也是这一屏里唯一的隐私相关开关 —— 分到「内容源」会让那个开关更难被想起来。
 */
export default function AppearanceModule() {
  const settings = useSettings();
  const { t } = useTranslation('settings');
  const { t: common } = useTranslation('common');

  return (
    <>
      <SectionCard
        title={t('appearance.title')}
        testId="card-appearance"
      >
        <Field label={common('language.label')} layout="row" testId="field-ui-language">
          <LanguageSelect />
        </Field>
        <Field label={t('appearance.theme')} layout="row" testId="field-theme">
          <ToggleButtonGroup
            className="max-w-full flex-wrap"
            data-testid="theme-select"
            aria-label={t('appearance.theme')}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[settings.theme]}
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (next) settings.update({ theme: next as AppTheme });
            }}
          >
            <ToggleButton id="auto">{t('appearance.themes.auto')}</ToggleButton>
            <ToggleButton id="light">{t('appearance.themes.light')}</ToggleButton>
            <ToggleButton id="dark">{t('appearance.themes.dark')}</ToggleButton>
          </ToggleButtonGroup>
        </Field>
        <Field
          label={t('appearance.fontScale')}
          layout="row"
          testId="field-font-scale"
        >
          <ToggleButtonGroup
            className="max-w-full flex-wrap"
            data-testid="font-scale-select"
            aria-label={t('appearance.fontScaleLabel')}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[settings.fontScale]}
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (next) settings.update({ fontScale: next as FontScale });
            }}
          >
            {FONT_SCALE_OPTIONS.map(({ id }) => (
              <ToggleButton key={id} id={id}>
                {t(`appearance.fontScales.${id}`)}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Field>
        <Field
          label={t('appearance.accentColor')}
          layout="row"
          testId="field-accent-color"
        >
          <ColorSwatchPicker
            aria-label={t('appearance.accentColor')}
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
            {ACCENT_COLOR_OPTIONS.map(({ id, value }) => (
              <ColorSwatchPicker.Item key={id} color={value} aria-label={t(`appearance.accentColors.${id}`)}>
                <ColorSwatchPicker.Swatch />
                <ColorSwatchPicker.Indicator>
                  <Sym name="check" size={24} />
                </ColorSwatchPicker.Indicator>
              </ColorSwatchPicker.Item>
            ))}
          </ColorSwatchPicker>
        </Field>
        <Field
          label={t('appearance.dynamicColor')}
          layout="row"
          testId="field-dynamic-color"
        >
          <Switch
            data-testid="dynamic-color"
            aria-label={t('appearance.dynamicColor')}
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
        title={t('reading.title')}
        testId="card-material"
      >
        <Field
          label={t('reading.remoteAssets')}
          layout="row"
          testId="field-html-remote"
        >
          <Switch
            data-testid="html-remote-assets"
            aria-label={t('reading.remoteAssets')}
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
