import type { WorkerConfig, WorkerType } from '@wayang-ai/protocol';
import { parsePositiveInt } from './form-values';

/**
 * 第三方 worker（`workers.<id>`）表单的值、转换与校验——设置页保存前一律走
 * 这里。字段长什么样在 worker-form.tsx（公共字段 + 分发）与
 * worker-type-fields.tsx（各类型的专属字段）。
 *
 * 字段按类型定制：表单值是一份扁平对象，四种类型的字段都在里面；切换类型只改
 * `type`，校验与写回只看当前类型真正会读的字段。写在别的类型上不生效的键
 * （claude-code 行上的 ACP 启动字段、ACP 行上的模型引用）写回时一并清掉。
 *
 * 有几项不提供配置、一律用默认值（ACP 类的默认行为因此保持一致）：给 claude-code
 * 指定模型；ACP 类的 MCP 注入、进度空闲回退、取消后是否保留迟到的结果、opencode
 * 的权限闸。配置行上已有的这些键（可能来自 CLI 配置）表单不展示、保存时原样保留。
 */
export const PERMISSION_MODE_UNSET = '__unset__';

export interface WorkerFormValues {
  type: WorkerType;
  description: string;
  emoji: string;
  capabilities: string;
  // --- claude-code ---
  maxTurns: string;
  cliPath: string;
  // --- ACP 类（acp / codebuddy / opencode）---
  command: string;
  /** 启动参数，每行一个。 */
  args: string;
  /** 环境变量，每行一个 `KEY=VALUE`。 */
  env: string;
  permissionMode: typeof PERMISSION_MODE_UNSET | 'client' | 'agent';
}

export const EMPTY_WORKER_FORM: WorkerFormValues = {
  type: 'claude-code',
  description: '',
  emoji: '',
  capabilities: '',
  maxTurns: '',
  cliPath: '',
  command: '',
  args: '',
  env: '',
  permissionMode: PERMISSION_MODE_UNSET,
};

export function workerForm(worker: WorkerConfig): WorkerFormValues {
  return {
    type: worker.type,
    description: worker.description,
    emoji: worker.emoji ?? '',
    capabilities: (worker.capabilities ?? []).join(', '),
    maxTurns: worker.maxTurns !== undefined ? String(worker.maxTurns) : '',
    cliPath: worker.cliPath ?? '',
    command: worker.command ?? '',
    args: (worker.args ?? []).join('\n'),
    env: Object.entries(worker.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    permissionMode: worker.permissionMode ?? PERMISSION_MODE_UNSET,
  };
}

/** 每行一项的文本 → 列表（去首尾空白、丢空行）。 */
export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 每行一个 `KEY=VALUE` 的环境变量文本 → 记录。`problem` 是第一条格式问题的
 * 说明（null = 合法）；有问题时 record 为空，不要拿去写配置。同名出现多次以
 * 最后一行为准（与 .env 的习惯一致）。
 */
export function envLines(text: string): { record: Record<string, string>; problem: string | null } {
  const record: Record<string, string> = {};
  for (const line of parseLines(text)) {
    const eq = line.indexOf('=');
    const key = eq === -1 ? '' : line.slice(0, eq).trim();
    if (key.length === 0) {
      const shown = line.length > 30 ? `${line.slice(0, 30)}…` : line;
      return { record: {}, problem: `环境变量要每行一个、写成 KEY=VALUE（「${shown}」不对）` };
    }
    record[key] = line.slice(eq + 1).trim();
  }
  return { record, problem: null };
}

/** 保存前的校验：返回第一条问题，null 表示可以保存。 */
export function workerFormProblem(values: WorkerFormValues): string | null {
  if (values.description.trim().length === 0) return '请填写描述（给 controller 看的自然语言说明）';
  if (values.type === 'claude-code') {
    if (parsePositiveInt(values.maxTurns).invalid) return 'Max turns 需为正整数，留空表示不限';
    return null;
  }
  if (values.type === 'acp' && values.command.trim().length === 0) return '请填写可执行命令（通用 acp 没有内置的可执行文件）';
  const env = envLines(values.env);
  if (env.problem) return env.problem;
  return null;
}

/**
 * 表单值合并回配置项。表单留空的可选字段不落盘（只改个名称不会给配置行
 * 添一堆空值）；该类型不读的键清掉（claude-code 行上的 ACP 启动字段会被启动
 * 校验直接拒绝）。表单不展示的键（ACP 的 protocol、mcp、trustUpdatesAfterCancel，
 * claude-code 的 model）原样保留——它们一律用默认值，除非配置行上本来就写着别的。
 * 表单不合法时抛错，不写出半截配置。
 */
export function applyWorkerForm(existing: WorkerConfig, values: WorkerFormValues): WorkerConfig {
  const problem = workerFormProblem(values);
  if (problem) throw new Error(problem);
  const next: WorkerConfig = { ...existing };
  next.type = values.type;
  next.description = values.description.trim();
  put(next, 'emoji', values.emoji.trim() || undefined);
  const capabilities = values.capabilities
    .split(',')
    .map((capability) => capability.trim())
    .filter((capability) => capability.length > 0);
  put(next, 'capabilities', capabilities.length > 0 ? capabilities : undefined);
  if (values.type === 'claude-code') applyClaudeCode(next, values);
  else applyAcp(next, values);
  return next;
}

/** 写一个可选字段：没有值就把键删掉，不留值为 undefined 的空键。 */
function put<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function applyClaudeCode(next: WorkerConfig, values: WorkerFormValues): void {
  // ACP 的启动字段写在 claude-code 行上会被启动校验拒绝；permissionMode 只有
  // ACP 类读（claude-code 的权限模式由 core 自己定），留着不起作用。
  for (const key of ['command', 'args', 'env', 'protocol', 'trustUpdatesAfterCancel', 'mcp', 'permissionMode'] as const) delete next[key];
  // `model` 表单不展示：已有的原样留在 next 里（来自 existing），不碰。
  put(next, 'maxTurns', parsePositiveInt(values.maxTurns).value);
  put(next, 'cliPath', values.cliPath.trim() || undefined);
}

function applyAcp(next: WorkerConfig, values: WorkerFormValues): void {
  // cliPath / maxTurns 对 ACP 类无效；ACP 协议没有模型字段，配置了也只在启动时
  // 记一条「未被消费」。
  delete next.cliPath;
  delete next.maxTurns;
  delete next.model;
  put(next, 'command', values.command.trim() || undefined);
  const args = parseLines(values.args);
  put(next, 'args', args.length > 0 ? args : undefined);
  const env = envLines(values.env).record;
  put(next, 'env', Object.keys(env).length > 0 ? env : undefined);
  put(next, 'permissionMode', values.permissionMode === PERMISSION_MODE_UNSET ? undefined : values.permissionMode);
  // mcp / trustUpdatesAfterCancel / protocol 表单不展示：next 里留着 existing 的值，不碰。
}
