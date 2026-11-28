import type { ModelConfig } from '@wayang-ai/protocol';
import { Button } from '@/renderer/shared/components/ui/button';
import { Input } from '@/renderer/shared/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/shared/components/ui/select';
import { FormField } from './form-field';
import { parseDecimal, parsePositiveInt } from './form-values';

/**
 * `models` 条目的表单——设置页（provider 卡内新增 / 编辑）与 onboard 向导
 * 共用。受控组件，值是输入框里的原始文本；转换与校验函数两边保存前共用。
 */
export interface ModelFormValues {
  /** 模型条目的名称（`models` 的键），controller / worker 的模型绑定引用它。 */
  key: string;
  /** 所属 provider：设置页里由所在卡片决定，向导里经下拉选择。 */
  provider: string;
  /** 发给 provider 的模型名。 */
  name: string;
  contextWindowTokens: string;
  maxOutputTokens: string;
  temperature: string;
}

/**
 * 上下文窗口的常用档位：多数模型就落在这几档，点一下直接填。K / M 按 1024 算
 * （256K = 262144，与 core 的兜底值、CLI 状态栏的显示同一个口径）；要别的值照常手输。
 */
export const CONTEXT_WINDOW_PRESETS: readonly { label: string; tokens: number }[] = [
  { label: '256K', tokens: 256 * 1024 },
  { label: '512K', tokens: 512 * 1024 },
  { label: '1M', tokens: 1024 * 1024 },
];

/** 新增模型的初值：上下文窗口预填 128K，请求参数留空。 */
export function emptyModelForm(provider: string): ModelFormValues {
  return { key: '', provider, name: '', contextWindowTokens: String(128 * 1024), maxOutputTokens: '', temperature: '' };
}

export function modelForm(key: string, model: ModelConfig): ModelFormValues {
  return {
    key,
    provider: model.provider,
    name: model.name,
    contextWindowTokens: String(model.contextWindowTokens ?? ''),
    maxOutputTokens: String(model.maxOutputTokens ?? ''),
    temperature: String(model.temperature ?? ''),
  };
}

/** 表单值 → models 条目（已校验合法时调用）：去空格，可选项留空即不写。 */
export function modelFromForm(values: ModelFormValues): ModelConfig {
  const def: ModelConfig = { provider: values.provider, name: values.name.trim() };
  const window = parsePositiveInt(values.contextWindowTokens).value;
  const maxOutput = parsePositiveInt(values.maxOutputTokens).value;
  const temperature = parseDecimal(values.temperature).value;
  if (window !== undefined) def.contextWindowTokens = window;
  if (maxOutput !== undefined) def.maxOutputTokens = maxOutput;
  if (temperature !== undefined) def.temperature = temperature;
  return def;
}

export function modelFormProblem(
  values: ModelFormValues,
  options: { requireKey?: boolean; takenKeys?: readonly string[]; requireWindow?: boolean } = {},
): string | null {
  if (options.requireKey) {
    const key = values.key.trim();
    if (key.length === 0) return '请填写名称';
    if (options.takenKeys?.includes(key)) return `名称「${key}」已存在`;
  }
  if (values.provider.trim().length === 0) return '请选择所属 provider';
  if (values.name.trim().length === 0) return '请填写模型名（发给 provider 的模型名）';
  const window = parsePositiveInt(values.contextWindowTokens);
  if (window.invalid || (window.empty && options.requireWindow)) return '上下文窗口需为正整数（tokens）';
  if (parsePositiveInt(values.maxOutputTokens).invalid) return '最大输出 tokens 需为正整数，留空表示不设置';
  const temperature = parseDecimal(values.temperature);
  if (temperature.invalid || (temperature.value !== undefined && (temperature.value < 0 || temperature.value > 2))) {
    return '温度需为 0–2 之间的数字，留空表示用模型默认';
  }
  return null;
}

export interface ModelFormProps {
  value: ModelFormValues;
  onChange: (next: ModelFormValues) => void;
  /**
   * 给出时显示「Provider」下拉（向导里一个表单可能落在任何 provider 下）；
   * 省略时所属 provider 由外层决定（设置页的 provider 卡内）。
   */
  providers?: readonly string[];
  /** 显示「名称」输入（新增和编辑都可开——编辑时改名即重命名，绑定跟着改）。 */
  keyEditable?: boolean;
  disabled?: boolean;
}

export function ModelForm({ value, onChange, providers, keyEditable = false, disabled = false }: ModelFormProps) {
  const set = (patch: Partial<ModelFormValues>): void => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-3">
      {keyEditable && (
        <FormField label="名称" hint="controller / worker 的模型绑定引用它">
          {(id) => (
            <Input id={id} allowClear value={value.key} disabled={disabled} placeholder="main" onChange={(e) => set({ key: e.target.value })} />
          )}
        </FormField>
      )}
      {providers && (
        <FormField label="Provider">
          {(id) => (
            <Select value={value.provider} disabled={disabled} onValueChange={(provider) => set({ provider })}>
              <SelectTrigger id={id} fieldSize="md" className="w-full">
                <SelectValue placeholder="选择 provider" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {provider}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
      )}
      <FormField label="模型名" hint="发给 provider 的模型名">
        {(id) => (
          <Input id={id} allowClear value={value.name} disabled={disabled} placeholder="gpt-x" spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
        )}
      </FormField>
      {/* 三个数字字段各占一行；上下文窗口带常用档位的快捷选项。 */}
      <FormField label="上下文窗口（tokens）" hint="留空按 256K">
        {(id) => (
          <div className="flex flex-wrap items-center gap-2">
            <Input id={id} fieldSize="sm" inputMode="numeric" value={value.contextWindowTokens} disabled={disabled} onChange={(e) => set({ contextWindowTokens: e.target.value })} />
            {CONTEXT_WINDOW_PRESETS.map((preset) => (
              <Button
                key={preset.tokens}
                type="button"
                size="xs"
                variant={value.contextWindowTokens === String(preset.tokens) ? 'secondary' : 'outline'}
                disabled={disabled}
                onClick={() => set({ contextWindowTokens: String(preset.tokens) })}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        )}
      </FormField>
      <FormField label="最大输出 tokens">
        {(id) => <Input id={id} fieldSize="sm" inputMode="numeric" value={value.maxOutputTokens} disabled={disabled} onChange={(e) => set({ maxOutputTokens: e.target.value })} />}
      </FormField>
      {/* 温度不填时 core 不会把它发给模型服务——用哪家的默认值由服务端定，所以只能手输。 */}
      <FormField label="温度" hint="0–2，留空用模型服务的默认值">
        {(id) => <Input id={id} fieldSize="sm" inputMode="decimal" value={value.temperature} disabled={disabled} onChange={(e) => set({ temperature: e.target.value })} />}
      </FormField>
    </div>
  );
}
