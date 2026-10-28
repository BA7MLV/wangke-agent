import { type ReactNode } from 'react';
import { Button, Dropdown, cn } from '@heroui/react';
import { Sym } from './icons';

export interface MenuAction { key: string; label: string; icon: ReactNode; danger?: boolean; disabled?: boolean; onAction: () => void }

/**
 * 「…」菜单：不常用的操作收进一颗圆形按钮（HIG：More 按钮 + pull-down menu）。
 * 全应用只有这一份实现，聊天页、Bot 栏和项目页共用。
 */
export function MoreMenu({ label, actions, testId, className }: { label: string; actions: MenuAction[]; testId?: string; className?: string }) {
  if (!actions.length) return null;
  return (
    <Dropdown>
      <Button isIconOnly variant="ghost" className={cn('rounded-full', className)} aria-label={label} data-testid={testId}>
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
