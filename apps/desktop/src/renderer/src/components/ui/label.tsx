import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '../../lib/cn';

/** shadcn/ui Label (new-york, Tailwind v4 token system — §2.8 决策十一). */
export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    data-slot="label"
    className={cn(
      'flex select-none items-center gap-2 text-sm font-medium leading-none',
      'group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50',
      'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;
