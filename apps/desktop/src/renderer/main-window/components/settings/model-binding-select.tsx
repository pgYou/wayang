import { modelRefProvider } from '@wayang-ai/protocol';
import type { ModelRef, WayangConfig } from '@wayang-ai/protocol';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/shared/components/ui/select';

/**
 * 模型绑定下拉——controller / puppet worker 的模型绑定，以及第三方 worker
 * 的 `model` 引用，三处共用一个组件。选项是 `config.models` 的条目；当前值
 * 若不是 models 条目（`provider/model` 组合引用、内联对象——通常来自导入的
 * 配置），下拉里保留一项「保持现状」，不会因为选不了而把它悄悄丢掉。
 */
const UNSET = '__unset__';
const CURRENT = '__current__';

/**
 * 下拉项（也是选中后触发器里显示的内容）的写法：provider 做成胶囊标签在前，
 * 模型名称在后——光看条目名分不清它落在哪个 provider 上。
 */
function RefLabel({ provider, name, note }: { provider: string; name: string; note?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Badge variant="secondary" className="rounded-full font-normal">
        {provider}
      </Badge>{' '}
      <span className="min-w-0 truncate">{name}</span>
      {note && <span className="shrink-0 text-xs text-muted-foreground">{note}</span>}
    </span>
  );
}

export interface ModelBindingSelectProps {
  /** 数据源：下拉列出 `config.models` 的条目。 */
  config: WayangConfig;
  value: ModelRef | undefined;
  onChange: (model: ModelRef | undefined) => void;
  /** 提供「不指定」选项（第三方 worker 的模型引用可留空）。 */
  allowUnset?: boolean;
  unsetLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  /** 传给下拉触发器，供 FormField 的 label 关联。 */
  id?: string;
}

export function ModelBindingSelect({
  config,
  value,
  onChange,
  allowUnset = false,
  unsetLabel = '不指定',
  placeholder = '选择模型',
  disabled = false,
  id,
}: ModelBindingSelectProps) {
  const models = Object.entries(config.models ?? {});
  const isEntry = typeof value === 'string' && models.some(([key]) => key === value);
  const currentRef = value !== undefined && !isEntry ? value : undefined;
  // Radix Select 不接受空串选项：未绑定与「保持现状」各用一个哨兵值。
  const selected = value === undefined ? (allowUnset ? UNSET : '') : currentRef === undefined ? (value as string) : CURRENT;

  return (
    <Select
      value={selected}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === UNSET) onChange(undefined);
        else if (next === CURRENT) onChange(currentRef);
        else onChange(next);
      }}
    >
      <SelectTrigger id={id} fieldSize="md" className="w-full">
        <SelectValue className="min-w-0" placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowUnset && <SelectItem value={UNSET}>{unsetLabel}</SelectItem>}
        {models.map(([key, model]) => (
          <SelectItem key={key} value={key}>
            <RefLabel provider={model.provider} name={key} />
          </SelectItem>
        ))}
        {currentRef !== undefined && (
          <SelectItem value={CURRENT}>
            {typeof currentRef === 'string' ? (
              // 组合引用 `provider/model`：模型名本身可以含 `/`，只切第一个。
              <RefLabel provider={modelRefProvider(config, currentRef) ?? '?'} name={currentRef.slice(currentRef.indexOf('/') + 1)} note="组合引用" />
            ) : (
              <RefLabel provider={currentRef.provider} name={currentRef.name} note="内联模型" />
            )}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}
