import { useState } from 'react';
import { ChevronRightIcon, LoaderIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import type { WayangConfig, WorkerConfig } from '@wayang-ai/protocol';
import { removeWorkerEntry, renameWorkerEntry, setWorkerEntryEnabled, upsertWorkerEntry } from '@/renderer/shared/lib/config-draft';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Button } from '@/renderer/shared/components/ui/button';
import { Collapse } from '@/renderer/shared/components/ui/collapse';
import { IconButton } from '@/renderer/shared/components/ui/icon-button';
import { Input } from '@/renderer/shared/components/ui/input';
import { Switch } from '@/renderer/shared/components/ui/switch';
import {
  EMPTY_WORKER_FORM,
  FormField,
  WorkerEmojiField,
  WorkerForm,
  applyWorkerForm,
  workerForm,
  workerFormProblem,
  type WorkerFormValues,
} from '@/renderer/main-window/components/settings';
import { cn } from '@/renderer/shared/lib/cn';
import { useAutoSaveAction, useDraftSection } from './draft-section';
import { SaveCancelBar } from './field-controls';
import { SettingsCard } from './settings-section';
import type { ConfigCommitState } from '../use-config-commit';

type CommitFn = ConfigCommitState['commit'];

/**
 * 一个第三方 worker 一张可折叠卡片。头部只有 emoji + 名称（折叠时补一个类型
 * 徽标，便于扫一眼分辨）；展开后是字段表单，第一项就是名称——改名称即重命名。
 */
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
  // 名称（workers 的键）可以改：改了即重命名，和其余字段一起保存。
  const [idDraft, setIdDraft] = useState(workerId);
  const id = idDraft.trim();
  const idProblem = id.length === 0 ? '请填写名称' : id !== workerId && config.workers?.[id] ? `名称「${id}」已存在` : null;

  const section = useDraftSection(workerForm(worker), async (values) => {
    await commit(upsertWorkerEntry(renameWorkerEntry(config, workerId, id), id, applyWorkerForm(worker, values)));
  });
  const toggleAction = useAutoSaveAction();
  const dirty = section.dirty || idDraft !== workerId;
  // 有改动但不合法时就近说明原因（保存条同时不出现为可点）。
  const liveProblem = dirty ? (idProblem ?? workerFormProblem(section.value)) : null;

  return (
    <SettingsCard className="gap-0 py-0">
      <div className="flex items-center gap-2 px-4 py-3">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left">
          <ChevronRightIcon className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          {worker.emoji && <span className="shrink-0">{worker.emoji}</span>}
          <span className="font-mono text-sm font-medium">{workerId}</span>
          {/* 类型只在折叠时显示（展开后表单里就有这一项）；描述不进头部。 */}
          {!open && <Badge variant="outline">{worker.type}</Badge>}
        </button>
        <Switch
          checked={worker.enable !== false}
          disabled={toggleAction.pending}
          aria-label={`启用 ${workerId}`}
          onCheckedChange={(checked) => toggleAction.run(() => commit(setWorkerEntryEnabled(config, workerId, checked)))}
        />
        <IconButton label={`删除 worker ${workerId}`} disabled={toggleAction.pending} onClick={() => toggleAction.run(() => commit(removeWorkerEntry(config, workerId)))}>
          <Trash2Icon />
        </IconButton>
      </div>
      <Collapse open={open}>
        <div className="border-t border-border px-4 py-4">
          <div className="flex flex-col gap-3">
            {/* emoji 在名称前面，同一行。 */}
            <div className="flex items-start gap-3">
              <WorkerEmojiField value={section.value.emoji} onChange={(emoji) => section.setValue({ ...section.value, emoji })} disabled={section.saving} />
              <FormField label="名称" className="min-w-0 flex-1">
                {(fieldId) => <Input id={fieldId} allowClear value={idDraft} disabled={section.saving} onChange={(e) => setIdDraft(e.target.value)} />}
              </FormField>
            </div>
            <WorkerForm config={config} value={section.value} onChange={section.setValue} disabled={section.saving} />
          </div>
          <SaveCancelBar
            className="mt-4"
            dirty={dirty && liveProblem === null}
            saving={section.saving}
            error={section.error ?? liveProblem}
            onSave={section.save}
            onCancel={() => {
              section.cancel();
              setIdDraft(workerId);
            }}
          />
        </div>
      </Collapse>
    </SettingsCard>
  );
}

export function NewWorkerCard({ config, commit, onDone }: { config: WayangConfig; commit: CommitFn; onDone: () => void }) {
  const [workerId, setWorkerId] = useState('');
  const [draft, setDraft] = useState<WorkerFormValues>(EMPTY_WORKER_FORM);
  const action = useAutoSaveAction();
  const id = workerId.trim();
  const problem = id.length === 0 ? '请填写名称' : config.workers?.[id] ? `名称「${id}」已存在` : workerFormProblem(draft);
  // 按钮不合法不点亮；动过之后才把原因显示出来（空表单一上来不该报错）。
  const touched = workerId.length > 0 || JSON.stringify(draft) !== JSON.stringify(EMPTY_WORKER_FORM);

  const add = (): void => {
    if (problem) return;
    action.run(async () => {
      await commit(upsertWorkerEntry(config, id, applyWorkerForm({ type: draft.type, description: '' }, draft)));
      onDone();
    });
  };

  return (
    <SettingsCard className="gap-4 p-4">
      <div className="flex items-start gap-3">
        <WorkerEmojiField value={draft.emoji} onChange={(emoji) => setDraft((prev) => ({ ...prev, emoji }))} disabled={action.pending} />
        <FormField label="名称" className="min-w-0 flex-1">
          {(fieldId) => (
            <Input id={fieldId} allowClear value={workerId} disabled={action.pending} placeholder="如 claude-code" onChange={(e) => setWorkerId(e.target.value)} />
          )}
        </FormField>
      </div>
      <WorkerForm config={config} value={draft} onChange={setDraft} disabled={action.pending} />
      {action.error && <p className="text-xs text-destructive">{action.error}</p>}
      {!action.error && touched && problem && <p className="text-xs text-destructive">{problem}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={add} disabled={!touched || problem !== null || action.pending}>
          {action.pending ? <LoaderIcon className="animate-spin" /> : <PlusIcon />}
          添加
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={action.pending}>
          取消
        </Button>
      </div>
    </SettingsCard>
  );
}
