import type { HTMLAttributes, ReactNode } from 'react';
import { Card } from '@/renderer/shared/components/ui/card';
import { Label } from '@/renderer/shared/components/ui/label';
import { cn } from '@/renderer/shared/lib/cn';
import { RestartBadge } from './field-controls';

/**
 * 设置页分区：标题悬在卡片外（与卡片之间留白），卡片只承载「行」，行与行
 * 之间用细分割线分隔——一个分区一张卡片，而不是每个配置项一整块卡片，
 * 页面因此有层次与呼吸感。需重启字段的徽标放在标题（整区皆需重启）或行
 * 标签（混合分区）旁。
 */
export function SettingsSection({ title, restart, children }: { title: string; restart?: boolean; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 px-1 text-sm font-medium">
        {title}
        {restart && <RestartBadge />}
      </h3>
      <Card className="gap-0 divide-y divide-border border-transparent py-0 shadow-card">{children}</Card>
    </section>
  );
}

/** 分区内的一行：统一内边距，行间距由 SettingsSection 的分割线表达。 */
export function SettingsRow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-3 p-4', className)} {...props} />;
}

/** 行内字段标签（可选重启徽标）。 */
export function FieldLabel({ children, restart }: { children: ReactNode; restart?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Label>{children}</Label>
      {restart && <RestartBadge />}
    </div>
  );
}
