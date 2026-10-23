import { useRef } from 'react';
import { Menu, type MenuInstance } from '@vidstack/react';
import { useDefaultLayoutContext } from '@vidstack/react/player/layouts/default';
import { useSettings } from '../store/settings';
import { Sym } from '../ui/icons';
import { SHORTCUT_ACTIONS, formatShortcut } from '../utils/shortcutSettings';

/** 始终展示当前配置，而不是另存一份可能过期的快捷键说明。 */
export default function PlayerShortcutsMenu() {
  const shortcuts = useSettings((s) => s.shortcuts);
  const { isSmallLayout } = useDefaultLayoutContext();
  const menuRef = useRef<MenuInstance>(null);
  return (
    <Menu.Root ref={menuRef} className="player-shortcuts-menu" onKeyDown={(event) => {
      if (event.key !== 'Escape' || !menuRef.current?.contentElement?.hasAttribute('data-open')) return;
      event.preventDefault();
      event.stopPropagation();
      menuRef.current.close(event.nativeEvent);
    }}>
      <Menu.Button className="vds-menu-button vds-button" aria-label="播放器快捷键" title="快捷键">
        <Sym name="keyboard" />
      </Menu.Button>
      <Menu.Content className="vds-menu-items player-shortcuts-content" placement={isSmallLayout ? 'bottom end' : 'top end'} offset={8}>
        <h3>播放器快捷键</h3>
        {!shortcuts.enabled && <p className="player-shortcuts-notice">快捷键已关闭，可在设置中启用。</p>}
        <p>先点击画面；输入文字时不会触发。</p>
        <dl>
          {SHORTCUT_ACTIONS.filter(({ id }) => shortcuts.bindings[id]).map(({ id, label }) => (
            <div key={id}>
              <dt>{label}{id === 'arrowSeekForward' || id === 'arrowSeekBackward' ? ` ${shortcuts.arrowSeek}s` : id === 'seekForward' || id === 'seekBackward' ? ` ${shortcuts.keySeek}s` : ''}</dt>
              <dd><kbd>{formatShortcut(shortcuts.bindings[id])}</kbd></dd>
            </div>
          ))}
        </dl>
        <p>{shortcuts.bindings.arrowSeekForward ? `播放时长按「${formatShortcut(shortcuts.bindings.arrowSeekForward)}」临时 3 倍速，松开恢复。` : ''}数字 0–9 跳到 0%–90%；Esc 退出全屏。可在设置 → 快捷键中修改。</p>
        <button type="button" role="menuitem" className="vds-menu-item" onClick={(event) => menuRef.current?.close(event.nativeEvent)}>关闭说明</button>
      </Menu.Content>
    </Menu.Root>
  );
}
