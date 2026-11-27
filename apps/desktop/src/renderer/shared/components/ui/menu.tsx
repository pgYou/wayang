import type { ReactNode } from 'react';
import { cn } from '@/renderer/shared/lib/cn';

export interface MenuItem<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface MenuProps<T extends string = string> {
  items: ReadonlyArray<MenuItem<T>>;
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
  'aria-label'?: string;
}

/**
 * Menu——垂直单选导航菜单（受控）：无分割线；当前项与 hover 项带灰色圆角
 * 矩形底（当前项更深一级）。用于页内分组导航（如设置页）。与 DropdownMenu
 * （弹出式动作菜单）区分。
 */
export function Menu<T extends string = string>({ items, value, onValueChange, className, ...props }: MenuProps<T>) {
  return (
    <nav className={cn('flex flex-col gap-1', className)} {...props}>
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            disabled={item.disabled}
            aria-current={selected ? 'page' : undefined}
            onClick={() => onValueChange(item.value)}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors outline-none',
              'focus-visible:bg-grey-2 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
              selected ? 'bg-grey-3 font-medium text-foreground' : 'text-muted-foreground hover:bg-grey-2 hover:text-foreground',
            )}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
