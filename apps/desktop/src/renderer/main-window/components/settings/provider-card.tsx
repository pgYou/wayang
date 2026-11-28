import { useState } from 'react';
import { ChevronRightIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import type { ProviderConfig, WayangConfig } from '@wayang-ai/protocol';
import {
  modelRefSites,
  modelRemovalProblem,
  providerRemovalProblem,
  removeModel,
  removeProvider,
  renameModel,
  renameProvider,
  setControllerModel,
  setWorkerModel,
  upsertModel,
  upsertProvider,
} from '@/renderer/shared/lib/config-draft';
import { Button } from '@/renderer/shared/components/ui/button';
import { IconButton } from '@/renderer/shared/components/ui/icon-button';
import { Collapse } from '@/renderer/shared/components/ui/collapse';
import {
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
import { cn } from '@/renderer/shared/lib/cn';
import { useAutoSaveAction } from './draft-section';
import { FormDialog } from './form-dialog';
import { SettingsCard } from './settings-section';
import { ModelCard } from './model-card';
import type { ConfigCommit } from './commit';

interface ModelEditor {
  /** null = 新增；否则是被编辑条目的原条目名（条目名可改，改名即重命名）。 */
  originalKey: string | null;
  /** 打开表单时的值——判断「动过没有」，没动过时保存不点亮。 */
  initial: ModelFormValues;
  value: ModelFormValues;
}

/**
 * 一个 provider 一张卡片：头部可折叠——展开时只有名称（内容就在下面），折叠
 * 时补上概要（Base URL、模型数）；展开后连接信息只读展示（API Key 默认打码，
 * 标签后的眼睛切换明文），其下的模型直接在卡内增删，被绑定使用的模型带标记。
 * 新增 / 编辑 provider 与模型都在弹窗里做（FormDialog）——卡片本身不展开表单。
 * 设置页和 onboard 向导共用这一张卡片。
 */
export function ProviderCard({
  config,
  commit,
  providerKey,
  provider,
  open,
  onToggle,
  cardClassName,
}: {
  config: WayangConfig;
  commit: ConfigCommit;
  providerKey: string;
  provider: ProviderConfig;
  open: boolean;
  onToggle: () => void;
  /** 追加到卡片上的类（如白底页面上补一个边框，见 ModelsGroup 的 cardClassName）。 */
  cardClassName?: string;
}) {
  const models = Object.entries(config.models ?? {}).filter(([, m]) => m.provider === providerKey);
  // 两个弹窗的开着与否就是它们的表单值：null = 关着。
  const [editValues, setEditValues] = useState<ProviderFormValues | null>(null);
  const [modelEditor, setModelEditor] = useState<ModelEditor | null>(null);
  const deleteAction = useAutoSaveAction();
  const saveAction = useAutoSaveAction();

  /* ------------------------- provider 编辑弹窗 ------------------------- */

  const connection = providerForm(providerKey, provider);
  const editDirty = editValues !== null && JSON.stringify(editValues) !== JSON.stringify(connection);
  // 名称可改：不能为空、不能和别的 provider 重名（自己的当前名字不算）。
  const editProblem = editValues
    ? providerFormProblem(editValues, { requireKey: true, takenKeys: Object.keys(config.providers ?? {}).filter((k) => k !== providerKey) })
    : null;

  const saveProvider = (): void => {
    if (!editValues || !editDirty || editProblem) return;
    saveAction.run(async () => {
      const key = editValues.key.trim();
      // 改名称 = 重命名：名下的模型、经它引用的绑定一起改写。
      const base = key !== providerKey ? renameProvider(config, providerKey, key) : config;
      await commit(upsertProvider(base, key, providerFromForm(editValues)));
      setEditValues(null);
    });
  };

  /* ------------------------------ 模型弹窗 ------------------------------ */

  const modelDirty = modelEditor !== null && JSON.stringify(modelEditor.value) !== JSON.stringify(modelEditor.initial);
  // 校验口径：名称必填且不重名；上下文窗口只在新增时必填。改名不要求补窗口——
  // 没声明窗口的条目改名，在热更通道上走不通，会整体标记为「重启后生效」
  // （见 config-update-plan），但保存本身照常成功。
  const modelProblem = ({ originalKey, value }: ModelEditor): string | null =>
    modelFormProblem(value, {
      requireKey: true,
      takenKeys: Object.keys(config.models ?? {}).filter((k) => k !== originalKey),
      requireWindow: originalKey === null,
    });

  const saveModel = (): void => {
    if (!modelEditor || !modelDirty || modelProblem(modelEditor)) return;
    saveAction.run(async () => {
      const { originalKey, value } = modelEditor;
      const key = value.key.trim();
      // 改条目名 = 重命名：同步改写绑定。
      const renamed = originalKey !== null && originalKey !== key;
      const base = renamed ? renameModel(config, originalKey, key) : config;
      let next = upsertModel(base, key, modelFromForm({ ...value, provider: providerKey }));
      // 还没绑定的位置先用这个模型补上（第一次添加模型时 controller / worker
      // 都指向它，之后可以再改）；已经绑好的不动。设置页上绑定始终在，这里
      // 等于不生效——主要是给 onboard 向导用的。
      if (next.controller?.model === undefined) next = setControllerModel(next, key);
      if (next.worker?.model === undefined) next = setWorkerModel(next, key);
      await commit(next);
      setModelEditor(null);
    });
  };

  const closeDialogs = (): void => {
    setEditValues(null);
    setModelEditor(null);
    saveAction.clearError();
  };

  /* -------------------------------- 删除 -------------------------------- */

  const deleteProvider = (): void =>
    deleteAction.run(async () => {
      const problem = providerRemovalProblem(config, providerKey);
      if (problem) throw new Error(problem);
      await commit(removeProvider(config, providerKey));
    });

  const deleteModel = (key: string): void =>
    deleteAction.run(async () => {
      const problem = modelRemovalProblem(config, key);
      if (problem) throw new Error(problem);
      await commit(removeModel(config, key));
    });

  return (
    <>
      <SettingsCard className={cn('gap-0 py-0', cardClassName)}>
        <div className="flex items-center gap-2 px-4 py-3">
          <button
            type="button"
            data-testid="provider-toggle"
            data-id={providerKey}
            onClick={onToggle}
            aria-expanded={open}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          >
            <ChevronRightIcon className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
            <span className="font-mono text-sm font-medium">{providerKey}</span>
            {/* 概要（Base URL、模型数）只在折叠时显示：展开后下面就是完整内容，不必重复。 */}
            {!open && (
              <>
                <span className="truncate text-xs text-muted-foreground">{provider.baseURL ?? '—'}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{models.length} 个模型</span>
              </>
            )}
          </button>
          <IconButton
            data-testid="provider-edit"
            data-id={providerKey}
            label={`编辑 provider ${providerKey}`}
            onClick={() => {
              setEditValues(connection);
              saveAction.clearError();
            }}
          >
            <PencilIcon />
          </IconButton>
          <IconButton
            data-testid="provider-delete"
            data-id={providerKey}
            label={`删除 provider ${providerKey}`}
            disabled={deleteAction.pending}
            onClick={deleteProvider}
          >
            <Trash2Icon />
          </IconButton>
        </div>
        {/* 删除被拦下时的提示：放头部下方，折叠状态也能看到。 */}
        {deleteAction.error && <p data-testid="provider-delete-error" className="px-4 pb-3 text-xs text-destructive">{deleteAction.error}</p>}
        <Collapse open={open}>
          {/* 卡内两部分：基础信息 + 模型。中间不加分割线，模型用灰底小卡自成一块。 */}
          <div className="flex flex-col gap-4 border-t border-border px-4 py-3">
            <div className="flex flex-col gap-4">
              <ReadonlyField label="Base URL">
                <span className="break-all text-base">{provider.baseURL ?? '—'}</span>
              </ReadonlyField>
              <ReadonlySecretField label="API Key" value={provider.apiKey ?? ''} />
            </div>

            {models.map(([key, m]) => (
              <ModelCard
                key={key}
                entryKey={key}
                model={m}
                sites={modelRefSites(config, key)}
                deleteDisabled={deleteAction.pending}
                onEdit={() => {
                  const initial = modelForm(key, m);
                  setModelEditor({ originalKey: key, initial, value: initial });
                  saveAction.clearError();
                }}
                onDelete={() => deleteModel(key)}
              />
            ))}

            <div>
              <Button
                size="sm"
                variant="dashed"
                data-testid="model-add"
                onClick={() => {
                  const initial = emptyModelForm(providerKey);
                  setModelEditor({ originalKey: null, initial, value: initial });
                  saveAction.clearError();
                }}
              >
                <PlusIcon />
                添加模型
              </Button>
            </div>
          </div>
        </Collapse>
      </SettingsCard>

      <FormDialog
        testId="provider-edit-dialog"
        open={editValues !== null}
        onClose={closeDialogs}
        title="编辑 provider"
        description="改名称会同步更新它名下的模型和引用它的绑定。"
        submitLabel="保存"
        onSubmit={saveProvider}
        submitDisabled={!editDirty || editProblem !== null}
        problem={saveAction.error ?? (editDirty ? editProblem : null)}
        saving={saveAction.pending}
      >
        {editValues && <ProviderForm keyEditable value={editValues} onChange={setEditValues} />}
      </FormDialog>

      <FormDialog
        testId={modelEditor?.originalKey === null ? 'model-add-dialog' : 'model-edit-dialog'}
        open={modelEditor !== null}
        onClose={closeDialogs}
        title={modelEditor?.originalKey === null ? '添加模型' : '编辑模型'}
        description={`所属 provider：${providerKey}`}
        submitLabel={modelEditor?.originalKey === null ? '添加' : '保存'}
        onSubmit={saveModel}
        submitDisabled={!modelDirty || (modelEditor !== null && modelProblem(modelEditor) !== null)}
        problem={saveAction.error ?? (modelDirty && modelEditor ? modelProblem(modelEditor) : null)}
        saving={saveAction.pending}
        className="max-w-xl"
      >
        {modelEditor && <ModelForm keyEditable value={modelEditor.value} onChange={(value) => setModelEditor({ ...modelEditor, value })} />}
      </FormDialog>
    </>
  );
}
