import { useCallback, useState, type ComponentProps } from 'react';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { Button } from '@/renderer/shared/components/ui/button';
import { Input } from '@/renderer/shared/components/ui/input';
import { cn } from '@/renderer/shared/lib/cn';

/**
 * 打码用的圆点。固定 20 个（不随密钥真实长度变：一是长度本身也是信息，二是
 * 切换显示时宽度不要差太多）；比常见的 8 个长，长密钥切换明文时才不会一下
 * 撑开一大截。
 */
const MASK = '••••••••••••••••••••';

/** 「显示 / 隐藏」密钥的状态；眼睛按钮与密钥文本共用。 */
export function useReveal(): { reveal: boolean; toggle: () => void } {
  const [reveal, setReveal] = useState(false);
  const toggle = useCallback((): void => setReveal((v) => !v), []);
  return { reveal, toggle };
}

/**
 * 密钥的眼睛开关：明文 / 打码互切。输入框旁用 icon-sm；放在只读字段的标签行里
 * 用 icon-xs（24px，与行高一致）。
 */
export function RevealButton({
  reveal,
  label,
  onToggle,
  disabled,
  size = 'icon-sm',
}: {
  reveal: boolean;
  label: string;
  onToggle: () => void;
  disabled?: boolean;
  size?: 'icon-xs' | 'icon-sm';
}) {
  return (
    <Button
      type="button"
      size={size}
      variant="ghost"
      data-testid="secret-reveal"
      disabled={disabled}
      aria-label={reveal ? `隐藏 ${label}` : `显示 ${label}`}
      aria-pressed={reveal}
      onClick={onToggle}
    >
      {reveal ? <EyeOffIcon /> : <EyeIcon />}
    </Button>
  );
}

export interface SecretInputProps extends Omit<ComponentProps<'input'>, 'type' | 'value' | 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  /** 眼睛按钮的无障碍名称里用的字段名。 */
  label?: string;
}

/** 密钥输入框：默认打码，眼睛图标切换明文。 */
export function SecretInput({ value, onChange, disabled, className, label = '密钥', ...rest }: SecretInputProps) {
  const { reveal, toggle } = useReveal();
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Input
        {...rest}
        type={reveal ? 'text' : 'password'}
        value={value}
        disabled={disabled}
        className="min-w-0 flex-1"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {value.length > 0 && <RevealButton reveal={reveal} label={label} disabled={disabled} onToggle={toggle} />}
    </div>
  );
}

/** 密钥文本：按 reveal 决定明文还是打码（眼睛开关由外层放在固定的位置）。 */
export function SecretValue({ value, reveal, className }: { value: string; reveal: boolean; className?: string }) {
  return <span className={cn('min-w-0 break-all text-base', className)}>{reveal ? value : MASK}</span>;
}
