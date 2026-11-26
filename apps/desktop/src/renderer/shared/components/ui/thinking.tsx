import { useState, useCallback, useEffect, useRef } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { cn } from '@/renderer/shared/lib/cn';
import { formatDuration } from '@/renderer/shared/lib/chat-metrics';
import { Collapse } from '@/renderer/shared/components/ui/collapse';
import './thinking.scss';

/**
 * LoadingDots — 跳动圆点加载指示器。
 */
export function LoadingDots({ className }: { className?: string }) {
  return (
    <div
      className={cn('wayang-loading-dots flex items-center gap-1 py-1', className)}
      aria-label="Loading"
    >
      <span className="inline-block size-1.5 animate-[pulse-dot_1.4s_ease-in-out_infinite] rounded-full bg-grey-6" />
      <span className="inline-block size-1.5 animate-[pulse-dot_1.4s_ease-in-out_0.2s_infinite] rounded-full bg-grey-6" />
      <span className="inline-block size-1.5 animate-[pulse-dot_1.4s_ease-in-out_0.4s_infinite] rounded-full bg-grey-6" />
    </div>
  );
}

export type ThinkingSemanticDOM = 'root' | 'header' | 'content';

export interface ThinkingProps {
  /** 思考内容 */
  children?: React.ReactNode;
  /** 状态标题文本（如 "深度思考中…"） */
  title?: React.ReactNode;
  /** 加载中状态 — true 展示默认加载动画，ReactNode 则自定义 */
  loading?: boolean | React.ReactNode;
  /**
   * 思考开始时刻（epoch ms）。进行中每秒重算「思考中 Xs」；晚挂载也不
   * 漂移（起点来自数据而非 mount 时间）。
   */
  startedAt?: number;
  /**
   * 完成态时长（entry `timing.durationMs`）。已知时「已思考 Xs」显示它
   * （历史会话直接可用）；未知（旧数据无 timing）降级为不带秒数的文案。
   */
  durationMs?: number;
  /** 默认是否展开（非受控） */
  defaultExpanded?: boolean;
  /** 是否展开（受控） */
  expanded?: boolean;
  /** 展开/折叠回调 */
  onExpand?: (expanded: boolean) => void;
  /** 语义化节点 className */
  classNames?: Partial<Record<ThinkingSemanticDOM, string>>;
  /** 根节点 className */
  className?: string;
}

/**
 * 思考耗时状态机：
 * - 进行中（active）：elapsed = now - startedAt（缺省 mount 时刻），1s 间隔 tick；
 * - 同一 mount 内 active→false：定时器已停，定格在最后的 tick；若此刻
 *   durationMs（权威记录）已到，覆盖为它；
 * - 挂载即完成态：elapsed = durationMs（无则 null——不显示秒数）。
 */
function useThinkingElapsed(active: boolean, startedAt?: number, durationMs?: number): number | null {
  const [elapsed, setElapsed] = useState<number | null>(() =>
    active ? 0 : durationMs !== undefined ? durationMs : null,
  );
  const startRef = useRef(startedAt ?? Date.now());

  useEffect(() => {
    if (!active) return;
    const tick = (): void => setElapsed(Date.now() - startRef.current);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active]);

  // Same-mount completion: prefer the recorded duration over the last tick.
  const prevActiveRef = useRef(active);
  useEffect(() => {
    if (prevActiveRef.current && !active && durationMs !== undefined) {
      setElapsed(durationMs);
    }
    prevActiveRef.current = active;
  }, [active, durationMs]);

  return elapsed;
}

/**
 * Thinking — 可折叠思考过程展示，支持 loading 态、自定义 title。
 *
 * 折叠逻辑：
 * - 用户未操作过：按 defaultExpanded 决定初始状态；loading→true 时自动展开；loading→false（reasoning 结束）时自动收起
 * - 用户操作过（点击了折叠/展开）：始终以用户操作结果为准，不再自动收起/展开
 *
 * 默认标题带耗时：进行中「思考中 Xs」（每秒更新），完成「已思考 Xs」
 * （durationMs 未知的历史数据退化为「已思考」）。显式 title 传入时完全优先。
 */
export function Thinking({
  children,
  title,
  loading = false,
  startedAt,
  durationMs,
  defaultExpanded,
  expanded: expandedProp,
  onExpand,
  classNames = {},
  className,
}: ThinkingProps) {
  const isControlled = expandedProp !== undefined;
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const expanded = isControlled ? expandedProp : internalExpanded;

  const userInteractedRef = useRef(false);

  useEffect(() => {
    if (isControlled || userInteractedRef.current) return;

    if (loading) {
      if (!expanded) {
        setInternalExpanded(true);
        onExpand?.(true);
      }
    } else {
      if (expanded) {
        setInternalExpanded(false);
        onExpand?.(false);
      }
    }
  }, [loading]);

  const toggleExpand = useCallback(() => {
    userInteractedRef.current = true;
    const next = !expanded;
    if (!isControlled) {
      setInternalExpanded(next);
    }
    onExpand?.(next);
  }, [expanded, isControlled, onExpand]);

  // 耗时状态机（hook 必须先于下面的条件 return）。
  const elapsed = useThinkingElapsed(Boolean(loading), startedAt, durationMs);

  const hasContent = children !== undefined && children !== null && children !== '';
  if (!hasContent && !loading) return null;

  const loadingContent: React.ReactNode =
    loading === true ? <LoadingDots /> : loading || null;

  // 默认标题：进行中「思考中 Xs」（每秒更新）；完成「已思考 Xs」——历史
  // 数据无 timing（elapsed=null）时退化为不带秒数的「已思考」。
  const defaultTitle = loading
    ? `思考中 ${formatDuration(elapsed ?? 0)}`
    : elapsed !== null
      ? `已思考 ${formatDuration(elapsed)}`
      : '已思考';
  const resolvedTitle = title ?? defaultTitle;

  return (
    <div
      className={cn(
        'wayang-thinking rounded-lg',
        className,
        classNames.root,
      )}
    >
      {/* Header — 可点击折叠/展开 */}
      <button
        type="button"
        className={cn(
          'wayang-thinking-header flex h-6 cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground',
          classNames.header,
        )}
        onClick={toggleExpand}
        aria-expanded={expanded}
      >
        <ChevronRightIcon
          className={cn(
            'size-3.5 shrink-0 transition-transform duration-200',
            expanded && 'rotate-90',
          )}
        />
        <span className="select-none">{resolvedTitle}</span>
      </button>

      {/* Content — 折叠/展开 */}
      <Collapse open={expanded ?? false} className="wayang-thinking-content">
        <div
          className={cn(
            'mx-2 mb-2 rounded-sm border-l-2 border-border/60 bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground',
            classNames.content,
          )}
        >
          {hasContent && children}
          {loading && loadingContent}
        </div>
      </Collapse>
    </div>
  );
}
