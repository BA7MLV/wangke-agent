import { Button } from '@heroui/react';
import { Banner, Sym, toast } from '../ui';
import './subtitle-danmaku.css';

interface Props {
  title: string;
  text: string | null;
  onClose: () => void;
}

/** 失败详情常驻在面板里，关闭前不会像 toast 一样消失（替 antd Alert closable）。 */
export default function PersistentError({ title, text, onClose }: Props) {
  if (!text) return null;

  // 一键复制原文（替 antd Typography.Paragraph copyable）
  const copy = () => {
    void navigator.clipboard?.writeText(text);
    toast.success('报错详情已复制');
  };

  return (
    <Banner
      variant="error"
      icon={<Sym name="error" />}
      title={title}
      testId="persistent-error"
      description={<div className="persistent-error__desc">{text}</div>}
      action={
        <>
          <Button
            isIconOnly
            variant="tertiary"
            size="sm"
            aria-label="复制报错详情"
            data-testid="persistent-error-copy"
            onPress={copy}
          >
            <Sym name="content_copy" />
          </Button>
          <Button
            isIconOnly
            variant="tertiary"
            size="sm"
            aria-label="关闭报错详情"
            data-testid="persistent-error-close"
            onPress={onClose}
          >
            <Sym name="close" />
          </Button>
        </>
      }
    />
  );
}
