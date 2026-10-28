import { ListBox, Select } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { normalizeUiLanguage, type UiLanguage } from '../i18n/locale';
import { useSettings } from '../store/settings';

const LANGUAGES = ['auto', 'zh-CN', 'en-US'] as const satisfies readonly UiLanguage[];

/** 登录前和设置共用；语种使用自称，切错语言也能找到切回入口。 */
export default function LanguageSelect() {
  const { t } = useTranslation('common');
  const language = useSettings((s) => s.uiLanguage);
  const update = useSettings((s) => s.update);
  return (
    <Select
      className="w-48 max-w-full"
      data-testid="ui-language-select"
      aria-label={t('language.label')}
      selectedKey={language}
      onSelectionChange={(key) => {
        if (key != null) update({ uiLanguage: normalizeUiLanguage(key) });
      }}
    >
      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      <Select.Popover isNonModal data-testid="ui-language-options">
        <ListBox>
          {LANGUAGES.map((value) => (
            <ListBox.Item key={value} id={value} textValue={t(`language.${value}`)}>
              {t(`language.${value}`)}
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
