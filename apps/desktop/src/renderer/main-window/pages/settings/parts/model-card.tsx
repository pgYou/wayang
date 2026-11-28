import { PencilIcon, Trash2Icon } from 'lucide-react';
import type { ModelConfig } from '@wayang-ai/protocol';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { cn } from '@/renderer/shared/lib/cn';
import { IconButton } from '@/renderer/shared/components/ui/icon-button';

/** 上下文窗口兜底值的展示写法（core 的 262144 tokens，K 按 1024 算），与表单里的提示同一个口径。 */
const DEFAULT_CONTEXT_WINDOW_LABEL = '256K';

/** 小卡里的一行「标签 值」；没设置的值显示 `unset`（灰色）。 */
function ModelFact({ label, value, unset = '未设置' }: { label: string; value: string | undefined; unset?: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate text-sm', value === undefined && 'text-muted-foreground')}>{value ?? unset}</span>
    </div>
  );
}

/**
 * provider 卡片里的一个模型条目：灰底小卡。条目的信息（模型名、上下文窗口、
 * 最大输出、温度）和「被谁使用」直接摆出来，不用点开编辑才看得到；
 * 编辑 / 删除在右上角。
 */
export function ModelCard({
  entryKey,
  model,
  sites,
  deleteDisabled,
  onEdit,
  onDelete,
}: {
  entryKey: string;
  model: ModelConfig;
  /** 使用这个模型的绑定位置（controller / worker / workers.<id>）。 */
  sites: string[];
  deleteDisabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-grey-2 p-3">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{entryKey}</span>
        {/* 小卡本身就是灰底，按钮悬停底色要更深一档才看得出来。 */}
        <IconButton label={`编辑模型 ${entryKey}`} className="hover:bg-grey-3" onClick={onEdit}>
          <PencilIcon />
        </IconButton>
        <IconButton label={`删除模型 ${entryKey}`} className="hover:bg-grey-3" disabled={deleteDisabled} onClick={onDelete}>
          <Trash2Icon />
        </IconButton>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        <ModelFact label="模型名" value={model.name} />
        <ModelFact
          label="上下文窗口"
          value={model.contextWindowTokens !== undefined ? `${model.contextWindowTokens} tokens` : undefined}
          unset={`未设置 · 默认 ${DEFAULT_CONTEXT_WINDOW_LABEL}`}
        />
        <ModelFact label="最大输出" value={model.maxOutputTokens !== undefined ? `${model.maxOutputTokens} tokens` : undefined} />
        <ModelFact label="温度" value={model.temperature !== undefined ? String(model.temperature) : undefined} />
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="w-16 shrink-0 text-xs text-muted-foreground">用于</span>
        {sites.length > 0 ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {sites.map((site) => (
              <Badge key={site} variant="outline" className="shrink-0 text-[10px] font-normal text-muted-foreground">
                {site}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">未使用</span>
        )}
      </div>
    </div>
  );
}
