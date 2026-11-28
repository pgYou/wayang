import type { WayangConfig } from '@wayang-ai/protocol';
import { Input } from '@/renderer/shared/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/shared/components/ui/select';
import { Switch } from '@/renderer/shared/components/ui/switch';
import { Textarea } from '@/renderer/shared/components/ui/textarea';
import { FormField } from './form-field';
import { ModelBindingSelect } from './model-binding-select';
import { PERMISSION_MODE_UNSET, type WorkerFormValues } from './worker-form-values';

/**
 * 各类型 worker 的专属字段：只摆这一类真正会读的键。四类共用的字段（类型、
 * 能力标签、描述）在 worker-form.tsx 的 WorkerBaseFields，这几组接在它后面。
 * 接成两列网格、整行宽，由 WorkerForm 放在公共字段下方。
 */

/** 一组类型专属字段拿到的接口：整份表单值 + 改其中几个字段。 */
export interface WorkerFieldsProps {
  value: WorkerFormValues;
  onChange: (next: WorkerFormValues) => void;
  disabled?: boolean;
}

const FIELDS_GRID = 'grid grid-cols-1 gap-3 sm:col-span-2 sm:grid-cols-2';

interface SwitchFieldProps {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** 开关字段：和输入框等高（36px）的一行，开关垂直居中。 */
function SwitchField({ label, hint, checked, onCheckedChange, disabled }: SwitchFieldProps) {
  return (
    <FormField label={label} hint={hint}>
      {(id) => (
        <div className="flex h-9 items-center">
          <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
        </div>
      )}
    </FormField>
  );
}

/** claude-code：交给 Claude Code 的模型、轮数上限、CLI 位置。 */
export function ClaudeCodeWorkerFields({ config, value, onChange, disabled = false }: WorkerFieldsProps & { config: WayangConfig }) {
  const set = (patch: Partial<WorkerFormValues>): void => onChange({ ...value, ...patch });
  return (
    <div className={FIELDS_GRID}>
      <FormField label="模型引用" hint="只把模型名传给 Claude Code，留空用它的默认模型">
        {(id) => <ModelBindingSelect id={id} config={config} value={value.model} allowUnset disabled={disabled} onChange={(model) => set({ model })} />}
      </FormField>
      <FormField label="Max turns" hint="留空不限">
        {(id) => <Input id={id} fieldSize="sm" inputMode="numeric" placeholder="不限" value={value.maxTurns} disabled={disabled} onChange={(e) => set({ maxTurns: e.target.value })} />}
      </FormField>
      <FormField label="CLI 路径" hint="留空自动探测" className="sm:col-span-2">
        {(id) => <Input id={id} allowClear value={value.cliPath} disabled={disabled} onChange={(e) => set({ cliPath: e.target.value })} />}
      </FormField>
    </div>
  );
}

/**
 * ACP 类（acp / codebuddy / opencode）：怎么启动（命令、参数、环境变量）、
 * 权限归谁管、wayang 的 MCP 工具挂不挂。两个键只有特定类型读：
 * trustUpdatesAfterCancel 仅通用 acp，protocol.gatePermissions 仅 opencode。
 */
export function AcpWorkerFields({ value, onChange, disabled = false }: WorkerFieldsProps) {
  const set = (patch: Partial<WorkerFormValues>): void => onChange({ ...value, ...patch });
  const generic = value.type === 'acp';
  return (
    <div className={FIELDS_GRID}>
      <FormField label="可执行命令" hint={generic ? undefined : '留空使用内置默认'}>
        {(id) => (
          <Input
            id={id}
            allowClear
            value={value.command}
            disabled={disabled}
            placeholder={generic ? '必填，如 my-agent' : undefined}
            onChange={(e) => set({ command: e.target.value })}
          />
        )}
      </FormField>
      <FormField label="权限模式">
        {(id) => (
          <Select
            value={value.permissionMode}
            disabled={disabled}
            onValueChange={(permissionMode) => set({ permissionMode: permissionMode as WorkerFormValues['permissionMode'] })}
          >
            <SelectTrigger id={id} fieldSize="md" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PERMISSION_MODE_UNSET}>未设置（默认 client）</SelectItem>
              <SelectItem value="client">client（权限请求由 wayang 转发）</SelectItem>
              <SelectItem value="agent">agent（权限由 agent 自己管）</SelectItem>
            </SelectContent>
          </Select>
        )}
      </FormField>
      <FormField label="启动参数" hint="每行一个；留空用内置默认" className="sm:col-span-2">
        {(id) => <Textarea id={id} value={value.args} disabled={disabled} onChange={(e) => set({ args: e.target.value })} />}
      </FormField>
      <FormField label="环境变量" hint="每行一个，写成 KEY=VALUE" className="sm:col-span-2">
        {(id) => (
          <Textarea id={id} value={value.env} disabled={disabled} placeholder="HTTP_PROXY=http://127.0.0.1:7890" onChange={(e) => set({ env: e.target.value })} />
        )}
      </FormField>
      <SwitchField label="MCP 注入" hint="把上报进度、向 controller 提问两个工具挂给 agent" checked={value.mcpEnabled} onCheckedChange={(mcpEnabled) => set({ mcpEnabled })} disabled={disabled} />
      <FormField label="空闲回退（ms）" hint="没有新输出这么久就补一条进度，留空用默认值">
        {(id) => (
          <Input id={id} fieldSize="sm" inputMode="numeric" placeholder="默认值" value={value.mcpFallbackMs} disabled={disabled} onChange={(e) => set({ mcpFallbackMs: e.target.value })} />
        )}
      </FormField>
      {generic && (
        <SwitchField
          label="取消后保留迟到的结果"
          hint="任务取消后才返回的内容是否仍写入记录；默认丢弃"
          checked={value.trustUpdatesAfterCancel}
          onCheckedChange={(trustUpdatesAfterCancel) => set({ trustUpdatesAfterCancel })}
          disabled={disabled}
        />
      )}
      {value.type === 'opencode' && (
        <SwitchField
          label="接管权限审批"
          hint="关闭后 opencode 的工具操作不经 wayang 审批"
          checked={value.gatePermissions}
          onCheckedChange={(gatePermissions) => set({ gatePermissions })}
          disabled={disabled}
        />
      )}
    </div>
  );
}
