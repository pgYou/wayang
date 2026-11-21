import * as React from 'react';
import { cn } from '../../lib/cn';

type Variant = 'default' | 'outline' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const variants: Record<Variant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary-strong shadow-sm',
  outline: 'border border-primary-border bg-surface text-foreground hover:bg-primary-soft',
  ghost: 'text-muted-foreground hover:bg-primary-soft hover:text-foreground',
  danger: 'bg-danger-soft text-danger border border-danger/30 hover:bg-danger hover:text-white',
};

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-9 px-4 text-sm',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
