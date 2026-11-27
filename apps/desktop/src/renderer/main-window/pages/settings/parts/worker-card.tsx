import { useState } from 'react';
import { ChevronRightIcon, LoaderIcon, PlusIcon } from 'lucide-react';
import { WORKER_TYPES, type WayangConfig, type WorkerConfig, type WorkerType } from '@wayang-ai/protocol';
import { removeWorkerEntry, setWorkerEntryEnabled, upsertWorkerEntry } from '@/renderer/shared/lib/config-draft';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Button } from '@/renderer/shared/components/ui/button';
import { Card } from '@/renderer/shared/components/ui/card';
import { Collapse } from '@/renderer/shared/components/ui/collapse';
import { Input } from '@/renderer/shared/components/ui/input';
import { Label } from '@/renderer/shared/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/shared/components/ui/select';
import { Switch } from '@/renderer/shared/components/ui/switch';
import { cn } from '@/renderer/shared/lib/cn';
import { useAutoSaveAction, useDraftSection } from './draft-section';
import { SaveCancelBar } from './field-controls';
import type { ConfigCommitState } from '../use-config-commit';

type CommitFn = ConfigCommitState['commit'];

const PERMISSION_MODE_UNSET = '__unset__';

interface WorkerDraft {
  type: WorkerType;
  description: string;
  model: string;
  maxTurns: string;
  emoji: string;
  capabilities: string;
  permissionMode: string;
  cliPath: string;
  command: string;
}

function toDraft(worker: WorkerConfig): WorkerDraft {
  return {
    type: worker.type,
    description: worker.description,
    model: typeof worker.model === 'string' ? worker.model : '',
    maxTurns: worker.maxTurns !== undefined ? String(worker.maxTurns) : '',
    emoji: worker.emoji ?? '',
    capabilities: (worker.capabilities ?? []).join(', '),
    permissionMode: worker.permissionMode ?? PERMISSION_MODE_UNSET,
    cliPath: worker.cliPath ?? '',
    command: worker.command ?? '',
  };
}

/** 把表单合并回配置项：按 type 清掉另一侧的启动字段，未展示的字段原样保留。 */
function toWorkerConfig(existing: WorkerConfig, draft: WorkerDraft): WorkerConfig {
  const next: WorkerConfig = { ...existing };
  next.type = draft.type;
  next.description = draft.description.trim();
  next.model = draft.model.trim() || undefined;
  next.emoji = draft.emoji.trim() || undefined;
  next.capabilities = draft.capabilities
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const maxTurns = Number(draft.maxTurns.trim());
  next.maxTurns = draft.maxTurns.trim().length > 0 && Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : undefined;
  next.permissionMode = draft.permissionMode === PERMISSION_MODE_UNSET ? undefined : (draft.permissionMode as 'client' | 'agent');

  if (draft.type === 'claude-code') {
    delete next.command;
    delete next.args;
    delete next.env;
    delete next.protocol;
    delete next.trustUpdatesAfterCancel;
    delete next.mcp;
    next.cliPath = draft.cliPath.trim() || undefined;
  } else {
    delete next.cliPath;
    next.command = draft.command.trim() || undefined;
  }
  return next;
}

/** 一个第三方 worker 一张卡片：头部（折叠/开关/删除）+ 可编辑的字段区。 */
export function WorkerCard({
  config,
  commit,
  workerId,
  worker,
  open,
  onToggle,
}: {
  config: WayangConfig;
  commit: CommitFn;
  workerId: string;
  worker: WorkerConfig;
  open: boolean;
  onToggle: () => void;
}) {
  const section = useDraftSection(toDraft(worker), async (draft) => {
    if (draft.description.trim().length === 0) throw new Error('描述不能为空');
    if (draft.type === 'acp' && draft.command.trim().length === 0) throw new Error('类型 acp 需要可执行命令');
    await commit(upsertWorkerEntry(config, workerId, toWorkerConfig(worker, draft)));
  });
  const toggleAction = useAutoSaveAction();
  const draft = section.value;
  const set = (patch: Partial<WorkerDraft>): void => section.setValue({ ...draft, ...patch });

  return (
    <Card className="gap-0 border-transparent py-0 shadow-card">
      <div className="flex items-center gap-2 px-4 py-3">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left">
          <ChevronRightIcon className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          {worker.emoji && <span className="shrink-0">{worker.emoji}</span>}
          <span className="font-mono text-sm font-medium">{workerId}</span>
          <Badge variant="outline">{worker.type}</Badge>
          <span className="truncate text-xs text-muted-foreground">{worker.description}</span>
        </button>
        <Switch
          checked={worker.enable !== false}
          disabled={toggleAction.pending}
          aria-label={`启用 ${workerId}`}
          onCheckedChange={(checked) => toggleAction.run(() => commit(setWorkerEntryEnabled(config, workerId, checked)))}
        />
        <Button size="sm" variant="ghost" disabled={toggleAction.pending} onClick={() => toggleAction.run(() => commit(removeWorkerEntry(config, workerId)))}>
          删除
        </Button>
      </div>
      <Collapse open={open}>
        <div className="border-t border-border px-4 py-4">
          <WorkerFields draft={draft} onChange={set} />
          <div className="mt-4">
            <SaveCancelBar
              dirty={section.dirty}
              saving={section.saving}
              error={section.error ?? toggleAction.error}
              onSave={section.save}
              onCancel={section.cancel}
            />
          </div>
        </div>
      </Collapse>
    </Card>
  );
}

