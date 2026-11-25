import * as React from 'react';
import { cn } from '../../lib/cn';

/** shadcn/ui Skeleton (Tailwind v4 token system — §2.8 决策十一). */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="skeleton" className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}
