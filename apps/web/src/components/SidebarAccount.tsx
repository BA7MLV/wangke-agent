import { lazy, Suspense, useState } from 'react';
import { Button, Dropdown, Label } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { cloud } from '../cloud/state';
import { useSettings } from '../store/settings';
import { toast } from '../ui/feedback';
import { Sym } from '../ui/icons';
import { openSettings } from './settingsDialogStore';
import './sidebar-account.css';

const ArchivedSessionsDialog = lazy(() => import('./ArchivedSessionsDialog'));

/** 头像和称呼打开账号菜单；右侧齿轮是独立的设置快捷入口。 */
export default function SidebarAccount({ settingsTestId }: { settingsTestId: string }) {
  const { t } = useTranslation('common');
  const userName = useSettings((s) => s.userName);
  const name = userName || t('account.defaultName');
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const logout = async () => {
    if (loggingOut || !cloud.enabled || cloud.worker) return;
    setLoggingOut(true);
    try {
      const { logoutCloud } = await import('../cloud/logout');
      await logoutCloud();
    } catch (error) {
      toast.error((error as Error).message || t('botHome.logoutFailed'));
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="sidebar-account" data-testid="sidebar-account">
      <Dropdown.Root>
        <Dropdown.Trigger
          className="sidebar-account__trigger"
          aria-label={t('account.menu', { name })}
          isDisabled={loggingOut}
          aria-busy={loggingOut || undefined}
          data-testid="nav-rail-account"
        >
          <span className="sidebar-account__avatar" aria-hidden="true" data-testid="account-avatar">
            {Array.from(name)[0].toLocaleUpperCase()}
          </span>
          <span className="sidebar-account__name" title={name} data-testid="account-name">{name}</span>
        </Dropdown.Trigger>
        <Dropdown.Popover placement="top start" offset={8} className="w-60 max-w-[calc(100vw-24px)] motion-reduce:animate-none">
          <Dropdown.Menu aria-label={t('account.actions')} onAction={(key) => {
            if (key === 'settings') openSettings();
            else if (key === 'archived') setArchivedOpen(true);
            else if (key === 'logout') void logout();
          }}>
            <Dropdown.Item id="settings" textValue={t('settings')} data-testid="account-menu-settings">
              <Sym name="settings" /><Label>{t('settings')}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="archived" textValue={t('account.archived')} data-testid="account-menu-archived">
              <Sym name="archive" /><Label>{t('account.archived')}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="logout" textValue={t('account.logout')} data-testid="account-menu-logout"
              isDisabled={!cloud.enabled || cloud.worker || loggingOut}>
              <Sym name="logout" /><Label>{t('account.logout')}</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <Button isIconOnly variant="ghost" className="sidebar-account__settings"
        aria-label={t('settings')} data-testid={settingsTestId} onPress={() => openSettings()}>
        <Sym name="settings" />
      </Button>
      {archivedOpen && (
        <Suspense fallback={null}>
          <ArchivedSessionsDialog onClose={() => setArchivedOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
