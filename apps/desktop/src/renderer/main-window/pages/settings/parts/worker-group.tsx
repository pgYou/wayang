import { useState } from 'react';
import { LoaderIcon } from 'lucide-react';
import { WORKER_TYPES, type WayangConfig, type WorkerType } from '@wayang-ai/protocol';
import {
  removeWorkerEntry,
  setMaxConcurrency,
  setWorkerEntryEnabled,
  setWorkerMaxTurns,
  setWorkerToolChoice,
  upsertWorkerEntry,
} from '@/renderer/shared/lib/config-draft';
import { Button } from '@/renderer/shared/components/ui/button';
import { Input } from '@/renderer/shared/components/ui/input';
import { Label } from '@/renderer/shared/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/shared/components/ui/select';
import { Switch } from '@/renderer/shared/components/ui/switch';
import { useAutoSaveAction, useDraftSection } from './draft-section';
import { SaveCancelBar } from './field-controls';
import { FieldLabel, SettingsRow, SettingsSection } from './settings-section';
import type { ConfigCommitState } from '../use-config-commit';

type CommitFn = ConfigCommitState['commit'];

const TOOL_CHOICE_UNSET = '__unset__';

/** Worker 分组：puppet 默认参数（并发/tool-choice/maxTurns）+ 第三方 worker 列表。 */
export function WorkerGroup({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  return (
    <>
      <PuppetDefaultsSection config={config} commit={commit} />
      <ThirdPartyWorkersSection config={config} commit={commit} />
    </>
  );
}

function PuppetDefaultsSection({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const concurrency = useDraftSection(String(config.worker?.maxConcurrency ?? 3), async (value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new Error('maxConcurrency 必须是正整数');
    await commit(setMaxConcurrency(config, n));
  });
  const maxTurns = useDraftSection(config.worker?.maxTurns !== undefined ? String(config.worker.maxTurns) : '', async (value) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      await commit(setWorkerMaxTurns(config, undefined));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0) throw new Error('maxTurns 必须是正整数，留空表示不限');
    await commit(setWorkerMaxTurns(config, n));
  });
  const toolChoiceAction = useAutoSaveAction();

  return (
    <SettingsSection title="Puppet 默认参数">
      <SettingsRow>
        <FieldLabel>最大并发</FieldLabel>
        <Input inputMode="numeric" value={concurrency.value} onChange={(e) => concurrency.setValue(e.target.value)} />
        <SaveCancelBar dirty={concurrency.dirty} saving={concurrency.saving} error={concurrency.error} onSave={concurrency.save} onCancel={concurrency.cancel} />
      </SettingsRow>
      <SettingsRow>
        <FieldLabel restart>Max turns</FieldLabel>
        <Input inputMode="numeric" placeholder="留空表示不限" value={maxTurns.value} onChange={(e) => maxTurns.setValue(e.target.value)} />
        <SaveCancelBar dirty={maxTurns.dirty} saving={maxTurns.saving} error={maxTurns.error} onSave={maxTurns.save} onCancel={maxTurns.cancel} />
      </SettingsRow>
      <SettingsRow>
        <FieldLabel>Tool choice</FieldLabel>
        <Select
          value={config.worker?.toolChoice ?? TOOL_CHOICE_UNSET}
          onValueChange={(v) =>
            toolChoiceAction.run(() => commit(setWorkerToolChoice(config, v === TOOL_CHOICE_UNSET ? undefined : (v as 'auto' | 'required' | 'none'))))
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TOOL_CHOICE_UNSET}>未设置（默认）</SelectItem>
            <SelectItem value="auto">auto</SelectItem>
            <SelectItem value="required">required</SelectItem>
            <SelectItem value="none">none</SelectItem>
          </SelectContent>
        </Select>
        {toolChoiceAction.error && <p className="text-xs text-destructive">{toolChoiceAction.error}</p>}
      </SettingsRow>
    </SettingsSection>
  );
}

interface WorkerFormState {
  id: string;
  type: WorkerType;
  description: string;
  model: string;
  command: string;
}

function ThirdPartyWorkersSection({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const rows = Object.entries(config.workers ?? {});
  const [form, setForm] = useState<WorkerFormState | null>(null);
  const action = useAutoSaveAction();

  const canSave = form !== null && form.id.trim().length > 0 && form.description.trim().length > 0 && (form.type !== 'acp' || form.command.trim().length > 0);

  const save = (): void => {
    if (!form) return;
    action.run(() =>
      commit(
        upsertWorkerEntry(config, form.id.trim(), {
          type: form.type,
          description: form.description.trim(),
          model: form.model.trim() || undefined,
          command: form.type === 'acp' ? form.command.trim() : undefined,
          enable: true,
        }),
      ).then(() => setForm(null)),
    );
  };

  return (
    <SettingsSection title="第三方 Worker" restart>
      {rows.map(([id, w]) => (
        <SettingsRow key={id} className="flex-row items-center gap-3 py-3 text-sm">
          <span className="font-mono font-medium">{id}</span>
          <span className="text-xs text-muted-foreground">{w.type}</span>
          <span className="truncate text-xs text-muted-foreground">{w.description}</span>
          <Switch
            className="ml-auto"
            checked={w.enable !== false}
            disabled={action.pending}
            aria-label={`启用 ${id}`}
            onCheckedChange={(checked) => action.run(() => commit(setWorkerEntryEnabled(config, id, checked)))}
          />
          <Button size="sm" variant="ghost" disabled={action.pending} onClick={() => action.run(() => commit(removeWorkerEntry(config, id)))}>
            删除
          </Button>
        </SettingsRow>
      ))}
      <SettingsRow>
        {form !== null ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label>ID</Label>
                <Input value={form.id} onChange={(e) => setForm((f) => (f ? { ...f, id: e.target.value } : f))} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>类型</Label>
                <Select value={form.type} onValueChange={(v) => setForm((f) => (f ? { ...f, type: v as WorkerType } : f))}>
                  <SelectTrigger>
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
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label>描述（给 controller 看的自然语言说明）</Label>
                <Input value={form.description} onChange={(e) => setForm((f) => (f ? { ...f, description: e.target.value } : f))} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>模型引用（可选）</Label>
                <Input value={form.model} onChange={(e) => setForm((f) => (f ? { ...f, model: e.target.value } : f))} />
              </div>
              {form.type === 'acp' && (
                <div className="flex flex-col gap-1">
                  <Label>可执行命令</Label>
                  <Input value={form.command} onChange={(e) => setForm((f) => (f ? { ...f, command: e.target.value } : f))} />
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={save} disabled={!canSave || action.pending}>
                {action.pending && <LoaderIcon className="animate-spin" />}
                保存
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(null)} disabled={action.pending}>
                取消
              </Button>
            </div>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => setForm({ id: '', type: 'claude-code', description: '', model: '', command: '' })}
          >
            新增 worker
          </Button>
        )}
        {action.error && <p className="text-xs text-destructive">{action.error}</p>}
      </SettingsRow>
    </SettingsSection>
  );
}
