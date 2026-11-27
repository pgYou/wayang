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

/** 环带宽度与画布边长（css px）：16px 画布、2px 描边，与此前 DOM 双层圆的环宽一致。 */
const RING_SIZE = 16;
const RING_LINE_WIDTH = 2;

/**
 * 上下文圆环：contextUsage 的环形可视化 + 点击弹出明细 popover。
 * - Canvas 实现（非 DOM 双层圆）：此前用两个同心 <span> 做环（外层
 *   conic-gradient 画进度、内层纯色圆挖洞）有两个问题——conic-gradient
 *   的色块分界是硬边，起止两端缺圆头收口；内层挖洞圆固定填 sender 背景
 *   色，hover 时按钮底色变 grey-3 而挖洞圆色不跟随，露出方形色差。canvas
 *   用单层 stroke 画环（先画整圈 sky-soft 轨道，再按 percent 画 sky/
 *   destructive 进度弧，lineCap=round 收口两端），不填内部区域——画布
 *   其余像素保持透明，hover 底色变化透过画布直接可见，无挖洞圆层。
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
  // portal 从裁剪链解耦，弹层完整可见。锚点坐标是动态测量值，与 canvas
  // 环同款走命令式注入（JSX 不留内联样式）。
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

  // canvas 画环：先画整圈轨道（sky-soft），再按 percent 画进度弧
  // （lineCap=round 两端圆头）。只 stroke 不 fill——内部像素保持透明，
  // hover 时按钮底色变化直接透出，不存在填色挖洞圆层。
  // 低占用保底：弧段不足 6% 时视觉不可辨（2px 环带 × 7°≈1px）——下限 6%。
  // 颜色取自 CSS 变量（oklch 字面值，非 var() 引用——canvas 2d 不解析
  // 自定义属性），每次重绘按需读取，天然跟随主题变化。
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = RING_SIZE * dpr;
    canvas.height = RING_SIZE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, RING_SIZE, RING_SIZE);

    const root = getComputedStyle(document.documentElement);
    const trackColor = root.getPropertyValue('--sky-soft').trim();
    const progressColor = root.getPropertyValue(danger ? '--destructive' : '--sky').trim();
    const center = RING_SIZE / 2;
    const radius = center - RING_LINE_WIDTH / 2;
    const startAngle = -Math.PI / 2;

    ctx.lineWidth = RING_LINE_WIDTH;
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.strokeStyle = trackColor;
    ctx.stroke();

    if (resolvedPercent <= 0) return;
    const arcPercent = Math.max(resolvedPercent, 6);
    ctx.beginPath();
    ctx.arc(center, center, radius, startAngle, startAngle + (arcPercent / 100) * Math.PI * 2);
    ctx.strokeStyle = progressColor;
    ctx.lineCap = 'round';
    ctx.stroke();
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
    <span className={cn('relative inline-flex shrink-0 items-center justify-center', className)}>
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
        {/* canvas 环（见组件顶部注释）：只 stroke 轨道 + 进度弧，不填内部，
            hover 底色变化透过画布直接可见。环 16px 装不下数字——环与
            n% 水平相邻（图标+标签形态）。 */}
        <canvas ref={canvasRef} aria-hidden className="size-[16px] shrink-0" width={RING_SIZE} height={RING_SIZE} />
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
