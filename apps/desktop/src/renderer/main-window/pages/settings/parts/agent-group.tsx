import { useState } from 'react';
import { PencilIcon, PlusIcon } from 'lucide-react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { setControllerModel, setWorkerModel } from '@/renderer/shared/lib/config-draft';
import { Button } from '@/renderer/shared/components/ui/button';
import { IconButton } from '@/renderer/shared/components/ui/icon-button';
import {
  FormField,
  ModelBindingSelect,
  PuppetDefaultsForm,
  applyPuppetDefaultsForm,
  puppetDefaultsForm,
  puppetDefaultsFormProblem,
  type PuppetDefaultsFormValues,
} from '@/renderer/main-window/components/settings';
import { cn } from '@/renderer/shared/lib/cn';
import { useAutoSaveAction } from './draft-section';
import { FormDialog } from './form-dialog';
import { RestartBadge } from './field-controls';
import { FieldLabel, SectionTitle, SettingsRow, SettingsSection } from './settings-section';
import { NewWorkerCard, WorkerCard } from './worker-card';
import type { ConfigCommitState } from '../use-config-commit';

type CommitFn = ConfigCommitState['commit'];

/**
 * Agent 分组：谁在干活、用什么模型。模型绑定（controller / puppet worker 各用
 * 哪个模型，选了即生效）在最上面，其下是 puppet 默认参数和第三方 worker 列表。
 */
export function AgentGroup({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  return (
    <>
      <BindingsSection config={config} commit={commit} />
      <PuppetDefaultsSection config={config} commit={commit} />
      <ThirdPartyWorkersSection config={config} commit={commit} />
    </>
  );
}

function BindingsSection({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const action = useAutoSaveAction();
  return (
    <SettingsSection title="模型绑定">
      <SettingsRow>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Controller 模型" hint="负责理解意图、拆解任务、调度 worker">
            {(id) => (
              <ModelBindingSelect
                id={id}
                config={config}
                value={config.controller?.model}
                disabled={action.pending}
                onChange={(model) => action.run(() => commit(setControllerModel(config, model)))}
              />
            )}
          </FormField>
          <FormField label="Worker 模型" hint="puppet worker 默认使用的模型">
            {(id) => (
              <ModelBindingSelect
                id={id}
                config={config}
                value={config.worker?.model}
                disabled={action.pending}
                onChange={(model) => action.run(() => commit(setWorkerModel(config, model)))}
              />
            )}
          </FormField>
        </div>
        {action.error && <p className="text-xs text-destructive">{action.error}</p>}
      </SettingsRow>
    </SettingsSection>
  );
}

/**
 * Puppet 默认参数：卡片里只读，三项各占一行；标题行右侧的「编辑」打开弹窗改，
 * 卡片本身不展开表单（与 provider / 模型一致）。
 */
function PuppetDefaultsSection({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const [editValues, setEditValues] = useState<PuppetDefaultsFormValues | null>(null);
  const action = useAutoSaveAction();
  const worker = config.worker;
  const committed = puppetDefaultsForm(worker);
  const dirty = editValues !== null && JSON.stringify(editValues) !== JSON.stringify(committed);
  const problem = editValues ? puppetDefaultsFormProblem(editValues) : null;

  const save = (): void => {
    if (!editValues || !dirty || problem) return;
    action.run(async () => {
      await commit(applyPuppetDefaultsForm(config, editValues));
      setEditValues(null);
    });
  };
  const close = (): void => {
    setEditValues(null);
    action.clearError();
  };

  return (
    <>
      <SettingsSection
        title="Puppet 默认参数"
        action={
          <IconButton
            label="编辑 Puppet 默认参数"
            onClick={() => {
              setEditValues(committed);
              action.clearError();
            }}
          >
            <PencilIcon />
          </IconButton>
        }
      >
        <PuppetRow label="最大并发" value={worker?.maxConcurrency !== undefined ? String(worker.maxConcurrency) : undefined} />
        <PuppetRow
          label="Max turns"
          restart
          value={worker?.maxTurns !== undefined ? String(worker.maxTurns) : undefined}
          unset="不限"
        />
        <PuppetRow label="Tool choice" value={worker?.toolChoice} unset="未设置" />
      </SettingsSection>

      <FormDialog
        open={editValues !== null}
        onClose={close}
        title="编辑 Puppet 默认参数"
        description="puppet worker 的并发数、轮数上限与工具调用模式。"
        submitLabel="保存"
        onSubmit={save}
        submitDisabled={!dirty || problem !== null}
        problem={action.error ?? (dirty ? problem : null)}
        saving={action.pending}
      >
        {editValues && <PuppetDefaultsForm value={editValues} onChange={setEditValues} />}
      </FormDialog>
    </>
  );
}

/** 只读的一行：左边标签（可带重启徽标），右边值；没设置的值显示 `unset`（灰色）。 */
function PuppetRow({ label, restart = false, value, unset }: { label: string; restart?: boolean; value: string | undefined; unset?: string }) {
  return (
    <SettingsRow className="flex-row flex-wrap items-center gap-3">
      <FieldLabel restart={restart} className="w-36 shrink-0">
        {label}
      </FieldLabel>
      <span className={cn('text-base', value === undefined && 'text-muted-foreground')}>{value ?? unset ?? '—'}</span>
    </SettingsRow>
  );
}

function ThirdPartyWorkersSection({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const rows = Object.entries(config.workers ?? {});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(false);

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>
        第三方 Worker
        <RestartBadge />
      </SectionTitle>
      {rows.map(([id, worker]) => (
        <WorkerCard
          key={id}
          config={config}
          commit={commit}
          workerId={id}
          worker={worker}
          open={!collapsed[id]}
          onToggle={() => setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }))}
        />
      ))}
      {creating && <NewWorkerCard config={config} commit={commit} onDone={() => setCreating(false)} />}
      {!creating && (
        <Button size="sm" variant="dashed" className="self-start" onClick={() => setCreating(true)}>
          <PlusIcon />
          添加 worker
        </Button>
      )}
    </section>
  );
}
