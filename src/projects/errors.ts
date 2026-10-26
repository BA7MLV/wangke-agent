import i18n from '../i18n';
import { ServerApiError } from '../api/serverClient';
import messages from '../i18n/locales/zh-CN/projects.json';

export function projectError(error: unknown): string {
  if (error instanceof ServerApiError) {
    if (error.status === 401 || error.code === 'http_404') return i18n.t('projects:serverRequired');
    if (Object.hasOwn(messages.errors, error.code)) return i18n.t(`projects:errors.${error.code as keyof typeof messages.errors}`);
  }
  return i18n.t('projects:error');
}
