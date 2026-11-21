import * as React from 'react';
import { cn } from '../../lib/cn';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full resize-none rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm text-foreground',
        'placeholder:text-muted-foreground/70',
        'focus:border-primary-border focus:outline-none focus:ring-2 focus:ring-primary/25',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
