import { LoaderIcon } from 'lucide-react';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Button } from '@/renderer/shared/components/ui/button';
import { cn } from '@/renderer/shared/lib/cn';

/**
 * 需重启字段的就近标记——用 UI 元素（徽标）替代「此项需重启生效」的
 * 解释性文案，只出现在例外（需重启）字段旁，默认（热更）不标注。
 *
 * 刻意做得轻：浅灰底、无边框、小一号的次要色文字——它是标题旁边的注脚，
 * 视觉重量不能盖过标题本身。高度 16px，比正文行高还矮，不会把标题行撑开。
 */
export function RestartBadge() {
  return <Badge className="border-transparent bg-grey-2 py-0 text-[10px] leading-4 font-normal text-muted-foreground">重启生效</Badge>;
}

/**
 * 「输入类」控件的保存/取消条：用户开始改（dirty）才出现——没改动时不摆着
 * 两个灰按钮占地方。`inline` 用于短字段（数字等）——与输入框同排，不另起一行。
 * `className` 加在最外层；整条不出现时它也不生效（外边距不会凭空留白）。
 */
export function SaveCancelBar({
  dirty,
  saving,
  error,
  onSave,
  onCancel,
  inline = false,
  className,
}: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
  inline?: boolean;
  className?: string;
}) {
  if (!dirty && !saving && !error) return null;

  const buttons = (
    <div className="flex shrink-0 items-center gap-2">
      <Button size="sm" onClick={onSave} disabled={!dirty || saving}>
        {saving && <LoaderIcon className="animate-spin" />}
        保存
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={!dirty || saving}>
        取消
      </Button>
    </div>
  );

  if (inline) {
    return (
      <div className={cn('flex min-w-0 items-center gap-3', className)}>
        {error && <p className="min-w-0 truncate text-xs text-destructive">{error}</p>}
        {buttons}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {buttons}
    </div>
  );
}
