import { useRef } from 'react';
import { Button, Dropdown, Label, Separator } from '@heroui/react';
import type { NavConfig } from './layout';
import { Sym } from './icons';
import { openSettings } from '../components/settingsDialogStore';

/** Telegram LeftMainHeader: menu/back and search share one persistent top row. */
export function ChatSidebarHeader({ rail, search, onSearch, onNavigate, onCollapse, onDismiss, withSettings }: {
  rail: NavConfig;
  search: string;
  onSearch: (value: string) => void;
  onNavigate?: () => void;
  onCollapse?: () => void;
  onDismiss?: () => void;
  withSettings: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const resetSearch = () => { onSearch(''); inputRef.current?.focus(); };
  return <div className="chat-sidebar__header">
    {search ? <Button isIconOnly variant="ghost" className="chat-sidebar__header-button"
      aria-label="返回会话列表" data-testid="chat-search-back" onPress={resetSearch}>
      <Sym name="arrow_back" />
    </Button> : <Dropdown>
      <Dropdown.Trigger className="chat-sidebar__header-button" aria-label="打开主菜单" data-testid="chat-sidebar-menu">
        <Sym name="menu" />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom start" className="chat-sidebar__menu">
        <Dropdown.Menu aria-label="主导航" onAction={(key) => {
          if (key === 'sidebar-settings') { openSettings(); onNavigate?.(); }
          else if (key === 'sidebar-collapse') onCollapse?.();
          else {
            rail.items.find((item) => item.value === String(key))?.onClick();
            onNavigate?.();
          }
        }}>
          {rail.items.filter((item) => !item.isAction).map((item) => (
            <Dropdown.Item key={item.value} id={item.value} textValue={item.label} data-testid={item.testId}>
              {item.icon}<Label>{item.label}</Label>
              {item.value === rail.value && <span className="chat-sidebar__current" aria-label="当前页面">●</span>}
            </Dropdown.Item>
          ))}
          {(withSettings || onCollapse) && <Separator />}
          {withSettings && <Dropdown.Item id="sidebar-settings" textValue="设置" data-testid="nav-rail-settings">
            <Sym name="settings" /><Label>设置</Label>
          </Dropdown.Item>}
          {onCollapse && <Dropdown.Item id="sidebar-collapse" textValue="收起侧边栏" data-testid="nav-rail-toggle">
            <Sym name="panel_left" /><Label>收起侧边栏</Label>
          </Dropdown.Item>}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>}
    <label className="recent-search">
      <Sym name="search" aria-hidden="true" />
      <input ref={inputRef} type="search" value={search} aria-label="搜索会话" placeholder="搜索会话"
        autoComplete="off" data-testid="chat-search" onChange={(event) => onSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && search) { event.preventDefault(); event.stopPropagation(); resetSearch(); }
        }} />
    </label>
    {onDismiss && <Button isIconOnly variant="ghost" className="chat-sidebar__header-button"
      aria-label="关闭导航" data-testid="nav-rail-close" onPress={onDismiss}><Sym name="close" /></Button>}
  </div>;
}
