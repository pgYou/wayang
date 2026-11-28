import * as React from 'react';
import { XIcon } from 'lucide-react';
import { cn } from '@/renderer/shared/lib/cn';
import { fieldSizeClass, type FieldSize } from './field-size';
import { IconButton } from './icon-button';

export interface InputProps extends React.ComponentProps<'input'> {
  fieldSize?: FieldSize;
  /**
   * 右侧带「清空」按钮（有内容时才出现），点了把值置空。只对受控输入有意义
   * （要有 value / onChange）：按钮是把原生 value 置空后派发 input 事件，和用户
   * 自己删光内容走的是同一条 onChange。
   */
  allowClear?: boolean;
}

/**
 * Input — 灰底输入：软灰面 → 悬停加深 → 聚焦换净底 + 边框指示。
 * `fieldSize` 选宽度档（sm/md/lg，默认 lg 整行），见 field-size.ts。
 */
const INPUT_CLASS =
  'flex h-9 min-w-0 rounded-lg border border-transparent bg-grey-2 px-3 py-1 text-sm text-foreground transition-all outline-none ' +
  'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground ' +
  'hover:bg-grey-3 focus-visible:border-ring focus-visible:bg-background ' +
  'aria-invalid:border-destructive aria-invalid:ring-destructive/20 ' +
  'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 ' +
  'file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground';

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, fieldSize = 'lg', allowClear = false, ...props }, ref) => {
    // 不带清空的输入框保持原来的结构（就是一个 <input>），不套任何容器。
    if (!allowClear) {
      return <input type={type} data-slot="input" className={cn(INPUT_CLASS, fieldSizeClass[fieldSize], className)} ref={ref} {...props} />;
    }
    return <ClearableInput type={type} fieldSize={fieldSize} className={className} ref={ref} {...props} />;
  },
);
Input.displayName = 'Input';

/** 带「清空」按钮的输入：外面包一层定位容器，按钮贴在输入框右端内侧。 */
const ClearableInput = React.forwardRef<HTMLInputElement, InputProps>(function ClearableInput(
  { className, type, fieldSize = 'lg', value, ...props },
  ref,
) {
  const node = React.useRef<HTMLInputElement | null>(null);
  const setNode = React.useCallback(
    (el: HTMLInputElement | null): void => {
      node.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  const hasValue = typeof value === 'string' && value.length > 0;

  const clear = (): void => {
    const el = node.current;
    if (!el) return;
    // 走原型上的 setter：绕开 React 对 value 的追踪，让它把这次置空当成用户输入。
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  };

  return (
    <span className={cn('relative flex', fieldSizeClass[fieldSize], className)}>
      <input type={type} data-slot="input" className={cn(INPUT_CLASS, 'w-full', hasValue && 'pr-8')} ref={setNode} value={value} {...props} />
      {hasValue && (
        <IconButton label="清空" className="absolute top-1/2 right-1 -translate-y-1/2" onClick={clear}>
          <XIcon />
        </IconButton>
      )}
    </span>
  );
});
