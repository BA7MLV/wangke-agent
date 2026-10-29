import { Modal } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { Sym } from '../ui/icons';
import { MODAL_CONTAINER_CLASS } from '../ui/modalContainer';
import { ArchivedSessionsList } from './settings/ArchivedSessionsCard';

/** 从账号菜单直接查看归档，不必先进入设置的数据模块。 */
export default function ArchivedSessionsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('common');
  return (
    <Modal.Root isOpen onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Backdrop>
        <Modal.Container placement="center" className={MODAL_CONTAINER_CLASS}>
          <Modal.Dialog className="max-h-[calc(100%-2rem)] w-[min(40rem,calc(100%-2rem))] max-w-[min(40rem,calc(100%-2rem))]" data-testid="archived-sessions-dialog">
            <Modal.CloseTrigger aria-label={t('account.closeArchived')}><Sym name="close" /></Modal.CloseTrigger>
            <Modal.Header><Modal.Heading>{t('account.archived')}</Modal.Heading></Modal.Header>
            <Modal.Body className="min-h-0 overflow-y-auto overscroll-contain">
              <ArchivedSessionsList />
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}
