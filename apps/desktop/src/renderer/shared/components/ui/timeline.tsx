import type { ReactNode } from 'react';
import { CheckIcon } from 'lucide-react';
import { cn } from '@/renderer/shared/lib/cn';

/**
 * Timeline — 横向的步骤条：一排节点用线段连起来，标出走到哪了。整条居中，
 * 节点之间隔着一段定长的线段，文字居中排在节点正下方。
 * 节点三种状态：已完成（实心 + 对勾）、当前（加粗描边 + 序号）、未到
 * （浅描边 + 序号）；走过的线段是主色，没走的是边框色。纯展示，不处理点击。
 */

export interface TimelineItem {
  key: string;
  /** 节点下方的文字。 */
  label: ReactNode;
  /** 跟在文字后面的补充说明（如「可选」），弱化显示。 */
  hint?: ReactNode;
}

export interface TimelineProps {
  items: readonly TimelineItem[];
  /** 当前走到第几个节点（下标）。 */
  current: number;
  className?: string;
}

type StepState = 'done' | 'current' | 'pending';

/* 状态相关的类名写死在表里：Tailwind 只生成源码里完整出现过的类名。 */
const MARKER: Record<StepState, string> = {
  done: 'border border-primary bg-primary text-primary-foreground',
  current: 'border-2 border-primary bg-background font-semibold text-primary',
  pending: 'border border-border bg-background text-muted-foreground',
};

const LABEL: Record<StepState, string> = {
  done: 'text-foreground',
  current: 'font-medium text-foreground',
  pending: 'text-muted-foreground',
};

export function Timeline({ items, current, className }: TimelineProps) {
  return (
    <ol data-slot="timeline" className={cn('flex justify-center', className)}>
      {items.map((item, i) => {
        const state: StepState = i < current ? 'done' : i === current ? 'current' : 'pending';
        return (
          <li
            key={item.key}
            data-slot="timeline-item"
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
            // 连接线不占排布宽度（见下），所以到下一个节点的间距用外边距补：8 + 128 + 8。
            className={cn('flex flex-col items-center', i < items.length - 1 && 'me-36')}
          >
            {/* 点的外面套一层定位用的盒子：连接线从这里（点的右缘）伸出去。不把它放进
                排布里，标签才会对齐点本身，而不是对齐「点 + 连接线」的整体。 */}
            <span className="relative flex">
              <span
                data-slot="timeline-marker"
                className={cn('flex size-6 shrink-0 items-center justify-center rounded-full text-xs', MARKER[state])}
              >
                {state === 'done' ? <CheckIcon className="size-3.5" /> : i + 1}
              </span>
              {i < items.length - 1 && (
                <span
                  data-slot="timeline-connector"
                  className={cn(
                    'absolute top-1/2 left-full ms-2 h-0.5 w-32 -translate-y-1/2 rounded-full',
                    state === 'done' ? 'bg-primary' : 'bg-border',
                  )}
                />
              )}
            </span>
            {/* 标签这一行宽度记为 0、文字居中溢出：文字不撑宽 li，li 始终和点一样宽，
                到下一个点的间距（上面那个外边距）才不会随文字长短变。 */}
            <div className={cn('mt-2 flex w-0 justify-center text-sm', LABEL[state])}>
              <span className="shrink-0 whitespace-nowrap">
                {item.label}
                {item.hint !== undefined && <span className="ml-1 text-muted-foreground">{item.hint}</span>}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
