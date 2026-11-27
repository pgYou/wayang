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
 * 「输入类」卡片的保存/取消条：按钮常驻、dirty 时才点亮（启用）——与
 * 参考图「分类/标签」卡片底部的保存按钮一致。
 */
export function SaveCancelBar({
  dirty,
  saving,
  error,
  onSave,
  onCancel,
}: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={!dirty || saving}>
          {saving && <LoaderIcon className="animate-spin" />}
          保存
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={!dirty || saving}>
          取消
        </Button>
      </div>
    </div>
  );
}
