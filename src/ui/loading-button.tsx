/**
 * 带「处理中」态的按钮。
 *
 * HeroUI v3 的 Button 基于 react-aria-components，只有 `isDisabled`，**没有**
 * mdui 那套 `loading` / `isPending`。mdui 迁移过来的调用点大量写着
 * `isLoading={busy}`，语义是「转圈 + 禁用」。这个包装把它补回来：
 *
 * ```tsx
 * <LoadingButton loading={busy} variant="primary" onPress={save}>保存</LoadingButton>
 * ```
 *
 * 约定：
 * - loading 时自动 `isDisabled`，避免重复提交（调用方不用自己写 `|| busy`）；
 * - 只把 children 里**第一个**元素换成 Spinner，纯文本标签保持原样，
 *   这样「图标 + 文案」的按钮在处理中仍然显示文案，用户知道自己在等什么；
 * - 透传其余 Button 属性（含 data-testid，e2e 选择器不受影响）。
 */
import { Button, Spinner, type ButtonProps } from '@heroui/react';
import { Children, isValidElement, type ReactNode } from 'react';

export interface LoadingButtonProps extends Omit<ButtonProps, 'children'> {
  children: ReactNode;
  /** 处理中：禁用按钮并把首个图标换成转圈 */
  loading?: boolean;
}

export function LoadingButton({ children, loading = false, isDisabled, ...rest }: LoadingButtonProps) {
  const content = loading
    ? Children.map(children, (child, i) => {
        // 只替换第一个元素型 child（通常是图标），后面的文案原样保留
        if (i === 0 && isValidElement(child)) {
          return <Spinner key="loading" size="sm" color="current" aria-hidden />;
        }
        return child;
      })
    : children;

  return (
    <Button {...rest} isDisabled={isDisabled || loading}>
      {content}
    </Button>
  );
}