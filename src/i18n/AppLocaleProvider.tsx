import { useSyncExternalStore, type ReactNode } from 'react';
import { I18nProvider as HeroI18nProvider } from '@heroui/react';
import { I18nextProvider } from 'react-i18next';
import i18n from './index';
import { FALLBACK_LOCALE } from './locale';

function subscribe(onChange: () => void) {
  i18n.on('languageChanged', onChange);
  return () => { i18n.off('languageChanged', onChange); };
}
const getLocale = () => i18n.resolvedLanguage ?? FALLBACK_LOCALE;

/** 同一棵 React 树更新 locale，不以语言为 key 重挂载应用。 */
export default function AppLocaleProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return (
    <I18nextProvider i18n={i18n}>
      <HeroI18nProvider locale={locale}>{children}</HeroI18nProvider>
    </I18nextProvider>
  );
}
