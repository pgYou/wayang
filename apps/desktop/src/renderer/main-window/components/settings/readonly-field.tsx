import type { ReactNode } from 'react';
import { Label } from '@/renderer/shared/components/ui/label';
import { cn } from '@/renderer/shared/lib/cn';
import { RevealButton, SecretValue, useReveal } from './secret-field';

/**
 * 只读字段：标签行 + 值。值用大一号的字并撑到输入框的高度——只读态和编辑态
 * （同样的标签 + 输入框）看起来是同一个位置的同一项，而不是挤成两行小字。
 */
export interface ReadonlyFieldProps {
  label: string;
  /**
   * 标签右侧的附加控件（如密钥的眼睛）。放标签行里位置才固定——跟在值后面
   * 会随值的长度变。
   */
  adornment?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function ReadonlyField({ label, adornment, className, children }: ReadonlyFieldProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      {/* 标签行固定 24px：带不带附加控件都一样高，字段之间对得齐。 */}
      <div className="flex h-6 items-center gap-1">
        <Label>{label}</Label>
        {adornment}
      </div>
      <div className="flex min-h-9 items-center">{children}</div>
    </div>
  );
}

/** 只读的密钥字段：默认打码，眼睛在标签后面。空值显示「—」，没有眼睛。 */
export function ReadonlySecretField({ label, value, className }: { label: string; value: string; className?: string }) {
  const { reveal, toggle } = useReveal();
  return (
    <ReadonlyField
      label={label}
      className={className}
      adornment={value.length > 0 ? <RevealButton reveal={reveal} label={label} onToggle={toggle} size="icon-xs" /> : undefined}
    >
      {value.length > 0 ? <SecretValue value={value} reveal={reveal} /> : <span className="text-base">—</span>}
    </ReadonlyField>
  );
}
