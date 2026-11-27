import { type ReactNode } from 'react';
import { cn } from '@/renderer/shared/lib/cn';

/**
 * Collapse — 折叠/展开容器：`grid-template-rows: 0fr → 1fr` 高度缓动，
 * 无需测量内容高度。内容常驻 DOM（overflow-hidden 裁切），外边距请内聚到
 * children 的最内层元素上，收起时随裁切一起消失。
 */
export function Collapse({
  open,
  children,
  className,
}: {
  /** 展开 / 收起。 */
  open: boolean;
  children: ReactNode;
  /** 透传到动画外层（语义类名 / 附加布局类）。 */
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-300 ease-in-out',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        className,
      )}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}
