import { useState, useCallback, useEffect, useRef } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { cn } from '@/renderer/shared/lib/cn';
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
 * Thinking — 可折叠思考过程展示，支持 loading 态、自定义 title。
 *
 * 折叠逻辑：
 * - 用户未操作过：按 defaultExpanded 决定初始状态；loading→true 时自动展开；loading→false（reasoning 结束）时自动收起
 * - 用户操作过（点击了折叠/展开）：始终以用户操作结果为准，不再自动收起/展开
 */
export function Thinking({
  children,
  title,
  loading = false,
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

  const hasContent = children !== undefined && children !== null && children !== '';
  if (!hasContent && !loading) return null;

  const loadingContent: React.ReactNode =
    loading === true ? <LoadingDots /> : loading || null;

  const resolvedTitle = title ?? (loading ? '深度思考中…' : '已深度思考');

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
