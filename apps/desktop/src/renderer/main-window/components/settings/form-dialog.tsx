import type { FormEvent, ReactNode } from 'react';
import { LoaderIcon } from 'lucide-react';
import { Button } from '@/renderer/shared/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/shared/components/ui/dialog';
import { cn } from '@/renderer/shared/lib/cn';

/**
 * 设置页的表单弹窗：标题 + 说明 + 表单 + 右下角「取消 / 主按钮」。新增 / 编辑
 * provider、模型都用它——卡片保持只读，改动在弹窗里做完再保存，卡片里不再
 * 原地展开表单。内容包在 <form> 里，回车即提交。
 */
export interface FormDialogProps {
  open: boolean;
  /** 关闭请求（取消、右上角 ×、Esc、点遮罩）一律视为取消。 */
  onClose: () => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  onSubmit: () => void;
  /** 主按钮不可点的条件（没改动、不合法）。 */
  submitDisabled?: boolean;
  /** 就近显示的问题（校验原因 / 保存失败）。 */
  problem?: ReactNode;
  saving?: boolean;
  /** 透传给弹窗容器（如放宽宽度）。 */
  className?: string;
  /** 落在弹窗容器上的锚点（data-testid），区分是哪一个弹窗；标题、取消、主按钮自带锚点。 */
  testId?: string;
  children: ReactNode;
}

export function FormDialog({
  open,
  onClose,
  title,
  description,
  submitLabel,
  onSubmit,
  submitDisabled = false,
  problem,
  saving = false,
  className,
  testId,
  children,
}: FormDialogProps) {
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    // 自己处理提交，不走浏览器原生表单提交（会刷新页面）。
    event.preventDefault();
    if (!submitDisabled && !saving) onSubmit();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className={cn('max-w-lg', className)} data-testid={testId}>
        <DialogHeader>
          <DialogTitle data-testid="dialog-title">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {children}
          {problem && <p className="text-xs text-destructive">{problem}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" data-testid="dialog-cancel" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="submit" data-testid="dialog-submit" disabled={submitDisabled || saving}>
              {saving && <LoaderIcon className="animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
