import * as React from 'react';
import * as HoverCardPrimitive from '@radix-ui/react-hover-card';
import { cn } from '@/renderer/shared/lib/cn';
import './hover-card.scss';

/**
 * shadcn/ui HoverCard（radix hover-card 封装，Tailwind v4 token 体系）。
 * 悬停/聚焦触发的预览卡：`openDelay` / `closeDelay` 控制开合延迟，
 * 内容经 Portal 浮出（不受触发器祖先 overflow 裁切）。
 * 入场淡入走原生 CSS 过渡（样式在 hover-card.scss；仓库未装
 * tw-animate-css，不用 animate-in 一族）。
 * 首个使用方：聊天时间线左侧的轮次导航 rail（hover 横条预览该轮问答）。
 */

export const HoverCard = HoverCardPrimitive.Root;
export const HoverCardTrigger = HoverCardPrimitive.Trigger;

export const HoverCardContent = React.forwardRef<
  React.ComponentRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Content
      ref={ref}
      data-slot="hovercard-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'wayang-hover-card z-50 w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none',
        className,
      )}
      {...props}
    />
  </HoverCardPrimitive.Portal>
))
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName;
