import { useState, type ReactNode } from 'react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { Button } from '@/renderer/shared/components/ui/button';
import { Card } from '@/renderer/shared/components/ui/card';
import { cn } from '@/renderer/shared/lib/cn';

/** 每个向导步骤拿到的外部接口。 */
export interface StepProps {
  draft: WayangConfig;
  onChange: (next: WayangConfig) => void;
  /**
   * 步骤告诉向导「现在为什么不能点下一步」（null = 可以）。用于有未保存的
   * 表单、或本步内有不合法输入的情况——免得把没保存的内容悄悄丢掉。
   * 空串 = 挡住但不解释（表单刚打开还没动时，没什么可说的）。
   */
  onBlock: (reason: string | null) => void;
}

export const FORM_OPEN_REASON = '有还没保存的表单：先点「添加 / 保存」或「取消」';
/** 表单开着但还没动过：挡住「下一步」，不显示提示。 */
export const FORM_PRISTINE = '';

/** 向导步骤里的一张卡片（条目展示与表单共用一个底）。 */
export function StepCard({ children, className }: { children: ReactNode; className?: string }) {
  return <Card className={cn('gap-3 p-4', className)}>{children}</Card>;
}

/**
 * 草稿里已有条目的卡片：标题行（名称 + 标记 + 概要）+ 内容 + 编辑 / 删除。
 * 删除分两拍——第一次点变成「确认删除」，再点才真的从草稿里拿掉（删除
 * provider 会连带它名下的模型和绑定，误触代价不小）。
 */
export function EntryCard({
  title,
  badges,
  meta,
  onEdit,
  onDelete,
  children,
}: {
  title: string;
  badges?: ReactNode;
  meta?: ReactNode;
  onEdit: () => void;
  onDelete: () => void;
  children?: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <StepCard>
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-sm font-medium">{title}</span>
        {badges}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{meta}</span>
        <div className="flex shrink-0 items-center gap-1">
          {armed ? (
            <>
              <Button size="sm" variant="destructive" onClick={onDelete}>
                确认删除
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>
                取消
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={onEdit}>
                编辑
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setArmed(true)}>
                删除
              </Button>
            </>
          )}
        </div>
      </div>
      {children}
    </StepCard>
  );
}

/** 表单相对初值有没有被动过——没动过就不该一上来展示校验问题。 */
export function touched(current: object, initial: object): boolean {
  return JSON.stringify(current) !== JSON.stringify(initial);
}

/**
 * 表单下方的 添加/保存 + 取消：`invalid` 时按钮不点亮；`problem` 是给用户
 * 看的原因（没动过的表单传 null）。
 */
export function FormActions({
  primary,
  invalid,
  problem,
  onSave,
  onCancel,
}: {
  primary: string;
  invalid: boolean;
  problem: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={onSave} disabled={invalid}>
        {primary}
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        取消
      </Button>
      {problem && <p className="text-xs text-destructive">{problem}</p>}
    </div>
  );
}
