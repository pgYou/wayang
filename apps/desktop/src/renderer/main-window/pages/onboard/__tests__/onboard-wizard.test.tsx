// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act, type ButtonHTMLAttributes, type LabelHTMLAttributes, type ReactNode } from 'react';
import type { WayangConfig } from '@wayang-ai/protocol';
import { emptyDraft, setControllerModel, setWorkerModel, upsertModel, upsertProvider } from '@/renderer/shared/lib/config-draft';
import { draftProblem, type WizardStepId } from '../wizard-state';

/**
 * 向导流程的钉子：从空草稿走完「模型 → Agent」两步交出一份完整配置；预填草稿
 * （磁盘上不完整的）在同一条流程里改；第三方 worker 不在向导里添加；确认页的
 * 门槛与保存同口径。
 *
 * 向导各步不自己画卡片，直接用设置页同一套组件（components/settings）：编辑 /
 * 删除是图标按钮，provider 与模型的新增 / 编辑在弹窗里做，第三方 worker 是
 * 卡片内展开的表单。卡片自身的增删改细节由设置页测试负责
 * （pages/settings/__tests__），这里钉的是「接进向导之后」的行为。
 *
 * UI shim 约定同设置页测试：Label / Select 是「能用」的替身（真 htmlFor、带
 * option 的原生 select）；Dialog 像真的一样 portal 到 body，所以弹窗里的控件
 * 不在 container 里，查找一律从 document.body 出发。
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
  const Select = ({ value, onValueChange, children }: { value?: string; onValueChange: (value: string) => void; children: ReactNode }) => {
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

vi.mock('@/renderer/shared/components/ui/dialog', async () => {
  const { createPortal } = await import('react-dom');
  const pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? createPortal(<div role="dialog">{children}</div>, document.body) : null),
    DialogContent: ({ children, ...rest }: { children?: ReactNode }) => <div {...rest}>{children}</div>,
    DialogHeader: pass,
    DialogTitle: ({ children, ...rest }: { children?: ReactNode }) => <h2 {...rest}>{children}</h2>,
    DialogDescription: pass,
    DialogFooter: pass,
  };
});

import { byTestId, queryByTestId, rowAction } from '@/renderer/shared/lib/__tests__/anchors';
import { FinalConfirm, OnboardWizard } from '../onboard-wizard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
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

const text = (): string => document.body.textContent ?? '';

// 找元素一律用 data-testid（见 lib/__tests__/anchors），不按可见文案或 aria-label 找：
// 那些是给用户看的，改一次测试就得跟着改。
/** 页面上的按钮。 */
const button = (id: string): HTMLButtonElement => byTestId(id) as HTMLButtonElement;
/** 某一行（provider / 模型）上的动作按钮。 */
const rowButton = (id: string, rowId: string): HTMLButtonElement => rowAction(id, rowId) as HTMLButtonElement;

/** 按标签文字找控件。只认带 for 的表单标签——卡片里的只读字段也有同名标签，但没有关联控件。 */
const controlFor = (label: string): HTMLElement => {
  const tags = Array.from(document.body.querySelectorAll('label')).filter((el) => el.hasAttribute('for'));
  const match = tags.find((el) => el.textContent?.trim() === label) ?? tags.find((el) => el.textContent?.trim().startsWith(label));
  const control = match ? document.getElementById(match.getAttribute('for')!) : null;
  if (!control) throw new Error(`control not found for label: ${label}`);
  return control;
};

const selectFor = (label: string): HTMLSelectElement => {
  const control = controlFor(label);
  if (!(control instanceof HTMLSelectElement)) throw new Error(`control for "${label}" is not a select`);
  return control;
};

