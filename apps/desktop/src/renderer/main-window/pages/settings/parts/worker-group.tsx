import { useState } from 'react';
import { PlusIcon } from 'lucide-react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { setMaxConcurrency, setWorkerMaxTurns, setWorkerToolChoice } from '@/renderer/shared/lib/config-draft';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Button } from '@/renderer/shared/components/ui/button';
import { Input } from '@/renderer/shared/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/shared/components/ui/select';
import { useAutoSaveAction, useDraftSection, type DraftSection } from './draft-section';
import { SaveCancelBar } from './field-controls';
import { FieldLabel, SettingsRow, SettingsSection } from './settings-section';
import { NewWorkerCard, WorkerCard } from './worker-card';
import type { ConfigCommitState } from '../use-config-commit';

type CommitFn = ConfigCommitState['commit'];

const TOOL_CHOICE_UNSET = '__unset__';

/** Worker 分组：puppet 默认参数（并发/tool-choice/maxTurns）+ 第三方 worker 卡片列表。 */
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
    if (!Number.isInteger(n) || n <= 0) throw new Error('必须是正整数');
    await commit(setMaxConcurrency(config, n));
  });
  const maxTurns = useDraftSection(config.worker?.maxTurns !== undefined ? String(config.worker.maxTurns) : '', async (value) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      await commit(setWorkerMaxTurns(config, undefined));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0) throw new Error('必须是正整数，留空表示不限');
    await commit(setWorkerMaxTurns(config, n));
  });
  const toolChoiceAction = useAutoSaveAction();

  return (
    <SettingsSection title="Puppet 默认参数">
      <SettingsRow className="flex-row flex-wrap items-center gap-3">
        <FieldLabel>最大并发</FieldLabel>
        <Input fieldSize="sm" inputMode="numeric" value={concurrency.value} onChange={(e) => concurrency.setValue(e.target.value)} />
        <InlineSave section={concurrency} />
      </SettingsRow>
      <SettingsRow className="flex-row flex-wrap items-center gap-3">
        <FieldLabel restart>Max turns</FieldLabel>
        <Input fieldSize="sm" inputMode="numeric" placeholder="不限" value={maxTurns.value} onChange={(e) => maxTurns.setValue(e.target.value)} />
        <InlineSave section={maxTurns} />
      </SettingsRow>
      <SettingsRow className="flex-row flex-wrap items-center gap-3">
        <FieldLabel>Tool choice</FieldLabel>
        <Select
          value={config.worker?.toolChoice ?? TOOL_CHOICE_UNSET}
          onValueChange={(v) =>
            toolChoiceAction.run(() => commit(setWorkerToolChoice(config, v === TOOL_CHOICE_UNSET ? undefined : (v as 'auto' | 'required' | 'none'))))
          }
        >
          <SelectTrigger fieldSize="md">
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

/** 短字段的保存/取消与输入框同排。 */
function InlineSave({ section }: { section: Pick<DraftSection<never>, 'dirty' | 'saving' | 'error' | 'save' | 'cancel'> }) {
  return <SaveCancelBar dirty={section.dirty} saving={section.saving} error={section.error} onSave={section.save} onCancel={section.cancel} inline />;
}

function ThirdPartyWorkersSection({ config, commit }: { config: WayangConfig; commit: CommitFn }) {
  const rows = Object.entries(config.workers ?? {});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(false);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 px-1 text-sm font-medium">
        第三方 Worker
        <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
          重启生效
        </Badge>
      </h3>
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
        <Button size="sm" variant="secondary" className="self-start" onClick={() => setCreating(true)}>
          <PlusIcon />
          新增 worker
        </Button>
      )}
    </section>
  );
}
