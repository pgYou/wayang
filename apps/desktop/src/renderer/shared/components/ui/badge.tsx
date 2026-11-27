import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/renderer/shared/lib/cn';

/**
 * shadcn/ui Badge (new-york, Tailwind v4 token system) with
 * the app's semantic tones mapped onto tokens (success / destructive stay
 * first-class — the chat surface uses them for worker outcomes).
 */
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-md border px-2 py-1 text-xs font-medium [&_svg]:pointer-events-none [&_svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-primary-border bg-primary-soft text-primary-strong',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-destructive/30 bg-destructive-soft text-destructive',
        success: 'border-success/30 bg-success/10 text-success',
        outline: 'border-border bg-background text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

export function Badge({ className, variant, asChild = false, ...props }: BadgeProps) {
  // `React.ElementType` cast: same dual-@types/react hoisting note as Button.
  const Comp = (asChild ? Slot : 'span') as React.ElementType;
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
