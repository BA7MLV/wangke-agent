import { useSettings } from '../store/settings';
import { applyLocale } from './index';
import { normalizeUiLanguage, resolveLocale } from './locale';

/** 在 boot 与首帧之前调用；store -> 引擎单向同步，不在翻译引擎反向导入 store。 */
export function startLocaleSync(): () => void {
  const sync = () => applyLocale(resolveLocale(
    normalizeUiLanguage(useSettings.getState().uiLanguage),
    navigator.languages?.length ? navigator.languages : [navigator.language],
  ));
  sync();
  const unsubscribe = useSettings.subscribe((next, previous) => {
    if (next.uiLanguage !== previous.uiLanguage) sync();
  });
  const onLanguageChange = () => {
    if (useSettings.getState().uiLanguage === 'auto') sync();
  };
  window.addEventListener('languagechange', onLanguageChange);
  return () => {
    unsubscribe();
    window.removeEventListener('languagechange', onLanguageChange);
  };
}
