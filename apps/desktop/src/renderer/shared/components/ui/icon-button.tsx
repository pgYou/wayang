import * as React from 'react';
import { Button, type ButtonProps } from './button';
import { cn } from '@/renderer/shared/lib/cn';

/**
 * IconButton — 只放一个图标的 Button，把最常见的那种写法收成一行。
 *
 * 「只有图标」在 Button 里是尺寸而不是变体——变体留给颜色样式，两个维度
 * 才能自由组合（24px 的红色删除按钮就是 size="icon-xs" variant="destructive"）。
 * 这里默认 size="icon-xs"；ghost 变体下默认平时次要色、悬停才变正文字色：
 * 图标按钮通常是一排里的次要动作，不该跟内容抢视觉重量。
 *
 * `label` 必填：同时写成 aria-label 和悬停提示——只放图标的按钮不能没有名字。
 */
export interface IconButtonProps extends Omit<ButtonProps, 'size' | 'variant' | 'children'> {
  /** 无障碍名称，同时也是悬停提示（如「编辑」「删除模型 fast」）。 */
  label: string;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  /**
   * 平时次要色、悬停正文字色。默认只在 ghost 变体下开启；其他变体有自己的
   * 颜色（如 destructive 的红），不覆盖。
   */
  quiet?: boolean;
  children: React.ReactNode;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, size = 'icon-xs', variant = 'ghost', quiet, className, children, ...props }, ref) => {
    const isQuiet = quiet ?? variant === 'ghost';
    return (
      <Button
        ref={ref}
        type="button"
        size={size}
        variant={variant}
        aria-label={label}
        title={label}
        className={cn(isQuiet && 'text-muted-foreground hover:text-foreground', className)}
        {...props}
      >
        {children}
      </Button>
    );
  },
);
IconButton.displayName = 'IconButton';
