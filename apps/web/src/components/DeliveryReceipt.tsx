import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextSwap } from './motion';
import type { DeliveryStatus } from '../pages/botMessages';

const DELIVERY_DELAY = 800;
const DELIVERED_HOLD = 1000;
const READ_DELAY = 600;

/** Delay presentation, never manufacture an acknowledgement or read event. */
export default function DeliveryReceipt({ status, createdAt }: { status: DeliveryStatus; createdAt: number }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState<'sent' | 'read' | null>(() =>
    Date.now() - createdAt > 10_000 && status !== 'sending' ? status : null);
  const deliveredAt = useRef(0);
  useEffect(() => {
    if (status === 'sending' || shown === 'read') return;
    if (!shown) {
      const timer = window.setTimeout(() => {
        deliveredAt.current = Date.now();
        setShown('sent');
      }, DELIVERY_DELAY);
      return () => clearTimeout(timer);
    }
    if (status === 'read') {
      const timer = window.setTimeout(() => setShown('read'), Math.max(READ_DELAY, deliveredAt.current + DELIVERED_HOLD - Date.now()));
      return () => clearTimeout(timer);
    }
  }, [status, shown]);
  return <div className="imsg-receipt" data-status={shown ?? undefined} data-testid="message-receipt" role="status">
    {shown && <TextSwap text={t(shown === 'read' ? 'botHome.read' : 'botHome.delivered')} />}
  </div>;
}
