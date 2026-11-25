import { useEffect, useMemo, useState } from 'react';
import { buildTurnDots, type TurnDot } from '../lib/chat-metrics';
import { cn } from '../lib/cn';

/**
 * TurnDotsNav（§4.3 工作项③）：侧边轮次圆点导航。
 *
 * - 数据源只取 user 消息（每条 user 消息 = 一个「轮次锚点」）；
 * - ≤20 圆点滑动窗口（buildTurnDots，纯函数）；
 * - hover 预览（title 提示首行摘要）；
 * - 点击平滑滚动到目标轮次（scrollIntoView smooth）；
 * - IntersectionObserver 联动高亮（视口内最靠上的 user 轮次）。
 *
 * 封装为独立组件：ChatArea 只在布局层给 user 行挂 `data-turn-uuid` 锚点，
 * 气泡渲染组件零改动（不侵入气泡渲染）。
 */

const TURN_ANCHOR_ATTR = 'data-turn-uuid';

export function anchorSelector(uuid: string): string {
  return `[${TURN_ANCHOR_ATTR}="${uuid}"]`;
}

interface TurnDotsNavProps {
  items: readonly TurnDot[];
  /** The scrolling container that holds the turn anchors. */
  scrollContainer: HTMLElement | null;
  className?: string;
}

export function TurnDotsNav({ items, scrollContainer, className }: TurnDotsNavProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // IntersectionObserver highlight: the topmost in-viewport user turn wins.
  useEffect(() => {
    if (!scrollContainer || items.length === 0) return;
    const anchors = items
      .map((item) => scrollContainer.querySelector(anchorSelector(item.id)))
      .filter((el): el is Element => el !== null);
    if (anchors.length === 0) return;
    const visible = new Map<Element, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target, entry.intersectionRatio);
          else visible.delete(entry.target);
        }
        if (visible.size === 0) return;
        // Topmost visible anchor: smallest boundingRect.top.
        let best: Element | null = null;
        let bestTop = Number.POSITIVE_INFINITY;
        for (const el of visible.keys()) {
          const top = el.getBoundingClientRect().top;
          if (top < bestTop) {
            bestTop = top;
            best = el;
          }
        }
        if (best) {
          const uuid = best.getAttribute(TURN_ANCHOR_ATTR);
          const index = items.findIndex((item) => item.id === uuid);
          if (index >= 0) setActiveIndex(index);
        }
      },
      { root: scrollContainer, threshold: [0, 0.25, 0.6] },
    );
    for (const anchor of anchors) observer.observe(anchor);
    return () => observer.disconnect();
  }, [items, scrollContainer]);

  const { dots, total } = useMemo(() => buildTurnDots(items, activeIndex), [items, activeIndex]);
  if (total === 0) return null;

  const scrollTo = (uuid: string): void => {
    const el = scrollContainer?.querySelector(anchorSelector(uuid));
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <nav
      aria-label="轮次导航"
      className={cn('absolute top-1/2 right-2 z-10 flex -translate-y-1/2 flex-col items-center gap-2', className)}
    >
      {dots.map((dot) => (
        <button
          key={dot.id}
          type="button"
          title={dot.preview}
          aria-label={`跳到轮次：${dot.preview}`}
          onClick={() => scrollTo(dot.id)}
          className={cn(
            'size-2 rounded-full transition-all',
            dot.index === activeIndex ? 'scale-125 bg-primary' : 'bg-primary-border hover:bg-primary-strong',
          )}
        />
      ))}
      {total > dots.length && <span className="text-[10px] leading-none text-muted-foreground">{dots[0].index + 1}–{dots[dots.length - 1].index + 1}/{total}</span>}
    </nav>
  );
}
