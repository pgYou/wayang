import {
  forwardRef,
  useRef,
  useState,
  useEffect,
  useImperativeHandle,
  useCallback,
} from 'react';
import { ArrowUpIcon, SquareIcon } from 'lucide-react';
import { cn } from '@/renderer/shared/lib/cn';
import { Button } from './button';

export interface AutoResizeTextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  minRows?: number;
  maxRows?: number;
}

/**
 * AutoResizeTextarea — 自适应高度多行输入（按内容增长，min/max 行数约束）。
 */
export const AutoResizeTextarea = forwardRef<
  HTMLTextAreaElement,
  AutoResizeTextareaProps
>(({ minRows = 1, maxRows = 8, className, onChange, ...props }, ref) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => textareaRef.current!);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = 'auto';

    const computedStyle = getComputedStyle(el);
    const lineHeight = parseFloat(computedStyle.lineHeight) || 20;
    const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
    const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;
    const borderTop = parseFloat(computedStyle.borderTopWidth) || 0;
    const borderBottom = parseFloat(computedStyle.borderBottomWidth) || 0;

    const minHeight = lineHeight * minRows + paddingTop + paddingBottom + borderTop + borderBottom;
    const maxHeight = lineHeight * maxRows + paddingTop + paddingBottom + borderTop + borderBottom;

    const newHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${newHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [minRows, maxRows]);

  useEffect(() => {
    resize();
  }, [props.value, resize]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange?.(e);
    resize();
  };

  return (
    <textarea
      ref={textareaRef}
      className={cn(
        'wayang-auto-resize-textarea',
        'w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      rows={minRows}
      onChange={handleChange}
      {...props}
    />
  );
});

AutoResizeTextarea.displayName = 'AutoResizeTextarea';

export interface SenderProps {
  /** 输入框值（受控） */
  value?: string;
  /** 默认值 */
  defaultValue?: string;
  /** 占位文本 */
  placeholder?: string;
  /** 是否只读 */
  readOnly?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
  /** 加载状态（发送中，显示取消按钮） */
  loading?: boolean;
  /** 头部区域 */
  header?: React.ReactNode;
  /** 底部区域 */
  footer?: React.ReactNode;
  /** 前缀内容（输入框左侧） */
  prefix?: React.ReactNode;
  /** 后缀内容（输入框右侧，默认为发送按钮前） */
  suffix?: React.ReactNode;
  /** 提交方式: 'enter' = Enter发送, 'shiftEnter' = Shift+Enter发送 */
  submitType?: 'enter' | 'shiftEnter';
  /** 自适应高度配置 */
  autoSize?: boolean | { minRows?: number; maxRows?: number };
  /** 输入变化回调 */
  onChange?: (value: string) => void;
  /** 提交回调 */
  onSubmit?: (message: string) => void;
  /** 取消回调 */
  onCancel?: () => void;
  /** 获取焦点回调 */
  onFocus?: React.FocusEventHandler<HTMLTextAreaElement>;
  /** 失去焦点回调 */
  onBlur?: React.FocusEventHandler<HTMLTextAreaElement>;
  /** 粘贴文件回调 */
  onPasteFile?: (files: FileList) => void;
  /** 自定义类名 */
  className?: string;
}

export interface SenderRef {
  focus: () => void;
  blur: () => void;
  clear: () => void;
}

/**
 * Sender — 输入区（自适应输入框 + 底部工具栏 + 发送/停止按钮），受控/非受控双模式。
 */
