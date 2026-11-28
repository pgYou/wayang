import { useEffect, useState } from 'react';
import { removeWorkerEntry, renameWorkerEntry, upsertWorkerEntry } from '@/renderer/shared/lib/config-draft';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Button } from '@/renderer/shared/components/ui/button';
import { Input } from '@/renderer/shared/components/ui/input';
import {
  EMPTY_WORKER_FORM,
  FormField,
  PuppetDefaultsForm,
  WorkerEmojiField,
  WorkerForm,
  applyPuppetDefaultsForm,
  applyWorkerForm,
  puppetDefaultsForm,
  puppetDefaultsFormProblem,
  workerForm,
  workerFormProblem,
  type PuppetDefaultsFormValues,
  type WorkerFormValues,
} from '@/renderer/main-window/components/settings';
import { FORM_OPEN_REASON, FORM_PRISTINE, EntryCard, FormActions, StepCard, touched, type StepProps } from './step-parts';

/**
 * Worker 步（可选）：puppet worker 默认参数 + 第三方 worker。表单都是设置页
 * 同一套原子组件；改动直接写进草稿。
 */
export function WorkerStep({ draft, onChange, onBlock }: StepProps) {
  const workers = Object.entries(draft.workers ?? {});
  const [editor, setEditor] = useState<WorkerEditor | null>(null);
  // puppet 默认参数的输入留在本步：合法的值即时写回草稿，输入到一半（比如
  // 清空了并发数）先留在本地，并挡住「完成」直到改回合法值。
  const [puppet, setPuppet] = useState<PuppetDefaultsFormValues>(() => puppetDefaultsForm(draft.worker));

  /** 校验口径：名称必填且不重名（自己的当前名字不算），再看表单其余字段。 */
  const problemOf = ({ originalId, id, value }: WorkerEditor): string | null => {
    const name = id.trim();
    if (name.length === 0) return '请填写名称';
    if (name !== originalId && draft.workers?.[name]) return `名称「${name}」已存在`;
    return workerFormProblem(value);
  };
  const initialOf = ({ originalId }: WorkerEditor): WorkerFormValues => {
    const existing = originalId !== null ? draft.workers?.[originalId] : undefined;
    return existing ? workerForm(existing) : EMPTY_WORKER_FORM;
  };

  /** 编辑器动过没有：新增看整张表单（含名称）；编辑看字段或名称有没有变。 */
  const editorTouched = (current: WorkerEditor): boolean =>
    current.originalId === null
      ? touched({ ...current.value, id: current.id }, { ...EMPTY_WORKER_FORM, id: '' })
      : touched(current.value, initialOf(current)) || current.id !== current.originalId;

  const blockReason = editor !== null ? (editorTouched(editor) ? FORM_OPEN_REASON : FORM_PRISTINE) : (puppetDefaultsFormProblem(puppet) ?? null);
  useEffect(() => {
    onBlock(blockReason);
  }, [blockReason, onBlock]);

  const save = (current: WorkerEditor): void => {
    if (problemOf(current)) return;
    const existing = current.originalId !== null ? draft.workers?.[current.originalId] : undefined;
    const base = existing ?? { type: current.value.type, description: '' };
    // 改名称 = 重命名（位置不变）；新增时 originalId 为 null，renameWorkerEntry 原样返回。
    const renamed = renameWorkerEntry(draft, current.originalId ?? current.id, current.id.trim());
    onChange(upsertWorkerEntry(renamed, current.id.trim(), applyWorkerForm(base, current.value)));
    setEditor(null);
  };

  const updatePuppet = (next: PuppetDefaultsFormValues): void => {
    setPuppet(next);
    if (puppetDefaultsFormProblem(next) === null) onChange(applyPuppetDefaultsForm(draft, next));
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="px-1 text-sm font-medium">Puppet 默认参数</h3>
        <StepCard>
          <PuppetDefaultsForm value={puppet} onChange={updatePuppet} />
        </StepCard>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="px-1 text-sm font-medium">第三方 Worker</h3>
        {workers.map(([id, worker]) =>
          editor?.originalId === id ? (
            <StepCard key={id}>
              {/* emoji 在名称前面，同一行。 */}
              <div className="flex items-start gap-3">
                <WorkerEmojiField value={editor.value.emoji} onChange={(emoji) => setEditor({ ...editor, value: { ...editor.value, emoji } })} />
                <FormField label="名称" className="min-w-0 flex-1">
                  {(fieldId) => <Input id={fieldId} allowClear value={editor.id} onChange={(e) => setEditor({ ...editor, id: e.target.value })} />}
                </FormField>
              </div>
              <WorkerForm config={draft} value={editor.value} onChange={(value) => setEditor({ ...editor, value })} />
              <FormActions
                primary="保存"
                invalid={problemOf(editor) !== null}
                problem={editorTouched(editor) ? problemOf(editor) : null}
                onSave={() => save(editor)}
                onCancel={() => setEditor(null)}
              />
            </StepCard>
          ) : (
            <EntryCard
              key={id}
              title={worker.emoji ? `${worker.emoji} ${id}` : id}
              badges={
                <>
                  <Badge variant="outline">{worker.type}</Badge>
                  {worker.enable === false && (
                    <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                      已停用
                    </Badge>
                  )}
                </>
              }
              meta={`${worker.description}${typeof worker.model === 'string' ? ` · 模型 ${worker.model}` : ''}`}
              onEdit={() => setEditor({ originalId: id, id, value: workerForm(worker) })}
              onDelete={() => onChange(removeWorkerEntry(draft, id))}
            />
          ),
        )}
        {editor?.originalId === null && (
          <StepCard>
            <div className="flex items-start gap-3">
              <WorkerEmojiField value={editor.value.emoji} onChange={(emoji) => setEditor({ ...editor, value: { ...editor.value, emoji } })} />
              <FormField label="名称" className="min-w-0 flex-1">
                {(fieldId) => (
                  <Input id={fieldId} allowClear value={editor.id} placeholder="如 claude-code" onChange={(e) => setEditor({ ...editor, id: e.target.value })} />
                )}
              </FormField>
            </div>
            <WorkerForm config={draft} value={editor.value} onChange={(value) => setEditor({ ...editor, value })} />
            <FormActions
              primary="添加"
              invalid={problemOf(editor) !== null}
              problem={editorTouched(editor) ? problemOf(editor) : null}
              onSave={() => save(editor)}
              onCancel={() => setEditor(null)}
            />
          </StepCard>
        )}
        {editor === null && (
          <Button size="sm" variant="dashed" className="self-start" onClick={() => setEditor({ originalId: null, id: '', value: EMPTY_WORKER_FORM })}>
            添加 worker
          </Button>
        )}
      </section>
    </div>
  );
}

interface WorkerEditor {
  /** null = 新增；否则是被编辑 worker 的原名称。 */
  originalId: string | null;
  /** 名称输入框的当前值：新增时是要创建的名字，编辑时改了即重命名。 */
  id: string;
  value: WorkerFormValues;
}
