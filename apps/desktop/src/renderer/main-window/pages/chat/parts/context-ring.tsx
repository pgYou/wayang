import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ContextUsage } from '@wayang-ai/protocol';
import { contextPercent, formatTokens } from '@/renderer/shared/lib/chat-metrics';
import { cn } from '@/renderer/shared/lib/cn';

/**
 * 轻量 popover 关闭逻辑：点击外部 / Esc 收起。无 radix 依赖——这里是
 * 只读数值展示（无焦点管理、无嵌套浮层需求），自实现保持 ui 最小面。
 */
function usePopoverDismiss(
  open: boolean,
  close: () => void,
  anchorRef: React.RefObject<HTMLElement | null>,
): { popoverRef: React.RefObject<HTMLDivElement | null> } {
  const popoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close, anchorRef]);
  return { popoverRef };
}

/** popover 行：标签 + 数值（等宽数字右对齐）。 */
function MetricRow({ label, value, tone }: { label: ReactNode; value: string; tone?: 'destructive' | 'muted' }) {
  return (
    <div className="flex items-center justify-between gap-6 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-mono tabular-nums',
          tone === 'destructive' ? 'text-destructive' : tone === 'muted' ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * 上下文圆环：contextUsage 的环形可视化 + 点击弹出明细 popover。
 * - DOM 实现（conic-gradient 双层圆，无 SVG）：外层 18px 圆按 percent
 *   从 12 点方向分色画进度，内层 12px 圆挖洞形成 3px 环；>80% 进度色
 *   变 destructive；
 * - 点击（Esc/再次点击关闭）展示纯数值：占用百分比、已用/窗口上限
 *   tokens（estimate 来源走 muted 色阶表达）、按组 breakdown（用户
 *   消息 / 助手输出 / 工具调用参数 / 工具返回 / 压缩摘要）——浮层内
 *   不放解释性文案；
 * - usage 为 null（未就绪）时不可点、仅占位。
 */
export function ContextRing({ usage, className }: { usage: ContextUsage | null; className?: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = (): void => setOpen(false);

  const percent = contextPercent(usage);
  const resolvedPercent = percent ?? 0;
  const danger = resolvedPercent > 80;

  // popover 经 Portal 挂 body 并按触发器实测位置定位：sender 根容器
  // overflow-hidden（squircle 裁切）会截掉任何从卡片内弹出的层——
  // portal 从裁剪链解耦，弹层完整可见。锚点坐标是动态测量值，与 conic
  // 同款走命令式注入（JSX 不留内联样式）。
  const [anchorRect, setAnchorRect] = useState<{ top: number; right: number } | null>(null);
  const { popoverRef } = usePopoverDismiss(open, close, triggerRef);
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setAnchorRect({ top: rect.top, right: window.innerWidth - rect.right });
  }, [open]);
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el || !anchorRect) return;
    el.style.top = `${anchorRect.top}px`;
    el.style.right = `${anchorRect.right}px`;
    el.style.transform = 'translateY(-100%)';
  }, [anchorRect, open]);

  // conic 进度是运行时数据（percent/danger），按 user-row 折叠 max-height
  // 的先例走命令式 el.style（UI 纪律：JSX 里静态样式一律 class，动态值
  // 才允许命令式注入）。0%/轨道色也经 effect 落，不与任何静态 bg 类竞争。
  // 低占用保底：弧段不足 6% 时视觉不可辨（3px 环带 × 7°≈1px）——下限 6%。
  // 轨道用淡蓝（sky-soft，用户气泡同款）：灰轨道与灰底 sender 融为一体，
  // 淡蓝既标出环的存在又不抢进度弧。
  const arcRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = arcRef.current;
    if (!el) return;
    const arcPercent = resolvedPercent > 0 ? Math.max(resolvedPercent, 6) : 0;
    el.style.background =
      arcPercent > 0
        ? `conic-gradient(${danger ? 'var(--destructive)' : 'var(--sky)'} ${arcPercent}%, var(--sky-soft) ${arcPercent}%)`
        : 'var(--sky-soft)';
  }, [resolvedPercent, danger]);

  const label =
    usage && percent !== null
      ? `上下文 ${percent}%（${formatTokens(usage.usedTokens)} / ${formatTokens(usage.contextWindowTokens)} tokens）`
      : '上下文窗口就绪';

  const breakdownRows: Array<[string, number]> = usage?.breakdown
    ? [
      ['用户消息', usage.breakdown.user],
      ['助手输出', usage.breakdown.assistant],
      ['工具调用参数', usage.breakdown.toolCalls],
      ['工具返回结果', usage.breakdown.toolResults],
      ['压缩摘要', usage.breakdown.compactSummary],
    ]
    : [];

  return (
    <span className={cn('relative inline-flex size-10 shrink-0 items-center justify-center', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        disabled={!usage}
        onClick={(): void => {
          if (usage) setOpen((v) => !v);
        }}
        className="group/ring relative inline-flex h-6 cursor-pointer items-center gap-1 rounded-full px-1 outline-none transition-colors hover:bg-grey-3 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default"
      >
        {/* DOM 环（conic-gradient，无 SVG）：外层 18px 圆从 12 点方向按
            percent 分色（arcRef 命令式注入，见上）；内层 12px 圆挖洞
            （卡片同色背景）形成 3px 环。0% 时整环为轨道色。
            环 18px 装不下数字——环与 n% 水平相邻（图标+标签形态）；
            两圆 inset-0 在 18px wrapper 内居中（absolute 无 inset 会
            停在 static 位错叠到文字上）。 */}
        <span aria-hidden className="relative inline-flex size-[18px] shrink-0">
          <span ref={arcRef} aria-hidden className="absolute inset-0 rounded-full" />
          <span aria-hidden className="absolute inset-0 m-auto size-[12px] rounded-full bg-chat-sender" />
        </span>
        {percent !== null && percent > 0 && (
          <span
            className={cn(
              'text-[10px] font-medium tabular-nums leading-none',
              danger ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {percent}%
          </span>
        )}
      </button>

      {open && usage && anchorRect &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="上下文窗口明细"
            className="fixed z-50 mb-2 flex w-64 flex-col gap-1 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            <div className="text-xs font-semibold">上下文窗口</div>
            <MetricRow label="占用" value={percent !== null ? `${percent}%` : '—'} tone={danger ? 'destructive' : undefined} />
            <MetricRow
              label="已用 tokens"
              value={formatTokens(usage.usedTokens)}
              tone={usage.source === 'estimate' ? 'muted' : undefined}
            />
            <MetricRow label="窗口上限" value={formatTokens(usage.contextWindowTokens)} tone="muted" />
            {breakdownRows.length > 0 && (
              <>
                <div className="my-1 border-t border-border" />
                {breakdownRows.map(([name, value]) => (
                  <MetricRow key={name} label={name} value={formatTokens(value)} />
                ))}
                <MetricRow label="合计" value={formatTokens(usage.breakdown?.total ?? 0)} tone="muted" />
              </>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
