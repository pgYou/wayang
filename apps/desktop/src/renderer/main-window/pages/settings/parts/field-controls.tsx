import { LoaderIcon } from 'lucide-react';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Button } from '@/renderer/shared/components/ui/button';

/**
 * 需重启字段的就近标记——用 UI 元素（徽标）替代「此项需重启生效」的
 * 解释性文案，只出现在例外（需重启）字段旁，默认（热更）不标注。
 */
export function RestartBadge() {
  return (
    <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
      重启生效
    </Badge>
  );
}

/**
 * 「输入类」控件的保存/取消条：按钮常驻、dirty 时才点亮（启用）。
 * `inline` 用于短字段（数字等）——与输入框同排，不另起一行。
 */
export function SaveCancelBar({
  dirty,
  saving,
  error,
  onSave,
  onCancel,
  inline = false,
}: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
  inline?: boolean;
}) {
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
      <div className="flex min-w-0 items-center gap-3">
        {error && <p className="min-w-0 truncate text-xs text-destructive">{error}</p>}
        {buttons}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-xs text-destructive">{error}</p>}
      {buttons}
    </div>
  );
}
