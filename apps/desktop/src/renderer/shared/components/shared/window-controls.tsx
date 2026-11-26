import { useEffect, useState } from 'react';
import { Maximize2Icon, MinusIcon, XIcon } from 'lucide-react';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { cn } from '@/renderer/shared/lib/cn';

/**
 * 自绘窗口按钮——仅非 darwin 平台的回退（macOS 用系统红绿灯，见
 * AppHeader）：红=关闭、黄=最小化、绿=zoom。整组 hover 时全部显形符号、
 * 窗口失焦整体转灰，对齐系统行为。色点为「非标准按钮样式的可点击交互
 * 容器」——AGENTS.md 允许的原生 button 例外；颜色一律走 traffic token。
 * 整组位于 header 内，no-drag 规则由 app-header.scss 统一处理。
 */

/** 失焦态：对齐系统红绿灯 inactive 时的灰色形态。 */
const DIMMED = 'bg-muted-foreground/30';

function TrafficDot({
  label,
  action,
  color,
  focused,
  glyph,
}: {
  label: string;
  action: 'close' | 'minimize' | 'toggleZoom';
  color: string;
  focused: boolean;
  glyph: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => void wayang.windowControl(action)}
      className={cn('flex size-3 cursor-default items-center justify-center rounded-full transition-colors', focused ? color : DIMMED)}
    >
      <span className="flex items-center justify-center opacity-0 transition-opacity group-hover/dots:opacity-100 [&_svg]:size-2 [&_svg]:text-foreground/50">
        {glyph}
      </span>
    </button>
  );
}

export function WindowControls() {
  // 失焦转灰：跟随窗口焦点（对齐系统红绿灯 inactive 形态）。
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = (): void => setFocused(true);
    const onBlur = (): void => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // group/dots：悬停组内任一色点，三枚符号一起显形（系统整组行为）。
  return (
    <div className="group/dots flex shrink-0 items-center gap-2">
      <TrafficDot label="关闭" action="close" color="bg-traffic-close" focused={focused} glyph={<XIcon />} />
      <TrafficDot label="最小化" action="minimize" color="bg-traffic-minimize" focused={focused} glyph={<MinusIcon />} />
      <TrafficDot label="全屏" action="toggleZoom" color="bg-traffic-zoom" focused={focused} glyph={<Maximize2Icon />} />
    </div>
  );
}
