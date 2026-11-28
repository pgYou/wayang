import type { ProviderConfig } from '@wayang-ai/protocol';
import { Input } from '@/renderer/shared/components/ui/input';
import { FormField } from './form-field';
import { SecretInput } from './secret-field';

/**
 * provider 的连接信息表单——设置页（新增 / 编辑）与 onboard 向导共用。受控
 * 组件：值是输入框里的原始文本，怎么保存由外层决定（设置页提交到后端，
 * 向导写进本地草稿）；配套的转换与校验函数是同一份，两边保存前都走。
 */
export interface ProviderFormValues {
  /** `providers` 的键。新增和编辑时都可填——编辑时改名称即重命名，引用它的地方一起改写。 */
  key: string;
  baseURL: string;
  apiKey: string;
}

export function providerForm(key: string, provider: ProviderConfig): ProviderFormValues {
  return { key, baseURL: provider.baseURL ?? '', apiKey: provider.apiKey ?? '' };
}

/** 表单值 → provider（只含连接信息；已校验合法时调用）。 */
export function providerFromForm(values: ProviderFormValues): ProviderConfig {
  return { type: 'openai-compatible', baseURL: values.baseURL.trim(), apiKey: values.apiKey.trim() };
}

/** 保存前的校验：返回第一条问题，null 表示可以保存。 */
export function providerFormProblem(
  values: ProviderFormValues,
  /** `takenKeys` 是「已经被占用的名字」：编辑时要把自己的当前名字排除掉。 */
  options: { requireKey?: boolean; takenKeys?: readonly string[] } = {},
): string | null {
  if (options.requireKey) {
    const key = values.key.trim();
    if (key.length === 0) return '请填写 provider 名称';
    if (options.takenKeys?.includes(key)) return `provider 名称「${key}」已存在`;
  }
  const baseURL = values.baseURL.trim();
  if (baseURL.length === 0) return '请填写 Base URL';
  if (!/^https?:\/\/\S+$/.test(baseURL)) return 'Base URL 需以 http:// 或 https:// 开头';
  if (values.apiKey.trim().length === 0) return '请填写 API Key';
  return null;
}

export interface ProviderFormProps {
  value: ProviderFormValues;
  onChange: (next: ProviderFormValues) => void;
  /** 显示「名称」输入。新增和编辑都可以开——编辑时改名称即重命名。 */
  keyEditable?: boolean;
  disabled?: boolean;
}

export function ProviderForm({ value, onChange, keyEditable = false, disabled = false }: ProviderFormProps) {
  const set = (patch: Partial<ProviderFormValues>): void => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-3">
      {keyEditable && (
        <FormField label="名称">
          {(id) => (
            <Input id={id} allowClear value={value.key} disabled={disabled} placeholder="default" onChange={(e) => set({ key: e.target.value })} />
          )}
        </FormField>
      )}
      <FormField label="Base URL" hint="OpenAI 兼容接口地址">
        {(id) => (
          <Input
            id={id}
            value={value.baseURL}
            disabled={disabled}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            onChange={(e) => set({ baseURL: e.target.value })}
          />
        )}
      </FormField>
      <FormField label="API Key">
        {(id) => <SecretInput id={id} label="API Key" value={value.apiKey} disabled={disabled} placeholder="sk-…" onChange={(apiKey) => set({ apiKey })} />}
      </FormField>
    </div>
  );
}
