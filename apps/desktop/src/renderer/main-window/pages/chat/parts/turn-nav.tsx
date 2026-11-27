import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { TURN_BAR_MAX_SCALE, turnBarVisualState, type TurnDot } from '@/renderer/shared/lib/chat-metrics';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/renderer/shared/components/ui/hover-card';
import { cn } from '@/renderer/shared/lib/cn';
import './turn-nav.scss';

/**
 * TurnNav：聊天时间线左侧的轮次导航 rail
 *
 * - 每条 user 提问 = 一根横条，全部轮次按序均匀纵向堆叠（不按消息
 *   高度映射）；rail 垂直居中、自身可纵向滚动（轮次多时不出界）；
 * - 固定行高虚拟滚动（@tanstack/react-virtual，行高 10px、overscan 6）：
 *   目录可达上千条，只挂载 rail 视口与 overscan 内的按钮——每根横条各带
 *   一个 HoverCard，全量挂载会让每次流式更新重渲染上千个 radix Root；
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
 * 动态值（虚拟行 translateY、山峰 opacity/scaleX）走 ref + effect 命令式
 * 注入——UI 纪律：JSX 不留内联样式（同 ContextRing 的 conic 先例）。
 */

const TURN_ANCHOR_ATTR = 'data-turn-uuid';

const RAIL_ROW_PX = 10;
const RAIL_OVERSCAN = 6;

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
  /** 山峰焦点：hover/focus 到的那根；undefined = 无交互，回落 scroll active 色。 */
  const [focusIndex, setFocusIndex] = useState<number | undefined>(undefined);
  const railRef = useRef<HTMLDivElement>(null);
  const getRailScrollElement = useCallback(() => railRef.current, []);
  const getRailItemKey = useCallback((index: number) => items[index]?.id ?? index, [items]);

  const railVirtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => RAIL_ROW_PX,
    getItemKey: getRailItemKey,
    getScrollElement: getRailScrollElement,
    overscan: RAIL_OVERSCAN,
  });
  const virtualRows = railVirtualizer.getVirtualItems();

  // scroll active：视口内最靠上的 user 轮次
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
  // 目录从 tail 一次扩展到上千项时，scrollToIndex 与 virtualizer 的测量
  // 更新处于同一个 commit，Chromium 可能合并 scroll 通知——补发一次只
  // 同步 rail observer，确保活动项对应的可视窗口立即挂载
  useEffect(() => {
    if (activeIndex === null || activeIndex < 0 || items.length < 2) return;
    railVirtualizer.scrollToIndex(activeIndex, { align: 'auto' });
    const element = railRef.current;
    if (!element) return;
    queueMicrotask(() => {
      if (railRef.current !== element) return;
      element.dispatchEvent(new Event('scroll'));
    });
  }, [activeIndex, items.length, railVirtualizer]);

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
      data-item-count={items.length}
      data-rendered-item-count={virtualRows.length}
      className={cn(
        'pointer-events-none absolute inset-y-0 left-3 z-10 w-6 transition-[opacity,transform,visibility] duration-150 ease-out motion-reduce:transition-none',
        className,
      )}
    >
      <div
        ref={railRef}
        onPointerLeave={() => setFocusIndex(undefined)}
        onScroll={() => setFocusIndex(undefined)}
        className="pointer-events-auto absolute left-0 top-1/2 max-h-[calc(100%-6rem)] w-6 -translate-y-1/2 overflow-x-hidden overflow-y-auto py-1"
      >
        <RailSpacer totalSize={railVirtualizer.getTotalSize()}>
          {virtualRows.map((virtualRow) => {
            const item = items[virtualRow.index];
            if (!item) return null;
            return (
              <TurnNavItem
                key={virtualRow.key}
                item={item}
                index={virtualRow.index}
                itemCount={items.length}
                start={virtualRow.start}
                active={virtualRow.index === activeIndex}
                focusIndex={focusIndex}
                onFocus={setFocusIndex}
                onJump={() => jumpTo(item)}
              />
            );
          })}
        </RailSpacer>
      </div>
    </nav>
  );
}

/**
 * 撑高容器：高度 = virtualizer 总尺寸（动态值，命令式注入）。只渲染
 * 可视窗口与 overscan 内的虚拟行，DOM 按钮数不再等于目录总数。
 */
const RailSpacer = memo(function RailSpacer({ totalSize, children }: { totalSize: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.style.height = `${totalSize}px`;
  }, [totalSize]);
  return (
    <div ref={ref} className="relative w-6">
      {children}
    </div>
  );
});

interface TurnNavItemProps {
  item: TurnDot;
  index: number;
  /** Total directory size (aria-setsize — the DOM holds only the virtual window). */
  itemCount: number;
  /** The virtualizer's computed top offset (px). */
  start: number;
  active: boolean;
  focusIndex: number | undefined;
  onFocus: (index: number | undefined) => void;
  onJump: () => void;
}

const TurnNavItem = memo(function TurnNavItem({
  item,
  index,
  itemCount,
  start,
  active,
  focusIndex,
  onFocus,
  onJump,
}: TurnNavItemProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);

  // 虚拟行纵向定位（translateY）命令式注入。
  useEffect(() => {
    if (rowRef.current) rowRef.current.style.transform = `translateY(${start}px)`;
  }, [start]);

  const visual = turnBarVisualState(index, focusIndex ?? null);
  // 无交互焦点且为 scroll active：横条用前景色强调；交互中山峰接管配色。
  const showScrollActiveColor = focusIndex === undefined && active;
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
    // 虚拟行容器：绝对定位 + translateY(start)（上方 effect 注入）；命中区
    // 固定 24×10，入场位移与山峰缩放都在内层，不改变纵向定位。
    <div ref={rowRef} className="absolute left-0 top-0 h-2.5 w-6">
      <HoverCard openDelay={120} closeDelay={80}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            data-nav-index={index}
            aria-current={active ? 'location' : undefined}
            aria-label={`跳到提问 ${index + 1}：${item.preview}`}
            aria-posinset={index + 1}
            aria-setsize={itemCount}
            onClick={onJump}
            onFocus={() => onFocus(index)}
            onBlur={() => onFocus(undefined)}
            onPointerEnter={() => onFocus(index)}
            onPointerLeave={() => onFocus(undefined)}
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
    </div>
  );
});
