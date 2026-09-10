import { Alert, Typography } from 'antd';

interface Props {
  title: string;
  text: string | null;
  onClose: () => void;
}

/** 失败详情常驻在面板里，关闭前不会像 toast 一样消失。 */
export default function PersistentError({ title, text, onClose }: Props) {
  if (!text) return null;
  return (
    <Alert
      type="error"
      showIcon
      closable
      onClose={onClose}
      message={title}
      description={
        <Typography.Paragraph
          copyable={{ text }}
          style={{ whiteSpace: 'pre-wrap', userSelect: 'text', marginBottom: 0, maxHeight: 240, overflow: 'auto' }}
        >
          {text}
        </Typography.Paragraph>
      }
      style={{ marginBottom: 12, flexShrink: 0 }}
    />
  );
}
