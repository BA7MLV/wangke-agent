import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dropdown, cn } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { Sym } from '../ui';
import { useAppNav } from './appNav';
import { openSettings } from './settingsDialogStore';
import './mode-shell.css';

/*
 * 云端模式的两个主模式：「聊天」和「项目」。
 *   - 宽屏：左边一条很窄的竖栏，只有这两个入口，底部一颗「…」收着课程问答、资料、设置；
 *   - 手机：竖栏不出现，由页面在自己的顶栏里放 <ModeSwitch>（分段控件）和 <AppMenu>。
 * 课程问答和资料仍然能去，只是不再占主导航。
 */
export type AppMode = 'chat' | 'projects';

export interface MenuAction { key: string; label: string; icon: ReactNode; danger?: boolean; disabled?: boolean; onAction: () => void }

/** 「…」菜单。不常用的操作都收在这里，界面上只留一颗圆形按钮。 */
export function MoreMenu({ label, actions, testId, className }: { label: string; actions: MenuAction[]; testId?: string; className?: string }) {
  return (
    <Dropdown>
      <Button isIconOnly variant="ghost" className={cn('ms-icon-btn', className)} aria-label={label} data-testid={testId}>
        <Sym name="more_horiz" />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={label}
          disabledKeys={actions.filter(a => a.disabled).map(a => a.key)}
          onAction={(key) => actions.find(a => a.key === String(key))?.onAction()}
        >
          {actions.map(action => (
            <Dropdown.Item key={action.key} id={action.key} textValue={action.label} variant={action.danger ? 'danger' : undefined}>
              <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">{action.icon}</span>
              {action.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** 课程问答 / 资料 / 设置：不是主模式，但随时够得着。 */
export function useAppMenuActions(): MenuAction[] {
  const { t } = useTranslation();
  const nav = useAppNav('bot');
  const course = nav.items.find(item => item.value === 'chat');
  const library = nav.items.find(item => item.value === 'home');
  return [
    ...(course ? [{ key: 'course', label: t('botHome.nav.course'), icon: <Sym name="forum" />, onAction: course.onClick }] : []),
    ...(library ? [{ key: 'library', label: t('botHome.nav.library'), icon: <Sym name="video_library" />, onAction: library.onClick }] : []),
    { key: 'settings', label: t('botHome.settings'), icon: <Sym name="settings" />, onAction: () => openSettings() },
  ];
}

/** 顶部分段控件：聊天 | 项目。手机上用。 */
export function ModeSwitch({ mode }: { mode: AppMode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="ms-switch" role="group" aria-label={t('botHome.nav.label')}>
      {(['chat', 'projects'] as const).map(item => (
        <Button key={item} size="sm" variant="ghost" aria-pressed={mode === item} className="ms-switch__item"
          data-active={mode === item || undefined} data-testid={`mode-${item}`}
          onPress={() => { if (mode !== item) navigate(item === 'chat' ? '/' : '/projects'); }}>
          {t(item === 'chat' ? 'botHome.nav.chat' : 'botHome.nav.projects')}
        </Button>
      ))}
    </div>
  );
}

/** 只有「课程问答 / 资料 / 设置」再加页面自己的几项。 */
export function AppMenu({ extra = [], className }: { extra?: MenuAction[]; className?: string }) {
  const { t } = useTranslation();
  const app = useAppMenuActions();
  return <MoreMenu label={t('botHome.more')} actions={[...extra, ...app]} testId="app-menu" className={className} />;
}

export default function ModeShell({ mode, children }: { mode: AppMode; children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const app = useAppMenuActions();
  const items = [
    { mode: 'chat' as const, icon: 'chat_bubble' as const, label: t('botHome.nav.chat'), to: '/' },
    { mode: 'projects' as const, icon: 'folder' as const, label: t('botHome.nav.projects'), to: '/projects' },
  ];
  return (
    <div className="ms">
      <nav className="ms-rail" aria-label={t('botHome.nav.label')} data-testid="mode-rail">
        {items.map(item => (
          <Button key={item.mode} variant="ghost" className="ms-rail__item" aria-current={mode === item.mode ? 'page' : undefined}
            data-active={mode === item.mode || undefined} onPress={() => navigate(item.to)}>
            <span className="ms-rail__icon" aria-hidden="true"><Sym name={item.icon} /></span>
            <span className="ms-rail__label">{item.label}</span>
          </Button>
        ))}
        <div className="flex-1" />
        <MoreMenu label={t('botHome.more')} actions={app} testId="mode-rail-more" />
      </nav>
      <div className="ms-main">{children}</div>
    </div>
  );
}
