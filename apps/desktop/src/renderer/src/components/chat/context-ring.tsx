import { memo } from 'react';
import type { ContextUsage } from '@wayang-ai/protocol';
import { contextPercent, formatTokens } from '../../lib/chat-metrics';
import { cn } from '../../lib/cn';

/**
 * 上下文圆环（§4.3 工作项③）：contextUsage 的环形可视化。SVG token 绘制
 * （stroke-dasharray 进度），>80% 变 destructive 色。
 */
export const ContextRing = memo(function ContextRing({ usage, className }: { usage: ContextUsage | null; className?: string }) {
  const percent = contextPercent(usage);
  if (percent === null) return null;

  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const danger = percent > 80;
  return (
    <span
      className={cn('relative inline-flex size-6 shrink-0 items-center justify-center', className)}
      title={`上下文 ${percent}%（${formatTokens(usage!.usedTokens)}/${formatTokens(usage!.contextWindowTokens)} tokens）`}
    >
      <svg viewBox="0 0 24 24" className="size-6 -rotate-90">
        <circle cx="12" cy="12" r={radius} fill="none" strokeWidth="2.5" className="stroke-primary-border" />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - percent / 100)}
          className={danger ? 'stroke-destructive' : 'stroke-primary'}
        />
      </svg>
      <span className={cn('absolute text-[9px] font-medium', danger ? 'text-destructive' : 'text-primary-strong')}>
        {percent}
      </span>
    </span>
  );
});