export function NewWorkerCard({ config, commit, onDone }: { config: WayangConfig; commit: CommitFn; onDone: () => void }) {
  const [workerId, setWorkerId] = useState('');
  const [draft, setDraft] = useState<WorkerDraft>({
    type: 'claude-code',
    description: '',
    model: '',
    maxTurns: '',
    emoji: '',
    capabilities: '',
    permissionMode: PERMISSION_MODE_UNSET,
    cliPath: '',
    command: '',
  });
  const action = useAutoSaveAction();
  const canSave = workerId.trim().length > 0 && draft.description.trim().length > 0 && (draft.type !== 'acp' || draft.command.trim().length > 0);

  const save = (): void => {
    action.run(async () => {
      await commit(upsertWorkerEntry(config, workerId.trim(), toWorkerConfig({ type: draft.type, description: '' }, draft)));
      onDone();
    });
  };

  return (
    <Card className="gap-3 border-transparent p-4 shadow-card">
      <div className="flex items-center gap-3">
        <div className="flex flex-col gap-1">
          <Label>ID</Label>
          <Input fieldSize="md" value={workerId} onChange={(e) => setWorkerId(e.target.value)} />
        </div>
        <Button size="sm" variant="ghost" className="mt-5" onClick={onDone} disabled={action.pending}>
          取消
        </Button>
      </div>
      <WorkerFields draft={draft} onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))} />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={!canSave || action.pending}>
          {action.pending ? <LoaderIcon className="animate-spin" /> : <PlusIcon />}
          新增
        </Button>
      </div>
      {action.error && <p className="text-xs text-destructive">{action.error}</p>}
    </Card>
  );
}

/** worker 的字段表单（编辑与新增共用），按内容长度选宽度档。 */
function WorkerFields({ draft, onChange }: { draft: WorkerDraft; onChange: (patch: Partial<WorkerDraft>) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1">
        <Label>类型</Label>
        <Select value={draft.type} onValueChange={(v) => onChange({ type: v as WorkerType })}>
          <SelectTrigger fieldSize="md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORKER_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label>权限模式</Label>
        <Select value={draft.permissionMode} onValueChange={(v) => onChange({ permissionMode: v })}>
          <SelectTrigger fieldSize="md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PERMISSION_MODE_UNSET}>未设置（默认 client）</SelectItem>
            <SelectItem value="client">client</SelectItem>
            <SelectItem value="agent">agent</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Label>描述</Label>
        <Input value={draft.description} placeholder="给 controller 看的自然语言说明" onChange={(e) => onChange({ description: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1">
        <Label>模型引用</Label>
        <Input value={draft.model} placeholder="模型条目名，留空则用默认" onChange={(e) => onChange({ model: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1">
        <Label>能力标签</Label>
        <Input value={draft.capabilities} placeholder="逗号分隔，如 coding, review" onChange={(e) => onChange({ capabilities: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Label>启动</Label>
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Max turns</span>
            <Input fieldSize="sm" inputMode="numeric" placeholder="不限" value={draft.maxTurns} onChange={(e) => onChange({ maxTurns: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Emoji</span>
            <Input fieldSize="sm" value={draft.emoji} onChange={(e) => onChange({ emoji: e.target.value })} />
          </div>
          {draft.type === 'claude-code' ? (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs text-muted-foreground">CLI 路径</span>
              <Input value={draft.cliPath} placeholder="留空自动探测" onChange={(e) => onChange({ cliPath: e.target.value })} />
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs text-muted-foreground">可执行命令</span>
              <Input
                value={draft.command}
                placeholder={draft.type === 'acp' ? '必填，如 my-agent' : '留空使用内置默认'}
                onChange={(e) => onChange({ command: e.target.value })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
