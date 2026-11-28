/**
 * 原子设置组件——设置页与 onboard 向导共用的配置表单。每个组件只管「一个
 * 配置实体的表单长什么样、值怎么转换、保存前怎么校验」，受控（value /
 * onChange）且不关心持久化：设置页把保存接到后端提交，向导把保存接进本地
 * 草稿。窗口级共享（目前只有 main window 用），不属于任何单一页面。
 */

export { FormField, type FormFieldProps } from './form-field';
export { SecretInput, SecretValue, RevealButton, useReveal, type SecretInputProps } from './secret-field';
export { ReadonlyField, ReadonlySecretField, type ReadonlyFieldProps } from './readonly-field';
export { parseDecimal, parsePositiveInt, type ParsedNumber } from './form-values';

export {
  ProviderForm,
  providerForm,
  providerFromForm,
  providerFormProblem,
  type ProviderFormProps,
  type ProviderFormValues,
} from './provider-form';

export {
  ModelForm,
  CONTEXT_WINDOW_PRESETS,
  emptyModelForm,
  modelForm,
  modelFromForm,
  modelFormProblem,
  type ModelFormProps,
  type ModelFormValues,
} from './model-form';

export { ModelBindingSelect, type ModelBindingSelectProps } from './model-binding-select';

export {
  WorkerEmojiField,
  WorkerForm,
  WorkerBaseFields,
  EMPTY_WORKER_FORM,
  workerForm,
  workerFormProblem,
  applyWorkerForm,
  type WorkerFormProps,
  type WorkerFormValues,
} from './worker-form';

export {
  PuppetDefaultsForm,
  puppetDefaultsForm,
  puppetDefaultsFormProblem,
  applyPuppetDefaultsForm,
  type PuppetDefaultsFormProps,
  type PuppetDefaultsFormValues,
} from './puppet-defaults-form';
