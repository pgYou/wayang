import { useEffect, useState } from 'react';
import {
  modelRefSites,
  removeModel,
  removeProvider,
  renameModel,
  renameProvider,
  setControllerModel,
  setWorkerModel,
  upsertModel,
  upsertProvider,
} from '@/renderer/shared/lib/config-draft';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Button } from '@/renderer/shared/components/ui/button';
import {
  FormField,
  ModelBindingSelect,
  ModelForm,
  ProviderForm,
  ReadonlyField,
  ReadonlySecretField,
  emptyModelForm,
  modelForm,
  modelFormProblem,
  modelFromForm,
  providerForm,
  providerFormProblem,
  providerFromForm,
  type ModelFormValues,
  type ProviderFormValues,
} from '@/renderer/main-window/components/settings';
import { FORM_OPEN_REASON, FORM_PRISTINE, EntryCard, FormActions, StepCard, touched, type StepProps } from './step-parts';

const EMPTY_PROVIDER: ProviderFormValues = { key: '', baseURL: '', apiKey: '' };

/* ------------------------------ Provider ------------------------------ */

export function ProviderStep({ draft, onChange, onBlock }: StepProps) {
  const providers = Object.entries(draft.providers ?? {});
  // 一个 provider 都没有时直接展开新增表单：从零填写的人不用先找按钮。
  const [adding, setAdding] = useState(providers.length === 0);
  const [values, setValues] = useState<ProviderFormValues>(EMPTY_PROVIDER);
  // 正在编辑的 provider（键）与它的表单值：值放在这一层，才知道「动过没有」。
  const [editing, setEditing] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<ProviderFormValues>(EMPTY_PROVIDER);

  const editInitial = editing !== null ? providerForm(editing, draft.providers[editing]) : EMPTY_PROVIDER;
  const addProblem = providerFormProblem(values, { requireKey: true, takenKeys: providers.map(([key]) => key) });
  // 名称可改：不能为空、不能和别的 provider 重名（自己的当前名字不算）。
  const editProblem = providerFormProblem(editValues, {
    requireKey: true,
    takenKeys: providers.map(([key]) => key).filter((key) => key !== editing),
  });

  // 表单开着就挡住「下一步」，免得没保存的输入被丢掉：动过才解释原因，没动过不显示。
  const formTouched = editing !== null ? touched(editValues, editInitial) : touched(values, EMPTY_PROVIDER) && adding;
  useEffect(() => {
    onBlock(editing !== null || adding ? (formTouched ? FORM_OPEN_REASON : FORM_PRISTINE) : null);
  }, [editing, adding, formTouched, onBlock]);

  const startEdit = (key: string): void => {
    setEditValues(providerForm(key, draft.providers[key]));
    setEditing(key);
  };
  const saveEdit = (): void => {
    if (editing === null || editProblem) return;
    const key = editValues.key.trim();
    // 改名称 = 重命名：名下的模型、经它引用的绑定一起改写。
    const base = key !== editing ? renameProvider(draft, editing, key) : draft;
    onChange(upsertProvider(base, key, providerFromForm(editValues)));
    setEditing(null);
  };

  return (
    <div className="flex flex-col gap-3">
      {providers.map(([key, provider]) =>
        editing === key ? (
          <StepCard key={key}>
            <ProviderForm keyEditable value={editValues} onChange={setEditValues} />
            <FormActions primary="保存" invalid={editProblem !== null} problem={touched(editValues, editInitial) ? editProblem : null} onSave={saveEdit} onCancel={() => setEditing(null)} />
          </StepCard>
        ) : (
          <EntryCard key={key} title={key} meta={provider.baseURL} onEdit={() => startEdit(key)} onDelete={() => onChange(removeProvider(draft, key))}>
            <div className="flex flex-col gap-4">
              <ReadonlyField label="Base URL">
                <span className="break-all text-base">{provider.baseURL ?? '—'}</span>
              </ReadonlyField>
              <ReadonlySecretField label="API Key" value={provider.apiKey ?? ''} />
            </div>
          </EntryCard>
        ),
      )}
      {adding ? (
        <StepCard>
          <ProviderForm keyEditable value={values} onChange={setValues} />
          <FormActions
            primary="添加"
            invalid={addProblem !== null}
            problem={touched(values, EMPTY_PROVIDER) ? addProblem : null}
            onSave={() => {
              if (addProblem) return;
              onChange(upsertProvider(draft, values.key.trim(), providerFromForm(values)));
              setValues(EMPTY_PROVIDER);
              setAdding(false);
            }}
            onCancel={() => {
              setValues(EMPTY_PROVIDER);
              setAdding(false);
            }}
          />
        </StepCard>
      ) : (
        <Button size="sm" variant="secondary" className="self-start" onClick={() => setAdding(true)}>
          新增 provider
        </Button>
      )}
    </div>
  );
}

