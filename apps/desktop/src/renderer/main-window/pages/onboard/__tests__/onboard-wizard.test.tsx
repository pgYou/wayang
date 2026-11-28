// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act, type ButtonHTMLAttributes, type LabelHTMLAttributes, type ReactNode } from 'react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { emptyDraft, setControllerModel, setWorkerModel, upsertModel, upsertProvider } from '@/renderer/shared/lib/config-draft';
import { draftProblem, type WizardStepId } from '../wizard-state';

/**
 * 向导流程的钉子：从空草稿走完 Provider → 模型 → 模型绑定 → Worker 四步交出
 * 一份完整配置；预填草稿（导入的 / 磁盘上不完整的）在同一条流程里改；未保存
 * 的表单挡住「下一步」；删除要两拍；确认页的门槛与保存同口径。
 *
 * UI shim 约定同 components/settings 的测试：Label / Select 是「能用」的替身
 * （真 htmlFor、带 option 的原生 select），才能按标签找控件、改值。
 */

vi.mock('@/renderer/shared/components/ui/label', () => ({
  Label: ({ children, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) => <label {...rest}>{children}</label>,
}));

vi.mock('@/renderer/shared/components/ui/button', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock('@/renderer/shared/components/ui/badge', () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/renderer/shared/components/ui/select', async () => {
  const React = await import('react');
  const SelectTrigger = (_props: { id?: string }): null => null;
  const SelectValue = (): null => null;
  const SelectContent = (_props: { children?: ReactNode }): null => null;
  const SelectItem = (_props: { value: string; children?: ReactNode }): null => null;
  const Select = ({ value, onValueChange, children }: { value?: string; onValueChange: (value: string) => void; children?: ReactNode }) => {
    const options: { value: string; label: ReactNode }[] = [];
    let id: string | undefined;
    const walk = (nodes: ReactNode): void => {
      React.Children.forEach(nodes, (child) => {
        if (!React.isValidElement<{ id?: string; value?: string; children?: ReactNode }>(child)) return;
        if (child.type === SelectItem) options.push({ value: child.props.value ?? '', label: child.props.children });
        else {
          if (child.type === SelectTrigger) id = child.props.id;
          walk(child.props.children);
        }
      });
    };
    walk(children);
    return (
      <select id={id} value={value ?? ''} onChange={(e) => onValueChange(e.target.value)}>
        <option value="" />
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  };
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

import { FinalConfirm, OnboardWizard } from '../onboard-wizard';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const text = (): string => container!.textContent ?? '';
const labels = (): string[] => Array.from(container!.querySelectorAll('label')).map((el) => el.textContent ?? '');

const buttonNamed = (name: string): HTMLButtonElement => {
  const button = Array.from(container!.querySelectorAll('button')).find((el) => el.textContent?.trim() === name);
  if (!button) throw new Error(`button not found: ${name}`);
  return button as HTMLButtonElement;
};

const controlFor = (label: string): HTMLElement => {
  const htmlFor = Array.from(container!.querySelectorAll('label')).find((el) => el.textContent === label)?.getAttribute('for');
  const control = htmlFor ? document.getElementById(htmlFor) : null;
  if (!control) throw new Error(`control not found for label: ${label}`);
  return control;
};

const inputFor = (label: string): HTMLInputElement => {
  const control = controlFor(label);
  if (!(control instanceof HTMLInputElement)) throw new Error(`control for "${label}" is not an input`);
  return control;
};

const selectFor = (label: string): HTMLSelectElement => {
  const control = controlFor(label);
  if (!(control instanceof HTMLSelectElement)) throw new Error(`control for "${label}" is not a select`);
  return control;
};

const typeInto = (input: HTMLInputElement, value: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const click = (el: Element): void => {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

/** 最近一次经 onChange 报出来的草稿（Harness 的当前 state）。 */
let latest: WayangConfig | null = null;

function Harness({
  initial,
  initialStep,
  onComplete,
  onCancel,
}: {
  initial: WayangConfig;
  initialStep?: WizardStepId;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  latest = draft;
  return <OnboardWizard draft={draft} onChange={setDraft} initialStep={initialStep} onComplete={onComplete} onCancel={onCancel} />;
}

/** 一份「provider、模型都有，但没绑定」的草稿——像导入后缺必要核心的配置。 */
const prefilled: WayangConfig = upsertModel(
  upsertProvider(emptyDraft(), 'hub', { type: 'openai-compatible', baseURL: 'https://hub.example/v1', apiKey: 'sk-1' }),
  'main',
  { provider: 'hub', name: 'gpt-x', contextWindowTokens: 128000 },
);

describe('OnboardWizard', () => {
  it('walks an empty draft through provider → model → binding → worker and hands over a complete config', () => {
    const onComplete = vi.fn();
    act(() => root!.render(<Harness initial={emptyDraft()} onComplete={onComplete} onCancel={() => undefined} />));

    // Step 1 — the add form is already open. 下一步 waits, and a form the user
    // has not touched yet is not nagged at (no step problem, no unsaved notice).
    expect(labels()).toEqual(['名称', 'Base URL', 'API Key']);
    const next = buttonNamed('下一步');
    expect(next.disabled).toBe(true);
    expect(text()).not.toContain('至少添加一个 provider');
    expect(text()).not.toContain('有还没保存的表单');
    typeInto(inputFor('名称'), 'hub');
    typeInto(inputFor('Base URL'), 'https://hub.example/v1');
    typeInto(inputFor('API Key'), 'sk-1');
    // Touched but unsaved: now the reason shows (as guidance, not an error colour).
    const unsaved = Array.from(container!.querySelectorAll('p')).find((el) => el.textContent === '有还没保存的表单：先点「添加 / 保存」或「取消」');
    expect(unsaved?.className).not.toContain('text-destructive');
    click(buttonNamed('添加'));
    expect(text()).toContain('https://hub.example/v1');
    expect(next.disabled).toBe(false);
    click(next);

    // Step 2 — the first model.
    typeInto(inputFor('名称'), 'fast');
    typeInto(inputFor('模型名'), 'gpt-x');
    expect(selectFor('Provider').value).toBe('hub');
    click(buttonNamed('添加'));
    click(buttonNamed('下一步'));

    // Step 3 — the first model was auto-bound to both sides; adjustable here.
    expect(selectFor('Controller 模型').value).toBe('fast');
    expect(selectFor('Worker 模型').value).toBe('fast');
    click(buttonNamed('下一步'));

    // Step 4 — optional, no gate.
    expect(labels()).toContain('最大并发');
    expect(inputFor('最大并发').value).toBe('3');
    click(buttonNamed('完成，去确认'));
    expect(onComplete).toHaveBeenCalledTimes(1);

    expect(latest).toMatchObject({
      providers: { hub: { type: 'openai-compatible', baseURL: 'https://hub.example/v1', apiKey: 'sk-1' } },
      models: { fast: { provider: 'hub', name: 'gpt-x', contextWindowTokens: 128 * 1024 } },
      controller: { model: 'fast' },
      worker: { model: 'fast', maxConcurrency: 3 },
    });
    expect(draftProblem(latest!)).toBeNull();
  });

  it('an invalid add form explains itself and keeps both 添加 and 下一步 closed', () => {
    act(() => root!.render(<Harness initial={emptyDraft()} onComplete={() => undefined} onCancel={() => undefined} />));
    typeInto(inputFor('名称'), 'hub');
    typeInto(inputFor('Base URL'), 'hub.example/v1');
    typeInto(inputFor('API Key'), 'sk-1');
    expect(text()).toContain('Base URL 需以 http:// 或 https:// 开头');
    expect(buttonNamed('添加').disabled).toBe(true);
    expect(buttonNamed('下一步').disabled).toBe(true);

    // Cancelling closes the form; the step itself still has no provider — said
    // as guidance (grey), not as an error.
    click(buttonNamed('取消'));
    const guidance = Array.from(container!.querySelectorAll('p')).find((el) => el.textContent === '至少添加一个 provider');
    expect(guidance?.className).toContain('text-muted-foreground');
    expect(buttonNamed('下一步').disabled).toBe(true);
    expect(buttonNamed('新增 provider')).toBeDefined();
  });

  it('a prefilled draft lists its entries (key masked); editing a provider reports the new key', () => {
    act(() => root!.render(<Harness initial={prefilled} onComplete={() => undefined} onCancel={() => undefined} />));
    expect(text()).toContain('••••••••');
    expect(text()).not.toContain('sk-1');
    // No add form open on a step that already has an entry → 下一步 is free.
    expect(buttonNamed('下一步').disabled).toBe(false);

    click(buttonNamed('编辑'));
    expect(inputFor('API Key').value).toBe('sk-1');
    // An untouched edit form blocks silently; only once it has changes does it say why.
    expect(buttonNamed('下一步').disabled).toBe(true);
    expect(text()).not.toContain('有还没保存的表单');
    typeInto(inputFor('API Key'), 'sk-2');
    expect(text()).toContain('有还没保存的表单');
    click(buttonNamed('保存'));
    expect(latest?.providers.hub.apiKey).toBe('sk-2');
    expect(text()).not.toContain('sk-2');
  });

  it('renaming a model in the wizard keeps the bindings on it', () => {
    act(() => root!.render(<Harness initial={setWorkerModel(setControllerModel(prefilled, 'main'), 'main')} onComplete={() => undefined} onCancel={() => undefined} />));
    click(buttonNamed('下一步'));
    expect(text()).toContain('controller');
    click(buttonNamed('编辑'));
    typeInto(inputFor('名称'), 'sonnet');
    click(buttonNamed('保存'));
    expect(Object.keys(latest?.models ?? {})).toEqual(['sonnet']);
    expect(latest?.controller.model).toBe('sonnet');
    expect(latest?.worker.model).toBe('sonnet');
  });

  it('deleting an entry takes a second, confirming click — and a provider takes its models along', () => {
    act(() => root!.render(<Harness initial={prefilled} onComplete={() => undefined} onCancel={() => undefined} />));
    click(buttonNamed('删除'));
    expect(latest?.providers.hub).toBeDefined();
    click(buttonNamed('确认删除'));
    expect(latest?.providers.hub).toBeUndefined();
    expect(latest?.models).toEqual({});
  });

  it('starts on the given step (where the confirm page sends you back) and 上一步 walks back to the welcome page', () => {
    const onCancel = vi.fn();
    act(() => root!.render(<Harness initial={prefilled} initialStep="binding" onComplete={() => undefined} onCancel={onCancel} />));
    expect(labels()).toContain('Controller 模型');
    expect(text()).toContain('controller 未绑定模型');
    expect(buttonNamed('下一步').disabled).toBe(true);

    click(buttonNamed('上一步'));
    expect(labels()).not.toContain('Controller 模型');
    expect(text()).toContain('新增模型');
    click(buttonNamed('上一步'));
    expect(text()).toContain('新增 provider');
    click(buttonNamed('返回欢迎页'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('FinalConfirm', () => {
  const complete = setWorkerModel(setControllerModel(prefilled, 'main'), 'main');

  it('refuses an incomplete draft (same check as the save path) and passes a complete one to onConfirm', () => {
    const onConfirm = vi.fn();
    act(() => root!.render(<FinalConfirm draft={prefilled} saving={false} error={null} onBack={() => undefined} onConfirm={onConfirm} />));
    expect(text()).toContain('controller 未绑定模型');
    expect(buttonNamed('确认写入并进入主界面').disabled).toBe(true);

    act(() => root!.unmount());
    root = createRoot(container!);
    act(() => root!.render(<FinalConfirm draft={complete} saving={false} error={null} onBack={() => undefined} onConfirm={onConfirm} />));
    expect(buttonNamed('确认写入并进入主界面').disabled).toBe(false);
    click(buttonNamed('确认写入并进入主界面'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // 没有第三方 worker 时不摆这一节。
    expect(text()).not.toContain('第三方 Worker');
  });

  it('lists every third-party worker and the puppet defaults the wizard set — without printing env values', () => {
    const withWorkers: WayangConfig = {
      ...complete,
      worker: { ...complete.worker, maxTurns: 12, toolChoice: 'auto' },
      workers: {
        claude: { type: 'claude-code', description: '第三方编码 agent' },
        buddy: { type: 'acp', description: '内部 agent', command: 'my-agent', env: { TOKEN: 'sk-secret-value' }, enable: false },
      },
    };
    act(() => root!.render(<FinalConfirm draft={withWorkers} saving={false} error={null} onBack={() => undefined} onConfirm={() => undefined} />));
    expect(text()).toContain('第三方 Worker（2）');
    expect(text()).toContain('claude: claude-code · 第三方编码 agent');
    expect(text()).toContain('buddy: acp（已停用） · 内部 agent');
    expect(text()).toMatch(/worker: main · maxConcurrency \d+ · maxTurns 12 · toolChoice auto/);
    // 环境变量里可能有密钥：确认页只报有几项，不展开值。
    expect(text()).not.toContain('sk-secret-value');
  });
});
