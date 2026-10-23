/** 界面语言与内容/语音识别语言独立。此模块也可用于迁移与后台任务。 */
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
export type UiLanguage = 'auto' | AppLocale;
export const FALLBACK_LOCALE: AppLocale = 'zh-CN';

export function normalizeUiLanguage(value: unknown, fallback: UiLanguage = FALLBACK_LOCALE): UiLanguage {
  return value === 'auto' || value === 'zh-CN' || value === 'en-US' ? value : fallback;
}

export function resolveLocale(preference: UiLanguage, languages: readonly string[]): AppLocale {
  if (preference !== 'auto') return normalizeUiLanguage(preference) as AppLocale;
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    if (base === 'zh') return 'zh-CN';
    if (base === 'en') return 'en-US';
  }
  return FALLBACK_LOCALE;
}
