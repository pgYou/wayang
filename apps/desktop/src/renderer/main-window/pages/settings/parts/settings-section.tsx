import type { HTMLAttributes, ReactNode } from 'react';
import { Card } from '@/renderer/shared/components/ui/card';
import { Label } from '@/renderer/shared/components/ui/label';
import { cn } from '@/renderer/shared/lib/cn';
import { RestartBadge } from './field-controls';

/**
 * 分区大标题：设置页每一节的标题都用它——字号 / 字重 / 行高 / 左右留白只在
 * 这里定义（分组里自己排的标题行，如 Providers，也用它），各处不会各写各的。
 * 行高固定 24px（与 app 的行类组件一致）：带不带徽标、右边放不放按钮，
 * 每一节的标题行都一样高。
 */
export function SectionTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('flex h-6 items-center gap-2 px-1 text-lg/6 font-medium', className)} {...props} />;
}

/** 设置页的卡片：白底、渐变曲率圆角（和 toast、聊天气泡同一套 squircle 类）。 */
export function SettingsCard({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <Card className={cn('rounded-squircle border-transparent shadow-card', className)} {...props} />;
}

/**
 * 设置页分区：标题悬在卡片外（与卡片之间留白），卡片只承载「行」，行与行
 * 之间用细分割线分隔——一个分区一张卡片，而不是每个配置项一整块卡片，
 * 页面因此有层次与呼吸感。需重启字段的徽标放在标题（整区皆需重启）或行
 * 标签（混合分区）旁。
 */
export function SettingsSection({
  title,
  restart,
  action,
  children,
}: {
  title: string;
  restart?: boolean;
  /** 标题行最右边的动作（如整区的「编辑」按钮）；右缘与下方卡片的右缘对齐。 */
  action?: ReactNode;
  children: ReactNode;
}) {
  const heading = (
    <SectionTitle className={action ? 'flex-1' : undefined}>
      {title}
      {restart && <RestartBadge />}
    </SectionTitle>
  );
  return (
    <section className="flex flex-col gap-2">
      {action ? (
        <div className="flex items-center">
          {heading}
          {action}
        </div>
      ) : (
        heading
      )}
      <SettingsCard className="gap-0 divide-y divide-border py-0">{children}</SettingsCard>
    </section>
  );
}

/** 分区内的一行：统一内边距，行间距由 SettingsSection 的分割线表达。 */
export function SettingsRow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-3 p-4', className)} {...props} />;
}

/** 行内字段标签（可选重启徽标）。 */
export function FieldLabel({ children, restart, className }: { children: ReactNode; restart?: boolean; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Label>{children}</Label>
      {restart && <RestartBadge />}
    </div>
  );
}
