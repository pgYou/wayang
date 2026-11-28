import * as React from 'react';
import { cn } from '@/renderer/shared/lib/cn';

/**
 * Textarea — 灰底输入面（灰阶填充、悬停加深、聚焦换底色）。高度跟内容走，和
 * Sender 的输入框一个套路：一行时和 Input 等高，内容多了自动长高，长到上限
 * 后在框内滚动。靠 CSS 的 field-sizing 实现，不需要测量；这种模式下原生 rows
 * 不起作用，也不显示拖拽角。
 *
 * 高度按 20px 行高 + 上下 4px 内边距 + 上下 1px 边框算：一行 36px。上限取
 * 150px = 7 整行——整行数的高度（130 / 150 / 170）都不是 4 的倍数，取档位值
 * 会在底边切出半行字，所以这里写具体数值。
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => (
    <textarea
      data-slot="textarea"
      rows={1}
      className={cn(
        'field-sizing-content max-h-[150px] min-h-9 w-full resize-none overflow-y-auto rounded-lg border border-transparent bg-grey-2 px-3 py-1 text-sm text-foreground transition-all outline-none',
        'placeholder:text-muted-foreground hover:bg-grey-3 focus-visible:border-ring focus-visible:bg-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
