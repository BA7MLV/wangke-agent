import { Dropdown, Label } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { ResourceFolderColor } from '@wangke/contracts/resources';
import { FOLDER_COLORS } from './FolderIcon';

export default function FolderColorMenu({ color = 'blue', disabled, onChange }: {
  color?: ResourceFolderColor; disabled?: boolean; onChange: (color: ResourceFolderColor) => void;
}) {
  const { t } = useTranslation('projects');
  return <Dropdown.SubmenuTrigger>
    <Dropdown.Item id="folder-color" textValue={t('folderColor')} isDisabled={disabled}>
      <Label>{t('folderColor')}</Label><Dropdown.SubmenuIndicator />
    </Dropdown.Item>
    <Dropdown.Popover><Dropdown.Menu aria-label={t('folderColor')} selectionMode="single" selectedKeys={[color]} onAction={key => {
      const selected = FOLDER_COLORS.find(entry => entry.id === key);
      if (selected && !disabled) onChange(selected.id);
    }}>
      {FOLDER_COLORS.map(entry => <Dropdown.Item key={entry.id} id={entry.id} textValue={t(`colors.${entry.id}`)}>
        <span className="size-4 shrink-0 rounded-full border border-black/10" style={{ backgroundColor: entry.swatch }} aria-hidden="true" />
        <Label>{t(`colors.${entry.id}`)}</Label><Dropdown.ItemIndicator />
      </Dropdown.Item>)}
    </Dropdown.Menu></Dropdown.Popover>
  </Dropdown.SubmenuTrigger>;
}
