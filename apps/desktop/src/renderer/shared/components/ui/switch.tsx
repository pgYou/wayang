import { cn } from '@/renderer/shared/lib/cn';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** 表单里的开关字段：传 FormField 给的 id，label 才关联得到。 */
  id?: string;
  'aria-label'?: string;
  className?: string;
}

/**
 * Switch——无 radix 依赖的最小开关：on/off 两档，纯 Tailwind 条件类表达
 * （无需命令式样式注入）。用于设置页里「选中即生效」的布尔字段（如第三方
 * worker 的启用开关）。轨道 28×16、滑块 12px：和旁边的 icon-xs 图标按钮
 * （24px）放在一起时不会显得一头大。
 */
export function Switch({ checked, onCheckedChange, disabled, className, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-grey-4',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'size-3 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-[14px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}
