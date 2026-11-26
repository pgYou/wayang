import { memo } from 'react';
import type { ContextUsage } from '@wayang-ai/protocol';
import { contextPercent, formatTokens } from '@/renderer/shared/lib/chat-metrics';
import { cn } from '@/renderer/shared/lib/cn';

/**
 * 上下文圆环：contextUsage 的环形可视化。
 * SVG token 绘制（stroke-dasharray 进度），>80% 变 destructive 色。
 */
export const ContextRing = memo(function ContextRing({
  usage,
  className,
}: {
  usage: ContextUsage | null;
  className?: string;
}) {
  const percent = contextPercent(usage);
  const radius = 11;
  const circumference = 2 * Math.PI * radius;
  const resolvedPercent = percent ?? 0;
  const danger = resolvedPercent > 80;
  const label =
    usage && percent !== null
      ? `上下文 ${percent}%（${formatTokens(usage.usedTokens)} / ${formatTokens(usage.contextWindowTokens)} tokens）`
      : '上下文窗口就绪';

  return (
    <span
      className={cn('relative inline-flex size-8 shrink-0 items-center justify-center', className)}
      title={label}
    >
      <svg viewBox="0 0 32 32" className="size-7 -rotate-90">
        <circle cx="16" cy="16" r={radius} fill="none" strokeWidth="2.5" className="stroke-border" />
        {resolvedPercent > 0 && (
          <circle
            cx="16"
            cy="16"
            r={radius}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - resolvedPercent / 100)}
            className={danger ? 'stroke-destructive' : 'stroke-sky'}
          />
        )}
      </svg>
      {percent !== null && percent > 0 && (
        <span className={cn('text-[10px] font-medium', danger ? 'text-destructive' : 'text-muted-foreground')}>
          {percent}%
        </span>
      )}
    </span>
  );
});
