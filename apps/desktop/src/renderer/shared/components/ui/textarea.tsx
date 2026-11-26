import * as React from 'react';
import { cn } from '@/renderer/shared/lib/cn';

/**
 * Textarea — 灰底输入面（灰阶填充、悬停加深、聚焦换底色）。
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-lg border border-transparent bg-grey-2 px-3 py-2 text-sm text-foreground transition-all outline-none',
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
