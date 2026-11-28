import type { WorkerType } from '@wayang-ai/protocol';
import { WORKER_TYPES } from '@wayang-ai/protocol';
import { Input } from '@/renderer/shared/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/shared/components/ui/select';
import { Textarea } from '@/renderer/shared/components/ui/textarea';
import { FormField } from './form-field';
import { type WorkerFormValues } from './worker-form-values';
import { AcpWorkerFields, ClaudeCodeWorkerFields, type WorkerFieldsProps } from './worker-type-fields';

export {
  EMPTY_WORKER_FORM,
  applyWorkerForm,
  workerForm,
  workerFormProblem,
  type WorkerFormValues,
} from './worker-form-values';

/** WorkerForm 的外部接口：整份表单值 + 改动回调。 */
export type WorkerFormProps = WorkerFieldsProps;

/** worker 的 emoji：窄输入框，放在「名称」前面同一行（不在 WorkerForm 内部，由使用方摆在名称旁）。 */
export function WorkerEmojiField({ value, onChange, disabled = false }: { value: string; onChange: (emoji: string) => void; disabled?: boolean }) {
  return (
    <FormField label="Emoji" className="w-20 shrink-0">
      {(id) => <Input id={id} value={value} placeholder="可选" disabled={disabled} onChange={(e) => onChange(e.target.value)} />}
    </FormField>
  );
}

/** 四类 worker 共用的字段：类型（决定下面接哪组专属字段）、能力标签、描述。 */
export function WorkerBaseFields({ value, onChange, disabled = false }: WorkerFieldsProps) {
  const set = (patch: Partial<WorkerFormValues>): void => onChange({ ...value, ...patch });
  return (
    <>
      <FormField label="类型">
        {(id) => (
          <Select value={value.type} disabled={disabled} onValueChange={(type) => set({ type: type as WorkerType })}>
            <SelectTrigger id={id} fieldSize="md" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WORKER_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>
      <FormField label="能力标签">
        {(id) => (
          <Input id={id} allowClear value={value.capabilities} disabled={disabled} placeholder="逗号分隔，如 coding, review" onChange={(e) => set({ capabilities: e.target.value })} />
        )}
      </FormField>
      {/* 描述是给 controller 看的一段自然语言，可能有好几句：用文本域。 */}
      <FormField label="描述" className="sm:col-span-2">
        {(id) => <Textarea id={id} value={value.description} disabled={disabled} placeholder="给 controller 看的自然语言说明" onChange={(e) => set({ description: e.target.value })} />}
      </FormField>
    </>
  );
}

/**
 * 第三方 worker（`workers.<id>`）的字段表单——设置页新增 / 编辑第三方 worker
 * 时用（onboard 不添加第三方 worker）。受控组件；表单 ↔ 配置项的转换与校验在
 * worker-form-values.ts，保存前一律走它。
 *
 * 字段按类型定制：四类共用的在上面（WorkerBaseFields），之后按类型接一组专属
 * 字段（worker-type-fields.tsx）——只摆这一类真正会读的键。名称不在表单内部
 * （新增 / 编辑 / 是否可改名由使用方决定）；emoji 用 WorkerEmojiField，由使用
 * 方摆在名称前面同一行。
 */
export function WorkerForm({ value, onChange, disabled = false }: WorkerFormProps) {
  // 字段间距与各类型专属字段那组网格一致（见 worker-type-fields 的 FIELDS_GRID）。
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
      <WorkerBaseFields value={value} onChange={onChange} disabled={disabled} />
      {value.type === 'claude-code' ? (
        <ClaudeCodeWorkerFields value={value} onChange={onChange} disabled={disabled} />
      ) : (
        <AcpWorkerFields value={value} onChange={onChange} disabled={disabled} />
      )}
    </div>
  );
}
