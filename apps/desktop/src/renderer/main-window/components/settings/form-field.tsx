import { useId, type ReactNode } from 'react';
import { Label } from '@/renderer/shared/components/ui/label';
import { cn } from '@/renderer/shared/lib/cn';

/**
 * 表单字段的最小外壳：标签 + 控件（+ 一行说明）。原子设置组件都用它排
 * 字段；标签与控件靠自动生成的 id 关联（点标签聚焦、读屏可读）——children
 * 写成渲染函数时拿到这个 id，传给控件。
 */
export interface FormFieldProps {
  label: string;
  /** 控件下方的一行说明。 */
  hint?: string;
  className?: string;
  children: ReactNode | ((id: string) => ReactNode);
}

export function FormField({ label, hint, className, children }: FormFieldProps) {
  const id = useId();
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <Label htmlFor={id}>{label}</Label>
      {typeof children === 'function' ? children(id) : children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
