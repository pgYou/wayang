import { memo, useEffect, useRef, useState } from 'react';
import { TURN_BAR_MAX_SCALE, turnBarVisualState, type TurnDot } from '@/renderer/shared/lib/chat-metrics';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/renderer/shared/components/ui/hover-card';
import { cn } from '@/renderer/shared/lib/cn';
import './turn-dots-nav.scss';

/**
 * TurnNav：聊天时间线左侧的轮次导航 rail（交互 1:1 对齐 ZCode
 * ConversationTurnNavigator，见其 docs/ui/conversation-turn-navigator.md）。
 *
 * - 每条 user 提问 = 一根横条，全部轮次按序均匀纵向堆叠（不按消息
 *   高度映射）；rail 垂直居中、自身可纵向滚动（轮次多时不出界）；
 * - 行高 10px、按钮 24×10 连续贴合无 gap——鼠标纵向滑动经过时 hover
 *   不断开；
 * - scroll active（视口内最靠上的 user 轮次）：只改颜色（前景色 +
 *   opacity .9），不改宽度；
 * - hover/focus「山峰」：悬停那根最长最亮（前景色、scaleX 2.6），邻近
 *   1–2 根按距离递减变长（1.7 / 1.25），不做阶梯式颜色渐变；横条固定
 *   左端向右伸长（origin-left），避免居中缩放造成长短错位；
 * - 入场：左移 6px 淡入，180ms ease-out，同批同时入场；只作用于横条的
 *   独立展示层，按钮命中区与纵向定位不动；
 * - hover 卡片：120ms 开 / 80ms 关，右侧弹出——第一段 user 提问，
 *   第二段所属轮次的 assistant 正文摘要；
 * - 少于 2 条提问不显示。
 *
 * 动态值（山峰 opacity/scaleX）走 ref + effect 命令式注入——UI 纪律：
 * JSX 不留内联样式（同 ContextRing 的 conic 先例）。
 */

const TURN_ANCHOR_ATTR = 'data-turn-uuid';

export function anchorSelector(uuid: string): string {
  return `[${TURN_ANCHOR_ATTR}="${uuid}"]`;
}

interface TurnNavProps {
  items: readonly TurnDot[];
  /** The scrolling container that holds the turn anchors. */
  scrollContainer: HTMLElement | null;
  className?: string;
}

export function TurnNav({ items, scrollContainer, className }: TurnNavProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  /** 山峰焦点：hover/focus 到的那根；null = 无交互，回落 scroll active 色。 */
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const railRef = useRef<HTMLDivElement>(null);

  // scroll active：视口内最靠上的 user 轮次（与 ZCode active query 同语义）。
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

  // active 变化时把该条滚入 rail 自身视口（长目录下高亮条始终可见）。
  useEffect(() => {
    if (activeIndex === null) return;
    const rail = railRef.current;
    const el = rail?.querySelector<HTMLElement>(`[data-nav-index="${activeIndex}"]`);
    if (!rail || !el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < rail.scrollTop) rail.scrollTop = top;
    else if (bottom > rail.scrollTop + rail.clientHeight) rail.scrollTop = bottom - rail.clientHeight;
  }, [activeIndex]);

  // rail 滚动或指针离开整条 rail：山峰消失（ZCode onScroll/onPointerLeave）。
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const clear = (): void => setFocusIndex(null);
    rail.addEventListener('scroll', clear, { passive: true });
    rail.addEventListener('pointerleave', clear);
    return () => {
      rail.removeEventListener('scroll', clear);
      rail.removeEventListener('pointerleave', clear);
    };
  }, []);

  if (items.length < 2) return null;

  const jumpTo = (item: TurnDot): void => {
    const el = scrollContainer?.querySelector(anchorSelector(item.id));
    const reduceMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <nav
      aria-label="轮次导航"
      className={cn('pointer-events-none absolute inset-y-0 left-3 z-10 w-6', className)}
    >
      <div
        ref={railRef}
        className="pointer-events-auto absolute left-0 top-1/2 max-h-[calc(100%-6rem)] w-6 -translate-y-1/2 overflow-x-hidden overflow-y-auto py-1"
      >
        {items.map((item, index) => (
          <TurnNavItem
            key={item.id}
            item={item}
            index={index}
            active={index === activeIndex}
            focusIndex={focusIndex}
            onFocus={setFocusIndex}
            onJump={() => jumpTo(item)}
          />
        ))}
      </div>
    </nav>
  );
}

interface TurnNavItemProps {
  item: TurnDot;
  index: number;
  active: boolean;
  focusIndex: number | null;
  onFocus: (index: number | null) => void;
  onJump: () => void;
}

const TurnNavItem = memo(function TurnNavItem({
  item,
  index,
  active,
  focusIndex,
  onFocus,
  onJump,
}: TurnNavItemProps) {
  const barRef = useRef<HTMLSpanElement>(null);
  const visual = turnBarVisualState(index, focusIndex);
  // 无交互焦点且为 scroll active：横条用前景色强调；交互中山峰接管配色。
  const showScrollActiveColor = focusIndex === null && active;
  const peak = visual.colorTone === 'focus';

  // 山峰动态值（opacity / scaleX）命令式注入：仅在相关输入变化时写。
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    el.style.transform = `scaleX(${Math.min(visual.scaleX, TURN_BAR_MAX_SCALE)})`;
    el.style.opacity = String(
      showScrollActiveColor ? 0.9 : item.running ? Math.max(visual.opacity, 0.72) : visual.opacity,
    );
  }, [visual, showScrollActiveColor, item.running]);

  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          data-nav-index={index}
          aria-current={active ? 'location' : undefined}
          aria-label={`跳到提问 ${index + 1}：${item.preview}`}
          aria-posinset={index + 1}
          onClick={onJump}
          onFocus={() => onFocus(index)}
          onBlur={() => onFocus(null)}
          onPointerEnter={() => onFocus(index)}
          onPointerLeave={() => onFocus(null)}
          className="flex h-2.5 w-6 cursor-pointer items-center justify-start rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {/* 展示层独立入场动画（左移 6px 淡入 180ms），命中区与定位不动。 */}
          <span className="wayang-turn-nav-enter block" aria-hidden="true">
            <span
              ref={barRef}
              className={cn(
                'block h-0.5 w-3 origin-left rounded-full transition-[opacity,transform,background-color] duration-150 ease-out motion-reduce:transition-none',
                peak || showScrollActiveColor ? 'bg-foreground' : 'bg-grey-5',
              )}
            />
          </span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" side="right" sideOffset={8} className="w-80 p-3">
        <div className="flex flex-col gap-2">
          <p className="line-clamp-2 whitespace-pre-line text-sm font-medium leading-5">{item.preview}</p>
          <p
            className={cn(
              'line-clamp-3 whitespace-pre-line text-sm leading-5',
              item.assistantPreview ? 'text-popover-foreground/80' : 'text-muted-foreground',
            )}
          >
            {item.assistantPreview ?? (item.running ? '回答生成中…' : '暂无回复')}
          </p>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
});