const typeInto = (el: HTMLElement, value: string): void => {
  // 走原型上的 setter：React 在节点上包了一层 value 追踪，直接赋值会被它当成「没变」。
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const click = (el: Element): void => {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

/** 当前打开的弹窗（没有则 null）。 */
const openDialog = (): HTMLElement | null => document.body.querySelector('[role="dialog"]') as HTMLElement | null;

/** 提交弹窗里的表单（回车 / 点主按钮走的是同一条路）；保存经 commit 是异步的，等它落定。 */
const submitDialog = async (): Promise<void> => {
  const form = openDialog()?.querySelector('form');
  if (!form) throw new Error('no form in the open dialog');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
};

/** 等异步的保存落定（卡片的 commit 是 promise）。 */
const settle = (): Promise<void> => act(async () => undefined);

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
  it('walks an empty draft through 模型 → Agent and hands over a complete config', async () => {
    const onComplete = vi.fn();
    act(() => root!.render(<Harness initial={emptyDraft()} onComplete={onComplete} onCancel={() => undefined} />));

    // Step 1「模型」— nothing yet: the add-provider dialog opens by itself, and 下一步 waits.
    expect(button('wizard-next').disabled).toBe(true);
    expect(queryByTestId('provider-add-dialog')).not.toBeNull();
    typeInto(controlFor('名称'), 'hub');
    typeInto(controlFor('Base URL'), 'https://hub.example/v1');
    typeInto(controlFor('API Key'), 'sk-1');
    await submitDialog();
    await settle();
    expect(openDialog()).toBeNull();
    // The card lists the entry with the key masked; its models live in the same card.
    expect(text()).toContain('https://hub.example/v1');
    expect(text()).toContain('••••••••');
    expect(queryByTestId('model-add')).not.toBeNull();
    expect(button('wizard-next').disabled).toBe(true);
    click(button('model-add'));
    expect(queryByTestId('model-add-dialog')).not.toBeNull();
    typeInto(controlFor('名称'), 'fast');
    typeInto(controlFor('模型名'), 'gpt-x');
    await submitDialog();
    await settle();
    expect(openDialog()).toBeNull();
    expect(button('wizard-next').disabled).toBe(false);
    click(button('wizard-next'));

    // Step 2「Agent」— the first model was auto-bound to both sides; adjustable here.
    expect(selectFor('Controller 模型').value).toBe('fast');
    expect(selectFor('Worker 模型').value).toBe('fast');
    expect(queryByTestId('agent-puppet-defaults')).not.toBeNull();
    click(button('wizard-next'));
    expect(onComplete).toHaveBeenCalledTimes(1);

    expect(latest).toMatchObject({
      providers: { hub: { type: 'openai-compatible', baseURL: 'https://hub.example/v1', apiKey: 'sk-1' } },
      models: { fast: { provider: 'hub', name: 'gpt-x', contextWindowTokens: 128 * 1024 } },
      controller: { model: 'fast' },
      worker: { model: 'fast', maxConcurrency: 3 },
    });
    expect(draftProblem(latest!)).toBeNull();
  });

  it('an invalid form in the dialog explains itself and keeps 添加 closed; cancelling leaves the step empty', async () => {
    act(() => root!.render(<Harness initial={emptyDraft()} onComplete={() => undefined} onCancel={() => undefined} />));
    // 弹窗一进来就开着。
    expect(queryByTestId('provider-add-dialog')).not.toBeNull();
    typeInto(controlFor('名称'), 'hub');
    typeInto(controlFor('Base URL'), 'hub.example/v1');
    typeInto(controlFor('API Key'), 'sk-1');
    expect(openDialog()!.textContent).toContain('Base URL 需以 http:// 或 https:// 开头');
    expect(button('dialog-submit').disabled).toBe(true);
    await submitDialog();
    await settle();
    expect(text()).not.toContain('hub.example/v1');

    // Cancelling closes the dialog; the step itself still has no provider — said
    // as guidance (grey), not as an error.
    click(button('dialog-cancel'));
    expect(openDialog()).toBeNull();
    // 引导文案本身是被测的行为（说清还差什么）；样式上它是灰字、不是报错。
    expect(byTestId('step-problem').textContent).toBe('至少添加一个 provider');
    expect(byTestId('step-problem').className).toContain('text-muted-foreground');
    expect(button('wizard-next').disabled).toBe(true);
    expect(queryByTestId('provider-add')).not.toBeNull();
  });

  it('a prefilled draft lists its entries (key masked); the pencil opens the edit dialog and saves the new key', async () => {
    act(() => root!.render(<Harness initial={prefilled} onComplete={() => undefined} onCancel={() => undefined} />));
    expect(text()).toContain('••••••••');
    expect(text()).not.toContain('sk-1');
    // No dialog open on a step that already has an entry → 下一步 is free.
    expect(button('wizard-next').disabled).toBe(false);

    click(rowButton('provider-edit', 'hub'));
    expect(queryByTestId('provider-edit-dialog')).not.toBeNull();
    expect((controlFor('API Key') as HTMLInputElement).value).toBe('sk-1');
    typeInto(controlFor('API Key'), 'sk-2');
    await submitDialog();
    await settle();
    expect(openDialog()).toBeNull();
    expect(latest?.providers.hub.apiKey).toBe('sk-2');
    expect(text()).not.toContain('sk-2');
  });

  it('renaming a model in the wizard keeps the bindings on it', async () => {
    act(() =>
      root!.render(<Harness initial={setWorkerModel(setControllerModel(prefilled, 'main'), 'main')} onComplete={() => undefined} onCancel={() => undefined} />),
    );
    expect(text()).toContain('controller');
    click(rowButton('model-edit', 'main'));
    expect(queryByTestId('model-edit-dialog')).not.toBeNull();
    typeInto(controlFor('名称'), 'sonnet');
    await submitDialog();
    await settle();
    expect(Object.keys(latest?.models ?? {})).toEqual(['sonnet']);
    expect(latest?.controller.model).toBe('sonnet');
    expect(latest?.worker.model).toBe('sonnet');
  });

  it('deleting follows the settings page: a provider that still owns models is refused, and goes once they are gone', async () => {
    act(() => root!.render(<Harness initial={prefilled} onComplete={() => undefined} onCancel={() => undefined} />));
    click(rowButton('provider-delete', 'hub'));
    await settle();
    // 被拦下：原因写在卡片头部下方。
    expect(text()).toContain('该 provider 下还有模型（main）');
    expect(latest?.providers.hub).toBeDefined();
    click(rowButton('model-delete', 'main'));
    await settle();
    expect(latest?.models).toEqual({});
    click(rowButton('provider-delete', 'hub'));
    await settle();
    expect(latest?.providers.hub).toBeUndefined();
  });

  it('the Agent step offers no third-party workers — they are added later on the settings page', () => {
    const complete = setWorkerModel(setControllerModel(prefilled, 'main'), 'main');
    act(() => root!.render(<Harness initial={complete} initialStep="agent" onComplete={() => undefined} onCancel={() => undefined} />));
    expect(queryByTestId('agent-bindings')).not.toBeNull();
    expect(queryByTestId('agent-puppet-defaults')).not.toBeNull();
    expect(queryByTestId('agent-workers')).toBeNull();
    expect(queryByTestId('worker-add')).toBeNull();
    expect(button('wizard-next').disabled).toBe(false);
  });

  it('starts on the given step (where the confirm page sends you back) and 上一步 walks back to the start page', () => {
    const onCancel = vi.fn();
    act(() => root!.render(<Harness initial={prefilled} initialStep="agent" onComplete={() => undefined} onCancel={onCancel} />));
    expect(queryByTestId('agent-bindings')).not.toBeNull();
    expect(byTestId('step-problem').textContent).toContain('controller 未绑定模型');
    expect(button('wizard-next').disabled).toBe(true);

    click(button('wizard-back'));
    expect(queryByTestId('agent-bindings')).toBeNull();
    expect(queryByTestId('model-add')).not.toBeNull();
    expect(queryByTestId('provider-add')).not.toBeNull();
    click(button('wizard-back'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('the wizard page has no outer card: a two-node timeline on top, then the cards the step owns', () => {
    act(() => root!.render(<Harness initial={prefilled} initialStep="agent" onComplete={() => undefined} onCancel={() => undefined} />));
    const items = Array.from(container!.querySelectorAll<HTMLElement>('[data-slot="timeline-item"]')).map((li) => li.dataset.state);
    // 落在第二步：第一步已完成，第二步是当前。
    expect(items).toEqual(['done', 'current']);
    expect(container!.querySelectorAll('[data-slot="timeline"] [aria-current="step"]').length).toBe(1);
  });
});

describe('FinalConfirm', () => {
  const complete = setWorkerModel(setControllerModel(prefilled, 'main'), 'main');

  /** 确认页的小外壳：草稿放在 state 里，页面上的修改经 onChange 写回去。 */
  function ConfirmHarness({
    initial,
    error,
    onCancel,
    onConfirm,
  }: {
    initial: WayangConfig;
    error?: string | null;
    onCancel: () => void;
    onConfirm: () => void;
  }) {
    const [draft, setDraft] = useState(initial);
    return <FinalConfirm draft={draft} onChange={setDraft} saving={false} error={error ?? null} onCancel={onCancel} onConfirm={onConfirm} />;
  }

  /** 原生 select 替身上选一个值（React 的 onChange 听的是 change 事件）。 */
  const pick = async (label: string, value: string): Promise<void> => {
    await act(async () => {
      const select = selectFor(label);
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
  };

  it('shows both groups on one page — editable in place — and 应用 waits until the whole config is valid', async () => {
    const onConfirm = vi.fn();
    act(() => root!.render(<ConfirmHarness initial={prefilled} onCancel={() => undefined} onConfirm={onConfirm} />));
    // 两步的卡片都在：模型（provider 卡片）和 Agent（模型绑定、puppet 默认参数）。
    expect(text()).toContain('https://hub.example/v1');
    // 模型的 provider 卡片和 Agent 的两个分区都在；页首有大标题。
    expect(document.querySelector('[data-testid="provider-edit"][data-id="hub"]')).not.toBeNull();
    expect(queryByTestId('agent-bindings')).not.toBeNull();
    expect(queryByTestId('agent-puppet-defaults')).not.toBeNull();
    expect(queryByTestId('confirm-title')?.tagName).toBe('H1');
    // 第三方 worker 不在 onboard 里添加。
    expect(queryByTestId('agent-workers')).toBeNull();
    // 缺绑定：说明还差什么，「进入应用」不可点。
    expect(byTestId('confirm-problem').textContent).toContain('controller 未绑定模型');
    expect(button('confirm-apply').disabled).toBe(true);

    // 原地改：两边都选上模型就合法了。
    await pick('Controller 模型', 'main');
    expect(byTestId('confirm-problem').textContent).toContain('worker 未绑定模型');
    expect(button('confirm-apply').disabled).toBe(true);
    await pick('Worker 模型', 'main');
    expect(queryByTestId('confirm-problem')).toBeNull();
    expect(button('confirm-apply').disabled).toBe(false);
    click(button('confirm-apply'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('返回初始页 goes back; a failed write stays on the page with the error', () => {
    const onCancel = vi.fn();
    act(() =>
      root!.render(<ConfirmHarness initial={complete} error="providers.hub.baseURL is required" onCancel={onCancel} onConfirm={() => undefined} />),
    );
    expect(button('confirm-apply').disabled).toBe(false);
    expect(byTestId('confirm-error').textContent).toContain('providers.hub.baseURL is required');
    click(button('confirm-back'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