export const Sender = forwardRef<SenderRef, SenderProps>(
  (
    {
      value: controlledValue,
      defaultValue = '',
      placeholder = 'Enter...',
      readOnly,
      disabled,
      loading,
      header,
      footer,
      prefix,
      suffix,
      submitType = 'enter',
      autoSize = true,
      onChange,
      onSubmit,
      onCancel,
      onFocus,
      onBlur,
      onPasteFile,
      className,
    },
    ref,
  ) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [internalValue, setInternalValue] = useState(defaultValue);
    const [isFocused, setIsFocused] = useState(false);

    const isControlled = controlledValue !== undefined;
    const currentValue = isControlled ? controlledValue : internalValue;

    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      blur: () => textareaRef.current?.blur(),
      clear: () => {
        if (!isControlled) {
          setInternalValue('');
        }
        onChange?.('');
      },
    }));

    const handleValueChange = useCallback(
      (newValue: string) => {
        if (!isControlled) {
          setInternalValue(newValue);
        }
        onChange?.(newValue);
      },
      [isControlled, onChange],
    );

    const handleSubmit = useCallback(() => {
      const trimmed = currentValue.trim();
      if (!trimmed || disabled || readOnly) return;

      onSubmit?.(trimmed);

      if (!isControlled) {
        setInternalValue('');
      }
    }, [currentValue, disabled, readOnly, onSubmit, isControlled]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Escape' && loading) {
          onCancel?.();
          return;
        }
        if (loading) return;

        if (submitType === 'enter') {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            handleSubmit();
          }
        } else {
          if (e.key === 'Enter' && e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            handleSubmit();
          }
        }
      },
      [submitType, handleSubmit, loading, onCancel],
    );

    const handlePaste = useCallback(
      (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        if (e.clipboardData?.files?.length && onPasteFile) {
          e.preventDefault();
          onPasteFile(e.clipboardData.files);
        }
      },
      [onPasteFile],
    );

    const handleFocus: React.FocusEventHandler<HTMLTextAreaElement> = (e) => {
      setIsFocused(true);
      onFocus?.(e);
    };

    const handleBlur: React.FocusEventHandler<HTMLTextAreaElement> = (e) => {
      setIsFocused(false);
      onBlur?.(e);
    };

    const autoSizeConfig =
      typeof autoSize === 'object'
        ? autoSize
        : autoSize
          ? { minRows: 2, maxRows: 8 }
          : { minRows: 1, maxRows: 1 };

    const canSubmit = currentValue.trim().length > 0 && !disabled && !readOnly;

    return (
      <div
        className={cn(
          'wayang-sender',
          // 背景恒为灰底（聚焦不换白底）；聚焦指示只体现在 1px outline 变深。
          'flex flex-col overflow-hidden rounded-xl bg-chat-sender outline outline-1 outline-chat-sender-border transition-colors',
          isFocused && 'wayang-sender-focused outline-chat-sender-focus',
          disabled && 'wayang-sender-disabled cursor-not-allowed opacity-50',
          className,
        )}
      >
        {/* Header */}
        {header && (
          <div className="wayang-sender-header border-b border-border px-3 py-2">{header}</div>
        )}

        {/* Input area */}
        <div className="wayang-sender-input-area flex flex-col gap-2 px-3 py-2">
          {/* Textarea - Row 1 */}
          <AutoResizeTextarea
            ref={textareaRef}
            value={currentValue}
            placeholder={placeholder}
            readOnly={readOnly}
            disabled={disabled}
            minRows={autoSizeConfig.minRows}
            maxRows={autoSizeConfig.maxRows}
            onChange={(e) => handleValueChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={handleFocus}
            onBlur={handleBlur}
            className="wayang-sender-textarea"
          />

          {/* Prefix + Suffix / Action Button - Row 2 */}
          <div
            className="wayang-sender-actions flex items-center justify-between"
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest('.dont-focus')) {
                textareaRef.current?.focus();
              }
            }}
          >
            {/* Prefix */}
            <div className="wayang-sender-prefix flex shrink-0 items-center gap-2">
              {prefix}
            </div>

            {/* Suffix / Action Button */}
            <div className="wayang-sender-suffix flex shrink-0 items-center gap-2">
              {suffix}
              {loading ? (
                <Button
                  variant="destructive"
                  size="icon-xs"
                  className="wayang-sender-cancel-btn dont-focus cursor-pointer rounded-full"
                  onClick={onCancel}
                  aria-label="停止"
                >
                  <SquareIcon className="size-3 fill-current" />
                </Button>
              ) : (
                <Button
                  variant="default"
                  size="icon-xs"
                  className="wayang-sender-submit-btn dont-focus cursor-pointer rounded-full"
                  disabled={!canSubmit}
                  onClick={handleSubmit}
                  aria-label="发送"
                >
                  <ArrowUpIcon className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        {footer && (
          <div className="wayang-sender-footer border-t border-border px-3 py-2">{footer}</div>
        )}
      </div>
    );
  },
);

Sender.displayName = 'Sender';
