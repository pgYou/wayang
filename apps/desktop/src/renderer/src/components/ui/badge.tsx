import * as React from 'react';
import { cn } from '../../lib/cn';

type Tone = 'blue' | 'neutral' | 'success' | 'danger';

const tones: Record<Tone, string> = {
  blue: 'bg-primary-soft text-primary-strong border-primary-border',
  neutral: 'bg-background text-muted-foreground border-border',
  success: 'bg-success/10 text-success border-success/30',
  danger: 'bg-danger-soft text-danger border-danger/30',
};

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
