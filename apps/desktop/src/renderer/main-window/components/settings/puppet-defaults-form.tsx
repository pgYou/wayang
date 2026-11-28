import type { ToolChoice, WayangConfig } from '@wayang-ai/protocol';
import { Input } from '@/renderer/shared/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/shared/components/ui/select';
import { FormField } from './form-field';
import { parsePositiveInt } from './form-values';

/**
 * puppet worker 默认参数（`worker.maxConcurrency` / `maxTurns` /
 * `toolChoice`）的表单——设置页与 onboard 向导共用。受控组件，值是输入框
 * 里的原始文本；写回配置与校验是同一份。
 */
const TOOL_CHOICE_UNSET = '__unset__';

export interface PuppetDefaultsFormValues {
  maxConcurrency: string;
  maxTurns: string;
  toolChoice: typeof TOOL_CHOICE_UNSET | ToolChoice;
}

export function puppetDefaultsForm(worker: WayangConfig['worker'] | undefined): PuppetDefaultsFormValues {
  return {
    maxConcurrency: worker?.maxConcurrency !== undefined ? String(worker.maxConcurrency) : '',
    maxTurns: worker?.maxTurns !== undefined ? String(worker.maxTurns) : '',
    toolChoice: worker?.toolChoice ?? TOOL_CHOICE_UNSET,
  };
}

/** 保存前的校验：返回第一条问题，null 表示可以保存。 */
export function puppetDefaultsFormProblem(values: PuppetDefaultsFormValues): string | null {
  const concurrency = parsePositiveInt(values.maxConcurrency);
  if (concurrency.empty || concurrency.invalid) return '最大并发需为正整数';
  if (parsePositiveInt(values.maxTurns).invalid) return 'Max turns 需为正整数，留空表示不限';
  return null;
}

/** 表单值写回配置（不合法时抛错，不写出半截配置）。 */
export function applyPuppetDefaultsForm(config: WayangConfig, values: PuppetDefaultsFormValues): WayangConfig {
  const problem = puppetDefaultsFormProblem(values);
  if (problem) throw new Error(problem);
  const worker: WayangConfig['worker'] = { ...config.worker, maxConcurrency: parsePositiveInt(values.maxConcurrency).value as number };
  const maxTurns = parsePositiveInt(values.maxTurns).value;
  if (maxTurns === undefined) delete worker.maxTurns;
  else worker.maxTurns = maxTurns;
  if (values.toolChoice === TOOL_CHOICE_UNSET) delete worker.toolChoice;
  else worker.toolChoice = values.toolChoice;
  return { ...config, worker };
}

export interface PuppetDefaultsFormProps {
  value: PuppetDefaultsFormValues;
  onChange: (next: PuppetDefaultsFormValues) => void;
  disabled?: boolean;
}

export function PuppetDefaultsForm({ value, onChange, disabled = false }: PuppetDefaultsFormProps) {
  const set = (patch: Partial<PuppetDefaultsFormValues>): void => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-3">
      <FormField label="最大并发">
        {(id) => <Input id={id} fieldSize="sm" inputMode="numeric" value={value.maxConcurrency} disabled={disabled} onChange={(e) => set({ maxConcurrency: e.target.value })} />}
      </FormField>
      <FormField label="Max turns" hint="留空不限">
        {(id) => <Input id={id} fieldSize="sm" inputMode="numeric" value={value.maxTurns} disabled={disabled} onChange={(e) => set({ maxTurns: e.target.value })} />}
      </FormField>
      <FormField label="Tool choice" className="w-56">
        {(id) => (
          <Select
            value={value.toolChoice}
            disabled={disabled}
            onValueChange={(toolChoice) => set({ toolChoice: toolChoice as PuppetDefaultsFormValues['toolChoice'] })}
          >
            <SelectTrigger id={id} fieldSize="md" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TOOL_CHOICE_UNSET}>未设置（默认）</SelectItem>
              <SelectItem value="auto">auto</SelectItem>
              <SelectItem value="required">required</SelectItem>
              <SelectItem value="none">none</SelectItem>
            </SelectContent>
          </Select>
        )}
      </FormField>
    </div>
  );
}
