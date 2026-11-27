import * as React from 'react';
import { cn } from '@/renderer/shared/lib/cn';
import { fieldSizeClass, type FieldSize } from './field-size';

/**
 * Input — 灰底输入：软灰面 → 悬停加深 → 聚焦换净底 + 边框指示。
 * `fieldSize` 选宽度档（sm/md/lg，默认 lg 整行），见 field-size.ts。
 */
export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'> & { fieldSize?: FieldSize }>(
  ({ className, type, fieldSize = 'lg', ...props }, ref) => (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 min-w-0 rounded-lg border border-transparent bg-grey-2 px-3 py-1 text-sm text-foreground transition-all outline-none',
        'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground',
        'hover:bg-grey-3 focus-visible:border-ring focus-visible:bg-background',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
        fieldSizeClass[fieldSize],
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
