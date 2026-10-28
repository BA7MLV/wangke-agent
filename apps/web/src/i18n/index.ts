import { createInstance, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { FALLBACK_LOCALE, SUPPORTED_LOCALES, type AppLocale } from './locale';
import { resources } from './resources';

const i18n: I18n = createInstance();
// 只有本地资源，没有异步 backend；导入后即可翻译启动错误。
void i18n.use(initReactI18next).init({
  resources,
  lng: FALLBACK_LOCALE,
  fallbackLng: FALLBACK_LOCALE,
  supportedLngs: [...SUPPORTED_LOCALES],
  load: 'currentOnly',
  defaultNS: 'common',
  ns: ['common', 'settings', 'projects'],
  initAsync: false,
  interpolation: { escapeValue: false }, // 文本转义交给 React，译文不作为 HTML 注入。
  react: { useSuspense: false },
});

export function applyLocale(locale: AppLocale): void {
  if (i18n.language !== locale) void i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = i18n.dir(locale);
  document.title = i18n.t('appTitle');
}

export default i18n;
