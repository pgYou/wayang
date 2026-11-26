import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import type { DisplayItem } from '@/renderer/shared/lib/display';
import { FOLD_THRESHOLD_PX, formatMessageTime } from '@/renderer/shared/lib/chat-metrics';
import { Button } from '@/renderer/shared/components/ui/button';
import { cn } from '@/renderer/shared/lib/cn';

/** 收起态高度（与 line-clamp-11 的截断高度对齐）。 */
const FOLD_COLLAPSED_PX = 260;

/**
 * 用户消息行——右侧灰蓝气泡（sky 系特殊位：用户在场感）。
 * 长消息折叠（>300px 默认收起）：`grid-template-rows: 260px ↔ 1fr` 高度缓动，
 * 省略号 line-clamp 延迟到收起动画结束后再上，避免内容瞬跳。
 * 气泡下操作条：左侧常驻「显示更多/收起」文本胶囊（对齐气泡左缘，小号灰字，
 * hover 恢复前景色 + 胶囊底）；右侧 hover 显示时间与复制。
 * Memoized：行组件接收 memo 化的稳定 item 引用，流式更新不重绘历史行。
 */
export const UserRow = memo(function UserRow({ item }: { item: DisplayItem }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [clampOn, setClampOn] = useState(true);
  const [copied, setCopied] = useState(false);
  const clampTimer = useRef<number | undefined>(undefined);

  // 折叠动画走 max-height 精确值（260px ↔ 测量高度）：两端都是具体像素，
  // 标准可插值、速度均匀（grid-rows 的 px↔fr 在 Chromium 不插值，已试错弃用）。
  // 首帧 paint 前完成测量 + 上限设置（同批 layout effect），无闪帧；clamp 前
  // 提下 scrollHeight 是截断值，所以测量发生在加 clamp 之前。
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (height === null) setHeight(el.scrollHeight);
    el.style.maxHeight = expanded && height !== null ? `${height}px` : `${FOLD_COLLAPSED_PX}px`;
  }, [item.content, expanded, height]);

  useEffect(() => () => window.clearTimeout(clampTimer.current), []);

  const expandable = height !== null && height > FOLD_THRESHOLD_PX;
  const folded = expandable && !expanded;
  const clamped = folded && clampOn;

  const toggleExpand = (): void => {
    if (expanded) {
      setExpanded(false);
      // 收起动画（300ms）结束后再上省略号截断。
      window.clearTimeout(clampTimer.current);
      clampTimer.current = window.setTimeout(() => setClampOn(true), 320);
    } else {
      window.clearTimeout(clampTimer.current);
      setClampOn(false);
      setExpanded(true);
    }
  };

  const onCopy = (): void => {
    void navigator.clipboard?.writeText(item.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="wayang-user-row group flex justify-end">
      <div className="flex max-w-[78%] flex-col items-end">
        <div
          ref={contentRef}
          className={cn(
            'overflow-hidden whitespace-pre-wrap rounded-xl bg-sky-soft px-4 py-2 text-sm leading-relaxed text-foreground transition-[max-height] duration-300 ease-in-out',
            clamped && 'line-clamp-11',
          )}
        >
          {item.content}
        </div>
        {/* 操作条与气泡同宽（self-stretch）：左缘对齐气泡左外边缘。 */}
        <div className="flex self-stretch h-6 items-center justify-between gap-2">
          {/* 常驻折叠/展开：小号灰字胶囊，hover 恢复前景色与底色。 */}
          <span>
            {expandable && (
              <Button
                variant="ghost"
                size="xs"
                onClick={toggleExpand}
                className="h-5 rounded-full px-2 text-[10px] text-muted-foreground hover:text-foreground"
              >
                {expanded ? '收起' : '显示更多'}
              </Button>
            )}
          </span>
          <span className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
            {item.timestamp > 0 && (
              <span className="font-mono text-[11px] text-muted-foreground/70">
                {formatMessageTime(item.timestamp)}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onCopy}
              title="复制消息"
              aria-label="复制消息"
            >
              {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
});
