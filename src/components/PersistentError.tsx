import { Banner, toast } from '../ui';
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
      icon={<mdui-sym-error />}
      title={title}
      testId="persistent-error"
      description={<div className="persistent-error__desc">{text}</div>}
      action={
        <>
          <mdui-button-icon data-testid="persistent-error-copy" onClick={copy}>
            <mdui-sym-content-copy />
          </mdui-button-icon>
          <mdui-button-icon data-testid="persistent-error-close" onClick={onClose}>
            <mdui-sym-close />
          </mdui-button-icon>
        </>
      }
    />
  );
}