/* -------------------------------- Model -------------------------------- */

interface ModelEditor {
  /** null = 新增；否则是被编辑条目的原条目名（改条目名即重命名，绑定跟着改）。 */
  originalKey: string | null;
  value: ModelFormValues;
}

export function ModelStep({ draft, onChange, onBlock }: StepProps) {
  const models = Object.entries(draft.models ?? {});
  const providerKeys = Object.keys(draft.providers ?? {});
  // 一个模型都没有时直接展开新增表单（同 ProviderStep）。
  const [editor, setEditor] = useState<ModelEditor | null>(models.length === 0 ? { originalKey: null, value: emptyModelForm(providerKeys[0] ?? '') } : null);

  useEffect(() => {
    onBlock(editor !== null ? (touched(editor.value, initialOf(editor)) ? FORM_OPEN_REASON : FORM_PRISTINE) : null);
  }, [editor, onBlock]);

  /** 校验口径：名称必填且不重名；上下文窗口在新增时必填（已有条目可以不声明）。 */
  const problemOf = ({ originalKey, value }: ModelEditor): string | null =>
    modelFormProblem(value, {
      requireKey: true,
      takenKeys: models.map(([key]) => key).filter((key) => key !== originalKey),
      requireWindow: originalKey === null,
    });
  /** 表单的初值——判断「动过没有」用。 */
  const initialOf = ({ originalKey }: ModelEditor): ModelFormValues => {
    const existing = originalKey !== null ? draft.models?.[originalKey] : undefined;
    return existing && originalKey !== null ? modelForm(originalKey, existing) : emptyModelForm(providerKeys[0] ?? '');
  };

  const save = (current: ModelEditor): void => {
    const problem = problemOf(current);
    if (problem) return;
    const { originalKey, value } = current;
    const key = value.key.trim();
    const renamed = originalKey !== null && originalKey !== key;
    let next = renamed ? renameModel(draft, originalKey, key) : draft;
    next = upsertModel(next, key, modelFromForm(value));
    // 还没绑定的位置先用这个模型补上（第一次添加时 controller / worker 都
    // 指向它）；已经绑好的不动，下一步可以再调整。
    if (next.controller?.model === undefined) next = setControllerModel(next, key);
    if (next.worker?.model === undefined) next = setWorkerModel(next, key);
    onChange(next);
    setEditor(null);
  };

  return (
    <div className="flex flex-col gap-3">
      {models.map(([key, model]) => (
        <EntryCard
          key={key}
          title={key}
          badges={modelRefSites(draft, key).map((site) => (
            <Badge key={site} variant="outline" className="shrink-0 text-[10px] font-normal text-muted-foreground">
              {site}
            </Badge>
          ))}
          meta={`${model.provider} / ${model.name}${model.contextWindowTokens !== undefined ? ` · ${model.contextWindowTokens} tokens` : ''}`}
          onEdit={() => setEditor({ originalKey: key, value: modelForm(key, model) })}
          onDelete={() => onChange(removeModel(draft, key))}
        />
      ))}
      {editor !== null ? (
        <StepCard>
          <ModelForm keyEditable providers={providerKeys} value={editor.value} onChange={(value) => setEditor({ originalKey: editor.originalKey, value })} />
          <FormActions
            primary={editor.originalKey === null ? '添加' : '保存'}
            invalid={problemOf(editor) !== null}
            problem={touched(editor.value, initialOf(editor)) ? problemOf(editor) : null}
            onSave={() => save(editor)}
            onCancel={() => setEditor(null)}
          />
        </StepCard>
      ) : (
        <Button size="sm" variant="secondary" className="self-start" onClick={() => setEditor({ originalKey: null, value: emptyModelForm(providerKeys[0] ?? '') })}>
          新增模型
        </Button>
      )}
    </div>
  );
}

/* ------------------------------- Binding ------------------------------- */

export function BindingStep({ draft, onChange }: StepProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <FormField label="Controller 模型" hint="负责理解意图、拆解任务、调度 worker">
        {(id) => <ModelBindingSelect id={id} config={draft} value={draft.controller?.model} onChange={(model) => onChange(setControllerModel(draft, model))} />}
      </FormField>
      <FormField label="Worker 模型" hint="puppet worker 默认使用的模型；第三方 worker 可在下一步单独指定">
        {(id) => <ModelBindingSelect id={id} config={draft} value={draft.worker?.model} onChange={(model) => onChange(setWorkerModel(draft, model))} />}
      </FormField>
    </div>
  );
}
